import test from 'node:test';
import assert from 'node:assert/strict';
import {EXECUTION_MODES,validateExecutionBudget,evaluateExecutionModeLaunch,validateRaceCandidates,compareRaceCandidates,
  type ExecutionBudget,type ExecutionModeLaunchFacts,type RaceCandidate,type RaceCandidateResult,type RaceCheckEvidence} from '../shared/execution-modes.ts';

const hash=(character:string)=>character.repeat(64);
function budget(billing:'subscription'|'api'='subscription'):ExecutionBudget{return {billing,maxTurns:4,turnsUsed:0,maxAttempts:2,attemptsUsed:0,
  maxIterations:3,iterationsUsed:0,maxDurationMs:120000,elapsedMs:0,maxTokens:10000,tokensUsed:0,tokenLimitEnforced:true,
  maxCostMicros:billing==='api'?100000:null,costUsedMicros:billing==='api'?0:null,costLimitEnforced:billing==='api',subscriptionQuota:billing==='subscription'?'available':null};}
function facts():ExecutionModeLaunchFacts{return {providerId:'codex',providerReady:true,currentPlanApproved:true,unresolvedQuestions:0,workspaceValidated:true,
  writeEnabled:true,policyValidated:true,mcpIsolated:true,networkAccess:false,shell:false,approval:'deny',budget:budget()};}
function pair():RaceCandidate[]{return ['a','b'].map((id,index)=>({candidateId:id,projectId:'project-1',planningVersionId:'plan-1',worktreeId:'worktree-'+id,
  canonicalPath:'C:\\Orbit\\'+id,pathStyle:'win32' as const,workspaceVerified:true,canonicalPathVerified:true,currentPlanApproved:true,
  baseSha:'a'.repeat(40),approvedRequirementHash:hash('1'),testSuiteHash:hash('2'),e2eSuiteHash:hash('3'),sourceDigest:hash(index?'5':'4')}));}
function results():(Omit<RaceCandidateResult,'evidence'>&{evidence:RaceCheckEvidence[]})[]{return pair().map(candidate=>({...candidate,agentReportedComplete:true,durationMs:100,tokensUsed:null,costMicros:null,
  evidence:(['tests','e2e'] as const).map(kind=>({kind,origin:'server-runner',runId:candidate.candidateId+'-'+kind,worktreeId:candidate.worktreeId,
    projectId:candidate.projectId,execution:'completed',exitCode:0,sourceDigest:candidate.sourceDigest,
    suiteHash:kind==='tests'?candidate.testSuiteHash:candidate.e2eSuiteHash,evidenceDigest:hash(kind==='tests'?'6':'7')}))}));}

test('six immutable modes advertise only Solo as connected and keep human approval in every mode',()=>{
  assert.deepEqual(EXECUTION_MODES.map(mode=>mode.name),['Solo','Cross Review','Debate','Race','Cooperate','Goal']);
  for(const mode of EXECUTION_MODES){assert.equal(mode.connection,mode.id==='solo'?'existing_codex_runner':'not_connected');assert.ok(Object.isFrozen(mode));
    assert.ok(mode.roles.some(role=>role.actor==='human'&&role.permission==='approve'));assert.ok(mode.requirements.length);assert.ok(mode.completion.length);}
  assert.ok(Object.isFrozen(EXECUTION_MODES));
});

test('Solo launch requires existing Codex policy, a current approved plan and an enforceable finite budget',()=>{
  assert.deepEqual(evaluateExecutionModeLaunch('solo',facts()),{ok:true});
  for(const patch of [{providerId:'claude'},{providerReady:false},{currentPlanApproved:false},{unresolvedQuestions:1},{workspaceValidated:false},
    {writeEnabled:false},{policyValidated:false},{mcpIsolated:false},{networkAccess:true},{shell:true},{approval:'allow' as const}])
    assert.equal(evaluateExecutionModeLaunch('solo',{...facts(),...patch}).ok,false);
  assert.deepEqual(evaluateExecutionModeLaunch('solo',{...facts(),budget:{...budget(),maxTokens:null}}),{ok:false,code:'BUDGET_UNKNOWN'});
});

