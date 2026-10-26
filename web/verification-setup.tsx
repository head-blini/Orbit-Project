import {useEffect,useRef,useState} from 'react';
import type {ConfigureVerificationInput,VerificationSetupReceipt,VerificationSetupView} from '../shared/verification-setup.ts';
import type {VerificationCommandPreview} from '../shared/verification.ts';

type Props={workspaceId:string;online:boolean;busy:boolean;post:(path:string,body:object)=>Promise<unknown>;onConfigured:()=>void};
type PendingRecord={input:ConfigureVerificationInput;projectId:string;targetRevision:number};
type Pending={record:PendingRecord|null;issue:string};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const storageIssue='브라우저의 등록 요청 기록을 확인하거나 보존할 수 없습니다. 이 사이트의 세션 저장소 설정과 현재 검증 설정을 확인하세요.';
function readPending(key:string):Pending{
  try{
    const raw=sessionStorage.getItem(key);if(!raw)return {record:null,issue:''};
    const record=JSON.parse(raw) as PendingRecord,value=record?.input;
    if(!record||Object.keys(record).sort().join(',')!=='input,projectId,targetRevision'||!uuid(record.projectId)||!Number.isSafeInteger(record.targetRevision)||record.targetRevision<1
      ||!value||Object.keys(value).sort().join(',')!=='confirmed,expectedPreviewDigest,profileId,requestId'||!uuid(value.requestId)||value.profileId!=='node-test-v1'||!digest(value.expectedPreviewDigest)||value.confirmed!==true)throw Error();
    return {record,issue:''};
  }catch{return {record:null,issue:storageIssue};}
}
const sameRequest=(left:PendingRecord|null,right:PendingRecord)=>!!left&&left.projectId===right.projectId&&left.targetRevision===right.targetRevision&&left.input.requestId===right.input.requestId&&left.input.profileId===right.input.profileId&&left.input.expectedPreviewDigest===right.input.expectedPreviewDigest&&left.input.confirmed===right.input.confirmed;
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
function commandValid(value:VerificationCommandPreview){return !!value&&typeof value.id==='string'&&typeof value.label==='string'&&typeof value.executable==='string'&&strings(value.args)&&Number.isFinite(value.timeoutMs)&&digest(value.configDigest)&&(value.protectedFiles===undefined||strings(value.protectedFiles));}
function viewValid(value:VerificationSetupView,workspaceId:string){
  return !!value&&value.workspaceId===workspaceId&&uuid(value.projectId)&&Number.isSafeInteger(value.revision)&&value.revision>=0
    &&(value.lastRequestId===null||(typeof value.lastRequestId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.lastRequestId)))&&['none','host','preset'].includes(value.source)&&typeof value.scope==='string'
    &&[null,'NO_NODE_TEST_FILES','HOST_CONFIGURATION','SOURCE_UNAVAILABLE','TOO_MANY_TEST_FILES'].includes(value.issue)
    &&Array.isArray(value.commands)&&value.commands.every(commandValid)
    &&(value.candidate===null||(value.source!=='host'&&value.issue===null&&value.candidate?.profileId==='node-test-v1'
      &&typeof value.candidate.label==='string'&&digest(value.candidate.sourceDigest)&&typeof value.candidate.baseSha==='string'
      &&strings(value.candidate.tests)&&value.candidate.tests.length>0&&digest(value.candidate.previewDigest)&&commandValid(value.candidate.command)));
}
const messages:Record<string,string>={
  INVALID_FIELDS:'등록 입력을 확인할 수 없습니다. 검증 설정을 다시 확인하고 새로 동의하세요.',
  VERIFICATION_SETUP_PREVIEW_STALE:'소스 또는 검증 설정이 변경되었습니다. 검증 설정을 다시 확인하고 새로 동의하세요.',
  VERIFICATION_SETUP_UNAVAILABLE:'이 작업 공간에서 검증 설정을 준비할 수 없습니다. 프로젝트와 작업 공간의 쓰기 상태를 확인하세요.',
  VERIFICATION_SETUP_CORRUPT:'저장된 검증 설정이 손상되어 등록을 차단했습니다. 서버의 설정 복구가 필요합니다.',
  VERIFICATION_SETUP_CONFIRMATION_REQUIRED:'검증 명령 등록에는 표시된 명령과 보호 파일에 대한 명시적 동의가 필요합니다. 설정을 다시 확인하세요.',
  VERIFICATION_SETUP_QUOTA:'이 프로젝트의 검증 설정 등록 한도에 도달했습니다. 서버의 기존 설정과 등록 기록을 확인하세요.',
  HOST_CONFIGURATION:'호스트 검증 설정을 사용 중입니다. 웹에서 프리셋으로 덮어쓸 수 없습니다.',
  IDEMPOTENCY_CONFLICT:'저장된 요청 ID와 등록 내용이 충돌합니다. 새 요청을 만들지 말고 기존 설정과 요청 기록을 확인하세요.',
  WORKSPACE_MISMATCH:'선택한 작업 공간이 변경되었습니다. 현재 작업 공간을 확인하세요.',
  RUN_ACTIVE:'실행 중인 작업이 끝난 뒤 검증 설정을 다시 확인하세요.',
  SOLO_RECOVERY_REQUIRED:'종료를 확인하지 못한 실행이 있습니다. 기존 실행의 복구 상태를 먼저 확인하세요.',
};
function CommandDetails({command}:{command:VerificationCommandPreview}){
  return <div><b>{command.label}</b><pre>{JSON.stringify([command.executable,...command.args])}</pre>
    <p>제한 {command.timeoutMs/1000}초 · 명령 설정 <code>{command.configDigest.slice(0,16)}</code></p>
    <p>보호 파일</p>{command.protectedFiles?.length?<ul>{command.protectedFiles.map(file=><li key={file}><code>{file}</code></li>)}</ul>:<p>등록된 보호 파일 없음</p>}
  </div>;
}

