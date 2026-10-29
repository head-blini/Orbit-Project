import {toolFixture} from './tool-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readRecordedToolInvocations} from '../server/tool-evidence.ts';
import {toolInvocationVerified} from '../server/tool-capability-ledger.ts';
import {AppError} from '../server/errors.ts';
for(const source of ['native','mock','unknown'] as const)test(`real controller launch profile with fake ${source} transport`,async()=>{
  const f=await toolFixture(source);try{
    const preview=f.controller.toolInvocations.previewApproval(f.selection);
    const approval=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:preview.previewId,expectedDigest:preview.digest,confirmed:true});
    const input={requestId:randomUUID(),previewId:approval.previewId,expectedDigest:approval.digest,confirmed:true};
    const result=await f.controller.toolInvocations.invoke(input);
    assert.equal(f.rpc.starts,1);assert.deepEqual(await f.controller.toolInvocations.invoke(input),result);assert.equal(f.rpc.starts,1);
    const enabled=f.rpc.sent.filter(r=>r.method==='thread/resume').at(-1)!.params;
    assert.deepEqual(enabled.config.mcp_servers,{fixture:{enabled:true},other:{enabled:false}});
    assert.equal(enabled.sandbox,'workspace-write');assert.equal(enabled.config.sandbox_workspace_write.network_access,false);assert.equal(enabled.approvalPolicy,'on-request');
    const run=f.store.runs()[0],rows=readRecordedToolInvocations(f.store,run);
    assert.equal(run.projectId,f.selection.projectId);assert.equal(run.taskId,f.selection.taskId);assert.equal(run.runtime,'codex');
    assert.equal(rows.length,1);assert.equal(toolInvocationVerified(rows[0],rows[0].grant),source==='native');
    assert.equal(f.rpc.closed,true);
    assert.ok(!JSON.stringify(f.store.eventsAfter(0)).includes('never stored'));
  }finally{await f.close();}
});
test('unknown transport outcome is durable, never retried',async()=>{
  const f=await toolFixture();try{
    f.rpc.complete=false;
    const p=f.controller.toolInvocations.previewApproval(f.selection),a=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true});
    const input={requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true};
    const r=await f.controller.toolInvocations.invoke(input);assert.equal(r.status,'unknown');
    assert.deepEqual(await f.controller.toolInvocations.invoke(input),r);assert.equal(f.rpc.starts,1);
  }finally{await f.close();}
});

test('recorded journal requires its exact consumed grant, approval and completed call',async()=>{
  const f=await toolFixture();try{
    const p=f.controller.toolInvocations.previewApproval(f.selection),a=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true});
    const r=await f.controller.toolInvocations.invoke({requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true}),run=f.store.runs()[0];
    const verified=()=>readRecordedToolInvocations(f.store,run).some(row=>toolInvocationVerified(row,row.grant));
    assert.equal(verified(),true);
    f.store.db.prepare('UPDATE tool_grant_consumptions SET invocation_id=?').run('other');assert.equal(verified(),false);
    f.store.db.prepare('UPDATE tool_grant_consumptions SET invocation_id=?,approval_digest=?').run(r.invocationId,'other');assert.equal(verified(),false);
    f.store.db.prepare('UPDATE tool_grant_consumptions SET approval_digest=?').run(r.digest);
    f.store.db.prepare("UPDATE tool_grants SET state='revoked'").run();assert.equal(verified(),false);
    f.store.db.prepare("UPDATE tool_grants SET state='used'").run();assert.equal(verified(),true);
    const event=f.store.eventsAfter(0).find(e=>e.kind==='item/completed')!;
    f.store.append('item/completed',run.id,{...event.data,item:{...(event.data.item as object),tool:'other'}});assert.equal(verified(),false);
    f.store.db.prepare("DELETE FROM events WHERE kind='item/completed'").run();assert.equal(verified(),false);
    const rows=readRecordedToolInvocations(f.store,run);assert.equal(rows[0].evidenceSource,'unknown');
    const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;readRecordedToolInvocations(f.store,run);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{await f.close();}
});

test('unapproved enabled server prevents turn dispatch and cannot be retried',async()=>{
  const f=await toolFixture();try{
    const p=f.controller.toolInvocations.previewApproval(f.selection),a=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true});
    const original=f.rpc.request.bind(f.rpc);
    f.rpc.request=async(method,params)=>{
      const result=await original(method,params);
      if(method==='mcpServerStatus/list'&&f.rpc.enabled)result.data[1].runtimeStatus='ready';
      return result;
    };
    const input={requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true};
    const result=await f.controller.toolInvocations.invoke(input);
    assert.equal(result.status,'unknown');assert.equal(f.rpc.starts,0);
    assert.deepEqual(await f.controller.toolInvocations.invoke(input),result);assert.equal(f.rpc.starts,0);
    assert.equal(readRecordedToolInvocations(f.store,f.store.runs()[0])[0].evidenceSource,'unknown');
  }finally{await f.close();}
});

