import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.ts';
import { VerificationService,readVerificationConfiguration } from '../server/verification-service.ts';
import type { Projects } from '../server/projects.ts';

function fixture(script="console.log('checked')",persist?:string){
  const directory=mkdtempSync(join(tmpdir(),'orbit-checks-')),store=new Store(persist??':memory:');
  const file=join(directory,'check.mjs');writeFileSync(file,script);
  const workspace={id:'workspace-1',projectId:'project-1',path:directory,baseSha:'a'.repeat(40),branch:'orbit/fixture',createdAt:'',status:'ready' as const};
  let source='b'.repeat(64),busy=false;
  const projects={writable:()=>workspace,list:()=>[{id:'project-1',path:directory}],fingerprint:()=>source} as unknown as Projects;
  const config=readVerificationConfiguration(JSON.stringify([{projectPath:directory,id:'check',label:'Fixture check',executable:process.execPath,args:[file],timeoutMs:5000}]));
  const service=new VerificationService(store,projects,config,()=>busy);
  const run=store.createRun('fixture-run',createHash('sha256').update('prompt').digest('hex'),'prompt',workspace.id);
  store.updateRun(run.id,{execution:'completed'},'run.completed');
  const input=()=>({requestId:'fixture-check',runId:run.id,workspaceId:workspace.id,commandId:'check',expectedSourceDigest:source,expectedConfigDigest:service.view(workspace.id,run.id).commands[0].configDigest});
  return {directory,store,service,run,workspace,input,projects,config,file,setSource:(value:string)=>{source=value;},setBusy:(value:boolean)=>{busy=value;}};
}
async function settled(service:VerificationService){await service.settle();}

test('verification is explicit, records real exit evidence and approval becomes stale after source changes',async()=>{
  const f=fixture();try{
    assert.equal(f.service.view(f.workspace.id,f.run.id).checks.length,0);
    const check=f.service.start(f.input());assert.equal(check.execution,'running');
    assert.equal(f.service.start(f.input()).id,check.id);
    await settled(f.service);
    let view=f.service.view(f.workspace.id,f.run.id);
    assert.equal(view.checks[0].verdict,'passed');assert.equal(view.checks[0].exitCode,0);assert.equal(view.canApprove,true);
    assert.equal(f.store.getRun(f.run.id)?.verification,'recorded','execution record points to checks without pretending they passed');
    f.service.approve({requestId:'approval-1',workspaceId:f.workspace.id,runId:f.run.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!});
    assert.equal(f.service.view(f.workspace.id,f.run.id).approvalCurrent,true);
    f.setSource('c'.repeat(64));view=f.service.view(f.workspace.id,f.run.id);
    assert.equal(view.canApprove,false);assert.equal(view.approvalCurrent,false);
  }finally{await f.service.close();f.store.close();}
});

test('configuration and stale approval gates reject browser overrides, secrets, missing commands and concurrent execution',async()=>{
  assert.deepEqual(readVerificationConfiguration(undefined),[]);
  assert.throws(()=>readVerificationConfiguration('[{"id":"bad"}]'),/INVALID_VERIFICATION_CONFIGURATION/);
  const f=fixture();try{
    const input=f.input();f.setSource('c'.repeat(64));assert.throws(()=>f.service.start(input),/VERIFICATION_PREVIEW_STALE/);
    f.setBusy(true);assert.throws(()=>f.service.start(f.input()),/RUN_ACTIVE/);f.setBusy(false);
    assert.throws(()=>f.service.start({...f.input(),commandId:'missing'}),/VERIFICATION_COMMAND_NOT_FOUND/);
    assert.throws(()=>f.service.start({...f.input(),cwd:f.directory} as any),/INVALID_FIELDS/);
    assert.equal(f.service.view(f.workspace.id,f.run.id).checks.length,0);
  }finally{await f.service.close();f.store.close();}
});

