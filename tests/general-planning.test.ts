import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {renameSync,symlinkSync,unlinkSync} from 'node:fs';
import type {PlanningVersion} from '../shared/parallel.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {generalPlanningFixture} from './general-planning-fixture.ts';
import {outcome,planningInput,tick} from './claude-task-fixture.ts';

test('general preview/start/completed/save creates only a new draft and preserves the approved version',async()=>{
  const f=generalPlanningFixture();try{
    const first=f.studio.mutate(f.project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:planningInput}) as PlanningVersion;
    const approved=f.studio.mutate(f.project.id,'plans',first.id,'approve',{expectedRevision:1});
    const preview=f.controller.previewPlanning(f.project.id,{text:f.text,workspaceId:null});
    assert.equal(preview.workspaceId,null);assert.equal(preview.runtime,'claude-code');assert.match(preview.instructions,/schema_version/);assert.equal(f.runners.length,0);
    const input={...f.input(),workspaceId:null};assert.throws(()=>f.controller.startPlanning(f.project.id,{...input,confirmed:false}),/PLANNING_CONFIRMATION_REQUIRED/);
    const record=f.controller.startPlanning(f.project.id,input);assert.equal(record.runtime,'claude-code');assert.equal(record.workspaceId,null);
    assert.equal(f.controller.startPlanning(f.project.id,{...input,workspaceId:undefined}).id,record.id);
    await f.complete();const complete=f.service.record(record.id);assert.equal(complete.execution,'completed');assert.equal(f.launches[0].cwd,f.project.path);assert.equal(f.launches[0].mode,'read');
    const analytics=f.controller.projectAnalytics(f.project.id);assert.equal(analytics.records.length,1);assert.equal(analytics.records[0].providerId,'claude-code');assert.equal(analytics.records[0].workspaceId,null);
    assert.equal((f.studio.read(f.project.id,'plans') as PlanningVersion[]).length,1);
    const saved=f.controller.savePlanningDraft(f.project.id,record.id,{expectedOutputDigest:complete.outputDigest!});
    assert.equal(saved.state,'draft');assert.notEqual(saved.id,first.id);assert.equal(saved.draft.provenance?.providerId,'claude-code');
    assert.deepEqual(f.controller.savePlanningDraft(f.project.id,record.id,{workspaceId:null,expectedOutputDigest:complete.outputDigest!}),saved);
    assert.deepEqual((f.studio.read(f.project.id,'plans') as PlanningVersion[]).find(v=>v.id===first.id),approved);
    assert.deepEqual(f.studio.read(f.project.id,'tasks'),[]);assert.deepEqual(f.store.runs(),[]);assert.equal(f.nativeCalls,0);
    assert.doesNotMatch(JSON.stringify(f.store.eventsAfter(0))+JSON.stringify(f.store.db.prepare('SELECT * FROM planning_suggestions').all()),/PRIVATE_PLANNING_MARKER/);
  }finally{await f.close();}
});
test('general invalid output fails without draft; interruption waits for exit and restart loses without retry',async()=>{
  const f=generalPlanningFixture();try{
    const bad=f.controller.startPlanning(f.project.id,f.input());await tick();f.runners[0].finish(outcome('completed',{response:'invalid output'}));await f.service.settle();
    assert.equal(f.service.record(bad.id).execution,'failed');assert.equal(f.service.record(bad.id).issue,'PLANNING_PROPOSAL_INVALID');
    assert.throws(()=>f.controller.savePlanningDraft(f.project.id,bad.id,{expectedOutputDigest:'a'.repeat(64)}),/PLANNING_PROPOSAL_UNAVAILABLE/);
    const input=f.input(),run=f.controller.startPlanning(f.project.id,input);await tick();
    assert.throws(()=>f.controller.previewPlanning(f.project.id,{text:f.text}),/PLANNING_BUSY/);
    f.controller.interruptPlanning(f.project.id,run.id,null);assert.equal(f.runners[1].interrupts,1);assert.equal(f.service.record(run.id).execution,'running');
    f.runners[1].finish(outcome('interrupted'));await f.service.settle();assert.equal(f.service.record(run.id).execution,'interrupted');
    f.store.db.prepare('UPDATE planning_suggestions SET body=? WHERE id=?').run(JSON.stringify({...f.service.record(run.id),execution:'running',processStopped:false}),run.id);
    const store=new Store(f.database),projects=new Projects(store,f.managed,[],f.root),restored=new Controller(store,f.dir,f.factory,projects,[],[],{},f.options);
    try{
      assert.equal(restored.planningSuggestions.record(run.id).execution,'lost');assert.equal(restored.planningSuggestions.view(f.project.id).recoveryRequired,true);
      assert.equal(restored.startPlanning(f.project.id,input).id,run.id);assert.equal(f.runners.length,2);
      assert.throws(()=>restored.previewPlanning(f.project.id,{text:f.text}),/PLANNING_RECOVERY_REQUIRED/);
      restored.recoverPlanning(f.project.id,{suggestionId:run.id,confirmedStopped:true});assert.equal(restored.planningSuggestions.view(f.project.id).recoveryRequired,false);
    }finally{await restored.close();store.close();}
    assert.deepEqual(f.studio.read(f.project.id,'plans'),[]);
  }finally{await f.close();}
});
test('general projects cannot store a Codex planner they cannot run, and rejected preference writes never retarget an active planning run',async()=>{
  const f=generalPlanningFixture();try{
    assert.throws(()=>f.controller.aiPreferences.update(f.project.id,{expectedRevision:0,planning:'codex',execution:'claude-code'}),/GIT_REQUIRED/);
    assert.equal(f.controller.aiPreferences.read(f.project.id).revision,0);
    const preview=f.controller.previewPlanning(f.project.id,{text:f.text});assert.equal(preview.runtime,'claude-code');
    const run=f.controller.startPlanning(f.project.id,f.input());
    assert.throws(()=>f.controller.aiPreferences.update(f.project.id,{expectedRevision:0,planning:'codex',execution:'codex'}),/GIT_REQUIRED/);
    await f.complete();assert.equal(f.service.record(run.id).execution,'completed');assert.equal(f.service.record(run.id).runtime,'claude-code');assert.equal(f.runners.length,1);
  }finally{await f.close();}
});
test('code projects still need a selected validated workspace and can choose Claude planning',async()=>{
  const f=generalPlanningFixture();try{
    const {project,workspace}=f.projects.createProject({requestId:randomUUID(),name:'Code',kind:'code'});
    assert.throws(()=>f.service.preview(project.id,{text:f.text}),/INVALID_FIELDS/);
    assert.throws(()=>f.controller.previewPlanning(project.id,{workspaceId:workspace!.id,text:f.text}),/WORKSPACE_MISMATCH/);
    await f.controller.selectWorkspace(workspace!.id);
    const codexPreview=f.controller.previewPlanning(project.id,{workspaceId:workspace!.id,text:f.text});assert.equal(codexPreview.runtime,'codex');
    f.controller.aiPreferences.update(project.id,{expectedRevision:0,planning:'claude-code',execution:'codex'});
    // Switching the planner invalidates a preview made for the previous runtime.
    assert.throws(()=>f.controller.startPlanning(project.id,{requestId:randomUUID(),workspaceId:workspace!.id,text:f.text,expectedPreviewDigest:codexPreview.previewDigest,confirmed:true}),/PLANNING_PREVIEW_STALE/);
    const preview=f.controller.previewPlanning(project.id,{workspaceId:workspace!.id,text:f.text});assert.equal(preview.runtime,'claude-code');
    const record=f.controller.startPlanning(project.id,{requestId:randomUUID(),workspaceId:workspace!.id,text:f.text,expectedPreviewDigest:preview.previewDigest,confirmed:true});
    await f.complete();assert.equal(f.launches[0].cwd,workspace!.path);assert.equal(f.service.record(record.id).execution,'completed');assert.equal(f.nativeCalls,0);
    assert.equal(f.controller.projectAnalytics(project.id).records[0].providerId,'claude-code');
  }finally{await f.close();}
});
test('general projects reject workspace spoofing and revalidate the server-owned folder before launch',async()=>{
  const f=generalPlanningFixture();try{
    assert.throws(()=>f.controller.previewPlanning(f.project.id,{text:f.text,workspaceId:randomUUID()}),/GIT_REQUIRED/);
    const input=f.input(),run=f.controller.startPlanning(f.project.id,input),moved=f.project.path+'-moved';
    renameSync(f.project.path,moved);symlinkSync(moved,f.project.path);
    try{await f.service.settle();assert.equal(f.runners.length,0);assert.equal(f.service.record(run.id).execution,'failed');}
    finally{unlinkSync(f.project.path);renameSync(moved,f.project.path);}
  }finally{await f.close();}
});

