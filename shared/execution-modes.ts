export type ExecutionMode='solo'|'cross_review'|'debate'|'race'|'cooperate'|'goal';
export interface ExecutionModeDefinition {
  id:ExecutionMode;name:string;connection:'existing_codex_runner'|'not_connected';
  requirements:readonly string[];
  roles:readonly {id:string;actor:'agent'|'server'|'human';permission:'isolated-write'|'read-only'|'approve'}[];
  nativeReuse:readonly string[];completion:readonly string[];
}
export interface ExecutionBudget {
  billing:'subscription'|'api';
  maxTurns:number|null;turnsUsed:number|null;maxAttempts:number|null;attemptsUsed:number|null;
  maxIterations:number|null;iterationsUsed:number|null;maxDurationMs:number|null;elapsedMs:number|null;
  maxTokens:number|null;tokensUsed:number|null;tokenLimitEnforced:boolean;
  maxCostMicros:number|null;costUsedMicros:number|null;costLimitEnforced:boolean;
  subscriptionQuota:'available'|'exhausted'|'unknown'|null;
}
export type ContractDecision={ok:true}|{ok:false;code:string};
export interface ExecutionModeLaunchFacts {
  providerId:string;providerReady:boolean;currentPlanApproved:boolean;unresolvedQuestions:number;
  workspaceValidated:boolean;writeEnabled:boolean;policyValidated:boolean;mcpIsolated:boolean;
  networkAccess:boolean;shell:boolean;approval:'deny'|'allow';budget:ExecutionBudget;
}
export interface RaceCandidate {
  candidateId:string;projectId:string;planningVersionId:string;worktreeId:string;
  canonicalPath:string;pathStyle:'win32'|'posix';workspaceVerified:boolean;canonicalPathVerified:boolean;currentPlanApproved:boolean;
  baseSha:string;approvedRequirementHash:string;testSuiteHash:string;e2eSuiteHash:string;sourceDigest:string;
}
export interface RaceCheckEvidence {
  kind:'tests'|'e2e';origin:'server-runner';runId:string;worktreeId:string;projectId:string;
  execution:'completed'|'not_run'|'interrupted'|'lost';exitCode:number|null;
  sourceDigest:string;suiteHash:string;evidenceDigest:string;
}
export interface RaceCandidateResult extends RaceCandidate {
  agentReportedComplete:boolean;durationMs:number|null;tokensUsed:number|null;costMicros:number|null;
  evidence:readonly RaceCheckEvidence[];
}
export type RaceComparison={status:'incomparable';code:string}|{status:'comparable';outcome:'winner';winnerId:string}
  |{status:'comparable';outcome:'tie'|'no_winner';winnerId:null};
