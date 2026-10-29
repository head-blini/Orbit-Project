import {isAbsolute,normalize} from 'node:path';
import type {Execution} from '../../shared/types.ts';
import type {ProgressSignals} from '../../shared/project-progress.ts';
import type {ClaudeEvent,ClaudeOutcome} from './claude-code.ts';
import {safeText} from '../privacy.ts';
import {AppError} from '../errors.ts';

/** Pieces the Controller needs to run a project Task on Claude Code; no persistence here. */
export interface ClaudeTaskInput {
  title:string;goal:string;baseline:{planningVersionId:string;revision:number;contentHash:string};
  acceptanceCriteria:readonly string[];constraints:readonly string[];nonGoals:readonly string[];
  decisions:readonly {decision:string;rationale:string}[];deliverable:string;
  /** Project-relative user materials (inputs/…) the task may read. */
  materials?:readonly string[];
}

const clip=(value:string,max:number)=>{const text=safeText(value).replace(/\s+/g,' ').trim();return text.length>max?text.slice(0,max-1)+'…':text;};
const list=(items:readonly string[],max=12)=>items.slice(0,max).map(item=>'- '+clip(item,200)).join('\n')||'- (없음)';

export function claudeTaskPrompt(input:ClaudeTaskInput):string{
  const file=normalize(input.deliverable);
  if(!input.deliverable||isAbsolute(input.deliverable)||file.startsWith('..')||/[\x00-\x1f]/.test(input.deliverable)||file.length>120)throw new AppError('INVALID_DELIVERABLE',400);
  return [
    `작업: ${clip(input.title,200)}`,
    `프로젝트 목표: ${clip(input.goal,400)}`,
    `승인 기준: ${input.baseline.planningVersionId} r${input.baseline.revision} · ${input.baseline.contentHash.slice(0,12)}`,
    '완료 조건:',list(input.acceptanceCriteria),
    '제약:',list(input.constraints),
    '하지 않을 것:',list(input.nonGoals),
    '승인된 결정과 이유:',input.decisions.slice(0,12).map(d=>`- ${clip(d.decision,160)} — ${clip(d.rationale,200)}`).join('\n')||'- (없음)',
    ...(input.materials?.length?['사용자 자료(읽기 전용, 수정 금지):',list(input.materials,20),'결과물의 수치·사실은 위 자료에서 가져오고, 계산한 값은 계산값이라고 표시하세요. 자료에 없는 내용은 지어내지 마세요.']:[]),
    `결과물은 현재 폴더의 ${file} 파일로 작성하세요. 다른 위치에 쓰지 마세요.`,
    // Live E2E 2026-10-29: the default file must not override approved criteria that name their own file.
    '단, 위 완료 조건이나 제약이 파일 이름·위치를 정하거나 다른 파일 생성을 금지하면 그 기준을 따르고 위 기본 파일은 만들지 마세요.',
    '승인 기준을 바꾸지 마세요. 기준과 충돌하거나 정보가 부족하면 결과물(없으면 최종 응답)에 미해결 사항으로 적으세요.',
    '완료를 선언해도 검증은 Orbit이 완료 조건으로 따로 수행합니다.',
  ].join('\n');
}

export function executionForClaudeOutcome(outcome:ClaudeOutcome):{execution:Execution;reason:string|null}{
  if(outcome.dispatch==='not_started'&&outcome.status==='interrupted')return {execution:'interrupted',reason:null};
  if(outcome.dispatch==='not_started'&&outcome.issue)return {execution:'failed',reason:outcome.issue};
  if(outcome.status==='spawn_failed')return {execution:'failed',reason:'RUNTIME_NOT_STARTED'};
  if(outcome.exit!=='observed')return {execution:'lost',reason:'EXIT_NOT_OBSERVED'};
  switch(outcome.status){
    case 'completed':return {execution:'completed',reason:null};
    case 'interrupted':return {execution:'interrupted',reason:null};
    case 'unknown':return {execution:'lost',reason:'RESULT_NOT_OBSERVED'};
    case 'auth_required':return {execution:'failed',reason:'LOGIN_REQUIRED'};
    case 'quota_exhausted':return {execution:'failed',reason:'QUOTA_EXHAUSTED'};
  }
  return {execution:'failed',reason:'RUNTIME_ERROR'};
}

export function quotaFromClaudeWindows(event:Pick<Extract<ClaudeEvent,{kind:'quota'}>,'status'|'windows'>|null):NonNullable<ProgressSignals['quota']>{
  if(!event)return 'unknown';
  if(event.status==='rejected'||event.windows.some(window=>window.status==='rejected'))return 'exhausted';
  return event.status==='unknown'&&!event.windows.length?'unknown':'available';
}
