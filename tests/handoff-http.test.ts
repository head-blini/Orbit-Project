import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {HandoffPackage} from '../shared/handoff.ts';

for(const kind of ['general','code'] as const)test(`GET task handoff is authenticated, query-free and inert for ${kind} projects`,async()=>{
  const store=new Store(':memory:'),studio=new Studio(store),projectId='project-a';let calls=0;
  for(const id of [projectId,'project-b'])store.saveProject({id,name:id,kind,path:'/unused',createdAt:'',writeEnabled:false});
  const input={format:'markdown',source:'manual',text:'# Report\n## Goal\nWrite a report\n## Requirements\n### R1\nSummarize\n#### Acceptance criteria\n- Evidence listed\n## Non-goals\n- No network\n'};
  const plan=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  studio.mutate(projectId,'plans',plan.id,'approve',{expectedRevision:1});
  const [task]=studio.mutate(projectId,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const controller=new Proxy({store},{get(target,key){if(key==='store')return target.store;return ()=>{calls++;throw new Error('UNEXPECTED_CONTROLLER_CALL');};}}) as unknown as Controller;
  const server=createHttpServer(controller,'.');
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0];
    const {csrfToken}=await session.json() as {csrfToken:string};
    const path=`/api/projects/${projectId}/tasks/${task.id}/handoff`,headers={cookie},before=store.lastSeq();
    assert.equal((await fetch(origin+path)).status,401);
    for(let i=0;i<2;i++){
      const response=await fetch(origin+path,{headers});assert.equal(response.status,200);
      const result=await response.json() as HandoffPackage;
      assert.equal(result.taskId,task.id);assert.equal(result.baseline.current,true);assert.equal(result.sourceRunId,null);assert.deepEqual(result.nonGoals,['No network']);
    }
    for(const query of ['?runId='+randomUUID(),'?taskId='+task.id,'?x=1&x=2'])assert.equal((await fetch(origin+path+query,{headers})).status,400);
    for(const foreign of [path.replace(projectId,'missing-project'),path.replace(projectId,'project-b'),path.replace(task.id,randomUUID())])assert.equal((await fetch(origin+foreign,{headers})).status,404);
    assert.equal((await fetch(origin+path,{method:'POST',headers:{...headers,origin,'content-type':'application/json','x-csrf-token':csrfToken},body:'{}'})).status,404);
    assert.equal(calls,0);assert.equal(store.lastSeq(),before);assert.equal(store.runs().length,0);assert.equal(store.workspaces().length,0);
  }finally{
    server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();
  }
});
