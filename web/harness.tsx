import {useCallback,useEffect,useState} from 'react';
import type {HarnessProjectView,HarnessTarget,HarnessTargetView,HarnessVersionView} from '../shared/harness.ts';

const TARGET:Record<HarnessTarget,string>={claude_task:'Claude 작업 지침',codex_brief:'Codex 작업 지침',repair:'수정 작업 지침'};
const when=(at:string|null)=>at?new Date(at).toLocaleString('ko-KR'):'시각 미상';
const short=(digest:string|null)=>digest?digest.slice(0,12):'없음';

/** Only a live, passed evaluation counts; fake, mock or unverified results are never shown as an improvement. */
const verifiedEval=(v:HarnessVersionView)=>v.evaluations.find(e=>e.verified&&e.state==='ok'&&e.verdict==='passed'&&e.runnerMode==='live')??null;
const freshApproval=(v:HarnessVersionView)=>v.approvals.find(a=>a.fresh)??null;
const everActive=(t:HarnessTargetView,versionId:string)=>t.history.some(h=>h.versionId===versionId);
/** Suggestions: never-activated non-baseline versions. Only children of the active version can be evaluated or promoted. */
const proposals=(t:HarnessTargetView)=>t.versions.filter(v=>v.revision>0&&!everActive(t,v.versionId));
/** HE-2 rollback targets: ancestors of the active version that were active before, or v0. */
function rollbackTargets(t:HarnessTargetView):HarnessVersionView[]{
  const byId=new Map(t.versions.map(v=>[v.versionId,v]));const out:HarnessVersionView[]=[];
  let parent=t.activeVersionId?byId.get(t.activeVersionId)?.parentId??null:null;
  while(parent){const v=byId.get(parent);if(!v)break;if(v.revision===0||everActive(t,v.versionId))out.push(v);parent=v.parentId;}
  return out;
}
function status(t:HarnessTargetView,v:HarnessVersionView):string{
  if(v.classification.status==='blocked')return '안전 규칙에 맞지 않아 쓸 수 없음';
  if(v.parentId!==t.activeVersionId)return '현재 지침이 바뀌어 다시 만들어야 함';
  if(!verifiedEval(v))return '검증되지 않음';
  if(!freshApproval(v))return '승인 필요';
  return '승인됨 · 적용 대기';
}

export interface HarnessActions {
  generate?:()=>void;
  propose?:(target:HarnessTarget,line:string)=>void;
  evaluate?:(versionId:string)=>void;
  approve?:(t:HarnessTargetView,v:HarnessVersionView)=>void;
  promote?:(t:HarnessTargetView,v:HarnessVersionView)=>void;
  rollback?:(t:HarnessTargetView,v:HarnessVersionView)=>void;
}

function Proposal({t,v,advanced,busy,runnerMode,actions}:{t:HarnessTargetView;v:HarnessVersionView;advanced:boolean;busy:boolean;runnerMode:HarnessProjectView['runnerMode'];actions:HarnessActions}){
  const added=v.lines.slice(t.versions.find(x=>x.versionId===v.parentId)?.lines.length??0);
  const evaluable=v.classification.status==='eligible'&&v.parentId===t.activeVersionId&&t.target!=='codex_brief';
  const passed=verifiedEval(v),approved=freshApproval(v);
  return <li>
    <b>작업 지침 개선 제안</b> <span>({v.origin==='user'?'직접 제안':'반복 실패 기록에서 만든 제안'})</span> — <strong>{status(t,v)}</strong>
    <ul>{added.map((line,i)=><li key={i}>{line}</li>)}</ul>
    {advanced&&<div>
      <div>버전 <code>{v.versionId}</code> · v{v.revision} · 내용 <code>{short(v.digest)}</code> · 상위 <code>{v.parentId}</code> · 만든 시각 {when(v.createdAt)}</div>
      {v.classification.status==='blocked'&&<div>차단 사유: {v.classification.reasons.map(r=><code key={r}>{r} </code>)}</div>}
      {v.evidence&&<div>근거 실패 묶음 {v.evidence.familyIds.length}개 · 재현 사례 {v.evidence.caseIds.length}개 · 색인 {v.evidence.indexerVersion}</div>}
      {!v.evidence&&<div>근거 재현 사례 없음 — 보호 평가를 통과할 수 없습니다.</div>}
      <h4>보호 평가</h4>
      {v.evaluations.length?<ul>{v.evaluations.map(e=><li key={e.evaluationId}>
        <code>{e.evaluationId}</code> · 판정 {e.verdict??'기록 손상'} · 실행 방식 {e.runnerMode==='live'?'실제':e.runnerMode==='fake'?'모의':'미상'} · {e.verified?'검증됨':'검증되지 않음 (개선으로 세지 않음)'} · {when(e.createdAt)}
        {e.reasons.length>0&&<div>{e.reasons.map(r=><code key={r}>{r} </code>)}</div>}
      </li>)}</ul>:<p>평가 기록 없음</p>}
      <h4>승인</h4>
      {v.approvals.length?<ul>{v.approvals.map(a=><li key={a.requestId}><code>{a.requestId}</code> · {when(a.approvedAt)} · {a.fresh?'유효':'만료됨 (평가·지침·평가 기준이 바뀜)'}</li>)}</ul>:<p>승인 기록 없음</p>}
      {actions.evaluate&&<button disabled={busy||!evaluable||!runnerMode} onClick={()=>actions.evaluate!(v.versionId)}>보호 평가 실행</button>}
      {!runnerMode&&<small> 평가 실행기가 연결되지 않아 평가할 수 없습니다.</small>}
      {t.target==='codex_brief'&&<small> Codex 지침은 실제 모델을 확인할 수 없어 평가할 수 없습니다.</small>}
      {' '}{actions.approve&&<button disabled={busy||!evaluable||!passed} onClick={()=>actions.approve!(t,v)}>적용 승인</button>}
      {' '}{actions.promote&&<button disabled={busy||!evaluable||!approved} onClick={()=>actions.promote!(t,v)}>승인된 지침 적용</button>}
    </div>}
  </li>;
}

