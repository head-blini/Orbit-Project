import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningVersion, SavedTask } from '../../shared/parallel.ts';
import {renderOverlay,type HarnessVersion} from '../../shared/harness.ts';
import {classifyHarnessCandidate,harnessDigest,harnessV0} from '../harness-policy.ts';
import {containsCredential} from '../privacy.ts';
import {outboundDenial} from '../providers/policy.ts';
import type {HarnessStore} from '../harness-store.ts';
import { AppError } from '../errors.ts';
import { approvalIssues, normalizeStoredPlanningDraft } from './parser.ts';
import { BRIEF_HEADER, MAX_EXECUTION_PROMPT_CHARS, briefPrompt } from './brief.ts';
export { MAX_EXECUTION_PROMPT_CHARS };

export interface ExecutionBrief {prompt:string;planningVersionId:string;planningContentHash:string;requirementLabels:string[]}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
// Random digit runs in UUIDs/SHA-256 digests match phone/national-id patterns, so PII inspection blanks only the
// brief's leading identifier values when UUID/digest-shaped. Free text and credential checks still see everything.
const BRIEF_GUIDANCE='Implement the saved task below within the selected isolated workspace. ';
const escapeRegex=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const briefIdentifiers=new RegExp('^('+escapeRegex(BRIEF_GUIDANCE)
  +'(?:\\n추가 실행 지침\\(Orbit 하네스 v[1-9][0-9]*\\):\\n(?:- [^\\r\\n]{1,160}\\n){1,5})?'
  +escapeRegex(BRIEF_HEADER.slice(BRIEF_GUIDANCE.length))+')'
  +'\\{\\n  "taskId": "([^"]*)",\\n  "planningVersionId": "([^"]*)",\\n  "contentHash": "([^"]*)"');
const opaqueId=(v:string)=>/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(v);
/** Text for PII inspection of an outbound prompt that may start with an execution brief. Never send this text. */
export const briefPiiInspectionText=(text:string)=>text.replace(briefIdentifiers,(_m,header:string,taskId:string,versionId:string,hash:string)=>
  `${header}{\n  "taskId": "${opaqueId(taskId)?'':taskId}",\n  "planningVersionId": "${opaqueId(versionId)?'':versionId}",\n  "contentHash": "${opaqueId(hash)?'':hash}"`);

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
  const prompt=briefPrompt({taskId:task.id,planningVersionId:version.id,contentHash:version.contentHash},draft,requirements);
  if(prompt.length>MAX_EXECUTION_PROMPT_CHARS)throw new AppError('EXECUTION_BRIEF_TOO_LARGE',422);
  return {prompt,planningVersionId:version.id,planningContentHash:version.contentHash,requirementLabels:[...task.requirementLabels]};
}

export type CodexHarnessContext={selected:HarnessVersion;applied:Pick<HarnessVersion,'target'|'versionId'|'revision'|'digest'>;reason?:'HARNESS_TOO_LARGE'};

/** Same injection-time AX06 and rendered-text checks as the Claude path. Only current() selects a version. */
export function activeCodexHarness(harness:Pick<HarnessStore,'current'>,projectId:string):HarnessVersion {
  let version:HarnessVersion,overlay:string;
  try{version=harness.current(projectId,'codex_brief');overlay=renderOverlay(version);}
  catch(error){throw new AppError(error instanceof AppError&&/^HARNESS_[A-Z_]+$/.test(error.message)?error.message:'HARNESS_INTEGRITY',409);}
  if(version.target!=='codex_brief'||version.class!=='execution_guidance'||version.digest!==harnessDigest(version))throw new AppError('HARNESS_INTEGRITY',409);
  if(version.revision>0){
    const verdict=classifyHarnessCandidate({class:version.class,target:version.target,lines:version.lines,origin:'user',evidence:null});
    if(verdict.status==='blocked')throw new AppError(verdict.reasons[0],409);
    if(containsCredential(overlay)||outboundDenial(overlay))throw new AppError('HARNESS_UNSAFE_TEXT',409);
  }
  return version;
}

/** Preserve the entire v0 prompt, including repair context, when the overlay exceeds the Codex bound. */
export function injectCodexHarness(prompt:string,selected:HarnessVersion):{prompt:string;harness:CodexHarnessContext} {
  const overlay=renderOverlay(selected);
  if(!prompt.startsWith(BRIEF_HEADER))throw new AppError('HARNESS_INTEGRITY',409);
  const rendered=overlay?BRIEF_GUIDANCE+'\n'+overlay+'\n'+prompt.slice(BRIEF_GUIDANCE.length):prompt;
  const overflow=!!overlay&&rendered.length>MAX_EXECUTION_PROMPT_CHARS;
  const {target,versionId,revision,digest}=overflow?harnessV0('codex_brief'):selected;
  return {prompt:overflow?prompt:rendered,harness:{selected,applied:{target,versionId,revision,digest},...(overflow?{reason:'HARNESS_TOO_LARGE' as const}:{})}};
}
