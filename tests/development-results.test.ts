import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Studio} from '../server/studio.ts';
import {VerificationService,readVerificationConfiguration} from '../server/verification-service.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

async function projection(){
  assert.ok(existsSync(new URL('../server/development-results.ts',import.meta.url)),'authoritative Development result projection is missing');
  return (await import('../server/development-results.ts')).getDevelopmentResult;
}
function fixture(configured=true){
  const directory=mkdtempSync(join(tmpdir(),'orbit-development-results-')),root=join(directory,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(join(root,'index.html'),'<h1>Result fixture</h1>');writeFileSync(join(root,'source.txt'),'first source');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const path=join(directory,'state.sqlite'),store=new Store(path),projects=new Projects(store,join(directory,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id),studio=new Studio(store);
  const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Result plan',goal:'Inspect the saved result',requirements:[{id:'R1',description:'Produce a static page',acceptance_criteria:['A local registered check passes']}],constraints:[],open_questions:[]})};
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
  const [task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const run=store.createRun(randomUUID(),'fixture','PRIVATE_PROMPT',workspace.id,{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
  store.updateRun(run.id,{execution:'completed',response:'PRIVATE_RESPONSE'},'run.completed');
  const failPath=join(directory,'fail-check');
  const config=readVerificationConfiguration(JSON.stringify(configured?[{projectPath:root,id:'check',label:'Local fixture check',executable:process.execPath,args:['-e',"console.log('PRIVATE_CHECK_OUTPUT');if(require('node:fs').existsSync(process.argv[1]))process.exit(9)",failPath],timeoutMs:5000}]:[]));
  const verification=new VerificationService(store,projects,config);
  const check=async()=>{const view=verification.view(workspace.id,run.id);const record=verification.start({requestId:randomUUID(),runId:run.id,workspaceId:workspace.id,commandId:'check',expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:view.commands[0].configDigest});await verification.settle();return record;};
  const approve=()=>{const view=verification.view(workspace.id,run.id);verification.approve({requestId:randomUUID(),runId:run.id,workspaceId:workspace.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!});};
  const close=async()=>{await verification.close();store.close();rmSync(directory,{recursive:true,force:true});};
  return {directory,root,path,failPath,store,projects,project,workspace,studio,input,plan,task,run,config,verification,check,approve,close};
}

test('selected Task Run joins approved planning and actual current-source Check without leaking raw records or mutating history',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const seq=f.store.lastSeq(),before=f.store.getRun(f.run.id),view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);
    assert.equal(view.projectId,f.project.id);assert.equal(view.task?.id,f.task.id);assert.equal(view.task?.title,'R1: Produce a static page');assert.equal(view.planning?.id,f.plan.id);assert.equal(view.planning?.current,true);
    assert.equal(view.run?.execution,'completed');assert.equal(view.sourceDigest,f.projects.snapshot(f.workspace.id).sourceDigest);assert.equal(view.sourceIssue,null);
    assert.equal(view.verification?.available,true);assert.equal(view.verification?.canApprove,true);assert.equal(view.verification?.approvalCurrent,true);assert.equal(view.verification?.checks[0].exitCode,0);
    assert.doesNotMatch(JSON.stringify(view),/PRIVATE_|requestId|"output"|"prompt"|"response"|"executable"|"args"/);
    assert.equal(f.store.lastSeq(),seq);assert.deepEqual(f.store.getRun(f.run.id),before);
  }finally{await f.close();}
});
test('changed current source preserves historical passing checks but suppresses current approval',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const old=f.projects.fingerprint(f.workspace.id);writeFileSync(join(f.workspace.path,'source.txt'),'second source');
    const view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);
    assert.notEqual(view.sourceDigest,old);assert.equal(view.verification?.checks[0].verdict,'passed');assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);
  }finally{await f.close();}
});
test('a newer failed Check defeats an older pass for the same unchanged source and configuration',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();writeFileSync(f.failPath,'fail');await f.check();
    const view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);
    assert.equal(view.verification?.checks[0].verdict,'failed');assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);
  }finally{await f.close();}
});
test('no configured commands still fingerprints source and legacy free prompts never invent Task links',async()=>{
  const get=await projection(),f=fixture(false);try{
    const free=f.store.createRun(randomUUID(),'fixture','PRIVATE_LEGACY',f.workspace.id);f.store.updateRun(free.id,{execution:'completed'},'run.completed');
    const view=get(f.store,f.projects,f.verification,f.workspace.id,free.id);
    assert.equal(view.sourceDigest,f.projects.snapshot(f.workspace.id).sourceDigest);assert.equal(view.task,null);assert.equal(view.planning,null);assert.equal(view.linkIssue,null);
    assert.deepEqual(view.verification?.commands,[]);assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);
    assert.equal(get(f.store,f.projects,f.verification,f.workspace.id,null).verification,null);
    const active=f.store.createRun(randomUUID(),'fixture','PRIVATE_ACTIVE',f.workspace.id);
    assert.equal(get(f.store,f.projects,f.verification,f.workspace.id,active.id).verification,null);
  }finally{await f.close();}
});
test('historical Task results survive a superseding planning version without using execution admission',async()=>{
  const get=await projection(),f=fixture();try{
    f.studio.mutate(f.project.id,'plans',f.plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:f.input});
    const view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);
    assert.equal(view.task?.id,f.task.id);assert.equal(view.planning?.id,f.plan.id);assert.equal(view.planning?.current,false);assert.equal(view.linkIssue,null);
    const bad=f.store.createRun(randomUUID(),'fixture','PRIVATE_BAD',f.workspace.id,{taskId:f.task.id,planningVersionId:randomUUID(),requirementLabels:['R1']});f.store.updateRun(bad.id,{execution:'completed'},'run.completed');
    const mismatch=get(f.store,f.projects,f.verification,f.workspace.id,bad.id);assert.equal(mismatch.linkIssue,'TASK_LINK_UNAVAILABLE');assert.equal(mismatch.task,null);assert.equal(mismatch.planning,null);
  }finally{await f.close();}
});
test('foreign Run and unregistered workspace cannot be projected as selected-workspace results',async()=>{
  const get=await projection(),f=fixture();try{
    const other=f.projects.create(f.project.id),run=f.store.createRun(randomUUID(),'fixture','PRIVATE_FOREIGN',other.id);
    assert.throws(()=>get(f.store,f.projects,f.verification,f.workspace.id,run.id),/RUN_NOT_FOUND|WORKSPACE_MISMATCH|RESULT_CONTEXT_MISMATCH/);
    assert.throws(()=>get(f.store,f.projects,f.verification,randomUUID(),null),/WORKSPACE_NOT_FOUND|WORKSPACE_NOT_READY/);
    assert.throws(()=>get(f.store,f.projects,f.verification,f.workspace.id,randomUUID()),/RUN_NOT_FOUND/);
  }finally{await f.close();}
});
test('unreadable source reports generic uncertainty without reusing a previously passing approval',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();writeFileSync(join(f.workspace.path,'auth.json'),'PRIVATE_FILE_CONTENT');
    const view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);
    assert.equal(view.sourceDigest,null);assert.ok(view.sourceIssue);assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_|auth\.json/);
  }finally{await f.close();}
});
test('late source changes and unavailable verification never publish a stale current approval',async t=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const original=f.projects.fingerprint.bind(f.projects);let reads=0;
    const mock=t.mock.method(f.projects,'fingerprint',(id:string)=>{if(++reads===3)writeFileSync(join(f.workspace.path,'source.txt'),'late change');return original(id);});
    const changed=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);assert.equal(changed.verification?.canApprove,false);assert.equal(changed.verification?.approvalCurrent,false);mock.mock.restore();
    t.mock.method(f.verification,'view',()=>{throw new Error('PRIVATE_INTERNAL_FAILURE');});
    const unavailable=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);assert.equal(unavailable.verification?.available,false);assert.equal(unavailable.verification?.canApprove,false);assert.equal(unavailable.verification?.approvalCurrent,false);assert.doesNotMatch(JSON.stringify(unavailable),/PRIVATE_/);
  }finally{await f.close();}
});
test('mismatched Check identity or base cannot support approval even when the legacy service accepts its verdict',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const original=f.verification.view(f.workspace.id,f.run.id).checks[0];
    for(const patch of [{baseSha:'a'.repeat(40)},{projectId:randomUUID()}]){
      f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify({...original,...patch}),original.id);
      const view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);
    }
  }finally{await f.close();}
});
test('a changed registered command configuration cannot reuse prior passing evidence for the same files',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const changed=new VerificationService(f.store,f.projects,[{...f.config[0],timeoutMs:4000}]);
    const view=get(f.store,f.projects,changed,f.workspace.id,f.run.id);
    assert.ok(view.sourceDigest);assert.equal(view.verification?.checks[0].verdict,'passed');assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);await changed.close();
  }finally{await f.close();}
});
test('lost Run recovery cannot be presented as current approval despite historical passing checks',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const run=f.store.getRun(f.run.id)!;
    f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...run,execution:'lost'}),run.id);
    const view=get(f.store,f.projects,f.verification,f.workspace.id,run.id);
    assert.equal(view.run?.execution,'lost');assert.equal(view.verification?.checks[0].verdict,'passed');assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);
  }finally{await f.close();}
});
test('a configured latest Check outside the bounded history never becomes an inferred passing result',async()=>{
  const get=await projection(),f=fixture();try{
    await f.check();f.approve();const original=f.verification.view(f.workspace.id,f.run.id).checks[0];
    for(let i=0;i<100;i++){const record={...original,id:randomUUID(),requestId:randomUUID(),commandId:'old-command-'+i};f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(record.id,record.requestId,JSON.stringify(record));}
    assert.equal(f.verification.view(f.workspace.id,f.run.id).canApprove,true);
    const view=get(f.store,f.projects,f.verification,f.workspace.id,f.run.id);assert.equal(view.verification?.checks.length,100);assert.equal(view.verification?.canApprove,false);assert.equal(view.verification?.approvalCurrent,false);
  }finally{await f.close();}
});
test('restart restores Task and Check provenance without rewriting records or running another Check',async()=>{
  const get=await projection(),f=fixture();let reopened:Store|undefined;
  try{
    await f.check();f.approve();const seq=f.store.lastSeq();await f.verification.close();f.store.close();reopened=new Store(f.path);
    const projects=new Projects(reopened,join(f.directory,'managed'),[f.root]),verification=new VerificationService(reopened,projects,f.config);
    const view=get(reopened,projects,verification,f.workspace.id,f.run.id);
    assert.equal(view.task?.id,f.task.id);assert.equal(view.verification?.checks.length,1);assert.equal(view.verification?.canApprove,true);assert.equal(view.verification?.approvalCurrent,true);assert.equal(reopened.lastSeq(),seq);await verification.close();
  }finally{if(reopened)reopened.close();else f.store.close();rmSync(f.directory,{recursive:true,force:true});}
});
