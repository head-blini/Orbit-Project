import type {VerificationCommandPreview} from './verification.ts';
export interface WorkflowStepDefinition {id:string;commandId:string;dependsOn:string[]}
export interface WorkflowDefinition {name:string;steps:WorkflowStepDefinition[]}
export interface WorkflowVersion {id:string;workflowId:string;projectId:string;revision:number;definition:WorkflowDefinition;definitionDigest:string;createdAt:string}
export type WorkflowStatus='running'|'passed'|'failed'|'interrupted'|'timed_out'|'stale'|'lost';
export interface WorkflowStepResult extends WorkflowStepDefinition {
  status:WorkflowStatus|'pending'|'skipped';startedAt:string|null;finishedAt:string|null;exitCode:number|null;durationMs:number|null;
  output:string;truncated:boolean;sourceDigest:string|null;finishedDigest:string|null;
}
export interface WorkflowRun {
  id:string;projectId:string;workspaceId:string;workflowId:string;versionId:string;definitionDigest:string;sourceDigest:string;baseSha:string;configDigest:string;
  status:WorkflowStatus;steps:WorkflowStepResult[];retryOfId:string|null;attempt:number;createdAt:string;finishedAt:string|null;recoveredAt:string|null;issue:string|null;
}
export interface WorkflowPreview {
  projectId:string;workspaceId:string;workflowId:string;versionId:string;definitionDigest:string;sourceDigest:string;baseSha:string;configDigest:string;previewDigest:string;
  name:string;steps:(WorkflowStepDefinition&{command:VerificationCommandPreview})[];totalTimeoutMs:number;scope:string;
}
export interface WorkflowView {
  projectId:string;workspaceId:string|null;commands:VerificationCommandPreview[];versions:WorkflowVersion[];runs:WorkflowRun[];
  busy:boolean;recoveryRequired:boolean;scope:string;
}
export interface SaveWorkflowInput extends WorkflowDefinition {requestId:string;workflowId:string|null;expectedRevision:number|null}
export interface StartWorkflowInput {requestId:string;workspaceId:string;workflowId:string;expectedVersionId:string;expectedPreviewDigest:string;confirmed:boolean;retryOfId:string|null}
export interface RecoverWorkflowInput {runId:string;confirmedStopped:boolean}
