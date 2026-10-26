import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningVersion, SavedTask } from '../../shared/parallel.ts';
import type { PlanningComparisonData, PlanningFieldChange, PlanningRequirementChange, PlanningTaskImpact,
  PlanningVersionIdentity } from '../../shared/planning-revisions.ts';
import { AppError } from '../errors.ts';
import { normalizeStoredPlanningDraft } from './parser.ts';

const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

function validateVersion(version:PlanningVersion):void {
  if(!version||!validId(version.id)||!validId(version.projectId)||!Number.isSafeInteger(version.revision)||version.revision<1
    ||!['draft','approved','superseded'].includes(version.state))throw new AppError('PLANNING_VERSION_INVALID',409);
  try{
    const draft=version.draft;
    const parsed=normalizeStoredPlanningDraft(draft);
    if(!parsed.ok||!isDeepStrictEqual(parsed.draft,draft)
      ||createHash('sha256').update(JSON.stringify(draft)).digest('hex')!==version.contentHash)throw new Error();
  }catch{throw new AppError('PLANNING_VERSION_INVALID',409);}
}

const identity=({id,revision,contentHash,state}:PlanningVersion):PlanningVersionIdentity=>({id,revision,contentHash,state});

/**
 * Pure comparison of authoritative stored records. The caller supplies project
 * authorization, current-head checks and explicit approval for any follow-up.
 * A comparison never grants execution authority or alters a saved task.
 */
export function comparePlanningVersions(base:PlanningVersion,target:PlanningVersion,tasks:SavedTask[]):PlanningComparisonData {
  validateVersion(base);validateVersion(target);
  if(base.projectId!==target.projectId||!validId(base.lineageId)||!validId(target.lineageId)||base.lineageId!==target.lineageId
    ||base.id===target.id||base.revision>=target.revision)throw new AppError('PLANNING_COMPARISON_SCOPE_INVALID',409);

  const fields:PlanningFieldChange[]=[];
  for(const field of ['title','goal','constraints','openQuestions','source'] as const){
    if(!isDeepStrictEqual(base.draft[field],target.draft[field]))fields.push({field,before:base.draft[field],after:target.draft[field]});
  }
  const beforeOrder=base.draft.requirements.map(requirement=>requirement.label);
  const afterOrder=target.draft.requirements.map(requirement=>requirement.label);
  if(!isDeepStrictEqual(beforeOrder,afterOrder))fields.push({field:'requirementOrder',before:beforeOrder,after:afterOrder});

  const beforeRequirements=new Map(base.draft.requirements.map(requirement=>[requirement.label,requirement]));
  const afterRequirements=new Map(target.draft.requirements.map(requirement=>[requirement.label,requirement]));
  const requirements:PlanningRequirementChange[]=base.draft.requirements.map(before=>{
    const after=afterRequirements.get(before.label)??null;
    const status=!after?'removed':before.description!==after.description||!isDeepStrictEqual(before.acceptanceCriteria,after.acceptanceCriteria)?'changed':'unchanged';
    return {label:before.label,status,before,after};
  });
  for(const after of target.draft.requirements){
    if(!beforeRequirements.has(after.label))requirements.push({label:after.label,status:'added',before:null,after});
  }

  const changedLabels=new Set(requirements.filter(requirement=>requirement.status==='changed').map(requirement=>requirement.label));
  const removedLabels=new Set(requirements.filter(requirement=>requirement.status==='removed').map(requirement=>requirement.label));
  const contextChanged=fields.some(change=>change.field==='goal'||change.field==='constraints'||change.field==='openQuestions');
  const affectedTasks:PlanningTaskImpact[]=[];
  for(const task of tasks){
    if(task.projectId!==base.projectId||task.planningVersionId!==base.id)continue;
    const reasons:PlanningTaskImpact['reasons']=[];
    if(task.requirementLabels.some(label=>changedLabels.has(label)))reasons.push('requirement_changed');
    if(task.requirementLabels.some(label=>removedLabels.has(label)))reasons.push('requirement_removed');
    if(contextChanged)reasons.push('plan_context_changed');
    if(reasons.length)affectedTasks.push({taskId:task.id,planningVersionId:task.planningVersionId,requirementLabels:task.requirementLabels,reasons});
  }
  return structuredClone({projectId:base.projectId,base:identity(base),target:identity(target),fields,requirements,affectedTasks});
}
