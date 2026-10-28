import type {ProjectProgress} from '../shared/project-progress.ts';

/** Project screen read model: pure functions over recorded progress and file counts. */
export type StepState='done'|'active'|'pending'|'unavailable';
export interface Step {id:string;label:string;state:StepState;detail:string}
export const stepStateLabel:Record<StepState,string>={done:'완료',active:'진행 중',pending:'대기',unavailable:'미연결'};
const responded=new Set(['response_unverified','verified','verification_failed','revalidation_required']);

/** Pure: derives the six visible steps only from recorded progress and files. */
export function projectSteps(progress:ProjectProgress|null,outputs:number):Step[]{
  const plan=progress?.plan??null,tasks=progress?.tasks??[];
  const running=tasks.some(task=>task.stage==='running'||task.stage==='interrupt_requested');
  const done=tasks.filter(task=>responded.has(task.stage)).length;
  return [
    {id:'goal',label:'목표',state:plan?'done':'active',detail:plan?'정의됨':'요청을 기획으로 정리하세요'},
    {id:'plan',label:'기획',state:plan?.state==='approved'?'done':plan?'active':'pending',detail:plan?.state==='approved'?`승인 버전 ${plan.revision}`:'검토·승인 전'},
    {id:'run',label:'실행',state:running||(done>0&&done<tasks.length)?'active':tasks.length&&done===tasks.length?'done':'pending',detail:tasks.length?`작업 ${tasks.length}개 중 ${done}개 응답 완료${running?' · 실행 중':''}`:'승인 후 작업이 생깁니다'},
    {id:'cross',label:'교차 검증',state:'unavailable',detail:'다른 AI의 독립 검증은 아직 연결되지 않았습니다'},
    {id:'fix',label:'수정·재검증',state:'unavailable',detail:'자동 수정은 미연결 · 추가 지시로 새 버전을 만들어 다시 실행'},
    {id:'result',label:'결과물',state:outputs?'done':'pending',detail:outputs?`파일 ${outputs}개`:'아직 없음'},
  ];
}
/** The single most useful next action, from recorded state only. */
export function nextAction(progress:ProjectProgress|null,outputs:number):{text:string;target:'plan'|'tasks'|'results'|'followup'}{
  const tasks=progress?.tasks??[];
  if(!progress?.plan)return {text:'AI에게 기획을 요청하세요',target:'followup'};
  if(progress.plan.state!=='approved')return {text:'기획을 확인하고 승인하세요',target:'plan'};
  if(!tasks.length)return {text:'승인한 기획으로 작업을 준비하세요',target:'plan'};
  if(tasks.some(task=>task.stage==='running'||task.stage==='interrupt_requested'))return {text:'AI가 실행 중입니다. 작업 상태를 확인하세요',target:'tasks'};
  if(tasks.some(task=>task.stage==='not_started'))return {text:'준비된 작업을 실행하세요',target:'tasks'};
  if(tasks.some(task=>['error','lost','interrupted'].includes(task.stage)))return {text:'멈춘 작업의 원인을 확인하세요',target:'tasks'};
  if(outputs)return {text:'결과물을 확인하세요',target:'results'};
  return {text:'추가 지시로 결과를 다듬으세요',target:'followup'};
}

