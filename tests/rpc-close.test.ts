import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Rpc} from '../server/rpc.ts';

test('a failed kill signal does not prove the RPC child stopped', {timeout:10000}, async()=>{
  const rpc=new Rpc(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000);'],process.cwd());
  const child=rpc.child,originalKill=child.kill;
  const actualClose=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  let closeEvents=0,notifications=0,closeSettled=false,closing:Promise<void>|undefined;
  rpc.on('closed',()=>{closeEvents++;});
  rpc.on('notification',()=>{notifications++;});
  try{
    await once(child,'spawn');
    let signalAttempted!:()=>void;
    const attempted=new Promise<void>(resolve=>{signalAttempted=resolve;});
    // Fault injection at the OS signal boundary; the owned child remains real
    // and alive until cleanup delivers an actual successful signal.
    child.kill=()=>{child.emit('error',new Error('SYNTHETIC_SIGNAL_FAILURE'));signalAttempted();return false;};
    const rejected=assert.rejects(rpc.request('fixture',{}),{message:'TRANSPORT_CLOSED'});
    closing=rpc.close().then(()=>{closeSettled=true;});
    await attempted;await rejected;await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    assert.doesNotThrow(()=>process.kill(child.pid!,0));
    assert.equal(closeEvents,0,'a process error must not emit confirmed closure');
    assert.equal(closeSettled,false,'close must wait for the actual process close event');
    await assert.rejects(rpc.request('after-error',{}),{message:'TRANSPORT_CLOSED'});
    child.stdout.emit('data',JSON.stringify({method:'after-error',params:{}})+'\n');
    assert.equal(notifications,0,'a failed transport must stop publishing stdout');
  }finally{
    child.kill=originalKill;
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await actualClose;await closing;
  }
  assert.equal(closeEvents,1);assert.equal(closeSettled,true);
});

test('closing after a spawned process error still requests graceful stdin shutdown', {timeout:10000}, async()=>{
  const rpc=new Rpc(process.execPath,['-e','process.stdin.resume();'],process.cwd());
  const child=rpc.child,actualClose=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  let closeEvents=0;rpc.on('closed',()=>{closeEvents++;});
  try{
    await once(child,'spawn');
    const rejected=assert.rejects(rpc.request('fixture',{}),{message:'TRANSPORT_CLOSED'});
    child.emit('error',new Error('SYNTHETIC_PROCESS_ERROR'));await rejected;
    assert.equal(closeEvents,0);
    await rpc.close();
    assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(closeEvents,1);
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await actualClose;
  }
});

test('a process that never spawned rejects requests and closes exactly once', {timeout:10000}, async()=>{
  const rpc=new Rpc(join(process.cwd(),'missing-rpc-fixture-'+randomUUID()),[],process.cwd());
  const actualClose=new Promise<void>(resolve=>rpc.child.once('close',()=>resolve()));
  let closeEvents=0;rpc.on('closed',()=>{closeEvents++;});
  await assert.rejects(rpc.request('fixture',{}),{message:'TRANSPORT_CLOSED'});
  await rpc.close();await rpc.close();await actualClose;
  assert.equal(rpc.child.pid,undefined);assert.equal(closeEvents,1);
});
