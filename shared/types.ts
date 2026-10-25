export type Execution = 'starting'|'running'|'interrupting'|'completed'|'interrupted'|'failed'|'lost';
export type ProviderStatus = 'disconnected'|'connecting'|'ready'|'auth_required'|'not_installed'|'error';
export interface Run {
  id:string; requestId:string; turnId:string|null; prompt:string; response:string;
  execution:Execution; verification:'not_run'; createdAt:string; updatedAt:string;
}
export interface AppEvent {seq:number; kind:string; at:string; runId:string|null; data:Record<string,unknown>}
export interface Snapshot {
  provider:ProviderStatus; issue:string|null; threadId:string|null;
  workspace:string; readOnly:true; runs:Run[]; lastSeq:number;
}
export const terminal=(s:Execution)=>['completed','interrupted','failed','lost'].includes(s);
