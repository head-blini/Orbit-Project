import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {
  FAILURE_CODE_TABLE, classify, familyTuple, groupFamilies, normalizeCode, ruleHypotheses,
  type FailureCategory, type FailureObservation, type FailureSource,
} from '../shared/failure-intelligence.ts';
import {familyId} from '../server/failure-fingerprint.ts';

const sources:FailureSource[]=['run','check','quality','integration','worker','capability'];
const categories:FailureCategory[]=['tool_environment','policy_refusal','quota_capacity','auth','output_rejected','unknown'];
const observation=(id:string, extra:Partial<FailureObservation>={}):FailureObservation=>({
  id,recordId:id,projectId:'project',taskId:'task',runId:'run-'+id,requestId:'request-'+id,
  source:'quality',code:'QUALITY_EVIDENCE_INVALID',category:'output_rejected',
  evidenceSource:'native',at:'2026-10-29T00:00:00.000Z',bindingDigest:'a'.repeat(64),
  commandIdOrGate:'semantic_review',runtime:'claude-code',qualityLoopId:'loop-'+id,...extra,
});

test('normalization rejects noncodes without coercion or trimming',()=>{
  for(const value of [null,undefined,12,{},['LOGIN_REQUIRED'],'','login_required','LOGIN_REQUIRED\n',' LOGIN_REQUIRED','ERROR_1','/private/file','raw response']) {
    assert.equal(normalizeCode(value),'UNCLASSIFIED');
  }
  assert.equal(normalizeCode({toString(){throw Error('must not coerce');}}),'UNCLASSIFIED');
  assert.equal(normalizeCode('LOGIN_REQUIRED'),'LOGIN_REQUIRED');
  assert.equal(normalizeCode('_'),'_');
});

const cases:[FailureSource,string,FailureCategory][]=[
  ['run','RUNTIME_NOT_STARTED','tool_environment'],['run','EXIT_NOT_OBSERVED','tool_environment'],
  ['run','SERVER_RESTART','tool_environment'],['run','RESULT_NOT_OBSERVED','unknown'],
  ['run','RUNTIME_ERROR','unknown'],['run','LOGIN_REQUIRED','auth'],['run','QUOTA_EXHAUSTED','quota_capacity'],
  ['check','FAILED','unknown'],['check','TIMED_OUT','unknown'],
  ['quality','QUALITY_EVIDENCE_INVALID','output_rejected'],['quality','QUALITY_REPAIR_EVIDENCE_INVALID','output_rejected'],
  ['quality','QUALITY_PERMISSION_DENIED','policy_refusal'],['quality','QUALITY_EVIDENCE_BLOCKED','policy_refusal'],
  ['quality','QUALITY_QUOTA_EXHAUSTED','quota_capacity'],['quality','QUALITY_EXECUTION_LOST','tool_environment'],
  ['quality','QUALITY_PROCESS_STOP_UNCONFIRMED','tool_environment'],['quality','QUALITY_STEP_FAILED','unknown'],
  ['quality','QUALITY_CALL_OR_TIME_LIMIT','unknown'],['quality','QUALITY_REPAIR_OR_CALL_LIMIT','unknown'],
  ['integration','INTEGRATION_VERIFICATION_FAILED','output_rejected'],
  ['integration','INTEGRATION_SCOPE','policy_refusal'],['integration','INTEGRATION_PROTECTED_VERIFICATION_FILE','policy_refusal'],
  ['integration','INTEGRATION_APPLY_UNCERTAIN','tool_environment'],['integration','INTEGRATION_CANDIDATE_REFUSED','unknown'],
  ['worker','INTEGRATION_BASELINE_CHANGED','policy_refusal'],['worker','LOST_UNKNOWN','tool_environment'],
  ['capability','CAPABILITY_BLOCKED','policy_refusal'],['capability','RUNTIME_VERSION_UNSUPPORTED','tool_environment'],
  ['capability','EXECUTION_PREFLIGHT_CHANGED','policy_refusal'],['capability','EXECUTION_DISPATCH_UNCONFIRMED','tool_environment'],
];
for(const [source,code,expected] of cases) test(`${source}/${code} has one conservative category`,()=>{
  assert.equal(classify(source,code,{output:'ignored',reason:'LOGIN_REQUIRED'}),expected);
});

