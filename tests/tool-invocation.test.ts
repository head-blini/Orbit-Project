import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {ToolPermissionStore} from '../server/tool-permissions.ts';
import {ToolInvocationService} from '../server/tool-invocation.ts';
import {itemDigest} from '../server/tool-capability-ledger.ts';
import type {ToolItemMeta,ToolKey} from '../shared/tool-capabilities.ts';
import type {ToolLaunchResult} from '../shared/tool-invocation.ts';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const key:ToolKey={runtimeId:'codex',kind:'mcp',itemId:hash('fixture')};
const selection={projectId:'p1',taskId:'t1',...key};
const original:ToolItemMeta={kind:'mcp',id:key.itemId,scope:'thread',handlerType:null,nativeTrust:'unknown',pluginOwned:false,runtimeVersion:'1',adapterRevision:'1'};
function fixture(path=':memory:'){
  const store=new Store(path),grants=new ToolPermissionStore(store);
  const state={meta:{...original} as ToolItemMeta|null,planning:hash('plan') as string|null,calls:0,result:{status:'completed',evidenceSource:'mock'} as ToolLaunchResult};
  const ports={grants,discovery:()=>state.meta,planningContentHash:()=>state.planning,launch:{invoke:async()=>{state.calls++;return state.result;}}};
  const service=new ToolInvocationService(store,ports);
  const grant=(requestId='grant1')=>grants.grant({requestId,projectId:'p1',taskId:'t1',key,itemDigest:itemDigest(state.meta!),confirmed:true});
  const approved=()=>{const p=service.preview(selection);return {requestId:'invoke1',previewId:p.previewId,expectedDigest:p.digest,confirmed:true as const};};
  return {store,grants,state,ports,service,grant,approved};
}

test('preview binds exact D1 digest; intent and consumed grant precede launch',async()=>{
  const f=fixture();try{
    const g=f.grant(),input=f.approved();
    assert.equal(input.expectedDigest,hash(JSON.stringify(['p1','t1','codex','mcp',key.itemId,itemDigest(original),g.grantId,f.state.planning])));
    f.ports.launch.invoke=async()=>{
      f.state.calls++;
      assert.equal(f.grants.validFor(key,itemDigest(original),'p1','t1'),null);
      const row=f.store.db.prepare('SELECT body FROM tool_invocations').get()!;
      assert.equal(JSON.parse(String(row.body)).status,'unknown');
      return f.state.result;
    };
    const result=await f.service.invoke(input);
    assert.equal(result.status,'completed');assert.equal(result.evidenceSource,'mock');assert.equal(f.state.calls,1);
    assert.deepEqual(await f.service.invoke(input),result);assert.equal(f.state.calls,1);
    await assert.rejects(f.service.invoke({...input,expectedDigest:hash('other')}),/IDEMPOTENCY_CONFLICT/);
  }finally{f.store.close();}
});

