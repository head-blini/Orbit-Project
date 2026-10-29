import {CapabilityRouting,type CapabilityRoutePost} from './capability-routing.tsx';
import type {CodexModelAttribution} from '../shared/codex-model-attribution.ts';
import type {QualityLoopRecord} from '../shared/quality-loop-record.ts';
import {getUiMode,subscribeUiMode} from './ui-mode.ts';
import {qualityOrigin,completionView,verifiedTaskCount,plainStatus} from './project-work-model.ts';
import {ProgressImpact} from './progress-impact.tsx';
import {TaskGraphPanel} from './task-graph-panel.tsx';
import {ClaudeRecoveryControl,QuotaResumeNote} from './claude-recovery.tsx';
import {useEffect,useRef,useState} from 'react';
import type {ConnectionFreshness,ProgressTask,ProjectProgress,TaskStage,ProgressVerification,ClaudeRunRecovery} from '../shared/project-progress.ts';
import type {HandoffHistoryEntry,HandoffPackage} from '../shared/handoff.ts';

export const stageLabels:Record<TaskStage,string>={
  not_started:'대기',quota_wait:'한도 대기',running:'실행 중',interrupt_requested:'중단 요청됨 · 종료 미확인',verifying:'검증 중',
  response_unverified:'AI 응답 완료 · 검증 전',verification_failed:'검증 실패',revalidation_required:'재검증 필요',verified:'검증 통과',
  interrupted:'중단 확인',error:'오류',lost:'연결 유실 · 결과 미확인',
};
const stageTone:Record<TaskStage,string>={not_started:'idle',quota_wait:'wait',running:'active',interrupt_requested:'wait',verifying:'active',response_unverified:'wait',
  verification_failed:'bad',revalidation_required:'wait',verified:'good',interrupted:'idle',error:'bad',lost:'bad'};
const verificationLabels:Record<ProgressVerification,string>={not_run:'검증 기록 없음',running:'검사 실행 중',passed:'검사 통과',failed:'검사 실패',stale:'기준 변경 · 재검증 필요',lost:'검사 결과 미확인'};
const nextActions:Partial<Record<TaskStage,string>>={
  not_started:'실행할 AI를 정해 시작하세요. 코드 작업은 작업 공간 선택과 검증 기준 확인이 먼저 필요합니다.',quota_wait:'관측된 사용량 한도가 소진되었습니다. 초기화 후 다시 실행하거나 다른 AI로 인계하세요. 자동 재시도하지 않습니다.',
  response_unverified:'AI 응답만 완료되었습니다. 결과를 검증 설정의 검사로 확인하세요.',verification_failed:'실패한 검사 결과를 확인하고 수정 작업을 만드세요.',
  revalidation_required:'승인 기준이 바뀌었습니다. 현재 기준으로 다시 검증하세요.',lost:'종료를 확인하지 못했습니다. 기록을 확인하기 전에는 같은 작업을 다시 실행하지 마세요.',
  error:'오류 기록을 확인한 뒤 다시 실행하거나 인계하세요.',interrupt_requested:'중단 요청을 보냈지만 종료는 아직 확인되지 않았습니다.',
};
export const blockerLabels:Record<string,string>={RECOVERY_REQUIRED:'종료를 확인하지 못한 실행이 있어 새 실행이 차단되었습니다.',LOGIN_REQUIRED:'AI 실행기 로그인이 필요합니다.',
  RUNTIME_NOT_INSTALLED:'AI 실행기가 설치되지 않았습니다.',RUNTIME_ERROR:'AI 실행기 연결 오류가 있습니다.',QUOTA_EXHAUSTED:'관측된 사용량 한도가 소진되었습니다.'};
const freshnessLabels:Record<ConnectionFreshness,string>={live:'실시간 이벤트 수신 중',quiet:'연결됨 · 최근 이벤트 없음',offline:'서버 연결 끊김 · 오래된 화면일 수 있음'};
const runtimeLabels:Record<string,string>={codex:'Codex','claude-code':'Claude Code'};
const time=(value:string|null)=>value?new Date(value).toLocaleString('ko-KR',{hour12:false}):'관측 기록 없음';
const runtime=(value:string|null)=>value?runtimeLabels[value]??value:'미지정';

