/**
 * Pure quarantine-release contract over trusted server facts. This module neither
 * collects nor authenticates facts, qualifies a runtime, releases a lock, signals
 * a process, persists a transition, nor authorizes dispatch/retry/success.
 * Callers must obtain facts from trusted collectors, never browser assertions,
 * and commit a release with a revision/source/ownership CAS under the lock.
 */
export interface RecoveryScope {
  operationId:string; requestId:string; runtimeId:string; ownerIncarnation:string;
  generation:number; nativeSessionId:string|null; nativeTurnId:string|null;
}
export interface RecoveryEnvironment {
  runtimeId:string; runtimeVersion:string; os:string;
  authMode:'subscription'|'api'|'none'|'unknown';
  policyFingerprint:string; configurationFingerprint:string;
}
/** Opaque, already verified canonical identities; this evaluator does not resolve paths. */
export interface RecoveryResource {
  repositoryId:string; commonGitDir:string; targetBranch:string; worktreeId:string;
  accountSlot:string; baseRevision:string; sourceFingerprint:string;
}
export interface OwnedProcessIdentity {
  /** Unique trusted registry identity for the actual owned ChildProcess, never a PID-derived key. */
  handleId:string; pid:number; bootId:string|null; startId:string|null;
}
export type RecoveryProof = 'process_closed'|'session_terminal'|'descendants_stopped';
export type RecoveryUnresolvedFact = RecoveryProof|'owner_stopped';
export type RecoveryNonProof = 'pid_observed'|'pid_absent'|'lease_expired'|'interrupt_ack'|'transport_eof'
  |'kill_requested'|'kill_error'|'deadline_elapsed'|'manager_exited'|'terminal_ui_text';