import {ProjectProgressService,defaultCompletionPolicy} from '../server/project-progress.ts';
import {Studio} from '../server/studio.ts';
test('progress completion reads persisted tool evidence without writing or claiming overall completion',async()=>{
  const f=await toolFixture();try{
    const p=f.controller.toolInvocations.previewApproval(f.selection),a=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true});
    await f.controller.toolInvocations.invoke({requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true});
    const key={runtimeId:'codex' as const,kind:'mcp' as const,itemId:f.selection.itemId};
    const progress=new ProjectProgressService(f.store,new Studio(f.store),{policy:()=>({...defaultCompletionPolicy('code'),requiredTools:[key]})});
    const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const completion=progress.read(f.project.id,{}).tasks[0].completion!;
    assert.equal(completion.tools?.[0].status,'passed');assert.equal(completion.verifiedDone,false);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{await f.close();}
});

test('next execution stays fenced until the tool session shutdown is observed',async()=>{
  const f=await toolFixture();let release:()=>void=()=>{};
  try{
    const close=f.rpc.close.bind(f.rpc);
    f.rpc.close=()=>new Promise<void>(resolve=>{release=()=>{void close().then(resolve);};});
    const p=f.controller.toolInvocations.previewApproval(f.selection),a=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true});
    await f.controller.toolInvocations.invoke({requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true});
    await assert.rejects(f.controller.connect(),/SESSION_BUSY/);release();
  }finally{release();await f.close();}
});

function deferred(){
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

for(const outcome of ['completed','failed','interrupted','timeout','transport failure','interrupt failure','launch refused','lost','shutdown'] as const)
  test(`tool ${outcome} clears its marker and fences execution until close completes`,async(t)=>{
    const f=await toolFixture();
    const closed=deferred();
    const closing=deferred();
    const started=deferred();
    const close=f.rpc.close.bind(f.rpc),request=f.rpc.request.bind(f.rpc);
    let terminalAction:Promise<unknown>|undefined;
    try{
      f.rpc.close=async()=>{closing.resolve();await closed.promise;await close();};
      f.rpc.request=async(method,params)=>{
        if(method==='config/read'&&outcome==='launch refused'){started.resolve();throw new AppError('LAUNCH_CONTEXT_CHANGED');}
        if(method==='turn/start'){
          started.resolve();
          if(outcome==='transport failure')throw new Error('fixture transport failure');
          return {turn:{id:'turn-fixture'}};
        }
        if(method==='turn/interrupt'&&outcome==='interrupt failure')throw new Error('fixture interrupt failure');
        return request(method,params);
      };
      t.mock.timers.enable({apis:['setTimeout']});
      const p=f.controller.toolInvocations.previewApproval(f.selection),a=f.controller.toolInvocations.approve({requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true});
      const invocation=f.controller.toolInvocations.invoke({requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true});
      await started.promise;
      await new Promise<void>(resolve=>setImmediate(resolve));
      const run=f.store.runs()[0];
      if(outcome==='timeout')t.mock.timers.tick(120000);
      else if(outcome==='interrupt failure')terminalAction=assert.rejects(f.controller.interrupt(run.id),/INTERRUPT_UNCERTAIN/);
      else if(outcome==='lost')f.rpc.emit('closed');
      else if(outcome==='shutdown')terminalAction=f.controller.close();
      else if(outcome!=='transport failure'&&outcome!=='launch refused'){
        if(outcome==='interrupted')await f.controller.interrupt(run.id);
        f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:outcome}}});
      }
      // A native close event already observes transport closure; the other paths must await close().
      if(outcome!=='lost')await closing.promise;
      assert.equal(f.controller['toolRun'],null);
      assert.equal(f.controller['launchValidated'],false);
      assert.equal(f.controller['deadline'],null);
      if(outcome!=='lost'){
        await assert.rejects(f.controller.connect(),/SESSION_BUSY/);
        await assert.rejects(f.controller.submit({requestId:randomUUID(),prompt:'Next run',workspaceId:f.workspace.id}),/SESSION_BUSY/);
      }
      const expected=outcome==='launch refused'?'failed':['completed','failed','interrupted'].includes(outcome)?outcome:'lost';
      assert.equal(f.store.getRun(run.id)!.execution,expected);
      if(outcome==='timeout')assert.ok(f.store.eventsAfter(0).some(e=>e.kind==='provider.status'&&e.data.issue==='RUN_TIMEOUT'));
      closed.resolve();await terminalAction;await invocation;await f.controller['toolClosing'];
      assert.equal(f.controller['toolClosing'],null);
      if(expected==='lost')assert.throws(()=>f.controller.assertExecutionAvailable(),/SOLO_RECOVERY_REQUIRED/);
      else assert.doesNotThrow(()=>f.controller.assertExecutionAvailable());
    }finally{closed.resolve();t.mock.timers.reset();await terminalAction;await f.close();}
  });