/** Stages where a new explicit run may start. A lost run is never retried from here. */
export const runnableStages:readonly TaskStage[]=['not_started','error','interrupted','verification_failed','response_unverified','revalidation_required'];
export interface TaskActions {
  runtimeLabel:string;canRun:boolean;busy:boolean;pendingTaskId:string|null;handoff:{taskId:string;markdown:string;history?:HandoffHistoryEntry[]}|null;
  onRun(task:ProgressTask):void;onInterrupt(task:ProgressTask):void;onHandoff(task:ProgressTask):void;
  /** Explicit lost-run recovery; absent where the runtime has no such action. */onRecover?(runId:string):void;
}
function TaskButtons({task,actions,released}:{task:ProgressTask;actions:TaskActions;released:boolean}){
  // A lost head becomes runnable only after its explicit recovery; the new run still needs a click and a new requestId.
  const pending=actions.pendingTaskId===task.id,runnable=actions.canRun&&(runnableStages.includes(task.stage)||task.stage==='lost'&&released);
  return <div className="progress-actions">
    {(runnable||pending)&&<button className={task.stage==='not_started'&&!pending?'primary':''} disabled={actions.busy||(!!actions.pendingTaskId&&!pending)} onClick={()=>actions.onRun(task)}>
      {pending?'같은 요청으로 다시 확인':task.stage==='not_started'?`${actions.runtimeLabel}로 실행`:`${actions.runtimeLabel}로 다시 실행`}</button>}
    {actions.canRun&&task.stage==='running'&&task.latestRunId&&<button disabled={actions.busy} onClick={()=>actions.onInterrupt(task)}>중단 요청</button>}
    <button disabled={actions.busy} onClick={()=>actions.onHandoff(task)}>인계 자료 보기</button>
    {actions.handoff?.taskId===task.id&&<pre className="progress-handoff" aria-label="인계 자료">{actions.handoff.markdown}</pre>}
    {actions.handoff?.taskId===task.id&&<ul className="progress-handoff-history" aria-label="인계 이력">
      {Array.isArray(actions.handoff.history)&&actions.handoff.history.length?actions.handoff.history.map(entry=><li key={entry.seq}>{time(entry.at)} · {runtime(entry.destination)}로 전달 · {entry.receipt==='acknowledged'?'실행기가 시작을 확인함':'전달됨 · 시작 확인 기록 없음'}{entry.receipt==='delivered'&&entry.runExecution&&['failed','lost','interrupted'].includes(entry.runExecution)?` (실행 상태: ${entry.runExecution})`:''}</li>):<li>아직 실행기로 전달된 기록이 없습니다.</li>}
    </ul>}
  </div>;
}

