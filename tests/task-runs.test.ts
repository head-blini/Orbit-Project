import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import { Controller } from '../server/controller.ts';
import { Projects } from '../server/projects.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';

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
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-task-run-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe',windowsHide:true});
  git('init','-q','-b','main');writeFileSync(join(root,'source.ts'),'export const original = true;\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial');
  const db=join(dir,'test.sqlite'),store=new Store(db),projects=new Projects(store,join(dir,'managed'),[root]);
  const project=projects.register(root),workspace=projects.create(project.id),rpc=new Fake();
  const controller=new Controller(store,createWorkspace(dir),()=>rpc,projects);
  await controller.selectWorkspace(workspace.id);await controller.connect();
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
