import type {ProjectProgress,ProgressTask} from '../shared/project-progress.ts';
import type {QualityLoopRecord,QualityModelEvidence} from '../shared/quality-loop-record.ts';
import type {QualityDimension,QualityProgress} from '../shared/quality-progress.ts';

/** Project screen read model: pure functions over recorded progress and file counts. */
export type StepState='done'|'active'|'pending'|'attention'|'blocked'|'unavailable';
export interface Step {id:string;label:string;state:StepState;detail:string;evidence?:string[]}
export const stepStateLabel:Record<StepState,string>={done:'완료',active:'진행 중',pending:'대기',attention:'확인 필요',blocked:'차단',unavailable:'미연결'};
const responded=new Set(['response_unverified','verified','verification_failed','revalidation_required']);

/** Where the recorded model identity came from. Only explicit native observation counts as native. */
export type QualityOrigin='native'|'mock'|'unknown';
export const qualityOriginLabel:Record<QualityOrigin,string>={native:'실제 실행 관측',mock:'모의 실행',unknown:'모델 미확인'};
/** Latest Quality Loop phase per task. `passed` needs native identities, a current baseline and passed required checks. */
export type QualityPhase='none'|'review'|'fix'|'retest'|'blocked'|'failed'|'stale'|'unverified'|'passed';
export interface TaskQuality {taskId:string;title:string;phase:QualityPhase;origin:QualityOrigin;reason:string;loop:QualityLoopRecord|null;server?:QualityProgress}
const phaseLabel:Record<QualityPhase,string>={none:'품질 기록 없음',review:'독립 검토 중',fix:'수정 중',retest:'재검증 중',blocked:'품질 검증 차단',failed:'품질 검증 실패',stale:'이전 기준 결과 · 재검증 필요',unverified:'통과로 보지 않음',passed:'독립 검토 일치 · 필수 검사 통과'};

export function qualityOrigin(loop:QualityLoopRecord):QualityOrigin{
  const evidence:(QualityModelEvidence|null)[]=[loop.producer,...loop.steps.filter(step=>step.kind!=='verification'&&step.state==='completed').map(step=>step.evidence)];
  if(evidence.some(item=>item?.evidenceSource==='mock'))return 'mock';
  // A missing evidenceSource is not proof of a native run; it stays unknown.
  return evidence.every(item=>item?.evidenceSource==='native'&&item.source==='native_observed'&&!!item.modelId)?'native':'unknown';
}
/** Native origin alone is not review proof: every selected reviewer needs a completed review observed as that model,
 * from a different model and run than the producer. */
export function independentlyReviewed(loop:QualityLoopRecord):boolean{
  const key=(e:QualityModelEvidence|null)=>e?.modelId?`${e.providerId}/${e.modelId}`:null,producer=key(loop.producer);
  const reviews=loop.steps.filter(step=>step.kind==='review'&&step.state==='completed').map(step=>step.evidence);
  return !!producer&&reviews.length>0&&!!loop.reviewers.length&&reviews.every(e=>!!key(e)&&key(e)!==producer&&e!.runId!==loop.producer.runId)
    &&loop.reviewers.every(r=>reviews.some(e=>key(e)===`${r.providerId}/${r.modelId}`));
}
const blockReason=(loop:QualityLoopRecord)=>loop.recoveryRequired?'실행 종료 확인 필요':loop.result.issue==='INDEPENDENT_MODEL_REQUIRED'?'실행 AI와 다른 독립 검토 모델이 필요합니다':/MODEL.*UNKNOWN|MODEL_MISMATCH|MODEL_EVIDENCE/.test(loop.result.issue??'')?'모델 신원을 확인하지 못했습니다':/QUOTA|RATE_LIMIT/.test(loop.result.issue??'')?'사용량 한도 대기':/PERMISSION|APPROVAL_DENIED|TOOLS_DENIED/.test(loop.result.issue??'')?'권한 확인 필요':loop.result.issue??'차단 사유 미기록';