function TaskRow({task,actions,advanced,projectId,routePost,routeDisabled,recoveries=[],quotaResetsAt}:{task:ProgressTask;actions?:TaskActions;advanced:boolean;projectId:string;routePost?:CapabilityRoutePost;routeDisabled?:boolean;
  recoveries?:ClaudeRunRecovery[];quotaResetsAt?:string|null}){
  const own=recoveries.filter(item=>item.taskId===task.id);
  return <details className="progress-task">
    <summary>
      <span className="progress-task-title">{task.title}</span>
      <span className={'progress-stage tone-'+stageTone[task.stage]}>{stageLabels[task.stage]}</span>
      {advanced?<>{completionView(task)&&<span className={'progress-stage tone-'+(completionView(task)!.done?'good':'wait')}>{completionView(task)!.label}</span>}
      {task.qualityLoops?.[0]&&<span className="progress-stage">{qualityLabel(task.qualityLoops[0])}</span>}</>
        :<span className={'progress-stage tone-'+plainStatus(task).tone}>{plainStatus(task).label}</span>}
      <span className="progress-meta">담당 {runtime(task.assignee)} · 마지막 관측 {task.lastObservedAt?time(task.lastObservedAt):'없음'}</span>
    </summary>
    <dl className="progress-facts">
      <div><dt>검증</dt><dd>{verificationLabels[task.verification]}</dd></div>
      <div><dt>완료 조건</dt><dd>{task.criteria.total}개 중 {task.criteria.verified}개 확인</dd></div>
      <div><dt>기준</dt><dd>{task.planCurrent?'현재 승인본':'이전 승인본 · 재검토 대상'}</dd></div>
      <div><dt>시작</dt><dd>{time(task.startedAt)}</dd></div>
      {task.requirementLabels.length>0&&<div><dt>요구사항</dt><dd>{task.requirementLabels.join(', ')}</dd></div>}
    </dl>
    {nextActions[task.stage]&&<p className="progress-next">{nextActions[task.stage]}</p>}
    {task.stage==='quota_wait'&&<QuotaResumeNote resetsAt={quotaResetsAt}/>}
    {own.map(item=><ClaudeRecoveryControl key={item.runId} recovery={item} advanced={advanced} busy={!!actions?.busy} onRecover={actions?.onRecover}/>)}
    <CompletionStatus task={task} advanced={advanced}/>
    {task.qualityLoops?.map(loop=><QualityLoopStatus key={loop.id} loop={loop} advanced={advanced}/>)}
    <CapabilityRouting key={`${projectId}/${task.id}`} projectId={projectId} taskId={task.id} records={task.capabilityRoutes} executions={task.capabilityExecutions} canPlan={!!routePost} advanced={advanced} post={routePost} disabled={routeDisabled}/>
    {actions&&<TaskButtons task={task} actions={actions} released={own.some(item=>item.runId===task.latestRunId&&item.state==='released')}/>}
    {task.runs.length>0?<table className="progress-runs"><caption>실행 기록 {task.runsTotal}개{task.runsTotal>task.runs.length?` 중 최근 ${task.runs.length}개`:''}</caption>
      <thead><tr><th>실행</th><th>담당</th><th>실행 상태</th><th>최근 도구</th><th>검증</th><th>마지막 관측</th></tr></thead>
      <tbody>{task.runs.map(run=><tr key={run.id}><td><code>{run.id.slice(0,8)}</code></td><td>{runtime(run.assignee)}{advanced&&run.modelAttribution&&<CodexModelEvidence value={run.modelAttribution}/>}</td><td>{run.execution}</td><td>{run.lastActivity??'—'}</td><td>{verificationLabels[run.verification]}{run.checks>1?` (${run.checks}회)`:''}</td><td>{time(run.lastObservedAt)}</td></tr>)}</tbody>
    </table>:<p className="progress-empty">아직 실행 기록이 없습니다.</p>}
  </details>;
}

