import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from './temp.ts';
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

test('Solo dispatch has durable manager/session identity and replay preserves the same operation',async()=>{
  const {c,rpc,store}=setup(),request=rpc.request.bind(rpc);let beforeDispatch=false;
  rpc.request=async(method,params)=>{
    if(method==='turn/start'){
      const run=store.runs().at(-1)!,record=store.soloOperation(run.id).record;
      assert.ok(record);assert.equal(record.execution,'starting');assert.equal(record.nativeSessionId,params.threadId);
      assert.match(record.ownerIncarnation,/^[a-f0-9-]{36}$/);assert.ok(record.generation>0);beforeDispatch=true;
      const provenance=store.db.prepare("SELECT data FROM events WHERE run_id=? AND kind='run.runtime_source'").get(run.id);
      assert.deepEqual(JSON.parse(String(provenance?.data)),{source:'unknown',interface:'codex.app_server'});
    }return request(method,params);
  };
  try{
    await c.connect();const input={requestId:'journal-dispatch-request',prompt:'Fixture'},run=await c.submit(input);
    assert.equal(beforeDispatch,true);const view=store.soloOperation(run.id);assert.equal(view.record?.nativeTurnId,'turn-fixture');
    assert.equal((await c.submit(input)).id,run.id);assert.deepEqual(store.soloOperation(run.id),view);assert.equal(rpc.starts,1);
  }finally{await c.close();store.close();}
});

