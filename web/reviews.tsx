import {useEffect,useMemo,useRef,useState} from 'react';
import type {ReviewPreview,ReviewRecord,ReviewRepairPreview,ReviewView,StartReviewInput,StartReviewRepairInput} from '../shared/reviews.ts';
import {createStudioMutator} from './studio-client.ts';

type Token={generation:number;sequence:number};
type ReadMode='poll'|'manual'|'after-action';
type Scope={workspaceId:string;runId:string|null};
export function acknowledgeReviewRead(mode:ReadMode,succeeded:boolean){return mode==='manual'&&succeeded;}
/** Actual polling and actions share one live scope; a mutation synchronously locks competing handlers. */
export function createReviewRequestEpoch(){
  let live=false,generation=0,sequence=0,action:number|null=null;
  return {reset(){live=true;generation++;sequence++;action=null;},dispose(){live=false;generation++;sequence++;action=null;},
    read():Token|null{return live&&action===null?{generation,sequence:++sequence}:null;},
    beginAction():Token|null{if(!live||action!==null)return null;action=++sequence;return {generation,sequence};},
    isCurrent(token:Token){return live&&token.generation===generation&&token.sequence===sequence;},sameScope(token:Token){return live&&token.generation===generation;},
    endAction(token:Token){if(!live||token.generation!==generation||action!==token.sequence)return false;action=null;return true;}};
}
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function reviewPreviewMatches(preview:ReviewPreview,view:ReviewView,scope:Scope){
  return !!preview&&!!view&&preview.workspaceId===scope.workspaceId&&preview.runId===scope.runId&&view.workspaceId===scope.workspaceId&&view.runId===scope.runId
    &&!!preview.projectId&&digest(preview.sourceDigest)&&preview.sourceDigest===view.sourceDigest&&!view.sourceIssue&&digest(preview.inputDigest)&&digest(preview.previewDigest)
    &&/^[a-f0-9]{40,64}$/.test(preview.baseSha)&&preview.timeoutMs===60000&&view.timeoutMs===60000&&preview.turnLimit===1&&view.turnLimit===1
    &&typeof preview.instructions==='string'&&!!preview.instructions&&Array.isArray(preview.files)&&preview.files.every(file=>!!file.path&&['modified','deleted','untracked'].includes(file.status)&&Number.isSafeInteger(file.bytes)&&file.bytes>=0)
    &&new Set(preview.files.map(file=>file.path)).size===preview.files.length&&Number.isSafeInteger(preview.patchBytes)&&preview.patchBytes>=0;
}
export function sameReviewPreview(a:ReviewPreview,b:ReviewPreview){
  return ['projectId','workspaceId','runId','baseSha','sourceDigest','inputDigest','previewDigest','instructions','patchBytes','timeoutMs','turnLimit','scope'].every(key=>a[key as keyof ReviewPreview]===b[key as keyof ReviewPreview])
    &&JSON.stringify(a.files.map(file=>[file.path,file.status,file.bytes]))===JSON.stringify(b.files.map(file=>[file.path,file.status,file.bytes]));
}
type Availability={online:boolean;busy:boolean;loading:boolean;fresh:boolean;uncertain:boolean;confirmed:boolean};
export function reviewAvailability(view:ReviewView|null,preview:ReviewPreview|null,scope:Scope,state:Availability){
  const allowed=state.online&&!state.busy&&!state.loading&&state.fresh&&!state.uncertain&&!!view&&!view.busy&&!view.recoveryRequired&&!view.sourceIssue&&digest(view.sourceDigest)&&view.workspaceId===scope.workspaceId&&view.runId===scope.runId;
  return {preview:!!allowed,start:!!allowed&&!!preview&&reviewPreviewMatches(preview,view!,scope)&&state.confirmed};
}
export function reviewRecoveryKey(record:ReviewRecord,workspaceId:string):string|null{
  return record.workspaceId===workspaceId&&record.execution!=='running'&&!record.processStopped&&!record.recoveredAt
    ?JSON.stringify([workspaceId,record.id,record.execution,record.processStopped,record.recoveredAt,record.sourceDigest,record.inputDigest]):null;
}
const statuses={running:'리뷰 응답 대기',completed:'리뷰 완료 · 검증 승인 아님',failed:'리뷰 실패',interrupted:'중단 결과',timed_out:'시간 초과 · 원격 결과 미확인',lost:'재시작·결과 미확인',stale:'소스 변경 · 현재 근거 아님'};
export interface ReviewPanelProps extends Scope {online:boolean;busy:boolean;post:(path:string,body:object)=>Promise<unknown>}
export function ReviewPanel(props:ReviewPanelProps){return <ScopedReview key={JSON.stringify([props.workspaceId,props.runId])} {...props}/>;}
function ScopedReview({workspaceId,runId,online,busy,post}:ReviewPanelProps){
  const [view,setView]=useState<ReviewView|null>(null),[preview,setPreview]=useState<ReviewPreview|null>(null),[loading,setLoading]=useState(false),[fresh,setFresh]=useState(false);
  const [action,setAction]=useState<'preview'|'start'|'interrupt'|'recover'|'repair-preview'|'repair-start'|null>(null),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [repair,setRepair]=useState<ReviewRepairPreview|null>(null),[repairConsent,setRepairConsent]=useState(false);
  const [consent,setConsent]=useState<string|null>(null),[recoveryConsent,setRecoveryConsent]=useState<string|null>(null);
  const order=useMemo(()=>createReviewRequestEpoch(),[]),postRef=useRef(post),viewRef=useRef<ReviewView|null>(null),previewRef=useRef<ReviewPreview|null>(null),actionRef=useRef<Token|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),reader=useRef<AbortController|null>(null),reload=useRef<(mode:ReadMode)=>Promise<void>>(async()=>{});postRef.current=post;
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{}return createStudioMutator((path,data)=>postRef.current(path,data),storage);},[]);
  const scope={workspaceId,runId},query=runId?'?runId='+encodeURIComponent(runId):'',path='/api/workspaces/'+encodeURIComponent(workspaceId)+'/reviews';
  const consentKey=preview?JSON.stringify([workspaceId,runId,preview.previewDigest,preview.inputDigest,preview.sourceDigest]):null;
  const confirmed=!!consentKey&&consent===consentKey,available=reviewAvailability(view,preview,scope,{online,busy:busy||!!action,loading,fresh,uncertain,confirmed});
  function discardPreview(){previewRef.current=null;setPreview(null);setConsent(null);setRepair(null);setRepairConsent(false);}
  const canRepair=online&&!busy&&!action&&fresh&&!loading&&!uncertain&&!!view&&!view.busy&&!view.recoveryRequired;
  useEffect(()=>{
    order.reset();viewRef.current=null;setView(null);setFresh(false);discardPreview();setRecoveryConsent(null);setUncertain(false);setError('');setMessage('');setAction(null);actionRef.current=null;setLoading(false);
    async function load(mode:ReadMode){
      if(!online||!workspaceId)return;const token=order.read();if(!token)return;if(timer.current)clearTimeout(timer.current);reader.current?.abort();const controller=new AbortController();reader.current=controller;setLoading(true);
      try{
        const response=await fetch(path+query,{signal:controller.signal});if(!response.ok)throw new Error();const result=await response.json() as ReviewView;
        if(!order.isCurrent(token))return;if(result.workspaceId!==workspaceId||result.runId!==runId||!Array.isArray(result.records))throw new Error();
        const previous=previewRef.current;
        if(previous){let valid=reviewPreviewMatches(previous,result,{workspaceId,runId})&&!result.busy&&!result.recoveryRequired;
          if(valid&&mode==='manual')try{const response=await fetch(path+'/preview'+query,{signal:controller.signal});if(!response.ok)throw new Error();const current=await response.json() as ReviewPreview;valid=reviewPreviewMatches(current,result,{workspaceId,runId})&&sameReviewPreview(previous,current);}catch{valid=false;}
          if(!order.isCurrent(token))return;if(!valid){discardPreview();setMessage('소스·입력·설정이 바뀌었거나 현재성을 확인할 수 없어 미리보기와 동의를 폐기했습니다. 새 미리보기를 확인하세요.');}
        }
        viewRef.current=result;setView(result);setFresh(true);
        if(acknowledgeReviewRead(mode,true)){setUncertain(false);setError('');setConsent(null);setRecoveryConsent(null);}
      }catch{if(order.isCurrent(token)&&!controller.signal.aborted){setFresh(false);discardPreview();setError('리뷰 상태의 현재성을 확인하지 못했습니다. 상태를 새로고침한 뒤 진행하세요.');}}
      finally{if(order.isCurrent(token)){setLoading(false);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>void load('poll'),viewRef.current?.records.some(record=>record.execution==='running')?1000:15000);}}
    }
    reload.current=load;if(online&&workspaceId)void load('poll');
    return()=>{order.dispose();reader.current?.abort();if(timer.current)clearTimeout(timer.current);reload.current=async()=>{};};
  },[workspaceId,runId,online,order,path,query]);
  async function act(kind:'preview'|'start'|'interrupt'|'recover'|'repair-preview'|'repair-start',record?:ReviewRecord){
    if(kind==='repair-preview'&&(!canRepair||!record||record.workspaceId!==workspaceId||record.execution!=='completed'))return;
    if(kind==='repair-start'&&(!canRepair||!repair||!repairConsent||!!repair.issue))return;
    if(kind==='preview'&&!available.preview||kind==='start'&&!available.start)return;
    if(kind==='interrupt'&&(!online||!record||record.workspaceId!==workspaceId||record.execution!=='running'))return;
    if(kind==='recover'&&(!online||busy||!fresh||loading||uncertain||view?.busy||!view?.recoveryRequired||!record||!reviewRecoveryKey(record,workspaceId)||recoveryConsent!==reviewRecoveryKey(record,workspaceId)))return;
    const token=order.beginAction();if(!token)return;actionRef.current=token;reader.current?.abort();if(timer.current)clearTimeout(timer.current);setAction(kind);setConsent(null);setRecoveryConsent(null);setError('');setMessage('');
    try{
      if(kind==='preview'){
        const controller=new AbortController();reader.current=controller;const response=await fetch(path+'/preview'+query,{signal:controller.signal});if(!response.ok)throw new Error();const value=await response.json() as ReviewPreview;
        if(!order.isCurrent(token))return;if(!viewRef.current||!reviewPreviewMatches(value,viewRef.current,{workspaceId,runId}))throw new Error();previewRef.current=value;setPreview(value);setMessage('전송할 정확한 리뷰 입력을 표시했습니다. 시작하려면 별도로 동의하세요.');
      }else if(kind==='start'){
        const input:Omit<StartReviewInput,'requestId'>={workspaceId,runId,expectedPreviewDigest:preview!.previewDigest,confirmed:true};const value=await mutate('/api/reviews/start',input) as ReviewRecord;
        if(!order.isCurrent(token))return;if(value.workspaceId!==workspaceId||value.runId!==runId)throw new Error();discardPreview();setMessage('Native Review 시작을 요청했습니다. 최종 결과와 프로세스 종료 여부는 기록에서 확인하세요.');
      }else if(kind==='repair-preview'){
        const controller=new AbortController();reader.current=controller;const response=await fetch(path+'/'+encodeURIComponent(record!.id)+'/repair-preview',{signal:controller.signal});if(!response.ok)throw new Error();const value=await response.json() as ReviewRepairPreview;
        if(!order.isCurrent(token))return;if(value.reviewId!==record!.id||value.workspaceId!==workspaceId||!digest(value.previewDigest))throw new Error();setRepair(value);setRepairConsent(false);setMessage(value.issue?'수정 실행을 시작할 수 없습니다: '+value.issue:'리뷰 지적과 수정 예산을 표시했습니다. 시작하려면 별도로 동의하세요.');
      }else if(kind==='repair-start'){
        const input:Omit<StartReviewRepairInput,'requestId'>={workspaceId,expectedPreviewDigest:repair!.previewDigest,confirmed:true};await mutate('/api/reviews/'+encodeURIComponent(repair!.reviewId)+'/repair',input);
        if(!order.isCurrent(token))return;discardPreview();setMessage('리뷰 지적 수정 Run을 요청했습니다. 결과는 Run 기록과 검증에서 확인하세요. 자동 재시도는 없습니다.');
      }else if(kind==='interrupt'){
        await postRef.current('/api/reviews/'+encodeURIComponent(record!.id)+'/interrupt',{workspaceId});if(!order.isCurrent(token))return;discardPreview();setMessage('리뷰 중단을 요청했습니다. 응답이나 화면 표시만으로 프로세스 종료를 단정하지 않습니다.');
      }else{
        await postRef.current('/api/reviews/recover',{reviewId:record!.id,confirmedStopped:true});if(!order.isCurrent(token))return;discardPreview();setMessage('프로세스 종료 확인을 전달했습니다. 이전 리뷰 결과를 완료로 바꾸거나 다시 실행하지 않습니다.');
      }
    }catch{if(order.sameScope(token)){discardPreview();if(kind!=='preview')setUncertain(true);setError('요청 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 리뷰 상태 새로고침 후 현재 기록을 확인하고 새로 동의하세요.');}}
    finally{if(order.endAction(token)&&actionRef.current===token){actionRef.current=null;setAction(null);setLoading(false);setFresh(false);await reload.current('after-action');}}
  }
  return <section className="surface review-panel" aria-label="Native Review" aria-busy={!!action||!!view?.busy}>
    <div className="section-heading"><h2>소스 기반 Native Review</h2><button disabled={!online||!workspaceId||loading||!!action} onClick={()=>void reload.current('manual')}>리뷰 상태 새로고침</button></div>
    <p>공식 Codex CLI의 별도 읽기 전용 텍스트 리뷰입니다. 기존 ChatGPT 구독을 사용하며 유료 API로 전환하지 않습니다. 자동 연결·시작·재시도·이어받기는 하지 않습니다.</p>
    <p>Model Hub 게이트웨이와 별도 경로입니다. 미리보기의 정제된 Diff 텍스트만 명시 전송하며 native CLI의 세션 보존·공급자 전송 정책이 적용됩니다. 파일 읽기·수정·도구 실행 권한을 주지 않습니다.</p>
    <p>1 turn · 60초 제한이며 구독 사용량·원격 완료·비용 상한을 보장하지 않습니다. 리뷰 완료는 테스트 통과·사용자 승인·병합이 아닙니다.</p>
    {!online&&<p>서버 연결 후 현재 소스와 리뷰 기록을 조회할 수 있습니다.</p>}{!workspaceId&&<p>작업 공간을 먼저 선택하세요.</p>}
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}{uncertain&&<p className="notice">이전 요청의 응답은 미확인입니다. 명시 리뷰 상태 새로고침이 성공하기 전에는 새 시작을 차단합니다. 자동 조회는 이 잠금을 해제하거나 요청을 재전송하지 않습니다.</p>}
    {view?.sourceIssue&&<p>소스 진단: <code>{view.sourceIssue}</code></p>}{view&&<p>{view.scope}</p>}{view?.recoveryRequired&&<p className="notice">종료가 확인되지 않은 리뷰가 있어 이 작업 공간은 격리 상태입니다. 현재 작업 공간의 이전 Run 기록도 확인하고 프로세스 종료를 직접 확인한 후 복구하세요.</p>}
    <p className="subtle">현재 source <code>{view?.sourceDigest??'unknown'}</code> · 조회 당시 값 · 자동 메타데이터 조회는 실행 중 1초, 그 외 15초이며 요청 처리 중 멈춥니다.</p>
    <button disabled={!available.preview} onClick={()=>void act('preview')}>Native Review 입력 미리보기</button>
    {preview&&<ReviewExecutionPreview preview={preview} confirmed={confirmed} canStart={available.start} onConsent={value=>setConsent(value?consentKey:null)} onStart={()=>void act('start')}/>}
    <ReviewHistory workspaceId={workspaceId} records={view?.records??[]} repairBudgets={view?.repairBudgets} repair={repair} repairConsent={repairConsent} canRepair={canRepair} onRepairPreview={record=>void act('repair-preview',record)} onRepairConsent={setRepairConsent} onRepairStart={()=>void act('repair-start')} sourceDigest={view?.sourceDigest??null} online={online} actionBusy={!!action} otherBusy={busy||!!view?.busy} fresh={fresh&&!loading} uncertain={uncertain} recoveryConsent={recoveryConsent}
      onInterrupt={record=>void act('interrupt',record)} onRecover={record=>void act('recover',record)} onRecoveryConsent={(record,value)=>setRecoveryConsent(value?reviewRecoveryKey(record,workspaceId):null)}/>
  </section>;
}
export function ReviewExecutionPreview({preview,confirmed,canStart,onConsent,onStart}:{preview:ReviewPreview;confirmed:boolean;canStart:boolean;onConsent:(value:boolean)=>void;onStart:()=>void}){
  return <section className="review-preview" aria-label="Native Review 전송 미리보기"><h3>조회 당시 정확한 전송 입력</h3><p>{preview.timeoutMs} ms · {preview.turnLimit} turn · 패치 {preview.patchBytes} bytes · 기준 <code>{preview.baseSha}</code></p>
    <p>source <code>{preview.sourceDigest}</code><br/>input <code>{preview.inputDigest}</code><br/>preview <code>{preview.previewDigest}</code></p><p>{preview.scope}</p>
    <ul>{preview.files.map(file=><li key={file.path}><code>{file.path}</code> · {file.status} · {file.bytes} bytes</li>)}</ul><pre className="review-instructions">{preview.instructions}</pre>
    <label className="review-consent"><input id="review-start-consent" type="checkbox" checked={confirmed} onChange={event=>onConsent(event.target.checked)}/>전송할 정확한 입력·파일·제한·native 보존 정책을 확인했고 별도 Native Review 시작에 동의합니다.</label>
    <button disabled={!canStart} onClick={()=>{if(canStart)onStart();}}>동의한 Native Review 시작</button>
  </section>;
}
interface HistoryProps {repairBudgets?:ReviewView['repairBudgets'];repair?:ReviewRepairPreview|null;repairConsent?:boolean;canRepair?:boolean;onRepairPreview?:(record:ReviewRecord)=>void;onRepairConsent?:(value:boolean)=>void;onRepairStart?:()=>void;
  workspaceId:string;records:ReviewRecord[];sourceDigest:string|null;online:boolean;actionBusy:boolean;otherBusy:boolean;fresh:boolean;uncertain:boolean;recoveryConsent:string|null;
  onInterrupt:(record:ReviewRecord)=>void;onRecover:(record:ReviewRecord)=>void;onRecoveryConsent:(record:ReviewRecord,value:boolean)=>void}
