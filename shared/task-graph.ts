import type {PlanningVersion} from './parallel.ts';

/** References only; SavedTask and PlanningVersion remain the content authorities. */
export interface TaskGraphContract {id:string;digest:string}
export interface TaskGraphImpactScope {files:string[];resources:string[]}
export interface TaskGraphMetadata {contracts?:TaskGraphContract[];impactScope?:TaskGraphImpactScope}
export interface TaskGraphNode extends TaskGraphMetadata {taskId:string}
/** taskId depends on dependsOn; the latter must be verified done before readiness. */
export interface TaskGraphEdge extends TaskGraphMetadata {taskId:string;dependsOn:string}
export interface TaskGraphInput {
  planningVersionId:string;contentHash:string;expectedRevision:number;
  nodes:TaskGraphNode[];edges:TaskGraphEdge[];
}
export interface TaskGraphRevision {
  projectId:string;planningVersionId:string;contentHash:string;revision:number;createdAt:string;
  nodes:TaskGraphNode[];edges:TaskGraphEdge[];
}
export interface TaskGraphBaseline {version:PlanningVersion|null;currentVersionId:string|null}
/** Trusted caller supplies facts for this graph revision; execution completion is not verification. */
export interface TaskGraphFacts {
  verifiedDoneIds:string[];
  blocked:{taskId:string;reasonCodes:string[]}[];
}
export type TaskGraphNodeState = {taskId:string}&(
  {state:'ready'|'done'}|{state:'waiting';predecessors:string[]}|
  {state:'blocked';reasonCodes:string[]}|{state:'stale';reasonCodes:['TASK_GRAPH_BASELINE_CHANGED']}
);
export interface TaskGraphState {stale:boolean;nodes:TaskGraphNodeState[]}
