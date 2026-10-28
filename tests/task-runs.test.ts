import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import { Controller } from '../server/controller.ts';
import { Projects } from '../server/projects.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';
import { Studio } from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

class Fake extends EventEmitter {
  calls:{method:string;params:any}[]=[];thread='task-thread';uncertain=false;
  async initialize(){} async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{this.calls.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[]};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:this.thread,status:{type:'idle'}},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
    if(method==='turn/start'){if(this.uncertain)throw new Error('uncertain');return {turn:{id:'task-turn'}};}return {};
  }
}
const input={format:'markdown',source:'manual',text:'# Safe implementation\n## Goal\nPreserve the original repository\n## Requirements\n### REQ-1\nUpdate the isolated source\n#### Acceptance criteria\n- Existing checks continue to pass\n## Constraints\n- Never change the original repository\n## Open questions\n'};
async function executionFixture(protectedSuite=false){
  const dir=mkdtempSync(join(tmpdir(),'orbit-task-run-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe',windowsHide:true});
  git('init','-q','-b','main');writeFileSync(join(root,'source.ts'),'export const original = true;\n');writeFileSync(join(root,'check.mjs'),"console.log('actual protected check');\n");git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial');
  const db=join(dir,'test.sqlite'),store=new Store(db),projects=new Projects(store,join(dir,'managed'),[root]);
  const project=projects.register(root),workspace=projects.create(project.id),rpc=new Fake();
  const controller=new Controller(store,createWorkspace(dir),()=>rpc,projects,protectedSuite?[{projectPath:root,id:'check',label:'Protected check',executable:process.execPath,args:['check.mjs'],timeoutMs:5000,protectedFiles:['check.mjs']}]:[]);
  await controller.selectWorkspace(workspace.id);await controller.connect();
  return {dir,db,store,projects,project,workspace,rpc,controller};
}
async function fixture(protectedSuite=false){
  const {dir,db,store,project,workspace,rpc,controller}=await executionFixture(protectedSuite);
  const server=createHttpServer(controller,'.');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as any;
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const post=(path:string,data:object)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(data)});
  const base='/api/projects/'+project.id;
  async function plan(questions=''){
    const version=await (await post(base+'/plans',{requestId:randomUUID(),input:{...input,text:input.text+questions}})).json() as any;
    await post(`${base}/plans/${version.id}/approve`,{expectedRevision:1});
    const tasks=await (await post(`${base}/plans/${version.id}/task-drafts`,{})).json() as any[];
    return {version,task:tasks[0],path:`${base}/tasks/${tasks[0].id}/run`};
  }
  return {dir,db,store,controller,rpc,project,workspace,origin,headers,post,base,plan,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();}};
}

test('stale_approval_rejected and task Run binds the approved hash before native dispatch',async()=>{
  const f=await executionFixture(),studio=new Studio(f.store);let runId='',hash='',legacyBody='';
  try{
    const plan=studio.mutate(f.project.id,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
    studio.mutate(f.project.id,'plans',plan.id,'approve',{expectedRevision:1});
    const [task]=studio.mutate(f.project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
    const request=f.rpc.request.bind(f.rpc);
    f.rpc.request=async(method,params)=>{
      if(method==='turn/start')assert.equal(f.store.runs().at(-1)?.planningContentHash,plan.contentHash);
      return request(method,params);
    };
    const requestId=randomUUID(),run=await f.controller.submitTask(f.project.id,task.id,{requestId,workspaceId:f.workspace.id});
    runId=run.id;hash=plan.contentHash;assert.equal(run.planningContentHash,hash);
    assert.equal((f.store.eventsAfter(0).find(e=>e.kind==='run.created')!.data.run as typeof run).planningContentHash,hash);
    f.store.updateRun(run.id,{execution:'completed'},'test.completed');
    const next=studio.mutate(f.project.id,'plans',plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input}) as PlanningVersion;
    const stale=()=>f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID(),workspaceId:f.workspace.id});
    await assert.rejects(stale,/PLANNING_VERSION_STALE/);
    studio.mutate(f.project.id,'plans',next.id,'approve',{expectedRevision:2});
    await assert.rejects(stale,/PLANNING_VERSION_STALE/);
    assert.equal((await f.controller.submitTask(f.project.id,task.id,{requestId,workspaceId:f.workspace.id})).id,run.id);
    assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);assert.equal(f.store.runs().length,1);
    const old=f.store.createRun(randomUUID(),'fixture','Old task run',f.workspace.id,{taskId:task.id,planningVersionId:plan.id,requirementLabels:task.requirementLabels});
    f.store.updateRun(old.id,{execution:'completed'},'test.completed');
    legacyBody=JSON.stringify(f.store.getRun(old.id));
  }finally{await f.controller.close();f.store.close();}
  const reopened=new Store(f.db);try{
    assert.equal(reopened.getRun(runId)?.planningContentHash,hash);
    assert.equal(Object.hasOwn(reopened.runs().at(-1)!,'planningContentHash'),false);
    assert.equal(JSON.stringify(reopened.runs().at(-1)),legacyBody);
  }finally{reopened.close();}
});

