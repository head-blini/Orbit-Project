import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexModelTracker,decodeCodexModelCatalog} from '../server/codex-model-attribution.ts';
import type {CodexModelAttribution} from '../shared/codex-model-attribution.ts';

const response=(model='gpt-5.4',thread='thread_1')=>({thread:{id:thread,sessionId:'native_session',modelProvider:'openai',model},model,modelProvider:'openai'});
const ack=(turn='turn_1')=>({turn:{id:turn,model:'fabricated-extra-field'}});
const event=(method:string,turn='turn_1',extra:object={})=>({method,params:{threadId:'thread_1',turnId:turn,turn:{id:turn},...extra}});
function setup(){const saved=new Map<string,CodexModelAttribution>();const tracker=new CodexModelTracker((key,value)=>saved.set(key,value));tracker.connect('thread/start',response(),'request-thread','user-choice');tracker.begin('run_1',{requestedModelId:'request-turn'});return {tracker,saved};}
test('choice, request, server configuration and actual identity stay separate',()=>{
  const {tracker}=setup();tracker.acknowledge('run_1',ack());tracker.event(event('turn/started'));tracker.event(event('turn/completed'));tracker.finish('run_1','completed');
  const value=tracker.snapshot('run_1')!;
  assert.equal(value.selectedModelId,'user-choice');assert.equal(value.requestedModelId,'request-turn');assert.equal(value.serverModelId,'gpt-5.4');
  assert.equal(value.threadId,'thread_1');assert.equal(value.nativeSessionId,'native_session');assert.equal(value.turnId,'turn_1');
  assert.equal(value.actualModelId,'unknown');assert.equal(value.actualModelEvidence,'unavailable');assert.equal(value.observationIncomplete,false);
});
test('catalog and extra turn/read fields cannot attest an executed model',()=>{
  assert.deepEqual(decodeCodexModelCatalog({data:[{id:'catalog-id',model:'gpt-5.4'}]}),[{id:'catalog-id',model:'gpt-5.4'}]);
  const {tracker}=setup();tracker.acknowledge('run_1',ack());tracker.threadRead({thread:{id:'thread_1',model:'gpt-5.5',modelProvider:'openai',turns:[{id:'turn_1',model:'execution-claim'}]}});
  tracker.event(event('model/verification','turn_1',{verifications:['trustedAccessForCyber']}));
  const value=tracker.snapshot('run_1')!;assert.equal(value.serverModelId,'gpt-5.5');assert.equal(value.serverSource,'thread/read');assert.equal(value.actualModelId,'unknown');
  assert.equal(JSON.stringify(value).includes('execution-claim'),false);
});
test('pre-ack routing and terminal events bind only to acknowledged turn',()=>{
  const {tracker}=setup();tracker.event(event('turn/started'));tracker.event(event('model/rerouted','turn_1',{fromModel:'gpt-5.4',toModel:'gpt-5.5',reason:'raw secret text'}));tracker.event(event('turn/completed'));
  tracker.acknowledge('run_1',ack());tracker.finish('run_1','completed');const value=tracker.snapshot('run_1')!;
  assert.equal(value.modelChanged,true);assert.equal(value.serverModelId,'gpt-5.4');assert.equal(value.actualModelId,'unknown');assert.equal(value.observationIncomplete,false);
  assert.equal(JSON.stringify(value).includes('raw secret'),false);assert.equal(value.observations.find(o=>o.source==='model/rerouted')?.turnId,'turn_1');
});
test('settings before acknowledgement remain configuration evidence',()=>{
  const {tracker}=setup();tracker.event(event('thread/settings/updated','turn_1',{threadSettings:{model:'gpt-5.5',modelProvider:'openai'}}));tracker.acknowledge('run_1',ack());
  const value=tracker.snapshot('run_1')!;assert.equal(value.modelChanged,true);assert.equal(value.serverModelId,'gpt-5.5');assert.equal(value.serverSource,'thread/settings/updated');assert.equal(value.actualModelId,'unknown');
});
test('foreign thread and turn cannot overwrite attribution',()=>{
  const {tracker}=setup();tracker.acknowledge('run_1',ack());const before=tracker.snapshot('run_1');
  tracker.event(event('model/rerouted','foreign_turn',{toModel:'foreign-model'}));tracker.event(event('thread/settings/updated','turn_1',{threadId:'foreign_thread',threadSettings:{model:'foreign-model'}}));
  assert.deepEqual(tracker.snapshot('run_1'),before);
});
test('pre-ack foreign turn is discarded and incomplete observation is explicit',()=>{
  const {tracker}=setup();tracker.event(event('model/rerouted','foreign_turn',{toModel:'foreign-model'}));tracker.acknowledge('run_1',ack());
  const value=tracker.snapshot('run_1')!;assert.equal(value.observationIncomplete,true);assert.equal(value.modelChanged,false);assert.equal(JSON.stringify(value).includes('foreign-model'),false);
});
test('resume model change leaves old execution immutable and rejects stale acknowledgement',()=>{
  const {tracker}=setup();tracker.disconnect();const prior=tracker.snapshot('run_1');tracker.connect('thread/resume',response('gpt-5.5'));tracker.begin('run_2');tracker.acknowledge('run_1',ack());tracker.acknowledge('run_2',ack('turn_2'));
  assert.deepEqual(tracker.snapshot('run_1'),prior);const next=tracker.snapshot('run_2')!;assert.equal(next.resumed,true);assert.equal(next.serverModelId,'gpt-5.5');assert.equal(next.actualModelId,'unknown');assert.equal(next.requestedModelId,null);assert.equal(next.turnId,'turn_2');
});
test('finish before acknowledgement preserves terminal status and uncertainty',()=>{
  const {tracker}=setup();tracker.event(event('turn/completed'));tracker.finish('run_1','completed');tracker.acknowledge('run_1',ack());
  assert.equal(tracker.snapshot('run_1')?.status,'completed');assert.equal(tracker.snapshot('run_1')?.observationIncomplete,true);assert.equal(tracker.snapshot('run_1')?.turnId,'turn_1');
});
test('missing events, interruption and connection loss are never verification success',()=>{
  for(const status of ['completed','interrupted','failed','lost'] as const){const {tracker}=setup();tracker.acknowledge('run_1',ack());tracker.finish('run_1',status);assert.equal(tracker.snapshot('run_1')?.observationIncomplete,true);assert.equal(tracker.snapshot('run_1')?.actualModelId,'unknown');}
  const {tracker}=setup();tracker.disconnect();assert.equal(tracker.snapshot('run_1')?.status,'lost');assert.equal(tracker.snapshot('run_1')?.observationIncomplete,true);
});
test('malformed getters and sensitive values never leak or interrupt execution',()=>{
  const {tracker,saved}=setup();tracker.event(event('thread/settings/updated','turn_1',{threadSettings:{model:'https://127.0.0.1/private',modelProvider:'Bearer secret'}}));
  const hostile={get method(){throw Error('secret');}};assert.doesNotThrow(()=>tracker.event(hostile));
  const value=saved.get('run_1')!;assert.equal(value.serverModelId,null);assert.equal(value.serverProviderId,null);assert.equal(JSON.stringify(value).includes('private'),false);assert.equal(value.observationIncomplete,true);
});
test('best effort persistence failure and mutation cannot affect execution attribution',async()=>{
  const tracker=new CodexModelTracker(()=>{throw Error('disk failure');});tracker.connect('thread/start',response());assert.doesNotThrow(()=>tracker.begin('run_1'));assert.equal(tracker.snapshot('run_1')?.observationIncomplete,true);
  const rejecting=new CodexModelTracker(()=>Promise.reject(Error('disk failure')));rejecting.connect('thread/start',response());rejecting.begin('run_1');await Promise.resolve();assert.equal(rejecting.snapshot('run_1')?.observationIncomplete,true);
  const {tracker:detached,saved}=setup();saved.get('run_1')!.serverModelId='mutated';const copy=detached.snapshot('run_1')!;copy.serverModelId='mutated';assert.equal(detached.snapshot('run_1')?.serverModelId,'gpt-5.4');
});
test('event buffers and retained observation payload are bounded',()=>{
  const {tracker}=setup();for(let index=0;index<200;index++)tracker.event(event('model/rerouted','turn_1',{toModel:'gpt-5.5'}));tracker.acknowledge('run_1',ack());
  const value=tracker.snapshot('run_1')!;assert.ok(value.observations.length<=128);assert.equal(value.observationIncomplete,true);
});
test('duplicate acknowledgement cannot replace the native execution identity',()=>{
  const {tracker}=setup();tracker.acknowledge('run_1',ack());tracker.acknowledge('run_1',ack('turn_2'));assert.equal(tracker.snapshot('run_1')?.turnId,'turn_1');assert.equal(tracker.snapshot('run_1')?.observationIncomplete,true);
});
