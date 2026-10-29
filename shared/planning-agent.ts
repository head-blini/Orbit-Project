import type {PlanningDraft,PlanningVersion} from './parallel.ts';
import type {ProjectAiRuntime} from './project-ai-preferences.ts';

export type PlanningSuggestionExecution='running'|'completed'|'failed'|'interrupted'|'timed_out'|'lost';
export interface PlanningAgentPreview {
  projectId:string;workspaceId:string|null;inputDigest:string;previewDigest:string;
  /** Present on new responses; optional for pre-C4 persisted/client fixtures. */
  runtime?:ProjectAiRuntime;preferencesRevision?:number;
  instructions:string;timeoutMs:number;turnLimit:1;scope:string;
}
export interface PlanningSuggestion {
  id:string;requestId:string;projectId:string;workspaceId:string|null;inputDigest:string;previewDigest:string;
  runtime?:ProjectAiRuntime;preferencesRevision?:number;
  execution:PlanningSuggestionExecution;proposal:PlanningDraft|null;outputDigest:string|null;issue:string|null;
  threadId:string|null;turnId:string|null;processStopped:boolean;recoveredAt:string|null;
  createdAt:string;finishedAt:string|null;durationMs:number|null;timeoutMs:number;turnLimit:1;savedPlanningVersionId:string|null;
}
export interface PlanningAgentView {
  projectId:string;workspaceId:string|null;records:PlanningSuggestion[];busy:boolean;recoveryRequired:boolean;
  runtime?:ProjectAiRuntime;
  timeoutMs:number;turnLimit:1;scope:string;
}
export interface StartPlanningSuggestionInput {
  requestId:string;workspaceId?:string|null;text:string;expectedPreviewDigest:string;confirmed:boolean;
}
export interface PlanningAgentPanelProps {
  projectId:string;workspaceId:string|null;online:boolean;busy:boolean;
  presentation?:'advanced'|'simple';
  post:(path:string,body:object)=>Promise<unknown>;
  onSaved:(version:PlanningVersion)=>void;
}

/** Read defaults never mutate the version content or its historical hash. */
export function planningDepth(value:unknown):'simple'|'detailed' {return value==='simple'?'simple':'detailed';}
export function planningDepthReason(draft:PlanningDraft):string {
  return draft.depthReason?.trim() || (planningDepth(draft.depth)==='simple'
    ?'간단한 목표와 최소 작업으로 정리합니다.'
    :'깊이가 명확하지 않으면 상세 명세로 검토합니다.');
}
