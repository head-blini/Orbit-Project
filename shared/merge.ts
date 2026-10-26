export interface MergeTarget {branch:string;head:string;treeSha:string}
export interface MergeCandidate {commitSha:string;treeSha:string;branch:string}
export interface MergeRecord {
  id:string;projectId:string;workspaceId:string;runId:string;sourceDigest:string;checkSetDigest:string;approvalId:string;
  target:MergeTarget;candidate:MergeCandidate|null;
  phase:'prepare'|'apply';status:'preparing'|'prepared'|'applying'|'applied'|'failed'|'lost'|'unknown';
  issue:string|null;completionBasis:'git_and_bytes'|'observed_after_recovery'|null;
  createdAt:string;updatedAt:string;
}
export interface MergeView {
  projectId:string;workspaceId:string;runId:string|null;available:boolean;issue:string|null;
  canPrepare:boolean;sourceDigest:string|null;checkSetDigest:string|null;approvalId:string|null;target:MergeTarget|null;
  busy:boolean;recoveryRequired:boolean;records:MergeRecord[];
  scope:string;
}
export interface PrepareMergeInput {
  requestId:string;workspaceId:string;runId:string;expectedSourceDigest:string;expectedCheckSetDigest:string;
  expectedApprovalId:string;expectedTargetBranch:string;expectedTargetHead:string;
}
export interface ApplyMergeInput {requestId:string;recordId:string;expectedCommitSha:string;confirmed:boolean}
export interface RecoverMergeInput {recordId:string;confirmedStopped:boolean}