test('static table is source scoped, immutable, and returns only one allowed category',()=>{
  assert.deepEqual(Object.keys(FAILURE_CODE_TABLE).sort(),[...sources].sort());
  assert.ok(Object.isFrozen(FAILURE_CODE_TABLE));
  for(const source of sources){
    assert.ok(Object.isFrozen(FAILURE_CODE_TABLE[source]));
    for(const [code,category] of Object.entries(FAILURE_CODE_TABLE[source])){
      assert.equal(normalizeCode(code),code);
      assert.ok(categories.includes(category));
      assert.equal(classify(source,code),category);
      assert.notEqual(category as string,'model_mistake');
    }
    for(const code of ['NEW_FAILURE','MODEL_MISTAKE','constructor','__proto__','raw text'])assert.equal(classify(source,code),'unknown');
  }
  assert.equal(classify('check','LOGIN_REQUIRED',{category:'auth',exitCode:1,verdict:'failed'}),'unknown');
  assert.equal(classify('run','QUALITY_EVIDENCE_INVALID'),'unknown');
});

test('all literal failure codes in the cited quality, integration and capability producers have explicit entries',()=>{
  const files={quality:'quality-loop.ts',integration:'integration-queue.ts',capability:'capability-execution.ts'} as const;
  for(const [source,file] of Object.entries(files)){
    const code=readFileSync(new URL('../server/'+file,import.meta.url),'utf8');
    const emitted=[...code.matchAll(/'([A-Z][A-Z_]+)'/g)].map(match=>match[1]);
    assert.ok(emitted.length>0);
    for(const reason of emitted)assert.ok(Object.hasOwn(FAILURE_CODE_TABLE[source as FailureSource],reason),`${source}/${reason} missing`);
  }
});

test('fingerprint uses the fixed JSON tuple and SHA-256, stable across calls',()=>{
  const tuple=familyTuple('output_rejected','QUALITY_EVIDENCE_INVALID','quality','semantic_review','claude-code');
  assert.deepEqual(tuple,['output_rejected','QUALITY_EVIDENCE_INVALID','quality','semantic_review','claude-code'] as const);
  const expected=createHash('sha256').update('["output_rejected","QUALITY_EVIDENCE_INVALID","quality","semantic_review","claude-code"]').digest('hex');
  assert.equal(familyId(...tuple),expected);
  assert.equal(familyId(...tuple),familyId(...tuple));
  assert.match(expected,/^[a-f0-9]{64}$/);
  const variants=[
    familyId('unknown',tuple[1],tuple[2],tuple[3],tuple[4]),
    familyId(tuple[0],'OTHER_CODE',tuple[2],tuple[3],tuple[4]),
    familyId(tuple[0],tuple[1],'check',tuple[3],tuple[4]),
    familyId(tuple[0],tuple[1],tuple[2],'unit',tuple[4]),
    familyId(tuple[0],tuple[1],tuple[2],tuple[3],'codex'),
  ];
  assert.equal(new Set([expected,...variants]).size,6);
  assert.equal(familyId('unknown','bad text','run'),familyId('unknown','UNCLASSIFIED','run',null,null));
  assert.notEqual(familyId('unknown','A','run','ab','c'),familyId('unknown','A','run','a','bc'));
});

