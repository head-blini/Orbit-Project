export type Execution = 'starting'|'running'|'interrupting'|'completed'|'interrupted'|'failed'|'lost';
export type ProviderStatus = 'disconnected'|'connecting'|'ready'|'auth_required'|'not_installed'|'error';
export interface Run {
  workspaceId?:string;
  taskId?:string; planningVersionId?:string; requirementLabels?:string[];
  id:string; requestId:string; turnId:string|null; prompt:string; response:string;
  execution:Execution; verification:'not_run'|'recorded'; createdAt:string; updatedAt:string;
}
export interface AppEvent {seq:number; kind:string; at:string; runId:string|null; data:Record<string,unknown>}
export interface Snapshot {
  extensionBusy?:boolean;
  verificationBusy?:boolean;
  mergeBusy?:boolean;
  reviewBusy?:boolean;
  planningBusy?:boolean;
  workflowBusy?:boolean;
  modelHubBusy?:boolean;modelHubConfigured?:boolean;
  connections?:{id:string;status:'mock_only';externalApiEnabled:boolean;coding:boolean}[];externalApiEnabled?:boolean;
  provider:ProviderStatus; issue:string|null; threadId:string|null;
  workspace:string; readOnly:boolean; runs:Run[]; lastSeq:number;
  selectedWorkspaceId?:string|null; projects?:Project[]; workspaces?:Workspace[];
}
export interface Project {id:string;name:string;path:string;createdAt:string;writeEnabled:boolean}
export interface Workspace {id:string;projectId:string;path:string;branch:string;baseSha:string;createdAt:string;status:'creating'|'ready'|'failed'}
export interface FileDiff {path:string;status:string;patch:string|null;omitted?:string}
export interface WorkspaceDiff {workspaceId:string;baseSha:string;files:FileDiff[]}
export const terminal=(s:Execution)=>['completed','interrupted','failed','lost'].includes(s);