for(const change of ['planning','metadata','grant','expected'] as const)test(`invoke refuses changed ${change}`,async()=>{
  const f=fixture();try{
    const g=f.grant(),input=f.approved();
    if(change==='planning')f.state.planning=hash('new');
    if(change==='metadata')f.state.meta!.adapterRevision='2';
    if(change==='grant'){f.grants.revoke(g.grantId);f.grant('grant2');}
    if(change==='expected')input.expectedDigest=hash('wrong');
    await assert.rejects(f.service.invoke(input),/ROUTE_CHANGED/);assert.equal(f.state.calls,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM tool_invocations').get()!.n,0);
  }finally{f.store.close();}
});

for(const state of ['missing','used','revoked'] as const)test(`preview refuses ${state} grant`,()=>{
  const f=fixture();try{
    if(state!=='missing'){const g=f.grant();if(state==='revoked')f.grants.revoke(g.grantId);else f.grants.consume(g.grantId,{projectId:'p1',taskId:'t1',key,itemDigest:itemDigest(original)});}
    assert.throws(()=>f.service.preview(selection),/TOOL_GRANT_REQUIRED/);assert.equal(f.state.calls,0);
  }finally{f.store.close();}
});

test('current discovery required at preview and invocation; wrong item fails closed',async()=>{
  const f=fixture();try{
    f.grant();const input=f.approved();f.state.meta=null;
    assert.throws(()=>f.service.preview(selection),/TOOL_ITEM_NOT_FOUND/);
    await assert.rejects(f.service.invoke(input),/ROUTE_CHANGED/);
    f.state.meta={...original,id:hash('other')};assert.throws(()=>f.service.preview(selection),/TOOL_ITEM_NOT_FOUND/);
    assert.equal(f.state.calls,0);
  }finally{f.store.close();}
});

test('only Codex MCP allowed; no grant inferred across tasks/projects',()=>{
  const f=fixture();try{
    f.grant();
    for(const kind of ['skill','plugin','hook','subagent','slash_command'])assert.throws(()=>f.service.preview({...selection,kind}),/TOOL_NOT_GRANTABLE/);
    assert.throws(()=>f.service.preview({...selection,runtimeId:'claude-code'}),/TOOL_NOT_GRANTABLE/);
    assert.throws(()=>f.service.preview({...selection,taskId:'t2'}),/TOOL_GRANT_REQUIRED/);
    assert.throws(()=>f.service.preview({...selection,projectId:'p2'}),/TOOL_GRANT_REQUIRED/);
  }finally{f.store.close();}
});

test('exact input, confirmation and planning baseline required',async()=>{
  const f=fixture();try{
    f.grant();const input=f.approved();
    await assert.rejects(f.service.invoke({...input,confirmed:false}),/APPROVAL_REQUIRED/);
    await assert.rejects(f.service.invoke({...input,command:'x'}),/INVALID_FIELDS/);
    assert.throws(()=>f.service.preview({...selection,itemId:'/tmp/mcp'}),/INVALID_FIELDS/);
    const getter={...selection};Object.defineProperty(getter,'taskId',{get:()=>{throw Error('getter executed');}});
    assert.throws(()=>f.service.preview(getter),/INVALID_FIELDS/);
    f.state.planning=null;assert.throws(()=>f.service.preview(selection),/PLANNING_BASELINE_REQUIRED/);
    assert.equal(f.state.calls,0);
  }finally{f.store.close();}
});

for(const outcome of ['unknown','throws'] as const)test(`${outcome} is durable and never retried`,async()=>{
  const f=fixture();try{
    f.grant();const input=f.approved();f.state.result={status:'unknown',evidenceSource:'unknown'};
    if(outcome==='throws')f.ports.launch.invoke=async()=>{f.state.calls++;throw Error('private provider output');};
    const result=await f.service.invoke(input);assert.equal(result.status,'unknown');
    assert.deepEqual(await new ToolInvocationService(f.store,f.ports).invoke(input),result);
    assert.equal(f.state.calls,1);assert.ok(!JSON.stringify(result).includes('private provider output'));
  }finally{f.store.close();}
});

test('pending concurrent replay returns unknown and launches once',async()=>{
  const f=fixture();try{
    f.grant();const input=f.approved();let finish!:(r:ToolLaunchResult)=>void;
    f.ports.launch.invoke=()=>{f.state.calls++;return new Promise(resolve=>{finish=resolve;});};
    const pending=f.service.invoke(input);assert.equal((await f.service.invoke(input)).status,'unknown');
    finish(f.state.result);await pending;assert.equal(f.state.calls,1);
    await assert.rejects(f.service.invoke({...input,requestId:'invoke2'}),/ROUTE_CHANGED/);
  }finally{f.store.close();}
});

test('intent insert failure rolls back grant consumption and audit',async()=>{
  const f=fixture();try{
    const g=f.grant(),input=f.approved(),seq=f.store.lastSeq();
    f.store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON tool_invocations BEGIN SELECT RAISE(ABORT,'fault'); END");
    await assert.rejects(f.service.invoke(input),/fault/);
    assert.equal(f.grants.validFor(key,itemDigest(original),'p1','t1')!.grantId,g.grantId);
    assert.equal(f.store.lastSeq(),seq);assert.equal(f.state.calls,0);
  }finally{f.store.close();}
});

test('crash after durable intent, before launch: restart stays unknown with zero calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-tool-invoke-')),path=join(dir,'test.db');
  const f=fixture(path);let reopened:Store|undefined;
  try{
    f.grant();const input=f.approved(),transaction=f.store.transaction.bind(f.store);
    f.store.transaction=(work)=>{const result=transaction(work);throw Error('crash after commit');return result;};
    await assert.rejects(f.service.invoke(input),/crash after commit/);assert.equal(f.state.calls,0);f.store.close();
    reopened=new Store(path);const grants=new ToolPermissionStore(reopened);
    const service=new ToolInvocationService(reopened,{...f.ports,grants});
    const result=await service.invoke(input);assert.equal(result.status,'unknown');assert.equal(f.state.calls,0);
    assert.equal(grants.validFor(key,itemDigest(original),'p1','t1'),null);
    assert.deepEqual(await service.invoke(input),result);
  }finally{if(reopened)reopened.close();rmSync(dir,{recursive:true,force:true});}
});

for(const state of ['used','revoked'] as const)test(`grant ${state} after preview prevents invocation`,async()=>{
  const f=fixture();try{
    const g=f.grant(),input=f.approved();
    if(state==='revoked')f.grants.revoke(g.grantId);
    else f.grants.consume(g.grantId,{projectId:'p1',taskId:'t1',key,itemDigest:itemDigest(original)});
    await assert.rejects(f.service.invoke(input),/ROUTE_CHANGED/);assert.equal(f.state.calls,0);
  }finally{f.store.close();}
});

test('grant lookup cannot authorize a grant absent from the intent database',async()=>{
  const f=fixture();try{
    const grant={grantId:'tg_absent',key,itemDigest:itemDigest(original)};
    const service=new ToolInvocationService(f.store,{...f.ports,grants:{validFor:()=>grant}});
    const preview=service.preview(selection);
    await assert.rejects(service.invoke({requestId:'invoke1',previewId:preview.previewId,expectedDigest:preview.digest,confirmed:true}),/ROUTE_CHANGED/);
    assert.equal(f.state.calls,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM tool_invocations').get()!.n,0);
  }finally{f.store.close();}
});

test('preview survives restart and completed request replays without a launch',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-tool-preview-')),path=join(dir,'test.db');
  const f=fixture(path);let reopened:Store|undefined;
  try{
    f.grant();const input=f.approved();f.store.close();
    reopened=new Store(path);let service=new ToolInvocationService(reopened,{...f.ports,grants:new ToolPermissionStore(reopened)});
    const result=await service.invoke(input);assert.equal(result.status,'completed');reopened.close();
    reopened=new Store(path);service=new ToolInvocationService(reopened,{...f.ports,grants:new ToolPermissionStore(reopened)});
    assert.deepEqual(await service.invoke(input),result);assert.equal(f.state.calls,1);
  }finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}
});