test('active general planning excludes task execution, and an active task excludes planning',async()=>{
  const f=generalPlanningFixture();try{
    const run=f.controller.startPlanning(f.project.id,f.input());await tick();
    await assert.rejects(f.controller.submitTask(f.project.id,randomUUID(),{requestId:randomUUID()}),/PLANNING_BUSY/);
    f.runners[0].finish(outcome('completed',{response:planningInput.text,exit:'not_observed'}));await f.service.settle();
    assert.equal(f.service.record(run.id).execution,'lost');
    await assert.rejects(f.controller.submitTask(f.project.id,randomUUID(),{requestId:randomUUID()}),/PLANNING_RECOVERY_REQUIRED/);
    f.controller.recoverPlanning(f.project.id,{suggestionId:run.id,confirmedStopped:true});
    const task=f.store.createRun(randomUUID(),'test','private',undefined,{runtime:'claude-code',projectId:f.project.id});
    const before=f.store.getRun(task.id);assert.throws(()=>f.controller.aiPreferences.update(f.project.id,{expectedRevision:0,planning:'codex',execution:'claude-code'}),/GIT_REQUIRED/);
    assert.deepEqual(f.store.getRun(task.id),before);
    assert.throws(()=>f.controller.previewPlanning(f.project.id,{text:f.text}),/PLANNING_BUSY/);
    f.store.updateRun(task.id,{execution:'interrupted'},'run.interrupted',{});
  }finally{await f.close();}
});

