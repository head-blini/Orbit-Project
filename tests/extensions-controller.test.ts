import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from './temp.ts';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import type {ExtensionInventory} from '../shared/extensions.ts';

class Fake extends EventEmitter {
  calls:{method:string;params:any}[]=[];hold:Promise<unknown>|null=null;holdMcp:Promise<unknown>|null=null;invalidMcp=false;closed=false;
  async initialize(){} async close(){this.closed=true;this.emit('closed');}
  skills(cwd:string){return {data:[{cwd,errors:[],skills:[{name:'fixture-review',path:join(cwd,'PRIVATE_SKILL_PATH','SKILL.md'),scope:'repo',enabled:true,description:'PRIVATE_DESCRIPTION',dependencies:{tools:[{command:'PRIVATE_COMMAND'}]}}]}]};}
  async request(method:string,params:any):Promise<any>{
    this.calls.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'fixture-extension-thread',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user'};
    if(method==='mcpServerStatus/list')return this.holdMcp??{data:this.invalidMcp?[{name:'unexpected',runtimeStatus:'connected',tools:{danger:{}}}]:[],nextCursor:null};
    if(method==='skills/list')return this.hold??this.skills(params.cwds[0]);
    if(method==='hooks/list')return {data:[{cwd:params.cwds[0],errors:[],warnings:[],hooks:[]}]};
    throw new Error('UNEXPECTED_NATIVE_CALL');
  }
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'orbit-extension-controller-')),store=new Store(':memory:'),rpcs:Fake[]=[];
  const workspace=createWorkspace(root),controller=new Controller(store,workspace,()=>{const rpc=new Fake();rpcs.push(rpc);return rpc;});
  return {store,controller,workspace,rpcs,get rpc(){return rpcs.at(-1)!;},close:async()=>{await controller.close();store.close();}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('extension cache is inert, explicit reads reuse the isolated session, never start turns and do not persist raw metadata',async()=>{
  const f=fixture();try{
    assert.equal(f.controller.extensionSnapshot().source,'not_queried');assert.equal(f.rpcs.length,0);
    assert.throws(()=>f.controller.refreshExtensions({workspaceId:null}),/NOT_CONNECTED/);
    await f.controller.connect();assert.equal(f.rpc.calls.filter(c=>c.method==='skills/list').length,0);
    const first=f.controller.refreshExtensions({workspaceId:null}),second=f.controller.refreshExtensions({workspaceId:null});assert.equal(first,second);
    const report=await first;assert.equal(report.source,'codex_app_server');assert.equal(report.sections.find(s=>s.kind==='skills')!.items[0].name,'fixture-review');
    assert.equal(report.sections.find(s=>s.kind==='skills')!.items[0].version,null);
    const extra=f.rpc.calls.slice(4);assert.deepEqual(extra.map(c=>c.method).sort(),['hooks/list','mcpServerStatus/list','skills/list'].sort());
    assert.deepEqual(extra.find(c=>c.method==='skills/list')!.params,{cwds:[f.workspace],forceReload:false});
    assert.deepEqual(extra.find(c=>c.method==='mcpServerStatus/list')!.params,{threadId:'fixture-extension-thread',detail:'toolsAndAuthOnly',limit:100});
    const before=f.rpc.calls.length;report.sections.length=0;assert.equal(f.controller.extensionSnapshot().sections.length,4);
    await f.controller.refreshExtensions({workspaceId:null});assert.equal(f.rpc.calls.length,before);
    const now=Date.now;try{Date.now=()=>now()+61000;await f.controller.refreshExtensions({workspaceId:null});assert.equal(f.rpc.calls.length,before+3);}finally{Date.now=now;}
    assert.equal(f.store.runs().length,0);assert.doesNotMatch(JSON.stringify(f.store.eventsAfter(0)),/PRIVATE_|fixture-review/);
    assert.doesNotMatch(JSON.stringify(f.controller.extensionSnapshot()),/PRIVATE_|SKILL\.md/);
    await f.controller.close();assert.equal(f.controller.extensionSnapshot().source,'not_queried');
    await f.controller.connect();assert.equal(f.controller.extensionSnapshot().source,'not_queried');assert.equal(f.rpc.calls.length,4);
  }finally{await f.close();}
});

test('pending inventory blocks another native turn and workspace changes until its own finally releases the lock',async()=>{
  const f=fixture();let finish!:(value:unknown)=>void;try{
    await f.controller.connect();f.rpc.hold=new Promise(resolve=>{finish=resolve;});const pending=f.controller.refreshExtensions({workspaceId:null});await tick();
    assert.equal(f.controller.snapshot().extensionBusy,true);
    await assert.rejects(f.controller.submit({requestId:'extension-locked',prompt:'hello'}),/EXTENSION_QUERY_ACTIVE/);
    assert.throws(()=>f.controller.registerProject('unused'),/EXTENSION_QUERY_ACTIVE/);
    for(const method of ['startModelRequest','startVerification','approveVerification','prepareMerge','applyMerge','recoverMerge','startWorkflow','recoverWorkflow','startReview','recoverReview'] as const){
      assert.throws(()=>f.controller[method](null as never),/EXTENSION_QUERY_ACTIVE/,method);
    }
    await assert.rejects(f.controller.connect(),/EXTENSION_QUERY_ACTIVE/);
    assert.equal(f.store.runs().length,0);finish(f.rpc.skills(f.workspace));await pending;
    assert.equal(f.controller.snapshot().extensionBusy,false);
  }finally{if(finish)finish(f.rpc.skills(f.workspace));await f.close();}
});

test('late closed-session results and finally cannot overwrite or unlock a new inventory request',async()=>{
  const f=fixture();let finishOld!:(value:unknown)=>void,finishNew!:(value:unknown)=>void;try{
    await f.controller.connect();const old=f.rpc;old.hold=new Promise(resolve=>{finishOld=resolve;});const oldPending=f.controller.refreshExtensions({workspaceId:null});await tick();
    await f.controller.close();await f.controller.connect();const current=f.rpc;current.hold=new Promise(resolve=>{finishNew=resolve;});const currentPending=f.controller.refreshExtensions({workspaceId:null});await tick();
    finishOld(old.skills(f.workspace));assert.equal((await oldPending).source,'not_queried');assert.equal(f.controller.snapshot().extensionBusy,true);
    assert.equal(f.controller.extensionSnapshot().source,'not_queried');finishNew(current.skills(f.workspace));assert.equal((await currentPending).source,'codex_app_server');assert.equal(f.controller.snapshot().extensionBusy,false);
  }finally{if(finishOld)finishOld({data:[]});if(finishNew)finishNew({data:[]});await f.close();}
});

test('an unexpected MCP runtime invalidates native launch permission instead of publishing an empty successful inventory',async()=>{
  const f=fixture();try{
    await f.controller.connect();f.rpc.invalidMcp=true;
    await assert.rejects(f.controller.refreshExtensions({workspaceId:null}),/MCP_ISOLATION_REQUIRED/);
    assert.equal(f.rpc.closed,true);assert.equal(f.controller.snapshot().provider,'error');assert.equal(f.controller.extensionSnapshot().source,'not_queried');
    assert.equal(f.rpc.calls.some(c=>c.method==='skills/list'||c.method==='hooks/list'),false);
    await assert.rejects(f.controller.submit({requestId:'after-bad-inventory',prompt:'hello'}),/NOT_CONNECTED/);
  }finally{await f.close();}
});

test('failed isolation and transport closure publish an inventory unlock before any late result',async()=>{
  for(const kind of ['isolation','closed']){
    const f=fixture();let release!:(value:unknown)=>void;
    try{
      await f.controller.connect();f.rpc.holdMcp=new Promise(resolve=>{release=resolve;});
      const pending=f.controller.refreshExtensions({workspaceId:null});await tick();
      assert.equal(f.controller.snapshot().extensionBusy,true);
      if(kind==='isolation'){
        release({data:[{name:'foreign',runtimeStatus:'connected',tools:{danger:{}}}],nextCursor:null});
        await assert.rejects(pending,/MCP_ISOLATION_REQUIRED/);
      }else{await f.rpc.close();await tick();}
      assert.equal(f.controller.snapshot().extensionBusy,false);
      assert.deepEqual(f.store.eventsAfter(0).filter(e=>e.kind==='extensions.updated').map(e=>e.data.busy),[true,false]);
      if(kind==='closed'){release({data:[],nextCursor:null});await pending;}
      assert.deepEqual(f.store.eventsAfter(0).filter(e=>e.kind==='extensions.updated').map(e=>e.data.busy),[true,false]);
    }finally{release?.({data:[],nextCursor:null});await f.close();}
  }
});

test('a late isolation failure from a closed RPC cannot disconnect the new verified session',async()=>{
  const f=fixture();let finish!:(value:unknown)=>void;try{
    await f.controller.connect();const old=f.rpc;old.holdMcp=new Promise(resolve=>{finish=resolve;});const pending=f.controller.refreshExtensions({workspaceId:null});await tick();
    await f.controller.close();await f.controller.connect();await f.controller.refreshExtensions({workspaceId:null});
    finish({data:[{name:'foreign',runtimeStatus:'connected',tools:{danger:{}}}]});assert.equal((await pending).source,'not_queried');
    assert.equal(f.controller.snapshot().provider,'ready');assert.equal(f.rpc.closed,false);assert.equal(f.controller.extensionSnapshot().source,'codex_app_server');
  }finally{if(finish)finish({data:[]});await f.close();}
});

test('HTTP inventory needs a session, exact current scope and explicit Origin/CSRF; GET and restart never perform native reads',async()=>{
  const f=fixture(),server=createHttpServer(f.controller,'.');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    assert.equal((await fetch(origin+'/api/extensions')).status,401);
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as any,cookie=session.headers.get('set-cookie')!.split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
    const get=await fetch(origin+'/api/extensions',{headers});assert.equal(get.status,200);assert.equal((await get.json() as ExtensionInventory).source,'not_queried');assert.equal(f.rpcs.length,0);
    const post=(body:object,path='/api/extensions/refresh',patch={})=>fetch(origin+path,{method:'POST',headers:{...headers,...patch},body:JSON.stringify(body)});
    assert.equal((await post({workspaceId:null},undefined,{'X-CSRF-Token':''})).status,403);
    assert.equal((await post({workspaceId:null,cwd:'private'})).status,400);assert.equal((await post({workspaceId:null},'/api/extensions/refresh?force=true')).status,400);
    assert.equal((await fetch(origin+'/api/extensions?threadId=foreign',{headers})).status,400);
    assert.equal((await post({workspaceId:null})).status,409);await f.controller.connect();
    assert.equal((await post({workspaceId:'00000000-0000-4000-8000-000000000001'})).status,409);assert.equal(f.rpc.calls.length,4);
    const accepted=await post({workspaceId:null});assert.equal(accepted.status,200);assert.equal((await accepted.json() as ExtensionInventory).source,'codex_app_server');
    await f.controller.close();const restarted=new Controller(f.store,f.workspace,()=>{throw new Error('NO_NATIVE_REPLAY');});assert.equal(restarted.extensionSnapshot().source,'not_queried');await restarted.close();
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
