import type {PlanningDraft,PlanningVersion} from './parallel.ts';

export type PlanningSuggestionExecution='running'|'completed'|'failed'|'interrupted'|'timed_out'|'lost';
export interface PlanningAgentPreview {
  projectId:string;workspaceId:string;inputDigest:string;previewDigest:string;
  instructions:string;timeoutMs:number;turnLimit:1;scope:string;
}
export interface PlanningSuggestion {
  id:string;requestId:string;projectId:string;workspaceId:string;inputDigest:string;previewDigest:string;
  execution:PlanningSuggestionExecution;proposal:PlanningDraft|null;outputDigest:string|null;issue:string|null;
  threadId:string|null;turnId:string|null;processStopped:boolean;recoveredAt:string|null;
  createdAt:string;finishedAt:string|null;durationMs:number|null;timeoutMs:number;turnLimit:1;savedPlanningVersionId:string|null;
}
export interface PlanningAgentView {
  projectId:string;workspaceId:string;records:PlanningSuggestion[];busy:boolean;recoveryRequired:boolean;
  timeoutMs:number;turnLimit:1;scope:string;
}
export interface StartPlanningSuggestionInput {
  requestId:string;workspaceId:string;text:string;expectedPreviewDigest:string;confirmed:boolean;
}
export interface PlanningAgentPanelProps {
  projectId:string;workspaceId:string|null;online:boolean;busy:boolean;
  presentation?:'advanced'|'simple';
  post:(path:string,body:object)=>Promise<unknown>;
  onSaved:(version:PlanningVersion)=>void;
}
