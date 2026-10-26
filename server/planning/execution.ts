import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningVersion, SavedTask } from '../../shared/parallel.ts';
import { AppError } from '../errors.ts';
import { approvalIssues, normalizeStoredPlanningDraft } from './parser.ts';

export interface ExecutionBrief {prompt:string;planningVersionId:string;requirementLabels:string[]}
export const MAX_EXECUTION_PROMPT_CHARS=4000;
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/**
 * Pure validation/formatting only. The caller must load both records from its
 * authoritative storage and require this version to be its current approved head.
 * IDs, hashes and approval metadata supplied by a browser are not authorization.
 * Request/workspace identity and idempotency remain the launch controller's job.
 */
export function buildExecutionBrief(task:SavedTask,version:PlanningVersion):ExecutionBrief {
  if(!task||!validId(task.id)||!validId(task.projectId)||!validId(task.planningVersionId))throw new AppError('INVALID_EXECUTION_TASK',400);
  if(!version||!validId(version.id)||!validId(version.projectId))throw new AppError('PLANNING_VERSION_INVALID',409);
  if(task.projectId!==version.projectId||task.planningVersionId!==version.id)throw new AppError('TASK_PLAN_MISMATCH',409);
  if(version.state!=='approved')throw new AppError('NOT_APPROVED',422);
  if(typeof version.approvedAt!=='string'||!Number.isFinite(Date.parse(version.approvedAt))||typeof version.approvedBy!=='string'||!version.approvedBy.trim()
    ||!Number.isSafeInteger(version.revision)||version.revision<1)throw new AppError('PLANNING_VERSION_INVALID',409);
  const draft=version.draft;
  if(!draft||typeof draft!=='object')throw new AppError('PLANNING_VERSION_INVALID',409);
  try{
    const parsed=normalizeStoredPlanningDraft(draft);
    if(!parsed.ok||!isDeepStrictEqual(parsed.draft,draft)||approvalIssues(draft).length
      ||createHash('sha256').update(JSON.stringify(draft)).digest('hex')!==version.contentHash)throw new Error();
  }catch{throw new AppError('PLANNING_VERSION_INVALID',409);}
  if(draft.openQuestions.length)throw new AppError('UNRESOLVED_QUESTIONS',422);
  // Persisted task drafts currently represent exactly one requirement. Reject
  // invented multi-requirement snapshots rather than guessing a merge format.
  if(!Array.isArray(task.requirementLabels)||task.requirementLabels.length!==1)throw new AppError('TASK_PLAN_MISMATCH',409);
  const requirements=version.draft.requirements.filter(requirement=>task.requirementLabels.includes(requirement.label));
  const requirement=requirements[0];
  if(requirements.length!==1||task.title!==`${requirement.label}: ${requirement.description.split('\n')[0]}`
    ||task.description!==requirement.description||!isDeepStrictEqual(task.acceptanceCriteria,requirement.acceptanceCriteria))throw new AppError('TASK_PLAN_MISMATCH',409);
  const prompt='Implement the saved task below within the selected isolated workspace. Follow every plan constraint. Report verification honestly; an agent response is not a passed check.\n'+JSON.stringify({
    taskId:task.id,planningVersionId:version.id,contentHash:version.contentHash,title:version.draft.title,
    goal:version.draft.goal,requirements,constraints:version.draft.constraints,decisions:version.draft.decisions??[],
  },null,2);
  if(prompt.length>MAX_EXECUTION_PROMPT_CHARS)throw new AppError('EXECUTION_BRIEF_TOO_LARGE',422);
  return {prompt,planningVersionId:version.id,requirementLabels:[...task.requirementLabels]};
}
