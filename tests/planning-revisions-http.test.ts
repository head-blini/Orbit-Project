import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {PlanningComparison} from '../shared/planning-revisions.ts';

test('planning diff is authenticated and inert; replan requires exact CSRF consent and creates only selected drafts',async()=>{
  const store=new Store(':memory:'),studio=new Studio(store);
  for(const id of ['project-a','project-b'])store.saveProject({id,name:id,path:'never-accessed',createdAt:new Date().toISOString(),writeEnabled:false});
  const input={format:'markdown',source:'manual',text:'# Plan\n## Goal\nSaved revisions\n## Requirements\n### R1\nOld requirement\n#### Acceptance criteria\n- Check\n## Constraints\n- Preserve source\n## Open questions\n'};
  const base=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  studio.mutate('project-a','plans',base.id,'approve',{expectedRevision:1});const old=studio.mutate('project-a','plans',base.id,'task-drafts',{}) as SavedTask[];
  const next=studio.mutate('project-a','plans',base.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:{...input,text:input.text.replace('Old requirement','New requirement')}}) as PlanningVersion;
  studio.mutate('project-a','plans',next.id,'approve',{expectedRevision:2});
  const server=createHttpServer({store} as unknown as Controller,'.');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
  const get=(path:string)=>fetch(origin+path,{headers:{cookie}}),post=(path:string,data:object)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(data)});
  try{
    const url=`/api/projects/project-a/plans/${next.id}/diff?baseVersionId=${base.id}`,replan=`/api/projects/project-a/plans/${next.id}/replan`,seq=store.lastSeq();
    assert.equal((await fetch(origin+url)).status,401);const response=await get(url);assert.equal(response.status,200);const comparison=await response.json() as PlanningComparison;
    assert.equal(comparison.canReplan,true);assert.equal(comparison.affectedTasks[0].taskId,old[0].id);assert.equal(store.lastSeq(),seq);assert.equal(store.runs().length,0);
    for(const invalid of [url+'&baseVersionId='+base.id,url+'&path=private',url.replace(base.id,'unknown'),url.split('?')[0]])assert.equal((await get(invalid)).status,400);
    assert.equal((await get(url.replace('project-a','project-b'))).status,404);
    const body={requestId:randomUUID(),baseVersionId:base.id,expectedPreviewDigest:comparison.previewDigest,requirementLabels:['R1']};
    assert.equal((await fetch(origin+replan,{method:'POST',headers:{...headers,'x-csrf-token':''},body:JSON.stringify(body)})).status,403);
    assert.equal((await post(replan,{...body,approved:true})).status,400);assert.equal((await post(replan+'?path=private',body)).status,400);assert.equal((await get(replan)).status,404);
    const created=await post(replan,body);assert.equal(created.status,200);const tasks=await created.json() as SavedTask[];assert.equal(tasks.length,1);assert.deepEqual(tasks[0].replannedFrom,{planningVersionId:base.id,taskIds:[old[0].id]});
    assert.deepEqual(await (await post(replan,body)).json(),tasks);assert.equal(store.lastSeq(),seq+1);assert.equal(store.runs().length,0);
    assert.deepEqual((studio.read('project-a','tasks') as SavedTask[]).filter(t=>t.planningVersionId===base.id),old);
    assert.doesNotMatch(JSON.stringify(store.eventsAfter(seq)),/New requirement|Old requirement/);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
