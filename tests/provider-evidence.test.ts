import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {providerExecutionEvidence} from '../server/provider-evidence.ts';
import type {QualityLoopRecord} from '../shared/quality-loop-record.ts';

test('legacy completion and mocked independent reviews never become live verification',()=>{
 const store=new Store(':memory:');try{const run=store.createRun('request','hash','prompt');store.updateRun(run.id,{execution:'completed',response:'result'},'run.completed');
 assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,null).source,'unknown');
 store.append('run.runtime_source',run.id,{source:'mock',interface:'codex.app_server'});
 const quality={result:{status:'passed'},verification:{status:'passed'},recoveryRequired:false,producer:{evidenceSource:'mock'},steps:[{kind:'review',state:'completed',evidence:{evidenceSource:'mock'}}]} as QualityLoopRecord;
 const value=providerExecutionEvidence(store,store.getRun(run.id)!,quality);assert.equal(value.source,'mock');assert.equal(value.livePipelineVerified,false);assert.equal(value.costUsd,null);assert.equal(value.remainingQuota,null);
 }finally{store.close();}
});
test('native source needs terminal provider evidence and native independent review plus local verification',()=>{
 const store=new Store(':memory:');try{const run=store.createRun('request','hash','prompt');
 store.append('run.runtime_source',run.id,{source:'native',interface:'codex.app_server'});
 store.updateRun(run.id,{execution:'completed',response:'result',turnId:'turn'},'run.completed');
 const quality={result:{status:'passed'},verification:{status:'passed'},recoveryRequired:false,producer:{evidenceSource:'native'},steps:[{kind:'review',state:'completed',evidence:{evidenceSource:'native'}}]} as QualityLoopRecord;
 assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,quality).livePipelineVerified,true);
 quality.steps[0].evidence!.evidenceSource='mock';assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,quality).livePipelineVerified,false);
 quality.steps[0].evidence!.evidenceSource='native';quality.verification.status='unknown';assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,quality).livePipelineVerified,false);
 }finally{store.close();}
});
test('Claude preflight not_started does not count as an observed provider task',()=>{
 const store=new Store(':memory:');try{const run=store.createRun('request','hash','prompt',undefined,{runtime:'claude-code'});
 store.append('run.runtime_source',run.id,{source:'native',interface:'claude.print'});
 store.append('run.runtime_outcome',run.id,{dispatch:'not_started',exit:'not_observed'});
 store.updateRun(run.id,{execution:'failed'},'run.failed');
 assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,null).executionObserved,false);
 assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,null).responseDigest,null);
 }finally{store.close();}
});

test('Claude completed outcome must independently preserve native provenance',()=>{
 const store=new Store(':memory:');try{const run=store.createRun('request','hash','prompt',undefined,{runtime:'claude-code'});
 store.append('run.runtime_source',run.id,{source:'native',interface:'claude.print'});
 store.updateRun(run.id,{execution:'completed',response:'result'},'run.completed');
 store.append('run.runtime_outcome',run.id,{source:'native',dispatch:'started',exit:'observed'});
 const native=providerExecutionEvidence(store,store.getRun(run.id)!,null);assert.equal(native.source,'native');assert.equal(native.executionObserved,true);assert.match(native.responseDigest!,/^[a-f0-9]{64}$/);
 store.append('run.runtime_outcome',run.id,{source:'mock',dispatch:'started',exit:'observed'});
 assert.equal(providerExecutionEvidence(store,store.getRun(run.id)!,null).source,'mock');
 }finally{store.close();}
});