test('lost Claude task blocks planning in its project without blocking another general project',async()=>{
  const f=generalPlanningFixture();try{
    const task=f.store.createRun(randomUUID(),'test','private',undefined,{runtime:'claude-code',projectId:f.project.id});
    f.store.updateRun(task.id,{execution:'lost'},'run.lost',{});
    assert.throws(()=>f.controller.previewPlanning(f.project.id,{text:f.text}),/PLANNING_BUSY/);
    const {project}=f.projects.createProject({requestId:randomUUID(),name:'Other research',kind:'general'});
    assert.equal(f.controller.previewPlanning(project.id,{text:f.text}).runtime,'claude-code');assert.equal(f.runners.length,0);
  }finally{await f.close();}
});
test('switching the planner keeps the approved baseline, decision rationale, non-goals and goal in execution briefs and handoffs',async()=>{
  const {HandoffService}=await import('../server/handoff-service.ts');
  const f=generalPlanningFixture();try{
    const {project,workspace}=f.projects.createProject({requestId:randomUUID(),name:'Code',kind:'code'});
    await f.controller.selectWorkspace(workspace!.id);
    const first=f.studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:planningInput}) as PlanningVersion;
    const approved=f.studio.mutate(project.id,'plans',first.id,'approve',{expectedRevision:1}) as PlanningVersion;
    const [task]=f.studio.mutate(project.id,'plans',first.id,'task-drafts',{}) as {id:string}[];
    const before={brief:f.studio.execution(project.id,task.id),handoff:new HandoffService(f.store,f.studio).build(project.id,task.id)};
    f.controller.aiPreferences.update(project.id,{expectedRevision:0,planning:'claude-code',execution:'codex'});
    const preview=f.controller.previewPlanning(project.id,{workspaceId:workspace!.id,text:f.text});
    const record=f.controller.startPlanning(project.id,{requestId:randomUUID(),workspaceId:workspace!.id,text:f.text,expectedPreviewDigest:preview.previewDigest,confirmed:true});
    await f.complete();f.controller.savePlanningDraft(project.id,record.id,{workspaceId:workspace!.id,expectedOutputDigest:f.service.record(record.id).outputDigest!});
    assert.deepEqual((f.studio.read(project.id,'plans') as PlanningVersion[]).find(v=>v.id===first.id),approved);
    const after={brief:f.studio.execution(project.id,task.id),handoff:new HandoffService(f.store,f.studio).build(project.id,task.id)};
    assert.deepEqual(after,before,'a new planner draft changes neither the execution brief nor the handoff until approved');
    assert.equal(after.handoff.baseline.contentHash,approved.contentHash);assert.equal(after.handoff.baseline.current,true);
    assert.deepEqual(after.handoff.decisions,[{decision:'Use Markdown',rationale:'Readable locally'}]);
    assert.deepEqual(after.handoff.nonGoals,['Publish externally']);assert.equal(after.handoff.goal,'Compare local evidence');
    for(const text of ['Use Markdown','Readable locally','Publish externally','Compare local evidence'])assert.ok(after.brief.prompt.includes(text),text);
  }finally{await f.close();}
});
