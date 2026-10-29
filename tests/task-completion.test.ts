import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTaskCompletion, completionPolicyDigest} from '../server/task-completion.ts';
import {CODE_GATES, GENERAL_GATES} from '../shared/task-completion.ts';
import type {CompletionBinding, CompletionEvidence, CompletionPolicy, CompletionLoop} from '../shared/task-completion.ts';
import type {QualityProgress, QualityDimension} from '../shared/quality-progress.ts';
import type {QualityModelEvidence} from '../shared/quality-loop-record.ts';

const model = (id:string):QualityModelEvidence => ({providerId:'provider',modelId:id,sessionId:`session-${id}`,runId:`run-${id}`,source:'native_observed',evidenceSource:'native'});
const dimension = (status:QualityDimension['status']='not_run', evidenceIds:string[]=[]):QualityDimension => ({status,evidenceIds,blockers:[],nextAction:null});
function fixture(kind:'code'|'general'='code') {
  const policy:CompletionPolicy = {projectKind:kind,requiredGates:[...(kind==='code'?CODE_GATES:GENERAL_GATES)],gateCommandMap:kind==='code'?Object.fromEntries(CODE_GATES.map(g=>[g,[g]])):{},notApplicable:[],requireIndependentReview:false,dependencyRelease:'quality_passed'};
  const binding:CompletionBinding = {projectId:'project',taskId:'task',runId:'run-producer',planningVersionId:'plan',planningContentHash:'baseline',acceptanceDigest:'acceptance',artifactId:'artifact',artifactDigest:'artifact-hash',graphRevision:'revision',contractDigest:'contract',policyDigest:completionPolicyDigest(policy),configDigest:'config',baseSha:kind==='code'?'base':null,inputSnapshotDigest:kind==='general'?'input':null,artifactScope:kind==='code'?'workspace':'task_manifest'};
  const quality:QualityProgress={execution:{...dimension('completed'),evidenceSource:'native'},format:dimension(),codeVerification:dimension(),semantic:dimension(),independentReview:dimension(),repair:dimension(),revalidation:dimension(),userApproval:dimension(),evidence:[]};
  const evidence:CompletionEvidence={quality,producer:{binding:{...binding},model:model('producer')},bindings:{},checks:[],commands:[],loops:[],gateResults:[],approvals:[]};
  function add(id:string, kind:'artifact_check'|'verification_check'|'quality_loop'|'user_approval', source:'local'|'native'='local') {
    quality.evidence.push({id,kind,evidenceSource:source,freshness:'current',recordedStatus:kind==='user_approval'?'approved':'passed',binding:{...binding},blockers:[]});
    evidence.bindings[id]={...binding};
  }
  if(kind==='code') for(const gate of CODE_GATES){
    add(gate,'verification_check');
    evidence.commands.push({id:gate,configDigest:'command-config'});
    evidence.checks.push({id:gate,requestId:gate,runId:binding.runId!,projectId:binding.projectId!,workspaceId:binding.artifactId!,taskId:'task',planningVersionId:'plan',planningContentHash:'baseline',acceptanceDigest:'acceptance',commandId:gate,configDigest:'command-config',baseSha:'base',sourceDigest:'artifact-hash',finishedDigest:'artifact-hash',createdAt:'2026-10-29T00:00:00Z',completedAt:'2026-10-29T00:01:00Z',execution:'completed',verdict:'passed',exitCode:0,durationMs:1,output:'',recoveredAt:null,evidenceSource:'local'});
  }
  else {
    for(const gate of ['artifact_format','numeric_source'] as const){add(gate,'artifact_check');evidence.gateResults.push({gate,evidenceId:gate,status:'passed'});}
    add('loop','quality_loop','native');
    quality.semantic=dimension('passed',['loop']);quality.independentReview=dimension('completed',['loop']);
    const review={modelKey:'provider/reviewer',sessionId:'session-reviewer',baselineDigest:'baseline',artifactDigest:'artifact-hash',criteria:[{criterion:'correct',status:'met' as const,evidence:'checked source'}],findings:[]};
    const loop:CompletionLoop={id:'loop',projectId:'project',taskId:'task',sourceRunId:'run-producer',baseline:{id:'plan',digest:'baseline',criteria:['correct']},producer:model('producer'),reviewers:[{id:'reviewer',providerId:'provider',modelId:'reviewer'}],recoveryRequired:false,result:{status:'passed',issue:null,calls:1,repairs:0,artifact:{id:'artifact',digest:'artifact-hash'},rounds:[{number:1,artifact:{id:'artifact',digest:'artifact-hash'},reviews:[{reviewerId:'reviewer',result:review}],failures:[]}]},steps:[{id:'review-step',index:1,kind:'review',state:'completed',requestDigest:'request',startedAt:'start',finishedAt:'finish',issue:null,evidence:model('reviewer'),result:review}],verification:{status:'passed',checkIds:['artifact_format','numeric_source'],issue:null}};
    evidence.loops.push(loop);
  }
  const evaluate=()=>evaluateTaskCompletion(evidence,policy,binding);
  const rebindPolicy=()=>{binding.policyDigest=completionPolicyDigest(policy);evidence.producer!.binding.policyDigest=binding.policyDigest;for(const b of Object.values(evidence.bindings))b.policyDigest=binding.policyDigest;};
  return {policy,binding,evidence,quality,add,evaluate,rebindPolicy};
}
for(const kind of ['code','general'] as const){
  test(`${kind}: complete fake evidence passes permissive policy`,()=>{const f=fixture(kind);assert.equal(f.evaluate().verifiedDone,true);});
  test(`${kind}: wait never releases`,()=>{const f=fixture(kind);f.policy.dependencyRelease='wait';f.rebindPolicy();assert.equal(f.evaluate().qualityPassed,true);assert.equal(f.evaluate().verifiedDone,false);});
}
for(const source of ['mock','unknown'] as const) for(const role of ['producer','reviewer','repair'] as const){
  test(`AX04: ${role} ${source} blocks`,()=>{const f=fixture('general');if(role==='producer')f.evidence.producer!.model.evidenceSource=source;
    else if(role==='reviewer')f.evidence.loops[0].steps[0].evidence!.evidenceSource=source;
    else f.evidence.loops[0].steps.push({id:'repair',index:2,kind:'repair',state:'completed',requestDigest:'r',startedAt:'s',finishedAt:'f',issue:null,evidence:{...model('repair'),evidenceSource:source},result:{artifact:{id:'artifact',digest:'artifact-hash'},evidence:{...model('repair'),evidenceSource:source}}});
    assert.equal(f.evaluate().verifiedDone,false);});
}
for(const field of ['planningContentHash','artifactDigest','configDigest','policyDigest','graphRevision','contractDigest','baseSha'] as const){
  test(`stale ${field} blocks`,()=>{const f=fixture();f.evidence.bindings.unit[field]='old';const r=f.evaluate();assert.equal(r.verifiedDone,false);assert.equal(r.gates.find(g=>g.id==='unit')!.freshness,'stale');});
}
for(const field of ['projectId','taskId','runId','planningVersionId','planningContentHash','acceptanceDigest','artifactId','artifactDigest','graphRevision','contractDigest','policyDigest','configDigest','baseSha'] as const){
  test(`null ${field} is not a wildcard`,()=>{const f=fixture();f.binding[field]=null;f.evidence.bindings.unit[field]=null;assert.equal(f.evaluate().verifiedDone,false);});
}
test('format-only does not imply numeric or semantic pass',()=>{const f=fixture('general');f.evidence.gateResults=f.evidence.gateResults.filter(g=>g.gate==='artifact_format');f.evidence.loops=[];f.quality.semantic=dimension();assert.equal(f.evaluate().verifiedDone,false);});
test('same-model reviewer is not independent',()=>{const f=fixture('general');f.evidence.loops[0].steps[0].evidence!.modelId='producer';assert.equal(f.evaluate().verifiedDone,false);});
test('missing gate blocks',()=>{const f=fixture();f.evidence.checks=f.evidence.checks.filter(c=>c.commandId!=='unit');assert.equal(f.evaluate().verifiedDone,false);});
test('N/A needs explicit approver, reason and time',()=>{for(const field of ['approvedBy','reason','approvedAt'] as const){const f=fixture();f.evidence.checks=[];f.policy.notApplicable=CODE_GATES.map(gate=>({gate,reason:'approved scope',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'}));f.policy.notApplicable[0][field]='';f.rebindPolicy();assert.equal(f.evaluate().verifiedDone,false);}});
test('approved N/A exempts only that gate',()=>{const f=fixture();f.evidence.checks=f.evidence.checks.filter(c=>c.commandId!=='e2e');f.policy.notApplicable=[{gate:'e2e',reason:'no UI',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'}];f.rebindPolicy();assert.equal(f.evaluate().verifiedDone,true);assert.equal(f.evaluate().gates.find(g=>g.id==='e2e')!.status,'not_applicable');});
test('latest failed/running attempt cannot fall back to older success',()=>{for(const execution of ['completed','running'] as const){const f=fixture();const c={...f.evidence.checks[0],id:'latest',createdAt:'2026-10-29T00:02:00Z',execution,verdict:'failed' as const};f.evidence.checks.unshift(c);f.add('latest','verification_check');assert.equal(f.evaluate().verifiedDone,false);}});
test('old stale history does not poison current evidence',()=>{const f=fixture();f.add('old','verification_check');f.quality.evidence.at(-1)!.freshness='stale';assert.equal(f.evaluate().verifiedDone,true);});
test('mock local check is recorded, never passed',()=>{const f=fixture();f.quality.evidence[0].evidenceSource='mock';f.evidence.checks[0].evidenceSource='mock';const r=f.evaluate();assert.equal(r.gates[0].status,'recorded');assert.equal(r.verifiedDone,false);});
test('command configuration mismatch blocks',()=>{const f=fixture();f.evidence.commands[0].configDigest='changed';assert.equal(f.evaluate().verifiedDone,false);});
test('policy tampering without digest update blocks',()=>{const f=fixture();f.policy.requiredGates=['lint'];assert.equal(f.evaluate().verifiedDone,false);});
test('empty required gates cannot vacuously pass',()=>{const f=fixture();f.policy.requiredGates=[];f.rebindPolicy();assert.equal(f.evaluate().verifiedDone,false);});
test('code independent review is optional but enforced when required',()=>{const f=fixture();f.policy.requireIndependentReview=true;f.rebindPolicy();assert.equal(f.evaluate().verifiedDone,false);});
test('approval remains separate and required release blocks missing approval',()=>{const f=fixture();f.policy.dependencyRelease='quality_passed_and_user_approval';f.rebindPolicy();const r=f.evaluate();assert.equal(r.qualityPassed,true);assert.equal(r.verifiedDone,false);});
test('repair completion alone cannot replace revalidation',()=>{const f=fixture('general');f.quality.repair=dimension('completed',['loop']);f.evidence.loops[0].result.repairs=1;assert.equal(f.evaluate().verifiedDone,false);});
test('numeric unverified cannot inherit artifact pass',()=>{const f=fixture('general');f.evidence.gateResults[1].status='unknown';assert.equal(f.evaluate().verifiedDone,false);});
test('pure, deterministic output and sorted unique reasons',()=>{const f=fixture();f.evidence.checks=[];const before=structuredClone(f.evidence);const a=f.evaluate();assert.deepEqual(a,f.evaluate());assert.deepEqual(a.reasonCodes,[...new Set(a.reasonCodes)].sort());assert.deepEqual(f.evidence,before);});
function approve(f:ReturnType<typeof fixture>){
  f.add('approval','user_approval');f.quality.userApproval=dimension('passed',['approval']);f.evidence.checkSetDigest='set';
  f.evidence.approvals.push({id:'approval',requestId:'approval',runId:f.binding.runId!,workspaceId:f.binding.artifactId!,sourceDigest:f.binding.artifactDigest!,checkSetDigest:'set',createdAt:'2026-10-29T00:03:00Z'});
  f.policy.dependencyRelease='quality_passed_and_user_approval';f.rebindPolicy();
}
test('current code approval releases, stale check set does not',()=>{const f=fixture();approve(f);assert.equal(f.evaluate().verifiedDone,true);f.evidence.checkSetDigest='new-set';assert.equal(f.evaluate().verifiedDone,false);});
test('general approval remains unsupported; permissive policy alone allows general completion',()=>{const f=fixture('general');approve(f);assert.equal(f.evaluate().qualityPassed,true);assert.equal(f.evaluate().verifiedDone,false);});
function repaired(){
  const f=fixture('general'),l=f.evidence.loops[0];l.result.repairs=1;
  l.steps[0].index=3;
  l.steps.unshift({id:'repair',index:1,kind:'repair',state:'completed',requestDigest:'r',startedAt:'s',finishedAt:'f',issue:null,evidence:model('repair'),result:{artifact:{id:'artifact',digest:'artifact-hash'},evidence:model('repair')}});
  l.steps.push({id:'verify',index:4,kind:'verification',state:'completed',requestDigest:'v',startedAt:'s',finishedAt:'f',issue:null,evidence:null,result:{status:'passed',checkIds:['artifact_format','numeric_source'],issue:null}});
  f.quality.repair=dimension('completed',['loop']);f.quality.revalidation=dimension('passed',['loop']);return f;
}
test('repaired artifact with fresh review and all checks passes',()=>{assert.equal(repaired().evaluate().verifiedDone,true);});
test('post-repair check subset blocks',()=>{const f=repaired();const result=f.evidence.loops[0].steps.at(-1)!.result!;if('checkIds' in result)result.checkIds=['artifact_format'];assert.equal(f.evaluate().verifiedDone,false);});
test('pre-repair review cannot count on same artifact hash',()=>{const f=repaired();f.evidence.loops[0].steps[1].index=0;assert.equal(f.evaluate().verifiedDone,false);});
test('unselected older loop cannot hide latest failed review',()=>{const f=fixture('general');f.add('new-loop','quality_loop','native');f.quality.semantic=dimension('failed',['new-loop']);assert.equal(f.evaluate().verifiedDone,false);});
test('collector independent review blockers remain authoritative',()=>{const f=fixture('general');f.quality.independentReview.blockers=['QUALITY_REVIEW_EVIDENCE_MISSING'];assert.equal(f.evaluate().verifiedDone,false);});
test('optional code review cannot erase observed mock reviewer',()=>{const f=fixture(),g=fixture('general');f.add('loop','quality_loop','native');f.evidence.loops=g.evidence.loops;f.evidence.loops[0].steps[0].evidence!.evidenceSource='mock';f.quality.independentReview=dimension('completed',['loop']);assert.equal(f.evaluate().verifiedDone,false);});
test('numeric latest attempt selected by collector order, not supplemental order',()=>{const f=fixture('general');f.add('new-numeric','artifact_check');f.evidence.gateResults.unshift({gate:'numeric_source',evidenceId:'new-numeric',status:'failed'});assert.equal(f.evaluate().verifiedDone,false);});
test('observed source without observed model blocks all AI roles',()=>{for(const role of ['producer','reviewer','repair']){const f=role==='repair'?repaired():fixture('general');const m=role==='producer'?f.evidence.producer!.model:f.evidence.loops[0].steps.find(s=>s.kind===(role==='reviewer'?'review':'repair'))!.evidence!;m.source='unknown';assert.equal(f.evaluate().verifiedDone,false);}});
test('general inventory must not be treated as a task manifest',()=>{const f=fixture('general');f.binding.artifactScope='workspace';assert.equal(f.evaluate().verifiedDone,false);});
test('general input snapshot missing blocks',()=>{const f=fixture('general');f.binding.inputSnapshotDigest=null;assert.equal(f.evaluate().verifiedDone,false);});
test('missing supplement or original null cannot be backfilled',()=>{for(const mode of ['supplement','original']){const f=fixture();if(mode==='supplement')delete f.evidence.bindings.lint;else f.quality.evidence[0].binding.acceptanceDigest=null;assert.equal(f.evaluate().verifiedDone,false);}});
test('policy digest stable across object key and command ordering',()=>{const f=fixture();f.policy.gateCommandMap.lint=['b','a'];const a=completionPolicyDigest(f.policy);f.policy.requiredGates.reverse();f.policy.gateCommandMap.lint.reverse();assert.equal(completionPolicyDigest(f.policy),a);});
test('mock review is recorded with mock source, never passed',()=>{const f=fixture('general');f.quality.evidence.find(e=>e.id==='loop')!.evidenceSource='mock';const r=f.evaluate();assert.equal(r.gates.find(g=>g.id==='semantic_review')!.status,'recorded');assert.equal(r.verifiedDone,false);});
test('review observation cannot be native when step provenance is unknown',()=>{const f=fixture('general');f.evidence.loops[0].steps[0].evidence!.evidenceSource='unknown';const r=f.evaluate();assert.equal(r.independentReview.source,'unknown');assert.equal(r.independentReview.status,'recorded');});

// Candidate local checks and native source observations are independent fixtures.
async function candidateFixture(){
  const {evaluateCandidateCompletion}=await import('../server/task-completion.ts');
  assert.equal(typeof evaluateCandidateCompletion,'function','candidate evaluator must be separate from task evaluator');
  const source=fixture(),candidate=fixture();
  candidate.evidence.producer=undefined;candidate.quality.execution.evidenceSource='local';
  const subject={subject:'integration_candidate' as const,producer:'orbit_merge' as const,integrationId:candidate.binding.artifactId!,candidateDigest:candidate.binding.artifactDigest!,targetDigest:candidate.binding.baseSha,sourceBinding:{...source.binding}};
  return {source,candidate,subject,evaluate:()=>evaluateCandidateCompletion(candidate.evidence,candidate.policy,candidate.binding,subject,source.evaluate())};
}
test('candidate: local gates plus CQG-1 source passes without an AI candidate producer',async()=>{
  const f=await candidateFixture(),before=structuredClone(f.candidate.evidence);
  assert.equal(f.evaluate().verifiedDone,true);assert.equal(f.candidate.evaluate().verifiedDone,false);
  assert.deepEqual(f.candidate.evidence,before);assert.deepEqual(f.evaluate(),f.evaluate());
});
for(const defect of ['mock','unknown','stale','format-only','base mismatch','manifest mismatch','missing gate','stale gate','native gate','worker only'] as const){
  test(`candidate: refuses ${defect}`,async()=>{
    const f=await candidateFixture();
    if(defect==='mock')f.source.evidence.producer!.model.evidenceSource='mock';
    if(defect==='unknown')f.source.evidence.producer!.model.modelId=null;
    if(defect==='stale')f.source.evidence.bindings.unit.artifactDigest='old';
    if(defect==='format-only')f.source.evidence.checks=[];
    if(defect==='base mismatch')f.subject.sourceBinding.baseSha='other';
    if(defect==='manifest mismatch')f.subject.sourceBinding.artifactDigest='other';
    if(defect==='missing gate'||defect==='worker only')f.candidate.evidence.checks=[];
    if(defect==='stale gate')f.candidate.evidence.bindings.unit.artifactDigest='old';
    if(defect==='native gate')f.candidate.quality.evidence[0].evidenceSource='native';
    assert.equal(f.evaluate().verifiedDone,false);
  });
}
for(const defect of ['none','format-only source','native semantic','missing semantic'] as const)test(`general candidate: ${defect}`,async()=>{
 const {evaluateCandidateCompletion}=await import('../server/task-completion.ts');
 const source=fixture('general'),candidate=fixture('general');
 const evidence:import('../shared/task-completion.ts').CandidateCompletionEvidence=structuredClone(candidate.evidence);
 evidence.producer=undefined;evidence.loops=[];evidence.quality.execution.evidenceSource='local';
 evidence.quality.independentReview=dimension();evidence.quality.semantic=dimension();
 evidence.quality.evidence=evidence.quality.evidence.filter(e=>e.kind!=='quality_loop');
 evidence.bindings.semantic={...candidate.binding};
 evidence.quality.evidence.push({id:'semantic',kind:'artifact_check',binding:{...candidate.binding},evidenceSource:defect==='native semantic'?'native':'local',freshness:'current',recordedStatus:'passed',blockers:[]});
 if(defect!=='missing semantic')evidence.gateResults.push({gate:'semantic_review',evidenceId:'semantic',status:'passed'});
 if(defect==='format-only source'){source.evidence.gateResults=source.evidence.gateResults.filter(g=>g.gate==='artifact_format');source.evidence.loops=[];}
 const result=evaluateCandidateCompletion(evidence,candidate.policy,candidate.binding,{subject:'integration_candidate',producer:'orbit_merge',integrationId:candidate.binding.artifactId!,candidateDigest:candidate.binding.artifactDigest!,targetDigest:null,sourceBinding:source.binding},source.evaluate());
 assert.equal(result.verifiedDone,defect==='none');
});
