import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {GoalService} from '../server/goal-service.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {CreateTrackedGoalInput} from '../shared/goals.ts';

function fixture(path=':memory:'){
  const store=new Store(path),studio=new Studio(store);
  for(const id of ['project-a','project-b'])store.saveProject({id,name:id,path:'never-open-this-path',createdAt:'',writeEnabled:false});
  const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Local goal',goal:'Preserve approved work',requirements:[{id:'R1',description:'Persist state',acceptance_criteria:['Survives restart']}],constraints:['No external calls'],open_questions:[]})};
  const draft=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  return {store,studio,draft,input,goals:new GoalService(store),approve:()=>studio.mutate('project-a','plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion};
}
const createInput=(p:PlanningVersion):CreateTrackedGoalInput=>({requestId:randomUUID(),planningVersionId:p.id,expectedPlanningHash:p.contentHash});

test('tracking requires an exact current approved plan but no runtime or writable project',()=>{
  const f=fixture();try{
    const request=createInput(f.draft);assert.throws(()=>f.goals.create('project-a',request),/PLAN_NOT_APPROVED/);
    f.approve();const goal=f.goals.create('project-a',request);
    assert.equal(goal.level,'tracking');assert.equal(goal.state,'tracking');assert.equal(goal.revision,1);
    assert.deepEqual(f.goals.create('project-a',request),goal);assert.equal(f.goals.list('project-a').length,1);
    assert.throws(()=>f.goals.create('project-b',request),/IDEMPOTENCY_CONFLICT/);
    assert.throws(()=>f.goals.create('project-b',createInput(f.draft)),/PLAN_NOT_FOUND/);
    assert.throws(()=>f.goals.create('project-a',{...createInput(f.draft),expectedPlanningHash:'a'.repeat(64)}),/PLAN_CHANGED/);
    assert.throws(()=>f.goals.create('project-a',createInput(f.draft)),/GOAL_ALREADY_TRACKED/);
    assert.equal(f.store.runs().length,0);assert.equal(f.store.projects()[0].writeEnabled,false);
  }finally{f.store.close();}
});
test('tracking revisions are atomic, replayable and durable without rewriting plan or task history',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-goal-')),path=join(root,'fixture.sqlite');const f=fixture(path);let reopened:Store|undefined;
  try{
    const plan=f.approve(),tasks=f.studio.mutate('project-a','plans',plan.id,'task-drafts',{}),request=createInput(plan),goal=f.goals.create('project-a',request);
    const pause={requestId:randomUUID(),expectedRevision:1,state:'paused' as const};const paused=f.goals.setState('project-a',goal.id,pause);
    assert.equal(paused.revision,2);assert.deepEqual(f.goals.setState('project-a',goal.id,pause),paused);
    assert.throws(()=>f.goals.setState('project-a',goal.id,{...pause,state:'tracking'}),/IDEMPOTENCY_CONFLICT/);
    assert.throws(()=>f.goals.setState('project-a',goal.id,{requestId:randomUUID(),expectedRevision:1,state:'tracking'}),/GOAL_REVISION_CONFLICT/);
    const cancelled=f.goals.setState('project-a',goal.id,{requestId:randomUUID(),expectedRevision:2,state:'cancelled'});
    assert.throws(()=>f.goals.setState('project-a',goal.id,{requestId:randomUUID(),expectedRevision:3,state:'tracking'}),/GOAL_CANCELLED/);
    assert.deepEqual(f.goals.history('project-a',goal.id).map(g=>g.state),['tracking','paused','cancelled']);
    assert.throws(()=>f.goals.history('project-b',goal.id),/GOAL_NOT_FOUND/);
    const events=f.store.lastSeq();f.store.close();reopened=new Store(path);const goals=new GoalService(reopened),studio=new Studio(reopened);
    assert.deepEqual(goals.list('project-a')[0].goal,cancelled);assert.deepEqual(goals.create('project-a',request),goal);
    assert.deepEqual(goals.setState('project-a',goal.id,pause),paused);assert.equal(goals.list('project-a')[0].goal.state,'cancelled');
    assert.equal(reopened.lastSeq(),events);assert.deepEqual(studio.read('project-a','tasks'),tasks);assert.deepEqual(studio.read('project-a','plans'),[plan]);
  }finally{if(reopened)reopened.close();else try{f.store.close();}catch{}rmSync(root,{recursive:true,force:true});}
});
test('a newer plan invalidates applicability while retaining historical goal binding and receipts',()=>{
  const f=fixture();try{
    const plan=f.approve(),request=createInput(plan),goal=f.goals.create('project-a',request);
    const next=f.studio.mutate('project-a','plans',plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:f.input}) as PlanningVersion;
    const view=f.goals.list('project-a')[0];assert.equal(view.planCurrent,false);assert.ok(view.blockers.includes('PLAN_NOT_CURRENT'));
    assert.deepEqual(view.goal,goal);assert.deepEqual(f.goals.create('project-a',request),goal);
    assert.throws(()=>f.goals.create('project-a',createInput(plan)),/PLAN_NOT_CURRENT/);
    assert.throws(()=>f.goals.create('project-a',createInput(next)),/PLAN_NOT_APPROVED/);
  }finally{f.store.close();}
});
test('completed run and passed check remain reference-only, scoped to canonical project task and workspace',()=>{
  const f=fixture();try{
    const plan=f.approve(),[task]=f.studio.mutate('project-a','plans',plan.id,'task-drafts',{}) as SavedTask[];
    f.store.saveWorkspace({id:'workspace-a',projectId:'project-a',path:'never-read',branch:'fixture',baseSha:'a'.repeat(40),createdAt:'',status:'ready'});
    f.store.saveWorkspace({id:'workspace-b',projectId:'project-b',path:'never-read',branch:'fixture',baseSha:'a'.repeat(40),createdAt:'',status:'ready'});
    const run=f.store.createRun('goal-run-01','digest','PRIVATE PROMPT','workspace-a',{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
    f.store.updateRun(run.id,{execution:'completed',response:'PRIVATE RESPONSE'},'run.completed');
    f.store.createRun('goal-run-02','digest','FOREIGN PROMPT','workspace-b',{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
    f.store.db.exec('CREATE TABLE verification_checks(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,body TEXT NOT NULL)');
    const check={id:'check-a',runId:run.id,workspaceId:'workspace-a',projectId:'project-a',execution:'completed',verdict:'passed',sourceDigest:'a'.repeat(64),output:'PRIVATE OUTPUT'};
    f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(check.id,'check-req',JSON.stringify(check));
    f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run('foreign','foreign-req',JSON.stringify({...check,id:'foreign',projectId:'project-b'}));
    const goal=f.goals.create('project-a',createInput(plan)),seq=f.store.lastSeq(),before=f.store.getRun(run.id);
    const view=f.goals.list('project-a')[0],req=view.requirements[0];
    assert.equal(req.acceptance,'unverified');assert.deepEqual(req.runs,[{id:run.id,execution:'completed'}]);
    assert.deepEqual(req.evidence.map(e=>[e.kind,e.id,e.qualification]),[['run',run.id,'reference_only'],['check','check-a','reference_only']]);
    assert.equal(view.goal.state,'tracking');assert.ok(view.blockers.includes('ACCEPTANCE_NOT_QUALIFIED'));
    assert.doesNotMatch(JSON.stringify(view),/PRIVATE|FOREIGN|OUTPUT/);assert.equal(f.store.lastSeq(),seq);assert.deepEqual(f.store.getRun(run.id),before);
    assert.throws(()=>f.goals.setState('project-a',goal.id,{requestId:randomUUID(),expectedRevision:1,state:'achieved'} as any),/INVALID_FIELDS/);
  }finally{f.store.close();}
});
test('goal mutation failure rolls back records, history, receipt and audit event together',()=>{
  const f=fixture();try{
    const plan=f.approve(),request=createInput(plan),seq=f.store.lastSeq();
    f.store.db.exec("CREATE TRIGGER fail_goal_event BEFORE INSERT ON events WHEN NEW.kind='goal.created' BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>f.goals.create('project-a',request),/fixture/);assert.equal(f.goals.list('project-a').length,0);assert.equal(f.store.lastSeq(),seq);
    f.store.db.exec('DROP TRIGGER fail_goal_event');const goal=f.goals.create('project-a',request);
    f.store.db.exec("CREATE TRIGGER fail_goal_history BEFORE INSERT ON goal_history BEGIN SELECT RAISE(FAIL,'history fixture'); END;");
    assert.throws(()=>f.goals.setState('project-a',goal.id,{requestId:randomUUID(),expectedRevision:1,state:'paused'}),/history fixture/);
    assert.deepEqual(f.goals.list('project-a')[0].goal,goal);assert.equal(f.goals.history('project-a',goal.id).length,1);
  }finally{f.store.close();}
});
test('goal requirement run projection is bounded without hiding totals or older recovery blockers',()=>{
  const f=fixture();try{
    const plan=f.approve(),[task]=f.studio.mutate('project-a','plans',plan.id,'task-drafts',{}) as SavedTask[];
    f.store.saveWorkspace({id:'workspace-a',projectId:'project-a',path:'never-read',branch:'fixture',baseSha:'a'.repeat(40),createdAt:'',status:'ready'});
    for(let i=0;i<105;i++){
      const run=f.store.createRun('bounded-goal-'+i,'digest','Not exposed','workspace-a',{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
      f.store.updateRun(run.id,{execution:i===0?'lost':'completed'},'run.fixture');
    }
    f.goals.create('project-a',createInput(plan));
    const view=f.goals.list('project-a')[0],requirement=view.requirements[0];
    assert.equal(requirement.runsTotal,105);assert.equal(requirement.runs.length,100);
    assert.deepEqual(requirement.runs.map(run=>run.id),f.store.runs().slice(-100).map(run=>run.id));
    assert.equal(requirement.evidenceTotal,105);assert.equal(requirement.evidence.length,100);
    assert.ok(view.blockers.includes('RUN_RECOVERY_UNRESOLVED'));
  }finally{f.store.close();}
});
test('lost verification remains visible and blocks tracking until its recorded recovery',()=>{
  const f=fixture();try{
    const plan=f.approve(),[task]=f.studio.mutate('project-a','plans',plan.id,'task-drafts',{}) as SavedTask[];
    f.store.saveWorkspace({id:'workspace-a',projectId:'project-a',path:'never-read',branch:'fixture',baseSha:'a'.repeat(40),createdAt:'',status:'ready'});
    const run=f.store.createRun('lost-check-goal','digest','Fixture','workspace-a',{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
    f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    f.store.db.exec('CREATE TABLE verification_checks(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,body TEXT NOT NULL)');
    const check={id:'check-lost',runId:run.id,projectId:'project-a',workspaceId:'workspace-a',execution:'lost',verdict:'not_run',recoveredAt:null};
    f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(check.id,'request-lost',JSON.stringify(check));
    f.goals.create('project-a',createInput(plan));
    const view=f.goals.list('project-a')[0];assert.ok(view.blockers.includes('EVIDENCE_RECOVERY_UNRESOLVED'));
    assert.equal(view.requirements[0].evidence.find(ref=>ref.id===check.id)?.status,'lost');
    f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify({...check,recoveredAt:new Date().toISOString()}),check.id);
    const recovered=f.goals.list('project-a')[0];assert.ok(!recovered.blockers.includes('EVIDENCE_RECOVERY_UNRESOLVED'));
    assert.equal(recovered.requirements[0].acceptance,'unverified');assert.equal(recovered.goal.state,'tracking');
  }finally{f.store.close();}
});
test('invalid fields and corrupted plan bytes cannot create a goal with forged acceptance provenance',()=>{
  const f=fixture();try{
    const plan=f.approve();
    for(const patch of [{execution:'autonomous'},{requestId:'x'},{expectedPlanningHash:'bad'},{planningVersionId:'--bad'}])assert.throws(()=>f.goals.create('project-a',{...createInput(plan),...patch} as any),/INVALID/);
    const changed=structuredClone(plan);changed.draft.requirements[0].acceptanceCriteria=[];
    assert.notEqual(createHash('sha256').update(JSON.stringify(changed.draft)).digest('hex'),plan.contentHash);
    f.store.db.prepare('UPDATE planning_versions SET body=? WHERE id=?').run(JSON.stringify(changed),plan.id);
    assert.throws(()=>f.goals.create('project-a',createInput(plan)),/PLAN_INTEGRITY/);assert.equal(f.goals.list('project-a').length,0);
  }finally{f.store.close();}
});
test('general project run (projectId, no workspaceId) counts only for its own project goal',()=>{
  const f=fixture();try{
    const plan=f.approve(),[task]=f.studio.mutate('project-a','plans',plan.id,'task-drafts',{}) as SavedTask[];
    const meta={taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1'],runtime:'claude-code' as const};
    const own=f.store.createRun('general-own','digest','Not exposed',undefined,{...meta,projectId:'project-a'});
    f.store.updateRun(own.id,{execution:'completed'},'run.completed');
    f.store.createRun('general-foreign','digest','Not exposed',undefined,{...meta,projectId:'project-b'});
    f.goals.create('project-a',createInput(plan));
    const req=f.goals.list('project-a')[0].requirements[0];
    assert.deepEqual(req.runs,[{id:own.id,execution:'completed'}]);assert.equal(req.runsTotal,1);assert.equal(req.acceptance,'unverified');
  }finally{f.store.close();}
});

test('goal completion references current CQG for every task, exposes only owned outputs, and downgrades stale/mock/unknown',()=>{
  const f=fixture();try{
    const plan=f.approve(),[task]=f.studio.mutate('project-a','plans',plan.id,'task-drafts',{}) as SavedTask[];
    const run=f.store.createRun('completion-goal','digest','fixture',undefined,{projectId:'project-a',taskId:task.id,planningVersionId:plan.id});f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    f.goals.create('project-a',createInput(plan));
    const decision={status:'passed',source:'local',freshness:'current',evidenceIds:['check-current'],blockers:[]};
    const completion:any={verifiedDone:true,qualityPassed:true,binding:{projectId:'project-a',taskId:task.id,runId:run.id,planningVersionId:plan.id,planningContentHash:plan.contentHash},gates:[{id:'unit',...decision}],independentReview:{...decision,status:'not_run',source:'unknown',freshness:'unavailable'},userApproval:{...decision,status:'not_run',source:'unknown',freshness:'unavailable'},reasonCodes:[]};
    const progress:any={projectId:'project-a',tasks:[{id:task.id,latestRunId:run.id,planCurrent:true,completion}]};
    const artifact={id:'version',deliverableId:'a'.repeat(64),path:'report.txt',size:5,sha256:'b'.repeat(64),taskId:task.id,runId:run.id,runAt:run.updatedAt,observedAt:run.updatedAt};
    const service=new GoalService(f.store,{progress:()=>progress,deliverables:()=>[artifact,{...artifact,id:'foreign',runId:'foreign-run'}]});
    const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const read=()=>service.list('project-a')[0];assert.equal(read().verifiedDone,true);assert.deepEqual(read().deliverables,[artifact]);assert.equal(read().taskCompletions![0].completion!.gates[0].evidenceIds[0],'check-current');
    for(const source of ['mock','unknown']){completion.gates[0].source=source;assert.equal(read().verifiedDone,false);}completion.gates[0].source='local';
    completion.gates[0].freshness='stale';assert.equal(read().verifiedDone,false);completion.gates[0].freshness='current';
    completion.binding.runId='old';assert.equal(read().verifiedDone,false);completion.binding.runId=run.id;
    progress.tasks.push({id:'unrelated',completion});assert.equal(read().verifiedDone,true);
    progress.tasks[0].latestRunId='newer';assert.equal(read().verifiedDone,false);progress.tasks[0].latestRunId=run.id;
    completion.verifiedDone=false;assert.equal(read().verifiedDone,false);completion.verifiedDone=true;
    completion.independentReview={...decision,source:'mock',status:'completed'};assert.equal(read().verifiedDone,false);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes,'goal reads do not persist completion or observations');
    completion.independentReview={...decision,status:'not_run',source:'unknown',freshness:'unavailable'};
    f.store.db.prepare('UPDATE planning_tasks SET body=? WHERE version_id=?').run(JSON.stringify([task,{...task,id:'second-task'}]),plan.id);
    assert.equal(read().taskCompletions!.length,2);assert.equal(read().verifiedDone,false,'every referenced task must have current completion');

  }finally{f.store.close();}
});
