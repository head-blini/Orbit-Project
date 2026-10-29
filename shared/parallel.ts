/** Provider-neutral Studio contracts. These records never grant execution authority. */
export type PlanningSource = 'manual' | 'import';
export interface PlanningDecision {topic:string;decision:string;rationale:string}
export interface PlanningProvenance {
  kind:string;providerId:string|null;externalUrl:string|null;
  author?:string;references?:{title:string;url:string}[];
}
export interface PlanningDraft {
  schemaVersion:'1.0'; title:string; goal:string;
  requirements:{label:string;description:string;acceptanceCriteria:string[]}[];
  constraints:string[]; openQuestions:string[]; source:PlanningSource;
  decisions?:PlanningDecision[]; provenance?:PlanningProvenance;
  nonGoals?:string[];
  /** Absent on historical versions; interpret as detailed without changing hashed content. */
  depth?:'simple'|'detailed'; depthReason?:string; risks?:string[];
}
export type PlanningParseResult = {ok:true;draft:PlanningDraft} | {ok:false;issues:{field:string;code:string}[]};
export interface PlanningVersion {
  id:string; projectId:string; revision:number; contentHash:string;
  state:'draft'|'approved'|'superseded'; draft:PlanningDraft;
  lineageId?:string; createdAt?:string; approvedAt?:string; approvedBy?:string;
}
export interface TaskDraft {
  title:string; description:string; acceptanceCriteria:string[];
  planningVersionId:string; requirementLabels:string[];
}
export interface SavedTask extends TaskDraft {
  id:string; projectId:string; state:'draft'; verification:'not_run'; createdAt:string;
  replannedFrom?:{planningVersionId:string;taskIds:string[]};
}
export interface ArchitectureGraph {
  nodes:{id:string;label:string;kind:string}[];
  edges:{from:string;to:string;label?:string}[];
}
export interface ArtifactInput {kind:'mermaid'|'architecture'|'presentation'|'c4';source:string;metadata:Record<string,string>}
export interface ArtifactRecord extends ArtifactInput {id:string;projectId:string;revision:number;contentHash:string;createdAt:string}
export interface TimelineView {
  lastSeq:number; workspaceKey:string;
  items:{seq:number;at:string;runId:string|null;kind:string;label:string}[];
  reload:{reason:'gap'|'workspace_changed'|'conflicting_sequence';after:number}|null;
}
export type ConnectionProviderId = 'bedrock'|'litellm'|'vllm'|'freellmapi';
export interface DestinationPolicy {destinationId:string;providerId:ConnectionProviderId;classification:'local'|'external';endpoint:string;action:'block'|'mask'|'allow'}
export interface ProviderTransport {send(request:{destinationId:string;providerId:ConnectionProviderId;endpoint:string;payload:string}):Promise<{text:string}>}
export interface ProviderDescriptor {
  id:'codex';status:'ready'|'auth_required'|'not_installed'|'unsupported'|'error';
  capabilities:{patch:boolean;shell:false;approvals:'deny';mcp:'disabled'};
}
export interface LaunchContext {
  provider:ProviderDescriptor;expectedWorkspaceId:string|null;selectedWorkspaceId:string|null;
  workspaceValidated:boolean;writeEnabled:boolean;policyValidated:boolean;mcpIsolated:boolean;
}
export type GuardrailDecision={allowed:true}|{allowed:false;code:string};
