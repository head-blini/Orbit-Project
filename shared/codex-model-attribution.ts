/** Codex configuration/routing observations are not execution attestations. */
export type CodexModelSource='thread/start'|'thread/resume'|'thread/read'|'thread/settings/updated';
export type CodexModelStatus='starting'|'running'|'completed'|'interrupted'|'failed'|'lost';
export interface CodexModelObservation {
  source:CodexModelSource|'turn/start'|'review/start'|'turn/started'|'turn/completed'|'model/rerouted';
  semantics:'configuration'|'request'|'routing'|'lifecycle';
  modelId:string|null;providerId:string|null;turnId:string|null;observedAt:number;
}
export interface CodexModelAttribution {
  selectedModelId:string|null;requestedModelId:string|null;
  serverModelId:string|null;serverProviderId:string|null;serverSource:CodexModelSource|null;
  actualModelId:'unknown';actualModelEvidence:'unavailable';
  threadId:string|null;nativeSessionId:string|null;turnId:string|null;
  status:CodexModelStatus;modelChanged:boolean;observationIncomplete:boolean;resumed:boolean;
  observations:CodexModelObservation[];
}