export interface RecoveryProfile {
  environment:RecoveryEnvironment;
  qualification:{status:'qualified'|'unknown'|'blocked';evidenceId:string;qualifiedAt:number;expiresAt:number};
  safety:'qualified'|'unknown'|'blocked';
  requirements:{processClosed:boolean;sessionTerminal:boolean;sessionStates:Array<'terminal'|'idle'>;descendants:'all_stopped'|'none_permitted'};
  freshness:{proofMaxAgeMs:number;checkMaxAgeMs:number;manualMaxAgeMs:number};
  /** Each substitution, including unknown owner liveness, must be explicitly qualified. */
  manual:{allowed:boolean;replaceable:RecoveryUnresolvedFact[]};
}
interface ScopedProof {scope:RecoveryScope;observedAt:number}
export interface RecoveryProofs {
  process:(ScopedProof & {kind:'owned_child_close'|'pre_dispatch_spawn_failure';observerIncarnation:string;process:OwnedProcessIdentity|null})|null;
  session:(ScopedProof & {kind:'authoritative_terminal';state:'terminal'|'idle'})|null;
  /** Collector accounts for ALL authorized descendants, not just the listed known survivors. */
  descendants:(ScopedProof & {kind:'authoritative_all_stopped';childIds:string[]})|null;
}
interface ManualBinding {
  scope:RecoveryScope; resource:RecoveryResource; recoveryRevision:number; unresolved:RecoveryUnresolvedFact[];
}
export interface RecoveryManualAttestation extends ManualBinding {
  kind:'human_attestation';actorId:string;attestedAt:number;previewId:string;
  action:'release_quarantine'|'retry'|'mark_success'|'enable_autonomous';
}
export interface RecoveryReleaseFacts {
  now:number;managerIncarnation:string;route:'automatic'|'manual';level:'tracking'|'assisted'|'autonomous';
  operation:{scope:RecoveryScope;environment:RecoveryEnvironment;resource:RecoveryResource;process:OwnedProcessIdentity|null;
    startedAt:number;recoveryRevision:number;dispatch:'not_dispatched'|'dispatched'|'unknown';
    state:'intent'|'dispatched'|'unknown'|'terminal'|'quarantined'|'release_ready'|'released'};
  profile:RecoveryProfile;
  persistence:{intent:'durable'|'missing'|'unknown';recovery:'durable'|'repair_required'|'unknown'};
  /** matched is collected ownership identity, never inferred from a stored PID or expired lease. */
  ownership:{scope:RecoveryScope;identity:'matched'|'mismatch'|'unknown';ownerLiveness:'stopped'|'running'|'unknown';checkedAt:number};
  workspaceCheck:{scope:RecoveryScope;resource:RecoveryResource;identity:'verified'|'changed'|'unknown';conflictingWriter:'clear'|'present'|'unknown';checkedAt:number};
  liveness:{process:'running'|'stopped'|'unknown';session:'running'|'terminal'|'unknown';descendants:'running'|'stopped'|'unknown'};
  proofs:RecoveryProofs;nonProofs:RecoveryNonProof[];
  manual:{preview:ManualBinding & {id:string;createdAt:number;expiresAt:number};attestation:RecoveryManualAttestation}|null;
}
export type RecoveryDenialCode = 'INVALID_RECOVERY_FACTS'|'NOT_QUARANTINED'|'PERSISTENCE_UNRESOLVED'
  |'PROFILE_SCOPE_MISMATCH'|'PROFILE_UNQUALIFIED'|'SAFETY_UNQUALIFIED'|'NATIVE_IDENTITY_UNKNOWN'|'PROCESS_IDENTITY_UNKNOWN'
  |'OWNERSHIP_SCOPE_MISMATCH'|'OWNERSHIP_UNVERIFIED'|'OWNERSHIP_CHECK_STALE'|'OWNER_STILL_RUNNING'
  |'WORKSPACE_SCOPE_MISMATCH'|'WORKSPACE_CHANGED'|'WORKSPACE_CHECK_STALE'|'WRITER_CONFLICT_UNRESOLVED'
  |'WORK_STILL_RUNNING'|'EVIDENCE_SCOPE_MISMATCH'|'EVIDENCE_STALE'|'PROCESS_IDENTITY_MISMATCH'
  |'SESSION_STATE_UNQUALIFIED'|'DESCENDANT_PROFILE_CONTRADICTION'|'TERMINATION_UNPROVEN'|'OWNER_LIVENESS_UNPROVEN'|'MANUAL_ASSISTED_ONLY'
  |'MANUAL_NOT_QUALIFIED'|'MANUAL_SCOPE_NOT_QUALIFIED'|'MANUAL_REQUIRED'|'MANUAL_PREVIEW_MISMATCH'
  |'MANUAL_SCOPE_MISMATCH'|'MANUAL_PREVIEW_STALE'|'MANUAL_ACTION_FORBIDDEN';
export interface RecoveryReleaseBasis {
  kind:'machine'|'human_attestation';
  qualificationEvidenceId:string;
  /** Only evidence actually required and established; none-permitted is not observed child termination. */
  proofs:Array<RecoveryProof|'descendants_not_permitted_by_profile'>;
  attestedFacts:RecoveryUnresolvedFact[];
  humanAttestation:RecoveryManualAttestation|null;
}
export type RecoveryReleaseDecision = {allowed:false;code:RecoveryDenialCode}
  |{allowed:true;code:'RELEASE_REQUIREMENTS_SATISFIED';basis:RecoveryReleaseBasis};

