import type {PlanningDraft,PlanningVersion,SavedTask} from './parallel.ts';

export type PlanningRequirement=PlanningDraft['requirements'][number];
export type PlanningVersionIdentity=Pick<PlanningVersion,'id'|'revision'|'contentHash'|'state'>;
export interface PlanningFieldChange {
  field:'title'|'goal'|'constraints'|'openQuestions'|'source'|'requirementOrder'|'decisions'|'provenance';
  before:string|string[];after:string|string[];
}
export interface PlanningRequirementChange {
  label:string;status:'added'|'removed'|'changed'|'unchanged';
  before:PlanningRequirement|null;after:PlanningRequirement|null;
}
export interface PlanningTaskImpact {
  taskId:string;planningVersionId:string;requirementLabels:string[];
  reasons:('requirement_changed'|'requirement_removed'|'plan_context_changed')[];
}
export interface PlanningComparisonData {
  projectId:string;base:PlanningVersionIdentity;target:PlanningVersionIdentity;
  fields:PlanningFieldChange[];requirements:PlanningRequirementChange[];affectedTasks:PlanningTaskImpact[];
}
export interface PlanningComparison extends PlanningComparisonData {
  targetCurrent:boolean;canReplan:boolean;previewDigest:string;
  availableLabels:string[];existingLabels:string[];
}
export interface PlanningReplanInput {
  baseVersionId:string;expectedPreviewDigest:string;requirementLabels:string[];
}
export interface PlanningComparisonProps {
  projectId:string;versions:PlanningVersion[];selected?:PlanningVersion;dirty:boolean;busy:boolean;
  onCompare:(projectId:string,targetId:string,baseId:string)=>Promise<PlanningComparison>;
  onReplan:(projectId:string,targetId:string,input:PlanningReplanInput)=>Promise<SavedTask[]>;
}
