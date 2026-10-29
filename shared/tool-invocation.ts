import type {ToolKey} from './tool-capabilities.ts';

export interface ToolInvocationSelection extends ToolKey {projectId:string;taskId:string}
export interface ToolInvocationPreview {previewId:string;digest:string}
export interface ToolInvocationInput {requestId:string;previewId:string;expectedDigest:string;confirmed:true}
export interface ToolInvocationBinding extends ToolInvocationSelection {
  itemDigest:string;grantId:string;planningContentHash:string;
}
/** Completion is an execution observation, never a verification verdict. */
export interface ToolLaunchResult {
  status:'completed'|'failed'|'unknown';
  evidenceSource:'native'|'mock'|'unknown';
}
export interface ToolLaunchRequest extends ToolInvocationBinding {
  invocationId:string;requestId:string;previewId:string;digest:string;
}
/** T7 supplies the existing task Run launch profile. No command, URL or tool arguments cross this boundary. */
export interface ToolLaunchPort {invoke(input:Readonly<ToolLaunchRequest>):Promise<ToolLaunchResult>}
export interface ToolInvocation extends ToolLaunchRequest,ToolLaunchResult {
  createdAt:string;updatedAt:string;issue:'OPERATION_UNCONFIRMED'|null;
}
