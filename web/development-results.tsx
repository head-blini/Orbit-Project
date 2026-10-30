import {useEffect,useState} from 'react';
import type {Run,Snapshot} from '../shared/types.ts';
import type {DevelopmentResultView,DevelopmentSelection} from '../shared/development-results.ts';
import {executionLabels} from './navigation.ts';
import {AppPreviewPanel} from './app-preview.tsx';
import {ReuseVendorPanel} from './reuse-vendor.tsx';

export function selectedDevelopmentRun(state:Snapshot|null,selection:DevelopmentSelection|null){
  const runs=state?.runs.filter(run=>run.workspaceId===state.selectedWorkspaceId)??[];
  return selection?.workspaceId===state?.selectedWorkspaceId?runs.find(run=>run.id===selection?.runId)??null:runs.at(-1)??null;
}
export function DevelopmentResultSummary({view}:{view:DevelopmentResultView}){
  const v=view.verification;
  const checkStatus=!view.run?'실행을 선택하면 검증 기록을 확인할 수 있습니다.':!v?'이 실행의 검증 근거 확인 전':!v.available||!view.sourceDigest?'현재 검증 상태 확인 불가':v.quarantined?'검증 복구 확인 필요':!v.commands.length?'검증 명령 미설정':v.canApprove?'현재 등록 명령 모두 통과':!v.checks.length?'검증 기록 없음':'검증 내역 확인 필요';
  return <div className="development-result-summary">
    <dl className="policy-list"><div><dt>기획 작업</dt><dd>{view.task?.title??(view.linkIssue?'기획 연결 확인 불가':'기획 Task 연결 없음')}{view.planning&&<p>{view.planning.title} · 버전 {view.planning.revision} · {view.planning.current?'현재 기획':'이전 기획'} · {view.task?.requirementLabels.join(', ')}</p>}</dd></div>
      <div><dt>AI 실행</dt><dd>{view.run?executionLabels[view.run.execution]:'선택한 실행 없음'}{view.run&&<p>{view.run.id} · {new Date(view.run.createdAt).toLocaleString('ko-KR')}</p>}</dd></div>
      <div><dt>명령 검증</dt><dd>{checkStatus}{v?.approvalCurrent&&<p>조회 당시 사용자 승인과 일치합니다.</p>}</dd></div></dl>
    {view.sourceIssue&&<p role="status">현재 소스를 확인하지 못했습니다. 과거 검증을 현재 결과로 사용하지 않습니다.</p>}
    <p className="subtle">조회 {new Date(view.observedAt).toLocaleString('ko-KR')} · 현재 소스 {view.sourceDigest?.slice(0,12)??'확인 불가'}. 명령 통과는 요구사항 전체의 수용 판정이 아닙니다. 미리보기는 현재 작업 공간의 사본이며 이 실행이 모든 파일을 만들었다는 뜻은 아닙니다.</p>
    {!!v?.checks.length&&<details><summary>선택 실행의 최근 검증 기록 · 최대 100개</summary><ul className="record-list">{v.checks.map(check=><li key={check.id}><div><b>{check.commandId}</b><p>{check.execution==='running'?'진행 중':check.execution==='lost'?'종료 미확인':check.verdict==='passed'?'당시 통과':check.verdict==='failed'?'당시 실패':check.verdict} · exit {check.exitCode??'미확인'} · {new Date(check.createdAt).toLocaleString('ko-KR')}</p><small>{check.sourceDigest===view.sourceDigest&&check.finishedDigest===view.sourceDigest?'조회한 소스와 일치':'현재 소스와 일치하지 않거나 종료 소스 미확인'} · {v.commands.some(command=>command.id===check.commandId&&command.configDigest===check.configDigest)?'등록 설정 일치':'이전 검사 설정'}</small></div></li>)}</ul></details>}
  </div>;
}
export function DevelopmentResultPanel({projectId,workspaceId,runs,selectedRun,onSelectRun,online,locked,refreshKey,post}:{projectId:string;workspaceId:string;runs:Run[];selectedRun:Run|null;onSelectRun:(runId:string)=>void;online:boolean;locked:boolean;refreshKey:string;post:(path:string,body:object)=>Promise<unknown>}){
  const [result,setResult]=useState<{key:string;view:DevelopmentResultView}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const runId=selectedRun?.id??null,key=JSON.stringify([projectId,workspaceId,runId,online,locked,refreshKey,retry]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;setError('');
    async function load(){
      if(!online)return;
      try{const response=await fetch('/api/workspaces/'+workspaceId+'/result'+(runId?'?runId='+encodeURIComponent(runId):''));if(!response.ok)throw new Error();const view=await response.json() as DevelopmentResultView;
        if(view.projectId!==projectId||view.workspaceId!==workspaceId||(view.run?.id??null)!==runId)throw new Error();
        if(!disposed){setResult({key,view});setError('');}
      }catch{if(!disposed){setResult(null);setError('실행 결과를 불러오지 못했습니다. 현재 작업 공간과 서버 연결을 확인하세요.');}}
      finally{if(!disposed)timer=setTimeout(()=>void load(),15000);}
    }
    void load();return()=>{disposed=true;if(timer)clearTimeout(timer);};
  },[key]);
  const view=result?.key===key?result.view:null;
  return <><section className="surface" aria-label="작업과 실행 결과">
    <div className="section-heading"><h2>작업과 실행 결과</h2><button disabled={!online} onClick={()=>setRetry(value=>value+1)}>결과 상태 새로고침</button></div>
    <label>확인할 실행<select aria-label="확인할 실행" value={runId??''} onChange={event=>onSelectRun(event.target.value)}><option value="">실행 선택 없음 · 현재 파일만 보기</option>{runs.filter(run=>run.workspaceId===workspaceId).map(run=><option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString('ko-KR')} · {executionLabels[run.execution]} · {run.id.slice(0,8)}</option>)}</select></label>
    {error&&<p role="alert">{error}</p>}{view?<DevelopmentResultSummary view={view}/>:<p role="status">{online?'선택 실행의 근거를 확인하고 있습니다.':'서버 연결 후 실행 결과를 확인할 수 있습니다.'}</p>}
    <p className="subtle">아래 리뷰·명령 검증·변경 반영은 선택한 종료 실행에 연결됩니다. 과거 실행을 선택해도 파일은 과거 버전으로 되돌아가지 않습니다.</p>
  </section><ReuseVendorPanel workspaceId={workspaceId} online={online} locked={locked} refreshKey={refreshKey} post={post}/><AppPreviewPanel workspaceId={workspaceId} online={online} locked={locked} refreshKey={refreshKey} post={post} evidence={locked?null:view}/></>;
}