/** Pure view: renders only recorded state, no inferred percentages or ETA. */
export function ProjectProgressView({progress,freshness,lastEventAt,actions,compact,routePost,routeDisabled,online}:{progress:ProjectProgress;freshness:ConnectionFreshness;lastEventAt:string|null;actions?:TaskActions;routePost?:CapabilityRoutePost;routeDisabled?:boolean;
  /** When set, the read-only task graph / integration queue panel is mounted. */online?:boolean;
  /** The project screen shows its own summary; compact keeps only the task list. */compact?:boolean}){
  const {totals,criteria}=progress;
  const [mode,setMode]=useState(getUiMode);
  useEffect(()=>subscribeUiMode(()=>setMode(getUiMode())),[]);
  const verified=verifiedTaskCount(progress);
  const quotaResetsAt=progress.blockers.find(b=>b.code==='QUOTA_EXHAUSTED')?.resetsAt;
  return <div className="project-progress">
    {!compact&&<section className="surface progress-summary" aria-label="프로젝트 진행 요약">
      <div className="section-heading"><div>
        <h2>{progress.plan?.title??'승인된 기획 없음'}</h2>
        <p>{progress.plan?`${progress.plan.goal} · 승인 버전 r${progress.plan.revision} · ${progress.plan.contentHash.slice(0,12)}`:'기획을 승인하면 작업과 완료 조건이 이곳에 연결됩니다.'}</p>
      </div><span className={'badge progress-fresh fresh-'+freshness} role="status">{freshnessLabels[freshness]}{lastEventAt?` · ${time(lastEventAt)}`:''}</span></div>
      <div className="progress-counters">
        <div><strong>{verified}/{totals.tasks}</strong><span>작업 {totals.tasks}개 중 {verified}개 검증 통과 (작업 수 기준)</span>
          <progress max={Math.max(totals.tasks,1)} value={verified} aria-label="작업 수 기준 검증 통과"/></div>
        <div><strong>{criteria.verified}/{criteria.total}</strong><span>완료 조건 {criteria.total}개 중 {criteria.verified}개 확인 (실행 기준과 일치한 검사만)</span>
          <progress max={Math.max(criteria.total,1)} value={criteria.verified} aria-label="완료 조건 기준 확인"/></div>
        <div><strong>{time(progress.lastObservedAt)}</strong><span>마지막 관측 활동</span></div>
      </div>
      {progress.blockers.length>0&&<ul className="progress-blockers" role="alert">{progress.blockers.map(b=><li key={b.code}>{blockerLabels[b.code]??b.code}{b.code==='QUOTA_EXHAUSTED'&&<QuotaResumeNote resetsAt={b.resetsAt}/>}</li>)}</ul>}
      {progress.untaskedRuns>0&&<p className="progress-note">작업과 연결되지 않은 직접 실행 {progress.untaskedRuns}개는 작업 진행에 포함하지 않았습니다.</p>}
      <p className="progress-note">AI 응답 완료와 검증 통과는 다른 상태입니다. 시간·노력 비율이나 남은 시간은 추정하지 않습니다.</p>
    </section>}
    {!compact&&<ProgressImpact progress={progress} advanced={mode==='advanced'}/>}
    {!compact&&online!==undefined&&progress.plan&&<TaskGraphPanel projectId={progress.projectId} planningVersionId={progress.plan.id} online={online}/>}
    <section className="surface" aria-label="작업별 진행">
      {!compact&&<div className="section-heading"><div><h2>작업</h2><p>작업을 펼치면 실행 기록과 검증 결과를 볼 수 있습니다.</p></div></div>}
      {progress.tasks.length?progress.tasks.map(task=><TaskRow key={task.id} task={task} actions={actions} advanced={mode==='advanced'} projectId={progress.projectId} routePost={routePost} routeDisabled={routeDisabled} recoveries={progress.claudeRecovery} quotaResetsAt={quotaResetsAt}/>):<p className="progress-empty">승인된 기획에서 만든 작업이 아직 없습니다.</p>}
    </section>
  </div>;
}

export function lastEventTime(events:readonly {at:string}[]):string|null{return events.length?events[events.length-1].at:null;}

type RawPost=(path:string,body:object)=>Promise<Response>;
const pendingKey='orbit.progress.pending';
const runErrors:Record<string,string>={RUN_ACTIVE:'이 작업은 이미 실행 중입니다. 기존 실행이 끝난 뒤 다시 시도하세요.',PLANNING_VERSION_STALE:'작업의 승인 기준이 현재 승인본이 아닙니다. 기획을 확인하세요.',
  CLAUDE_NOT_INSTALLED:'Claude Code가 설치되어 있지 않습니다.',SOLO_RECOVERY_REQUIRED:'종료를 확인하지 못한 실행이 있어 새 실행이 차단되었습니다.',IDEMPOTENCY_CONFLICT:'저장된 요청과 다른 작업입니다. 새로고침 후 확인하세요.'};
const recoveryErrors:Record<string,string>={CLAUDE_RUN_STILL_OWNED:'Orbit이 아직 이 실행을 관리 중입니다. 종료가 관측될 때까지 기다리거나 중단을 요청하세요.',
  CLAUDE_RUN_NOT_LOST:'이 실행은 복구 대상이 아닙니다. 새로고침 후 상태를 확인하세요.',CLAUDE_RUN_WORKER_RECOVERY_REQUIRED:'별도 작업 공간 실행은 여기서 차단을 해제할 수 없습니다.',CLAUDE_STOP_CONFIRMATION_REQUIRED:'종료 확인이 필요합니다.',SESSION_BUSY:'Orbit이 종료 중입니다.'};
function readPending(projectId:string):{taskId:string;requestId:string}|null{
  try{const value=JSON.parse(sessionStorage.getItem(pendingKey)??'null');return value&&value.projectId===projectId&&typeof value.taskId==='string'&&typeof value.requestId==='string'?value:null;}catch{return null;}
}

