import {useEffect,useMemo,useRef,useState} from 'react';
import type {MergeRecord,MergeView,PrepareMergeInput,ApplyMergeInput,RecoverMergeInput} from '../shared/merge.ts';
import {createStudioMutator} from './studio-client.ts';

type Token={generation:number;sequence:number};
type MergeReadMode='poll'|'manual'|'after-mutation';
/** Manual observation may acknowledge an uncertain response; it never retries a write. */
export function acknowledgeMergeRead(mode:MergeReadMode,succeeded:boolean){return mode==='manual'&&succeeded;}
/** The actual GET/POST handlers share this order; selection changes invalidate reads. */
export function createMergeRequestEpoch(){
  let live=false,generation=0,sequence=0,mutation:number|null=null;
  return {
    reset(){live=true;generation++;sequence++;mutation=null;},
    dispose(){live=false;generation++;sequence++;mutation=null;},
    read():Token|null{return !live||mutation!==null?null:{generation,sequence:++sequence};},
    beginMutation():Token|null{if(!live||mutation!==null)return null;mutation=++sequence;return {generation,sequence};},
    isCurrent(token:Token){return live&&token.generation===generation&&token.sequence===sequence;},
    sameScope(token:Token){return live&&token.generation===generation;},
    endMutation(token:Token){if(!live||token.generation!==generation||mutation!==token.sequence)return false;mutation=null;return true;},
    changeSelection(){if(!live||mutation!==null)return false;sequence++;return true;},
  };
}
type ActionState={online:boolean;busy:boolean;fresh:boolean;uncertain:boolean;applyConfirmed:boolean;recoveryConfirmed:boolean};
export function mergeActionAvailability(view:MergeView|null,record:MergeRecord|undefined,state:ActionState){
  const idle=state.online&&!state.busy&&state.fresh&&!!view&&!view.busy;
  const source=idle&&!state.uncertain&&!!view?.available&&!!view.canPrepare&&!view.recoveryRequired&&!!view.runId&&!!view.sourceDigest&&!!view.checkSetDigest&&!!view.approvalId&&!!view.target;
  const same=!!view&&!!record&&record.projectId===view.projectId&&record.workspaceId===view.workspaceId;
  const bound=source&&same&&record.runId===view!.runId&&record.sourceDigest===view!.sourceDigest&&record.checkSetDigest===view!.checkSetDigest&&record.approvalId===view!.approvalId
    &&record.target.branch===view!.target!.branch&&record.target.head===view!.target!.head;
  return {prepare:!!source,apply:!!bound&&record!.status==='prepared'&&!!record!.candidate&&state.applyConfirmed,
    recover:!!idle&&same&&!!view?.recoveryRequired&&['lost','unknown','failed','preparing','applying'].includes(record!.status)&&state.recoveryConfirmed};
}
function statusLabel(record:MergeRecord){
  if(record.status==='applied')return record.completionBasis==='git_and_bytes'?'반영 확인 · Git/bytes 검증':record.completionBasis==='observed_after_recovery'?'복구 조회로 적용 관찰':'적용 근거 확인 불가';
  return {preparing:'후보 생성 중',prepared:'후보 준비됨 · 아직 반영하지 않음',applying:'대상 반영 중 · 결과 대기',failed:'실패 · 적용 완료 아님',lost:'재시작·결과 미확인',unknown:'결과 불확실'}[record.status];
}
type Props={projectId:string;workspaceId:string;runId:string|null;online:boolean;busy:boolean;post:(path:string,body:object)=>Promise<unknown>};
export function MergePanel(props:Props){return <ScopedMerge key={JSON.stringify([props.projectId,props.workspaceId,props.runId])} {...props}/>;}
function ScopedMerge({projectId,workspaceId,runId,online,busy,post}:Props){
  const [view,setView]=useState<MergeView|null>(null),[selectedId,setSelectedId]=useState(''),[loading,setLoading]=useState(false),[fresh,setFresh]=useState(false);
  const [mutation,setMutation]=useState<'prepare'|'apply'|'recover'|null>(null),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[message,setMessage]=useState(''),[checkedAt,setCheckedAt]=useState<string|null>(null);
  const [consent,setConsent]=useState<string|null>(null),[stopped,setStopped]=useState<string|null>(null);
  const order=useMemo(()=>createMergeRequestEpoch(),[]),postRef=useRef(post),mutationRef=useRef<Token|null>(null),reader=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),reload=useRef<(mode:MergeReadMode)=>Promise<void>>(async()=>{});
  postRef.current=post;
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{}return createStudioMutator((path,data)=>postRef.current(path,data),storage);},[]);
  const records=view?.records.filter(record=>record.projectId===projectId&&record.workspaceId===workspaceId).slice(0,20)??[];
  const selected=records.find(record=>record.id===selectedId)??records.find(record=>record.runId===runId&&record.status==='prepared')??records[0];
  const consentKey=JSON.stringify({projectId,workspaceId,runId,recordId:selected?.id,candidate:selected?.candidate,target:selected?.target,status:selected?.status,updatedAt:selected?.updatedAt,
    sourceDigest:view?.sourceDigest,checkSetDigest:view?.checkSetDigest,approvalId:view?.approvalId,currentTarget:view?.target});
  const confirmed=consent===consentKey,recoveryConfirmed=stopped===consentKey;
  useEffect(()=>{setConsent(null);setStopped(null);},[consentKey]);
  useEffect(()=>{
    order.reset();setView(null);setFresh(false);setConsent(null);setStopped(null);setMutation(null);mutationRef.current=null;setLoading(false);
    async function load(mode:MergeReadMode){
      if(!online)return;const token=order.read();if(!token)return;
      if(timer.current)clearTimeout(timer.current);reader.current?.abort();const controller=new AbortController();reader.current=controller;setLoading(true);
      try{
        const response=await fetch('/api/workspaces/'+encodeURIComponent(workspaceId)+'/merge'+(runId?'?runId='+encodeURIComponent(runId):''),{signal:controller.signal});if(!response.ok)throw new Error();
        const result=await response.json() as MergeView;
        if(!order.isCurrent(token))return;if(result.projectId!==projectId||result.workspaceId!==workspaceId||result.runId!==runId||!Array.isArray(result.records))throw new Error();
        setView(result);setFresh(true);setLoadError('');setCheckedAt(new Date().toISOString());
        if(acknowledgeMergeRead(mode,true)){setUncertain(false);setError('');setConsent(null);setStopped(null);setMessage('서버 상태를 다시 확인했습니다. 진행하려면 현재 기록을 검토하고 새로 동의하세요.');}
      }catch{if(order.isCurrent(token)&&!controller.signal.aborted){setFresh(false);setLoadError('병합 상태를 확인하지 못했습니다. 표시된 과거 값으로 반영하지 않으며 다시 조회해야 합니다.');}}
      finally{if(order.isCurrent(token))setLoading(false);if(order.sameScope(token))timer.current=setTimeout(()=>void load('poll'),15000);}
    }
    reload.current=load;if(online)void load('poll');
    return()=>{order.dispose();reader.current?.abort();if(timer.current)clearTimeout(timer.current);reload.current=async()=>{};};
  },[projectId,workspaceId,runId,online,order]);
  function choose(id:string){
    if(!order.changeSelection())return;reader.current?.abort();setLoading(false);setSelectedId(id);setConsent(null);setStopped(null);setMessage('');
  }
  async function action(kind:'prepare'|'apply'|'recover'){
    const enabled=mergeActionAvailability(view,selected,{online,busy:busy||!!mutation,fresh:fresh&&!loading,uncertain,applyConfirmed:confirmed,recoveryConfirmed});
    if(!enabled[kind]||!view)return;const token=order.beginMutation();if(!token)return;
    mutationRef.current=token;reader.current?.abort();if(timer.current)clearTimeout(timer.current);setMutation(kind);setConsent(null);setStopped(null);setError('');setMessage('');
    try{
      let result:unknown;
      if(kind==='prepare'){
        const input:Omit<PrepareMergeInput,'requestId'>={workspaceId,runId:view.runId!,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!,expectedApprovalId:view.approvalId!,expectedTargetBranch:view.target!.branch,expectedTargetHead:view.target!.head};
        result=await mutate('/api/merges/prepare',{...input});
      }else if(kind==='apply'){
        const input:Omit<ApplyMergeInput,'requestId'>={recordId:selected!.id,expectedCommitSha:selected!.candidate!.commitSha,confirmed:true};result=await mutate('/api/merges/apply',{...input});
      }else{
        const input:RecoverMergeInput={recordId:selected!.id,confirmedStopped:true};result=await postRef.current('/api/merges/recover',input);
      }
      if(!order.isCurrent(token))return;
      const record=result as MergeRecord;if(record?.projectId===projectId&&record.workspaceId===workspaceId&&typeof record.id==='string')setSelectedId(record.id);
      setUncertain(false);setMessage(kind==='prepare'?'병합 후보 생성 요청을 보냈습니다. 서버의 최종 상태를 확인하세요.':kind==='apply'?'대상 브랜치 반영 요청을 보냈습니다. 반영 완료 여부는 서버 기록으로 확인하세요.':'프로세스 종료 확인을 전달해 상태 재확인을 요청했습니다. reset·rollback을 요청하지 않았습니다.');
    }catch{if(order.sameScope(token)){setUncertain(true);setError('요청 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 상태를 새로고침하고 불확실한 기록은 프로세스 종료 확인 후 재확인하세요.');}}
    finally{if(order.endMutation(token)&&mutationRef.current===token){mutationRef.current=null;setMutation(null);setFresh(false);setLoading(false);await reload.current('after-mutation');}}
  }
  return <section className="surface merge-panel" aria-label="승인된 로컬 병합" aria-busy={!!mutation||!!view?.busy}>
    <div className="section-heading"><h2>승인된 변경 반영</h2><button disabled={!online||loading||!!mutation} onClick={()=>void reload.current('manual')}>병합 상태 새로고침</button></div>
    <p>후보 생성은 primary 파일과 원 source worktree를 바꾸지 않습니다. 별도로 반영을 승인하면 표시된 primary 대상 branch의 파일이 변경되며 원 source worktree는 보존됩니다.</p>
    <p>현재 지원은 같은 base의 clean primary에 대한 ff-only입니다. dirty·stale 대상과 지원하지 않는 attributes는 거절합니다. source·target·리뷰 승인은 반영 직전에 서버가 다시 검사하며 화면 표시만으로 보장하지 않습니다.</p>
    <p>적용 중·재시작·결과 불확실 상태를 완료로 보지 않으며 자동 재시도하지 않습니다. 재확인은 서버 관찰만 요청하며 reset·rollback·push를 실행하지 않습니다.</p>
    {loadError&&<p role="alert">{loadError}</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}{uncertain&&<p className="notice">이 요청의 응답은 미확인입니다. 병합 상태 새로고침이 성공하면 표시된 기록을 검토한 뒤 새로 동의할 수 있습니다. 자동 조회는 잠금을 해제하지 않으며 저장된 요청을 자동으로 재전송하지 않습니다.</p>}
    {checkedAt&&<p className="subtle">마지막 조회 {checkedAt} · {fresh?'조회 당시 서버 값':'현재성 확인 필요'} · 자동 조회는 15초 간격이며 요청 처리 중에는 멈춥니다.</p>}
    {view?.issue&&<p>서버 진단: <code>{view.issue}</code></p>}{view&&<p>{view.scope}</p>}
    {!!records.length&&<label className="merge-record-select">병합 후보·처리 기록<select id="merge-record" value={selected?.id??''} disabled={!online||!!mutation} onChange={event=>choose(event.target.value)}>{records.map(record=><option key={record.id} value={record.id}>{record.id.slice(0,8)} · {statusLabel(record)}</option>)}</select></label>}
    <MergeControls view={view} record={selected} online={online} busy={busy||!!mutation} fresh={fresh&&!loading} uncertain={uncertain} applyConfirmed={confirmed} recoveryConfirmed={recoveryConfirmed}
      onPrepare={()=>void action('prepare')} onApply={()=>void action('apply')} onRecover={()=>void action('recover')} onApplyConsent={value=>setConsent(value?consentKey:null)} onRecoveryConsent={value=>setStopped(value?consentKey:null)}/>
    <MergeHistory projectId={projectId} workspaceId={workspaceId} records={records}/>
  </section>;
}
type Controls=ActionState&{view:MergeView|null;record?:MergeRecord;onPrepare:()=>void;onApply:()=>void;onRecover:()=>void;onApplyConsent:(value:boolean)=>void;onRecoveryConsent:(value:boolean)=>void};
export function MergeControls(props:Controls){
  const {view,record}=props,enabled=mergeActionAvailability(view,record,props);
  const canConfirm=mergeActionAvailability(view,record,{...props,applyConfirmed:true}).apply;
  const canRecover=mergeActionAvailability(view,record,{...props,recoveryConfirmed:true}).recover;
  return <div className="merge-controls">
    <dl className="policy-list"><div><dt>현재 리뷰 승인</dt><dd><code>{view?.approvalId??'unknown'}</code></dd></div><div><dt>source / checkset</dt><dd><code>{view?.sourceDigest??'unknown'}</code><br/><code>{view?.checkSetDigest??'unknown'}</code></dd></div><div><dt>현재 primary 대상</dt><dd>{view?.target?.branch??'unknown'}<br/><code>{view?.target?.head??'unknown'}</code></dd></div></dl>
    <button disabled={!enabled.prepare} onClick={()=>{if(enabled.prepare)props.onPrepare();}}>승인 내용의 병합 후보 만들기</button>
    {record?.candidate&&<div className="merge-candidate"><h3>선택한 보존 후보</h3><p>후보 commit <code>{record.candidate.commitSha}</code><br/>후보 tree <code>{record.candidate.treeSha}</code><br/>보존 후보 ref <code>{record.candidate.branch}</code></p><p>반영 대상 branch <b>{record.target.branch}</b> · 기준 head <code>{record.target.head}</code></p></div>}
    <label className="merge-consent"><input id="merge-apply-consent" type="checkbox" checked={props.applyConfirmed} disabled={!canConfirm} onChange={event=>props.onApplyConsent(event.target.checked)}/>표시된 대상 branch에 반영 승인</label>
    <button disabled={!enabled.apply} onClick={()=>{if(enabled.apply)props.onApply();}}>승인한 후보를 대상 브랜치에 반영</button>
    {!view?.canPrepare&&<p>현재 검증·리뷰 승인·source/checkset·clean 대상 조건을 서버에서 확인해야 후보를 만들거나 반영할 수 있습니다.</p>}
    {view?.recoveryRequired&&<div className="merge-recovery"><p>이전 Git 작업 결과가 불확실합니다. 프로세스 종료를 실제로 확인한 뒤 상태만 재확인하세요.</p><p>이 프로젝트의 다른 작업 공간에 미확정 병합이 있을 수 있습니다. 여기에는 현재 작업 공간의 기록을 표시합니다. 해당 기록이 보이지 않으면 프로젝트 화면에서 관련 작업 공간을 선택해 확인하세요. <a href="#/projects">프로젝트에서 작업 공간 선택</a></p><label className="merge-consent"><input id="merge-recovery-consent" type="checkbox" checked={props.recoveryConfirmed} disabled={!canRecover} onChange={event=>props.onRecoveryConsent(event.target.checked)}/>이전 Git 프로세스가 종료되었음을 확인</label><button disabled={!enabled.recover} onClick={()=>{if(enabled.recover)props.onRecover();}}>프로세스 종료 확인 후 상태 재확인</button></div>}
  </div>;
}
export function MergeHistory({projectId,workspaceId,records}:{projectId:string;workspaceId:string;records:readonly MergeRecord[]}){
  const visible=records.filter(record=>record.projectId===projectId&&record.workspaceId===workspaceId).slice(0,20);
  return <section className="merge-history" aria-label="병합 처리 기록"><h3>병합 기록 · 미확정 기록 우선 · 최대 20개</h3>{visible.length?<ul className="record-list">{visible.map(record=><li key={record.id}><div><b>{statusLabel(record)}</b><p>기록 {record.id} · Run {record.runId} · {record.phase}</p><p>대상 {record.target.branch} · 반영 전 head <code>{record.target.head}</code></p>{record.candidate&&<p>후보 commit <code>{record.candidate.commitSha}</code> · tree <code>{record.candidate.treeSha}</code></p>}{record.issue&&<p>진단 <code>{record.issue}</code></p>}<p>갱신 {record.updatedAt}</p></div></li>)}</ul>:<p className="subtle">저장된 병합 기록이 없습니다.</p>}</section>;
}
