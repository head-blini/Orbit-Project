import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {Studio} from '../server/studio.ts';
import {createWorkspace} from '../server/workspace.ts';
import {TaskGraphService} from '../server/task-graph.ts';
import {readVerificationConfiguration} from '../server/verification-service.ts';
import {defaultCompletionPolicy} from '../server/project-progress.ts';
import {CODE_GATES,type CompletionPolicy} from '../shared/task-completion.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import {planningInput} from './claude-task-fixture.ts';

/** Single Codex Run (no worker batch) through the real verification + approval services; no model calls. */
async function fixture(policy:CompletionPolicy|undefined){
 const dir=mkdtempSync(join(tmpdir(),'orbit-single-run-')),root=join(dir,'project');mkdirSync(root);
 const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe',windowsHide:true});
 git('init','-q','-b','main');writeFileSync(join(root,'check.mjs'),'process.exit(0)');writeFileSync(join(root,'source.txt'),'before');
 git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
 const store=new Store(join(dir,'test.sqlite')),projects=new Projects(store,join(dir,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id),studio=new Studio(store);
 const config=readVerificationConfiguration(JSON.stringify([{projectPath:root,id:'test',label:'Fixture test',executable:process.execPath,args:['check.mjs'],timeoutMs:5000,protectedFiles:['check.mjs']}]));
 const controller=new Controller(store,createWorkspace(dir),()=>{throw new Error('AI_DISABLED_IN_FIXTURE');},projects,config,[],{},{},{},policy?{completion:{policy:()=>policy}}:{});
 await controller.selectWorkspace(workspace.id);
 const version=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:planningInput}) as PlanningVersion;
 studio.mutate(project.id,'plans',version.id,'approve',{expectedRevision:1});
 const [task]=studio.mutate(project.id,'plans',version.id,'task-drafts',{}) as SavedTask[];
 new TaskGraphService(store).save(project.id,{planningVersionId:version.id,contentHash:version.contentHash,expectedRevision:0,nodes:[{taskId:task.id}],edges:[]});
 const acceptance=controller.taskVerificationPreview(project.id,task.id,workspace.id)!;
 const run=store.createRun(randomUUID(),'fixture','single run',workspace.id,{taskId:task.id,planningVersionId:version.id,planningContentHash:version.contentHash},undefined,acceptance);
 store.updateRun(run.id,{execution:'completed',turnId:'turn'},'run.completed');
 // Persisted native observations are fixtures, never live provider evidence.
 store.append('run.runtime_source',run.id,{source:'native',interface:'codex.app_server'});
 store.append('run.identity',run.id,{providerId:'fixture',modelId:'producer',sessionId:'session',modelEvidence:'assistant_message'});
 const read=()=>controller.progress.read(project.id,{}).tasks.find(t=>t.id===task.id)!.completion!;
 const verifyAndApprove=async()=>{
  let view=controller.verification.view(workspace.id,run.id);
  controller.startVerification({requestId:randomUUID(),runId:run.id,workspaceId:workspace.id,commandId:'test',expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:view.commands[0].configDigest});
  await controller.verification.settle();view=controller.verification.view(workspace.id,run.id);assert.equal(view.canApprove,true);
  return controller.approveVerification({requestId:randomUUID(),runId:run.id,workspaceId:workspace.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!});
 };
 return {store,workspace,run,controller,read,verifyAndApprove,close:async()=>{await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const gated=():CompletionPolicy=>({...defaultCompletionPolicy('code'),dependencyRelease:'quality_passed_and_user_approval',gateCommandMap:Object.fromEntries(CODE_GATES.map(g=>[g,['test']]))});

test('single Run with configured gate commands reaches verifiedDone after verification and user approval; changed source stales it',async()=>{
 const f=await fixture(gated());try{
  assert.equal(f.controller.verification.view(f.workspace.id,f.run.id).approval,null);
  const approval=await f.verifyAndApprove();
  let completion=f.read();
  assert.deepEqual(approval.completionBinding,completion.binding,'approval binding is the server read-model binding');
  assert.equal(completion.userApproval.status,'passed',completion.userApproval.blockers.join());
  assert.equal(completion.qualityPassed,true,completion.reasonCodes.join());assert.equal(completion.verifiedDone,true);
  writeFileSync(join(f.workspace.path,'source.txt'),'after');
  completion=f.read();
  assert.equal(completion.verifiedDone,false);assert.equal(completion.userApproval.status,'blocked');assert.equal(completion.userApproval.freshness,'stale');
  assert.ok(completion.userApproval.blockers.includes('CQG_BINDING_CHANGED:artifactDigest'));
  assert.ok(!completion.reasonCodes.some(r=>r.startsWith('CQG_BINDING_MISSING')),completion.reasonCodes.join());
 }finally{await f.close();}
});

test('single Run without gate commands stays blocked only by CQG_GATE_COMMAND_MISSING, never by missing bindings',async()=>{
 for(const policy of [{...defaultCompletionPolicy('code'),dependencyRelease:'wait' as const},undefined]){
  const f=await fixture(policy);try{
   await f.verifyAndApprove();
   const completion=f.read();
   assert.equal(completion.userApproval.status,'passed',completion.userApproval.blockers.join());
   assert.equal(completion.qualityPassed,false);assert.equal(completion.verifiedDone,false);
   assert.deepEqual(completion.reasonCodes,['CQG_DEPENDENCY_RELEASE_WAIT','CQG_GATE_COMMAND_MISSING']);
   assert.ok(completion.gates.every(g=>g.blockers.join()==='CQG_GATE_COMMAND_MISSING'));
  }finally{await f.close();}
 }
});

test('legacy approval without captured binding stays unbound; replay never rebinds it',async()=>{
 const f=await fixture(gated());try{
  const approval=await f.verifyAndApprove();
  const {completionBinding:_,...legacy}=approval;
  f.store.db.prepare('UPDATE verification_approvals SET body=? WHERE id=?').run(JSON.stringify(legacy),approval.id);
  const completion=f.read();
  assert.equal(completion.verifiedDone,false);assert.ok(completion.userApproval.blockers.includes('CQG_BINDING_MISSING:policyDigest'));
  const view=f.controller.verification.view(f.workspace.id,f.run.id);
  const replay=f.controller.approveVerification({requestId:approval.requestId,runId:f.run.id,workspaceId:f.workspace.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!});
  assert.equal(replay.completionBinding,undefined);assert.equal(f.read().verifiedDone,false);
 }finally{await f.close();}
});
