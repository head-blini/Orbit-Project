import {useEffect,useRef,useState} from 'react';
import type {CapabilityExecutionRecord,CapabilityExecutionStatus} from '../shared/capability-execution.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {QualityLoopPreview} from '../shared/quality-loop-record.ts';
import type {CapabilityRoutePost} from './capability-routing.tsx';
import {QualityLoopStatus} from './project-progress.tsx';

const labels:Record<CapabilityExecutionStatus,string>={awaiting_approval:'실행 승인 대기',dispatching:'실행 요청 확인 중',running:'실행 중',interrupt_requested:'중단 요청됨 · 종료 미확인',interrupted:'중단 확인',failed:'실행 실패',recovery_required:'종료 확인 필요',execution_completed:'응답 완료 · 품질 검증 전',quality_running:'품질 검증 중',quality_blocked:'품질 검증 차단',quality_failed:'품질 검증 실패',quality_passed:'품질 검증 통과'};
export function ProviderEvidence({record,advanced}:{record:CapabilityExecutionRecord;advanced:boolean}){
  const evidence=record.providerEvidence,source=evidence?.source??'unknown';
  const liveVerified=source==='native'&&evidence?.livePipelineVerified===true;
  return <section aria-label="Provider 검증 근거">
    <p>검증 출처: {source==='mock'?'Mock · 모의 검증':source==='native'?'실제 네이티브 Provider':'unknown · 실행 출처 미확인'}</p>
    <p>{source==='mock'?'모의 실행 관측':source==='native'?'실제 실행 관측':'실행 관측'}: {evidence?.executionObserved?'확인':'미확인'} · 실 Provider 전체 흐름: {liveVerified?'검증됨':'검증 대기'}</p>
    <p>실제 비용 (USD): unknown · 잔여 사용량: unknown</p>
    {advanced&&<details><summary>Provider 증거 상세</summary>
      <p>실행 인터페이스: {evidence?.interface??'unknown'} · 응답 근거: {evidence?.responseDigest??'없음'}</p>
      <p>품질 검증 기록: {evidence?.quality??'not_started'} · 비용과 사용량은 추정하지 않습니다.</p>
    </details>}
  </section>;
}
export function CapabilityExecutionEvidence({record,advanced}:{record:CapabilityExecutionRecord;advanced:boolean}){
  return <section aria-label="기능 실행 기록"><p role="status"><strong>{record.status==='quality_passed'&&record.providerEvidence?.source==='mock'?'모의 품질 검증 통과':labels[record.status]}</strong> · {record.runtimeId}</p>
    <p>실제 실행 모델: {record.models.actualModelId} · 근거: {record.models.source}</p>
    <ProviderEvidence record={record} advanced={advanced}/>
    {record.issue&&<p role="alert">{record.issue}</p>}
    {advanced&&<details><summary>실행 계약과 증거</summary>
      <p>사용자 선택: {record.models.selectedModelId??'미지정'} · 요청 모델: {record.models.requestedModelId??'미지정'} · 서버 설정 모델: {record.models.serverModelId??'unknown'}</p>
      <p>승인 작업: {record.taskId} · 기획 기준: {record.baseline.planningVersionId} · {record.baseline.planningContentHash}</p>
      <p>Adapter 버전: {record.adapter.version??'unknown'} · 개정: {record.adapter.revision}</p>
      <p>계획 근거: {record.planDigest} · 실행 ID: {record.runId??'없음'}</p>
      <a href={`/api/projects/${encodeURIComponent(record.projectId)}/capability-executions/${encodeURIComponent(record.id)}`} target="_blank" rel="noreferrer">저장된 실행 증거 보기</a>
    </details>}
    {record.quality&&<QualityLoopStatus loop={record.quality} advanced={advanced}/>}
  </section>;
}

