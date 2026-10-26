export type ReviewExecution='running'|'completed'|'failed'|'interrupted'|'timed_out'|'lost'|'stale';
export interface ReviewFile {path:string;status:'modified'|'deleted'|'untracked';bytes:number}
export interface ReviewPreview {
  projectId:string;workspaceId:string;runId:string|null;baseSha:string;sourceDigest:string;inputDigest:string;previewDigest:string;
  instructions:string;files:ReviewFile[];patchBytes:number;timeoutMs:number;turnLimit:1;scope:string;
}
export interface ReviewRecord {
  id:string;requestId:string;projectId:string;workspaceId:string;runId:string|null;baseSha:string;sourceDigest:string;finishedDigest:string|null;
  inputDigest:string;previewDigest:string;files:ReviewFile[];execution:ReviewExecution;response:string;issue:string|null;
  threadId:string|null;turnId:string|null;processStopped:boolean;recoveredAt:string|null;
  createdAt:string;finishedAt:string|null;durationMs:number|null;timeoutMs:number;turnLimit:1;
}
export interface ReviewView {
  workspaceId:string;runId:string|null;records:ReviewRecord[];sourceDigest:string|null;sourceIssue:string|null;
  busy:boolean;recoveryRequired:boolean;timeoutMs:number;turnLimit:1;scope:string;
}
export interface StartReviewInput {requestId:string;workspaceId:string;runId:string|null;expectedPreviewDigest:string;confirmed:boolean}
export interface RecoverReviewInput {reviewId:string;confirmedStopped:boolean}
