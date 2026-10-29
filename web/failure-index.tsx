import {useCallback,useEffect,useState} from 'react';
import type {FailureCategory,FailureFamilyView,FailureIndexView} from '../shared/failure-intelligence.ts';

const CATEGORY:Record<FailureCategory,string>={tool_environment:'도구·환경 문제',policy_refusal:'정책에 의한 거절',quota_capacity:'사용량·용량 한도',auth:'로그인·인증 문제',output_rejected:'결과가 기준에 맞지 않음',unknown:'원인 미분류'};
const when=(at:string)=>at?new Date(at).toLocaleString('ko-KR'):'시각 미상';

function FamilyRow({family,advanced,children}:{family:FailureFamilyView;advanced:boolean;children?:React.ReactNode}){
  const counts=family.realCount?`실제 ${family.realCount}회`:'';const extra=[family.mockCount?`모의 ${family.mockCount}회`:'',family.unknownCount?`출처 미확인 ${family.unknownCount}회`:''].filter(Boolean).join(' · ');
  return <li>
    <b>{CATEGORY[family.category]}</b> <span>{[counts,extra].filter(Boolean).join(' · ')}</span> <time>{when(family.lastSeen)}</time>
    {advanced&&<div><code>{family.code}</code> · 출처 {family.source}{family.commandIdOrGate&&<> · 검사 <code>{family.commandIdOrGate}</code></>}{family.runtime&&<> · 실행기 {family.runtime}</>} · 기준 <code>{family.bindingDigest.slice(0,12)||'없음'}</code></div>}
    {children}
  </li>;
}

/** Presentational and static-renderable. Mock/unknown-only families never count as real evidence. */
export function FailureIndexBody({view,advanced,busy=false,confirming=null,error='',onCreate,onDelete,onConfirm,onCancel}:{view:FailureIndexView;advanced:boolean;busy?:boolean;confirming?:string|null;error?:string;
  onCreate?:(failureId:string)=>void;onDelete?:(caseId:string)=>void;onConfirm?:()=>void;onCancel?:()=>void}){
  const real=view.families.filter(f=>f.realCount>0),repeated=real.filter(f=>f.realCount>=2),other=view.families.filter(f=>f.realCount===0);
  const confirmRow=(key:string)=>confirming===key&&<span role="group"><button disabled={busy} onClick={onConfirm}>확인하고 저장</button> <button onClick={onCancel}>취소</button></span>;
  return <section className="surface failure-index" aria-label="반복되는 문제">
    <div className="section-heading"><div><h2>반복되는 문제</h2><p>기록된 실패를 같은 종류끼리 모았습니다. 읽기 전용이며 실행·재시도는 하지 않습니다.</p></div></div>
    {error&&<div className="banner error" role="alert">{error}</div>}
    {!advanced&&(repeated.length?<ul>{repeated.map(f=><li key={f.familyId}>{CATEGORY[f.category]}이(가) {f.realCount}번 반복됐습니다. 마지막 발생 {when(f.lastSeen)}</li>)}</ul>:<p>실제로 반복된 문제는 아직 없습니다.</p>)}
    {!advanced&&other.length>0&&<p>참고: 모의·출처 미확인 실패 {other.length}종은 실제 증거로 세지 않았습니다.</p>}
    {advanced&&<>
      <h3>실제 실패 묶음</h3>
      {real.length?<ul>{real.map(f=><FamilyRow key={f.familyId} family={f} advanced>
        {onCreate&&f.realFailureIds[0]&&<div><button disabled={busy} onClick={()=>onCreate(f.realFailureIds[0])}>재현 사례 만들기</button> {confirmRow(f.realFailureIds[0])}{confirming===f.realFailureIds[0]&&<small> 입력 본문 없이 식별값만 저장합니다. 삭제는 직접 요청할 때만 합니다.</small>}</div>}
      </FamilyRow>)}</ul>:<p>기록된 실제 실패가 없습니다.</p>}
      <h3>참고용 (모의·출처 미확인 — 실제 증거 아님)</h3>
      {other.length?<ul>{other.map(f=><FamilyRow key={f.familyId} family={f} advanced/>)}</ul>:<p>없음</p>}
      <h3>가설 (규칙 기반, 미검증)</h3>
      {view.hypotheses.length?<ul>{view.hypotheses.map((h,i)=><li key={i}><b>가설</b> {h.statement}<div>근거 {h.evidence.length}건: {h.evidence.map(id=><code key={id}>{id} </code>)}</div>
        <div>{h.counterEvidence.length?`반증 ${h.counterEvidence.length}건`:'반증 자료 없음 (성공 기록은 비교하지 않았습니다)'}</div></li>)}</ul>:<p>근거가 충분한 가설이 없습니다.</p>}
      <h3>재현 사례</h3>
      {view.cases.length?<ul>{view.cases.map(c=><li key={c.id}><code>{c.failureId}</code> <time>{when(c.createdAt)}</time>{onDelete&&<> <button disabled={busy} onClick={()=>onDelete(c.id)}>삭제</button> {confirmRow(c.id)}</>}</li>)}</ul>:<p>저장된 사례가 없습니다.</p>}
    </>}
  </section>;
}

export function FailureIndexPanel({projectId,online,advanced,post}:{projectId:string;online:boolean;advanced:boolean;post:(path:string,body:object)=>Promise<Response>}){
  const [view,setView]=useState<FailureIndexView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirming,setConfirming]=useState<{key:string;kind:'create'|'delete'}|null>(null);
  const load=useCallback(async()=>{
    try{const r=await fetch(`/api/projects/${encodeURIComponent(projectId)}/failure-index`,{cache:'no-store'});if(!r.ok)throw new Error();
      const v=await r.json() as FailureIndexView;if(v.projectId!==projectId)throw new Error();setView(v);setError('');}
    catch{setError('반복 문제 기록을 불러오지 못했습니다. 서버 연결을 확인한 뒤 다시 열어 주세요.');}
  },[projectId]);
  useEffect(()=>{setView(null);setConfirming(null);if(online)void load();},[load,online]);
  async function confirm(){
    if(!confirming||busy)return;setBusy(true);setError('');const base=`/api/projects/${encodeURIComponent(projectId)}/failure-cases`;
    try{
      const r=await post(confirming.kind==='create'?base:`${base}/${encodeURIComponent(confirming.key)}/delete`,confirming.kind==='create'?{requestId:crypto.randomUUID(),failureId:confirming.key,confirmed:true}:{confirmed:true});
      if(!r.ok)throw new Error();setConfirming(null);await load();
    }catch{setError('요청을 완료하지 못했습니다. 이 기록은 사례로 저장할 수 없거나 이미 바뀌었을 수 있습니다.');}finally{setBusy(false);}
  }
  if(!view)return error?<div className="banner error" role="alert">{error}</div>:null;
  return <FailureIndexBody view={view} advanced={advanced} busy={busy||!online} confirming={confirming?.key??null} error={error}
    onCreate={key=>setConfirming({key,kind:'create'})} onDelete={key=>setConfirming({key,kind:'delete'})} onConfirm={()=>void confirm()} onCancel={()=>setConfirming(null)}/>;
}
