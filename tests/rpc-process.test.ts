import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Rpc} from '../server/rpc.ts';
import type {NativeProcessObservation} from '../shared/native-process.ts';

test('owned process observations bind spawn and actual close before transport closure without exposing launch data', {timeout:10000}, async()=>{
  const rpc=new Rpc(process.execPath,['-e','process.stdin.resume();'],process.cwd());
  const actualClose=new Promise<void>(resolve=>rpc.child.once('close',()=>resolve()));
  const observed:NativeProcessObservation[]=[],order:string[]=[];
  rpc.on('process.observed',(value:NativeProcessObservation)=>{observed.push({...value});order.push(value.state);value.state='spawn_failed';});
  try{
    assert.equal(typeof rpc.processObservation,'function');
    rpc.on('closed',()=>{order.push('transport.closed');assert.equal(rpc.processObservation().state,'closed');});
    const pending=rpc.processObservation();
    assert.equal(pending.state,'spawn_pending');assert.equal(pending.pid,null);
    assert.match(pending.handleId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(Number.isFinite(Date.parse(pending.createdAt)),true);
    assert.deepEqual(Object.keys(pending).sort(),['handleId','pid','createdAt','state','closedAt','exitCode','signal'].sort());
    pending.handleId='changed-by-reader';
    await once(rpc.child,'spawn');
    const running=rpc.processObservation();
    assert.equal(running.state,'running');assert.equal(running.pid,rpc.child.pid);assert.equal(running.closedAt,null);
    assert.notEqual(running.handleId,pending.handleId);assert.equal(running.createdAt,pending.createdAt);
    await rpc.close();await actualClose;
    const closed=rpc.processObservation();
    assert.equal(closed.state,'closed');assert.equal(closed.handleId,running.handleId);assert.equal(closed.pid,running.pid);
    assert.equal(closed.exitCode,0);assert.equal(closed.signal,null);assert.equal(Number.isFinite(Date.parse(closed.closedAt!)),true);
    assert.deepEqual(order,['running','closed','transport.closed']);
    assert.deepEqual(observed.map(item=>item.state),['running','closed']);
    assert.equal(observed[1].handleId,running.handleId);
  }finally{
    if(rpc.child.exitCode===null&&rpc.child.signalCode===null)rpc.child.kill('SIGKILL');
    await actualClose;await rpc.close();
  }
});

test('a no-PID spawn failure is a distinct terminal observation published only once', {timeout:10000}, async()=>{
  const rpc=new Rpc(join(process.cwd(),'missing-process-fixture-'+randomUUID()),[],process.cwd());
  const actualClose=new Promise<void>(resolve=>rpc.child.once('close',()=>resolve()));
  const observed:NativeProcessObservation[]=[];
  rpc.on('process.observed',(value:NativeProcessObservation)=>observed.push(value));
  try{
    assert.equal(typeof rpc.processObservation,'function');
    const pending=rpc.processObservation();assert.equal(pending.state,'spawn_pending');
    await rpc.close();await actualClose;await rpc.close();
    const failed=rpc.processObservation();
    assert.equal(failed.state,'spawn_failed');assert.equal(failed.pid,null);assert.equal(failed.handleId,pending.handleId);
    assert.equal(failed.exitCode,null);assert.equal(failed.signal,null);assert.equal(Number.isFinite(Date.parse(failed.closedAt!)),true);
    assert.deepEqual(observed,[failed]);
  }finally{await actualClose;await rpc.close();}
});

test('stdout EOF, a signal request and a spawned-process error are not process-close observations', {timeout:10000}, async()=>{
  const rpc=new Rpc(process.execPath,['-e',"process.stdout.end(JSON.stringify({method:'fixture/ready',params:{}})+'\\n');process.stdin.resume();setInterval(()=>{},1000);"],process.cwd());
  const child=rpc.child,originalKill=child.kill;
  const actualClose=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  const eof=new Promise<void>(resolve=>child.stdout.once('end',()=>resolve()));
  const observed:NativeProcessObservation[]=[];rpc.on('process.observed',(value:NativeProcessObservation)=>observed.push(value));
  let closing:Promise<void>|undefined;
  try{
    assert.equal(typeof rpc.processObservation,'function');
    await eof;assert.equal(rpc.processObservation().state,'running');
    let signalAttempted!:()=>void;const attempted=new Promise<void>(resolve=>{signalAttempted=resolve;});
    child.kill=()=>{signalAttempted();return false;};
    closing=rpc.close();await attempted;
    assert.equal(rpc.processObservation().state,'running');assert.equal(rpc.processObservation().closedAt,null);
    child.emit('error',new Error('SYNTHETIC_SIGNAL_FAILURE'));
    assert.equal(rpc.processObservation().state,'running');assert.deepEqual(observed.map(item=>item.state),['running']);
  }finally{
    child.kill=originalKill;
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await actualClose;await closing;await rpc.close();
  }
  assert.equal(rpc.processObservation().state,'closed');assert.deepEqual(observed.map(item=>item.state),['running','closed']);
});