test('grouping separates mock, unknown, and native/local counts, deduplicates ids, and never mutates input',()=>{
  const input=[observation('a'),observation('b',{evidenceSource:'mock'}),observation('c',{evidenceSource:'local'}),observation('d',{evidenceSource:'unknown'}),observation('a')];
  const before=structuredClone(input);
  const [family]=groupFamilies(input);
  assert.equal(family.realCount,2);assert.equal(family.mockCount,1);assert.equal(family.unknownCount,1);
  assert.deepEqual(family.evidenceIds,['a','b','c','d']);
  assert.deepEqual(input,before);
  assert.deepEqual(groupFamilies([...input].reverse()),groupFamilies(input));
  assert.equal(groupFamilies([observation('a'),observation('b',{runtime:'codex'})]).length,2);
  assert.equal(groupFamilies([observation('a'),observation('b',{commandIdOrGate:'unit'})]).length,2);
  assert.equal(groupFamilies([observation('a'),observation('b',{projectId:'other'})]).length,2);
});

test('two independent runtimes yield an environment/spec hypothesis with evidence',()=>{
  const hypotheses=ruleHypotheses(groupFamilies([observation('a'),observation('b',{runtime:'codex'})]));
  assert.equal(hypotheses.length,1);
  assert.match(hypotheses[0].statement,/environment or specification/);
  assert.deepEqual(hypotheses[0].evidence,['a','b']);
  assert.deepEqual(hypotheses[0].counterEvidence,[]);
  assert.equal(hypotheses[0].kind,'hypothesis');assert.equal(hypotheses[0].confidence,'rule');
});

test('only one observed runtime yields a tentative model-or-adapter hypothesis',()=>{
  const hypotheses=ruleHypotheses(groupFamilies([observation('a'),observation('b')]));
  assert.equal(hypotheses.length,1);assert.match(hypotheses[0].statement,/model or adapter/);
  for(const h of hypotheses){assert.equal(h.kind,'hypothesis');assert.equal(h.confidence,'rule');assert.ok(h.evidence.length>=2);}
});

test('mock/unknown, repeated run/request, same quality loop, and missing metadata cannot prove repetition',()=>{
  for(const extra of [
    {evidenceSource:'mock' as const},{evidenceSource:'unknown' as const},
    {runId:'run-a'},{requestId:'request-a'},{runId:undefined},{requestId:undefined},
    {runtime:undefined},{runtime:'unknown'},{qualityLoopId:undefined},{bindingDigest:'b'.repeat(64)},{taskId:'other'},
  ]) assert.deepEqual(ruleHypotheses(groupFamilies([observation('a'),observation('b',extra)])),[]);
  assert.deepEqual(ruleHypotheses(groupFamilies([observation('a',{qualityLoopId:'loop'}),observation('b',{qualityLoopId:'loop',runtime:'codex'})])),[]);
  assert.deepEqual(ruleHypotheses(groupFamilies([observation('a')])),[]);
  assert.deepEqual(ruleHypotheses(groupFamilies([])),[]);
});

test('source facts and model attribution remain separate; unrecognized failures yield no cause hypothesis',()=>{
  const records=[observation('a',{code:'NEW_FAILURE'}),observation('b',{code:'NEW_FAILURE'})];
  const families=groupFamilies(records);
  assert.equal(families[0].tuple[0],'unknown');
  assert.deepEqual(ruleHypotheses(families),[]);
  assert.equal(groupFamilies([observation('a')])[0].tuple[0],'output_rejected');
});

test('raw prompt, response, check output, review/evidence text and paths never pass through',()=>{
  const secret='raw private material /private/person/file.txt';
  const input=[observation('a'),observation('b',{runtime:'codex'})].map(record=>Object.assign(record,{
    prompt:secret,response:secret,output:secret,evidence:secret,review:secret,artifact:secret,path:secret,
  }));
  const families=groupFamilies(input),hypotheses=ruleHypotheses(families);
  assert.ok(hypotheses.length);
  assert.ok(!JSON.stringify({families,hypotheses}).includes(secret));
  assert.deepEqual(groupFamilies(input),groupFamilies([observation('a'),observation('b',{runtime:'codex'})]));
  assert.equal(classify('run',secret,{reason:secret}),'unknown');
});