function Target({t,advanced,busy,runnerMode,actions}:{t:HarnessTargetView;advanced:boolean;busy:boolean;runnerMode:HarnessProjectView['runnerMode'];actions:HarnessActions}){
  if(t.state==='error')return <li><b>{TARGET[t.target]}</b> 기록을 읽을 수 없습니다{advanced&&<> (<code>{t.error}</code>)</>}.</li>;
  const active=t.versions.find(v=>v.versionId===t.activeVersionId),list=proposals(t),back=rollbackTargets(t);
  const proposed=active?.windows.some(w=>w.endedAt===null&&w.rollbackProposed);
  return <li>
    <b>{TARGET[t.target]}</b> 현재 {active&&active.revision>0?`추가 지침 v${active.revision} 사용 중`:'기본 지침 사용 중 (추가 지침 없음)'}
    {proposed&&<div className="banner warning">적용 뒤에도 같은 실패가 다시 기록됐습니다. 이전 지침으로 되돌리는 것을 검토해 보세요. 자동으로 되돌리지 않습니다.</div>}
    {list.length?<ul>{list.map(v=><Proposal key={v.versionId} t={t} v={v} advanced={advanced} busy={busy} runnerMode={runnerMode} actions={actions}/>)}</ul>:<p>개선 제안 없음</p>}
    {advanced&&<>
      {active&&active.revision>0&&<><h4>현재 추가 지침</h4><ul>{active.lines.map((l,i)=><li key={i}>{l}</li>)}</ul></>}
      <h4>적용 이력</h4>
      {t.history.length?<ul>{t.history.map(h=><li key={h.sequence}>#{h.sequence} {h.kind==='promotion'?'적용':'되돌림'} <code>{h.fromVersionId}</code> → <code>{h.versionId}</code> · {when(h.createdAt)}</li>)}</ul>:<p>이력 없음</p>}
      {active?.windows.map(w=><div key={w.startSequence}>적용 구간 #{w.startSequence}: {w.status}{w.families.length>0&&<> · {w.families.map(f=><span key={f.familyId}> 이전 실제 {f.before?.real??'미상'} / 이후 실제 {f.after?.real??'미상'}</span>)}</>}</div>)}
      {actions.rollback&&back.map(v=><div key={v.versionId}><button disabled={busy} onClick={()=>actions.rollback!(t,v)}>{v.revision===0?'기본 지침으로 되돌리기':`v${v.revision}(으)로 되돌리기`}</button></div>)}
    </>}
  </li>;
}

/** Presentational and static-renderable. */
export function HarnessBody({view,advanced,busy=false,confirming=null,error='',actions={},onConfirm,onCancel}:{view:HarnessProjectView;advanced:boolean;busy?:boolean;confirming?:string|null;error?:string;
  actions?:HarnessActions;onConfirm?:()=>void;onCancel?:()=>void}){
  const [target,setTarget]=useState<HarnessTarget>('claude_task'),[line,setLine]=useState('');
  return <section className="surface harness" aria-label="작업 지침 개선">
    <div className="section-heading"><div><h2>작업 지침 개선</h2><p>반복된 실패를 바탕으로 AI 작업 지침에 덧붙일 문장을 제안합니다. 검증과 사용자 승인 없이는 적용되지 않습니다.</p></div></div>
    {error&&<div className="banner error" role="alert">{error}</div>}
    {confirming&&<div role="group" className="banner">{confirming} <button disabled={busy} onClick={onConfirm}>확인</button> <button onClick={onCancel}>취소</button></div>}
    <ul>{view.targets.map(t=><Target key={t.target} t={t} advanced={advanced} busy={busy} runnerMode={view.runnerMode} actions={actions}/>)}</ul>
    {advanced&&<>
      {actions.generate&&<button disabled={busy} onClick={actions.generate}>실패 기록으로 제안 만들기</button>}
      {actions.propose&&<form onSubmit={e=>{e.preventDefault();if(line.trim())actions.propose!(target,line.trim());}}>
        <label>대상 <select value={target} onChange={e=>setTarget(e.target.value as HarnessTarget)}>{(Object.keys(TARGET) as HarnessTarget[]).map(k=><option key={k} value={k}>{TARGET[k]}</option>)}</select></label>
        {' '}<label>덧붙일 지침 한 문장 <input value={line} maxLength={160} onChange={e=>setLine(e.target.value)}/></label>
        {' '}<button disabled={busy||!line.trim()}>직접 제안</button>
        <small> 근거 사례가 없는 직접 제안은 보호 평가를 통과할 수 없어 적용되지 않습니다.</small>
      </form>}
    </>}
  </section>;
}

export function HarnessPanel({projectId,online,advanced,post}:{projectId:string;online:boolean;advanced:boolean;post:(path:string,body:object)=>Promise<Response>}){
  const [view,setView]=useState<HarnessProjectView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [pending,setPending]=useState<{label:string;path:string;body:object}|null>(null);
  const base=`/api/projects/${encodeURIComponent(projectId)}/harness`;
  const load=useCallback(async()=>{
    try{const r=await fetch(base,{cache:'no-store'});if(!r.ok)throw new Error();
      const v=await r.json() as HarnessProjectView;if(v.projectId!==projectId)throw new Error();setView(v);setError('');}
    catch{setError('작업 지침 기록을 불러오지 못했습니다. 서버 연결을 확인한 뒤 다시 열어 주세요.');}
  },[base,projectId]);
  useEffect(()=>{setView(null);setPending(null);if(online)void load();},[load,online]);
  async function send(path:string,body:object){
    setBusy(true);setError('');
    try{const r=await post(base+path,body);if(!r.ok){const e=await r.json().catch(()=>({})) as {error?:string};throw new Error(e.error??'');}setPending(null);await load();}
    catch(e){setError(`요청을 완료하지 못했습니다${e instanceof Error&&e.message?` (${e.message})`:''}. 지침이나 평가가 그사이 바뀌었을 수 있습니다.`);}
    finally{setBusy(false);}
  }
  const ask=(label:string,path:string,body:object)=>setPending({label,path,body});
  const rid=()=>crypto.randomUUID();
  const actions:HarnessActions={
    generate:()=>void send('/candidates/generate',{}),
    propose:(target,line)=>ask('이 문장을 직접 제안으로 저장할까요? 적용은 되지 않습니다.','/proposals',{requestId:rid(),target,line,evidence:null,confirmed:true}),
    evaluate:versionId=>void send('/evaluations',{requestId:rid(),candidateVersionId:versionId,liveApproval:null}),
    approve:(t,v)=>{const e=verifiedEval(v);if(e?.evaluationDigest)ask('검증된 평가 결과로 이 제안의 적용을 승인할까요?','/approvals',{requestId:rid(),evaluationId:e.evaluationId,candidateDigest:v.digest,evaluationDigest:e.evaluationDigest,expectedSequence:t.pointerSequence,confirmed:true});},
    promote:(t,v)=>{const a=freshApproval(v);if(a&&v.parentId&&t.pointerSequence!==null)ask('승인된 지침을 이 프로젝트의 다음 실행부터 적용할까요?','/promotions',{requestId:a.requestId,target:t.target,versionId:v.versionId,fromVersionId:v.parentId,expectedSequence:t.pointerSequence,candidateDigest:a.candidateDigest,evaluationDigest:a.evaluationDigest});},
    rollback:(t,v)=>{if(t.activeVersionId&&t.pointerSequence!==null)ask('이 지침으로 되돌릴까요? 기록은 지워지지 않습니다.','/rollbacks',{requestId:rid(),target:t.target,versionId:v.versionId,fromVersionId:t.activeVersionId,expectedSequence:t.pointerSequence,confirmed:true});},
  };
  if(!view)return error?<div className="banner error" role="alert">{error}</div>:null;
  return <HarnessBody view={view} advanced={advanced} busy={busy||!online} confirming={pending?.label??null} error={error} actions={actions}
    onConfirm={()=>{if(pending&&!busy)void send(pending.path,pending.body);}} onCancel={()=>setPending(null)}/>;
}
