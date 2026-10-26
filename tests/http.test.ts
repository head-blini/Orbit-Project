import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { createHttpServer } from '../server/http.ts';
import { Controller } from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import type { ProviderStatus } from '../shared/types.ts';
import type { NativeProbeReport } from '../shared/capabilities.ts';

async function fixture(){
  const store=new Store(':memory:');let submissions=0,probes=0;const projectCalls:unknown[]=[];
  const controller={store,assertExecutionAvailable:()=>{},snapshot:()=>({provider:'disconnected',issue:null,threadId:null,workspace:'fixture',readOnly:true,runs:store.runs(),lastSeq:store.lastSeq()}),connect:async()=>{},submit:async(input:any)=>{submissions++;return {id:'r',...input};},interrupt:async()=>{}} as unknown as Controller;
  Object.assign(controller,{registerProject:(path:string)=>{projectCalls.push(path);return {id:'project'};},createWorktree:(id:string)=>{projectCalls.push(id);return {id:'workspace'};},selectWorkspace:async(id:string)=>{projectCalls.push(id);},workspaceDiff:(id:string)=>({workspaceId:id,files:[]})});
  const assets=mkdtempSync(join(tmpdir(),'aicc-assets-'));writeFileSync(join(assets,'index.html'),'<!doctype html><title>Fixture</title>');
  const probeReport={checkedAt:'2026-10-25T00:00:00.000Z',codex:{status:'found' as const,version:'0.164.0'},claude:{status:'not_found_on_path' as const,version:null}};
  const server=createHttpServer(controller,assets,{nativeProbe:{get:()=>null,refresh:async()=>{probes++;return probeReport;}}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const response=await fetch(origin+'/api/session');const cookie=response.headers.get('set-cookie')!.split(';')[0];const {csrfToken}=await response.json() as any;
  return {origin,cookie,csrfToken,store,projectCalls,probes:()=>probes,count:()=>submissions,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}};
}

test('persisted Solo quarantine denies HTTP dispatch and probes while preserving state and request replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-http-quarantine-')),store=new Store(':memory:');let nativeCalls=0,probeCalls=0;
  const input={requestId:'quarantine-http-request',prompt:'Fixture',workspaceId:null};
  const run=store.createRun(input.requestId,createHash('sha256').update(input.prompt).digest('hex'),input.prompt);
  store.updateRun(run.id,{execution:'lost'},'run.lost');
  const controller=new Controller(store,createWorkspace(dir),()=>{nativeCalls++;throw new Error('NO_NATIVE_FIXTURE');});
  const server=createHttpServer(controller,'unused',{nativeProbe:{get:()=>null,refresh:async()=>{probeCalls++;throw new Error('NO_NATIVE_PROBE');}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string};
    const headers={Origin:origin,Cookie:session.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':csrfToken};
    for(const [path,body] of [['/api/connect',{}],['/api/capabilities/probe',{}],['/api/runs',{...input,requestId:'new-http-request'}],
      ['/api/model-hub/destinations/fixture/models',{projectId:randomUUID(),expectedConfigDigest:'0'.repeat(64),confirmed:true}]] as const){
      const response=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});
      assert.equal(response.status,409,path);assert.deepEqual(await response.json(),{error:'SOLO_RECOVERY_REQUIRED'});
    }
    const state=await (await fetch(origin+'/api/state',{headers})).json() as any;
    assert.equal(state.soloRecoveryRequired,true);assert.equal(state.runs[0].id,run.id);
    const replay=await fetch(origin+'/api/runs',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(replay.status,200);assert.equal((await replay.json() as any).id,run.id);
    assert.equal(nativeCalls,0);assert.equal(probeCalls,0);assert.equal(store.runs().length,1);
  }finally{await controller.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true});}
});

test('capability reads are inert; native version probes require exact body, session, Origin and CSRF',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+'/api/capabilities')).status,401);
    assert.equal((await fetch(f.origin+'/api/capabilities',{headers:{cookie:f.cookie,Origin:'http://evil.test'}})).status,403);
    const response=await fetch(f.origin+'/api/capabilities',{headers:{cookie:f.cookie}});
    assert.equal(response.status,200);
    assert.equal((await response.json() as any).providers[0].capabilities[0].effective,'connection_required');
    assert.equal(f.probes(),0);
    const headers={cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json','X-CSRF-Token':f.csrfToken};
    assert.equal((await fetch(f.origin+'/api/capabilities/probe',{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:'{}'})).status,403);
    assert.equal((await fetch(f.origin+'/api/capabilities/probe',{method:'POST',headers,body:'{"command":"evil"}'})).status,400);
    assert.equal(f.probes(),0);
    const probe=await fetch(f.origin+'/api/capabilities/probe',{method:'POST',headers,body:'{}'});
    assert.equal(probe.status,200);
    const registry=await probe.json() as any;
    assert.equal(registry.providers[0].nativeProbe.version,'0.164.0');
    assert.equal(registry.providers[1].nativeProbe.status,'not_found_on_path');
    assert.equal(registry.providers[1].authStatus,'unknown');
    assert.equal(f.probes(),1);assert.equal(f.count(),0);
  }finally{await f.close();}
});

