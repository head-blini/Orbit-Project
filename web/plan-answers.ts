import type {PlanningDraft} from '../shared/parallel.ts';

/**
 * Turns the user's answers to open questions into a new draft: each answered question
 * becomes a decision whose rationale records that the user answered it. Unanswered
 * questions stay open, so approval stays blocked until they are resolved.
 */
export function answerOpenQuestions(draft:PlanningDraft,answers:Readonly<Record<number,string>>):PlanningDraft{
  const answered=draft.openQuestions.map((question,index)=>({question,answer:(answers[index]??'').trim()}));
  return {...draft,
    openQuestions:answered.filter(item=>!item.answer).map(item=>item.question),
    decisions:[...(draft.decisions??[]),...answered.filter(item=>item.answer).map(item=>({topic:item.question.slice(0,200),decision:item.answer.slice(0,1000),rationale:'사용자가 기획 검토 중 직접 답변함'}))]};
}
