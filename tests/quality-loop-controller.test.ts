import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from './temp.ts';
import {Controller} from '../server/controller.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Studio} from '../server/studio.ts';
import {ProjectProgressService} from '../server/project-progress.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import {readVerificationConfiguration} from '../server/verification-service.ts';
import {claudeFixture,outcome,session,tick} from './claude-task-fixture.ts';

test('controller connects independent review, failed-only repair, durable local verification and global execution gates',async()=>{
  const f=claudeFixture();let controller:Controller|undefined;
  try{
    const {task}=f.plan(),source=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    writeFileSync(join(f.project.path,`task-${task.id.slice(0,8)}.md`),'# Report\nNeeds citation.');
    f.runners[0].finish(outcome('completed',{identity:{providerId:'anthropic',modelId:'model-a',sessionId:session.sessionId,executionId:null,modelEvidence:'assistant_message'}}));await tick();
    let reviews=0,failNextReview=true;
    controller=new Controller(f.store,f.dir,()=>{throw Error('NATIVE_FORBIDDEN');},f.projects,[],[],f.dependencies,{},
      {findExecutable:()=>'/fake/claude',claudeFactory:()=>({interrupt:()=> 'requested',async start(_prompt,onEvent){
        const number=++reviews,reviewSession='review-'+number,failed=failNextReview;failNextReview=false;
        onEvent({kind:'session',sessionId:reviewSession,model:'alias',permissionMode:'plan',auth:'subscription',tools:[]});
        return outcome('completed',{identity:{providerId:'anthropic',modelId:'model-b',sessionId:reviewSession,executionId:null,modelEvidence:'assistant_message'},response:JSON.stringify({verdict:failed?'changes_requested':'approve',baseline_respected:true,criteria:[{criterion:'Cite evidence',status:failed?'not_met':'met',evidence:failed?'Missing source citation':'Citation added'}],findings:[]})});
      }})});
    const reviewers=[{id:'reviewer',providerId:'anthropic',modelId:'model-b'}],limits={maxRepairs:1,maxCalls:3,timeoutMs:3000};
    const preview=controller.qualityLoops.preview(f.project.id,source.id,reviewers,limits);
    const input={projectId:f.project.id,sourceRunId:source.id,reviewers,limits,requestId:randomUUID(),expectedPreviewDigest:preview.previewDigest,confirmed:true};
    const loop=controller.qualityLoops.start(input);
    await tick();
    assert.equal(f.runners.length,2);assert.match(f.runners[1].prompt,/Missing source citation/);
    await assert.rejects(controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),/QUALITY_LOOP_BUSY/);
    assert.throws(()=>controller!.addMaterials(f.project.id,{}),/QUALITY_LOOP_BUSY/);
    assert.throws(()=>controller!.startModelRequest({} as never),/QUALITY_LOOP_BUSY/);
    assert.equal(controller.qualityLoops.start(input).id,loop.id);assert.equal(f.runners.length,2);
    writeFileSync(join(f.project.path,`task-${task.id.slice(0,8)}.md`),'# Report\nCitation added.');
    f.runners[1].finish(outcome('completed',{identity:{providerId:'anthropic',modelId:'model-a',sessionId:'repair-session',executionId:null,modelEvidence:'assistant_message'}}));
    const result=await controller.qualityLoops.settled(loop.id);
    assert.equal(result.result.status,'passed');assert.equal(result.result.repairs,1);assert.equal(reviews,2);
    assert.equal(result.verification.status,'passed');assert.ok(result.verification.checkIds.length);
    assert.equal(result.steps.filter(step=>step.kind==='repair').length,1);
    const board=new ProjectProgressService(f.store,f.studio).read(f.project.id,{});
    const visible=board.tasks.find(item=>item.id===task.id)!.qualityLoops![0];
    assert.equal(visible.id,loop.id);assert.deepEqual(visible.steps,result.steps);assert.deepEqual(visible.verification,result.verification);
    assert.equal(f.store.getRun(source.id)?.verification,'not_run','AI opinions do not approve the source run');
    // Crash-window simulation: terminal writer persisted, but its artifact receipt could not be stored.
    failNextReview=true;
    f.store.db.exec("CREATE TRIGGER fail_quality_receipt BEFORE INSERT ON quality_controller_receipts WHEN json_type(NEW.body,'$.value.evidence')='object' BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    const secondPreview=controller.qualityLoops.preview(f.project.id,source.id,reviewers,limits);
    const second=controller.qualityLoops.start({...input,requestId:randomUUID(),expectedPreviewDigest:secondPreview.previewDigest});await tick();
    assert.equal(f.runners.length,3);
    f.runners[2].finish(outcome('completed',{identity:{providerId:'anthropic',modelId:'model-a',sessionId:'repair-session-second',executionId:null,modelEvidence:'assistant_message'}}));
    const uncertain=await controller.qualityLoops.settled(second.id);
    assert.equal(uncertain.result.issue,'QUALITY_ARTIFACT_SNAPSHOT_MISSING');assert.equal(uncertain.recoveryRequired,false);
    f.store.db.exec('DROP TRIGGER fail_quality_receipt');
    // Also recover the durable intent state that an actual process crash would leave.
    uncertain.steps.find(step=>step.kind==='repair')!.state='intent';uncertain.recoveryRequired=true;
    f.store.db.prepare('UPDATE quality_loops SET body=? WHERE id=?').run(JSON.stringify(uncertain),uncertain.id);
    const recovered=await controller.qualityLoops.resume(second.id);
    assert.equal(recovered.result.status,'failed');assert.equal(recovered.result.issue,'QUALITY_ARTIFACT_SNAPSHOT_MISSING');assert.equal(recovered.recoveryRequired,false);assert.equal(f.runners.length,3);
    // Claude writes its durable Run before spawning. A missing executable before that point is a proved no-dispatch failure.
    failNextReview=true;f.dependencies.findExecutable=()=>{throw Error('CLAUDE_NOT_INSTALLED');};
    const thirdPreview=controller.qualityLoops.preview(f.project.id,source.id,reviewers,limits);
    const third=controller.qualityLoops.start({...input,requestId:randomUUID(),expectedPreviewDigest:thirdPreview.previewDigest});
    const notStarted=await controller.qualityLoops.settled(third.id);
    assert.equal(notStarted.result.status,'failed');assert.equal(notStarted.result.issue,'CLAUDE_NOT_INSTALLED');assert.equal(notStarted.recoveryRequired,false);
    const failedRepair=notStarted.steps.find(step=>step.kind==='repair')!;
    assert.equal(failedRepair.state,'failed');assert.equal(f.store.findRequest(failedRepair.id),null);assert.equal(f.runners.length,3);
    assert.doesNotThrow(()=>controller!.qualityLoops.ensureAvailable());
  }finally{for(const runner of f.runners)runner.finish();await controller?.close();await f.close();}
});

