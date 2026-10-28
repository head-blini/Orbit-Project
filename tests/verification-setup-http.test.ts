import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {VerificationSetupView} from '../shared/verification-setup.ts';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-setup-http-')),store=new Store(':memory:'),projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const {project,workspace}=projects.createProject({requestId:randomUUID(),name:'Node app'}),readonly=createWorkspace(dir);let nativeCalls=0;
  assert.ok(workspace);
  writeFileSync(join(workspace.path,'model.mjs'),'export const add=(a,b)=>a+b;\n');
  writeFileSync(join(workspace.path,'model.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './model.mjs';test('adds',()=>assert.equal(add(2,3),5));\n");
  const factory=()=>{nativeCalls++;throw new Error('NATIVE_FORBIDDEN');};const controller=new Controller(store,readonly,factory,projects);await controller.selectWorkspace(workspace.id);
  const server=createHttpServer(controller,'unused');await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string};
  const headers={Origin:origin,Cookie:session.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const path='/api/workspaces/'+workspace.id+'/verification-setup';
  const get=()=>fetch(origin+path,{headers});
  return {dir,store,projects,project,workspace,readonly,factory,controller,origin,path,headers,nativeCalls:()=>nativeCalls,get,
    view:async()=>{const r=await get();assert.equal(r.status,200);return await r.json() as VerificationSetupView;},
    post:(data:unknown,url=path,extra:Record<string,string>={})=>fetch(origin+url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)}),
    close:async()=>{await controller.close();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));store.close();rmSync(dir,{recursive:true,force:true});}};
}
const input=(v:VerificationSetupView)=>({requestId:randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:v.candidate!.previewDigest,confirmed:true});

test('a discovered preset configures both consumers and runs real passing and failing Node checks without host environment edits',async()=>{
  const f=await fixture();try{
    const source=f.projects.fingerprint(f.workspace.id),view=await f.view();assert.equal(view.source,'none');assert.deepEqual(view.candidate!.tests,['model.test.mjs']);
    assert.equal((await f.post(input(view))).status,200);assert.equal(f.projects.fingerprint(f.workspace.id),source);assert.equal(f.store.runs().length,0);assert.equal(f.nativeCalls(),0);
    const commands=f.controller.verification.view(f.workspace.id,null).commands;assert.equal(commands.length,1);assert.deepEqual(commands,f.controller.workflows.view(f.project.id,f.workspace.id).commands);assert.deepEqual(commands[0].protectedFiles,['model.test.mjs']);
    const run=f.store.createRun(randomUUID(),'fixture','synthetic completed Run',f.workspace.id);f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    const check=async()=>{const v=f.controller.verification.view(f.workspace.id,run.id);const r=await f.post({requestId:randomUUID(),runId:run.id,commandId:v.commands[0].id,expectedSourceDigest:v.sourceDigest,expectedConfigDigest:v.commands[0].configDigest},'/api/workspaces/'+f.workspace.id+'/checks');assert.equal(r.status,200);await f.controller.verification.settle();return f.controller.verification.view(f.workspace.id,run.id);};
    let result=await check();assert.equal(result.checks[0].exitCode,0);assert.equal(result.checks[0].verdict,'passed');assert.equal(result.acceptance!.state,'unbound');
    writeFileSync(join(f.workspace.path,'model.mjs'),'export const add=(a,b)=>a-b;\n');result=await check();assert.equal(result.checks[0].verdict,'failed');assert.notEqual(result.checks[0].exitCode,0);assert.equal(result.canApprove,false);assert.equal(result.checks.length,2);
    assert.equal(readFileSync(join(f.project.path,'README.md'),'utf8'),'# Orbit project\n\nThis project is ready for planning.\n');assert.equal(f.nativeCalls(),0);
    await f.controller.close();const reopened=new Controller(f.store,f.readonly,f.factory,f.projects);try{assert.deepEqual(reopened.verification.view(f.workspace.id,run.id).commands,commands);assert.equal(reopened.verification.view(f.workspace.id,run.id).checks.length,2);assert.equal(f.nativeCalls(),0);}finally{await reopened.close();}
  }finally{await f.close();}
});

