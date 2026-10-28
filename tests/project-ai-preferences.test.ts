import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
const module=await import('../server/project-ai-preferences.ts').catch(()=>null);

function fixture(){
  assert.ok(module,'project AI preferences service required');
  const store=new Store(':memory:'),code=randomUUID(),general=randomUUID();
  for(const [id,kind] of [[code,'code'],[general,'general']] as const)store.saveProject({id,kind,name:kind,path:'/unused/'+id,createdAt:'',writeEnabled:false});
  return {store,code,general,service:new module.ProjectAiPreferencesService(store)};
}
test('preferences have virtual project-kind defaults and GET/no-op writes have no side effects',()=>{
  const f=fixture();try{
    const before=f.store.lastSeq();
    assert.deepEqual(f.service.read(f.code),{planning:'codex',execution:'codex',revision:0,updatedAt:null});
    assert.deepEqual(f.service.read(f.general),{planning:'claude-code',execution:'claude-code',revision:0,updatedAt:null});
    assert.deepEqual(f.service.update(f.general,{expectedRevision:0,planning:'claude-code',execution:'claude-code'}),f.service.read(f.general));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_ai_preferences').get()!.n,0);
    assert.equal(f.store.lastSeq(),before);assert.deepEqual(f.store.runs(),[]);
  }finally{f.store.close();}
});
test('preferences CAS persists changes, rejects stale even if unchanged, and preserves no-op timestamp',()=>{
  const f=fixture();try{
    const changed=f.service.update(f.code,{expectedRevision:0,planning:'claude-code',execution:'codex'});
    assert.equal(changed.revision,1);assert.ok(changed.updatedAt);
    const restored=new module!.ProjectAiPreferencesService(f.store);assert.deepEqual(restored.read(f.code),changed);
    assert.deepEqual(f.service.update(f.code,{expectedRevision:1,planning:'claude-code',execution:'codex'}),changed);
    assert.throws(()=>f.service.update(f.code,{expectedRevision:0,planning:'claude-code',execution:'codex'}),error=>error instanceof Error&&error.message==='AI_PREFERENCES_STALE'&&(error as any).status===409);
    assert.equal(f.service.update(f.code,{expectedRevision:1,planning:'codex',execution:'codex'}).revision,2);
    assert.deepEqual(f.store.runs(),[]);
  }finally{f.store.close();}
});
test('preferences reject invalid runtimes/revisions/fields and general Codex execution without changing state',()=>{
  const f=fixture();try{
    const valid={expectedRevision:0,planning:'codex',execution:'codex'} as const;
    for(const input of [{...valid,planning:'other'},{...valid,execution:'other'},{...valid,expectedRevision:-1},{...valid,expectedRevision:0.5},{...valid,expectedRevision:'0'},{...valid,extra:true},null])assert.throws(()=>f.service.update(f.code,input as any),/INVALID_FIELDS/);
    assert.throws(()=>f.service.update(f.general,valid),/GIT_REQUIRED/);
    // Only combinations that actually run may be stored: the saved choice is the runtime used.
    assert.throws(()=>f.service.update(f.general,{expectedRevision:0,planning:'codex',execution:'claude-code'}),/GIT_REQUIRED/);
    assert.throws(()=>f.service.update(f.code,{expectedRevision:0,planning:'codex',execution:'claude-code'}),error=>error instanceof Error&&error.message==='RUNTIME_NOT_SUPPORTED'&&(error as any).status===409);
    assert.throws(()=>f.service.read(randomUUID()),/PROJECT_NOT_FOUND/);
    assert.equal(f.service.read(f.code).revision,0);assert.equal(f.service.read(f.general).revision,0);assert.deepEqual(f.store.runs(),[]);
  }finally{f.store.close();}
});
