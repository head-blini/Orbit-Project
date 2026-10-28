import {useEffect,useRef,useState} from 'react';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {CapabilityInvocationRecord} from '../shared/capability-invocation.ts';
import type {CapabilityRoutePost} from './capability-routing.tsx';
const invocationLabels={completed:'기능 요청 처리 완료',requested:'요청 접수 · 종료 확인 아님',failed:'기능 요청 실패',unknown:'기능 요청 결과 미확인'};
export function InvocationEvidence({record}:{record:CapabilityInvocationRecord}){
 return <section aria-label="기존 실행 기능 결과">
  <p role="status">{invocationLabels[record.status]}</p><p>대상 실행: {record.runId}</p>
  {record.issue&&<p role="alert">{record.issue}</p>}
  {record.result&&<><p>실행 상태: {record.result.execution} · 기록상 종결 상태: {record.result.terminal?'예':'아니오'} · 작업 정지 기록: {record.result.stopConfirmed?'확인':'미확인'}</p>
   <p>실행 증거 출처: {record.result.providerEvidence.source} · 품질 검증: {record.result.providerEvidence.quality} · 실 Provider 전체 흐름: {record.result.providerEvidence.source==='native'&&record.result.providerEvidence.livePipelineVerified?'검증됨':'검증 대기'}</p>
   {record.result.response&&<details><summary>저장된 결과 응답</summary><pre>{record.result.response}</pre></details>}
  </>}
 </section>;
}
export function CapabilityInvocation({decision,post,disabled=false}:{decision:CapabilityRouteDecision;post?:CapabilityRoutePost;disabled?:boolean}){
 const [record,setRecord]=useState<CapabilityInvocationRecord|null>(null),[approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false),generation=useRef(0);
 const scope=`${decision.projectId}/${decision.id}/${decision.runId??''}/${decision.invocationDigest??''}`,scopeRef=useRef(scope);scopeRef.current=scope;
 const base=`/api/projects/${encodeURIComponent(decision.projectId)}/capability-invocations`;
 function accept(value:CapabilityInvocationRecord){if(value?.routeId!==decision.id||value?.runId!==decision.runId||!Object.hasOwn(invocationLabels,value?.status))throw Error();setRecord(value);}
 useEffect(()=>{
  const ticket=++generation.current;pending.current=false;setRecord(null);setApproved(false);setError('');setBusy(false);
  void fetch(base,{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error();const value=await response.json();if(ticket!==generation.current||scopeRef.current!==scope)return;const found=value?.records?.find((r:CapabilityInvocationRecord)=>r.routeId===decision.id&&r.runId===decision.runId);if(found)accept(found);}).catch(()=>{if(ticket===generation.current&&scopeRef.current===scope)setError('저장된 기능 요청 기록을 불러오지 못했습니다.');});
  return()=>{generation.current++;};
 },[base,scope]);
 async function invoke(){
  if(!post||disabled||pending.current||!decision.invocationDigest||!decision.runId||decision.status!=='recommended'||decision.intent==='interrupt'&&!approved)return;
  pending.current=true;setBusy(true);setError('');const ticket=++generation.current;
  try{
   const key=`orbit.capability.invocation.${decision.projectId}.${decision.id}.${decision.invocationDigest}`;
   const requestId=record?.requestId??sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,requestId);
   const response=await post(base,{requestId,routeId:decision.id,expectedDigest:decision.invocationDigest,confirmed:true});
   const value=await response.json();if(ticket!==generation.current||scopeRef.current!==scope)return;
   if(!response.ok)throw Error();accept(value);setApproved(false);
  }catch{if(ticket===generation.current&&scopeRef.current===scope)setError('요청 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 같은 요청으로 기록을 다시 확인하세요.');}
  finally{if(ticket===generation.current&&scopeRef.current===scope){pending.current=false;setBusy(false);}}
 }
 const interrupt=decision.intent==='interrupt';
 return <section aria-label="기존 실행 기능 요청">
  <p>대상 실행: {decision.runId??'미선택'} · 새 모델 작업을 시작하지 않습니다.</p>
  {interrupt&&post&&<label><input type="checkbox" checked={approved} disabled={disabled||busy} onChange={event=>setApproved(event.target.checked)}/>선택한 실행의 중단 요청을 승인합니다</label>}
  {post&&<button disabled={disabled||busy||decision.status!=='recommended'||!decision.runId||!decision.invocationDigest||interrupt&&!approved} onClick={()=>void invoke()}>{record?'같은 기능 요청 기록 확인':interrupt?'승인하고 중단 요청':decision.intent==='result'?'저장된 실행 결과 조회':'실행 상태 조회'}</button>}
  {record&&<InvocationEvidence record={record}/>}{error&&<p role="alert">{error}</p>}
 </section>;
}
