import {CapabilityInvocation} from './capability-invocation.tsx';
import {CapabilityExecution} from './capability-execution.tsx';
import type {CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import {useEffect,useRef,useState} from 'react';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';

export type CapabilityRoutePost=(path:string,body:object)=>Promise<Response>;
/** Server copies win duplicate IDs; timestamp then ID gives a stable newest-first view. */
export function mergeCapabilityRoutes(records:CapabilityRouteDecision[],local:CapabilityRouteDecision|null,projectId:string,taskId:string):CapabilityRouteDecision[]{
  const scoped=[...(local?[local]:[]),...records].filter(record=>record.projectId===projectId&&record.taskId===taskId);
  return [...new Map(scoped.map(record=>[record.id,record])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
}
const labels={recommended:'실행 방식 추천',blocked:'추천 차단',needs_clarification:'요청 확인 필요'};
export function CapabilityRouteRecord({decision,advanced}:{decision:CapabilityRouteDecision;advanced:boolean}){
  return <section aria-label="실행 방식 추천 기록">
    <p role="status"><strong>{labels[decision.status]}</strong>{decision.runtimeId?` · ${decision.runtimeId}`:''}{decision.capabilityId?` · ${decision.capabilityId}`:''}</p>
    <p>추천 기록이며 실행 승인이 아닙니다.</p>
    {advanced&&<details><summary>추천 근거</summary>
      <p>실제 실행 모델: unknown · 모델 호출 없음</p>
      <ul>{decision.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>
      <p>승인 기준: {decision.baseline.planningVersionId} · {decision.baseline.planningContentHash}</p>
      <p>설정 버전: {decision.preferencesRevision} · 등록 정보: {decision.registryDigest} · <a href={`/api/capability-orchestration/evidence/${encodeURIComponent(decision.registryDigest)}`} target="_blank" rel="noreferrer">당시 등록 정보 보기</a></p>
      <p>요청 근거: {decision.textDigest} · 기록 시각: {decision.createdAt}</p>
    </details>}
  </section>;
}

/** Local recommendation only: no run/model dispatch and no client model override. */
export function CapabilityRouting({projectId,taskId,records=[],advanced,post,disabled=false,executions=[],canPlan=false}:{projectId:string;taskId:string;records?:CapabilityRouteDecision[];advanced:boolean;post?:CapabilityRoutePost;disabled?:boolean;executions?:CapabilityExecutionRecord[];canPlan?:boolean}){
  const scope=`${projectId}/${taskId}`,scopeRef=useRef(scope),ticket=useRef(0),pending=useRef(false);
  scopeRef.current=scope;
  const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [runId,setRunId]=useState('');
  const [local,setLocal]=useState<CapabilityRouteDecision|null>(null);
  useEffect(()=>{ticket.current++;pending.current=false;setText('');setRunId('');setLocal(null);setError('');setBusy(false);return()=>{ticket.current++;};},[scope]);
  async function recommend(){
    if(!post||disabled||pending.current||!text.trim())return;
    const current=++ticket.current,requestId=crypto.randomUUID();pending.current=true;setBusy(true);setError('');
    const active=()=>ticket.current===current&&scopeRef.current===scope;
    try{
      const response=await post(`/api/projects/${encodeURIComponent(projectId)}/capability-routes`,{requestId,taskId,text,...(runId?{runId}:{})});
      const value=await response.json();if(!active())return;
      if(!response.ok)throw new Error();
      if(value?.projectId!==projectId||value?.taskId!==taskId||value?.requestId!==requestId||value?.executionAuthorized!==false||value?.actualModel!=='unknown'||!Object.hasOwn(labels,value?.status)||!Array.isArray(value?.reasons)||!value?.baseline)throw new Error();
      setLocal(value);
    }catch{if(active())setError('추천 결과를 확인하지 못했습니다. 실행은 요청하지 않았습니다.');}
    finally{if(active()){pending.current=false;setBusy(false);}}
  }
  const runs=[...new Map(executions.filter(r=>r.projectId===projectId&&r.taskId===taskId&&r.runId).map(r=>[r.runId,r])).values()];
  const visible=mergeCapabilityRoutes(records,local,projectId,taskId);
  return <section aria-label="작업 실행 방식 추천">
    {post&&<div>
      <label>원하는 작업을 설명하세요<textarea aria-label="추천할 작업 설명" maxLength={4000} value={text} disabled={disabled||busy} onChange={event=>setText(event.target.value)}/></label>
      <label>기존 실행 대상<select aria-label="기존 실행 대상" value={runId} disabled={disabled||busy} onChange={event=>setRunId(event.target.value)}><option value="">대상을 직접 선택하세요</option>{runs.map(run=><option key={run.runId} value={run.runId!}>{run.runtimeId} · {run.runId} · {run.status}</option>)}</select></label>
      <button disabled={disabled||busy||!text.trim()} onClick={()=>void recommend()}>{busy?'추천 확인 중':'실행 방식 추천'}</button>
      <p>선택된 설정과 승인 기준으로 추천만 기록합니다. 모델을 호출하거나 실행하지 않습니다.</p>
      {error&&<p role="alert">{error}</p>}
    </div>}
    {visible.slice(0,advanced?20:1).map(decision=><div key={decision.id}><CapabilityRouteRecord decision={decision} advanced={advanced}/>{['status','result','interrupt'].includes(decision.intent)?<CapabilityInvocation decision={decision} post={post} disabled={disabled}/>:<CapabilityExecution decision={decision} records={executions} advanced={advanced} post={post} disabled={disabled} canPlan={canPlan}/>}</div>)}
  </section>;
}
