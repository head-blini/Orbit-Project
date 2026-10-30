import type {PlanningDraft} from '../../shared/parallel.ts';
import {approvalIssues} from './parser.ts';

/** Pure (no node/server imports) so the approval UI can use it too. Single owner of the execution brief layout. */
export const MAX_EXECUTION_PROMPT_CHARS=4000;
export const BRIEF_HEADER='Implement the saved task below within the selected isolated workspace. Follow every plan constraint. Report verification honestly; an agent response is not a passed check.\n';
export interface BriefIds {taskId:string;planningVersionId:string;contentHash:string}
/** Fixed-width stand-ins for the randomUUID ids and sha256 hash a real brief carries; used before a task exists. */
export const BRIEF_PLACEHOLDER_IDS:BriefIds={taskId:'0'.repeat(8)+'-0000-0000-0000-'+'0'.repeat(12),planningVersionId:'0'.repeat(8)+'-0000-0000-0000-'+'0'.repeat(12),contentHash:'0'.repeat(64)};
/** Rejected reuse candidates and a no-adopt summary are planning audit, not execution guidance; the plan keeps them. */
const executionDecisions=(draft:PlanningDraft)=>(draft.decisions??[]).filter(d=>!/^재사용 (?:미채택: |탐색 완료: )/.test(d.decision));
export function briefPrompt(ids:BriefIds,draft:PlanningDraft,requirements:PlanningDraft['requirements']):string{
  return BRIEF_HEADER+JSON.stringify({
    taskId:ids.taskId,planningVersionId:ids.planningVersionId,contentHash:ids.contentHash,title:draft.title,
    goal:draft.goal,requirements,constraints:draft.constraints,decisions:executionDecisions(draft),
    ...(draft.nonGoals?.length?{nonGoals:draft.nonGoals}:{}),
  },null,2);
}
/**
 * Approval-time check: one issue per requirement whose brief would exceed the run-start limit. Codex harness overlays
 * need no margin: injectCodexHarness falls back to the plain brief when an overlay would overflow, never refuses.
 */
export function briefSizeIssues(draft:PlanningDraft):{field:string;code:string}[]{
  return draft.requirements.flatMap((requirement,index)=>
    briefPrompt(BRIEF_PLACEHOLDER_IDS,draft,[requirement]).length>MAX_EXECUTION_PROMPT_CHARS?[{field:`requirements.${index}`,code:'EXECUTION_BRIEF_TOO_LARGE'}]:[]);
}
/** Everything that blocks approval: missing fields plus oversized execution briefs. */
export const planningApprovalIssues=(draft:PlanningDraft)=>[...approvalIssues(draft),...briefSizeIssues(draft)];