type Validator = (value:unknown)=>boolean;
const text:Validator = v=>typeof v==='string'&&v.length>0&&v.length<=4096&&v.trim()===v&&!v.includes('\0');
const integer:Validator = v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const positive:Validator = v=>integer(v)&&(v as number)>0;
const bool:Validator = v=>typeof v==='boolean';
const nullable = (validate:Validator):Validator => v=>v===null||validate(v);
const oneOf = (...values:string[]):Validator => v=>typeof v==='string'&&values.includes(v);
const list = (validate:Validator):Validator => v=>{
  if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||Reflect.ownKeys(v).length!==v.length+1)return false;
  for(let i=0;i<v.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(v,String(i));
    if(!descriptor||!('value' in descriptor)||!validate(descriptor.value))return false;
  }
  return new Set(v).size===v.length;
};
const shape = (fields:Record<string,Validator>):Validator => value=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return false;
  const keys=Object.keys(fields);
  return Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    return descriptor!==undefined&&'value' in descriptor&&fields[key]!(descriptor.value);
  });
};
const scopeFields={operationId:text,requestId:text,runtimeId:text,ownerIncarnation:text,generation:positive,nativeSessionId:nullable(text),nativeTurnId:nullable(text)};
const scope:Validator = value=>shape(scopeFields)(value)&&((value as RecoveryScope).nativeTurnId===null||(value as RecoveryScope).nativeSessionId!==null);
const environment=shape({runtimeId:text,runtimeVersion:text,os:text,authMode:oneOf('subscription','api','none','unknown'),policyFingerprint:text,configurationFingerprint:text});
const resource=shape({repositoryId:text,commonGitDir:text,targetBranch:text,worktreeId:text,accountSlot:text,baseRevision:text,sourceFingerprint:text});
const processIdentity=shape({handleId:text,pid:positive,bootId:nullable(text),startId:nullable(text)});
const unresolved=list(oneOf('process_closed','session_terminal','descendants_stopped','owner_stopped'));
const binding={scope,resource,recoveryRevision:positive,unresolved};
const proofFields={scope,observedAt:integer};
const validateFacts=shape({
  now:integer,managerIncarnation:text,route:oneOf('automatic','manual'),level:oneOf('tracking','assisted','autonomous'),
  operation:shape({scope,environment,resource,process:nullable(processIdentity),startedAt:integer,recoveryRevision:positive,
    dispatch:oneOf('not_dispatched','dispatched','unknown'),state:oneOf('intent','dispatched','unknown','terminal','quarantined','release_ready','released')}),
  profile:shape({environment,qualification:shape({status:oneOf('qualified','unknown','blocked'),evidenceId:text,qualifiedAt:integer,expiresAt:integer}),
    safety:oneOf('qualified','unknown','blocked'),requirements:shape({processClosed:bool,sessionTerminal:bool,sessionStates:list(oneOf('terminal','idle')),descendants:oneOf('all_stopped','none_permitted')}),
    freshness:shape({proofMaxAgeMs:positive,checkMaxAgeMs:positive,manualMaxAgeMs:positive}),manual:shape({allowed:bool,replaceable:unresolved})}),
  persistence:shape({intent:oneOf('durable','missing','unknown'),recovery:oneOf('durable','repair_required','unknown')}),
  ownership:shape({scope,identity:oneOf('matched','mismatch','unknown'),ownerLiveness:oneOf('stopped','running','unknown'),checkedAt:integer}),
  workspaceCheck:shape({scope,resource,identity:oneOf('verified','changed','unknown'),conflictingWriter:oneOf('clear','present','unknown'),checkedAt:integer}),
  liveness:shape({process:oneOf('running','stopped','unknown'),session:oneOf('running','terminal','unknown'),descendants:oneOf('running','stopped','unknown')}),
  proofs:shape({process:nullable(shape({...proofFields,kind:oneOf('owned_child_close','pre_dispatch_spawn_failure'),observerIncarnation:text,process:nullable(processIdentity)})),
    session:nullable(shape({...proofFields,kind:oneOf('authoritative_terminal'),state:oneOf('terminal','idle')})),
    descendants:nullable(shape({...proofFields,kind:oneOf('authoritative_all_stopped'),childIds:list(text)}))}),
  nonProofs:list(oneOf('pid_observed','pid_absent','lease_expired','interrupt_ack','transport_eof','kill_requested','kill_error','deadline_elapsed','manager_exited','terminal_ui_text')),
  manual:nullable(shape({preview:shape({...binding,id:text,createdAt:integer,expiresAt:integer}),
    attestation:shape({...binding,kind:oneOf('human_attestation'),actorId:text,attestedAt:integer,previewId:text,action:oneOf('release_quarantine','retry','mark_success','enable_autonomous')})}))
});
const equal = <T extends object>(a:T,b:T):boolean => (Object.keys(a) as Array<keyof T>).every(key=>a[key]===b[key]);
const sameFacts = (a:RecoveryUnresolvedFact[],b:RecoveryUnresolvedFact[]):boolean => a.length===b.length&&a.every(f=>b.includes(f));
const fresh = (at:number,now:number,maxAge:number,start:number):boolean => at>=start&&at<=now&&now-at<maxAge;