test('setup preserves auth and exact fields and refuses foreign workspace and command overrides',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+f.path)).status,401);
    const view=await f.view(),body=input(view);
    assert.equal((await f.post(body,f.path,{'X-CSRF-Token':''})).status,403);assert.equal((await f.post(body,f.path,{Origin:'http://foreign.invalid'})).status,403);
    for(const invalid of [{...body,executable:process.execPath},{...body,args:['-e','bad']},{...body,protectedFiles:[]},{...body,cwd:f.workspace.path},{...body,confirmed:'true'},{...body,profileId:'shell'},{}])assert.equal((await f.post(invalid)).status,400);
    assert.equal((await f.post({...body,confirmed:false})).status,409);
    assert.equal((await fetch(f.origin+f.path+'?extra=1',{headers:f.headers})).status,400);assert.equal((await f.post(body,f.path+'?extra=1')).status,400);
    const other=f.projects.create(f.project.id);assert.equal((await f.post(body,'/api/workspaces/'+other.id+'/verification-setup')).status,409);
    assert.deepEqual(f.controller.verification.view(f.workspace.id,null).commands,[]);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});

test('source changes reject stale setup and replayed registration neither creates another revision nor executes checks',async()=>{
  const f=await fixture();try{
    const body=input(await f.view());writeFileSync(join(f.workspace.path,'model.mjs'),'export const add=(a,b)=>Number(a)+Number(b);\n');
    const stale=await f.post(body);assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'VERIFICATION_SETUP_PREVIEW_STALE'});
    const fresh=input(await f.view()),saved=await f.post(fresh);assert.equal(saved.status,200);const receipt=await saved.json();
    assert.deepEqual(await (await f.post(fresh)).json(),receipt);assert.equal((await f.view()).revision,1);assert.equal((await f.view()).lastRequestId,fresh.requestId);
    const conflict=await f.post({...fresh,expectedPreviewDigest:'0'.repeat(64)});assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'IDEMPOTENCY_CONFLICT'});
    assert.equal(f.controller.verification.view(f.workspace.id,null).checks.length,0);assert.equal(f.store.runs().length,0);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});

test('unknown Solo execution and lost checks in another workspace block project command updates',async()=>{
  const f=await fixture();try{
    const body=input(await f.view()),other=f.projects.create(f.project.id);
    f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run('lost-check','lost-request',JSON.stringify({id:'lost-check',workspaceId:other.id,execution:'lost',recoveredAt:null}));
    const lost=await f.post(body);assert.equal(lost.status,409);assert.deepEqual(await lost.json(),{error:'VERIFICATION_RECOVERY_REQUIRED'});
    const run=f.store.createRun(randomUUID(),'fixture','uncertain',f.workspace.id);f.store.updateRun(run.id,{execution:'lost'},'run.lost');
    const uncertain=await f.post(body);assert.equal(uncertain.status,409);assert.deepEqual(await uncertain.json(),{error:'SOLO_RECOVERY_REQUIRED'});
    assert.deepEqual(f.controller.verification.view(f.workspace.id,null).commands,[]);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});

test('the configured preset binds protected tests before a Task and later registration cannot rewrite its baseline',async()=>{
  const f=await fixture();try{
    const studio=new Studio(f.store),draft=studio.mutate(f.project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Node sum',goal:'Add two numbers',requirements:[{id:'R1',description:'Return the sum',acceptance_criteria:['Adding two and three returns five']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
    const plan=studio.mutate(f.project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
    const [task]=studio.mutate(f.project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
    assert.equal(f.controller.verification.acceptance.preview(f.project.id,f.workspace.id,task.id),null);
    assert.equal((await f.post(input(await f.view()))).status,200);
    const baseline=f.controller.verification.acceptance.preview(f.project.id,f.workspace.id,task.id)!;assert.deepEqual(baseline.files.map(file=>file.path),['model.test.mjs']);
    const run=f.store.createRun(randomUUID(),'fixture','synthetic task Run',f.workspace.id,{taskId:task.id,planningVersionId:plan.id,requirementLabels:task.requirementLabels},undefined,baseline);
    f.store.updateRun(run.id,{execution:'completed'},'run.completed');assert.equal(f.controller.verification.acceptance.status(f.workspace.id,run.id).state,'current');
    const originalTest=readFileSync(join(f.workspace.path,'model.test.mjs'),'utf8');writeFileSync(join(f.workspace.path,'model.test.mjs'),'// removed assertions\n');
    assert.equal(f.controller.verification.acceptance.status(f.workspace.id,run.id).state,'changed');writeFileSync(join(f.workspace.path,'model.test.mjs'),originalTest);
    writeFileSync(join(f.workspace.path,'extra.test.mjs'),"import {test} from 'node:test';test('extra',()=>{});\n");assert.equal((await f.post(input(await f.view()))).status,200);
    assert.equal((await f.view()).revision,2);assert.equal(f.controller.verification.acceptance.status(f.workspace.id,run.id).state,'changed');
    assert.equal(f.controller.verification.acceptance.status(f.workspace.id,run.id).baseline!.digest,baseline.digest);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});
