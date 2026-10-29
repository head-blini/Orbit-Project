/** Browser-safe failure facts. No raw output, review text, paths, or provider messages belong here. */
export type FailureCategory='tool_environment'|'policy_refusal'|'quota_capacity'|'auth'|'output_rejected'|'unknown';
export type FailureSource='run'|'check'|'quality'|'integration'|'worker'|'capability';
export interface FailureRecord {
  id:string;source:FailureSource;recordId:string;projectId:string;taskId?:string;runId?:string;
  code:string;category:FailureCategory;evidenceSource:'native'|'mock'|'unknown'|'local';
  at:string;bindingDigest:string;
}
export interface Hypothesis {
  kind:'hypothesis';statement:string;confidence:'rule';evidence:string[];counterEvidence:string[];
}

/** Exact source/code matches only. Prefixes, error text, exit codes and caller claims are not causes.
 * Sources: server/runtimes/claude-task.ts, server/store.ts, server/quality-loop.ts,
 * server/integration-queue.ts, server/controller.ts, server/capability-execution.ts.
 * CheckRecord (shared/verification.ts) has no reason code. Its output must never be mined for one.
 * Lowercase worker state lost_unknown is explicitly adapted to LOST_UNKNOWN by the index reader;
 * normalizeCode itself never uppercases arbitrary input. Completion reasonCodes without an exact
 * entry stay unknown: blockers are not automatically execution failures or model mistakes.
 */
export const FAILURE_CODE_TABLE:Readonly<Record<FailureSource,Readonly<Record<string,FailureCategory>>>>=Object.freeze({
  run:Object.freeze({
    RUNTIME_NOT_STARTED:'tool_environment', EXIT_NOT_OBSERVED:'tool_environment', SERVER_RESTART:'tool_environment',
    LOGIN_REQUIRED:'auth', QUOTA_EXHAUSTED:'quota_capacity', RESULT_NOT_OBSERVED:'unknown', RUNTIME_ERROR:'unknown',
  }),
  check:Object.freeze({}),
  quality:Object.freeze({
    QUALITY_BASELINE_OR_SOURCE_INVALID:'policy_refusal', QUALITY_LIMITS_INVALID:'policy_refusal',
    INDEPENDENT_MODEL_REQUIRED:'policy_refusal', QUALITY_EVIDENCE_MISMATCH:'policy_refusal',
    QUALITY_EVIDENCE_BLOCKED:'policy_refusal', QUALITY_PERMISSION_DENIED:'policy_refusal',
    QUALITY_MODEL_MISMATCH:'policy_refusal', QUALITY_MODEL_UNKNOWN:'unknown', QUALITY_SOURCE_CHANGED:'policy_refusal',
    QUALITY_EVIDENCE_INVALID:'output_rejected', QUALITY_REPAIR_EVIDENCE_INVALID:'output_rejected',
    QUALITY_QUOTA_EXHAUSTED:'quota_capacity', QUALITY_EXECUTION_LOST:'tool_environment',
    QUALITY_PROCESS_STOP_UNCONFIRMED:'tool_environment', QUALITY_STEP_FAILED:'unknown',
    // These combine time/call/repair limits; none proves provider quota exhaustion.
    QUALITY_TIME_LIMIT:'unknown', QUALITY_CALL_OR_TIME_LIMIT:'unknown', QUALITY_REPAIR_OR_CALL_LIMIT:'unknown',
  }),
  integration:Object.freeze({
    INTEGRATION_TREE_TOO_LARGE:'tool_environment', INTEGRATION_PATH_ALIAS:'policy_refusal',
    INTEGRATION_GENERAL_DELETE_UNSUPPORTED:'policy_refusal', INTEGRATION_NOT_FOUND:'unknown',
    INTEGRATION_SPACE_MISSING:'tool_environment', INTEGRATION_REQUEST_INVALID:'policy_refusal',
    IDEMPOTENCY_CONFLICT:'policy_refusal', INTEGRATION_TERMINAL_REQUIRED:'policy_refusal',
    INTEGRATION_BASELINE_CHANGED:'policy_refusal', INTEGRATION_ALREADY_QUEUED:'policy_refusal',
    INTEGRATION_POLICY_CHANGED:'policy_refusal', INTEGRATION_SOURCE_CHANGED:'policy_refusal',
    INTEGRATION_PROJECT_MISSING:'tool_environment', INTEGRATION_PROTECTED_VERIFICATION_FILE:'policy_refusal',
    INTEGRATION_SCOPE:'policy_refusal', INTEGRATION_SCOPE_OR_SOURCE_CHANGED:'policy_refusal',
    INTEGRATION_TARGET_INVALID:'policy_refusal', INTEGRATION_STALE:'policy_refusal',
    INTEGRATION_STOP_CONFIRMATION_REQUIRED:'policy_refusal', INTEGRATION_CONFLICT:'policy_refusal',
    INTEGRATION_RELEASE_PENDING:'tool_environment', INTEGRATION_UNCERTAIN:'tool_environment',
    INTEGRATION_APPLY_UNCERTAIN:'tool_environment', INTEGRATION_RECOVERY_UNCERTAIN:'tool_environment',
    INTEGRATION_INTERRUPTED_NOT_APPLIED:'tool_environment', INTEGRATION_RESTART_RECOVERY_REQUIRED:'tool_environment',
    INTEGRATION_VERIFICATION_FAILED:'output_rejected', INTEGRATION_CANDIDATE_REFUSED:'unknown',
    INTEGRATION_REQUIRED_CHECK_BLOCKED:'unknown', INTEGRATION_REBUILD_LIMIT:'unknown',
  }),
  worker:Object.freeze({LOST_UNKNOWN:'tool_environment', INTEGRATION_BASELINE_CHANGED:'policy_refusal'}),
  capability:Object.freeze({
    ACCEPTANCE_PREVIEW_STALE:'policy_refusal', CAPABILITY_BLOCKED:'policy_refusal',
    CAPABILITY_EXECUTION_NOT_FOUND:'unknown', CAPABILITY_NOT_IMPLEMENTED:'tool_environment',
    EXECUTION_CONFIRMATION_REQUIRED:'policy_refusal', EXECUTION_DISPATCH_UNCONFIRMED:'tool_environment',
    EXECUTION_PREFLIGHT_CHANGED:'policy_refusal', EXECUTION_RECEIPT_MISMATCH:'policy_refusal',
    EXECUTION_RECOVERY_REQUIRED:'tool_environment', EXECUTION_RESTART_RECOVERY_REQUIRED:'tool_environment',
    EXECUTION_UNCONFIRMED:'tool_environment', IDEMPOTENCY_CONFLICT:'policy_refusal', INVALID_FIELDS:'policy_refusal',
    PLAN_CHANGED:'policy_refusal', QUALITY_RECOVERY_NOT_REQUIRED:'unknown', QUALITY_SOURCE_INVALID:'policy_refusal',
    ROUTE_NOT_EXECUTABLE:'policy_refusal', RUNTIME_VERSION_UNSUPPORTED:'tool_environment',
    SENSITIVE_EXECUTION_INPUT:'policy_refusal', WORKER_REQUEST_MISMATCH:'policy_refusal', WORKSPACE_REQUIRED:'policy_refusal',
  }),
});

