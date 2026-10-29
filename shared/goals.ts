import type {TaskCompletion} from './task-completion.ts';
import type {DeliverableVersion} from './deliverables.ts';
import type {Execution} from './types.ts';
export type TrackingState='tracking'|'paused'|'cancelled';
export interface TrackedGoal {
  id:string;projectId:string;planningVersionId:string;planningHash:string;revision:number;
  level:'tracking';state:TrackingState;createdAt:string;updatedAt:string;
}
export interface GoalEvidenceReference {
  kind:'run'|'check'|'review'|'approval'|'merge';id:string;runId:string;status:string;
  sourceDigest:string|null;qualification:'reference_only';
}
export interface GoalRequirementView {
  label:string;description:string;acceptanceCriteria:string[];taskIds:string[];
  runs:{id:string;execution:Execution}[];runsTotal:number;acceptance:'unverified';
  evidence:GoalEvidenceReference[];evidenceTotal:number;
}
export interface TrackedGoalView {
  goal:TrackedGoal;title:string;objective:string;planCurrent:boolean;
  verifiedDone?:boolean;
  taskCompletions?:{taskId:string;runId:string|null;verifiedDone:boolean;completion:TaskCompletion|null}[];
  deliverables?:DeliverableVersion[];
  requirements:GoalRequirementView[];blockers:string[];evidenceScope:string;
}
export interface CreateTrackedGoalInput {requestId:string;planningVersionId:string;expectedPlanningHash:string}
export interface SetTrackingStateInput {requestId:string;expectedRevision:number;state:TrackingState}

/** Downgrade-only guard for read models and offline UI snapshots. CQG remains the authority. */
export function currentGoalCompletion(completion:TaskCompletion|null|undefined):boolean {
  if(!completion?.verifiedDone||!completion.qualityPassed||!completion.gates.length)return false;
  const required=[...completion.gates,...(completion.tools??[])];
  if(!required.every(d=>d.freshness==='current'&&['local','native'].includes(d.source)&&['passed','not_applicable'].includes(d.status)))return false;
  return [completion.independentReview,completion.userApproval].every(d=>
    d.freshness!=='stale'&&d.source!=='mock'&&(!['passed','completed'].includes(d.status)||(d.freshness==='current'&&['local','native'].includes(d.source))));
}
