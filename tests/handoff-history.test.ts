import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ClaudeTaskService} from '../server/claude-task-service.ts';
import {handoffHistory} from '../server/handoff-history.ts';
import {claudeFixture,outcome,session,tick} from './claude-task-fixture.ts';

test('Claude dispatch records a digest-only delivery; ack only after executor start; no record for refused launch',async()=>{
  const f=claudeFixture();
  const service=new ClaudeTaskService(f.store,f.projects,f.dependencies);
  try{
    const {task,version}=f.plan();
    // refused launch (credential-like request id invalid) records nothing
    assert.throws(()=>service.submit(f.project.id,task.id,'x'));
    assert.deepEqual(handoffHistory(f.store,f.project.id,task.id),[]);
    const requestId=randomUUID(),before=f.store.lastSeq();
    const run=service.submit(f.project.id,task.id,requestId);
    let [entry]=handoffHistory(f.store,f.project.id,task.id);
    assert.equal(entry.runId,run.id);assert.equal(entry.requestId,requestId);assert.equal(entry.destination,'claude-code');
    assert.equal(entry.receipt,'delivered');assert.equal(entry.planningVersionId,version.id);assert.equal(entry.planningContentHash,version.contentHash);
    // Package is built before the run exists; a rebuild now differs (sourceRunId), so only the shape is checked.
    assert.match(entry.packageDigest,/^[0-9a-f]{64}$/);
    // replay of the same request does not duplicate
    service.submit(f.project.id,task.id,requestId);assert.equal(handoffHistory(f.store,f.project.id,task.id).length,1);
    assert.ok(f.store.lastSeq()>before);
    const stored=JSON.stringify(f.store.db.prepare("SELECT data FROM events WHERE kind='handoff.delivered'").all());
    assert.ok(!stored.includes('Compare local evidence'));
    // GET path (read) does not mutate
    const seq=f.store.lastSeq();handoffHistory(f.store,f.project.id,task.id);assert.equal(f.store.lastSeq(),seq);
    f.runners[0].emit(session);await tick();
    [entry]=handoffHistory(f.store,f.project.id,task.id);assert.equal(entry.receipt,'acknowledged');
    f.runners[0].finish(outcome('completed'));await tick();
  }finally{for(const r of f.runners)r.finish(outcome("interrupted"));await service.close();await f.close();}
});
test('lost run without executor start stays delivered and shows terminal state',async()=>{
  const f=claudeFixture();const service=new ClaudeTaskService(f.store,f.projects,f.dependencies);
  try{
    const {task}=f.plan();service.submit(f.project.id,task.id,randomUUID());
    f.runners[0].finish(outcome('error',{exit:'not_observed'}));await tick();
    const [entry]=handoffHistory(f.store,f.project.id,task.id);
    assert.equal(entry.receipt,'delivered');assert.notEqual(entry.runExecution,'running');
  }finally{for(const r of f.runners)r.finish(outcome("interrupted"));await service.close();await f.close();}
});

import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
test('GET handoff-history is authenticated, query-free, 404 for unknown task and never mutates',async()=>{
  const store=new Store(':memory:'),studio=new Studio(store),projectId='project-a';
  store.saveProject({id:projectId,name:projectId,kind:'general',path:'/unused',createdAt:'',writeEnabled:false});
  const input={format:'markdown',source:'manual',text:'# R\n## Goal\nWrite\n## Requirements\n### R1\nSummarize\n#### Acceptance criteria\n- Listed\n'};
  const plan=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  studio.mutate(projectId,'plans',plan.id,'approve',{expectedRevision:1});
  const [task]=studio.mutate(projectId,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const server=createHttpServer(new Proxy({store},{get:(t,k)=>k==='store'?t.store:()=>{throw new Error('UNEXPECTED');}}) as unknown as Controller,'.');
  try{
    await new Promise<void>((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const cookie=(await fetch(origin+'/api/session')).headers.get('set-cookie')!.split(';')[0],headers={cookie};
    const path=`/api/projects/${projectId}/tasks/${task.id}/handoff-history`,before=store.lastSeq();
    assert.equal((await fetch(origin+path)).status,401);
    const response=await fetch(origin+path,{headers});assert.equal(response.status,200);assert.deepEqual(await response.json(),{entries:[]});
    assert.equal((await fetch(origin+path+'?x=1',{headers})).status,400);
    assert.equal((await fetch(origin+path.replace(task.id,randomUUID()),{headers})).status,404);
    assert.equal(store.lastSeq(),before);
  }finally{server.closeAllConnections();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