export function normalizeCode(code:unknown):string {
  // The final negative lookahead rejects a trailing newline, which JS `$` alone permits.
  return typeof code==='string'&&/^[A-Z_]+$(?![\s\S])/.test(code)?code:'UNCLASSIFIED';
}

/** extra is deliberately ignored until a structured, source-specific rule is approved. */
export function classify(source:FailureSource,code:unknown,_extra?:unknown):FailureCategory {
  const normalized=normalizeCode(code);
  const table=Object.hasOwn(FAILURE_CODE_TABLE,source)?FAILURE_CODE_TABLE[source]:undefined;
  return table&&Object.hasOwn(table,normalized)?table[normalized]:'unknown';
}

export type FailureFamilyTuple=readonly [FailureCategory,string,FailureSource,string|null,string|null];
/** JSON.stringify of this ordered tuple is the SHA-256 input in server/failure-fingerprint.ts.
 * commandIdOrGate and runtime are trusted opaque identifiers, never commands, paths or display text.
 * Missing values are null (not empty strings). Runtime remains part of the family identity.
 */
export function familyTuple(category:FailureCategory,code:unknown,source:FailureSource,commandIdOrGate?:string|null,runtime?:string|null):FailureFamilyTuple {
  return [category,normalizeCode(code),source,commandIdOrGate??null,runtime??null];
}

/** Optional reader-supplied metadata, separate from the minimal public FailureRecord contract.
 * requestId is the original execution request, not a quality step request. qualityLoopId is
 * required for loop-derived failures so rounds cannot masquerade as independent reproductions.
 * IDs/digests must already be trusted, non-sensitive identifiers from the index reader.
 */
