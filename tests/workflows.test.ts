import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from './temp.ts';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import type {Projects} from '../server/projects.ts';
import {WorkflowService} from '../server/workflow-service.ts';

function fixture(codes=["require('node:fs').appendFileSync('order.log','a')","require('node:fs').appendFileSync('order.log','b')"]){
  const dir=mkdtempSync(join(tmpdir(),'orbit-workflows-')),store=new Store(':memory:'),p=randomUUID(),w=randomUUID();let source='a'.repeat(64),busy=false;
  store.saveProject({id:p,name:'Workflow fixture',path:dir,createdAt:'',writeEnabled:true});
  store.saveWorkspace({id:w,projectId:p,path:dir,branch:'orbit/workflow',baseSha:'b'.repeat(40),createdAt:'',status:'ready'});
  const projects={writable:(id:string)=>{assert.equal(id,w);return store.workspaces()[0];},fingerprint:()=>source} as unknown as Projects;
  const configuration=codes.map((code,i)=>({projectPath:dir,id:'check'+i,label:'Check '+i,executable:process.execPath,args:['-e',code],timeoutMs:2000}));
  const service=new WorkflowService(store,projects,configuration,()=>busy);
  const save=()=>({requestId:randomUUID(),workflowId:null,expectedRevision:null,name:'Local checks',steps:[{id:'second',commandId:'check1',dependsOn:['first']},{id:'first',commandId:'check0',dependsOn:[]}]});
  const input=(workflowId:string,retryOfId:string|null=null)=>{const preview=service.preview(w,workflowId);return {requestId:randomUUID(),workspaceId:w,workflowId,expectedVersionId:preview.versionId,expectedPreviewDigest:preview.previewDigest,confirmed:true,retryOfId};};
  return {store,service,projects,configuration,dir,p,w,save,input,setSource:(s:string)=>{source=s;},setBusy:(b:boolean)=>{busy=b;}};
}
test('immutable templates execute actual registered Node commands in dependency order and replay runs nothing twice',async()=>{
  const f=fixture();try{
    const save=f.save(),v1=f.service.save(f.p,save);assert.equal(f.service.save(f.p,save).id,v1.id);
    const v2=f.service.save(f.p,{...save,requestId:randomUUID(),workflowId:v1.workflowId,expectedRevision:1,name:'Updated checks'});
    assert.equal(v2.revision,2);assert.equal(f.service.view(f.p,f.w).versions.length,2);
    assert.throws(()=>f.service.save(f.p,{...save,requestId:randomUUID(),workflowId:v1.workflowId,expectedRevision:1}),/WORKFLOW_VERSION_CONFLICT/);
    const input=f.input(v1.workflowId),preview=f.service.preview(f.w,v1.workflowId);assert.deepEqual(preview.steps.map(s=>s.id),['first','second']);
    assert.throws(()=>f.service.start({...input,confirmed:false}),/WORKFLOW_CONFIRMATION_REQUIRED/);
    const run=f.service.start(input);assert.equal(run.status,'running');assert.equal(f.service.start(input).id,run.id);await f.service.settle();
    assert.equal(f.service.record(run.id).status,'passed');assert.equal(readFileSync(join(f.dir,'order.log'),'utf8'),'ab');
    assert.equal(f.service.start(input).status,'passed');assert.equal(readFileSync(join(f.dir,'order.log'),'utf8'),'ab');
    assert.equal(f.store.runs().length,0,'local workflows do not fabricate AI Runs or user review approvals');
    assert.doesNotMatch(JSON.stringify(f.store.eventsAfter(0).filter(e=>e.kind.startsWith('workflow.'))),/appendFileSync|order\.log|Local checks|orbit-workflows-/);
  }finally{await f.service.close();f.store.close();}
});
test('stale source, version, config, browser overrides and busy state fail before executing',async()=>{
  const f=fixture();try{
    const v=f.service.save(f.p,f.save()),input=f.input(v.workflowId);
    f.setSource('c'.repeat(64));assert.throws(()=>f.service.start(input),/WORKFLOW_PREVIEW_STALE/);f.setSource('a'.repeat(64));
    f.setBusy(true);assert.throws(()=>f.service.start(input),/WORKFLOW_BUSY/);f.setBusy(false);
    assert.throws(()=>f.service.start({...input,cwd:f.dir} as any),/INVALID_FIELDS/);
    assert.throws(()=>f.service.save(f.p,{...f.save(),steps:[{id:'one',commandId:'not-registered',dependsOn:[]}]}),/WORKFLOW_COMMAND_UNAVAILABLE/);
    const changed=new WorkflowService(f.store,f.projects,f.configuration.map(c=>({...c,timeoutMs:1999})),()=>false);
    assert.throws(()=>changed.start(input),/WORKFLOW_PREVIEW_STALE/);
    f.service.save(f.p,{...f.save(),workflowId:v.workflowId,expectedRevision:1});assert.throws(()=>f.service.start(input),/WORKFLOW_PREVIEW_STALE/);
    assert.equal(existsSync(join(f.dir,'order.log')),false);assert.equal(f.service.view(f.p,f.w).runs.length,0);
  }finally{await f.service.close();f.store.close();}
});
test('first failure prevents dependent execution and explicit identical-context retries stop at three attempts',async()=>{
  const f=fixture(["process.stdout.write('bounded diagnostic');process.exit(7)","require('node:fs').writeFileSync('should-not-exist','bad')"]);try{
    const version=f.service.save(f.p,f.save());let prior:string|null=null,first:string|null=null;
    for(let attempt=1;attempt<=3;attempt++){
      const run=f.service.start(f.input(version.workflowId,prior));await f.service.settle();const result=f.service.record(run.id);
      assert.equal(result.status,'failed');assert.equal(result.attempt,attempt);assert.equal(result.steps[0].exitCode,7);assert.equal(result.steps[1].status,'skipped');prior=run.id;if(attempt===1)first=run.id;
    }
    assert.throws(()=>f.service.start(f.input(version.workflowId,first)),/WORKFLOW_RETRY_SUPERSEDED/);
    assert.throws(()=>f.service.start(f.input(version.workflowId,prior)),/WORKFLOW_RETRY_LIMIT/);assert.equal(existsSync(join(f.dir,'should-not-exist')),false);
    f.setSource('d'.repeat(64));assert.throws(()=>f.service.start(f.input(version.workflowId,prior)),/WORKFLOW_RETRY_CONTEXT|WORKFLOW_RETRY_LIMIT/);
  }finally{await f.service.close();f.store.close();}
});
test('interrupt does not start later commands and restart quarantines lost work without replay',async()=>{
  const f=fixture(["setTimeout(()=>{},30000)","process.exit(0)"]);let recovery:WorkflowService|undefined;try{
    const v=f.service.save(f.p,f.save()),run=f.service.start(f.input(v.workflowId));f.service.interrupt(f.w,run.id);await f.service.settle();
    const stopped=f.service.record(run.id);assert.equal(stopped.status,'interrupted');assert.ok(stopped.steps.every(s=>s.status!=='passed'));
    f.store.db.prepare('UPDATE workflow_runs SET body=? WHERE id=?').run(JSON.stringify({...stopped,status:'running',finishedAt:null,steps:stopped.steps.map((s,i)=>({...s,status:i?'pending':'running'}))}),run.id);
    const recovered=recovery=new WorkflowService(f.store,f.projects,f.configuration,()=>false);
    assert.equal(recovered.record(run.id).status,'lost');assert.equal(recovered.active,false);assert.equal(recovered.view(f.p,f.w).recoveryRequired,true);
    assert.throws(()=>recovered.ensureAvailable(f.w),/WORKFLOW_RECOVERY_REQUIRED/);
    assert.throws(()=>recovered.recover({runId:run.id,confirmedStopped:false}),/WORKFLOW_CONFIRMATION_REQUIRED/);
    recovered.recover({runId:run.id,confirmedStopped:true});assert.equal(recovered.view(f.p,f.w).recoveryRequired,false);assert.equal(recovered.record(run.id).status,'lost');
    assert.throws(()=>recovered.start(f.input(v.workflowId,run.id)),/WORKFLOW_RETRY_CONTEXT/,'process-stop attestation does not prove the lost command failed');
    assert.equal(existsSync(join(f.dir,'order.log')),false);
  }finally{await recovery?.close();await f.service.close();f.store.close();}
});
test('a real running process is interrupted and changed source makes later steps ineligible',async()=>{
  for(const scenario of ['interrupt','source'] as const){
    const f=fixture(["require('node:fs').writeFileSync('started.flag','yes');setTimeout(()=>{},"+(scenario==='interrupt'?30000:200)+")","require('node:fs').writeFileSync('later.flag','bad')"]);
    try{
      const v=f.service.save(f.p,f.save()),run=f.service.start(f.input(v.workflowId));
      const deadline=Date.now()+1500;while(!existsSync(join(f.dir,'started.flag'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
      assert.equal(existsSync(join(f.dir,'started.flag')),true,'actual child must have started');
      if(scenario==='interrupt')f.service.interrupt(f.w,run.id);else f.setSource('c'.repeat(64));
      await f.service.settle();const result=f.service.record(run.id);assert.equal(result.status,scenario==='interrupt'?'interrupted':'stale');
      assert.equal(result.steps[1].status,'skipped');assert.equal(existsSync(join(f.dir,'later.flag')),false);
    }finally{await f.service.close();f.store.close();}
  }
});
test('workflow diagnostics are explicitly bounded and storage limits fail before another execution',async()=>{
  const f=fixture(["process.stdout.write('public-output '.repeat(1000))","process.exit(0)"]);try{
    const v=f.service.save(f.p,f.save()),run=f.service.start(f.input(v.workflowId));await f.service.settle();const result=f.service.record(run.id);
    assert.equal(result.status,'passed');assert.equal(result.steps[0].output.length,8000);assert.equal(result.steps[0].truncated,true);
    for(let i=0;i<99;i++){const copy={...result,id:randomUUID()};f.store.db.prepare('INSERT INTO workflow_runs VALUES(?,?,?)').run(copy.id,f.p,JSON.stringify(copy));}
    assert.throws(()=>f.service.start(f.input(v.workflowId)),/WORKFLOW_QUOTA/);assert.equal(f.service.active,false);
  }finally{await f.service.close();f.store.close();}
});
