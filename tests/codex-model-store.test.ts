import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {CodexModelTracker} from '../server/codex-model-attribution.ts';
import {qualityRunEvidence} from '../server/quality-loop-native.ts';

test('restart preserves configuration and quarantines only unfinished observations without dispatch',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-model-store-')),path=join(dir,'test.sqlite');let store=new Store(path);
  try{
    const tracker=new CodexModelTracker((id,value)=>store.saveCodexModelAttribution(id,value));
    tracker.connect('thread/start',{model:'server-model',modelProvider:'openai',thread:{id:'thread-one',sessionId:'native-session'}});
    const first=store.createRun('first','digest','prompt');tracker.begin(first.id,{selectedModelId:'selected-model',requestedModelId:'requested-model'});
    tracker.acknowledge(first.id,{turn:{id:'turn-one'}});
    tracker.event({method:'turn/started',params:{threadId:'thread-one',turn:{id:'turn-one'}}});
    tracker.event({method:'turn/completed',params:{threadId:'thread-one',turn:{id:'turn-one'}}});
    tracker.finish(first.id,'completed');store.updateRun(first.id,{turnId:'turn-one',execution:'completed'},'run.completed');
    const before=store.getCodexModelAttribution(first.id);
    const second=store.createRun('second','digest','prompt');tracker.begin(second.id);tracker.acknowledge(second.id,{turn:{id:'turn-two'}});
    store.db.close();store=new Store(path);
    assert.deepEqual(store.getCodexModelAttribution(first.id),before);
    const pending=store.getCodexModelAttribution(second.id)!;
    assert.equal(pending.status,'lost');assert.equal(pending.observationIncomplete,true);
    assert.equal(pending.serverModelId,'server-model');assert.equal(pending.actualModelId,'unknown');
    assert.equal(store.getRun(second.id)?.execution,'lost');assert.equal(store.runs().length,2);
    const evidence=qualityRunEvidence(store,store.getRun(first.id)!);
    assert.equal(evidence.modelId,null);assert.equal(evidence.source,'unknown');
    assert.equal(evidence.codex?.selectedModelId,'selected-model');assert.equal(evidence.codex?.requestedModelId,'requested-model');
    assert.equal(evidence.codex?.nativeSessionId,'native-session');
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('storage failure exposes incomplete observations instead of stale successful metadata',()=>{
  const store=new Store(':memory:');
  try{
    const run=store.createRun('request','digest','prompt');
    const tracker=new CodexModelTracker((id,value)=>store.saveCodexModelAttribution(id,value));
    tracker.connect('thread/start',{model:'server-model',modelProvider:'openai',thread:{id:'thread'}});tracker.begin(run.id);
    store.db.exec("CREATE TRIGGER fail_model_write BEFORE UPDATE ON run_model_attributions BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
    tracker.finish(run.id,'lost');
    assert.equal(store.getCodexModelAttribution(run.id)?.status,'lost');
    assert.equal(store.getCodexModelAttribution(run.id)?.observationIncomplete,true);
    assert.equal(store.getCodexModelAttribution(run.id)?.actualModelId,'unknown');
  }finally{store.db.close();}
});

test('restart quarantines attribution when execution completed before its final metadata write',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-model-gap-')),path=join(dir,'test.sqlite');let store=new Store(path);
  try{
    const run=store.createRun('request','digest','prompt'),tracker=new CodexModelTracker((id,value)=>store.saveCodexModelAttribution(id,value));
    tracker.connect('thread/start',{model:'server-model',modelProvider:'openai',thread:{id:'thread'}});
    tracker.begin(run.id);tracker.acknowledge(run.id,{turn:{id:'turn'}});
    store.updateRun(run.id,{execution:'completed',turnId:'turn'},'run.completed');
    store.close();store=new Store(path);
    assert.equal(store.getRun(run.id)?.execution,'completed');
    assert.equal(store.getCodexModelAttribution(run.id)?.status,'completed');
    assert.equal(store.getCodexModelAttribution(run.id)?.observationIncomplete,true);
    assert.equal(store.getCodexModelAttribution(run.id)?.actualModelId,'unknown');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
