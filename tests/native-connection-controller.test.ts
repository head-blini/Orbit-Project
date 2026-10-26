import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import type {NativeProcessObservation} from '../shared/native-process.ts';
import {Rpc} from '../server/rpc.ts';
import {NativeExecutableUnavailable,NativeLaunchNotStarted} from '../server/native-launch-error.ts';

class ObservedRpc extends EventEmitter{
  observation:NativeProcessObservation;starts=0;initializes=0;
  constructor(id:string){super();this.observation={handleId:'child-'+id,pid:123,createdAt:new Date().toISOString(),state:'running',closedAt:null,exitCode:null,signal:null};}
  processObservation(){return {...this.observation};}
  async initialize(){this.initializes++;}
  async request(method:string,params:any):Promise<any>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'session-process',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='mcpServerStatus/list')return {data:[]};
    if(method==='turn/start'){this.starts++;return {turn:{id:'turn-process'}};}
    return {};
  }
  finish(){this.emit('notification',{method:'turn/completed',params:{threadId:'session-process',turn:{id:'turn-process',status:'completed'}}});}
  observeClose(){this.observation={...this.observation,state:'closed',closedAt:new Date().toISOString(),exitCode:0};this.emit('process.observed');}
  async close(){if(this.observation.state!=='closed')this.observeClose();this.emit('closed');}
}
function setup(factory?:(store:Store)=>ObservedRpc){const root=mkdtempSync(join(tmpdir(),'orbit-native-controller-')),store=new Store(':memory:'),rpc=new ObservedRpc('first');return {root,store,rpc,c:new Controller(store,createWorkspace(root),()=>factory?factory(store):rpc)};}