/** Pure: classifies one task's newest Quality Loop record, then lets the server's QG-01 dimensions (when present) only downgrade it. */
export function taskQuality(task:ProgressTask):TaskQuality{
  const q=localServerQuality(task),c=task.completion;
  // The server completion verdict is authority: a local pass never survives verifiedDone=false.
  if(!c||c.verifiedDone||q.phase!=='passed')return q;
  const v=completionView(task)!;
  return {...q,phase:v.stale?'stale':'unverified',reason:`서버 완료 판정 미충족: ${v.label} · ${v.release}`};
}
function localServerQuality(task:ProgressTask):TaskQuality{
  const local=loopQuality(task),server=task.quality;
  if(!server||!local.loop||!['passed','failed','unverified'].includes(local.phase))return local;
  const blockers=(...dims:QualityDimension[])=>[...new Set(dims.flatMap(d=>d.blockers))].join(', ')||'근거 없음';
  if([server.semantic,server.independentReview,server.revalidation].some(d=>d.status==='stale'))return {...local,phase:'stale',reason:'서버 근거: 기준이나 결과물이 바뀌어 재검증이 필요합니다'};
  if(local.phase!=='passed')return local;
  if(server.independentReview.status!=='completed'||server.semantic.status!=='passed')return {...local,phase:'unverified',reason:`서버 근거 미충족 (독립 검토 ${server.independentReview.status} · 의미 기준 ${server.semantic.status}): ${blockers(server.independentReview,server.semantic)}`};
  if(server.repair.status==='completed'&&server.revalidation.status!=='passed')return {...local,phase:'unverified',reason:`수정 후 재검증 근거 없음 (${server.revalidation.status}): ${blockers(server.revalidation)}`};
  return local;
}
function loopQuality(task:ProgressTask):TaskQuality{
  const loop=task.qualityLoops?.[0]??null,base={taskId:task.id,title:task.title,loop,server:task.quality};
  if(!loop)return {...base,phase:'none',origin:'unknown',reason:'품질 검증을 실행한 기록이 없습니다'};
  const origin=qualityOrigin(loop),{status,repairs}=loop.result;
  if(loop.recoveryRequired||status==='blocked')return {...base,phase:'blocked',origin,reason:blockReason(loop)};
  if(status==='reviewing')return {...base,phase:repairs?'retest':'review',origin,reason:repairs?`수정 ${repairs}회 후 재검증 중`:'독립 AI가 검토 중'};
  if(status==='repairing')return {...base,phase:'fix',origin,reason:'검토 실패 항목을 수정 중'};
  if(loop.sourceRunId!==task.latestRunId||!task.planCurrent||task.stage==='revalidation_required')return {...base,phase:'stale',origin,reason:'더 새로운 실행이나 바뀐 기준이 있어 이 결과는 현재 기준이 아닙니다'};
  if(status==='failed'||status==='limit_reached')return {...base,phase:'failed',origin,reason:`${status==='limit_reached'?'수정·호출 한도 도달':'검토 미충족'} · 문제 ${loop.result.rounds.at(-1)?.failures.length??0}개`};
  if(origin!=='native')return {...base,phase:'unverified',origin,reason:origin==='mock'?'모의 실행 결과이며 실제 검증이 아닙니다':'실행·검토 모델 신원이 확인되지 않았습니다'};
  if(!independentlyReviewed(loop))return {...base,phase:'unverified',origin,reason:'독립 검토 완료 근거가 부족합니다'};
  if(loop.verification.status!=='passed')return {...base,phase:'unverified',origin,reason:`필수 검사 ${loop.verification.status==='failed'?'실패':'미확인'}`};
  return {...base,phase:'passed',origin,reason:repairs?`수정 ${repairs}회 후 재검증 통과`:'수정 없이 통과'};
}
/** Server completion verdict split into quality gates / independent review / user approval / release policy. Null when an older server sent none. */
export interface CompletionView {done:boolean;stale:boolean;label:string;gates:string;review:string;approval:string;release:string;reasons:string[]}
const decisionLabel=(d:{status:string;source:string;freshness:string})=>`${d.status==='passed'||d.status==='completed'?'통과':d.status==='not_applicable'?'해당 없음':d.status==='not_run'?'미실행':d.status==='failed'?'실패':d.status==='stale'?'기준 변경':'미확인'}${d.source==='mock'?' · 모의':d.source==='unknown'&&d.status!=='not_applicable'?' · 모델 미확인':''}${d.freshness==='stale'||d.status==='stale'?' · 기준 변경 · 재검증 필요':''}`;
export function completionView(task:ProgressTask):CompletionView|null{
  const c=task.completion;if(!c)return null;
  const all=[...c.gates,c.independentReview,c.userApproval];
  const stale=all.some(g=>g.freshness==='stale'||g.status==='stale'),mock=all.some(g=>g.source==='mock'),unknown=c.gates.some(g=>g.source==='unknown'&&g.status!=='not_applicable');
  const wait=c.reasonCodes.includes('CQG_DEPENDENCY_RELEASE_WAIT');
  const label=c.verifiedDone?'완료(검증됨)':stale?'기준 변경 · 재검증 필요':mock?'모의 · 완료로 보지 않음':unknown?'모델 미확인 · 완료로 보지 않음':c.qualityPassed?'품질 통과 · 종속 작업 해제 전':'완료 미인정';
  return {done:c.verifiedDone,stale,label,
    gates:c.qualityPassed?'품질 gate 통과':'품질 gate 미통과',review:`독립 검토 ${decisionLabel(c.independentReview)}`,approval:`사용자 승인 ${decisionLabel(c.userApproval)}`,
    release:c.verifiedDone?'종속 작업 해제됨':wait?'의존 작업 해제 대기: 정책 wait':'종속 작업 해제 전',reasons:c.reasonCodes};
}
/** Verified-task count: server completion when any task carries it, otherwise the server totals. */
export function verifiedTaskCount(progress:ProjectProgress):number{
  return progress.tasks.some(t=>t.completion)?progress.tasks.filter(t=>t.completion?.verifiedDone).length:progress.totals.verifiedTasks;
}
const evidenceLine=(q:TaskQuality)=>q.loop?`${q.title}: ${phaseLabel[q.phase]} · ${qualityOriginLabel[q.origin]} · ${q.reason} · 기록 ${q.loop.id.slice(0,8)} · 실행 ${q.loop.sourceRunId.slice(0,8)} · 회차 ${q.loop.result.rounds.length} · 필수 검사 ${q.loop.verification.status}${q.loop.result.issue?' · '+q.loop.result.issue:''}${q.server?` · 서버 독립 검토 ${q.server.independentReview.status} · 의미 기준 ${q.server.semantic.status} · 재검증 ${q.server.revalidation.status}`:' · 서버 품질 근거 없음'}`:`${q.title}: ${phaseLabel.none}`;

