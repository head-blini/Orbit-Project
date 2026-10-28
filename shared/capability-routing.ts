import type {OrchestrationCapabilityId,RuntimeId} from './capability-orchestration.ts';
export interface CapabilityRouteInput {requestId:string;taskId:string;text:string;runtimeId?:RuntimeId;runId?:string}
export interface CapabilityRouteDecision {
  id:string;requestId:string;projectId:string;taskId:string;createdAt:string;
  runId?:string;invocationDigest?:string;
  intent:'execution'|'planning'|'review'|'status'|'result'|'interrupt'|'unknown';status:'recommended'|'blocked'|'needs_clarification';
  runtimeId:RuntimeId|null;capabilityId:OrchestrationCapabilityId|null;reasons:string[];
  baseline:{planningVersionId:string;planningContentHash:string};preferencesRevision:number;
  registryDigest:string;textDigest:string;executionAuthorized:false;actualModel:'unknown';
}
