import {useEffect,useRef,useState} from 'react';
import type {ConnectionFreshness,ProgressTask,ProjectProgress,TaskStage,ProgressVerification} from '../shared/project-progress.ts';

export const stageLabels:Record<TaskStage,string>={
  not_started:'대기',quota_wait:'한도 대기',running:'실행 중',interrupt_requested:'중단 요청됨 · 종료 미확인',verifying:'검증 중',
  response_unverified:'AI 응답 완료 · 검증 전',verification_failed:'검증 실패',revalidation_required:'재검증 필요',verified:'검증 통과',
  interrupted:'중단 확인',error:'오류',lost:'연결 유실 · 결과 미확인',
};
const stageTone:Record<TaskStage,string>={not_started:'idle',quota_wait:'wait',running:'active',interrupt_requested:'wait',verifying:'active',response_unverified:'wait',
  verification_failed:'bad',revalidation_required:'wait',verified:'good',interrupted:'idle',error:'bad',lost:'bad'};
const verificationLabels:Record<ProgressVerification,string>={not_run:'검증 기록 없음',running:'검사 실행 중',passed:'검사 통과',failed:'검사 실패',stale:'기준 변경 · 재검증 필요',lost:'검사 결과 미확인'};
const nextActions:Partial<Record<TaskStage,string>>={
  not_started:'작업을 실행할 AI와 작업 공간을 선택하세요.',quota_wait:'관측된 사용량 한도가 소진되었습니다. 초기화 후 다시 실행하거나 다른 AI로 인계하세요. 자동 재시도하지 않습니다.',
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

function TaskRow({task}:{task:ProgressTask}){
  return <details className="progress-task">
    <summary>
      <span className="progress-task-title">{task.title}</span>
      <span className={'progress-stage tone-'+stageTone[task.stage]}>{stageLabels[task.stage]}</span>
      <span className="progress-meta">담당 {runtime(task.assignee)} · 마지막 관측 {time(task.lastObservedAt)}</span>
    </summary>
    <dl className="progress-facts">
      <div><dt>검증</dt><dd>{verificationLabels[task.verification]}</dd></div>
      <div><dt>완료 조건</dt><dd>{task.criteria.total}개 중 {task.criteria.verified}개 확인</dd></div>
      <div><dt>기준</dt><dd>{task.planCurrent?'현재 승인본':'이전 승인본 · 재검토 대상'}</dd></div>
      <div><dt>시작</dt><dd>{time(task.startedAt)}</dd></div>
      {task.requirementLabels.length>0&&<div><dt>요구사항</dt><dd>{task.requirementLabels.join(', ')}</dd></div>}
    </dl>
    {nextActions[task.stage]&&<p className="progress-next">{nextActions[task.stage]}</p>}
    {task.runs.length>0?<table className="progress-runs"><caption>실행 기록 {task.runsTotal}개{task.runsTotal>task.runs.length?` 중 최근 ${task.runs.length}개`:''}</caption>
      <thead><tr><th>실행</th><th>담당</th><th>실행 상태</th><th>검증</th><th>마지막 관측</th></tr></thead>
      <tbody>{task.runs.map(run=><tr key={run.id}><td><code>{run.id.slice(0,8)}</code></td><td>{runtime(run.assignee)}</td><td>{run.execution}</td><td>{verificationLabels[run.verification]}{run.checks>1?` (${run.checks}회)`:''}</td><td>{time(run.lastObservedAt)}</td></tr>)}</tbody>
    </table>:<p className="progress-empty">아직 실행 기록이 없습니다.</p>}
  </details>;
}

/** Pure view: renders only recorded state, no inferred percentages or ETA. */
export function ProjectProgressView({progress,freshness,lastEventAt}:{progress:ProjectProgress;freshness:ConnectionFreshness;lastEventAt:string|null}){
  const {totals,criteria}=progress;
  return <div className="project-progress">
    <section className="surface progress-summary" aria-label="프로젝트 진행 요약">
      <div className="section-heading"><div>
        <h2>{progress.plan?.title??'승인된 기획 없음'}</h2>
        <p>{progress.plan?`${progress.plan.goal} · 승인 버전 r${progress.plan.revision} · ${progress.plan.contentHash.slice(0,12)}`:'기획을 승인하면 작업과 완료 조건이 이곳에 연결됩니다.'}</p>
      </div><span className={'badge progress-fresh fresh-'+freshness} role="status">{freshnessLabels[freshness]}{lastEventAt?` · ${time(lastEventAt)}`:''}</span></div>
      <div className="progress-counters">
        <div><strong>{totals.verifiedTasks}/{totals.tasks}</strong><span>작업 {totals.tasks}개 중 {totals.verifiedTasks}개 검증 통과 (작업 수 기준)</span>
          <progress max={Math.max(totals.tasks,1)} value={totals.verifiedTasks} aria-label="작업 수 기준 검증 통과"/></div>
        <div><strong>{criteria.verified}/{criteria.total}</strong><span>완료 조건 {criteria.total}개 중 {criteria.verified}개 확인 (실행 기준과 일치한 검사만)</span>
          <progress max={Math.max(criteria.total,1)} value={criteria.verified} aria-label="완료 조건 기준 확인"/></div>
        <div><strong>{time(progress.lastObservedAt)}</strong><span>마지막 관측 활동</span></div>
      </div>
      {progress.blockers.length>0&&<ul className="progress-blockers" role="alert">{progress.blockers.map(b=><li key={b.code}>{blockerLabels[b.code]??b.code}</li>)}</ul>}
      {progress.untaskedRuns>0&&<p className="progress-note">작업과 연결되지 않은 직접 실행 {progress.untaskedRuns}개는 작업 진행에 포함하지 않았습니다.</p>}
      <p className="progress-note">AI 응답 완료와 검증 통과는 다른 상태입니다. 시간·노력 비율이나 남은 시간은 추정하지 않습니다.</p>
    </section>
    <section className="surface" aria-label="작업별 진행">
      <div className="section-heading"><div><h2>작업</h2><p>작업을 펼치면 실행 기록과 검증 결과를 볼 수 있습니다.</p></div></div>
      {progress.tasks.length?progress.tasks.map(task=><TaskRow key={task.id} task={task}/>):<p className="progress-empty">승인된 기획에서 만든 작업이 아직 없습니다.</p>}
    </section>
  </div>;
}

export function lastEventTime(events:readonly {at:string}[]):string|null{return events.length?events[events.length-1].at:null;}

/** Reads `/api/projects/:id/progress` on scope change and after new events. GET never starts work. */
export function ProjectProgressPanel({projectId,online,lastSeq,lastEventAt,freshness}:{projectId:string;online:boolean;lastSeq:number;lastEventAt:string|null;freshness:ConnectionFreshness}){
  const [progress,setProgress]=useState<ProjectProgress|null>(null),[error,setError]=useState('');
  const ticket=useRef(0);
  useEffect(()=>{setProgress(null);setError('');},[projectId]);
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
        setProgress(value);setError('');
      }catch{if(current===ticket.current)setError('진행 기록을 불러오지 못했습니다. 마지막으로 받은 기록을 표시합니다.');}
    },lastSeq?400:0);
    return()=>clearTimeout(timer);
  },[projectId,online,lastSeq]);
  if(!projectId)return <section className="surface"><p>프로젝트를 선택하면 진행 상태를 볼 수 있습니다.</p></section>;
  return <>
    {error&&<div className="banner error" role="alert">{error}</div>}
    {progress?<ProjectProgressView progress={progress} freshness={freshness} lastEventAt={lastEventAt}/>:!error&&<section className="surface"><p>진행 기록을 불러오는 중입니다.</p></section>}
  </>;
}
