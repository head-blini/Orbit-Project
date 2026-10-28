import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './capability-fixtures.ts';
import {createHttpServer} from '../server/http.ts';
import {unknownExtensions} from '../server/extensions.ts';
import type {Controller} from '../server/controller.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {CapabilityInvocationRecord} from '../shared/capability-invocation.ts';

async function setup(failStop=false){
 const f=fixture();let submits=0,stops=0;
 const run=f.store.createRun(randomUUID(),'digest','synthetic prompt',undefined,{runtime:'claude-code',projectId:'p',taskId:f.task.id,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash});
 const controller={store:f.store,snapshot:()=>({provider:'disconnected'}),extensionSnapshot:()=>unknownExtensions(null),assertExecutionAvailable:()=>{},submitTask:async()=>{submits++;throw Error('NO_DISPATCH');},interrupt:async(id:string)=>{stops++;assert.equal(id,run.id);if(failStop)throw Error('private provider failure');f.store.updateRun(id,{execution:'interrupting'},'interrupt.requested');}} as unknown as Controller;
 const server=createHttpServer(controller,'unused');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,base='/api/projects/p',path=base+'/capability-invocations';
 const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
 const headers={cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json'};
 const post=(url:string,data:unknown)=>fetch(origin+url,{method:'POST',headers,body:JSON.stringify(data)}),get=(url:string)=>fetch(origin+url,{headers:{cookie}});
 async function json<T>(response:Response):Promise<T>{const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body as T;}
 const route=async(text:string,extra:object={})=>json<CapabilityRouteDecision>(await post(base+'/capability-routes',{requestId:randomUUID(),taskId:f.task.id,runId:run.id,text,...extra}));
 return {...f,run,origin,base,path,cookie,post,get,json,route,submits:()=>submits,stops:()=>stops,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.store.close();}};
}
test('invocation HTTP requires session/CSRF and exact approval; rejects forged provider and target',async()=>{
 const f=await setup();try{
  assert.equal((await fetch(f.origin+f.path)).status,401);
  assert.equal((await fetch(f.origin+f.path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(f.origin+f.path,{method:'POST',headers:{cookie:f.cookie,origin:f.origin,'content-type':'application/json'},body:'{}'})).status,403);
  const route=await f.route('상태 조회');assert.equal(route.status,'recommended');
  const input={requestId:randomUUID(),routeId:route.id,expectedDigest:route.invocationDigest,confirmed:true};
  for(const forged of [{runtimeId:'codex'},{runId:randomUUID()},{prompt:'/bad'},{actualModel:'invented'}])assert.equal((await f.post(f.path,{...input,...forged})).status,400);
  assert.equal((await f.post(f.path,{...input,confirmed:false})).status,409);
  assert.equal((await f.post(f.path,{...input,expectedDigest:'0'.repeat(64)})).status,409);
  assert.equal((await f.post(f.base+'/capability-routes',{requestId:randomUUID(),taskId:f.task.id,runId:randomUUID(),text:'상태 조회'})).status,404);
  const foreign=f.store.createRun(randomUUID(),'digest','prompt',undefined,{runtime:'claude-code',projectId:'other',taskId:f.task.id,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash});
  assert.equal((await f.post(f.base+'/capability-routes',{requestId:randomUUID(),taskId:f.task.id,runId:foreign.id,text:'결과 조회'})).status,404);
  const mismatch=await f.route('Codex 상태 조회');assert.equal(mismatch.status,'blocked');
  assert.equal((await f.post(f.path,{...input,routeId:mismatch.id,expectedDigest:mismatch.invocationDigest})).status,409);
  assert.equal((await f.post(f.path+'?execute=true',input)).status,400);
  assert.equal((await f.get(f.path+'?execute=true')).status,400);assert.equal((await f.get('/api/projects/missing/capability-invocations')).status,404);
  assert.equal(f.submits(),0);assert.equal(f.stops(),0);
 }finally{await f.close();}
});
test('natural target result route returns existing sanitized response and persisted GET is inert',async()=>{
 const f=await setup();try{
  f.store.updateRun(f.run.id,{execution:'completed',response:'Saved safe result'},'run.completed');
  f.store.append('run.runtime_source',f.run.id,{source:'mock',interface:'claude.print'});
  f.store.append('run.runtime_outcome',f.run.id,{source:'mock',dispatch:'started',exit:'observed'});
  const route=await f.route('Claude 결과 수집');assert.equal(route.status,'recommended');assert.equal(route.actualModel,'unknown');
  const input={requestId:randomUUID(),routeId:route.id,expectedDigest:route.invocationDigest,confirmed:true};
  const result=await f.json<CapabilityInvocationRecord>(await f.post(f.path,input));
  assert.equal(result.status,'completed');assert.equal(result.result!.response,'Saved safe result');assert.equal(result.result!.providerEvidence.source,'mock');assert.equal(result.result!.providerEvidence.livePipelineVerified,false);
  const seq=f.store.lastSeq();assert.deepEqual(await f.json(await f.post(f.path,input)),result);
  assert.deepEqual(await f.json(await f.get(f.path)),{records:[result]});assert.equal(f.store.lastSeq(),seq);
  assert.equal((await f.post(f.path,{...input,routeId:randomUUID()})).status,409);
  assert.equal(f.submits(),0);assert.equal(f.stops(),0);assert.equal(f.store.runs().length,1);
  const events=f.store.eventsAfter(0).filter(event=>event.kind==='capability.invocation');
  assert.ok(events.length>0);assert.equal(JSON.stringify(events).includes('Saved safe result'),false);
 }finally{await f.close();}
});
for(const failStop of [false,true])test(`interrupt HTTP is idempotent and ${failStop?'uncertain outcome stays unknown':'request does not falsely confirm stop'}`,async()=>{
 const f=await setup(failStop);try{
  const route=await f.route('Claude 실행 중단');assert.equal(route.status,'recommended');
  const input={requestId:randomUUID(),routeId:route.id,expectedDigest:route.invocationDigest,confirmed:true};
  const responses=await Promise.all([f.post(f.path,input),f.post(f.path,input)]);
  const first=await f.json<CapabilityInvocationRecord>(responses[0]),second=await f.json<CapabilityInvocationRecord>(responses[1]);
  assert.equal(first.id,second.id);assert.equal(first.status,failStop?'unknown':'requested');assert.equal(first.issue,failStop?'INTERRUPT_UNCONFIRMED':null);
  if(first.result)assert.equal(first.result.stopConfirmed,false);
  assert.equal(f.stops(),1);assert.equal(f.submits(),0);
  assert.equal((await f.json<CapabilityInvocationRecord>(await f.post(f.path,input))).id,first.id);assert.equal(f.stops(),1);
  assert.equal(JSON.stringify(await f.json(await f.get(f.path))).includes('private provider failure'),false);
 }finally{await f.close();}
});
