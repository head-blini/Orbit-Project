import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './capability-fixtures.ts';
import {createHttpServer} from '../server/http.ts';
import {createNativeProbeService} from '../server/capability-probe.ts';
import {createClaudeAuthenticationService} from '../server/native-readiness.ts';
import {unknownExtensions} from '../server/extensions.ts';
import type {Controller} from '../server/controller.ts';
import type {NativeReadinessReport} from '../shared/native-readiness.ts';
import type {ProviderStatus} from '../shared/types.ts';

for(const version of ['2.1.259','2.0.0',null])test(`readiness HTTP mock discovery/auth: ${version??'not installed'}`,async()=>{
 const f=fixture();let probes=0,auth=0,connection:ProviderStatus='disconnected';
 const controller={store:f.store,snapshot:()=>({provider:connection}),extensionSnapshot:()=>unknownExtensions(null),assertExecutionAvailable:()=>{}} as unknown as Controller;
 const nativeProbe=createNativeProbeService(async()=>{probes++;return {checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.162.1'},claude:{status:version?'found':'not_found_on_path',version}};});
 const claudeAuthentication=createClaudeAuthenticationService(async()=>{auth++;return {checkedAt:new Date().toISOString(),authentication:'subscription',source:'claude.auth.status',issue:null};});
 const server=createHttpServer(controller,'unused',{nativeProbe,claudeAuthentication});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,path='/api/capability-orchestration/readiness';
 try{
  assert.equal((await fetch(origin+path)).status,401);
  assert.equal((await fetch(origin+path+'/refresh',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json'};
  const get=()=>fetch(origin+path,{headers:{cookie}}),post=(body:unknown,url=path+'/refresh')=>fetch(origin+url,{method:'POST',headers,body:JSON.stringify(body)});
  const before=await (await get()).json() as NativeReadinessReport;
  assert.equal(before.claude.authentication,null);assert.equal(before.codex.authentication,'unknown');assert.equal(before.claude.installation.status,'unknown');assert.equal(probes,0);assert.equal(auth,0);
  assert.equal((await fetch(origin+path+'/refresh',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await post({authentication:'subscription'})).status,400);assert.equal((await post({},path+'/refresh?execute=1')).status,400);assert.equal(probes,0);
  const response=await post({});assert.equal(response.status,200);const report=await response.json() as NativeReadinessReport;
  assert.equal(report.claude.installation.version,version);assert.equal(report.claude.authentication?.authentication,version==='2.1.259'?'subscription':undefined);
  assert.equal(report.actualModel,'unknown');assert.equal(report.liveValidation,'approval_required');assert.equal(report.costUsd,null);assert.equal(report.remainingQuota,null);
  assert.equal(probes,1);assert.equal(auth,version==='2.1.259'?1:0);
  connection='ready';const seq=f.store.lastSeq(),ready=await (await get()).json() as NativeReadinessReport;
  assert.equal(ready.codex.authentication,'confirmed');assert.equal(ready.codex.connection,'ready');assert.equal(ready.actualModel,'unknown');
  await get();await post({});assert.equal(probes,1);assert.equal(auth,version==='2.1.259'?1:0);assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.runs().length,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.store.close();}
});