export function VerificationSetupPanel(props:Props){
  const {workspaceId,online,busy}=props,key='orbit.verification.setup.pending.'+workspaceId;
  const [stored,setStored]=useState(()=>({key,...readPending(key)})),[loaded,setLoaded]=useState<{version:number;value:VerificationSetupView}|null>(null);
  const [consent,setConsent]=useState<{version:number;digest:string}|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[saving,setSaving]=useState(false),[refresh,setRefresh]=useState(0);
  const alive=useRef(true),sending=useRef(false),latest=useRef(props),pendingRef=useRef(stored);
  const scope=useRef({workspaceId,online,busy,version:0});
  if(scope.current.workspaceId!==workspaceId||scope.current.online!==online||scope.current.busy!==busy)scope.current={workspaceId,online,busy,version:scope.current.version+1};
  latest.current=props;pendingRef.current=stored;
  const version=scope.current.version,view=loaded?.version===version?loaded.value:null,pending=stored.key===key?stored.record:null;
  const storageError=stored.key===key?stored.issue:'';
  function current(ticket:number){return alive.current&&scope.current.version===ticket&&latest.current.online;}
  function rememberState(value:Pending){const next={key,...value};pendingRef.current=next;setStored(next);}
  function forget(record:PendingRecord){
    const existing=readPending(key);if(existing.issue||!sameRequest(existing.record,record))throw Error('STORAGE_CHANGED');
    sessionStorage.removeItem(key);rememberState({record:null,issue:''});
  }
  function reload(){
    if(!alive.current||!latest.current.online||sending.current)return;
    scope.current.version++;setConsent(null);setLoaded(null);setRefresh(value=>value+1);
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;scope.current.version++;};},[]);
  useEffect(()=>{rememberState(readPending(key));},[key]);
  useEffect(()=>{
    const ticket=scope.current.version;let disposed=false;
    setLoaded(null);setConsent(null);setMessage('');
    if(!online)return;
    void (async()=>{
      try{
        const response=await fetch('/api/workspaces/'+encodeURIComponent(workspaceId)+'/verification-setup');
        if(!response.ok){const body=await response.json();throw Error(typeof body?.error==='string'?body.error:'LOAD_FAILED');}
        const value=await response.json() as VerificationSetupView;
        if(disposed||!current(ticket))return;
        if(!viewValid(value,workspaceId))throw Error('VIEW_MISMATCH');
        setLoaded({version:ticket,value});setError('');
        const previous=readPending(key);rememberState(previous);
        if(previous.record&&value.projectId===previous.record.projectId&&value.lastRequestId===previous.record.input.requestId&&value.revision===previous.record.targetRevision&&!latest.current.busy){
          try{forget(previous.record);}catch{setError(storageIssue);return;}
          setMessage('검증 명령 등록이 확인되었습니다. 실제 실행은 별도로 승인하세요.');latest.current.onConfigured();
        }
      }catch(cause){if(!disposed&&current(ticket)){const code=cause instanceof Error?cause.message:'';setError(messages[code]??'검증 설정을 불러오지 못했습니다. 연결과 현재 작업 공간을 확인한 뒤 다시 확인하세요.');}}
    })();
    return()=>{disposed=true;};
  },[workspaceId,online,busy,refresh,key]);

  async function submit(retry=false){
    const ticket=version;
    if(!current(ticket)||sending.current||latest.current.busy||!view||storageError)return;
    const previous=readPending(key);
    if(previous.issue){rememberState(previous);setError(previous.issue);return;}
    let record:PendingRecord;
    if(retry){if(!pending||!sameRequest(previous.record,pending)||pending.projectId!==view.projectId)return;record=pending;}
    else{
      if(previous.record||pendingRef.current.record||view.source==='host'||!view.candidate||consent?.version!==ticket||consent.digest!==view.candidate.previewDigest)return;
      record={projectId:view.projectId,targetRevision:view.revision+1,input:{requestId:crypto.randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:view.candidate.previewDigest,confirmed:true}};
    }
    const input=record.input;
    sending.current=true;setSaving(true);setError('');setMessage('');
    try{
      try{sessionStorage.setItem(key,JSON.stringify(record));rememberState({record,issue:''});}catch{setError(storageIssue);return;}
      try{
        const receipt=await latest.current.post('/api/workspaces/'+encodeURIComponent(workspaceId)+'/verification-setup',input) as VerificationSetupReceipt;
        if(!current(ticket)||latest.current.busy)return;
        if(!receipt||receipt.workspaceId!==workspaceId||receipt.projectId!==record.projectId||receipt.requestId!==input.requestId||receipt.profileId!=='node-test-v1'||receipt.revision!==record.targetRevision||typeof receipt.createdAt!=='string')throw Error('UNCERTAIN_RESPONSE');
        try{forget(record);}catch{setError(storageIssue);return;}
        setConsent(null);setLoaded(null);scope.current.version++;setRefresh(value=>value+1);latest.current.onConfigured();
      }catch(cause){
        if(!current(ticket)||latest.current.busy)return;
        const code=cause instanceof Error?cause.message:'';
        if(['INVALID_FIELDS','VERIFICATION_SETUP_PREVIEW_STALE','HOST_CONFIGURATION'].includes(code)){
          try{forget(record);}catch{setError(storageIssue);return;}
          setConsent(null);setLoaded(null);
        }
        setError(messages[code]??'등록 결과를 확인하지 못했습니다. 저장된 동일 요청으로 다시 확인하거나 검증 설정을 다시 불러오세요.');
      }
    }finally{sending.current=false;if(alive.current)setSaving(false);}
  }
  const disabled=!online||busy||saving||!!storageError,accepted=!!view?.candidate&&consent?.version===version&&consent.digest===view.candidate.previewDigest;
  return <section aria-label="검증 명령 설정">
    <div className="section-heading"><h3>검증 명령 준비</h3><button disabled={!online||saving} onClick={reload}>검증 설정 다시 확인</button></div>
    <p>등록은 명령을 저장하며 테스트를 실행하지 않습니다. 실제 실행은 아래 검증 또는 Workflow에서 별도로 승인합니다.</p>
    <p className="notice">테스트 실행은 <b>Codex sandbox 밖의 로컬 OS 사용자 권한</b>으로 프로젝트 코드를 실행합니다. 테스트 통과는 해당 검사 결과이며 모든 요구사항 충족이나 테스트 품질을 보장하지 않습니다.</p>
    {error&&<p role="alert">{error}</p>}{storageError&&<p role="alert">{storageError}</p>}{message&&<p role="status">{message}</p>}
    {busy&&<p role="status">진행 중인 작업이 끝난 뒤 검증 명령을 등록할 수 있습니다.</p>}
    {!view?<p role="status">{online?(error?'검증 설정 다시 확인이 필요합니다.':'검증 설정 확인 중…'):'서버 연결이 필요합니다.'}</p>:<>
      <p>현재 설정: <b>{{none:'없음',host:'호스트 설정',preset:'저장된 프리셋'}[view.source]}</b> · revision {view.revision}</p>
      <p className="subtle">{view.scope}</p>
      {view.commands.length>0&&<details><summary>현재 검증 명령과 보호 파일</summary>{view.commands.map(command=><CommandDetails key={command.id} command={command}/>)}</details>}
      {view.source==='host'||view.issue==='HOST_CONFIGURATION'?<p>호스트 설정이 우선하며 웹에서 프리셋으로 덮어쓸 수 없습니다. 변경하려면 서버의 고급 검증 설정을 확인하세요.</p>:view.issue==='NO_NODE_TEST_FILES'?<p>등록할 Node 테스트가 없습니다. *.test.js, *.test.mjs, *.test.cjs 작성 후 다시 확인하세요. 테스트 파일이 없으면 검증 성공을 만들지 않습니다.</p>:view.issue==='TOO_MANY_TEST_FILES'?<p>테스트 파일이 지원 범위를 초과했습니다. 호스트의 고급 검증 설정을 사용하거나 테스트 구성을 정리한 뒤 다시 확인하세요.</p>:view.issue==='SOURCE_UNAVAILABLE'?<p>현재 소스와 테스트 파일을 확인할 수 없어 등록을 차단했습니다. 작업 공간의 소스 상태를 확인하세요.</p>:null}
      {view.candidate&&<form onSubmit={event=>{event.preventDefault();void submit();}}>
        <h4>{view.candidate.label}</h4>
        <p>현재 소스 <code>{view.candidate.sourceDigest.slice(0,16)}</code> · 기준 커밋 <code>{view.candidate.baseSha.slice(0,12)}</code></p>
        <p>발견한 테스트 파일 {view.candidate.tests.length}개</p><ul>{view.candidate.tests.map(file=><li key={file}><code>{file}</code></li>)}</ul>
        <CommandDetails command={view.candidate.command}/>
        <p>이 파일 목록을 고정해 등록합니다. 나중에 추가한 테스트는 다시 확인하고 등록해야 포함됩니다.</p>
        <label><input type="checkbox" checked={accepted} disabled={disabled||!!pending} onChange={event=>{if(current(version)&&!latest.current.busy&&!sending.current&&!pending)setConsent(event.target.checked?{version,digest:view.candidate!.previewDigest}:null);}}/> 표시된 명령·테스트·보호 파일을 확인했고 검증 명령 등록에 동의합니다.</label>
        <button className="primary" disabled={disabled||!!pending||!accepted}>검증 명령 등록</button>
      </form>}
    </>}
    {pending&&<div><p role="status">확인할 등록 요청이 저장돼 있습니다. 요청 <code>{pending.input.requestId.slice(0,8)}</code> · 기존 요청 내용으로만 다시 확인합니다.</p><button disabled={disabled||!view} onClick={()=>void submit(true)}>같은 등록 요청으로 다시 확인</button></div>}
  </section>;
}
