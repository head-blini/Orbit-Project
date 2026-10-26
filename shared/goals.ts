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
  requirements:GoalRequirementView[];blockers:string[];evidenceScope:string;
}
export interface CreateTrackedGoalInput {requestId:string;planningVersionId:string;expectedPlanningHash:string}
export interface SetTrackingStateInput {requestId:string;expectedRevision:number;state:TrackingState}