test('failed Solo identity persistence never starts a native turn or leaves a partial Run',async()=>{
  const {c,rpc,store}=setup();try{
    await c.connect();store.db.exec("CREATE TRIGGER fail_identity BEFORE INSERT ON solo_operations BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    await assert.rejects(c.submit({requestId:'journal-failure-request',prompt:'Fixture'}));
    assert.equal(rpc.starts,0);assert.equal(store.runs().length,0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM solo_operation_history').get()!.count,0);
  }finally{await c.close();store.close();}
});

test('native notification persistence failure fences the connection even when loss and status writes also fail',async()=>{
  for(const allWritesFail of [false,true]){
    const {c,rpc,store}=setup();try{
      await c.connect();const run=await c.submit({requestId:'journal-notification-failure',prompt:'Fixture'});
      store.db.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON solo_operation_history ${allWritesFail?'':"WHEN json_extract(NEW.body,'$.execution')='completed'"} BEGIN SELECT RAISE(FAIL,'journal-write-failed'); END;`);
      if(allWritesFail)store.db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'event-write-failed'); END;");
      const complete=()=>rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
      assert.doesNotThrow(complete);await new Promise(resolve=>setImmediate(resolve));
      assert.equal(c.snapshot().provider,'error');assert.equal(c.snapshot().issue,'STATE_PERSISTENCE_FAILED');
      assert.equal(c.snapshot().soloRecoveryRequired,true);assert.equal(rpc.dead,true);
      assert.equal(store.getRun(run.id)?.execution,allWritesFail?'running':'lost');
      assert.equal(store.soloOperation(run.id).history.some(entry=>entry.execution==='completed'),false);
      await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);
      await assert.rejects(c.submit({requestId:'journal-notification-next',prompt:'Next'}),/SOLO_RECOVERY_REQUIRED/);
      store.db.exec('DROP TRIGGER fail_history; DROP TRIGGER IF EXISTS fail_events');
      const before=store.soloOperation(run.id);complete();assert.deepEqual(store.soloOperation(run.id),before);
      assert.equal(rpc.starts,1);
    }finally{store.db.exec('DROP TRIGGER IF EXISTS fail_history; DROP TRIGGER IF EXISTS fail_events');await c.close();store.close();}
  }
});

test('closed and approval audit failures cannot escape native listeners or permit another dispatch',async()=>{
  for(const event of ['closed','approval']){
    const {c,rpc,store}=setup();try{
      await c.connect();await c.submit({requestId:'native-audit-failure',prompt:'Fixture'});
      store.db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'event-write-failed'); END;");
      assert.doesNotThrow(()=>rpc.emit(event,{method:'fixtureApproval'}));await new Promise(resolve=>setImmediate(resolve));
      assert.equal(c.snapshot().soloRecoveryRequired,true);assert.equal(c.snapshot().provider,'error');
      await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);assert.equal(rpc.starts,1);
    }finally{store.db.exec('DROP TRIGGER IF EXISTS fail_events');await c.close();store.close();}
  }
});

test('credential output stays redacted in every persisted run and event across chunks and interleaved items',async()=>{
  const {c,rpc,store}=setup();try{
    await c.connect();const run=await c.submit({requestId:'output-redaction-request',prompt:'Explain the synthetic fixture'});
    const emit=(method:string,params:object)=>rpc.emit('notification',{method,params:{threadId:'thread-fixture',turnId:'turn-fixture',...params}});
    const secret='synthetic-output-secret';
    emit('item/agentMessage/delta',{itemId:'a',delta:'AWS_SECRET_ACCESS_KEY='+secret.slice(0,10)});
    emit('item/completed',{item:{id:'b',type:'agentMessage',text:'Other message completed'}});
    assert.equal(JSON.stringify(store.eventsAfter(0)).includes(secret.slice(0,10)),false);
    emit('item/agentMessage/delta',{itemId:'a',delta:secret.slice(10)+'\n'});
    emit('item/agentMessage/delta',{itemId:'partial',delta:'ghp_fixture'});
    emit('item/completed',{item:{id:'other',type:'agentMessage',text:'Interleaved completion'}});
    assert.equal(JSON.stringify(store.eventsAfter(0)).includes('ghp_fixture'),false);
    emit('item/agentMessage/delta',{itemId:'partial',delta:'x'.repeat(30)+'\n'});
    emit('item/agentMessage/delta',{itemId:'aws-id',delta:'AKIAAAAAAA'});
    emit('item/completed',{item:{id:'aws-other',type:'agentMessage',text:'Other item'}});
    assert.equal(JSON.stringify(store.eventsAfter(0)).includes('AKIAAAAAAA'),false);
    emit('item/agentMessage/delta',{itemId:'aws-id',delta:'A'.repeat(10)+'\n'});
    emit('item/agentMessage/delta',{itemId:'c',delta:'-----BEGIN PRIVATE KEY-----\n'});
    emit('item/agentMessage/delta',{itemId:'c',delta:'SYNTHETIC_PRIVATE_BODY\n'});
    emit('item/completed',{item:{id:'d',type:'agentMessage',text:'Another message'}});
    emit('item/agentMessage/delta',{itemId:'c',delta:'-----END PRIVATE KEY-----\n'});
    emit('turn/completed',{turn:{id:'turn-fixture',status:'completed'}});
    for(const value of [JSON.stringify(store.eventsAfter(0)),JSON.stringify(store.runs()),JSON.stringify(c.snapshot())]){
      assert.equal(value.includes(secret),false);assert.equal(value.includes('SYNTHETIC_PRIVATE_BODY'),false);
    }
    assert.equal(store.getRun(run.id)!.execution,'completed');assert.match(store.getRun(run.id)!.response,/REDACTED/);
  }finally{await c.close();store.close();}
});

test('server outbound policy blocks personal data and JSON credentials before Codex dispatch or persistence',async()=>{
  const {c,rpc,store}=setup();try{
    await c.connect();
    for(const prompt of ['Contact example@example.test','{"api_key":"synthetic-value"}','AWS_SECRET_ACCESS_KEY=synthetic-value']){
      await assert.rejects(c.submit({requestId:'request-privacy',prompt}),/PERSONAL_DATA_BLOCKED|CREDENTIAL_LIKE_INPUT/);
      assert.equal(rpc.starts,0);assert.equal(store.runs().length,0);
      assert.equal(JSON.stringify(store.eventsAfter(0)).includes(prompt),false);
    }
  }finally{await c.close();store.close();}
});

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

test('null MCP configuration fails before native main-thread creation just as in isolated review',async()=>{
  const {c,rpc,store}=setup(),original=rpc.request.bind(rpc);
  rpc.request=(method,params)=>method==='config/read'?Promise.resolve({config:{mcp_servers:null}}):original(method,params);
  try{await assert.rejects(c.connect(),/MCP_ISOLATION_REQUIRED/);assert.equal(rpc.sent.some(call=>call.method==='thread/start'),false);assert.equal(rpc.starts,0);}
  finally{await c.close();store.close();}
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
test('disconnect quarantines Solo before reconnect or another turn while preserving request replay',async()=>{
  const {c,rpc,store}=setup();try{
    await c.connect();const input={requestId:'request-0001',prompt:'hello'},run=await c.submit(input);
    rpc.emit('closed');assert.equal(c.snapshot().provider,'disconnected');assert.equal(store.runs()[0].execution,'lost');
    await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);
    await assert.rejects(c.submit({...input,requestId:'request-0002'}),/SOLO_RECOVERY_REQUIRED/);
    assert.equal((await c.submit(input)).id,run.id);assert.equal(rpc.starts,1);assert.ok(!rpc.sent.some(x=>x.method==='thread/resume'));
    assert.equal(c.snapshot().soloRecoveryRequired,true);assert.equal(store.runs().length,1);
  }finally{await c.close();store.close();}
});
test('restart quarantines an unresolved stored Solo run before factory creation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-solo-restart-')),path=join(dir,'state.sqlite');let store=new Store(path),calls=0;
  const run=store.createRun('uncertain-restart','digest','Fixture');store.close();store=new Store(path);
  const c=new Controller(store,createWorkspace(dir),()=>{calls++;return new FakeRpc();});
  try{
    assert.equal(store.getRun(run.id)?.execution,'lost');assert.equal(c.snapshot().soloRecoveryRequired,true);
    await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);assert.equal(calls,0);
    assert.throws(()=>c.registerProject('/never-read'),/SOLO_RECOVERY_REQUIRED/);
    assert.throws(()=>c.createWorktree('another-project'),/SOLO_RECOVERY_REQUIRED/);
    await assert.rejects(c.selectWorkspace('another-workspace'),/SOLO_RECOVERY_REQUIRED/);
    assert.equal(store.getRun(run.id)?.prompt,'Fixture');
  }finally{await c.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('loss persistence failure retains a volatile deny barrier without claiming recovery',async()=>{
  const {c,rpc,store}=setup();try{
    await c.connect();await c.submit({requestId:'storage-loss-request',prompt:'Fixture'});
    store.db.exec("CREATE TRIGGER fail_loss BEFORE UPDATE ON runs BEGIN SELECT RAISE(FAIL,'loss fixture'); END;");
    assert.doesNotThrow(()=>rpc.emit('closed'));
    assert.equal(c.snapshot().soloRecoveryRequired,true);assert.equal(store.runs()[0].execution,'running');
    await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);assert.equal(rpc.starts,1);
    store.db.exec('DROP TRIGGER fail_loss');
    rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
    assert.equal(store.runs()[0].execution,'running','late events from the closed RPC must not erase the durable unresolved Run');
  }finally{store.db.exec('DROP TRIGGER IF EXISTS fail_loss');await c.close();store.close();}
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