/** Pure: the two quality steps (교차 검증, 수정·재검증) from recorded Quality Loops only. */
export function qualitySteps(progress:ProjectProgress|null,kind:'general'|'code'):[Step,Step]{
  const all=(progress?.tasks??[]).map(taskQuality),evidence=all.map(evidenceLine);
  const of=(...phases:QualityPhase[])=>all.filter(q=>phases.includes(q.phase)),count=(...phases:QualityPhase[])=>of(...phases).length;
  const passed=count('passed'),total=all.length;
  const summary=[['통과',passed],['진행',count('review','fix','retest')],['실패',count('failed')],['차단',count('blocked')],['재검증 필요',count('stale')],['통과 미인정',count('unverified')],['기록 없음',count('none')]]
    .filter(([,n])=>n).map(([label,n])=>`${label} ${n}`).join(' · ');
  let cross:Step;
  if(!total||count('none')===total)cross={id:'cross',label:'교차 검증',state:'pending',detail:total?'품질 검증 기록 없음 · 통과로 보지 않습니다':'작업이 생기면 독립 AI가 검토합니다'};
  else if(count('blocked'))cross={id:'cross',label:'교차 검증',state:'blocked',detail:`${of('blocked')[0].reason} · ${summary}`};
  else if(count('review','fix','retest'))cross={id:'cross',label:'교차 검증',state:'active',detail:summary};
  else if(passed===total)cross={id:'cross',label:'교차 검증',state:'done',detail:`작업 ${total}개 독립 검토 일치`};
  else cross={id:'cross',label:'교차 검증',state:'attention',detail:summary};
  const repairs=all.reduce((sum,q)=>sum+(q.phase==='passed'?q.loop!.result.repairs:0),0);
  let fix:Step;
  if(count('fix'))fix={id:'fix',label:'수정·재검증',state:'active',detail:`수정 중 ${count('fix')}개`};
  else if(count('retest'))fix={id:'fix',label:'수정·재검증',state:'active',detail:`재검증 중 ${count('retest')}개`};
  else if(count('failed'))fix={id:'fix',label:'수정·재검증',state:'attention',detail:`검증 실패 ${count('failed')}개 · 추가 지시로 수정 필요`};
  else if(count('stale'))fix={id:'fix',label:'수정·재검증',state:'attention',detail:`이전 기준 결과 ${count('stale')}개 · 현재 기준으로 재검증 필요`};
  else if(total&&passed===total)fix={id:'fix',label:'수정·재검증',state:'done',detail:repairs?`수정 ${repairs}회 후 재검증 통과`:'수정 불필요 · 필수 검사 통과'};
  else fix={id:'fix',label:'수정·재검증',state:'pending',detail:kind==='code'?'검토 결과와 검증 명령으로 확인':'검토 실패 시 제한 안에서 수정 후 재검증'};
  return [{...cross,evidence},{...fix,evidence}];
}