export interface FailureObservation extends FailureRecord {
  commandIdOrGate?:string|null;runtime?:string|null;requestId?:string;qualityLoopId?:string;
}
export interface FailureOccurrence {
  id:string;runId:string|null;requestId:string|null;qualityLoopId:string|null;
  evidenceSource:FailureRecord['evidenceSource'];
}
export interface FailureFamily {
  tuple:FailureFamilyTuple;projectId:string;taskId:string|null;bindingDigest:string;
  realCount:number;mockCount:number;unknownCount:number;evidenceIds:string[];occurrences:FailureOccurrence[];
}

/** Groups are scoped to project/task/binding; identical tuples may exist in different scopes.
 * Hash tuple on the server for familyId. Unknown provenance is never counted as real.
 * Record ids are unique index identities. Duplicate reads of one id count once per scope/family.
 * Only named metadata fields are copied; record bodies are never spread into the result.
 */
export function groupFamilies(records:readonly FailureObservation[]):FailureFamily[] {
  const groups=new Map<string,FailureFamily>();
  for(const record of records){
    const code=normalizeCode(record.code),tuple=familyTuple(classify(record.source,code),code,record.source,record.commandIdOrGate,record.runtime);
    const key=JSON.stringify([record.projectId,record.taskId??null,record.bindingDigest,tuple]);
    let group=groups.get(key);
    if(!group){
      group={tuple,projectId:record.projectId,taskId:record.taskId??null,bindingDigest:record.bindingDigest,
        realCount:0,mockCount:0,unknownCount:0,evidenceIds:[],occurrences:[]};
      groups.set(key,group);
    }
    if(group.evidenceIds.includes(record.id))continue;
    group.evidenceIds.push(record.id);
    if(record.evidenceSource==='mock')group.mockCount++;
    else if(record.evidenceSource==='native'||record.evidenceSource==='local')group.realCount++;
    else group.unknownCount++;
    group.occurrences.push({id:record.id,runId:record.runId??null,requestId:record.requestId??null,
      qualityLoopId:record.qualityLoopId??null,evidenceSource:record.evidenceSource});
  }
  return [...groups.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,group])=>{
    group.evidenceIds.sort();group.occurrences.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);return group;
  });
}

/** Rejected output is an observation, never proof of a model mistake.
 * Compare sibling runtime families only within the same project/task/binding and gate.
 * Require two distinct runs AND requests, excluding rounds of the same quality loop.
 * No hypothesis for unknown provenance/runtime, generic failures, or a single observation.
 * Failure-only input supplies no success counterevidence; never invent it.
 */
export function ruleHypotheses(families:readonly FailureFamily[]):Hypothesis[] {
  const comparisons=new Map<string,{occurrence:FailureOccurrence;runtime:string}[]>();
  for(const family of families){
    const [category,code,source,command,runtime]=family.tuple;
    if(category!=='output_rejected'||!runtime||runtime==='unknown'||!family.bindingDigest)continue;
    const key=JSON.stringify([family.projectId,family.taskId,family.bindingDigest,category,code,source,command]);
    const observations=comparisons.get(key)??[];
    for(const occurrence of family.occurrences){
      if((occurrence.evidenceSource==='native'||occurrence.evidenceSource==='local')&&occurrence.id&&occurrence.runId&&occurrence.requestId
        &&(source!=='quality'||!!occurrence.qualityLoopId)){
        observations.push({occurrence,runtime});
      }
    }
    comparisons.set(key,observations);
  }
  const result:Hypothesis[]=[];
  for(const [,observations] of [...comparisons.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    const evidence=new Set<string>();let crossRuntime=false;
    for(let i=0;i<observations.length;i++)for(let j=i+1;j<observations.length;j++){
      const a=observations[i],b=observations[j],left=a.occurrence,right=b.occurrence;
      if(left.id===right.id||left.runId===right.runId||left.requestId===right.requestId
        ||left.qualityLoopId!==null&&left.qualityLoopId===right.qualityLoopId)continue;
      evidence.add(left.id);evidence.add(right.id);
      if(a.runtime!==b.runtime)crossRuntime=true;
    }
    if(evidence.size<2)continue;
    result.push({kind:'hypothesis',confidence:'rule',
      statement:crossRuntime
        ?'Repeated output rejection across runtimes may indicate a shared environment or specification issue; cause is unverified.'
        :'Repeated output rejection on one runtime may indicate a model or adapter issue; independent cross-runtime evidence is insufficient and cause is unverified.',
      evidence:[...evidence].sort(),counterEvidence:[]});
  }
  return result;
}