export function ReviewHistory(props:HistoryProps){
  const rows=props.records.filter(record=>record.workspaceId===props.workspaceId).slice(0,20);
  return <section className="review-history" aria-label="Native Review 기록"><h3>현재 작업 공간 리뷰 기록 · 미확정 우선 · 최대 20개</h3><p>이전 Run 기록을 포함합니다. 리뷰 완료는 테스트 검증·사용자 승인·병합이 아닙니다.</p>
    {!rows.length&&<p>저장된 리뷰가 없습니다. 상태 조회는 리뷰를 시작하지 않습니다.</p>}<ul className="record-list">{rows.map(record=>{
      const recoveryKey=reviewRecoveryKey(record,props.workspaceId),canRecover=props.online&&!props.actionBusy&&!props.otherBusy&&props.fresh&&!props.uncertain&&!!recoveryKey&&props.recoveryConsent===recoveryKey;
      const current=props.sourceDigest&&record.sourceDigest===props.sourceDigest&&record.finishedDigest===props.sourceDigest;
      return <li key={record.id}><div><b>{statuses[record.execution]}</b><p>리뷰 {record.id} · Run {record.runId??'없음'} · {record.createdAt} · 종료 {record.finishedAt??'unknown'}</p>
        <p>{!props.sourceDigest?'소스 현재성 미확인':current?'조회 당시 소스와 일치 · 검증 승인 아님':'현재 소스와 다름 · 현재 검증 근거 아님'} · 프로세스 {record.processStopped?'종료 확인됨':'종료 확인 불가'}</p>
        <p>source <code>{record.sourceDigest}</code> · 종료 source <code>{record.finishedDigest??'unknown'}</code> · {record.durationMs??'unknown'} ms · 제한 {record.timeoutMs} ms · {record.turnLimit} turn</p>
        {record.issue&&<p>진단 <code>{record.issue}</code></p>}<pre className="review-response">{record.response.slice(0,64000)||'반환된 리뷰 텍스트 없음'}</pre>{record.response.length>64000&&<p>표시 출력이 제한되었습니다.</p>}
        {record.execution==='completed'&&props.repairBudgets?.[record.id]&&<ReviewRepair record={record} budget={props.repairBudgets[record.id]} {...props}/>}
        {record.recoveredAt&&<p>사용자 프로세스 종료 확인 {record.recoveredAt} · 이전 결과는 그대로 보존하며 재실행하지 않았습니다.</p>}
        {recoveryKey&&<div className="review-recovery"><p>실행 결과와 별개로 프로세스 종료를 확인할 수 없어 격리 상태입니다. 이전 프로세스가 실제 종료되었는지 직접 확인하세요.</p><label className="review-consent"><input type="checkbox" aria-label={'리뷰 프로세스 종료 확인 '+record.id} checked={props.recoveryConsent===recoveryKey} disabled={!props.online||props.actionBusy||props.otherBusy||!props.fresh||props.uncertain} onChange={event=>props.onRecoveryConsent(record,event.target.checked)}/>이전 Native Review 프로세스가 종료되었음을 확인</label><button disabled={!canRecover} onClick={()=>props.onRecover(record)}>종료 확인 후 리뷰 복구</button></div>}
      </div>{record.execution==='running'&&<button disabled={!props.online||props.actionBusy} onClick={()=>props.onInterrupt(record)}>Native Review 중단</button>}</li>;
    })}</ul>
  </section>;
}