/** Pure: derives the six visible steps only from recorded progress and files. */
export function projectSteps(progress:ProjectProgress|null,outputs:number):Step[]{
  const plan=progress?.plan??null,tasks=progress?.tasks??[];
  const running=tasks.some(task=>task.stage==='running'||task.stage==='interrupt_requested');
  const done=tasks.filter(task=>responded.has(task.stage)).length;
  return [
    {id:'goal',label:'목표',state:plan?'done':'active',detail:plan?'정의됨':'요청을 기획으로 정리하세요'},
    {id:'plan',label:'기획',state:plan?.state==='approved'?'done':plan?'active':'pending',detail:plan?.state==='approved'?`승인 버전 ${plan.revision}`:'검토·승인 전'},
    {id:'run',label:'실행',state:running||(done>0&&done<tasks.length)?'active':tasks.length&&done===tasks.length?'done':'pending',detail:tasks.length?`작업 ${tasks.length}개 중 ${done}개 응답 완료${running?' · 실행 중':''}`:'승인 후 작업이 생깁니다'},
    ...qualitySteps(progress,'general'),
    {id:'result',label:'결과물',state:outputs?'done':'pending',detail:outputs?`파일 ${outputs}개`:'아직 없음'},
  ];
}
/** Quality next action, or null when no Quality Loop record asks for one. */
export function qualityAction(progress:ProjectProgress|null):{text:string;target:'tasks'}|null{
  const all=(progress?.tasks??[]).map(taskQuality),has=(phase:QualityPhase)=>all.some(q=>q.phase===phase);
  if(has('blocked'))return {text:'품질 검증 차단 원인을 확인하세요',target:'tasks'};
  if(has('review')||has('fix')||has('retest'))return {text:'품질 검증이 진행 중입니다. 작업 상태를 확인하세요',target:'tasks'};
  if(has('failed'))return {text:'품질 검증 실패 항목을 확인하고 수정을 지시하세요',target:'tasks'};
  if(has('stale'))return {text:'현재 기준으로 품질 검증을 다시 실행하세요',target:'tasks'};
  if(has('unverified'))return {text:'통과로 인정되지 않은 품질 기록의 근거를 확인하세요',target:'tasks'};
  return null;
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
  const quality=qualityAction(progress);if(quality)return quality;
  if(outputs)return {text:'결과물을 확인하세요',target:'results'};
  return {text:'추가 지시로 결과를 다듬으세요',target:'followup'};
}