test('capability probe reports current connection after awaiting version diagnosis',{timeout:5000},async()=>{
  const store=new Store(':memory:');let provider:ProviderStatus='ready';
  let finish!:(report:NativeProbeReport)=>void,started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const pending=new Promise<NativeProbeReport>(resolve=>{finish=resolve;});
  const controller={store,assertExecutionAvailable:()=>{},snapshot:()=>({provider})} as unknown as Controller;
  const server=createHttpServer(controller,'unused',{nativeProbe:{get:()=>null,refresh:()=>{started();return pending;}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string};
    const result=fetch(origin+'/api/capabilities/probe',{method:'POST',headers:{Origin:origin,Cookie:session.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:'{}'});
    await began;provider='disconnected';
    finish({checkedAt:'2026-10-25T00:00:00.000Z',codex:{status:'found',version:'0.164.0'},claude:{status:'unknown',version:null}});
    const registry=await (await result).json() as any;
    assert.equal(registry.providers[0].connection,'disconnected');
    assert.equal(registry.providers[0].capabilities[0].effective,'connection_required');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
test('loopback API requires session and rejects cross-origin, forged Host and CSRF before mutation',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+'/api/state')).status,401);
    assert.equal((await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie,Origin:'http://evil.test'}})).status,403);
    const forgedHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(f.origin+'/api/session',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    assert.equal(forgedHost,403);
    const base={method:'POST',headers:{cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json'},body:'{}'};
    assert.equal((await fetch(f.origin+'/api/connect',base)).status,403);
    assert.equal((await fetch(f.origin+'/api/connect',{...base,headers:{...base.headers,'X-CSRF-Token':f.csrfToken}})).status,200);
    assert.equal((await fetch(f.origin+'/api/runs',{...base,headers:{...base.headers,'X-CSRF-Token':f.csrfToken,Origin:'null'},body:'{"prompt":"x","requestId":"12345678"}'})).status,403);
    assert.equal(f.count(),0);
  }finally{await f.close();}
});

test('project/workspace endpoints require CSRF, exact fields and identifiers, never browser sandbox overrides',async()=>{
  const f=await fixture();try{
    const headers={cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json','X-CSRF-Token':f.csrfToken};
    for(const [path,body] of [['/api/projects',{path:'C:/fixture',writeEnabled:true}],['/api/workspaces',{projectId:'bad',branch:'main'}],['/api/workspaces/select',{workspaceId:'--evil'}]] as const)assert.equal((await fetch(f.origin+path,{method:'POST',headers,body:JSON.stringify(body)})).status,400);
    assert.equal((await fetch(f.origin+'/api/projects',{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:JSON.stringify({path:'C:/fixture'})})).status,403);
    assert.equal(f.projectCalls.length,0);
    assert.equal((await fetch(f.origin+'/api/projects',{method:'POST',headers,body:JSON.stringify({path:'C:/fixture'})})).status,200);
    const id='11111111-1111-4111-8111-111111111111';assert.equal((await fetch(f.origin+'/api/workspaces',{method:'POST',headers,body:JSON.stringify({projectId:id})})).status,200);
    assert.equal((await fetch(f.origin+'/api/workspaces/select',{method:'POST',headers,body:JSON.stringify({workspaceId:id})})).status,200);
    assert.equal((await fetch(f.origin+'/api/workspaces/'+id+'/diff',{headers:{cookie:f.cookie}})).status,200);
    assert.equal((await fetch(f.origin+'/api/workspaces/'+id+'/diff')).status,401);
    assert.equal(f.projectCalls.length,3);
    assert.equal((await fetch(f.origin+'/api/runs',{method:'POST',headers,body:JSON.stringify({requestId:'request-context',prompt:'edit'})})).status,400);
    const submitted=await fetch(f.origin+'/api/runs',{method:'POST',headers,body:JSON.stringify({requestId:'request-context',prompt:'edit',workspaceId:id})});assert.equal(submitted.status,200);assert.equal((await submitted.json() as any).workspaceId,id);
  }finally{await f.close();}
});
test('large SSE backlog drains in order without closing or crashing the server',async()=>{
  const f=await fixture();const abort=new AbortController();try{
    for(let i=0;i<100;i++)f.store.append('fixture.large',null,{text:'x'.repeat(4000)});
    const response=await fetch(f.origin+'/api/events?after=0',{headers:{cookie:f.cookie},signal:abort.signal});
    const reader=response.body!.getReader();let content='';
    while(!content.includes('id: 100\n')){const chunk=await reader.read();if(chunk.done)break;content+=new TextDecoder().decode(chunk.value);}
    assert.equal((content.match(/id: \d+\n/g)??[]).length,100);
    assert.equal((await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}})).status,200);
  }finally{abort.abort();await f.close();}
});
test('unknown path/CLI override keys and oversized body are rejected',async()=>{
  const f=await fixture();try{
    const headers={cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json','X-CSRF-Token':f.csrfToken};
    for(const body of [JSON.stringify({prompt:'hi',requestId:'12345678',cwd:'C:/'}),'null','['.repeat(20000)]){
      const r=await fetch(f.origin+'/api/runs',{method:'POST',headers,body});assert.ok([400,413].includes(r.status));
    }
    assert.equal(f.count(),0);
  }finally{await f.close();}
});
test('state reload does not start a turn; SSE replays only events after cursor',async()=>{
  const f=await fixture();try{
    const first=f.store.append('fixture.first',null,{});f.store.append('fixture.second',null,{});
    await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}});await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}});assert.equal(f.count(),0);
    const abort=new AbortController();
    const r=await fetch(f.origin+'/api/events?after='+first.seq,{headers:{cookie:f.cookie},signal:abort.signal});
    const reader=r.body!.getReader();const text=new TextDecoder().decode((await reader.read()).value);
    assert.ok(text.includes('fixture.second'));assert.equal(text.includes('fixture.first'),false);abort.abort();
  }finally{await f.close();}
});
test('top-level navigation may arrive from another site, but cross-site API reads are rejected',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+'/',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,200);
    assert.equal((await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
  }finally{await f.close();}
});
