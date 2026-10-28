import {isAbsolute,normalize} from 'node:path';
import type {HandoffPackage} from '../../shared/handoff.ts';
import {containsCredential,safeText} from '../privacy.ts';
import {inspectOutbound} from '../guardrails/outbound.ts';
import {AppError} from '../errors.ts';

/**
 * Cross-model review: a different AI reads the producer's output against the approved
 * baseline in read-only mode. The result is an AI opinion, never verification or approval.
 */
export interface ClaudeReviewResult {
  kind:'ai_review_opinion';verdict:'approve'|'changes_requested'|'unclear';baselineRespected:boolean|null;
  criteria:{criterion:string;status:'met'|'not_met'|'unclear';evidence:string}[];
  findings:{severity:'high'|'medium'|'low';summary:string;path:string|null}[];
}
const runtimeName={codex:'Codex','claude-code':'Claude Code'} as const;
const clip=(text:string,max:number)=>{const value=safeText(text).replace(/\s+/g,' ').trim();return value.length>max?value.slice(0,max-1)+'…':value;};
const list=(items:readonly string[])=>items.slice(0,20).map(item=>'- '+clip(item,200)).join('\n')||'- (없음)';
const relative=(path:string)=>typeof path==='string'&&!!path&&path.length<=200&&!isAbsolute(path)&&!/[\x00-\x1f\\]/.test(path)&&!normalize(path).startsWith('..');
const criteriaOf=(handoff:HandoffPackage)=>handoff.requirements.flatMap(requirement=>requirement.acceptanceCriteria);

export function claudeReviewPrompt(input:{handoff:HandoffPackage;producer:keyof typeof runtimeName;targets:readonly string[]}):string{
  if(!input.targets.length||input.targets.length>50||!input.targets.every(relative))throw new AppError('INVALID_REVIEW_TARGET',400);
  const {handoff}=input;
  return [
    `${runtimeName[input.producer]}가 만든 결과를 승인 기준에 비추어 검토하세요. 파일을 수정하지 말고 읽기만 하세요.`,
    `프로젝트 목표: ${clip(handoff.goal,400)}`,
    `승인 기준: ${handoff.baseline.planningVersionId} r${handoff.baseline.revision} · ${handoff.baseline.contentHash.slice(0,12)}${handoff.baseline.current?'':' (현재 승인본 아님)'}`,
    '완료 조건(이 목록의 문장을 그대로 criterion으로 사용):',list(criteriaOf(handoff)),
    '제약:',list(handoff.constraints),'하지 않을 것:',list(handoff.nonGoals),
    '승인된 결정과 이유:',handoff.decisions.slice(0,20).map(d=>`- ${clip(d.decision,160)} — ${clip(d.rationale,200)}`).join('\n')||'- (없음)',
    '미해결 사항:',list(handoff.openQuestions),
    '검토 대상 파일:',input.targets.map(path=>'- '+path).join('\n'),
    '이 검토는 AI 의견이며 검증 통과가 아니고 승인 기준을 바꾸지 않습니다.',
    '다른 설명 없이 JSON 하나만 출력하세요: {"verdict":"approve|changes_requested|unclear","baseline_respected":true|false|null,'
      +'"criteria":[{"criterion":"<완료 조건 원문>","status":"met|not_met|unclear","evidence":"<근거>"}],'
      +'"findings":[{"severity":"high|medium|low","summary":"<문제>","path":"<상대 경로 또는 null>"}]}. 모든 완료 조건을 한 번씩 포함하세요.',
  ].join('\n');
}

const invalid=():never=>{throw new AppError('REVIEW_OUTPUT_INVALID',422);};
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():invalid();

export function parseClaudeReview(output:string,handoff:HandoffPackage):ClaudeReviewResult{
  let value:Record<string,unknown>;
  try{value=JSON.parse(output.trim());}catch{return invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  // Inspect every string the model returned before any of it is stored or shown.
  const strings:string[]=[],pending:unknown[]=[value];
  while(pending.length){const item=pending.pop();if(typeof item==='string')strings.push(item);else if(item&&typeof item==='object')pending.push(...Object.values(item));}
  const joined=strings.join('\n');if(containsCredential(joined)||inspectOutbound(joined).length)throw new AppError('REVIEW_OUTPUT_BLOCKED',422);
  const verdict=value.verdict;if(verdict!=='approve'&&verdict!=='changes_requested'&&verdict!=='unclear')invalid();
  const respected=value.baseline_respected;if(respected!==true&&respected!==false&&respected!==null)invalid();
  if(!Array.isArray(value.criteria)||!Array.isArray(value.findings)||value.findings.length>50)invalid();
  const expected=criteriaOf(handoff),criterionLimit=expected.reduce((max,criterion)=>Math.max(max,criterion.length),400),criteria=(value.criteria as Record<string,unknown>[]).map(item=>{
    const status=item?.status;if(status!=='met'&&status!=='not_met'&&status!=='unclear')invalid();
    return {criterion:text(item.criterion,criterionLimit),status:status as ClaudeReviewResult['criteria'][number]['status'],evidence:clip(text(item.evidence,1000),500)};
  });
  // Exactly the approved criteria, each once: the reviewer cannot add, drop or rename them.
  if(criteria.length!==expected.length||new Set(criteria.map(c=>c.criterion)).size!==criteria.length||!criteria.every(c=>expected.includes(c.criterion)))invalid();
  if(verdict==='approve'&&criteria.some(c=>c.status==='not_met'))invalid();
  const findings=(value.findings as Record<string,unknown>[]).map(item=>{
    const severity=item?.severity;if(severity!=='high'&&severity!=='medium'&&severity!=='low')invalid();
    const path=item.path===null?null:text(item.path,200);if(path!==null&&!relative(path))invalid();
    return {severity:severity as ClaudeReviewResult['findings'][number]['severity'],summary:clip(text(item.summary,1000),500),path};
  });
  return {kind:'ai_review_opinion',verdict:verdict as ClaudeReviewResult['verdict'],baselineRespected:respected as boolean|null,criteria,findings};
}
