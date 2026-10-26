import {useEffect,useRef,useState} from 'react';
import type {DevelopmentResultView} from '../shared/development-results.ts';
import type {AppPreview,AppPreviewCatalog} from '../shared/app-preview.ts';

export function previewOriginMatches(url:string,allowedOrigin:string){
  try{return /^http:\/\/127\.0\.0\.1:\d+$/.test(allowedOrigin)&&new URL(url).origin===allowedOrigin;}catch{return false;}
}

const messages:Record<string,string>={APP_PREVIEW_STALE:'파일이 바뀌었습니다. 최신 파일로 다시 열어 주세요.',APP_PREVIEW_ENTRY:'선택한 HTML 파일을 열 수 없습니다.',APP_PREVIEW_LIMIT:'미리보기 한도(256개 파일, 합계 8 MiB, HTML 1 MiB)를 넘었습니다.',APP_PREVIEW_QUOTA:'열려 있는 미리보기가 많습니다. 최대 10분 뒤 다시 시도해 주세요.',APP_PREVIEW_UNAVAILABLE:'미리보기 서버를 사용할 수 없습니다. Orbit을 다시 시작해 주세요.',WORKSPACE_SNAPSHOT_UNAVAILABLE:'파일을 안전하게 읽을 수 없습니다. 민감 파일·링크·파일 크기와 작업 공간 상태를 확인해 주세요.',WORKSPACE_MISMATCH:'현재 선택한 작업 공간에서 다시 열어 주세요.',SOLO_RECOVERY_REQUIRED:'종료가 확인되지 않은 실행이 있습니다. 복구 상태를 확인해 주세요.'};
export function AppPreviewFrame({preview}:{preview:AppPreview}){
  return <iframe className="app-preview-frame" title="생성된 웹앱 미리보기" src={preview.url} sandbox="allow-scripts" referrerPolicy="no-referrer"/>;
}
export function AppPreviewPanel({workspaceId,online,locked,refreshKey,post,evidence=null}:{workspaceId:string;online:boolean;locked:boolean;refreshKey:string;post:(path:string,body:object)=>Promise<unknown>;evidence?:DevelopmentResultView|null}){
  const [catalog,setCatalog]=useState<AppPreviewCatalog|null>(null),[entry,setEntry]=useState(''),[preview,setPreview]=useState<AppPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[expired,setExpired]=useState(false);
  const [allowedOrigin]=useState(()=>typeof document==='undefined'?'':document.querySelector('meta[name="orbit-preview-origin"]')?.getAttribute('content')??'');
  const [reloadRequired,setReloadRequired]=useState(false);
  const generation=useRef(0),catalogGeneration=useRef(0),sending=useRef(false),refreshPending=useRef(false),mounted=useRef(true),refreshLatest=useRef<()=>void>(()=>{}),base='/api/workspaces/'+workspaceId+'/app-preview';
  const failure=(error:unknown)=>messages[(error as Error).message]??'미리보기를 열지 못했습니다. 서버 연결과 현재 작업 상태를 확인한 뒤 다시 시도해 주세요.';
  async function read(){const response=await fetch(base);const value=await response.json();if(!response.ok)throw new Error(value.error);return value as AppPreviewCatalog;}
  async function load(){
    const ticket=++catalogGeneration.current,owner=generation.current;const current=()=>mounted.current&&ticket===catalogGeneration.current&&owner===generation.current;setBusy(true);setError('');
    try{const value=await read();if(current()){setCatalog(value);setEntry(old=>value.entries.includes(old)?old:value.entries[0]??'');}}
    catch(error){if(current()){setCatalog(null);setError(failure(error));}}
    finally{if(current()&&!sending.current)setBusy(false);}
  }
  refreshLatest.current=()=>{if(mounted.current&&online&&!locked)void load();};
  useEffect(()=>{mounted.current=true;setPreview(null);setCatalog(null);setEntry('');setError('');if(online&&!locked)void load();else setBusy(false);return()=>{mounted.current=false;generation.current++;catalogGeneration.current++;};},[workspaceId,online]);
  useEffect(()=>{
    if(locked){generation.current++;catalogGeneration.current++;setPreview(null);setCatalog(null);setBusy(false);return;}
    if(online&&refreshKey){if(sending.current)refreshPending.current=true;else void load();}
  },[refreshKey,locked]);
  useEffect(()=>{setExpired(false);if(!preview)return;const timer=setTimeout(()=>setExpired(true),Math.max(0,Date.parse(preview.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[preview]);
  async function open(){
    if(sending.current||!online||locked||!entry)return;
    sending.current=true;refreshPending.current=false;catalogGeneration.current++;const ticket=++generation.current;setBusy(true);setError('');setPreview(null);
    try{const current=await read();if(ticket!==generation.current)return;setCatalog(current);
      if(!current.entries.includes(entry))throw new Error('APP_PREVIEW_ENTRY');
      const next=await post(base,{entryPath:entry,expectedSourceDigest:current.sourceDigest}) as AppPreview;
      if(ticket===generation.current&&!previewOriginMatches(next.url,allowedOrigin)){setReloadRequired(true);throw new Error('APP_PREVIEW_RELOAD_REQUIRED');}
      if(ticket===generation.current){setPreview(next);setCatalog(null);refreshPending.current=false;await load();}
    }catch(error){if(ticket===generation.current){setPreview(null);setError(failure(error));}}
    finally{sending.current=false;if(mounted.current&&ticket===generation.current)setBusy(false);if(refreshPending.current){refreshPending.current=false;refreshLatest.current();}}
  }
  const stale=!!preview&&catalog?.sourceDigest!==preview.sourceDigest;
  return <section className="surface app-preview-panel" aria-busy={busy}>
    <div className="section-heading"><h2>결과 미리보기</h2><button disabled={!online||busy} onClick={()=>void load()}>파일 상태 확인</button></div>
    <p>작업 공간의 HTML과 상대 경로의 CSS·JavaScript를 실행합니다. 표시 시점의 파일 사본이며, 테스트 통과 여부는 아래 검증 결과에서 확인하세요.</p>
    <details><summary>지원 범위와 제한</summary><p>빌드·개발 서버·백엔드는 실행하지 않습니다. Git에서 제외한 dist·node_modules, TSX, /로 시작하거나 ?가 붙은 자산 경로와 여러 HTML 사이의 이동은 지원하지 않습니다. API 통신·브라우저 저장소·팝업·파일 다운로드가 제한됩니다. 화면의 새로고침은 입력한 내용을 초기화합니다.</p><p>현재 브라우저의 격리 기능을 사용합니다. 미리보기 안에 비밀정보를 입력하거나 개인 파일을 선택하지 마세요. 최대 10분 동안 유지되며 작업 공간 변경·Orbit 재시작 시 폐기됩니다.</p></details>
    {!online&&<p role="status">서버 연결 후 미리보기를 열 수 있습니다.</p>}
    {reloadRequired?<p role="alert">Orbit 재시작으로 미리보기 주소가 바뀌었습니다. 다른 화면의 작성 내용을 저장한 뒤 화면을 다시 불러와 주세요. <button onClick={()=>window.location.reload()}>Orbit 화면 다시 불러오기</button></p>:error&&<p role="alert">{error}</p>}
    {online&&catalog?.entries.length===0&&<p className="hint">정적 HTML 결과가 없습니다. HTML 결과물을 만들거나, 빌드가 필요한 프로젝트인지 확인해 주세요.</p>}
    <div className="app-preview-controls"><label>미리볼 HTML<select aria-label="미리볼 HTML" disabled={!online||busy||!catalog?.entries.length} value={entry} onChange={event=>{setEntry(event.target.value);setPreview(null);}}><option value="" disabled>HTML 파일 선택</option>{catalog?.entries.map(path=><option key={path} value={path}>{path}</option>)}</select></label>
      <button className="primary" disabled={!online||locked||busy||!entry} onClick={()=>void open()}>{busy?'파일 확인 중…':preview?'최신 파일로 다시 열기':'미리보기 열기'}</button>{preview&&<button onClick={()=>{generation.current++;setBusy(false);setPreview(null);}}>미리보기 닫기</button>}</div>
    {preview&&<><PreviewVerificationEvidence preview={preview} evidence={evidence}/><p className="subtle">{preview.entryPath} · {new Date(preview.createdAt).toLocaleString('ko-KR')} · 소스 {preview.sourceDigest.slice(0,12)} · {preview.fileCount}개 파일</p>
      {locked?<p role="status">작업이 진행 중이거나 복구 확인이 필요합니다. 작업 상태가 확인되면 최신 파일로 다시 열어 주세요.</p>:expired?<p role="status">미리보기가 만료되었습니다. 최신 파일로 다시 열어 주세요.</p>:stale?<p role="status">소스가 변경됐거나 현재 상태를 확인할 수 없습니다. 최신 파일로 다시 열어 주세요.</p>:<AppPreviewFrame key={preview.id} preview={preview}/>}</>}
  </section>;
}

export function PreviewVerificationEvidence({preview,evidence}:{preview:Pick<AppPreview,'workspaceId'|'sourceDigest'>;evidence:DevelopmentResultView|null}){
  const matches=!!evidence?.run&&evidence.workspaceId===preview.workspaceId&&evidence.sourceDigest===preview.sourceDigest;
  return <p className="subtle" role="status">{!evidence?.run?'선택 실행의 검증 근거가 없습니다.':!matches?'미리보기와 검증 조회의 소스가 다르거나 확인되지 않았습니다. 결과 상태를 새로 확인하세요.':evidence.verification?.available&&evidence.verification.canApprove&&!evidence.verification.quarantined?'이 미리보기와 같은 소스에서 등록된 검증 명령이 모두 통과했습니다.':'같은 소스의 조회 기록입니다. 검증 통과 여부는 위 실행 결과에서 확인하세요.'}</p>;
}
