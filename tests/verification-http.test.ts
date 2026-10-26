import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from './temp.ts';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
import { Controller } from '../server/controller.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';
import type { VerificationView } from '../shared/verification.ts';
import { readVerificationConfiguration } from '../server/verification-service.ts';

async function fixture(script="console.log('fixture verified')"){
  const dir=mkdtempSync(join(tmpdir(),'orbit-check-http-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe',windowsHide:true});
  git('init','-q','-b','main');writeFileSync(join(root,'check.mjs'),script);writeFileSync(join(root,'source.txt'),'before');
  git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(join(dir,'test.sqlite')),projects=new Projects(store,join(dir,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id);
  const config=readVerificationConfiguration(JSON.stringify([{projectPath:root,id:'test',label:'Fixture test',executable:process.execPath,args:['check.mjs'],timeoutMs:5000}]));
  const controller=new Controller(store,createWorkspace(dir),()=>{throw new Error('AI_DISABLED_IN_FIXTURE');},projects,config);
  await controller.selectWorkspace(workspace.id);
  const run=store.createRun(randomUUID(),'fixture','synthetic fixture run',workspace.id);store.updateRun(run.id,{execution:'completed'},'run.completed');
  const server=createHttpServer(controller,dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),{csrfToken}=await response.json() as any,cookie=response.headers.get('set-cookie')!.split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken},base='/api/workspaces/'+workspace.id;
  const post=(path:string,body:object,overrides:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});
  const view=async()=>(await (await fetch(origin+base+'/verification?runId='+run.id,{headers:{Cookie:cookie}})).json()) as VerificationView;
  const input=(v:VerificationView)=>({requestId:randomUUID(),runId:run.id,commandId:'test',expectedSourceDigest:v.sourceDigest!,expectedConfigDigest:v.commands[0].configDigest});
  return {dir,root,store,projects,workspace,run,controller,origin,base,headers,post,view,input,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();}};
}

test('real worktree HTTP verification records exit and approval, then invalidates changed source without modifying original',async()=>{
  const f=await fixture();try{
    let view=await f.view();assert.ok(view.sourceDigest);assert.equal(view.commands.length,1);assert.equal(view.canApprove,false);
    const body=f.input(view),response=await f.post(f.base+'/checks',body);assert.equal(response.status,200);
    const check=await response.json() as any;await f.controller.verification.settle();
    view=await f.view();assert.equal(view.checks[0].id,check.id);assert.equal(view.checks[0].exitCode,0);assert.equal(view.canApprove,true);
    assert.equal((await f.post(f.base+'/checks',body)).status,200);assert.equal((await f.view()).checks.length,1);
    const approval={requestId:randomUUID(),runId:f.run.id,expectedSourceDigest:view.sourceDigest,expectedCheckSetDigest:view.checkSetDigest};
    assert.equal((await f.post(f.base+'/review-approval',approval)).status,200);assert.equal((await f.view()).approvalCurrent,true);
    writeFileSync(join(f.workspace.path,'source.txt'),'after');
    view=await f.view();assert.equal(view.canApprove,false);assert.equal(view.approvalCurrent,false);
    assert.equal((await f.post(f.base+'/review-approval',{...approval,requestId:randomUUID()})).status,409);
    assert.equal(readFileSync(join(f.root,'source.txt'),'utf8'),'before');
    assert.equal(f.store.getRun(f.run.id)?.execution,'completed');assert.equal(f.store.getRun(f.run.id)?.verification,'recorded');
  }finally{await f.close();}
});

test('verification HTTP gates reject CSRF, field injection, source races, active workspaces and sensitive filenames',async()=>{
  const f=await fixture("setTimeout(()=>{},30000)");try{
    let view=await f.view(),body=f.input(view);
    assert.equal((await fetch(f.origin+f.base+'/verification?runId='+f.run.id)).status,401);
    assert.equal((await f.post(f.base+'/checks',body,{'X-CSRF-Token':''})).status,403);
    for(const extra of [{cwd:f.root},{args:['evil']},{executable:process.execPath},{env:{SECRET:'synthetic'}}])assert.equal((await f.post(f.base+'/checks',{...body,...extra})).status,400);
    assert.equal((await f.post(f.base+'/checks',{...body,expectedConfigDigest:'d'.repeat(64)})).status,409);
    writeFileSync(join(f.workspace.path,'source.txt'),'changed');assert.equal((await f.post(f.base+'/checks',body)).status,409);
    view=await f.view();body=f.input(view);
    const response=await f.post(f.base+'/checks',body);assert.equal(response.status,200);const check=await response.json() as any;
    await assert.rejects(f.controller.selectWorkspace(f.workspace.id),/VERIFICATION_ACTIVE/);
    assert.equal((await f.post(f.base+'/checks',{...body,requestId:randomUUID()})).status,409);
    assert.equal((await f.post(f.base+'/checks/'+check.id+'/interrupt',{})).status,200);
    await f.controller.verification.settle();assert.equal((await f.view()).checks[0].verdict,'interrupted');
    writeFileSync(join(f.workspace.path,'auth.json'),'synthetic credential fixture');
    view=await f.view();assert.equal(view.sourceDigest,null);assert.equal(view.sourceIssue,'FINGERPRINT_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(view),/synthetic credential fixture/);
  }finally{await f.close();}
});
