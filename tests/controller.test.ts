import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../server/controller.ts';
import { Store } from '../server/store.ts';
import { createWorkspace } from '../server/workspace.ts';

class FakeRpc extends EventEmitter {
  starts=0; sent:any[]=[]; dead=false;
  async request(method:string,params:any):Promise<any> {
    this.sent.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt',email:'must-not-export@example.test'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume') return {thread:{id:'thread-fixture',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='turn/start'){this.starts++; await new Promise(r=>setTimeout(r,10));this.emit('notification',{method:'turn/started',params:{threadId:'thread-fixture',turn:{id:'turn-fixture'}}});return {turn:{id:'turn-fixture'}};}
    return {};
  }
  async initialize(){}
  async close(){this.dead=true;this.emit('closed');}
}
function setup(){const rpc=new FakeRpc();const store=new Store(':memory:');const dir=createWorkspace(mkdtempSync(join(tmpdir(),'aicc-controller-')));return {rpc,store,c:new Controller(store,dir,()=>rpc)};}

test('MCP servers are disabled before thread creation and again on resume without exporting configuration',async()=>{
  const {c,rpc,store}=setup();const original=rpc.request.bind(rpc);
  rpc.request=(method,params)=>method==='config/read'?Promise.resolve({config:{mcp_servers:{fixture:{command:'private-command',env:{EXAMPLE:'private-value'}}}}}):original(method,params);
  try{
    await c.connect();await c.close();await c.connect();
    for(const method of ['thread/start','thread/resume']){
      const call=rpc.sent.find(x=>x.method===method);
      assert.deepEqual(call?.params.config?.mcp_servers,{fixture:{enabled:false}});
    }
    assert.equal(JSON.stringify(store.eventsAfter(0)).includes('private-value'),false);
    assert.equal(JSON.stringify(c.snapshot()).includes('private-command'),false);
  }finally{await c.close();store.close();}
});

test('unreadable MCP configuration prevents thread creation, not merely inference',async()=>{
  const {c,rpc,store}=setup();const original=rpc.request.bind(rpc);
  rpc.request=(method,params)=>method==='config/read'?Promise.reject(new Error('RPC_REJECTED')):original(method,params);
  try{
    await assert.rejects(c.connect(),/MCP_ISOLATION_REQUIRED/);
    assert.equal(rpc.sent.some(x=>x.method==='thread/start'),false);
    assert.equal(rpc.starts,0);
  }finally{await c.close();store.close();}
});

test('explicitly disabled known MCP entries are accepted; unknown or callable entries are rejected',async()=>{
  for(const [entry,allowed] of [
    [{name:'fixture',runtimeStatus:'disabled',tools:{}},true],
    [{name:'fixture',runtimeStatus:'ready',tools:{}},false],
    [{name:'fixture',runtimeStatus:'disabled',tools:{read:{}}},false],
    [{name:'unexpected',runtimeStatus:'disabled',tools:{}},false],
  ] as const){
    const {c,rpc,store}=setup();const original=rpc.request.bind(rpc);
    rpc.request=(method,params)=>method==='config/read'?Promise.resolve({config:{mcp_servers:{fixture:{enabled:true}}}}):method==='mcpServerStatus/list'?Promise.resolve({data:[entry],nextCursor:null}):original(method,params);
    try{if(allowed){await c.connect();assert.equal(c.snapshot().provider,'ready');}else await assert.rejects(c.connect(),/MCP_ISOLATION_REQUIRED/);}
    finally{await c.close();store.close();}
  }
});

