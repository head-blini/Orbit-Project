import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {Store} from '../server/store.ts';
import {ParallelWorkerService} from '../server/parallel-workers.ts';
import type {WorkerReserveInput,WorkerReservation} from '../shared/parallel-workers.ts';

function input(id='a',runtimeId='claude-code'):WorkerReserveInput {
  return {requestId:'request-'+id,ownerIncarnation:'owner-'+id,
    batch:{id:'batch-'+id,projectId:'project',planningVersionId:'plan',graphRevision:1,planningHash:'a'.repeat(64),taskIds:[id],contractDigests:[{id:'contract',digest:'digest'}],inputArtifactHashes:[{id:'artifact',hash:'b'.repeat(64)}],runtimeChoices:[{taskId:id,runtimeId}],parallelLimit:2},
    attempt:{id:'attempt-'+id,taskId:id,runtimeId,dispatchRequestId:'dispatch-'+id},
    claims:[{kind:'external_target',targetKey:'target-'+id}]};
}
function fixture(t:test.TestContext){const store=new Store(':memory:');t.after(()=>store.close());return {store,service:new ParallelWorkerService(store)};}
const evidence=(r:WorkerReservation,kind:'terminal_confirmed'|'not_dispatched')=>({kind,dispatchRequestId:r.attempt.dispatchRequestId,evidenceId:'receipt-1'});