/** Simple-mode one-line status. Never reports done unless the server completion verdict says so for the current baseline. */
export function plainStatus(task:ProgressTask):{label:string;tone:'good'|'wait'|'bad'|'idle'}{
  const v=completionView(task),q=taskQuality(task);
  if(!task.planCurrent||task.stage==='revalidation_required'||v?.stale||q.phase==='stale')return {label:'기준이 바뀌어 다시 확인해야 함',tone:'wait'};
  if(v?.done)return {label:'끝났고 확인됨',tone:'good'};
  if(v)return {label:v.label.replace('완료 미인정','아직 완료로 인정되지 않음').replace('완료로 보지 않음','아직 완료 아님'),tone:'wait'};
  if(task.stage==='verified')return {label:'검사는 통과 · 최종 완료 판정은 아직 없음',tone:'wait'};
  return {label:({not_started:'아직 시작 안 함',quota_wait:'사용량 한도 대기',running:'AI가 작업 중',interrupt_requested:'중단 요청됨 · 종료 미확인',verifying:'결과 확인 중',
    response_unverified:'AI 응답 받음 · 아직 확인 전',verification_failed:'확인 결과 문제 있음',interrupted:'중단됨',error:'오류로 멈춤',lost:'연결이 끊겨 결과를 알 수 없음'} as Record<string,string>)[task.stage]??'상태 미확인',
    tone:['verification_failed','error','lost'].includes(task.stage)?'bad':task.stage==='running'||task.stage==='verifying'?'wait':'idle'};
}

/** A03/A11: tasks on an older baseline or with stale completion/quality/check evidence, and their re-verification state.
 * Only server-recorded freshness is used; the cause of the change is not in ProjectProgress and is never guessed. */
export type ReverifyState='needed'|'running';
export interface ImpactItem {taskId:string;title:string;onOldBaseline:boolean;inProgress:boolean;reverify:ReverifyState;reasons:string[];oldRunIds:string[]}
export function taskImpact(task:ProgressTask,currentPlanId:string|null):ImpactItem|null{
  const v=completionView(task),q=taskQuality(task),reasons:string[]=[];
  if(!task.planCurrent)reasons.push('작업이 이전 승인 기획 기준입니다');
  if(task.verification==='stale'||task.stage==='revalidation_required')reasons.push('검사 결과가 현재 기준과 다릅니다');
  if(v?.stale)reasons.push('서버 완료 판정의 근거가 오래되었습니다');
  if(q.phase==='stale')reasons.push('품질 검증 결과가 이전 기준입니다');
  if(!reasons.length)return null;
  const inProgress=task.stage==='running'||task.stage==='interrupt_requested'||task.stage==='verifying';
  // A run with no recorded planning version cannot be placed on either baseline; it is not listed as old.
  const oldRunIds=currentPlanId?task.runs.filter(r=>r.planningVersionId&&r.planningVersionId!==currentPlanId).map(r=>r.id):[];
  return {taskId:task.id,title:task.title,onOldBaseline:!task.planCurrent,inProgress,reverify:task.verification==='running'||task.stage==='verifying'||q.phase==='retest'?'running':'needed',reasons,oldRunIds};
}
