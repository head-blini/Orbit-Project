import type {CodeGate,CompletionBinding} from './task-completion.ts';
import type {TaskAcceptanceStatus} from './acceptance.ts';
export interface VerificationCommandPreview {id:string;label:string;executable:string;args:string[];timeoutMs:number;configDigest:string;protectedFiles?:string[]}
export interface VerificationGateMapping {id:string;categories?:CodeGate[]}
export interface CheckRecord {
  completionBinding?:CompletionBinding;
  evidenceSource?:'local'|'mock';
  taskId?:string;planningVersionId?:string;planningContentHash?:string;
  id:string;requestId:string;runId:string;projectId:string;workspaceId:string;commandId:string;configDigest:string;
  baseSha:string;sourceDigest:string;finishedDigest:string|null;createdAt:string;completedAt:string|null;
  execution:'running'|'completed'|'lost';verdict:'not_run'|'passed'|'failed'|'interrupted'|'timed_out'|'stale';
  exitCode:number|null;durationMs:number|null;output:string;recoveredAt:string|null;
  acceptanceDigest?:string;
}
export interface VerificationApproval {
  /** Server-captured CQG binding at approval time; legacy approvals have none. */
  completionBinding?:CompletionBinding;
  id:string;requestId:string;runId:string;workspaceId:string;sourceDigest:string;checkSetDigest:string;createdAt:string;
}
export interface VerificationView {
  workspaceId:string;runId:string|null;commands:VerificationCommandPreview[];
  sourceDigest:string|null;sourceIssue:string|null;checks:CheckRecord[];quarantined:boolean;
  checkSetDigest:string|null;canApprove:boolean;approval:VerificationApproval|null;approvalCurrent:boolean;
  scope:string;acceptance?:TaskAcceptanceStatus;
}