const approval={id:'approval',actor:'human',permission:'approve'} as const;
function definition(value:ExecutionModeDefinition):ExecutionModeDefinition {
  return Object.freeze({...value,requirements:Object.freeze([...value.requirements]),roles:Object.freeze(value.roles.map(role=>Object.freeze({...role}))),
    nativeReuse:Object.freeze([...value.nativeReuse]),completion:Object.freeze([...value.completion])});
}
export const ORBIT_NATIVE_EXECUTION_FEATURES=Object.freeze({hooks:false,multiAgent:false,goal:false});
export const EXECUTION_MODES:readonly ExecutionModeDefinition[]=Object.freeze([
  definition({id:'solo',name:'Solo',connection:'existing_codex_runner',requirements:['current-approved-plan','one-ready-codex-provider','validated-worktree','finite-enforceable-budget'],
    roles:[{id:'implementer',actor:'agent',permission:'isolated-write'},approval],nativeReuse:['app-server-thread-turn-interrupt'],
    completion:['actual-configured-checks','human-review','explicit-human-approval','no-automatic-merge']}),
  definition({id:'cross_review',name:'Cross Review',connection:'not_connected',requirements:['solo-requirements','frozen-base-head','review-capability','separate-review-session'],
    roles:[{id:'implementer',actor:'agent',permission:'isolated-write'},{id:'reviewer',actor:'agent',permission:'read-only'},approval],nativeReuse:['app-server-review-when-validated','same-provider-new-session-or-cross-provider'],
    completion:['review-origin-recorded','findings-resolved-or-human-disposition','actual-reverification','explicit-human-approval']}),
  definition({id:'debate',name:'Debate',connection:'not_connected',requirements:['current-approved-topic','bounded-rounds','read-only-participants','explicit-disagreement-record'],
    roles:[{id:'proponent',actor:'agent',permission:'read-only'},{id:'critic',actor:'agent',permission:'read-only'},{id:'synthesizer',actor:'agent',permission:'read-only'},approval],nativeReuse:['native-subagents-when-validated'],
    completion:['evidence-backed-recommendation','unresolved-questions-preserved','human-plan-approval-before-any-coding']}),
  definition({id:'race',name:'Race',connection:'not_connected',requirements:['two-independent-verified-worktrees','identical-project-plan-base-and-suites','bounded-aggregate-and-candidate-budgets'],
    roles:[{id:'candidate-a',actor:'agent',permission:'isolated-write'},{id:'candidate-b',actor:'agent',permission:'isolated-write'},{id:'comparator',actor:'server',permission:'read-only'},approval],nativeReuse:['native-subagents-with-worktree-isolation-when-validated'],
    completion:['candidate-specific-source-digests','actual-tests-and-e2e-evidence','tie-or-incomparable-preserved','explicit-human-winner-approval']}),
  definition({id:'cooperate',name:'Cooperate',connection:'not_connected',requirements:['approved-task-dependency-graph','separate-worker-worktrees','ownership-and-integration-order','bounded-aggregate-budget'],
    roles:[{id:'coordinator',actor:'agent',permission:'read-only'},{id:'worker',actor:'agent',permission:'isolated-write'},{id:'integrator',actor:'agent',permission:'isolated-write'},approval],nativeReuse:['native-subagents-when-validated','existing-isolated-integration-runner'],
    completion:['worker-handoffs-recorded','conflicts-explicitly-resolved','actual-integrated-checks','explicit-human-approval']}),
  definition({id:'goal',name:'Goal',connection:'not_connected',requirements:['approved-objective-and-stop-conditions','native-goal-capability','bounded-iterations-and-budget','durable-checkpoints-no-auto-replay'],
    roles:[{id:'goal-worker',actor:'agent',permission:'isolated-write'},{id:'verifier',actor:'server',permission:'read-only'},approval],nativeReuse:['native-goal-only-when-validated'],
    completion:['actual-objective-evidence','finite-terminal-or-user-action-state','explicit-human-approval','no-automatic-merge']}),
]);

const no=(code:string):ContractDecision=>({ok:false,code});
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** Trusted server facts only; this does not measure usage or enforce a native budget. */
export function validateExecutionBudget(budget:ExecutionBudget):ContractDecision {
  if(!budget||!['subscription','api'].includes(budget.billing))return no('BUDGET_INVALID');
  const counters=[['maxTurns','turnsUsed'],['maxAttempts','attemptsUsed'],['maxIterations','iterationsUsed'],['maxDurationMs','elapsedMs'],['maxTokens','tokensUsed']] as const;
  for(const [maximum,used] of counters){
    const cap=budget[maximum],spent=budget[used];
    if(cap===null||cap===undefined||spent===null||spent===undefined)return no('BUDGET_UNKNOWN');
    if(!natural(cap)||cap===0||!natural(spent))return no('BUDGET_INVALID');
    if(spent>=cap)return no('BUDGET_EXHAUSTED');
  }
  if(budget.tokenLimitEnforced!==true)return no('BUDGET_UNENFORCEABLE');
  if(budget.billing==='subscription'){
    if(budget.subscriptionQuota==='unknown'||budget.subscriptionQuota===null||budget.subscriptionQuota===undefined)return no('BUDGET_UNKNOWN');
    if(budget.subscriptionQuota==='exhausted')return no('BUDGET_EXHAUSTED');
    if(budget.subscriptionQuota!=='available'||budget.maxCostMicros!==null||budget.costUsedMicros!==null||budget.costLimitEnforced!==false)return no('BUDGET_INVALID');
  }else{
    if(budget.maxCostMicros===null||budget.maxCostMicros===undefined||budget.costUsedMicros===null||budget.costUsedMicros===undefined)return no('BUDGET_UNKNOWN');
    if(!natural(budget.maxCostMicros)||budget.maxCostMicros===0||!natural(budget.costUsedMicros)||budget.subscriptionQuota!==null)return no('BUDGET_INVALID');
    if(budget.costUsedMicros>=budget.maxCostMicros)return no('BUDGET_EXHAUSTED');
    if(budget.costLimitEnforced!==true)return no('BUDGET_UNENFORCEABLE');
  }
  return {ok:true};
}

