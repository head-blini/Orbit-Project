import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {HandoffService} from '../server/handoff-service.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

const handoffInput={format:'markdown',source:'manual',text:'# Report\n## Goal\nPrepare a local report\n## Requirements\n### R1\nSummarize evidence\n#### Acceptance criteria\n- Sources are listed\n## Constraints\n- Stay offline\n## Non-goals\n- No paid services\n## Decisions\n### Storage\n#### Decision\nUse local artifacts\n#### Rationale\nPreserve reviewable evidence\n## Open questions\n'};
function handoffFixture(kind:'general'|'code'='general'){
  const store=new Store(':memory:'),studio=new Studio(store),projectId='project-a';
  for(const id of [projectId,'project-b'])store.saveProject({id,name:id,kind,path:'/private/project-path',createdAt:'',writeEnabled:false});
  const plan=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input:handoffInput}) as PlanningVersion;
  studio.mutate(projectId,'plans',plan.id,'approve',{expectedRevision:1});
  const [task]=studio.mutate(projectId,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const service=new HandoffService(store,studio);
  return {store,studio,projectId,plan,task,service};
}

test('decision_reason_survives_handoff: general and code projects retain decisions and superseded baselines',()=>{
  for(const kind of ['general','code'] as const){
    const f=handoffFixture(kind);try{
      const before=f.store.lastSeq(),result=f.service.build(f.projectId,f.task.id);
      assert.deepEqual(result.baseline,{planningVersionId:f.plan.id,revision:1,contentHash:f.plan.contentHash,current:true});
      assert.equal(result.sourceRunId,null);assert.deepEqual(result.verification,{execution:null,checks:[]});
      assert.deepEqual(result.allowedTools,[]);assert.deepEqual(result.nonGoals,['No paid services']);
      assert.deepEqual(result.decisions,[{decision:'Use local artifacts',rationale:'Preserve reviewable evidence'}]);
      assert.deepEqual(result.requirements,[{label:'R1',acceptanceCriteria:['Sources are listed']}]);
      assert.match(result.markdown,/Preserve reviewable evidence/);assert.match(result.markdown,/No paid services/);
      assert.equal(f.store.lastSeq(),before);assert.equal(f.store.runs().length,0);assert.equal(f.store.workspaces().length,0);
      const next=f.studio.mutate(f.projectId,'plans',f.plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:{...handoffInput,text:handoffInput.text.replace('local report','revised report')}}) as PlanningVersion;
      f.studio.mutate(f.projectId,'plans',next.id,'approve',{expectedRevision:2});
      const stale=f.service.build(f.projectId,f.task.id);assert.equal(stale.baseline.current,false);
      assert.equal(stale.baseline.contentHash,result.baseline.contentHash);assert.equal(stale.goal,result.goal);
      assert.match(stale.nextAction,/기준/);
    }finally{f.store.close();}
  }
});

test('handoff projects only the latest task run checks and project artifact references',()=>{
  const f=handoffFixture();try{
    const old=f.store.createRun(randomUUID(),'digest','RAW_PROMPT',undefined,{taskId:f.task.id,planningVersionId:f.plan.id});
    f.store.updateRun(old.id,{execution:'completed',response:'RAW_RESPONSE'},'test.completed');
    assert.equal(f.service.build(f.projectId,f.task.id).sourceRunId,old.id,'legacy run remains readable without a backfilled hash');
    const latest=f.store.createRun(randomUUID(),'digest','RAW_PROMPT',undefined,{taskId:f.task.id,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash});
    f.store.db.exec('CREATE TABLE verification_checks(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)');
    for(const [runId,projectId,verdict] of [[old.id,f.projectId,'passed'],[latest.id,'project-b','passed'],[latest.id,f.projectId,'failed']]){
      f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(randomUUID(),randomUUID(),JSON.stringify({runId,projectId,execution:'completed',verdict,output:'RAW_TOOL_OUTPUT',commandId:'/outside/command'}));
    }
    const artifact=f.studio.mutate(f.projectId,'artifacts',undefined,undefined,{requestId:randomUUID(),input:{kind:'mermaid',source:'flowchart TD\na["Input"]\nb["Report"]\na --> b',metadata:{title:'Report figure'}}}) as {id:string};
    f.studio.mutate('project-b','artifacts',undefined,undefined,{requestId:randomUUID(),input:{kind:'mermaid',source:'flowchart TD\na["Other"]',metadata:{title:'FOREIGN_ARTIFACT'}}});
    const before=f.store.lastSeq(),result=f.service.build(f.projectId,f.task.id);
    assert.equal(result.sourceRunId,latest.id);assert.equal(result.verification.execution,'starting');
    assert.deepEqual(result.verification.checks,[{execution:'completed',verdict:'failed'}]);
    assert.deepEqual(result.artifacts,[{id:artifact.id,title:'Report figure'}]);
    assert.doesNotMatch(JSON.stringify(result),/RAW_|FOREIGN_|outside|private\/project|flowchart|commandId/);
    assert.equal(f.store.lastSeq(),before);
  }finally{f.store.close();}
});

test('handoff sanitizes selected text, rejects broken bindings, and never exposes arbitrary paths',()=>{
  const f=handoffFixture();try{
    const text=handoffInput.text.replace('Prepare a local report','Keep api_key=synthetic-secret out of /outside/private-file and C:\\outside\\private-file and ../private-file')
      .replace('No paid services','No access to ~/private-file').replace('Preserve reviewable evidence','Avoid Bearer synthetic-rationale-secret');
    const next=f.studio.mutate(f.projectId,'plans',f.plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:{...handoffInput,text}}) as PlanningVersion;
    f.studio.mutate(f.projectId,'plans',next.id,'approve',{expectedRevision:2});
    const [task]=f.studio.mutate(f.projectId,'plans',next.id,'task-drafts',{}) as SavedTask[];
    f.studio.mutate(f.projectId,'artifacts',undefined,undefined,{requestId:randomUUID(),input:{kind:'mermaid',source:'flowchart TD\na["Report"]',metadata:{title:'api_key=synthetic-title-secret /outside/private-file'}}});
    const result=f.service.build(f.projectId,task.id);
    assert.doesNotMatch(JSON.stringify(result),/synthetic-.*secret|outside|private-file/);assert.match(result.goal,/REDACTED/);
    assert.throws(()=>f.service.build('missing-project',task.id),/PROJECT_NOT_FOUND/);
    assert.throws(()=>f.service.build('project-b',task.id),/TASK_NOT_FOUND/);
    assert.throws(()=>f.service.build(f.projectId,randomUUID()),/TASK_NOT_FOUND/);
    f.store.createRun(randomUUID(),'digest','RAW',undefined,{taskId:task.id,planningVersionId:next.id,planningContentHash:'0'.repeat(64)});
    assert.throws(()=>f.service.build(f.projectId,task.id),/HANDOFF_CONTEXT_MISMATCH/);
  }finally{f.store.close();}
});