test('split credential options and authorization headers never enter configuration or command preview',()=>{
  const directory=mkdtempSync(join(tmpdir(),'orbit-check-secret-'));
  const command={projectPath:directory,id:'check',label:'Fixture',executable:process.execPath,timeoutMs:1000};
  for(const args of [
    ['--api-key','SYNTHETIC_PRIVATE_ARG'],['--token','SYNTHETIC_PRIVATE_ARG'],['--password','SYNTHETIC_PRIVATE_ARG'],
    ['--client_secret','SYNTHETIC_PRIVATE_ARG'],['--aws-secret-access-key','SYNTHETIC_PRIVATE_ARG'],
    ['--header','Authorization:','SYNTHETIC_PRIVATE_ARG'],['--cookie','SYNTHETIC_PRIVATE_ARG'],
    ['--api-key=SYNTHETIC_PRIVATE_ARG'],['access_token','SYNTHETIC_PRIVATE_ARG'],
  ])assert.throws(()=>readVerificationConfiguration(JSON.stringify([{...command,args}])),/^Error: INVALID_VERIFICATION_CONFIGURATION$/);
});

test('failed and interrupted evidence cannot approve a run',async()=>{
  const f=fixture("process.exit(7)");try{
    f.service.start(f.input());await settled(f.service);
    const view=f.service.view(f.workspace.id,f.run.id);
    assert.equal(view.checks[0].exitCode,7);assert.equal(view.checks[0].verdict,'failed');assert.equal(view.canApprove,false);
    assert.throws(()=>f.service.approve({requestId:'approval-1',workspaceId:f.workspace.id,runId:f.run.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:'e'.repeat(64)}),/VERIFICATION_REQUIRED/);
  }finally{await f.service.close();f.store.close();}
  const g=fixture("setTimeout(()=>{},30000)");try{
    const check=g.service.start(g.input());g.service.interrupt(g.workspace.id,check.id);await settled(g.service);
    assert.equal(g.service.view(g.workspace.id,g.run.id).checks[0].verdict,'interrupted');
    assert.equal(g.service.view(g.workspace.id,g.run.id).canApprove,false);
  }finally{await g.service.close();g.store.close();}
});

test('a source change between the approval click and process launch never starts the command',async()=>{
  const f=fixture("import{writeFileSync}from'node:fs';writeFileSync('spawned.txt','unexpected')");try{
    f.service.start(f.input());f.setSource('c'.repeat(64));await settled(f.service);
    const check=f.service.view(f.workspace.id,f.run.id).checks[0];
    assert.equal(check.verdict,'stale');assert.equal(check.exitCode,null);assert.equal(existsSync(join(f.directory,'spawned.txt')),false);
  }finally{await f.service.close();f.store.close();}
});

test('the latest failed retry and changed command configuration invalidate older passing evidence',async()=>{
  const f=fixture();try{
    const original=f.input();f.service.start(original);await settled(f.service);
    assert.equal(f.service.view(f.workspace.id,f.run.id).canApprove,true);
    const changed=new VerificationService(f.store,f.projects,[{...f.config[0],timeoutMs:4000}]);
    assert.equal(changed.view(f.workspace.id,f.run.id).canApprove,false);await changed.close();
    writeFileSync(f.file,'process.exit(9)');
    f.service.start({...f.input(),requestId:'retry-2'});await settled(f.service);
    const view=f.service.view(f.workspace.id,f.run.id);assert.equal(view.checks.length,2);assert.equal(view.canApprove,false);
    assert.equal(f.service.start(original).id,view.checks[1].id);
    assert.throws(()=>f.service.start({...original,expectedSourceDigest:'d'.repeat(64)}),/IDEMPOTENCY_CONFLICT/);
  }finally{await f.service.close();f.store.close();}
});

test('restart marks unfinished checks lost and blocks that workspace until explicit process-stop acknowledgement',async()=>{
  const f=fixture();try{
    const check=f.service.start(f.input());await settled(f.service);
    f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify({...check,execution:'running'}),check.id);
    const restored=new VerificationService(f.store,f.projects,f.config);
    assert.equal(restored.view(f.workspace.id,f.run.id).checks[0].execution,'lost');
    assert.equal(restored.view(f.workspace.id,f.run.id).quarantined,true);
    assert.throws(()=>restored.ensureAvailable(f.workspace.id),/VERIFICATION_RECOVERY_REQUIRED/);
    assert.throws(()=>restored.start({...f.input(),requestId:'after-restart'}),/VERIFICATION_RECOVERY_REQUIRED/);
    restored.acknowledgeStopped(f.workspace.id,check.id);
    assert.equal(restored.view(f.workspace.id,f.run.id).canApprove,false);
    restored.start({...f.input(),requestId:'after-restart'});await restored.settle();
    assert.equal(restored.view(f.workspace.id,f.run.id).canApprove,true);
    await restored.close();
  }finally{await f.service.close();f.store.close();}
});