test('code project runs approved local checks with frozen acceptance; unknown Codex attribution dispatches no review',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'orbit-quality-code-')),root=join(directory,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(join(root,'check.mjs'),'if (2 + 2 !== 4) process.exit(1);');writeFileSync(join(root,'result.txt'),'The expected result.');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(':memory:'),projects=new Projects(store,join(directory,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id),studio=new Studio(store);
  store.setMeta('selectedWorkspace',workspace.id);
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Check result',goal:'Produce expected result',requirements:[{id:'R1',description:'Result',acceptance_criteria:['Approved test passes']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion,[task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const config=readVerificationConfiguration(JSON.stringify([{projectPath:root,id:'check',label:'Approved check',executable:process.execPath,args:['check.mjs'],timeoutMs:5000,protectedFiles:['check.mjs']}]));
  let reviews=0;
  const controller=new Controller(store,directory,()=>{throw Error('LIVE_CODEX_FORBIDDEN');},projects,config,[],{}, {},{findExecutable:()=>'/fake/claude',claudeFactory:()=>({interrupt:()=> 'requested',async start(_prompt,onEvent){
    reviews++;onEvent({kind:'session',sessionId:'review-session',model:'alias',permissionMode:'plan',auth:'subscription',tools:[]});
    return outcome('completed',{identity:{providerId:'anthropic',modelId:'model-b',sessionId:'review-session',executionId:null,modelEvidence:'assistant_message'},response:JSON.stringify({verdict:'approve',baseline_respected:true,criteria:[{criterion:'Approved test passes',status:'met',evidence:'Expected result and approved check present'}],findings:[]})});
  }})});
  try{
    const acceptance=controller.taskVerificationPreview(project.id,task.id,workspace.id)!;
    const source=store.createRun(randomUUID(),'fixture','produce result',workspace.id,{taskId:task.id,planningVersionId:plan.id,planningContentHash:plan.contentHash,requirementLabels:task.requirementLabels},undefined,acceptance);
    store.updateRun(source.id,{execution:'completed'},'run.completed');
    // The budget covers a real check subprocess plus ~250 synchronous git fingerprint spawns (~6-9s idle, >30s under CPU load).
    const reviewers=[{id:'claude',providerId:'anthropic',modelId:'model-b'}],limits={maxRepairs:0,maxCalls:1,timeoutMs:120000};
    const start=()=>{const preview=controller.qualityLoops.preview(project.id,source.id,reviewers,limits);return controller.qualityLoops.start({projectId:project.id,sourceRunId:source.id,reviewers,limits,requestId:randomUUID(),expectedPreviewDigest:preview.previewDigest,confirmed:true});};
    assert.equal(start().result.issue,'QUALITY_PRODUCER_MODEL_UNKNOWN');assert.equal(reviews,0);assert.equal(controller.verification.view(workspace.id,source.id).checks.length,0);
    // Synthetic native metadata is fixture-only; production Codex attribution remains unknown.
    store.append('run.identity',source.id,{providerId:'openai',modelId:'model-a',sessionId:'source-session',executionId:'source-turn',runId:source.id,modelEvidence:'assistant_message'});
    const record=start(),result=await controller.qualityLoops.settled(record.id);
    assert.equal(result.result.status,'passed');assert.equal(reviews,1);assert.equal(result.verification.status,'passed');
    const view=controller.verification.view(workspace.id,source.id),checks=view.checks.filter(check=>result.verification.checkIds.includes(check.id));
    assert.equal(checks.length,1);assert.equal(checks[0].exitCode,0);assert.equal(checks[0].acceptanceDigest,acceptance.digest);assert.equal(checks[0].sourceDigest,result.artifact.digest);assert.equal(checks[0].finishedDigest,result.artifact.digest);assert.equal(view.approval,null);
    writeFileSync(join(workspace.path,'check.mjs'),'process.exit(0); // weakened');
    assert.equal(controller.verification.acceptance.status(workspace.id,source.id).state,'changed');
  }finally{await controller.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
