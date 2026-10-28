import type {TaskAcceptanceStatus} from './acceptance.ts';
export interface VerificationCommandPreview {id:string;label:string;executable:string;args:string[];timeoutMs:number;configDigest:string;protectedFiles?:string[]}
export interface CheckRecord {
  evidenceSource?:'local'|'mock';
  taskId?:string;planningVersionId?:string;planningContentHash?:string;
  id:string;requestId:string;runId:string;projectId:string;workspaceId:string;commandId:string;configDigest:string;
  baseSha:string;sourceDigest:string;finishedDigest:string|null;createdAt:string;completedAt:string|null;
  execution:'running'|'completed'|'lost';verdict:'not_run'|'passed'|'failed'|'interrupted'|'timed_out'|'stale';
  exitCode:number|null;durationMs:number|null;output:string;recoveredAt:string|null;
  acceptanceDigest?:string;
}
export interface VerificationApproval {
  id:string;requestId:string;runId:string;workspaceId:string;sourceDigest:string;checkSetDigest:string;createdAt:string;
}
export interface VerificationView {
  workspaceId:string;runId:string|null;commands:VerificationCommandPreview[];
  sourceDigest:string|null;sourceIssue:string|null;checks:CheckRecord[];quarantined:boolean;
  checkSetDigest:string|null;canApprove:boolean;approval:VerificationApproval|null;approvalCurrent:boolean;
  scope:string;acceptance?:TaskAcceptanceStatus;
}
