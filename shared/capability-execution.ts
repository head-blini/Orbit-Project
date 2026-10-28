import type {RuntimeId} from './capability-orchestration.ts';
import type {QualityLoopRecord} from './quality-loop-record.ts';
export interface CapabilityPlanInput {requestId:string;routeId:string;workspaceId?:string;expectedAcceptanceDigest?:string}
export interface CapabilityExecutionApproval {confirmed:true;expectedPlanDigest:string}
export type CapabilityExecutionStatus='awaiting_approval'|'dispatching'|'running'|'interrupt_requested'|'interrupted'|'failed'|'recovery_required'|'execution_completed'|'quality_running'|'quality_blocked'|'quality_failed'|'quality_passed';
export interface CapabilityExecutionRecord {
 id:string;requestId:string;projectId:string;taskId:string;routeId:string;runtimeId:RuntimeId;
 createdAt:string;updatedAt:string;planDigest:string;bindingDigest:string;
 dispatchRequestId:string;workspaceId:string|null;expectedAcceptanceDigest:string|null;
 baseline:{planningVersionId:string;planningContentHash:string};preferencesRevision:number;
 adapter:{adapterId?:string|null;capabilities?:import('./capability-orchestration.ts').OrchestrationCapabilityId[];runtimeId:RuntimeId;revision:number;version:string|null;compatible:boolean;issue:string|null};
 status:CapabilityExecutionStatus;issue:string|null;runId:string|null;qualityLoopId:string|null;recoveryRequired:boolean;
 approvedAt:string|null;executionScope:'approved_task';validationSource:'runtime_evidence_required';
 models:{selectedModelId:string|null;requestedModelId:string|null;serverModelId:string|null;actualModelId:string;source:'unknown'|'native_observed'};
 quality:QualityLoopRecord|null;
}
