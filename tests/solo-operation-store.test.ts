import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {DatabaseSync} from 'node:sqlite';

const identity=()=>({runtimeId:'codex' as const,ownerIncarnation:'manager-fixture-1',generation:2,nativeSessionId:'session-fixture-1'});
const create=(store:Store)=>store.createRun('operation-request-1','digest','PRIVATE_PROMPT','workspace-1',undefined,identity());

test('Solo identity and state revisions commit with the Run without retaining prompt or output',()=>{
  const store=new Store(':memory:');try{
    const run=create(store);let view=store.soloOperation(run.id);
    assert.equal(view.identity,'recorded');assert.equal(view.history.length,1);
    assert.deepEqual(view.record,{schemaVersion:1,runId:run.id,requestId:run.requestId,workspaceId:'workspace-1',...identity(),nativeTurnId:null,
      execution:'starting',revision:1,createdAt:run.createdAt,updatedAt:run.updatedAt,eventKind:'run.created'});
    store.updateRun(run.id,{turnId:'turn-1',execution:'running'},'run.started');
    store.updateRun(run.id,{response:'PRIVATE_RESPONSE'},'message.updated');
    assert.equal(store.soloOperation(run.id).history.length,2);
    store.updateRun(run.id,{execution:'completed'},'run.completed');
    view=store.soloOperation(run.id);assert.deepEqual(view.history.map(item=>item.execution),['starting','running','completed']);
    assert.deepEqual(view.history.map(item=>item.revision),[1,2,3]);assert.equal(view.record?.nativeTurnId,'turn-1');
    assert.equal(JSON.stringify(view).includes('PRIVATE_'),false);
    assert.throws(()=>store.soloOperation('unknown'),/RUN_NOT_FOUND/);
  }finally{store.close();}
});

test('identity persistence failure rolls back Run and event, and transition failure keeps unresolved state',()=>{
  const store=new Store(':memory:');try{
    store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON solo_operations BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>create(store));assert.equal(store.runs().length,0);assert.equal(store.lastSeq(),0);
    store.db.exec('DROP TRIGGER fail_intent');const run=create(store),seq=store.lastSeq();
    store.db.exec("CREATE TRIGGER fail_transition BEFORE INSERT ON solo_operation_history BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>store.updateRun(run.id,{execution:'completed'},'run.completed'));
    assert.equal(store.getRun(run.id)?.execution,'starting');assert.equal(store.soloOperation(run.id).history.length,1);assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});

test('native turn identity is immutable and legacy runs stay explicitly unknown',()=>{
  const store=new Store(':memory:');try{
    const run=create(store);store.updateRun(run.id,{turnId:'turn-1',execution:'running'},'run.started');
    assert.throws(()=>store.updateRun(run.id,{turnId:'foreign-turn'},'run.accepted'),/OPERATION_TURN_MISMATCH/);
    assert.equal(store.getRun(run.id)?.turnId,'turn-1');assert.equal(store.soloOperation(run.id).history.length,2);
    const legacy=store.createRun('legacy-request-1','digest','Fixture');
    assert.deepEqual(store.soloOperation(legacy.id),{runId:legacy.id,identity:'legacy_unknown',record:null,history:[]});
  }finally{store.close();}
});

test('failed audit event persistence rolls back both Run and operation revisions',()=>{
  const store=new Store(':memory:');try{
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>create(store));assert.equal(store.runs().length,0);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM solo_operations').get()!.count,0);
    store.db.exec('DROP TRIGGER fail_event');const run=create(store),before=store.soloOperation(run.id);
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>store.updateRun(run.id,{execution:'completed'},'run.completed'));assert.deepEqual(store.soloOperation(run.id),before);
  }finally{store.close();}
});

test('a corrupted journal binding or history cannot be shown as a recorded identity',()=>{
  const store=new Store(':memory:');try{
    const run=create(store),view=store.soloOperation(run.id),changed={...view.record!,requestId:'foreign-request'};
    store.db.prepare('UPDATE solo_operations SET body=? WHERE run_id=?').run(JSON.stringify(changed),run.id);
    assert.throws(()=>store.soloOperation(run.id),/OPERATION_INTEGRITY/);
    store.db.prepare('UPDATE solo_operation_history SET body=? WHERE run_id=?').run(JSON.stringify(changed),run.id);
    assert.throws(()=>store.soloOperation(run.id),/OPERATION_INTEGRITY/);
  }finally{store.close();}
});

test('disk restart preserves owner identity, journals lost once, and leaves historical records intact',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-operation-journal-')),path=join(root,'state.sqlite');let store=new Store(path);
  try{
    const legacy=store.createRun('legacy-completed','digest','Fixture');store.updateRun(legacy.id,{execution:'completed'},'run.completed');
    const legacyBody=store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id)!.body;
    const run=create(store),events=store.eventsAfter(0);store.close();store=new Store(path);
    const view=store.soloOperation(run.id);assert.equal(view.record?.execution,'lost');assert.equal(view.record?.ownerIncarnation,'manager-fixture-1');
    assert.deepEqual(view.history.map(item=>item.execution),['starting','lost']);assert.deepEqual(store.eventsAfter(0).slice(0,events.length),events);
    assert.equal(store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id)!.body,legacyBody);
    store.close();store=new Store(path);assert.deepEqual(store.soloOperation(run.id),view);assert.equal(store.soloOperation(legacy.id).identity,'legacy_unknown');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('identity inputs reject untrusted fields and accessors without partial persistence',()=>{
  const store=new Store(':memory:');let reads=0;
  try{
    const accessor={...identity()};Object.defineProperty(accessor,'ownerIncarnation',{enumerable:true,get(){reads++;return 'owner';}});
    for(const value of [{...identity(),generation:0},{...identity(),generation:1.5},{...identity(),runtimeId:'unknown'},
      {...identity(),ownerIncarnation:''},{...identity(),browserConfirmed:true},accessor]){
      assert.throws(()=>store.createRun('invalid-identity','digest','Fixture',undefined,undefined,value as any),/INVALID_OPERATION_IDENTITY/);
    }
    assert.equal(reads,0);assert.equal(store.runs().length,0);assert.equal(store.lastSeq(),0);
  }finally{store.close();}
});

test('failed additive migration rolls back its tables and preserves existing Run bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-operation-migrate-')),path=join(root,'state.sqlite');let store=new Store(path);
  const run=store.createRun('migration-legacy','digest','Fixture');store.updateRun(run.id,{execution:'completed'},'run.completed');
  const body=store.db.prepare('SELECT body FROM runs WHERE id=?').get(run.id)!.body;
  store.db.exec("DROP TABLE solo_operation_history; DROP TABLE solo_operations; DELETE FROM metadata WHERE key='schema:solo-operations'; CREATE TRIGGER fail_migration BEFORE INSERT ON metadata WHEN NEW.key='schema:solo-operations' BEGIN SELECT RAISE(FAIL,'fixture'); END;");
  store.close();
  try{
    assert.throws(()=>new Store(path));const db=new DatabaseSync(path);
    try{
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('solo_operations','solo_operation_history')").get()!.count,0);
      assert.equal(db.prepare('SELECT body FROM runs WHERE id=?').get(run.id)!.body,body);
      db.exec('DROP TRIGGER fail_migration');
    }finally{db.close();}
    store=new Store(path);assert.equal(store.soloOperation(run.id).identity,'legacy_unknown');store.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