export function CapabilityExecution({decision,records=[],advanced,post,disabled=false,canPlan=false}:{decision:CapabilityRouteDecision;records?:CapabilityExecutionRecord[];advanced:boolean;post?:CapabilityRoutePost;disabled?:boolean;canPlan?:boolean}){
  const [local,setLocal]=useState<CapabilityExecutionRecord|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [approved,setApproved]=useState(false),[qualityApproved,setQualityApproved]=useState(false),[preview,setPreview]=useState<QualityLoopPreview|null>(null);
  const [model,setModel]=useState(''),[provider,setProvider]=useState('openai');
  const lock=useRef(false),mounted=useRef(true),planRequest=useRef<string|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const record=[...records.filter(r=>r.projectId===decision.projectId&&r.taskId===decision.taskId&&r.routeId===decision.id),...(local?[local]:[])].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
  const base=`/api/projects/${encodeURIComponent(decision.projectId)}/capability-executions`,path=record?`${base}/${encodeURIComponent(record.id)}`:base;
  function accept(value:CapabilityExecutionRecord){if(value.projectId!==decision.projectId||value.taskId!==decision.taskId||value.routeId!==decision.id||!Object.hasOwn(labels,value.status))throw Error();if(mounted.current)setLocal(value);}
  async function perform(action:()=>Promise<void>){if(lock.current||disabled)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(error){if(mounted.current)setError(error instanceof Error&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message==='WORKSPACE_REQUIRED'?'시작하기·에이전트 센터에서 작업 공간을 선택한 뒤 계획을 다시 확인하세요.':`요청 차단: ${error.message}`:'요청 결과를 확인하지 못했습니다. 기록을 새로고침하여 확인하세요. 자동 재실행하지 않습니다.');}finally{lock.current=false;if(mounted.current)setBusy(false);}}
  async function send(suffix:string,body:object){if(!post)throw Error();const response=await post(path+suffix,body);const value=await response.json();if(!response.ok)throw Error(typeof value?.error==='string'?value.error:'');return value;}
  async function refresh(){const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw Error();accept(await response.json());}
  useEffect(()=>{
    if(!record||disabled||!['dispatching','running','interrupt_requested','quality_running'].includes(record.status))return;
    const timer=setInterval(()=>{void perform(refresh);},3000);return()=>clearInterval(timer);
  },[record?.id,record?.status,path,disabled]);
  const qualityInput={reviewers:[{id:'cross-review',providerId:provider,modelId:model.trim()}],limits:{maxRepairs:1,maxCalls:4,timeoutMs:120000}};
  return <section aria-label="기능 실행 계획">
    {!record&&post&&decision.status==='recommended'&&decision.intent==='execution'&&(canPlan?<button disabled={disabled||busy} onClick={()=>void perform(async()=>{planRequest.current??=crypto.randomUUID();accept(await send('',{requestId:planRequest.current,routeId:decision.id}));})}>실행 계획 확인</button>:<p>코드 작업은 시작하기·에이전트 센터에서 작업 공간과 검증 기준을 먼저 선택하세요.</p>)}
    {record&&<>
      <CapabilityExecutionEvidence record={record} advanced={advanced}/>
      {post&&record.status==='awaiting_approval'&&<>
        {record.workspaceId&&<p>작업 공간: {record.workspaceId} · 검증 기준: {record.expectedAcceptanceDigest??'미확인'}</p>}
        <p>승인된 작업을 {record.runtimeId}로 실행합니다. 작업 내용이 제공자에게 전송되며 기존 권한·사용량 정책이 적용됩니다.</p>
        <label><input type="checkbox" checked={approved} disabled={disabled||busy} onChange={event=>setApproved(event.target.checked)}/>이 실행 계획과 제공자 사용을 승인합니다</label>
        <button disabled={disabled||busy||!approved} onClick={()=>void perform(async()=>{accept(await send('/start',{confirmed:true,expectedPlanDigest:record.planDigest}));setApproved(false);})}>승인하고 실행</button>
      </>}
      <button disabled={disabled||busy} onClick={()=>void perform(refresh)}>실행 기록 새로고침</button>
      {post&&['dispatching','running','quality_running'].includes(record.status)&&<button disabled={disabled||busy} onClick={()=>void perform(async()=>accept(await send('/interrupt',{})))}>기능 실행 중단 요청</button>}
      {post&&record.quality?.recoveryRequired&&<button disabled={disabled||busy} onClick={()=>void perform(async()=>accept(await send('/quality-resume',{})))}>품질 실행 증거 확인 후 재개</button>}
      {post&&record.recoveryRequired&&<button disabled={disabled||busy} onClick={()=>void perform(async()=>accept(await send('/recover',{})))}>기존 실행 종료 확인</button>}
      {post&&['execution_completed','quality_blocked','quality_failed'].includes(record.status)&&!record.quality?.recoveryRequired&&<fieldset disabled={disabled||busy}><legend>교차 품질 검증</legend>
        <p>관측된 모델과 검증자 독립성이 확인되어야 실행됩니다. 선택값은 실제 모델 증거가 아닙니다.</p>
        <label>검증 제공자<select value={provider} onChange={event=>{setProvider(event.target.value);setPreview(null);setQualityApproved(false);}}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
        <label>검증 모델 ID<input value={model} onChange={event=>{setModel(event.target.value);setPreview(null);setQualityApproved(false);}}/></label>
        <p>최대 수정 1회 · 호출 4회 · 제한 120초</p>
        <button disabled={!model.trim()} onClick={()=>void perform(async()=>{setPreview(null);setQualityApproved(false);const value=await send('/quality-preview',qualityInput) as QualityLoopPreview;if(value.projectId!==decision.projectId||value.sourceRunId!==record.runId||!value.previewDigest)throw Error();setPreview(value);})}>품질 검증 계획 확인</button>
        {preview&&<><p>검증 대상 실행: {preview.sourceRunId} · 결과물: {preview.artifact.id} · {preview.artifact.digest} · 기준: {preview.baseline.digest}</p><p>실행 모델 근거: {preview.producer.modelId??'unknown'} · {preview.producer.source}</p>
          <label><input type="checkbox" checked={qualityApproved} onChange={event=>setQualityApproved(event.target.checked)}/>이 결과물의 교차 검토와 제한 내 수정을 승인합니다</label>
          <button disabled={!qualityApproved} onClick={()=>void perform(async()=>{const key=`orbit.capability.quality.${record.id}.${record.qualityLoopId??'initial'}.${preview.previewDigest}`;let requestId=sessionStorage.getItem(key);if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem(key,requestId);}accept(await send('/quality-start',{...qualityInput,requestId,expectedPreviewDigest:preview.previewDigest,confirmed:true}));setPreview(null);setQualityApproved(false);})}>승인하고 품질 검증</button></>}
      </fieldset>}
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
