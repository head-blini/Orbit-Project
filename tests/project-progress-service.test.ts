import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {ProjectProgressService} from '../server/project-progress.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

function fixture(path=':memory:'){
  const store=new Store(path),studio=new Studio(store);
  for(const id of ['project-a','project-b'])store.saveProject({id,name:id,path:'never-open-this-path',createdAt:'',writeEnabled:false});
  store.saveWorkspace({id:'ws-a',projectId:'project-a',path:'never-open',branch:'b',baseSha:'0'.repeat(40),createdAt:'',status:'ready'});
  store.saveWorkspace({id:'ws-b',projectId:'project-b',path:'never-open',branch:'b',baseSha:'0'.repeat(40),createdAt:'',status:'ready'});
  const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Market report',goal:'Summarise the market',
    requirements:[{id:'R1',description:'Collect sources',acceptance_criteria:['Three sources cited','Dates recorded']}],constraints:[],open_questions:[]})};
  const draft=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  const plan=studio.mutate('project-a','plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
  const tasks=studio.mutate('project-a','plans',plan.id,'task-drafts',{}) as SavedTask[];
  return {store,studio,plan,tasks,service:new ProjectProgressService(store,studio)};
}

test('progress reads the approved plan, its tasks and only this project runs',()=>{
  const f=fixture();try{
    const task=f.tasks[0];
    f.store.createRun(randomUUID(),'d'.repeat(64),'collect','ws-a',{taskId:task.id,planningVersionId:f.plan.id,requirementLabels:task.requirementLabels});
    f.store.createRun(randomUUID(),'e'.repeat(64),'other project','ws-b');
    const progress=f.service.read('project-a',{});
    assert.equal(progress.plan?.id,f.plan.id);assert.equal(progress.plan?.title,'Market report');
    assert.equal(progress.totals.tasks,f.tasks.length);assert.equal(progress.criteria.total,2);
    assert.equal(progress.tasks[0].runsTotal,1);assert.equal(progress.tasks[0].stage,'running');assert.equal(progress.tasks[0].assignee,'codex');
    assert.equal(progress.untaskedRuns,0);
    assert.throws(()=>f.service.read('missing',{}),/PROJECT_NOT_FOUND/);
  }finally{f.store.close();}
});

test('get_progress_never_starts_run: reading progress appends no events and creates no runs',()=>{
  const f=fixture();try{
    const seq=f.store.lastSeq(),runs=f.store.runs().length;
    f.service.read('project-a',{quota:'exhausted'});f.service.read('project-a',{});
    assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.runs().length,runs);
  }finally{f.store.close();}
});

test('a restart preserves progress and turns an unfinished run into lost, never completed',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-progress-')),path=join(root,'fixture.sqlite');const f=fixture(path);let reopened:Store|undefined;
  try{
    const task=f.tasks[0];
    f.store.createRun(randomUUID(),'d'.repeat(64),'collect','ws-a',{taskId:task.id,planningVersionId:f.plan.id,requirementLabels:task.requirementLabels});
    f.store.close();
    reopened=new Store(path);const progress=new ProjectProgressService(reopened,new Studio(reopened)).read('project-a',{});
    assert.equal(progress.tasks[0].stage,'lost');assert.equal(progress.totals.verifiedTasks,0);
  }finally{reopened?.close();rmSync(root,{recursive:true,force:true});}
});
