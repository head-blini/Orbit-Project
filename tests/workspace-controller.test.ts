import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Controller } from '../server/controller.ts';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
import { createWorkspace } from '../server/workspace.ts';
class Fake extends EventEmitter {
  calls:{method:string;params:any}[]=[];thread='';policyPatch:any={};
  async initialize(){}
  async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{this.calls.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{local:{enabled:true}}}};
    if(method==='mcpServerStatus/list')return {data:[{name:'local',runtimeStatus:'disabled',tools:{}}]};
    if(method==='thread/start'||method==='thread/resume'){this.thread=params.threadId??'thread-'+this.calls.length;return {thread:{id:this.thread,status:{type:'idle'}},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true,...this.policyPatch}};}
    if(method==='turn/start')return {turn:{id:'turn-1'}};return {};
  }
}
function setup(){const dir=mkdtempSync(join(tmpdir(),'orbit-controller-'));const root=join(dir,'project');mkdirSync(root);const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe',windowsHide:true});git('init','-q','-b','main');writeFileSync(join(root,'code.ts'),'original\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial');const store=new Store(':memory:');const projects=new Projects(store,join(dir,'managed'),[root]);const project=projects.register(root);const a=projects.create(project.id),b=projects.create(project.id);const rpc=new Fake();const cwd:string[]=[];const c=new Controller(store,createWorkspace(dir),path=>{cwd.push(path);return rpc;},projects);return {store,projects,c,rpc,a,b,cwd,root};}
test('only selected workspace reaches Codex; runs and threads scoped, active switch denied, transport loss preserves edits',async()=>{
  const {store,c,rpc,a,b,cwd,root}=setup();try{
    await c.selectWorkspace(a.id);await c.connect();assert.deepEqual(cwd,[a.path]);
    const start=rpc.calls.find(x=>x.method==='thread/start')!.params;assert.equal(start.cwd,a.path);assert.equal(start.sandbox,'workspace-write');assert.equal(start.approvalPolicy,'on-request');assert.deepEqual(start.config.mcp_servers,{local:{enabled:false}});assert.deepEqual(start.config.sandbox_workspace_write.writable_roots,[]);
    const run=await c.submit({requestId:'workspace-request-a',prompt:'change code',workspaceId:a.id});assert.equal(run.workspaceId,a.id);const turn=rpc.calls.find(x=>x.method==='turn/start')!.params;assert.equal(turn.cwd,a.path);assert.equal(turn.sandboxPolicy.excludeTmpdirEnvVar,true);assert.equal(turn.sandboxPolicy.networkAccess,false);
    await assert.rejects(c.selectWorkspace(b.id),/RUN_ACTIVE/);writeFileSync(join(a.path,'code.ts'),'changed\n');rpc.emit('closed');assert.equal(store.getRun(run.id)!.execution,'lost');
    await c.selectWorkspace(b.id);assert.equal(c.snapshot().runs.length,0);assert.equal(c.snapshot().threadId,null);await c.connect();await c.selectWorkspace(a.id);await c.connect();assert.equal(c.snapshot().runs[0].id,run.id);assert.equal(rpc.calls.filter(x=>x.method==='turn/start').length,1);assert.ok(rpc.calls.some(x=>x.method==='thread/resume'));assert.equal(readFileSync(join(a.path,'code.ts'),'utf8'),'changed\n');assert.equal(readFileSync(join(root,'code.ts'),'utf8'),'original\n');
  }finally{await c.close();store.close();}
});
test('a stale browser cannot submit to the workspace another tab selected',async()=>{
  const {store,c,rpc,a,b}=setup();try{await c.selectWorkspace(a.id);await c.connect();await c.selectWorkspace(b.id);await c.connect();await assert.rejects(c.submit({requestId:'stale-tab-request',prompt:'edit the selected project',workspaceId:a.id}),/WORKSPACE_MISMATCH/);await assert.rejects(c.submit({requestId:'missing-context-request',prompt:'edit'}),/WORKSPACE_MISMATCH/);assert.equal(store.runs().length,0);assert.equal(rpc.calls.some(x=>x.method==='turn/start'),false);}finally{await c.close();store.close();}
});
test('workspace policy with extra writable root or temporary grants never reaches ready',async()=>{
  const {store,c,rpc,a}=setup();try{await c.selectWorkspace(a.id);for(const patch of [{writableRoots:[tmpdir()]},{excludeTmpdirEnvVar:false},{excludeSlashTmp:false},{networkAccess:true},{type:'dangerFullAccess'}]){rpc.policyPatch=patch;await assert.rejects(c.connect(),/POLICY_MISMATCH/);assert.equal(c.snapshot().provider,'error');}assert.equal(rpc.calls.some(x=>x.method==='turn/start'),false);}finally{await c.close();store.close();}
});
