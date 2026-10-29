import React,{useEffect,useRef,useState} from 'react';
import type {CreatedProject} from '../shared/project-creation.ts';

type Kind='code'|'general';
// workspaceId is null for a general project: it has no Git repository or worktree.
type Receipt={requestId:string;name:string;kind:Kind;result:{projectId:string;workspaceId:string|null}|null;selected:boolean};
type Props={projectId:string;projectCount:number;selectedWorkspaceId:string|null;online:boolean;locked:boolean;onProject:(id:string)=>void;onPlanning?:()=>void;action:(fn:()=>Promise<void>)=>Promise<void>;post:(path:string,body:object)=>Promise<any>};
const storageKey='orbit.project.creation';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const nameIssue='프로젝트 이름은 1~80자의 일반 이름으로 입력하세요. 경로, 명령, 비밀번호나 API 키는 넣지 마세요.';
function validName(name:string){return !!name&&name.length<=80&&!/[\x00-\x1f\x7f/\\<>:=`$|;&]/.test(name)&&!name.startsWith('-')&&name!=='.'&&name!=='..'&&!/\b(?:password|passwd|secret|token|api[-_ ]?key|authorization|credentials?)\b|\b(?:sk-|gh[opusr]_|github_pat_|AIza|xox[baprs]-)/i.test(name);}
function readReceipt():{receipt:Receipt|null;issue:string}{
  try{
    const raw=sessionStorage.getItem(storageKey);if(!raw)return {receipt:null,issue:''};
    const value=JSON.parse(raw) as Receipt;
    if(value&&value.kind===undefined)value.kind='code';
    if(!value||!uuid(value.requestId)||typeof value.name!=='string'||!validName(value.name)||typeof value.selected!=='boolean'||(value.kind!=='code'&&value.kind!=='general')
      ||(value.result!==null&&(!value.result||!uuid(value.result.projectId)||(value.kind==='general'?value.result.workspaceId!==null:!uuid(value.result.workspaceId))))||(!value.result&&value.selected))throw new Error();
    return {receipt:value,issue:''};
  }catch{return {receipt:null,issue:'저장된 프로젝트 생성 기록을 확인할 수 없어 새 요청을 보내지 않습니다. 이 사이트의 세션 저장소 설정과 기존 프로젝트를 확인하세요.'};}
}
const messages:Record<string,string>={
  INVALID_FIELDS:nameIssue,
  PROJECT_CREATION_UNAVAILABLE:'현재 서버에서 새 프로젝트를 준비할 수 없습니다. 서버 설정과 기존 프로젝트를 확인하세요.',
  PROJECT_CREATION_INCOMPLETE:'프로젝트 준비가 중간에 멈췄습니다. 생성 기록과 파일은 보존돼 있습니다. 새로 만들지 말고 서버의 복구 상태를 확인하세요.',
  IDEMPOTENCY_CONFLICT:'저장된 요청과 프로젝트 이름이 일치하지 않습니다. 새로 만들지 말고 기존 생성 기록을 확인하세요.',
  RUN_ACTIVE:'다른 실행이 끝난 뒤 다시 시도하세요.',
  SOLO_RECOVERY_REQUIRED:'종료를 확인하지 못한 실행이 있습니다. 기존 실행의 복구 상태를 먼저 확인하세요.',
};

export function ProjectCreatePanel(props:Props){
  const {projectId,selectedWorkspaceId,online,locked,onPlanning}=props;
  const [initial]=useState(readReceipt),[receipt,setReceipt]=useState<Receipt|null>(initial.receipt),[name,setName]=useState(initial.receipt?.name??'');
  const [issue,setIssue]=useState(initial.issue),[busy,setBusy]=useState(false),[kind,setKind]=useState<Kind>(initial.receipt?.kind??'code');
  const sending=useRef(false),alive=useRef(true),stored=useRef(receipt),latest=useRef(props);
  const scope=useRef({projectId,selectedWorkspaceId,online,version:0});
  if(scope.current.projectId!==projectId||scope.current.selectedWorkspaceId!==selectedWorkspaceId||scope.current.online!==online)scope.current={projectId,selectedWorkspaceId,online,version:scope.current.version+1};
  latest.current=props;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);

  function remember(next:Receipt){
    // Persist before dispatch and before selection. An uncertain request always
    // retains the same name and ID, including after this panel is unmounted.
    const current=readReceipt();
    if(current.issue||(!stored.current&&current.receipt)||(stored.current&&(!current.receipt||current.receipt.requestId!==next.requestId||current.receipt.name!==next.name)))throw new Error('RECEIPT_CHANGED');
    if(current.receipt?.result){
      if(next.result&&(next.result.projectId!==current.receipt.result.projectId||next.result.workspaceId!==current.receipt.result.workspaceId))throw new Error('RECEIPT_CHANGED');
      next={...next,result:current.receipt.result,selected:next.selected||current.receipt.selected};
    }
    sessionStorage.setItem(storageKey,JSON.stringify(next));stored.current=next;
    if(alive.current){setReceipt(next);setName(next.name);}
  }
  function forget(record:Receipt,completed:boolean){
    const current=readReceipt();
    if(current.issue||!current.receipt||current.receipt.requestId!==record.requestId||current.receipt.name!==record.name||current.receipt.selected!==completed||!!current.receipt.result!==completed)throw new Error('RECEIPT_CHANGED');
    sessionStorage.removeItem(storageKey);stored.current=null;if(alive.current)setReceipt(null);
  }
  function show(message:string){if(alive.current)setIssue(message);}
  async function prepare(){
    if(sending.current||latest.current.locked||!latest.current.online||initial.issue||!alive.current)return;
    const version=scope.current.version,startingProject=latest.current.projectId,startingWorkspace=latest.current.selectedWorkspaceId;
    let record=stored.current;
    const firstProject=startingProject===''&&startingWorkspace===null&&latest.current.projectCount===0&&!record?.result;
    if(!record){const trimmed=name.trim();if(!validName(trimmed)){show(nameIssue);return;}record={requestId:crypto.randomUUID(),name:trimmed,kind,result:null,selected:false};}
    sending.current=true;setBusy(true);setIssue('');
    try{
      try{remember(record);}catch{show('브라우저가 생성 요청을 보존하지 못해 요청을 보내지 않았습니다. 이 사이트의 세션 저장소 설정을 확인하세요.');return;}
      await props.action(async()=>{
        try{
          if(!record!.result){
            const general=record!.kind==='general';
            const result=await props.post('/api/projects/create',{requestId:record!.requestId,name:record!.name,...(general?{kind:'general'}:{})}) as CreatedProject;
            if(!result||!uuid(result.project?.id))throw new Error('UNCERTAIN_RESPONSE');
            if(general?result.project.kind!=='general'||result.workspace!==null:!result.workspace||!uuid(result.workspace.id)||result.workspace.projectId!==result.project.id||result.workspace.status!=='ready')throw new Error('UNCERTAIN_RESPONSE');
            record={...record!,result:{projectId:result.project.id,workspaceId:result.workspace?.id??null}};
            remember(record);
          }
          // action() itself sets locked. Scope and connectivity, rather than that
          // self-owned busy flag, decide whether the next mutation is still wanted.
          const result=record!.result!;
          // resolveProject adopts the first catalog entry when saveProject's SSE
          // arrives before this response. Allow exactly that one transition; even
          // a temporary different selection or disconnect revokes this exception.
          const firstFallback=firstProject&&scope.current.version===version+1&&latest.current.projectCount===1
            &&scope.current.projectId===result.projectId&&scope.current.selectedWorkspaceId===null;
          if(!alive.current||(scope.current.version!==version&&!firstFallback)||!latest.current.online){show('프로젝트는 준비됐습니다. 연결과 선택한 프로젝트를 확인한 뒤 작업 공간을 선택하세요.');return;}
          if(result.workspaceId===null){
            // A general project is project-scoped only; selecting it never touches workspaces.
            record={...record!,selected:true};remember(record);
            if(alive.current&&(latest.current.projectId===startingProject||latest.current.projectId===result.projectId))latest.current.onProject(result.projectId);
            return;
          }
          await props.post('/api/workspaces/select',{workspaceId:result.workspaceId});
          record={...record!,selected:true};remember(record);
          // workspace.selected reconnects SSE before its HTTP response. Preserve
          // that success, while never overwriting an unrelated user selection.
          const current=latest.current;
          if(alive.current&&(current.projectId===startingProject||current.projectId===result.projectId)
            &&(current.selectedWorkspaceId===startingWorkspace||current.selectedWorkspaceId===result.workspaceId))current.onProject(result.projectId);
        }catch(error){
          const code=error instanceof Error?error.message:'';
          if(code==='INVALID_FIELDS'&&!record!.result){
            // This rejection precedes every server allocation. Other errors may
            // already have created files and must retain their request identity.
            try{forget(record!,false);}catch{show('이름은 거부됐지만 브라우저의 요청 기록을 갱신하지 못했습니다. 세션 저장소 설정을 확인하세요.');return;}
          }
          show(messages[code]??(stored.current?.result?'프로젝트는 준비됐지만 작업 공간 선택을 확인하지 못했습니다. 선택만 다시 시도하세요.':'생성 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요. 새 프로젝트는 자동으로 만들지 않습니다.'));
        }
      });
    }catch{show('작업 상태를 확인하지 못했습니다. 저장된 요청으로 다시 확인하세요.');}
    finally{sending.current=false;if(alive.current)setBusy(false);}
  }
  function startAnother(){
    if(sending.current||latest.current.locked||!latest.current.online||!stored.current?.selected)return;
    try{forget(stored.current,true);setName('');setIssue('');}
    catch{show('브라우저의 생성 기록을 갱신하지 못했습니다. 세션 저장소 설정을 확인하세요.');}
  }
  const disabled=locked||!online||busy||!!initial.issue;
  const ready=!!receipt?.selected&&receipt.result?.projectId===projectId&&(receipt.result.workspaceId===null||receipt.result.workspaceId===selectedWorkspaceId);
  return <section aria-label="새 프로젝트 준비">
    <h3>새 프로젝트 만들기</h3>
    <p className="hint">{kind==='general'?'문서·조사·분석 같은 일반 작업용 폴더를 준비합니다. Git이나 작업 공간은 만들지 않습니다.':'이름을 입력하면 Git 저장소와 격리 작업 공간을 준비합니다. AI 실행과 검증 명령 설정은 별도입니다.'}</p>
    <form className="register-project" onSubmit={event=>{event.preventDefault();void prepare();}}>
      <label htmlFor="new-project-name">새 프로젝트 이름</label>
      <div><input id="new-project-name" value={name} maxLength={80} autoComplete="off" placeholder="나의 첫 프로젝트" disabled={disabled||!!receipt} onChange={event=>{if(!stored.current&&!sending.current)setName(event.target.value);}}/>
        {!receipt&&<button className="primary" disabled={disabled||!name.trim()}>{busy?'준비 중…':'새 프로젝트 준비'}</button>}</div>
    </form>
    <fieldset className="project-kind" disabled={disabled||!!receipt}><legend>작업 종류</legend>
      <label><input type="radio" name="new-project-kind" value="general" checked={kind==='general'} onChange={()=>{if(!stored.current&&!sending.current)setKind('general');}}/> 일반 작업 (문서·조사·분석)</label>
      <label><input type="radio" name="new-project-kind" value="code" checked={kind==='code'} onChange={()=>{if(!stored.current&&!sending.current)setKind('code');}}/> 코드 작업 (Git 저장소)</label>
    </fieldset>
    <p className="subtle">일반 이름만 입력하세요. 경로, 명령, 비밀번호나 API 키는 넣지 마세요.</p>
    {receipt&&!ready&&<p className="hint">{receipt.result?receipt.result.workspaceId===null?'프로젝트가 준비됐습니다. 프로젝트를 선택하면 기획을 시작할 수 있습니다.':'프로젝트가 준비됐습니다. 이 작업 공간을 선택하면 기획을 시작할 수 있습니다.':'확인할 생성 요청이 저장돼 있습니다. 이름을 바꾸지 않고 같은 요청으로 확인합니다.'}</p>}
    {receipt&&!ready&&<button disabled={disabled} onClick={()=>void prepare()}>{busy?'준비 중…':receipt.result?'작업 공간 선택 다시 시도':'같은 요청으로 다시 확인'}</button>}
    {ready&&<p className="hint">{receipt?.result?.workspaceId===null?'일반 프로젝트가 준비됐습니다.':'프로젝트와 작업 공간이 준비됐습니다.'}</p>}
    {ready&&onPlanning&&<button className="primary" disabled={disabled} onClick={()=>{if(!sending.current&&!latest.current.locked&&latest.current.online&&stored.current?.selected&&latest.current.projectId===stored.current.result?.projectId&&(stored.current.result?.workspaceId===null||latest.current.selectedWorkspaceId===stored.current.result?.workspaceId))latest.current.onPlanning?.();}}>기획으로 이동</button>}
    {receipt?.selected&&<button disabled={disabled} onClick={startAnother}>다른 프로젝트 만들기</button>}
    {issue&&<p role="alert" className="notice">{issue}</p>}
  </section>;
}

const folderKey='orbit.folder.registration';
type FolderReceipt={requestId:string;name:string;path:string};
const folderMessages:Record<string,string>={
  INVALID_FIELDS:nameIssue,INVALID_PATH:'폴더 위치는 /로 시작하는 전체 경로로 입력하세요.',PATH_UNAVAILABLE:'폴더를 찾지 못했거나 읽고 쓸 수 없습니다.',
  LINK_REJECTED:'바로가기(링크)가 포함된 폴더는 등록할 수 없습니다.',INVALID_PROJECT:'폴더가 아닙니다.',
  FOLDER_NOT_ALLOWED:'이 폴더는 등록이 허용되지 않았습니다. 서버 관리자가 허용 목록(ORBIT_ALLOWED_PROJECTS)에 이 폴더를 정확히 추가해야 합니다. 홈·시스템 폴더는 등록할 수 없습니다.',
  PROJECT_OVERLAP:'이미 등록된 프로젝트와 겹치는 폴더입니다.',GIT_FOLDER_REJECTED:'Git 저장소가 들어 있는 폴더는 일반 프로젝트로 등록할 수 없습니다. 코드 작업 프로젝트로 등록하세요.',
  FOLDER_UNSUPPORTED:'AI 도구 설정 폴더(.claude, .codex 등)가 들어 있어 등록하지 않았습니다.',
  FOLDER_RESERVED_NAME:'폴더에 이미 inputs, output 또는 .orbit-workers가 있어 등록하지 않았습니다. 기존 파일을 지키기 위해 Orbit은 이 이름을 덮어쓰지 않습니다.',
  TREE_TOO_LARGE:'파일이 너무 많은 폴더입니다.',FOLDER_CHANGED:'확인하는 동안 폴더가 바뀌었습니다. 다시 시도하세요.',IDEMPOTENCY_CONFLICT:'저장된 등록 요청과 입력이 다릅니다. 이전 요청을 취소한 뒤 다시 시도하세요.',
  RUN_ACTIVE:'다른 실행이 끝난 뒤 다시 시도하세요.',
};
function readFolderReceipt():FolderReceipt|null{try{const value=JSON.parse(sessionStorage.getItem(folderKey)??'null');return value&&uuid(value.requestId)&&typeof value.name==='string'&&typeof value.path==='string'?value:null;}catch{return null;}}

/** Registers an existing folder as a general project. Orbit does not move or change its files. */
export function FolderRegisterPanel({online,locked,post,onProject}:{online:boolean;locked:boolean;post:(path:string,body:object)=>Promise<any>;onProject:(id:string)=>void}){
  const [pending,setPending]=useState(readFolderReceipt),[name,setName]=useState(pending?.name??''),[path,setPath]=useState(pending?.path??'');
  const [busy,setBusy]=useState(false),[issue,setIssue]=useState('');
  const disabled=!online||locked||busy;
  async function register(){
    if(disabled)return;
    const trimmed=name.trim();if(!pending&&!validName(trimmed)){setIssue(nameIssue);return;}
    // The same request ID is reused after an uncertain response, so no folder is registered twice.
    const receipt=pending??{requestId:crypto.randomUUID(),name:trimmed,path:path.trim()};
    try{sessionStorage.setItem(folderKey,JSON.stringify(receipt));}catch{setIssue('브라우저가 요청 기록을 보존하지 못해 보내지 않았습니다.');return;}
    setPending(receipt);setBusy(true);setIssue('');
    try{
      const result=await post('/api/projects/register-folder',receipt) as CreatedProject;
      if(result?.project?.kind!=='general'||!uuid(result.project.id))throw new Error('UNCERTAIN_RESPONSE');
      sessionStorage.removeItem(folderKey);setPending(null);setName('');setPath('');onProject(result.project.id);
    }catch(error){
      const code=error instanceof Error?error.message:'';
      setIssue(folderMessages[code]??'등록 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
    }finally{setBusy(false);}
  }
  function cancel(){try{sessionStorage.removeItem(folderKey);}catch{}setPending(null);setIssue('');}
  return <section aria-label="기존 폴더 등록">
    <p className="hint">이미 자료가 있는 폴더를 일반 작업 프로젝트로 씁니다. 기존 파일은 옮기거나 바꾸지 않고, Orbit은 그 안의 inputs(자료)·output(결과물)·.orbit-workers(격리 작업 공간)에만 씁니다. 기존 파일 보호를 위해 격리된 작업 공간 없이는 AI 기획·실행을 하지 않습니다.</p>
    <form className="register-project" onSubmit={event=>{event.preventDefault();void register();}}>
      <label htmlFor="folder-project-name">프로젝트 이름</label>
      <input id="folder-project-name" value={name} maxLength={80} autoComplete="off" disabled={disabled||!!pending} onChange={event=>setName(event.target.value)}/>
      <label htmlFor="folder-project-path">폴더 위치(전체 경로)</label>
      <input id="folder-project-path" value={path} maxLength={2000} autoComplete="off" placeholder="/Users/나/Documents/보고서" disabled={disabled||!!pending} onChange={event=>setPath(event.target.value)}/>
      <button className="primary" disabled={disabled||!name.trim()||!path.trim()}>{busy?'확인 중…':pending?'같은 요청으로 다시 확인':'폴더 등록'}</button>
    </form>
    {pending&&!busy&&<button type="button" onClick={cancel}>이 요청 취소</button>}
    <p className="subtle">서버 관리자가 허용한 폴더만 등록됩니다. Git 저장소, 홈·시스템 폴더, 다른 프로젝트와 겹치는 폴더는 등록할 수 없습니다.</p>
    {issue&&<p role="alert" className="notice">{issue}</p>}
  </section>;
}
