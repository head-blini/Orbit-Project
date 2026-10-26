export type HttpModelProviderId='openai-compatible'|'litellm'|'vllm'|'freellmapi'|'local';
export type ModelProviderId=HttpModelProviderId|'bedrock';
export type ModelTemporaryInput='none'|'possible'|'present'|'removed'|'cleanup_required';
export interface ModelHubUsage {promptTokens:number|null;completionTokens:number|null;totalTokens:number|null;source:'provider'|'unknown'}
export interface ModelHubCatalog {status:'not_queried'|'available'|'empty'|'failed';models:string[];checkedAt:string|null;issue:string|null}
export interface ModelHubDestination {
  id:string;label:string;providerId:ModelProviderId;endpoint:string;locality:'loopback'|'external';
  status:'disabled'|'project_blocked'|'configured';configDigest:string;configuredModels:string[];
  credential:'reference_configured'|'not_required';timeoutMs:number;maxOutputTokens:number;catalog:ModelHubCatalog;
  transport?:'http_json_sse'|'aws_cli_converse';
}
export interface ModelHubRequest {
  id:string;requestId:string;projectId:string;destinationId:string;providerId:ModelProviderId;model:string;configDigest:string;
  execution:'running'|'completed'|'failed'|'interrupted'|'lost';response:string;issue:string|null;
  usage:ModelHubUsage;costUsd:null;createdAt:string;finishedAt:string|null;durationMs:number|null;timeoutMs:number;maxOutputTokens:number;
  temporaryInput?:ModelTemporaryInput;
}
export interface ModelHubView {
  providers:{id:ModelProviderId|'future';implementation:'http_json_sse'|'aws_cli_converse'|'not_implemented'|'extension_point'}[];
  destinations:ModelHubDestination[];requests:ModelHubRequest[];activeRequestId:string|null;
  bedrockRecovery?:{projectId:string;requestId:string}[];
  billing:'separate_from_native_subscription';costSource:'unknown';
}