/** Pure preflight contract, not an HTTP authorization boundary or an execution engine. */
export function evaluateExecutionModeLaunch(mode:ExecutionMode,facts:ExecutionModeLaunchFacts):ContractDecision {
  if(!EXECUTION_MODES.some(definition=>definition.id===mode))return no('UNKNOWN_EXECUTION_MODE');
  if(mode!=='solo')return no('MODE_NOT_CONNECTED');
  if(!facts||facts.providerId!=='codex'||facts.providerReady!==true||facts.currentPlanApproved!==true||facts.unresolvedQuestions!==0)return no('MODE_REQUIREMENTS_UNMET');
  if(facts.workspaceValidated!==true||facts.writeEnabled!==true||facts.policyValidated!==true||facts.mcpIsolated!==true
    ||facts.networkAccess!==false||facts.shell!==false||facts.approval!=='deny')return no('MODE_PERMISSION_DENIED');
  return validateExecutionBudget(facts.budget);
}

function pathKey(candidate:RaceCandidate):string|null {
  const path=candidate.canonicalPath;
  if(typeof path!=='string'||path.length>2000||/[\x00-\x1f]/.test(path))return null;
  let segments:string[],key:string;
  if(candidate.pathStyle==='win32'){
    if(!/^[A-Za-z]:[\\/]/.test(path)||path.slice(2).includes(':'))return null;
    key=path.replaceAll('\\','/').toLowerCase();segments=key.slice(3).split('/');
    if(segments.some(segment=>/[. ]$/.test(segment)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(segment)))return null;
  }else if(candidate.pathStyle==='posix'){
    if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))return null;
    key=path;segments=path.slice(1).split('/');
  }else return null;
  if(segments.some(segment=>!segment||segment==='.'||segment==='..'))return null;
  return key;
}

/** Canonical paths and workspace identities MUST already have been verified by the server. */
export function validateRaceCandidates(candidates:readonly RaceCandidate[]):ContractDecision {
  if(!Array.isArray(candidates)||candidates.length!==2)return no('RACE_CANDIDATES_INVALID');
  for(const candidate of candidates){
    if(!candidate||![candidate.candidateId,candidate.projectId,candidate.planningVersionId,candidate.worktreeId].every(id)
      ||typeof candidate.baseSha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.baseSha)
      ||![candidate.approvedRequirementHash,candidate.testSuiteHash,candidate.e2eSuiteHash,candidate.sourceDigest].every(digest))return no('RACE_CANDIDATES_INVALID');
    if(candidate.workspaceVerified!==true||candidate.canonicalPathVerified!==true)return no('RACE_WORKSPACE_UNVERIFIED');
    if(candidate.currentPlanApproved!==true)return no('RACE_PLAN_NOT_APPROVED');
  }
  const [a,b]=candidates,first=pathKey(a),second=pathKey(b);
  if(!first||!second||a.pathStyle!==b.pathStyle||a.candidateId===b.candidateId||a.worktreeId===b.worktreeId
    ||first===second||first.startsWith(second+'/')||second.startsWith(first+'/'))return no('RACE_WORKSPACE_NOT_ISOLATED');
  for(const key of ['projectId','planningVersionId','baseSha','approvedRequirementHash','testSuiteHash','e2eSuiteHash'] as const)
    if(a[key]!==b[key])return no('RACE_CONDITIONS_MISMATCH');
  return {ok:true};
}

/** Compare authoritative runner evidence, never agent claims, speed or unmeasured prices. */
export function compareRaceCandidates(candidates:readonly RaceCandidateResult[]):RaceComparison {
  const conditions=validateRaceCandidates(candidates);if(!conditions.ok)return {status:'incomparable',code:conditions.code};
  const passing:boolean[]=[],runIds=new Set<string>();
  for(const candidate of candidates){
    if(!Array.isArray(candidate.evidence)||candidate.evidence.length!==2)return {status:'incomparable',code:'RACE_EVIDENCE_INCOMPLETE'};
    const kinds=new Set<string>();let passed=true;
    for(const check of candidate.evidence){
      if(!check||!['tests','e2e'].includes(check.kind)||kinds.has(check.kind)||check.origin!=='server-runner'||check.execution!=='completed'
        ||!natural(check.exitCode)||!id(check.runId)||!digest(check.evidenceDigest))return {status:'incomparable',code:'RACE_EVIDENCE_INCOMPLETE'};
      if(check.worktreeId!==candidate.worktreeId||check.projectId!==candidate.projectId||check.sourceDigest!==candidate.sourceDigest
        ||check.suiteHash!==(check.kind==='tests'?candidate.testSuiteHash:candidate.e2eSuiteHash)||runIds.has(check.runId))return {status:'incomparable',code:'RACE_EVIDENCE_MISMATCH'};
      kinds.add(check.kind);runIds.add(check.runId);passed=passed&&check.exitCode===0;
    }
    passing.push(passed);
  }
  if(passing[0]===passing[1])return {status:'comparable',outcome:passing[0]?'tie':'no_winner',winnerId:null};
  return {status:'comparable',outcome:'winner',winnerId:candidates[passing[0]?0:1].candidateId};
}