test('unconnected modes cannot become executable through optimistic provider facts',()=>{
  for(const mode of ['cross_review','debate','race','cooperate','goal'] as const)assert.deepEqual(evaluateExecutionModeLaunch(mode,facts()),{ok:false,code:'MODE_NOT_CONNECTED'});
  assert.deepEqual(evaluateExecutionModeLaunch('invented' as never,facts()),{ok:false,code:'UNKNOWN_EXECUTION_MODE'});
});

test('subscription and API budgets distinguish missing quota or cost evidence from zero usage',()=>{
  assert.deepEqual(validateExecutionBudget(budget()),{ok:true});assert.deepEqual(validateExecutionBudget(budget('api')),{ok:true});
  assert.deepEqual(validateExecutionBudget({...budget(),subscriptionQuota:'unknown'}),{ok:false,code:'BUDGET_UNKNOWN'});
  assert.deepEqual(validateExecutionBudget({...budget(),subscriptionQuota:'exhausted'}),{ok:false,code:'BUDGET_EXHAUSTED'});
  assert.deepEqual(validateExecutionBudget({...budget('api'),costUsedMicros:null}),{ok:false,code:'BUDGET_UNKNOWN'});
  assert.deepEqual(validateExecutionBudget({...budget('api'),maxCostMicros:null}),{ok:false,code:'BUDGET_UNKNOWN'});
  assert.deepEqual(validateExecutionBudget({...budget(),tokenLimitEnforced:false}),{ok:false,code:'BUDGET_UNENFORCEABLE'});
  assert.deepEqual(validateExecutionBudget({...budget('api'),costLimitEnforced:false}),{ok:false,code:'BUDGET_UNENFORCEABLE'});
});

test('unknown, invalid or exhausted call, retry, iteration, time and token ceilings never mean unlimited',()=>{
  const counters=[['maxTurns','turnsUsed'],['maxAttempts','attemptsUsed'],['maxIterations','iterationsUsed'],['maxDurationMs','elapsedMs'],['maxTokens','tokensUsed']] as const;
  for(const [maximum,used] of counters){
    for(const patch of [{[maximum]:null},{[used]:null}])assert.deepEqual(validateExecutionBudget({...budget(),...patch}),{ok:false,code:'BUDGET_UNKNOWN'});
    for(const value of [0,-1,Infinity,NaN,1.5])assert.deepEqual(validateExecutionBudget({...budget(),[maximum]:value}),{ok:false,code:'BUDGET_INVALID'});
    assert.deepEqual(validateExecutionBudget({...budget(),[used]:budget()[maximum]}),{ok:false,code:'BUDGET_EXHAUSTED'});
  }
  assert.deepEqual(validateExecutionBudget({...budget('api'),costUsedMicros:100000}),{ok:false,code:'BUDGET_EXHAUSTED'});
});

test('Race accepts distinct verified worktrees with equal project and frozen requirement and suite identities',()=>{
  const candidates=pair();assert.notEqual(candidates[0].sourceDigest,candidates[1].sourceDigest);assert.deepEqual(validateRaceCandidates(candidates),{ok:true});
  for(const key of ['projectId','planningVersionId','baseSha','approvedRequirementHash','testSuiteHash','e2eSuiteHash'] as const){
    const changed=pair();changed[1][key]=key.endsWith('Hash')?hash('8'):key==='baseSha'?'b'.repeat(40):'other';
    assert.equal(validateRaceCandidates(changed).ok,false,key);
  }
});

test('Race rejects identical, case-aliased, nested, noncanonical or unverified worktree facts',()=>{
  for(const patch of [{worktreeId:'worktree-a'},{canonicalPath:'c:/ORBIT/A'},{canonicalPath:'C:\\Orbit\\a\\child'},
    {canonicalPath:'C:\\Orbit\\a\\..\\b'},{canonicalPathVerified:false},{workspaceVerified:false},{candidateId:'a'}]){
    const candidates=pair();Object.assign(candidates[1],patch);assert.equal(validateRaceCandidates(candidates).ok,false);
  }
  assert.equal(validateRaceCandidates(pair().slice(0,1)).ok,false);assert.equal(validateRaceCandidates([...pair(),pair()[0]]).ok,false);
});

