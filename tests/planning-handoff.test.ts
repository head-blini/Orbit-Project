import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { Studio } from '../server/studio.ts';
import { PlanningHandoffService } from '../server/planning-handoff-service.ts';
import type { PlanningVersion,SavedTask } from '../shared/parallel.ts';
import type { VerificationView,CheckRecord } from '../shared/verification.ts';

const input={format:'markdown',source:'manual',text:'# Handoff\n## Goal\nSafe changes\n## Requirements\n### R1\nMake a greeting\n#### Acceptance criteria\n- Node check passes\n## Constraints\n- Keep interfaces\n## Open questions\n'};
function fixture(){
  const store=new Store(':memory:'),studio=new Studio(store),p='project-a',w=randomUUID();
  for(const id of [p,'project-b'])store.saveProject({id,name:id,path:'private-path-not-exported',createdAt:'',writeEnabled:true});
  store.saveWorkspace({id:w,projectId:p,path:'private-worktree',branch:'private-branch',baseSha:'b'.repeat(40),createdAt:'',status:'ready'});
  const plan=studio.mutate(p,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  studio.mutate(p,'plans',plan.id,'approve',{expectedRevision:1});
  const [task]=studio.mutate(p,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const run=store.createRun(randomUUID(),'digest','SENSITIVE_PROMPT',w,{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
  store.updateRun(run.id,{execution:'completed',response:'SENSITIVE_RESPONSE'},'test.completed');
  const check:CheckRecord={id:randomUUID(),requestId:randomUUID(),runId:run.id,projectId:p,workspaceId:w,commandId:'node-check',configDigest:'c'.repeat(64),baseSha:'b'.repeat(40),sourceDigest:'d'.repeat(64),finishedDigest:'d'.repeat(64),createdAt:'2026-10-26T00:00:00.000Z',completedAt:'2026-10-26T00:00:01.000Z',execution:'completed',verdict:'passed',exitCode:0,durationMs:1000,output:'SENSITIVE_OUTPUT',recoveredAt:null};
  const view:VerificationView={workspaceId:w,runId:run.id,commands:[],sourceDigest:'d'.repeat(64),sourceIssue:null,checks:[check],quarantined:false,checkSetDigest:'f'.repeat(64),canApprove:true,approval:{id:randomUUID(),requestId:randomUUID(),runId:run.id,workspaceId:w,sourceDigest:'d'.repeat(64),checkSetDigest:'f'.repeat(64),createdAt:''},approvalCurrent:true,scope:'test'};
  let reads=0;
  const service=new PlanningHandoffService(store,()=>{reads++;return view;},()=>({workspaceId:w,baseSha:'b'.repeat(40),files:[{path:'greet.ts',status:'M',patch:'SENSITIVE_PATCH'}]}));
  const request={taskId:task.id,runId:run.id,question:'Should we add a second greeting?'};
  return {store,studio,service,p,w,plan,task,run,view,check,request,reads:()=>reads};
}
test('feedback projects only bound evidence and keeps execution, checks and current approval separate',()=>{
  const f=fixture();try{
    const before=f.store.lastSeq(),result=f.service.create(f.p,f.request);
    assert.equal(result.run.execution,'completed');assert.equal(result.verification.approvalCurrent,true);assert.equal(result.verification.checks[0].exitCode,0);
    assert.deepEqual(result.changes.files,[{path:'greet.ts',status:'M'}]);assert.equal(result.planning.current,true);
    assert.match(result.markdown,/Node check passes/);assert.match(result.markdown,/Should we add/);
    assert.doesNotMatch(JSON.stringify(result),/SENSITIVE_|private-path|private-worktree|private-branch|requestId|recoveredAt/);
    assert.equal(f.store.lastSeq(),before,'read-only preview does not persist questions, response or audit bodies');
    assert.equal(f.store.runs().length,1);
    f.view.canApprove=false;f.view.approvalCurrent=false;f.view.sourceDigest='e'.repeat(64);
    const stale=f.service.create(f.p,f.request);assert.equal(stale.verification.canApprove,false);assert.equal(stale.verification.approvalCurrent,false);
    assert.equal(stale.verification.checks[0].verdict,'passed','historical result is preserved, not presented as current');
    assert.notEqual(stale.verification.checks[0].sourceDigest,stale.verification.sourceDigest);
  }finally{f.store.close();}
});
test('feedback rejects project/task/run/plan/workspace mismatch before evidence access and never trusts body overrides',()=>{
  const f=fixture();try{
    for(const [project,request] of [['project-b',f.request],[f.p,{...f.request,taskId:randomUUID()}],[f.p,{...f.request,question:'ok',state:'approved'}]] as const){assert.throws(()=>f.service.create(project,request));}
    assert.equal(f.reads(),0);
    const other=f.store.createRun(randomUUID(),'x','hidden',f.w,{taskId:f.task.id,planningVersionId:randomUUID(),requirementLabels:['R1']});
    f.store.updateRun(other.id,{execution:'completed'},'test');assert.throws(()=>f.service.create(f.p,{...f.request,runId:other.id}),/FEEDBACK_CONTEXT_MISMATCH/);
    f.store.saveWorkspace({...f.store.workspaces()[0],projectId:'project-b'});assert.throws(()=>f.service.create(f.p,f.request),/FEEDBACK_CONTEXT_MISMATCH/);
    assert.equal(f.reads(),0);
  }finally{f.store.close();}
});
test('historical plan and unavailable/running verification never become a current approval',()=>{
  const f=fixture();try{
    f.studio.mutate(f.p,'plans',f.plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:{...input,text:input.text.replace('Safe changes','New goal')}});
    const old=f.service.create(f.p,f.request);assert.equal(old.planning.current,false);assert.match(old.markdown,/Safe changes/);assert.doesNotMatch(old.markdown,/New goal/);
    const unavailable=new PlanningHandoffService(f.store,()=>{throw new Error('SENSITIVE_FAILURE');},()=>{throw new Error('SENSITIVE_FAILURE');});
    const result=unavailable.create(f.p,f.request);assert.equal(result.verification.available,false);assert.equal(result.verification.approvalCurrent,false);assert.equal(result.changes.available,false);assert.doesNotMatch(result.markdown,/SENSITIVE_FAILURE/);
    const running=f.store.createRun(randomUUID(),'x','hidden',f.w,{taskId:f.task.id,planningVersionId:f.plan.id,requirementLabels:['R1']});
    const before=f.reads();const active=f.service.create(f.p,{...f.request,runId:running.id});assert.equal(active.verification.available,false);assert.equal(f.reads(),before);
    f.view.checks=[{...f.check,runId:randomUUID()}];assert.equal(f.service.create(f.p,f.request).verification.available,false);
    f.view.checks=[f.check];f.view.sourceDigest=null;f.view.sourceIssue='FINGERPRINT_UNAVAILABLE';f.view.canApprove=false;f.view.approvalCurrent=false;
    assert.equal(f.service.create(f.p,f.request).verification.available,false,'a returned sourceIssue is an unavailable read, even without a thrown error');
  }finally{f.store.close();}
});
test('feedback blocks private user content without saving it and bounds untrusted fields',()=>{
  const f=fixture();try{
    const before=f.store.lastSeq();
    for(const question of ['person@example.com','api_key=synthetic_fixture_value','x'.repeat(2001),'bad\u0000question'])assert.throws(()=>f.service.create(f.p,{...f.request,question}));
    assert.equal(f.reads(),0);assert.equal(f.store.lastSeq(),before);
    const bad=new PlanningHandoffService(f.store,()=>f.view,()=>({workspaceId:f.w,baseSha:'b'.repeat(40),files:[{path:'person@example.com.ts',status:'M',patch:null}]}));
    assert.throws(()=>bad.create(f.p,f.request),/PLANNING_EXPORT_BLOCKED/);
  }finally{f.store.close();}
});