/** Explicit, user-initiated hand-off of one review's full text to the existing repair run. Never automatic; disabled when the per-task budget is used. */
function ReviewRepair({record,budget,repair,repairConsent,canRepair,onRepairPreview,onRepairConsent,onRepairStart}:HistoryProps&{record:ReviewRecord;budget:{used:number;max:number}}){
  const exhausted=budget.used>=budget.max,shown=repair?.reviewId===record.id?repair:null;
  return <div className="review-repair"><p>수정 예산 {budget.used}/{budget.max}{exhausted&&' · 소진됨 (REVIEW_REPAIR_BUDGET_EXHAUSTED)'}</p>
    <button aria-label={'리뷰 지적 수정 실행 미리보기 '+record.id} disabled={!canRepair||exhausted||!record.runId} onClick={()=>onRepairPreview?.(record)}>리뷰 지적으로 수정 실행 미리보기</button>
    {shown&&<div aria-label="리뷰 지적 수정 전송 미리보기"><p>{shown.scope}</p><p>리뷰 지적 {shown.promptChars}/{shown.maxPromptChars}자 · 파일 {shown.findings.files.join(', ')||'없음'}</p>{shown.issue&&<p role="alert">진단 <code>{shown.issue}</code></p>}
      <label className="review-consent"><input type="checkbox" aria-label={'리뷰 지적 수정 전송 동의 '+record.id} checked={!!repairConsent} disabled={!!shown.issue} onChange={event=>onRepairConsent?.(event.target.checked)}/>리뷰 텍스트 전체가 수정 Run 지시문으로 Codex에 전송됨을 확인했고 수정 1회 사용에 동의합니다.</label>
      <button aria-label={'리뷰 지적 수정 실행 시작 '+record.id} disabled={!canRepair||!repairConsent||!!shown.issue} onClick={()=>onRepairStart?.()}>동의한 리뷰 지적 수정 실행</button></div>}
  </div>;
}
