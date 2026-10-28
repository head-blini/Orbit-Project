import type {RuntimeId} from './capability-orchestration.ts';
import type {RuntimeOperationObservation} from './runtime-operation.ts';
export interface CapabilityInvocationInput {requestId:string;routeId:string;expectedDigest:string;confirmed:true}
export interface CapabilityInvocationRecord {
 id:string;requestId:string;projectId:string;taskId:string;routeId:string;runId:string;runtimeId:RuntimeId;
 capabilityId:'status'|'result'|'interrupt';createdAt:string;updatedAt:string;
 status:'completed'|'requested'|'failed'|'unknown';issue:string|null;result:RuntimeOperationObservation|null;
}
