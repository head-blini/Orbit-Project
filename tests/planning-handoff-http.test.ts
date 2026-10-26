import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { Studio } from '../server/studio.ts';
import { createHttpServer } from '../server/http.ts';
import type { Controller } from '../server/controller.ts';
import type { PlanningVersion,SavedTask } from '../shared/parallel.ts';
import { parsePlanningDraft } from '../server/planning/parser.ts';

const input={format:'markdown',source:'manual',text:'# Plan\n## Goal\nPreserve content\n## Requirements\n### R1\nExport reliably\n#### Acceptance criteria\n- Import again\n## Constraints\n## Open questions\n'};
async function fixture(){
  const store=new Store(':memory:'),studio=new Studio(store),p='project-a',w=randomUUID();
  for(const id of [p,'project-b'])store.saveProject({id,name:id,path:'unused',createdAt:'',writeEnabled:false});
  store.saveWorkspace({id:w,projectId:p,path:'unused',branch:'fixture',baseSha:'b'.repeat(40),createdAt:'',status:'ready'});
  const plan=studio.mutate(p,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  studio.mutate(p,'plans',plan.id,'approve',{expectedRevision:1});
  const [task]=studio.mutate(p,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const run=store.createRun(randomUUID(),'digest','SECRET_INPUT',w,{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});store.updateRun(run.id,{execution:'completed'},'test');
  const controller={store,verification:{view:()=>{throw new Error('unavailable');}},workspaceDiff:()=>{throw new Error('unavailable');}} as unknown as Controller;
  const server=createHttpServer(controller,'.');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,session=await fetch(origin+'/api/session');
  const cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
  return {store,studio,p,plan,task,run,origin,headers,get:(path:string)=>fetch(origin+path,{headers:{cookie}}),post:(path:string,data:object)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(data)}),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}};
}
test('authenticated planning download binds immutable content, roundtrips formats, and rejects ownership/hash/query overrides',async()=>{
  const f=await fixture();try{
    const url=`/api/projects/${f.p}/plans/${f.plan.id}/export?revision=1&hash=${f.plan.contentHash}&format=json`;
    const exported=await f.get(url);assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition')!,/attachment; filename="orbit-plan-.*-v1.json"/);
    const json=await exported.text();const parsed=parsePlanningDraft({format:'json',text:json,source:'manual'});assert.deepEqual(parsed,{ok:true,draft:f.plan.draft});
    const md=await f.get(url.replace('format=json','format=markdown'));assert.equal(md.status,200);assert.deepEqual(parsePlanningDraft({format:'markdown',text:await md.text(),source:'manual'}),parsed);
    assert.equal((await fetch(f.origin+url)).status,401);assert.equal((await f.get(url.replace('project-a','project-b'))).status,404);
    assert.equal((await f.get(url.replace(f.plan.contentHash,'0'.repeat(64)))).status,409);assert.equal((await f.get(url+'&path=private')).status,400);assert.equal((await f.get(url+'&format=json')).status,400);
    f.studio.mutate(f.p,'plans',f.plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:{...input,text:input.text.replace('Preserve content','Changed goal')}});
    assert.equal(await (await f.get(url)).text(),json,'historical content stays exportable without authorizing a new run');
    assert.equal(f.store.runs().length,1);
  }finally{await f.close();}
});
test('feedback preview is an explicit CSRF-protected project request and writes no questions or execution',async()=>{
  const f=await fixture();try{
    const url=`/api/projects/${f.p}/planning-feedback`,body={taskId:f.task.id,runId:f.run.id,question:'Manual reconsideration'};
    assert.equal((await f.get(url)).status,404);
    assert.equal((await fetch(f.origin+url,{method:'POST',headers:{...f.headers,'x-csrf-token':''},body:JSON.stringify(body)})).status,403);
    const before=f.store.lastSeq(),response=await f.post(url,body);assert.equal(response.status,200);
    const result=await response.json() as any;assert.equal(result.verification.available,false);assert.equal(result.verification.approvalCurrent,false);assert.match(result.markdown,/Manual reconsideration/);assert.doesNotMatch(JSON.stringify(result),/SECRET_INPUT/);
    assert.equal((await f.post(url.replace('project-a','project-b'),body)).status,404);assert.equal((await f.post(url,{...body,approvalCurrent:true})).status,400);
    assert.equal((await f.post(url+'?path=private',body)).status,400);assert.equal((await f.post(url,{...body,question:'person@example.com'})).status,422);
    assert.equal(f.store.lastSeq(),before);assert.equal(f.store.runs().length,1);
  }finally{await f.close();}
});