test('server policy mismatches prevent a ready session',async()=>{
  for(const patch of [{approvalPolicy:'never'},{approvalsReviewer:'auto_review'},{sandbox:{type:'readOnly',networkAccess:true}}]){
    const {c,rpc,store}=setup();const original=rpc.request.bind(rpc);
    rpc.request=async(method,params)=>{const value=await original(method,params);return method==='thread/start'?{...value,...patch}:value;};
    try{await assert.rejects(c.connect(),/POLICY_MISMATCH/);assert.equal(rpc.starts,0);}
    finally{await c.close();store.close();}
  }
});
test('concurrent duplicate submissions start only one turn; altered payload conflicts',async()=>{
  const {c,rpc,store}=setup(); await Promise.all([c.connect(),c.connect()]);
  const input={requestId:'request-0001',prompt:'hello'};
  const [a,b]=await Promise.all([c.submit(input),c.submit(input)]);
  assert.equal(a.id,b.id);assert.equal(rpc.starts,1);
  await assert.rejects(c.submit({...input,prompt:'different'}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(c.submit({requestId:'request-0002',prompt:'hello'}),/RUN_ACTIVE/);
  assert.equal(JSON.stringify(c.snapshot()).includes('example.test'),false);await c.close();store.close();
});
test('MCP inventory containing any configured server prevents ready state and inference',async()=>{
  const {c,rpc,store}=setup();const original=rpc.request.bind(rpc);
  rpc.request=(method,params)=>method==='mcpServerStatus/list'?Promise.resolve({data:[{name:'fixture',tools:{}}],nextCursor:null}):original(method,params);
  await assert.rejects(c.connect(),/MCP_ISOLATION_REQUIRED/);
  assert.equal(c.snapshot().provider,'error');assert.equal(rpc.starts,0);
  await c.close();store.close();
});
test('unavailable or paginated MCP inventory fails closed',async()=>{
  const {c,rpc,store}=setup();const original=rpc.request.bind(rpc);
  rpc.request=(method,params)=>method==='mcpServerStatus/list'?Promise.resolve({data:[],nextCursor:'next'}):original(method,params);
  await assert.rejects(c.connect(),/MCP_ISOLATION_REQUIRED/);assert.equal(rpc.starts,0);await c.close();store.close();
});
test('interrupt acceptance stays interrupting until terminal event; verification remains not_run',async()=>{
  const {c,rpc,store}=setup();await c.connect();const r=await c.submit({requestId:'request-0001',prompt:'hello'});
  await c.interrupt(r.id);assert.equal(store.getRun(r.id)?.execution,'interrupting');
  rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'interrupted'}}});
  assert.equal(store.getRun(r.id)?.execution,'interrupted');assert.equal(store.getRun(r.id)?.verification,'not_run');
  await c.close();store.close();
});
test('disconnect marks active run lost; reconnect loads saved thread and never resends prompt',async()=>{
  const {c,rpc,store}=setup();await c.connect();await c.submit({requestId:'request-0001',prompt:'hello'});
  rpc.emit('closed');assert.equal(c.snapshot().provider,'disconnected');assert.equal(store.runs()[0].execution,'lost');
  await c.connect();assert.equal(rpc.starts,1);assert.ok(rpc.sent.some(x=>x.method==='thread/resume'));
  await c.close();store.close();
});
test('foreign events cannot alter the active run and completion does not pass verification',async()=>{
  const {c,rpc,store}=setup();await c.connect();await c.submit({requestId:'request-0001',prompt:'hello'});
  rpc.emit('notification',{method:'turn/completed',params:{threadId:'foreign',turn:{id:'turn-fixture',status:'completed'}}});
  assert.equal(store.runs()[0].execution,'running');
  rpc.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread-fixture',turnId:'turn-fixture',itemId:'m1',delta:'Safe answer.'}});
  rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
  assert.equal(store.runs()[0].response,'Safe answer.');assert.equal(store.runs()[0].verification,'not_run');
  await c.close();store.close();
});
test('a late interrupt failure for completed A cannot mark new run B lost',async()=>{
  const {c,rpc,store}=setup();await c.connect();
  const a=await c.submit({requestId:'request-0001',prompt:'A'});
  let rejectInterrupt!:(e:Error)=>void;const original=rpc.request.bind(rpc);
  rpc.request=(method,params)=>method==='turn/interrupt'?new Promise((_resolve,reject)=>{rejectInterrupt=reject;}):original(method,params);
  const pending=c.interrupt(a.id);
  rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
  const b=await c.submit({requestId:'request-0002',prompt:'B'});
  rejectInterrupt(new Error('RPC_TIMEOUT'));
  await pending;
  assert.equal(store.getRun(b.id)?.execution,'running');assert.equal(c.snapshot().provider,'ready');
  await c.close();store.close();
});
