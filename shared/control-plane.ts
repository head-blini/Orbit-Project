/** Trusted server facts only. This contract does not grant execution authority. */
export interface AssistedAdmissionFacts {
  initiator:'user'|'schedule'|'automatic';billing:'subscription'|'api'|'unknown';
  quota:{state:'available'|'exhausted'|'unknown';fresh:boolean};quotaUnknownAcknowledged:boolean;
  safety:'qualified'|'unknown'|'blocked';workspaceValidated:boolean;approvalCurrent:boolean;
  ownership:'exclusive'|'conflict'|'unknown';recovery:'clear'|'quarantined'|'unknown';stop:'qualified'|'unknown';
  maxTurns:number;maxAttempts:number;maxDurationMs:number;delegation:boolean;automaticContinuation:boolean;
  hardTokenCapRequired:boolean;hardTokenCapEnforced:boolean;hardCostCapRequired:boolean;hardCostCapEnforced:boolean;
}
export type AdmissionDecision={allowed:false;code:string}|{allowed:true;quota:'available'|'unknown';tokenCap:'enforced'|'not_enforced';costCap:'enforced'|'not_enforced'};
export function assessAssistedAdmission(f:AssistedAdmissionFacts):AdmissionDecision {
  const deny=(code:string):AdmissionDecision=>({allowed:false,code});
  if(!f||!f.quota||!['available','exhausted','unknown'].includes(f.quota.state)||typeof f.quota.fresh!=='boolean'
    ||[f.quotaUnknownAcknowledged,f.workspaceValidated,f.approvalCurrent,f.delegation,f.automaticContinuation,
      f.hardTokenCapRequired,f.hardTokenCapEnforced,f.hardCostCapRequired,f.hardCostCapEnforced].some(v=>typeof v!=='boolean'))return deny('INVALID_ADMISSION_FACTS');
  if(f.initiator!=='user')return deny('DIRECT_USER_ACTION_REQUIRED');
  if(f.billing!=='subscription')return deny('SUBSCRIPTION_AUTH_REQUIRED');
  if(f.safety!=='qualified')return deny('SAFETY_UNQUALIFIED');
  if(!f.workspaceValidated)return deny('WORKSPACE_UNQUALIFIED');
  if(!f.approvalCurrent)return deny('APPROVAL_REQUIRED');
  if(f.ownership!=='exclusive')return deny('OWNER_UNQUALIFIED');
  if(f.recovery!=='clear')return deny('RECOVERY_REQUIRED');
  if(f.stop!=='qualified')return deny('STOP_UNQUALIFIED');
  if(f.maxTurns!==1||f.maxAttempts!==1||!Number.isSafeInteger(f.maxDurationMs)||f.maxDurationMs<=0||f.maxDurationMs>120000
    ||f.delegation||f.automaticContinuation)return deny('ASSISTED_ENVELOPE_INVALID');
  if(f.hardTokenCapRequired&&!f.hardTokenCapEnforced)return deny('HARD_TOKEN_CAP_UNAVAILABLE');
  if(f.hardCostCapRequired&&!f.hardCostCapEnforced)return deny('HARD_COST_CAP_UNAVAILABLE');
  // An old exhaustion observation is not permission to spend again.
  if(f.quota.state==='exhausted')return deny('QUOTA_EXHAUSTED');
  const quota=f.quota.fresh&&f.quota.state==='available'?'available':'unknown';
  if(quota==='unknown'&&!f.quotaUnknownAcknowledged)return deny('QUOTA_ACK_REQUIRED');
  return {allowed:true,quota,tokenCap:f.hardTokenCapEnforced?'enforced':'not_enforced',costCap:f.hardCostCapEnforced?'enforced':'not_enforced'};
}
export interface PolicyClaim {id:string;label:string;owner:'orbit'|'runtime'|'unverified';status:'enforced'|'attested'|'unknown';scope:string}
export interface ControlPlaneStatus {
  schemaVersion:1;levels:{tracking:'available';assisted:'qualification_pending';autonomous:'disabled'};
  policies:PolicyClaim[];limitations:string[];
}