/** Reads `/api/projects/:id/progress` on scope change and after new events. GET never starts work.
 * Runs start only from an explicit click; an uncertain request keeps its ID and is never resent automatically. */
export function ProjectProgressPanel({projectId,projectKind,online,lastSeq,lastEventAt,freshness,post,compact,onProgress}:{projectId:string;projectKind:'code'|'general'|null;online:boolean;lastSeq:number;lastEventAt:string|null;freshness:ConnectionFreshness;post?:RawPost;
  compact?:boolean;onProgress?:(progress:ProjectProgress)=>void}){
  const report=useRef(onProgress);report.current=onProgress;
  const [progress,setProgress]=useState<ProjectProgress|null>(null),[error,setError]=useState('');
  const [busy,setBusy]=useState(false),[pending,setPending]=useState(()=>readPending(projectId)),[handoff,setHandoff]=useState<{taskId:string;markdown:string;history:HandoffHistoryEntry[]}|null>(null);
  const ticket=useRef(0);
  useEffect(()=>{setProgress(null);setError('');setHandoff(null);setPending(readPending(projectId));},[projectId]);
  useEffect(()=>{
    if(!projectId||!online)return;
    const current=++ticket.current;
    const timer=setTimeout(async()=>{
      try{
        const response=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/progress',{cache:'no-store'});
        if(!response.ok)throw new Error();
        const value=await response.json() as ProjectProgress;
        if(current!==ticket.current)return;
        if(value?.projectId!==projectId||!Array.isArray(value.tasks))throw new Error();
        setProgress(value);setError('');report.current?.(value);
      }catch{if(current===ticket.current)setError('진행 기록을 불러오지 못했습니다. 마지막으로 받은 기록을 표시합니다.');}
    },lastSeq?400:0);
    return()=>clearTimeout(timer);
  },[projectId,online,lastSeq]);
  async function act(fn:()=>Promise<void>){if(busy||!online)return;setBusy(true);setError('');try{await fn();}finally{setBusy(false);}}
  const run=(task:ProgressTask)=>act(async()=>{
    if(!post)return;
    const current=readPending(projectId);if(current&&current.taskId!==task.id)return;
    const record=current??{taskId:task.id,requestId:crypto.randomUUID()};
    try{sessionStorage.setItem(pendingKey,JSON.stringify({projectId,...record}));}catch{setError('브라우저가 요청 기록을 보존하지 못해 실행 요청을 보내지 않았습니다.');return;}
    setPending(record);
    let response:Response;
    try{response=await post(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/run`,{requestId:record.requestId});}
    catch{setError('실행 요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요. 새 실행은 자동으로 보내지 않습니다.');return;}
    const data=await response.json().catch(()=>null) as {error?:string}|null;
    // A definite server answer (accepted or rejected before any run was recorded) releases the pinned request.
    if(response.ok||(response.status>=400&&response.status<500)||data?.error==='CLAUDE_NOT_INSTALLED'){try{sessionStorage.removeItem(pendingKey);}catch{}setPending(null);}
    if(!response.ok)setError(runErrors[data?.error??'']??'실행을 시작하지 못했습니다. 기록을 확인하세요.');
  });
  const interrupt=(task:ProgressTask)=>act(async()=>{
    if(!post||!task.latestRunId)return;
    try{const response=await post(`/api/runs/${encodeURIComponent(task.latestRunId)}/interrupt`,{});if(!response.ok)setError('중단 요청을 보내지 못했습니다.');}
    catch{setError('중단 요청 결과를 확인하지 못했습니다. 진행판의 다음 관측을 확인하세요.');}
  });
  const recoveryIds=useRef(new Map<string,string>());
  const recover=(runId:string)=>act(async()=>{
    if(!post)return;
    // An uncertain answer keeps the same requestId so a manual retry cannot record a second recovery.
    const requestId=recoveryIds.current.get(runId)??crypto.randomUUID();recoveryIds.current.set(runId,requestId);
    let response:Response;
    try{response=await post(`/api/projects/${encodeURIComponent(projectId)}/claude-runs/${encodeURIComponent(runId)}/recover`,{requestId,confirmedStopped:true});}
    catch{setError('차단 해제 결과를 확인하지 못했습니다. 진행판을 확인한 뒤 다시 시도하세요.');return;}
    const data=await response.json().catch(()=>null) as {error?:string}|null;
    if(response.status<500)recoveryIds.current.delete(runId);
    if(!response.ok)setError(recoveryErrors[data?.error??'']??'차단을 해제하지 못했습니다. 기록을 확인하세요.');
  });
  const showHandoff=(task:ProgressTask)=>act(async()=>{
    if(handoff?.taskId===task.id){setHandoff(null);return;}
    try{
      const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/handoff`,{cache:'no-store'});
      if(!response.ok)throw new Error();const value=await response.json() as HandoffPackage;
      if(value.taskId!==task.id||typeof value.markdown!=='string')throw new Error();
      const log=await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/handoff-history`,{cache:'no-store'});
      const entries=log.ok?(await log.json() as {entries?:unknown}).entries:[],history=Array.isArray(entries)?entries as HandoffHistoryEntry[]:[];
      setHandoff({taskId:task.id,markdown:value.markdown,history});
    }catch{setError('인계 자료를 불러오지 못했습니다.');}
  });
  const actions:TaskActions|undefined=projectKind==='general'&&post?{runtimeLabel:'Claude Code',canRun:true,busy:busy||!online,pendingTaskId:pending?.taskId??null,handoff,onRun:run,onInterrupt:interrupt,onHandoff:showHandoff,onRecover:recover}
    :projectKind==='code'?{runtimeLabel:'Codex',canRun:false,busy:busy||!online,pendingTaskId:null,handoff,onRun:()=>{},onInterrupt:()=>{},onHandoff:showHandoff}:undefined;
  if(!projectId)return <section className="surface"><p>프로젝트를 선택하면 진행 상태를 볼 수 있습니다.</p></section>;
  return <>
    {error&&<div className="banner error" role="alert">{error}</div>}
    {projectKind==='code'&&!compact&&<p className="progress-note">코드 프로젝트 작업은 시작하기·에이전트 센터에서 검증 기준을 확인한 뒤 실행합니다.</p>}
    {progress?<ProjectProgressView progress={progress} freshness={freshness} lastEventAt={lastEventAt} actions={actions} compact={compact} routePost={post} routeDisabled={!online} online={online}/>:!error&&<section className="surface"><p>진행 기록을 불러오는 중입니다.</p></section>}
  </>;
}

export function qualityLabel(loop:QualityLoopRecord){const state=loop.result.status,issue=loop.result.issue??'';return loop.recoveryRequired?'실행 확인 필요':/QUOTA|RATE_LIMIT/.test(issue)?'사용량 한도 대기':/PERMISSION|APPROVAL_DENIED/.test(issue)?'권한 확인 필요':/MODEL.*UNKNOWN|MODEL.*UNSUPPORTED|MODEL_MISMATCH/.test(issue)?'모델 확인 필요':state==='reviewing'?(loop.result.repairs?'재검증 중':'품질 검증 중'):state==='repairing'?'수정 중':state==='passed'?({native:'AI 검토 일치',mock:'모의 AI 검토 일치 · 실제 검증 아님',unknown:'AI 검토 일치 · 모델 미확인'} as const)[qualityOrigin(loop)]:state==='limit_reached'?'품질 검증 한도 도달':state==='failed'?'품질 검증 실패':loop.result.issue==='INDEPENDENT_MODEL_REQUIRED'?'독립 검토 모델 필요':state==='blocked'?'품질 검증 차단':'품질 검증 대기';}
/** Server completion verdict: simple mode one line, advanced mode per-gate table. Renders nothing for older servers. */
export function CompletionStatus({task,advanced}:{task:ProgressTask;advanced:boolean}){
  const v=completionView(task),c=task.completion;
  if(!v||!c)return null;
  return <section aria-label="서버 완료 판정" className="progress-quality">
    <p role="status"><strong>{v.label}</strong> · {v.gates} · {v.review} · {v.approval} · {v.release}</p>
    {advanced&&<table className="progress-runs"><caption>완료 gate · 사유 {c.reasonCodes.join(', ')||'없음'}</caption>
      <thead><tr><th>gate</th><th>상태</th><th>근거 출처</th><th>최신성</th><th>근거 ID</th></tr></thead>
      <tbody>{c.gates.map(g=><tr key={g.id}><td>{g.id}</td><td>{g.status}</td><td>{g.source}</td><td>{g.freshness}</td><td>{g.evidenceIds.map(id=>id.slice(0,8)).join(', ')||'없음'}</td></tr>)}</tbody>
    </table>}
  </section>;
}
export function QualityLoopStatus({loop,advanced}:{loop:QualityLoopRecord;advanced:boolean}){
  const label=qualityLabel(loop);
  const issues=loop.result.rounds.at(-1)?.failures??[];
  const repair=loop.steps.filter(step=>step.kind==='repair').at(-1)?.evidence;
  const identity=(e:QualityLoopRecord['producer'])=>`${e.providerId} / ${e.modelId??'unknown'}`;
  return <section aria-label="품질 검증" className="progress-quality">
    <p role="status"><strong>{label}</strong> · {loop.result.rounds.length}회차 · 문제 {issues.length}개</p>
    <p>실행자 {identity(loop.producer)} · 검증자 {loop.reviewers.map(r=>`${r.providerId} / ${r.modelId} (선택)`).join(', ')}{repair?` · 수정자 ${identity(repair)}`:''}</p>
    {loop.result.issue&&<p role="alert">{loop.result.issue}</p>}
    <p>필수 검사: {loop.verification.status==='passed'?'통과':loop.verification.status==='failed'?'실패':'미확인'} · 사용자 승인과 별개입니다.</p>
    {advanced&&<details><summary>품질 검증 상세 증거</summary>
      <p>기준 {loop.version.id} · {loop.baseline.digest}</p>
      <p>실행 세션 {loop.producer.sessionId??'unknown'} · Orbit 실행 ID {loop.producer.runId??'unknown'} · 네이티브 실행 ID {loop.producer.executionId??'unknown'}</p>
      {loop.producer.codex&&<CodexModelEvidence value={loop.producer.codex}/>}
      <ul>{issues.map((f,i)=><li key={i}>{f.criterion??'발견 문제'}: {f.evidence}</li>)}</ul>
      {loop.steps.map(step=><div key={step.id}><strong>{step.kind==='repair'?'수정자':step.kind==='review'?'검증자':'필수 검사'} · {step.state}</strong>
        {step.evidence&&<p>{identity(step.evidence)} · 세션 {step.evidence.sessionId??'unknown'} · Orbit 실행 {step.evidence.runId??'unknown'} · 네이티브 실행 {step.evidence.executionId??'unknown'} · 근거 {step.evidence.source}</p>}
        {step.evidence?.codex&&<CodexModelEvidence value={step.evidence.codex}/>}
        {step.issue&&<p>{step.issue}</p>}
      </div>)}
      <pre>{JSON.stringify({rounds:loop.result.rounds,verification:loop.verification},null,2)}</pre>
    </details>}
  </section>;
}

/** Official server configuration is deliberately labelled separately from execution proof. */
export function CodexModelEvidence({value}:{value:CodexModelAttribution}){
  return <details><summary>Codex 모델 식별 근거</summary>
    <p>사용자 선택: {value.selectedModelId??'미지정'} · 요청 모델: {value.requestedModelId??'미지정'}</p>
    <p>서버 설정 모델: {value.serverModelId??'unknown'} · 공급자: {value.serverProviderId??'unknown'} · 근거: {value.serverSource??'없음'}</p>
    <p>실제 실행 모델: unknown · 독립 모델 검증 근거 없음</p>
    <p>스레드: {value.threadId??'unknown'} · 네이티브 세션: {value.nativeSessionId??'unknown'} · 턴: {value.turnId??'unknown'}</p>
    <p>관측 상태: {value.status}{value.resumed?' · 재개된 세션':''}{value.modelChanged?' · 모델 변경 관측':''}{value.observationIncomplete?' · 관측 불완전':''}</p>
    <pre>{JSON.stringify(value.observations,null,2)}</pre>
  </details>;
}