export function evaluateRecoveryRelease(input:unknown):RecoveryReleaseDecision {
  const deny=(code:RecoveryDenialCode):RecoveryReleaseDecision=>({allowed:false,code});
  if(!validateFacts(input))return deny('INVALID_RECOVERY_FACTS');
  const f=input as RecoveryReleaseFacts;
  const {operation:o,profile:p,proofs,now}=f;
  if(o.startedAt>now||(!p.requirements.processClosed&&!p.requirements.sessionTerminal)
    ||(p.requirements.sessionTerminal&&p.requirements.sessionStates.length===0)
    ||(f.route==='automatic'&&f.manual!==null))return deny('INVALID_RECOVERY_FACTS');
  if(o.state!=='quarantined'&&o.state!=='release_ready')return deny('NOT_QUARANTINED');
  if(f.persistence.intent!=='durable'||f.persistence.recovery!=='durable')return deny('PERSISTENCE_UNRESOLVED');
  if(!equal(o.environment,p.environment)||o.environment.runtimeId!==o.scope.runtimeId)return deny('PROFILE_SCOPE_MISMATCH');
  if(p.qualification.status!=='qualified'||p.environment.authMode==='unknown'||p.qualification.qualifiedAt>o.startedAt
    ||p.qualification.expiresAt<=now||p.qualification.expiresAt<=p.qualification.qualifiedAt)return deny('PROFILE_UNQUALIFIED');
  if(p.safety!=='qualified')return deny('SAFETY_UNQUALIFIED');
  if(o.dispatch!=='not_dispatched'&&(o.scope.nativeSessionId===null||o.scope.nativeTurnId===null))return deny('NATIVE_IDENTITY_UNKNOWN');
  if(p.requirements.processClosed&&o.dispatch!=='not_dispatched'&&o.process===null)return deny('PROCESS_IDENTITY_UNKNOWN');
  // A handle name survives in storage, its object ownership does not. Without
  // original close proof, another incarnation needs stable boot/start identity.
  if(p.requirements.processClosed&&!proofs.process&&o.process&&f.managerIncarnation!==o.scope.ownerIncarnation
    &&(o.process.bootId===null||o.process.startId===null))return deny('PROCESS_IDENTITY_UNKNOWN');
  if(!equal(f.ownership.scope,o.scope))return deny('OWNERSHIP_SCOPE_MISMATCH');
  if(f.ownership.identity!=='matched')return deny('OWNERSHIP_UNVERIFIED');
  if(!fresh(f.ownership.checkedAt,now,p.freshness.checkMaxAgeMs,o.startedAt))return deny('OWNERSHIP_CHECK_STALE');
  if(f.ownership.ownerLiveness==='running')return deny('OWNER_STILL_RUNNING');
  if(!equal(f.workspaceCheck.scope,o.scope))return deny('WORKSPACE_SCOPE_MISMATCH');
  if(f.workspaceCheck.identity!=='verified'||!equal(f.workspaceCheck.resource,o.resource))return deny('WORKSPACE_CHANGED');
  if(!fresh(f.workspaceCheck.checkedAt,now,p.freshness.checkMaxAgeMs,o.startedAt))return deny('WORKSPACE_CHECK_STALE');
  if(f.workspaceCheck.conflictingWriter!=='clear')return deny('WRITER_CONFLICT_UNRESOLVED');
  if(Object.values(f.liveness).includes('running'))return deny('WORK_STILL_RUNNING');

  // Supplied contradictory/foreign evidence cannot be erased by a human confirmation.
  for(const proof of [proofs.process,proofs.session,proofs.descendants]){
    if(!proof)continue;
    if(!equal(proof.scope,o.scope))return deny('EVIDENCE_SCOPE_MISMATCH');
    if(!fresh(proof.observedAt,now,p.freshness.proofMaxAgeMs,o.startedAt))return deny('EVIDENCE_STALE');
  }
  if(proofs.process){
    const proof=proofs.process;
    if(proof.observerIncarnation!==o.scope.ownerIncarnation)return deny('PROCESS_IDENTITY_MISMATCH');
    if(proof.kind==='owned_child_close'){
      if(!proof.process||!o.process||!equal(proof.process,o.process))return deny('PROCESS_IDENTITY_MISMATCH');
    } else if(proof.process!==null||o.process!==null||o.dispatch!=='not_dispatched'
      ||o.scope.nativeSessionId!==null||o.scope.nativeTurnId!==null)return deny('PROCESS_IDENTITY_MISMATCH');
  }
  if(proofs.session&&(o.scope.nativeSessionId===null||o.scope.nativeTurnId===null))return deny('NATIVE_IDENTITY_UNKNOWN');
  if(proofs.session&&!p.requirements.sessionStates.includes(proofs.session.state))return deny('SESSION_STATE_UNQUALIFIED');
  if(p.requirements.descendants==='none_permitted'&&proofs.descendants?.childIds.length)return deny('DESCENDANT_PROFILE_CONTRADICTION');

  const established:RecoveryReleaseBasis['proofs']=[];
  const missing:RecoveryUnresolvedFact[]=[];
  if(p.requirements.processClosed)(proofs.process?established:missing).push('process_closed');
  if(p.requirements.sessionTerminal)(proofs.session?established:missing).push('session_terminal');
  if(p.requirements.descendants==='none_permitted')established.push('descendants_not_permitted_by_profile');
  else (proofs.descendants?established:missing).push('descendants_stopped');
  if(f.ownership.ownerLiveness==='unknown')missing.push('owner_stopped');
  if(f.route==='automatic'){
    if(missing.some(fact=>fact!=='owner_stopped'))return deny('TERMINATION_UNPROVEN');
    if(missing.length)return deny('OWNER_LIVENESS_UNPROVEN');
    return {allowed:true,code:'RELEASE_REQUIREMENTS_SATISFIED',basis:{kind:'machine',qualificationEvidenceId:p.qualification.evidenceId,proofs:established,attestedFacts:[],humanAttestation:null}};
  }
  if(f.level!=='assisted')return deny('MANUAL_ASSISTED_ONLY');
  if(!p.manual.allowed)return deny('MANUAL_NOT_QUALIFIED');
  if(missing.some(fact=>!p.manual.replaceable.includes(fact)))return deny('MANUAL_SCOPE_NOT_QUALIFIED');
  if(!f.manual)return deny('MANUAL_REQUIRED');
  const {preview,attestation}=f.manual;
  if(attestation.action!=='release_quarantine')return deny('MANUAL_ACTION_FORBIDDEN');
  if(preview.id!==attestation.previewId)return deny('MANUAL_PREVIEW_MISMATCH');
  for(const binding of [preview,attestation]){
    if(!equal(binding.scope,o.scope)||!equal(binding.resource,o.resource)||binding.recoveryRevision!==o.recoveryRevision
      ||!sameFacts(binding.unresolved,missing))return deny('MANUAL_SCOPE_MISMATCH');
  }
  if(!fresh(preview.createdAt,now,p.freshness.manualMaxAgeMs,o.startedAt)||preview.expiresAt<=now
    ||preview.expiresAt<=preview.createdAt||!fresh(attestation.attestedAt,now,p.freshness.manualMaxAgeMs,preview.createdAt))return deny('MANUAL_PREVIEW_STALE');
  return {allowed:true,code:'RELEASE_REQUIREMENTS_SATISFIED',basis:{kind:'human_attestation',qualificationEvidenceId:p.qualification.evidenceId,
    proofs:established,attestedFacts:missing,humanAttestation:structuredClone(attestation)}};
}