test('Race compares tests and E2E against each candidate own source rather than requiring equal solution digests',()=>{
  const candidates=results();candidates[1].evidence[1]={...candidates[1].evidence[1],exitCode:1};
  assert.deepEqual(compareRaceCandidates(candidates),{status:'comparable',outcome:'winner',winnerId:'a'});
  candidates[0].evidence[0]={...candidates[0].evidence[0],sourceDigest:candidates[1].sourceDigest};
  assert.equal(compareRaceCandidates(candidates).status,'incomparable');
});

test('missing, stale, non-server, interrupted or digestless test and E2E evidence is incomparable',()=>{
  for(const patch of [{execution:'not_run'},{execution:'interrupted'},{exitCode:null},{sourceDigest:hash('9')},{suiteHash:hash('9')},
    {evidenceDigest:''},{origin:'agent'},{worktreeId:'foreign-worktree'},{projectId:'foreign-project'}]){
    const candidates=results();candidates[0].evidence[0]={...candidates[0].evidence[0],...patch} as RaceCheckEvidence;
    assert.equal(compareRaceCandidates(candidates).status,'incomparable');
  }
  const missing=results();missing[0].evidence=[];assert.equal(compareRaceCandidates(missing).status,'incomparable');
  const noE2e=results();noE2e[1].evidence=noE2e[1].evidence.slice(0,1);assert.equal(compareRaceCandidates(noE2e).status,'incomparable');
});

test('agent success, elapsed time, tokens and price cannot break a verification tie or crown a failed result',()=>{
  const candidates=results();candidates[0].durationMs=1;candidates[1].durationMs=10000;candidates[0].agentReportedComplete=false;
  candidates[0].tokensUsed=10;candidates[1].tokensUsed=1000;candidates[0].costMicros=1;candidates[1].costMicros=1000;
  assert.deepEqual(compareRaceCandidates(candidates),{status:'comparable',outcome:'tie',winnerId:null});
  for(const candidate of candidates){candidate.evidence[0]={...candidate.evidence[0],exitCode:1};candidate.agentReportedComplete=true;}
  assert.deepEqual(compareRaceCandidates(candidates),{status:'comparable',outcome:'no_winner',winnerId:null});
  candidates[1].evidence[0]={...candidates[1].evidence[0],exitCode:0};candidates[1].agentReportedComplete=false;
  assert.deepEqual(compareRaceCandidates(candidates),{status:'comparable',outcome:'winner',winnerId:'b'});
});

test('Race requires current server-verified plan approval rather than a hash-shaped draft identity',()=>{
  const candidates=pair();Object.assign(candidates[1],{currentPlanApproved:false});
  assert.deepEqual(validateRaceCandidates(candidates),{ok:false,code:'RACE_PLAN_NOT_APPROVED'});
});

test('reused runner IDs and duplicate suite evidence stay incomparable even for identical solution sources',()=>{
  const repeated=results();repeated[1].evidence[0]={...repeated[1].evidence[0],runId:repeated[0].evidence[0].runId};
  assert.equal(compareRaceCandidates(repeated).status,'incomparable');
  const duplicate=results();duplicate[0].evidence[1]={...duplicate[0].evidence[0],runId:'another-tests-run'};
  assert.equal(compareRaceCandidates(duplicate).status,'incomparable');
  const identical=results();identical[1].sourceDigest=identical[0].sourceDigest;
  identical[1].evidence=identical[1].evidence.map(check=>({...check,sourceDigest:identical[1].sourceDigest}));
  const before=structuredClone(identical);assert.deepEqual(compareRaceCandidates(identical),{status:'comparable',outcome:'tie',winnerId:null});assert.deepEqual(identical,before);
});