test('reservation durably binds approval, attempt, claims and intent; request replay is idempotent',t=>{
  const {store,service}=fixture(t),i=input(),r=service.reserve(i);
  assert.equal(r.state,'reserved');assert.deepEqual(r.batch,i.batch);assert.deepEqual(r.attempt,i.attempt);
  assert.deepEqual(service.reserve(i),r);assert.equal(service.list().length,1);
  assert.equal(store.eventsAfter(0).filter(e=>e.kind==='worker.reserved').length,1);
  const changed=structuredClone(i);changed.batch.graphRevision++;
  assert.throws(()=>service.reserve(changed),/IDEMPOTENCY_CONFLICT/);
  r.batch.taskIds.length=0;assert.deepEqual(service.read(r.reservationId).batch,i.batch);
});
test('conflicting claims roll back the whole attempt and every claim',t=>{
  const {service}=fixture(t),a=input(),b=input('b');service.reserve(a);
  b.claims.push(...a.claims);assert.throws(()=>service.reserve(b),/RESOURCE_CONFLICT/);
  assert.equal(service.list().length,1);
  const c=input('c');c.claims=[b.claims[0]];assert.equal(service.reserve(c).state,'reserved');
});
test('global, per-runtime and approved batch limits are enforced',t=>{
  const {service}=fixture(t);service.reserve(input('a','codex'));
  assert.throws(()=>service.reserve(input('b','codex')),/RUNTIME_LIMIT/);
  service.reserve(input('c'));assert.throws(()=>service.reserve(input('d')),/TOTAL_LIMIT/);
  const {service:other}=fixture(t),a=input('e'),b=input('f');
  a.batch.taskIds.push('f');a.batch.runtimeChoices.push({taskId:'f',runtimeId:'claude-code'});a.batch.parallelLimit=1;b.batch=structuredClone(a.batch);
  other.reserve(a);assert.throws(()=>other.reserve(b),/BATCH_LIMIT/);
});
test('same task has one owner even with disjoint claims and distinct attempts',t=>{
  const {service}=fixture(t),a=input(),b=input('b');service.reserve(a);
  b.attempt.taskId='a';b.batch.taskIds=['a'];b.batch.runtimeChoices=[{taskId:'a',runtimeId:'claude-code'}];
  assert.throws(()=>service.reserve(b),/TASK_RESERVED/);
});
test('intent persistence failure leaves no batch, attempt, claim or event',t=>{
  const {store,service}=fixture(t);
  store.db.exec("CREATE TRIGGER fail_worker_intent BEFORE INSERT ON events WHEN NEW.kind='worker.reserved' BEGIN SELECT RAISE(ABORT,'intent failed'); END");
  assert.throws(()=>service.reserve(input()),/intent failed/);assert.deepEqual(service.list(),[]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM worker_batches').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM worker_claims').get()!.n,0);
  assert.equal(store.lastSeq(),0);store.db.exec('DROP TRIGGER fail_worker_intent');assert.equal(service.reserve(input()).state,'reserved');
});
test('release requires bound termination evidence or proven reserved non-dispatch',t=>{
  const {service}=fixture(t),r=service.reserve(input());
  assert.throws(()=>service.release(r),/RELEASE_EVIDENCE/);
  assert.throws(()=>service.release(r,{...evidence(r,'not_dispatched'),dispatchRequestId:'other'}),/RELEASE_EVIDENCE/);
  assert.equal(service.release(r,evidence(r,'not_dispatched')).state,'released');
  const b=service.reserve(input('b'));service.transition(b,'dispatched');
  assert.throws(()=>service.release(b,evidence(b,'not_dispatched')),/RELEASE_EVIDENCE/);
  service.transition(b,'running');service.confirmTerminal(b,evidence(b,'terminal_confirmed'));
  assert.equal(service.read(b.reservationId).state,'terminal_confirmed');
  assert.equal(service.release(b).state,'released');
});
test('lost retains claims and slots until termination is confirmed',t=>{
  const {service}=fixture(t),a=input('a','codex'),r=service.reserve(a);service.transition(r,'dispatched');service.transition(r,'lost_unknown');
  const b=input('b');b.claims=a.claims;assert.throws(()=>service.reserve(b),/RESOURCE_CONFLICT/);
  assert.throws(()=>service.reserve(input('c','codex')),/RUNTIME_LIMIT/);
  assert.throws(()=>service.release(r,evidence(r,'not_dispatched')),/RELEASE_EVIDENCE/);
  assert.throws(()=>service.transition(r,'running'),/INVALID_TRANSITION/);
  service.confirmTerminal(r,evidence(r,'terminal_confirmed'));assert.throws(()=>service.reserve(b),/RESOURCE_CONFLICT/);
  service.release(r);assert.equal(service.reserve(b).state,'reserved');
});
test('explicit ownership transfer fences late updates and never releases claims',t=>{
  const {service}=fixture(t),r=service.reserve(input()),next=service.transfer(r,'replacement');
  assert.ok(next.fencingGeneration>r.fencingGeneration);assert.equal(next.state,'reserved');
  assert.throws(()=>service.transition(r,'dispatched'),/FENCE_STALE/);
  assert.throws(()=>service.release(r,evidence(r,'not_dispatched')),/FENCE_STALE/);
  assert.throws(()=>service.transfer(r,'third'),/FENCE_STALE/);
  assert.equal(service.transition(next,'dispatched').state,'dispatched');
});
test('restart preserves reserved, dispatched, running and lost without event or redispatch',()=>{
  for(const state of ['reserved','dispatched','running','lost_unknown'] as const){
    const root=mkdtempSync(join(tmpdir(),'orbit-worker-restart-')),path=join(root,'test.db');let store=new Store(path);
    try{
      let service=new ParallelWorkerService(store);const i=input(),r=service.reserve(i);
      if(state!=='reserved')service.transition(r,'dispatched');if(state==='running'||state==='lost_unknown')service.transition(r,state);
      const before=service.read(r.reservationId),seq=store.lastSeq();store.close();store=new Store(path);service=new ParallelWorkerService(store);
      assert.deepEqual(service.read(r.reservationId),before);assert.deepEqual(service.reserve(i),before);assert.equal(store.lastSeq(),seq);
      const b=input('b');b.claims=i.claims;assert.throws(()=>service.reserve(b),/RESOURCE_CONFLICT/);
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  }
});
test('malformed batches, claims, runtime choices and immutable batch reuse fail closed',t=>{
  const {service}=fixture(t);
  for(const mutate of [(i:WorkerReserveInput)=>i.batch.taskIds.push('a'),(i:WorkerReserveInput)=>i.batch.graphRevision=0,(i:WorkerReserveInput)=>i.batch.parallelLimit=3,(i:WorkerReserveInput)=>i.attempt.runtimeId='unknown',(i:WorkerReserveInput)=>i.claims=[],(i:WorkerReserveInput)=>i.batch.runtimeChoices=[]]){
    const i=input();mutate(i);assert.throws(()=>service.reserve(i),/WORKER_INPUT|RUNTIME_UNSUPPORTED/);
  }
  const a=input(),b=input('b');service.reserve(a);b.batch={...b.batch,id:a.batch.id};assert.throws(()=>service.reserve(b),/BATCH_CONFLICT/);
  assert.equal(service.list().length,1);
});
for(const scenario of ['resource','total','runtime','task'] as const)test(`racing SQLite connections enforce ${scenario} admission atomically`,{timeout:15000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-worker-race-')),path=join(root,'test.db'),store=new Store(path);
  const setup=new ParallelWorkerService(store);if(scenario==='total')setup.reserve(input('seed'));
  store.close();t.after(()=>rmSync(root,{recursive:true,force:true}));
  const gate=new SharedArrayBuffer(4),signal=new Int32Array(gate);
  const code=`const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {Store}=await import(workerData.storeURL);const {ParallelWorkerService}=await import(workerData.serviceURL);
    const store=new Store(workerData.path);store.db.exec('PRAGMA busy_timeout=5000');const service=new ParallelWorkerService(store);
    parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.gate),0,0);
    try{service.reserve(workerData.input);parentPort.postMessage('won');}catch(e){parentPort.postMessage(e.message);}finally{store.close();}})();`;
  const workers:Worker[]=[],results:Promise<string>[]=[],exits:Promise<void>[]=[];
  t.after(async()=>{await Promise.all(workers.map(w=>w.terminate()));});
  // Initialize existing Store migrations serially; only reservations race at the barrier.
  for(const id of ['a','b']){
    const i=input(id,scenario==='runtime'?'codex':'claude-code');
    if(scenario==='resource')i.claims=[{kind:'external_target',targetKey:'shared'}];
    if(scenario==='task'){i.attempt.taskId='shared';i.batch.taskIds=['shared'];i.batch.runtimeChoices=[{taskId:'shared',runtimeId:i.attempt.runtimeId}];}
    const w=new Worker(code,{eval:true,workerData:{path,gate,input:i,storeURL:new URL('../server/store.ts',import.meta.url).href,serviceURL:new URL('../server/parallel-workers.ts',import.meta.url).href}});workers.push(w);
    exits.push(new Promise<void>((resolve,reject)=>{w.once('exit',code=>code===0?resolve():reject(new Error('worker exit '+code)));w.once('error',reject);}));
    const ready=new Promise<void>((resolve,reject)=>{w.once('message',()=>resolve());w.once('error',reject);});
    results.push(new Promise<string>((resolve,reject)=>{w.on('message',v=>{if(v!=='ready')resolve(v);});w.once('error',reject);}));
    await ready;
  }
  Atomics.store(signal,0,1);Atomics.notify(signal,0);
  const error={resource:'WORKER_RESOURCE_CONFLICT',total:'WORKER_TOTAL_LIMIT',runtime:'WORKER_RUNTIME_LIMIT',task:'WORKER_TASK_RESERVED'}[scenario];
  assert.deepEqual((await Promise.all(results)).sort(),[error,'won']);
  await Promise.all(exits);
  const check=new Store(path);try{assert.equal(new ParallelWorkerService(check).list().length,scenario==='total'?2:1);}finally{check.close();}
});

test('raw claim changes conflict on replay even when DB group identity is equivalent',t=>{
  const {service}=fixture(t),i=input();
  i.claims=[{kind:'db_file_group',host:'host-a',path:{path:'/data/test.db-wal',canonicalPath:'/data/test.db-wal',aliasStatus:'verified_no_alias'}}];
  const r=service.reserve(i);assert.equal(r.claims[0].kind,'db_file_group');assert.deepEqual(service.reserve(i),r);
  const changed=structuredClone(i);if(changed.claims[0].kind==='db_file_group')changed.claims[0].path={path:'/data/test.db',canonicalPath:'/data/test.db',aliasStatus:'verified_no_alias'};
  assert.throws(()=>service.reserve(changed),/IDEMPOTENCY_CONFLICT/);
});
test('partial claim insert failure rolls back the reservation and intent',t=>{
  const {store,service}=fixture(t),i=input();i.claims.push({kind:'external_target',targetKey:'second'});
  store.db.exec("CREATE TRIGGER fail_second_claim BEFORE INSERT ON worker_claims WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  assert.throws(()=>service.reserve(i),/claim failed/);assert.deepEqual(service.list(),[]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM worker_claims').get()!.n,0);assert.equal(store.lastSeq(),0);
});
test('late terminal evidence from old owner cannot release a transferred running attempt',t=>{
  const {service}=fixture(t),r=service.reserve(input());service.transition(r,'dispatched');service.transition(r,'running');
  const next=service.transfer(r,'replacement');assert.equal(next.state,'running');
  assert.throws(()=>service.confirmTerminal(r,evidence(r,'terminal_confirmed')),/FENCE_STALE/);
  assert.throws(()=>service.confirmTerminal(next,evidence(next,'not_dispatched')),/RELEASE_EVIDENCE/);
  assert.equal(service.read(r.reservationId).state,'running');
  service.confirmTerminal(next,evidence(next,'terminal_confirmed'));service.release(next);
  assert.deepEqual(service.reserve(input()),service.read(r.reservationId));
  const fresh=service.reserve(input('b'));assert.ok(fresh.fencingGeneration>next.fencingGeneration);
});
test('post-commit observer failure cannot cause a duplicate reservation on retry',t=>{
  const {store,service}=fixture(t),i=input();store.once('event',()=>{throw new Error('observer failed');});
  assert.throws(()=>service.reserve(i),/observer failed/);
  assert.equal(service.list().length,1);assert.deepEqual(service.reserve(i),service.list()[0]);
  assert.equal(store.eventsAfter(0).length,1);
});
