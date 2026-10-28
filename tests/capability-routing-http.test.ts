import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './capability-fixtures.ts';
import {createHttpServer} from '../server/http.ts';
import {createNativeProbeService} from '../server/capability-probe.ts';
import {unknownExtensions} from '../server/extensions.ts';
import type {Controller} from '../server/controller.ts';

test('capability HTTP reads are inert; discovery and routing require session/CSRF and reject forged grants',async()=>{
 const f=fixture(),controller={store:f.store,snapshot:()=>({provider:'disconnected'}),extensionSnapshot:()=>unknownExtensions(null),assertExecutionAvailable:()=>{}} as unknown as Controller;
 let probes=0;const probe=createNativeProbeService(async()=>{probes++;return {checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.162.1'},claude:{status:'found',version:'2.1.0'}};});
 const server=createHttpServer(controller,'unused',{nativeProbe:probe});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  assert.equal((await fetch(origin+'/api/capability-orchestration')).status,401);
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json'};
  const get=(path:string)=>fetch(origin+path,{headers:{cookie}}),post=(path:string,value:unknown)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(value)});
  assert.equal((await get('/api/capability-orchestration')).status,200);assert.equal(probes,0);
  assert.equal((await fetch(origin+'/api/capability-orchestration/refresh',{method:'POST',headers:{cookie},body:'{}'})).status,403);assert.equal(probes,0);
  assert.equal((await post('/api/capability-orchestration/refresh',{})).status,200);assert.equal(probes,1);
  const path='/api/projects/p/capability-routes',input={requestId:randomUUID(),taskId:f.task.id,text:'문서 작성'};
  assert.equal((await post(path,{...input,actualModel:'invented'})).status,400);
  const response=await post(path,input);assert.equal(response.status,200);const route=await response.json() as {registryDigest:string;executionAuthorized:boolean};
  assert.equal(route.executionAuthorized,false);assert.equal(f.store.runs().length,0);
  const seq=f.store.lastSeq();assert.equal((await get(path)).status,200);assert.equal((await get('/api/capability-orchestration/evidence/'+route.registryDigest)).status,200);
  assert.equal(f.store.lastSeq(),seq);assert.equal(probes,1);
  assert.equal((await get(path+'?run=1')).status,400);assert.equal((await get('/api/projects/missing/capability-routes')).status,404);
  assert.equal((await post(path+'?run=1',input)).status,400);assert.equal(f.store.runs().length,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.store.close();}
});