test('connection intent precedes factory and owned process facts remain separate from Run completion',async()=>{
  let beforeFactory=false;
  const {root,c,store}=setup(s=>{const row=s.db.prepare('SELECT body FROM native_connections').get();assert.ok(row);assert.equal(JSON.parse(String(row.body)).process,null);beforeFactory=true;return new ObservedRpc('intent');});
  try{
    await c.connect();assert.equal(beforeFactory,true);const run=await c.submit({requestId:'process-facts-request',prompt:'Fixture'});
    assert.equal(store.soloOperation(run.id).connection?.process?.state,'running');
    await c.close();assert.equal(store.soloOperation(run.id).connection?.process?.state,'closed');
    assert.equal(store.getRun(run.id)?.execution,'lost','parent close cannot promote execution to success');
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('failed durable connection intent prevents factory and native initialization',async()=>{
  let calls=0;const {root,c,store}=setup(()=>{calls++;return new ObservedRpc('never');});
  try{
    store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON native_connections BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    await assert.rejects(c.connect());assert.equal(calls,0);assert.equal(store.runs().length,0);
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('late owned-process close updates only its original connection after a later generation starts',async()=>{
  const ports:ObservedRpc[]=[];const {root,c,store}=setup(()=>{const rpc=new ObservedRpc(String(ports.length));ports.push(rpc);return rpc;});
  try{
    await c.connect();const a=await c.submit({requestId:'process-generation-a',prompt:'A'});ports[0].finish();ports[0].emit('closed');
    assert.equal(store.soloOperation(a.id).connection?.process?.state,'running');
    await c.connect();const b=await c.submit({requestId:'process-generation-b',prompt:'B'}),before=store.soloOperation(b.id);
    ports[0].observeClose();
    assert.equal(store.soloOperation(a.id).connection?.process?.state,'closed');assert.equal(store.getRun(a.id)?.execution,'completed');
    assert.deepEqual(store.soloOperation(b.id),before);assert.equal(c.snapshot().provider,'ready');
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('failed process evidence persistence stays unknown and quarantines without escaping the child listener',async()=>{
  const {root,c,store,rpc}=setup();try{
    await c.connect();const run=await c.submit({requestId:'process-evidence-failure',prompt:'Fixture'});
    store.db.exec("CREATE TRIGGER fail_process BEFORE UPDATE ON native_connections WHEN json_extract(NEW.body,'$.process.state')='closed' BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.doesNotThrow(()=>rpc.observeClose());await new Promise(resolve=>setImmediate(resolve));
    assert.equal(c.snapshot().soloRecoveryRequired,true);assert.equal(store.soloOperation(run.id).connection?.process?.state,'running');
    await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);assert.equal(rpc.starts,1);
  }finally{store.db.exec('DROP TRIGGER IF EXISTS fail_process');await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('pre-Run evidence persistence failure remains quarantined after restart instead of losing the barrier',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-connection-failure-restart-')),path=join(root,'fixture.sqlite');let store=new Store(path);
  const workspace=createWorkspace(root),rpc=new ObservedRpc('failure');const c=new Controller(store,workspace,()=>rpc);let next:Controller|undefined;
  try{
    store.db.exec("CREATE TRIGGER fail_observation BEFORE UPDATE ON native_connections BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    await assert.rejects(c.connect(),/STATE_PERSISTENCE_FAILED/);assert.equal(c.snapshot().soloRecoveryRequired,true);assert.equal(store.runs().length,0);
    store.db.exec('DROP TRIGGER fail_observation');await c.close();store.close();store=new Store(path);let calls=0;
    next=new Controller(store,workspace,()=>{calls++;return new ObservedRpc('must-not-start');});
    assert.equal(next.snapshot().soloRecoveryRequired,true);await assert.rejects(next.connect(),/SOLO_RECOVERY_REQUIRED/);assert.equal(calls,0);
  }finally{await next?.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('known session identity survives later policy rejection without becoming successful execution',async()=>{
  const {root,c,store,rpc}=setup(),request=rpc.request.bind(rpc);
  rpc.request=async(method,params)=>{const value=await request(method,params);return method==='thread/start'?{...value,approvalPolicy:'never'}:value;};
  try{
    await assert.rejects(c.connect(),/POLICY_MISMATCH/);const row=store.db.prepare('SELECT owner_incarnation,generation FROM native_connections').get()!;
    const connection=store.nativeConnection(String(row.owner_incarnation),Number(row.generation));assert.equal(connection?.nativeSessionId,'session-process');assert.equal(connection?.process?.state,'closed');assert.equal(store.runs().length,0);
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('trusted executable absence records no creation and does not quarantine a subsequent startup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-no-native-process-')),store=new Store(':memory:'),workspace=createWorkspace(root);
  const c=new Controller(store,workspace,()=>{throw new NativeExecutableUnavailable();});let next:Controller|undefined;
  try{
    await assert.rejects(c.connect(),/CODEX_NOT_INSTALLED/);assert.equal(store.unresolvedNativeConnections(),false);
    next=new Controller(store,workspace,()=>new ObservedRpc('later-installed'));assert.equal(next.snapshot().soloRecoveryRequired,false);
  }finally{await next?.close();await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('an unclassified factory failure quarantines the same manager before another attempt',async()=>{
  let calls=0;const {root,c,store}=setup(()=>{calls++;throw new Error('FACTORY_UNCERTAIN');});
  try{
    await assert.rejects(c.connect(),/CONNECTION_FAILED/);assert.equal(c.snapshot().soloRecoveryRequired,true);
    await assert.rejects(c.connect(),/SOLO_RECOVERY_REQUIRED/);assert.equal(calls,1);assert.equal(store.unresolvedNativeConnections(),true);
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('a trusted refusal before spawning records absence and permits a later connection',async()=>{
  let calls=0;const {root,c,store}=setup(()=>{if(++calls===1)throw new NativeLaunchNotStarted('LAUNCH_REJECTED_BEFORE_SPAWN');return new ObservedRpc('allowed');});
  try{
    await assert.rejects(c.connect(),/CONNECTION_FAILED/);assert.equal(c.snapshot().soloRecoveryRequired,false);
    const row=store.db.prepare('SELECT owner_incarnation,generation FROM native_connections').get()!;
    const refused=store.nativeConnection(String(row.owner_incarnation),Number(row.generation));
    assert.equal(refused?.notCreatedReason,'LAUNCH_REJECTED_BEFORE_SPAWN');assert.equal(refused?.process,null);assert.equal(refused?.journalState,'closed');
    assert.equal(store.unresolvedNativeConnections(),false);await c.connect();assert.equal(calls,2);assert.equal(c.snapshot().provider,'ready');
  }finally{await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('actual owned Node child close is durably bound through Rpc, Controller and Run across restart',{timeout:10000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-native-child-journal-')),path=join(root,'fixture.sqlite');let store=new Store(path);
  const script=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const e=JSON.parse(line);if(e.id===undefined)return;let result={};
    if(e.method==='account/read')result={account:{type:'chatgpt'}};
    if(e.method==='config/read')result={config:{mcp_servers:{}}};
    if(e.method==='thread/start')result={thread:{id:'actual-child-session',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(e.method==='mcpServerStatus/list')result={data:[]};
    if(e.method==='turn/start')result={turn:{id:'actual-child-turn'}};
    process.stdout.write(JSON.stringify({id:e.id,result})+'\\n');
    if(e.method==='turn/start')process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'actual-child-session',turn:{id:'actual-child-turn',status:'completed'}}})+'\\n');
  });`;
  const c=new Controller(store,createWorkspace(root),()=>new Rpc(process.execPath,['-e',script],root));
  let closed=false;
  try{
    await c.connect();const finished=new Promise<void>(resolve=>{store.on('event',event=>{if(event.kind==='run.completed')resolve();});});
    const run=await c.submit({requestId:'actual-process-fixture',prompt:'Fixture'});await finished;
    assert.equal(store.getRun(run.id)?.execution,'completed');const before=store.soloOperation(run.id);
    assert.equal(before.connection?.process?.state,'running');assert.ok(before.connection!.process!.pid!>0);
    await c.close();closed=true;const after=store.soloOperation(run.id);assert.equal(after.connection?.process?.state,'closed');assert.equal(after.connection?.process?.exitCode,0);
    assert.equal(after.record?.execution,'completed');assert.equal(after.connection?.process?.handleId,before.connection?.process?.handleId);
    assert.equal(JSON.stringify(after).includes(process.execPath),false);
    store.close();store=new Store(path);assert.deepEqual(store.soloOperation(run.id),after);
  }finally{if(!closed)await c.close();store.close();rmSync(root,{recursive:true,force:true});}
});
