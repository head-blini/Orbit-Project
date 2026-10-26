import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {DatabaseSync} from 'node:sqlite';

const owner='manager-connection-fixture';
const processFact=()=>({handleId:'owned-child-fixture',pid:1234,createdAt:'2026-10-27T00:00:00.000Z',state:'running' as const,closedAt:null,exitCode:null,signal:null});
const identity={runtimeId:'codex' as const,ownerIncarnation:owner,generation:2,nativeSessionId:'session-connection-fixture'};

test('connection intent, native session and exact process observations join the existing Run identity',()=>{
  const store=new Store(':memory:');try{
    store.beginNativeConnection(owner,2);assert.equal(store.nativeConnection(owner,2)?.process,null);
    store.observeNativeProcess(owner,2,processFact());store.bindNativeSession(owner,2,identity.nativeSessionId);
    const run=store.createRun('native-process-request','digest','Fixture',undefined,undefined,identity);
    assert.equal(store.soloOperation(run.id).connection?.process?.state,'running');
    store.closeNativeTransport(owner,2);
    assert.equal(store.soloOperation(run.id).connection?.process?.state,'running','transport close is not process close');
    const closed={...processFact(),state:'closed' as const,closedAt:'2026-10-27T00:01:00.000Z',exitCode:0};
    store.observeNativeProcess(owner,2,closed);const seq=store.lastSeq();
    store.observeNativeProcess(owner,2,closed);assert.equal(store.lastSeq(),seq);
    store.observeNativeProcess(owner,2,Object.fromEntries(Object.entries(closed).reverse()) as typeof closed);assert.equal(store.lastSeq(),seq);
    assert.equal(store.soloOperation(run.id).connection?.process?.closedAt,closed.closedAt);
    assert.equal(store.getRun(run.id)?.execution,'starting','process facts do not mark a Run successful or release it');
    assert.throws(()=>store.bindNativeSession(owner,2,'other-session'),/CONNECTION_IDENTITY_MISMATCH/);
    assert.throws(()=>store.observeNativeProcess(owner,2,processFact()),/PROCESS_OBSERVATION_MISMATCH/);
  }finally{store.close();}
});

test('journal failures roll back intent and evidence instead of leaving partial facts',()=>{
  const store=new Store(':memory:');try{
    store.db.exec("CREATE TRIGGER fail_connection BEFORE INSERT ON native_connections BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>store.beginNativeConnection(owner,2));assert.equal(store.nativeConnection(owner,2),null);assert.equal(store.lastSeq(),0);
    store.db.exec('DROP TRIGGER fail_connection');store.beginNativeConnection(owner,2);const before=store.nativeConnection(owner,2),seq=store.lastSeq();
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>store.observeNativeProcess(owner,2,processFact()));assert.deepEqual(store.nativeConnection(owner,2),before);assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});

test('process identity and shape are validated without accessing getters or trusting PID-only claims',()=>{
  const store=new Store(':memory:');let reads=0;
  try{
    store.beginNativeConnection(owner,2);
    const accessor={...processFact()};Object.defineProperty(accessor,'pid',{enumerable:true,get(){reads++;return 1234;}});
    for(const fact of [accessor,{...processFact(),state:{toString(){reads++;return 'running';}}},{...processFact(),pid:0},{...processFact(),state:'closed'},
      {...processFact(),bootId:'invented'},{...processFact(),state:'spawn_failed',closedAt:'2026-10-27T00:00:00.000Z'},
      {...processFact(),state:'closed',closedAt:'2026-10-27T00:00:01.000Z',signal:'secret path /fixture'}]){
      assert.throws(()=>store.observeNativeProcess(owner,2,fact as any),/INVALID_PROCESS_OBSERVATION/);
    }
    assert.equal(reads,0);store.observeNativeProcess(owner,2,processFact());
    for(const change of [{pid:4321},{handleId:'foreign-child'},{createdAt:'2026-10-26T00:00:00.000Z'}])assert.throws(()=>store.observeNativeProcess(owner,2,{...processFact(),...change}),/PROCESS_OBSERVATION_MISMATCH/);
    assert.throws(()=>store.observeNativeProcess(owner,3,processFact()),/CONNECTION_NOT_FOUND/);
  }finally{store.close();}
});

test('connection migration rolls back atomically and corrupted connection or session binding is rejected',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-connection-migration-')),path=join(root,'fixture.sqlite');let store=new Store(path);
  try{
    store.db.exec("DROP TABLE native_connections; DELETE FROM metadata WHERE key='schema:native-connections'; CREATE TRIGGER fail_native_migration BEFORE INSERT ON metadata WHEN NEW.key='schema:native-connections' BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    store.close();assert.throws(()=>new Store(path));const db=new DatabaseSync(path);
    try{assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='native_connections'").get()!.n,0);db.exec('DROP TRIGGER fail_native_migration');}finally{db.close();}
    store=new Store(path);store.beginNativeConnection(owner,2);store.bindNativeSession(owner,2,'foreign-session');
    const run=store.createRun('bad-session-binding','digest','Fixture',undefined,undefined,identity);
    assert.throws(()=>store.soloOperation(run.id),/CONNECTION_IDENTITY_MISMATCH/);
    const before=store.nativeConnection(owner,2)!;
    store.db.prepare('UPDATE native_connections SET body=? WHERE owner_incarnation=? AND generation=?').run(JSON.stringify({...before,generation:3}),owner,2);
    assert.throws(()=>store.nativeConnection(owner,2),/CONNECTION_INTEGRITY/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('connection evidence survives restart unchanged while old Run and journal schemas remain intact',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-native-connection-')),path=join(root,'fixture.sqlite');let store=new Store(path);
  try{
    store.beginNativeConnection(owner,2);store.bindNativeSession(owner,2,identity.nativeSessionId);store.observeNativeProcess(owner,2,processFact());
    const run=store.createRun('native-restart-request','digest','Fixture',undefined,undefined,identity);store.updateRun(run.id,{execution:'completed'},'run.completed');
    const body=store.db.prepare('SELECT body FROM runs WHERE id=?').get(run.id)!.body;
    const before=store.soloOperation(run.id);store.close();store=new Store(path);
    assert.deepEqual(store.soloOperation(run.id),before);assert.equal(store.db.prepare('SELECT body FROM runs WHERE id=?').get(run.id)!.body,body);
    assert.equal(store.soloOperation(run.id).connection?.process?.state,'running','restart must not fabricate parent termination');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
