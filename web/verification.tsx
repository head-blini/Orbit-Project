import { useEffect,useRef,useState } from 'react';
import type { VerificationView,VerificationCommandPreview } from '../shared/verification.ts';
import {TaskAcceptanceDetails} from './task-verification-preview.tsx';
const verdicts={not_run:'미검증',passed:'통과',failed:'실패',interrupted:'중단',timed_out:'시간 초과',stale:'소스 변경·무효'};
type Props={workspaceId:string;runId:string|null;online:boolean;agentActive:boolean;post:(path:string,body:object)=>Promise<unknown>};
export function VerificationPanel({workspaceId,runId,online,agentActive,post}:Props){
  const [view,setView]=useState<VerificationView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const pendingKey='orbit.verification.pending.'+workspaceId;
  const [pending,setPending]=useState<string|null>(()=>{try{return sessionStorage.getItem(pendingKey);}catch{return null;}});
  const alive=useRef(true),sending=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const load=async()=>{
      if(!online)return;
      try{
        const response=await fetch('/api/workspaces/'+workspaceId+'/verification'+(runId?'?runId='+runId:''));
        if(!response.ok)throw new Error();
        const result=await response.json() as VerificationView;
        if(disposed)return;setView(result);setError('');
        let requestId:string|null=null;try{requestId=sessionStorage.getItem(pendingKey);}catch{}
        if(requestId&&(result.checks.some(check=>check.requestId===requestId)||result.approval?.requestId===requestId)){try{sessionStorage.removeItem(pendingKey);}catch{}setPending(null);}
        timer=setTimeout(load,result.checks.some(check=>check.execution==='running')?1500:15000);
      }catch{if(!disposed)setError('검증 상태를 불러오지 못했습니다. 작업 공간과 연결을 확인하세요.');}
    };
    setView(null);void load();return()=>{disposed=true;if(timer)clearTimeout(timer);};
  },[workspaceId,runId,online,refresh,pendingKey]);
  async function action(path:string,body:object,recorded=false){
    if(sending.current||!online||(recorded&&(pending||acceptanceBlocked)))return;
    sending.current=true;setBusy(true);setError('');
    const requestId=crypto.randomUUID();
    try{
      if(recorded){sessionStorage.setItem(pendingKey,requestId);setPending(requestId);}
      await post(path,recorded?{...body,requestId}:body);
      if(recorded){sessionStorage.removeItem(pendingKey);if(alive.current)setPending(null);}
      if(alive.current)setRefresh(value=>value+1);
    }catch{if(alive.current){setError('요청 결과를 확인하지 못했습니다. 상태를 다시 불러와 확인하세요.');setRefresh(value=>value+1);}}
    finally{sending.current=false;if(alive.current)setBusy(false);}
  }
  const running=view?.checks.some(check=>check.execution==='running')??false;
  const acceptanceBlocked=view?.acceptance?.state==='changed'||view?.acceptance?.state==='unavailable';
  function start(command:VerificationCommandPreview){
    if(!view?.sourceDigest||!runId||acceptanceBlocked)return;
    void action('/api/workspaces/'+workspaceId+'/checks',{runId,commandId:command.id,expectedSourceDigest:view.sourceDigest,expectedConfigDigest:command.configDigest},true);
  }
  return <section className="surface verification-panel">
    <div className="section-heading"><h2>실제 명령 검증 및 승인</h2><button disabled={!online||busy} onClick={()=>setRefresh(value=>value+1)}>검증 상태 새로고침</button></div>
    <p className="notice">명령은 <b>Codex sandbox 밖의 로컬 OS 사용자 권한</b>으로 저장소 코드를 실행합니다. 아래 명령·인자·대상을 확인한 뒤 실행을 승인하세요. 자동 병합하지 않습니다.</p>
    {error&&<p role="alert">{error}</p>}
    {!view?<p role="status">{online?'검증 상태 확인 중…':'서버 연결이 필요합니다.'}</p>:<>
      <p className="subtle">{view.scope}</p>
      <section aria-label="고정 검증 기준"><h3>Task 실행 시 고정한 기준</h3>
        {!view.acceptance||view.acceptance.state==='unbound'?<p>이 실행에는 고정 기준이 없습니다. 기존 검증 통과는 인수 조건 충족이나 원래 테스트 보호의 증명이 아닙니다.</p>:<>
          <p role={acceptanceBlocked?'alert':'status'}>{view.acceptance.state==='current'?'고정한 인수 조건·명령 설정·보호 파일이 현재 상태와 일치합니다.':view.acceptance.state==='changed'?'고정한 기준이 변경되어 명령 실행과 결과 승인을 차단했습니다.':'고정한 기준을 확인할 수 없어 명령 실행과 결과 승인을 차단했습니다.'}</p>
          <p>새 기준은 새 Task 실행에서만 고정할 수 있습니다. 이 실행의 기준을 덮어쓰지 않습니다.</p>
          {view.acceptance.baseline&&<details><summary>고정 기준과 보호 파일 보기</summary><TaskAcceptanceDetails preview={view.acceptance.baseline}/></details>}
        </>}
      </section>
      {!view.commands.length?<p>서버에 등록된 검증 명령이 없습니다. ORBIT_VERIFICATION_COMMANDS 설정이 필요합니다. 기획과 기존 AI 실행은 계속 사용할 수 있습니다.</p>:<>
        <p>연결 실행: {runId?.slice(0,8)??'완료된 AI 실행 없음'} · 현재 소스: <code>{view.sourceDigest?.slice(0,16)??'확인 불가'}</code></p>
        {view.sourceIssue&&<p role="alert">파일 범위·민감 경로·읽기 제한으로 소스 증거를 만들 수 없어 검증을 차단했습니다.</p>}
        {view.quarantined&&<p role="alert">이전 검증이 비정상 종료되어 프로세스 상태를 확인할 수 없습니다. 해당 로컬 명령이 종료됐는지 확인하기 전 새 실행은 차단됩니다.</p>}
        <ul className="record-list">{view.commands.map(command=><li key={command.id}><div><b>{command.label}</b><pre>{JSON.stringify([command.executable,...command.args])}</pre><p>제한 {command.timeoutMs/1000}초 · 설정 <code>{command.configDigest.slice(0,16)}</code></p></div><button onClick={()=>start(command)} disabled={!online||busy||!!pending||running||agentActive||view.quarantined||acceptanceBlocked||!runId||!view.sourceDigest}>명령 승인 후 실행</button></li>)}</ul>
      </>}
      <ul className="record-list">{view.checks.map(check=><li key={check.id}><div><b>{check.commandId} · {check.execution==='running'?'검증 실행 중':check.execution==='lost'?'재시작·결과 미확인':verdicts[check.verdict]}</b><p>exit {check.exitCode??'unknown'} · {check.durationMs===null?'시간 미확인':(check.durationMs/1000).toFixed(2)+'초'} · {new Date(check.createdAt).toLocaleString('ko-KR')}</p>
        {check.sourceDigest!==view.sourceDigest&&<p>현재 소스와 다른 과거 증거입니다.</p>}
        <p>검사에 연결된 고정 기준: {check.acceptanceDigest?<code>{check.acceptanceDigest.slice(0,16)}</code>:'없음 · 기존 검증 기록'}</p>
        <details><summary>정제된 검증 출력</summary><pre>{check.output||'출력 없음'}</pre></details>
        {check.execution==='lost'&&!check.recoveredAt&&<button disabled={busy||!online} onClick={()=>void action('/api/workspaces/'+workspaceId+'/checks/'+check.id+'/acknowledge-stopped',{confirmedStopped:true})}>이전 검증 프로세스가 종료됐음을 확인했습니다</button>}
      </div>{check.execution==='running'&&<button disabled={busy||!online} onClick={()=>void action('/api/workspaces/'+workspaceId+'/checks/'+check.id+'/interrupt',{})}>검증 중단</button>}</li>)}</ul>
      <p>{view.approvalCurrent?'조회 당시 소스와 검증 결과를 사용자가 승인했습니다.':view.approval?'이전 승인은 현재 소스·검증과 일치하지 않습니다.':'현재 변경에 대한 사용자 승인 없음'}</p>
      <button disabled={!online||busy||agentActive||!!pending||acceptanceBlocked||!view.canApprove||view.approvalCurrent} onClick={()=>void action('/api/workspaces/'+workspaceId+'/review-approval',{runId,expectedSourceDigest:view.sourceDigest,expectedCheckSetDigest:view.checkSetDigest},true)}>Diff와 검증 결과 확인 후 승인</button>
    </>}
    {pending&&<p role="status">이전 요청 결과를 확인 중입니다. <button disabled={busy} onClick={()=>{try{sessionStorage.removeItem(pendingKey);setPending(null);}catch{}}}>실행 기록 확인 후 요청 잠금 해제</button></p>}
  </section>;
}