test('approved task executes its authoritative brief once and preserves the link across uncertain response and restart',async()=>{
  const f=await fixture();try{
    const p=await f.plan(),requestId=randomUUID();f.rpc.uncertain=true;
    const result=await f.post(p.path,{requestId,workspaceId:f.workspace.id});assert.equal(result.status,503);
    const run=f.store.runs()[0];assert.equal(run.taskId,p.task.id);assert.equal(run.planningVersionId,p.version.id);assert.equal(run.verification,'not_run');
    const dispatch=f.rpc.calls.find(c=>c.method==='turn/start')!;assert.match(dispatch.params.input[0].text,/Never change the original repository/);
    assert.equal(run.execution,'lost');
    await f.post(`${f.base}/plans/${p.version.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input});
    const replay=await f.post(p.path,{requestId,workspaceId:f.workspace.id});assert.equal(replay.status,200);assert.equal((await replay.json() as any).id,run.id);
    assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);
    const event=f.store.eventsAfter(0).find(e=>e.kind==='run.created')!;assert.equal((event.data.run as any).taskId,p.task.id);
  }finally{await f.close();}
  const reopened=new Store(f.db);try{assert.ok(reopened.runs()[0].taskId);assert.equal(reopened.runs()[0].execution,'lost');}finally{reopened.close();}
});

test('Task baseline is explicitly previewed, stored before dispatch and rejects stale or missing approval',async()=>{
  const f=await fixture(true);try{
    const p=await f.plan(),url=f.origin+p.path.replace(/run$/,'verification-preview')+'?workspaceId='+f.workspace.id;
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url+'&workspaceId='+f.workspace.id,{headers:f.headers})).status,400);
    const response=await fetch(url,{headers:f.headers});assert.equal(response.status,200);
    const {preview}=await response.json() as any;assert.equal(preview.files[0].path,'check.mjs');assert.equal(f.store.runs().length,0);
    assert.equal((await f.post(p.path,{requestId:randomUUID(),workspaceId:f.workspace.id})).status,409);
    assert.equal((await f.post(p.path,{requestId:randomUUID(),workspaceId:f.workspace.id,expectedAcceptanceDigest:'a'.repeat(64)})).status,409);
    const requestId=randomUUID(),launch={requestId,workspaceId:f.workspace.id,expectedAcceptanceDigest:preview.digest};
    const originalRequest=f.rpc.request.bind(f.rpc);
    f.rpc.request=async(method,params)=>{if(method==='turn/start'){
      const run=f.store.runs()[0];assert.equal(run.acceptanceDigest,preview.digest);
      assert.equal(f.store.db.prepare('SELECT digest FROM run_acceptance_baselines WHERE run_id=?').get(run.id)?.digest,preview.digest);
    }return originalRequest(method,params);};
    assert.equal((await f.post(p.path,launch)).status,200);
    assert.equal((await f.post(p.path,launch)).status,200);
    assert.equal((await f.post(p.path,{...launch,expectedAcceptanceDigest:'b'.repeat(64)})).status,409);
    assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);
  }finally{await f.close();}
});

test('real checks accept implementation changes but reject weakened tests and cannot replace an original baseline',async()=>{
  const f=await fixture(true);try{
    const p=await f.plan(),preview=f.controller.taskVerificationPreview(f.project.id,p.task.id,f.workspace.id)!;
    const run=await f.controller.submitTask(f.project.id,p.task.id,{requestId:randomUUID(),workspaceId:f.workspace.id,expectedAcceptanceDigest:preview.digest});
    f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    writeFileSync(join(f.workspace.path,'source.ts'),'export const original = false;\n');
    const checks=f.controller.verification;
    const start=()=>{const view=checks.view(f.workspace.id,run.id);return checks.start({requestId:randomUUID(),runId:run.id,workspaceId:f.workspace.id,commandId:'check',expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:view.commands[0].configDigest});};
    assert.equal(checks.view(f.workspace.id,run.id).acceptance?.state,'current');
    start();await checks.settle();let view=checks.view(f.workspace.id,run.id);
    assert.equal(view.checks[0].exitCode,0);assert.equal(view.checks[0].acceptanceDigest,preview.digest);assert.equal(view.canApprove,true);
    checks.approve({requestId:randomUUID(),workspaceId:f.workspace.id,runId:run.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!});
    const recorded=view.checks[0];
    for(const acceptanceDigest of [undefined,'c'.repeat(64)]){
      f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify({...recorded,acceptanceDigest}),recorded.id);
      const mismatched=checks.view(f.workspace.id,run.id);assert.equal(mismatched.canApprove,false);assert.equal(mismatched.approvalCurrent,false);
    }
    f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify(recorded),recorded.id);
    assert.equal(checks.view(f.workspace.id,run.id).approvalCurrent,true);
    writeFileSync(join(f.workspace.path,'check.mjs'),"// assertions removed\nprocess.exit(0);\n");
    view=checks.view(f.workspace.id,run.id);assert.equal(view.acceptance?.state,'changed');assert.equal(view.canApprove,false);assert.equal(view.approvalCurrent,false);
    assert.throws(start,/ACCEPTANCE_/);assert.equal(view.checks.length,1);
    const later=f.controller.taskVerificationPreview(f.project.id,p.task.id,f.workspace.id)!;assert.notEqual(later.digest,preview.digest);
    assert.equal(checks.view(f.workspace.id,run.id).acceptance?.baseline?.digest,preview.digest);
  }finally{await f.close();}
});

test('baseline persistence failure rolls back Run intent and makes zero native dispatches',async()=>{
  const f=await fixture(true);try{
    const p=await f.plan(),preview=f.controller.taskVerificationPreview(f.project.id,p.task.id,f.workspace.id)!;
    f.store.db.exec("CREATE TRIGGER deny_baseline BEFORE INSERT ON run_acceptance_baselines BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await assert.rejects(f.controller.submitTask(f.project.id,p.task.id,{requestId:randomUUID(),workspaceId:f.workspace.id,expectedAcceptanceDigest:preview.digest}));
    assert.equal(f.store.runs().length,0);assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,0);
    assert.equal(f.store.eventsAfter(0).some(e=>e.kind==='run.created'),false);
  }finally{await f.close();}
});

test('protected file change after dispatching a Check invalidates actual exit-zero evidence',async()=>{
  const f=await fixture(true);try{
    writeFileSync(join(f.workspace.path,'check.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('check.mjs','// removed checks');console.log('exit zero after rewrite');\n");
    const p=await f.plan(),preview=f.controller.taskVerificationPreview(f.project.id,p.task.id,f.workspace.id)!;
    const run=await f.controller.submitTask(f.project.id,p.task.id,{requestId:randomUUID(),workspaceId:f.workspace.id,expectedAcceptanceDigest:preview.digest});
    f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    const checks=f.controller.verification,view=checks.view(f.workspace.id,run.id);
    checks.start({requestId:randomUUID(),runId:run.id,workspaceId:f.workspace.id,commandId:'check',expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:view.commands[0].configDigest});
    await checks.settle();const after=checks.view(f.workspace.id,run.id);
    assert.equal(after.checks[0].exitCode,0);assert.equal(after.checks[0].verdict,'stale');assert.equal(after.canApprove,false);assert.equal(after.acceptance?.state,'changed');
    f.store.db.prepare('DELETE FROM run_acceptance_baselines WHERE run_id=?').run(run.id);
    assert.equal(checks.view(f.workspace.id,run.id).acceptance?.state,'unavailable');assert.equal(checks.view(f.workspace.id,run.id).canApprove,false);
  }finally{await f.close();}
});

test('task execution rejects unresolved, stale, foreign, injected and wrong-workspace requests before dispatch',async()=>{
  const f=await fixture();try{
    const p=await f.plan('- Which storage policy?\n');
    assert.equal((await f.post(p.path,{requestId:randomUUID(),workspaceId:f.workspace.id})).status,422);
    const ready=await f.plan();
    assert.equal((await f.post(ready.path,{requestId:randomUUID(),workspaceId:f.workspace.id,prompt:'override'})).status,400);
    assert.equal((await f.post(ready.path,{requestId:randomUUID(),workspaceId:null})).status,400);
    assert.equal((await f.post(ready.path,{requestId:randomUUID(),workspaceId:randomUUID()})).status,409);
    assert.equal((await f.post(ready.path.replace(f.project.id,'other-project'),{requestId:randomUUID(),workspaceId:f.workspace.id})).status,409);
    const noCsrf=await fetch(f.origin+ready.path,{method:'POST',headers:{...f.headers,'X-CSRF-Token':''},body:JSON.stringify({requestId:randomUUID(),workspaceId:f.workspace.id})});assert.equal(noCsrf.status,403);
    await f.post(`${f.base}/plans/${ready.version.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input});
    assert.equal((await f.post(ready.path,{requestId:randomUUID(),workspaceId:f.workspace.id})).status,409);
    assert.equal(f.rpc.calls.some(c=>c.method==='turn/start'),false);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('task and free-prompt requests cannot reuse each other idempotency identities',async()=>{
  const f=await fixture();try{
    const p=await f.plan(),requestId=randomUUID();
    const response=await f.post(p.path,{requestId,workspaceId:f.workspace.id});assert.equal(response.status,200);
    const run=await response.json() as any;
    const conflict=await f.post('/api/runs',{requestId,prompt:run.prompt,workspaceId:f.workspace.id});assert.equal(conflict.status,409);
    assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);
  }finally{await f.close();}
});
