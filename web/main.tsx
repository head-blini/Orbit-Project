import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, AppEvent, Run } from '../shared/types.ts';
import type {DevelopmentSelection} from '../shared/development-results.ts';
import type { SavedTask } from '../shared/parallel.ts';
import { terminal } from '../shared/types.ts';
import './style.css';
import { WorkspacePanel } from './workspaces.tsx';
import { StudioPage, MockProviders } from './studios.tsx';
import { AgentCenter } from './agent-center.tsx';
import { Navigation,TopBar,CommandPanel } from './shell.tsx';
import { Dashboard,Development,PrivacySecurity,UnavailablePage } from './pages.tsx';
import { pages,parsePage,resolveProject,workspaceMatchesProject,readPreference,writePreference,projectPreferenceKey,readOnlyPreference,providerLabels,type PageId } from './navigation.ts';
import './orbit.css';
import { RunTimeline,buildTimeline } from './visualization/index.tsx';
import { acceptSnapshot } from './studio-client.ts';
import { CapabilityPanel } from './capabilities.tsx';
import { ExecutionModes } from './execution-modes.tsx';
import { UsagePanel } from './usage.tsx';
import { ProjectAnalyticsPanel } from './project-analytics.tsx';
import { ExtensionsPanel } from './extensions.tsx';
import { ModelHubPanel } from './model-hub.tsx';
import { WorkflowsPanel } from './workflows.tsx';
import { GoalTrackingPanel } from './goals.tsx';
import {TaskVerificationPreviewPanel} from './task-verification-preview.tsx';
import {StartPage} from './start.tsx';

type TaskIntent={task:SavedTask;workspaceId:string;scope:string;generation:number;returnPage:'start'|'agents'};
const acceptanceErrors:Record<string,string>={ACCEPTANCE_PREVIEW_STALE:'확인한 인수 조건·명령 설정·보호 파일이 바뀌었습니다. 실행 기록을 확인한 뒤 Task 기준을 다시 확인하세요.',ACCEPTANCE_BASELINE_CHANGED:'실행 시 고정한 기준이 현재 상태와 다릅니다. 기존 기준을 복원하거나 새 Task 실행에서 기준을 고정하세요.',ACCEPTANCE_CONFIGURATION:'등록된 보호 파일 설정을 확인할 수 없습니다. 검증 명령 설정을 확인하세요.',ACCEPTANCE_CONFIGURATION_INCOMPLETE:'일부 검증 명령의 보호 파일 설정이 빠져 있습니다. 등록된 명령 설정을 확인하세요.',ACCEPTANCE_FILE_UNAVAILABLE:'보호 파일을 안전하게 읽을 수 없습니다. 파일 경로·링크·읽기 권한을 확인하세요.',ACCEPTANCE_SOURCE_UNAVAILABLE:'현재 작업 공간의 소스를 안전하게 확인할 수 없습니다.',ACCEPTANCE_BASELINE_UNAVAILABLE:'실행에 고정된 기준을 읽을 수 없습니다. 새 실행과 승인을 중단하고 기록을 확인하세요.',ACCEPTANCE_CONTEXT_CHANGED:'작업 공간 또는 기획이 바뀌었습니다. 현재 Task 기준을 다시 확인하세요.'};

const errors:Record<string,string>={STATE_PERSISTENCE_FAILED:'실행 상태를 저장하지 못해 새 실행을 차단했습니다. 기록을 보존한 상태로 저장 공간과 오류를 확인하세요.',SOLO_RECOVERY_REQUIRED:'종료를 확인하지 못한 실행이 있어 새 실행을 차단했습니다. 기록 조회는 가능하며 안전한 복구 기능은 준비 중입니다.',PERSONAL_DATA_BLOCKED:'개인정보 패턴이 감지되어 전송을 차단했습니다. 실제 개인정보를 입력하지 마세요.',DESTINATION_BLOCKED:'현재 목적지의 반출 정책으로 차단됐습니다.',CHATGPT_LOGIN_REQUIRED:'터미널에서 codex login으로 ChatGPT 계정에 로그인하세요.',CODEX_NOT_INSTALLED:'Codex 실행 파일을 찾지 못했습니다. README의 AICC_CODEX_BIN 설정을 확인하세요.',CONNECTION_FAILED:'Codex에 연결하지 못했습니다. CLI 로그인과 정상 사용자 환경을 확인한 뒤 다시 연결하세요.',SUBMIT_UNCERTAIN:'전송 결과를 확인하지 못했습니다. 자동으로 재전송하지 않습니다.',RUN_ACTIVE:'다른 실행이 진행 중입니다.',CREDENTIAL_LIKE_INPUT:'인증정보로 보이는 내용은 전송할 수 없습니다.',CSRF_REJECTED:'웹 연결이 만료됐습니다. 새로고침하세요.',NOT_CONNECTED:'먼저 Codex를 연결하세요.',POLICY_MISMATCH:'읽기 전용·네트워크·승인 정책이 일치하지 않아 연결을 차단했습니다.',MCP_ISOLATION_REQUIRED:'MCP 도구 격리를 확인하지 못해 연결을 차단했습니다. README의 MCP 격리 안내를 확인하세요.',THREAD_STILL_ACTIVE:'저장된 세션이 아직 실행 중입니다. 기존 실행 상태를 확인하세요.'};
export function App(){
  const [developmentSelection,setDevelopmentSelection]=useState<DevelopmentSelection|null>(null);
  const [page,setPage]=useState<PageId>(()=>parsePage(window.location.hash));
  const [visited,setVisited]=useState<Set<PageId>>(()=>new Set([parsePage(window.location.hash)]));
  const [preferredProject,setPreferredProject]=useState(()=>{try{return readPreference(window.localStorage,projectPreferenceKey);}catch{return '';}});
  const [sidebarOpen,setSidebarOpen]=useState(false),[commandOpen,setCommandOpen]=useState(false);
  useEffect(()=>{document.title=(pages.find(item=>item.id===page)?.label??'대시보드')+' · Orbit';window.scrollTo({top:0});},[page]);
  useEffect(()=>{const sync=()=>{const next=parsePage(window.location.hash);setPage(next);setVisited(old=>new Set([...old,next]));setSidebarOpen(false);setCommandOpen(false);};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
  function navigate(next:PageId){window.location.hash='/'+next;setPage(next);setVisited(old=>new Set([...old,next]));setSidebarOpen(false);setCommandOpen(false);}
  function selectProject(id:string){cancelTask();setPreferredProject(id||readOnlyPreference);try{writePreference(window.localStorage,projectPreferenceKey,id||readOnlyPreference);}catch{/* Use in-memory selection. */}}

  const [state,setState]=useState<Snapshot|null>(null),[promptDrafts,setPromptDrafts]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[online,setOnline]=useState(false),[events,setEvents]=useState<AppEvent[]>([]);
  const [pending,setPending]=useState<string|null>(()=>{try{return sessionStorage.getItem('aicc.pending');}catch{return null;}});
  const [anchor,setAnchor]=useState<Snapshot|null>(null);
  const csrf=useRef(''),seq=useRef(0),submitting=useRef(false);
  const generation=useRef(0),reload=useRef<()=>Promise<void>>(async()=>{});
  const [taskIntent,setTaskIntent]=useState<TaskIntent|null>(null),taskIntentRef=useRef<TaskIntent|null>(null),taskContext=useRef({scope:'',allowed:false});
  async function refreshState(){const ticket=generation.current;const response=await fetch('/api/state');if(!response.ok)throw new Error('상태를 불러오지 못했습니다.');const next:Snapshot=await response.json();
    const intent=taskIntentRef.current;if(intent&&ticket===generation.current&&(intent.scope!==JSON.stringify([intent.task.projectId,next.selectedWorkspaceId,next.threadId,generation.current])||next.provider!=='ready'||next.soloRecoveryRequired||next.verificationBusy||next.modelHubBusy||next.mergeBusy||next.workflowBusy||next.planningBusy||next.reviewBusy||next.extensionBusy||next.runs.some(run=>!terminal(run.execution))))cancelTask();
    setState(old=>acceptSnapshot(old,next,ticket===generation.current));}
  useEffect(()=>{
    let disposed=false,source:EventSource|null=null,retry:ReturnType<typeof setTimeout>|undefined;
    async function bootstrap(){
      cancelTask();const ticket=++generation.current;source?.close();if(retry)clearTimeout(retry);
      try{
        const session=await fetch('/api/session');if(!session.ok)throw new Error();csrf.current=(await session.json()).csrfToken;
        const r=await fetch('/api/state');if(!r.ok)throw new Error();const s:Snapshot=await r.json();if(disposed||ticket!==generation.current)return;
        setState(s);setAnchor(s);setEvents([]);seq.current=s.lastSeq;setOnline(true);
        let id:string|null=null;try{id=sessionStorage.getItem('aicc.pending');}catch{/* The authoritative snapshot still restores runs. */}if(id&&s.runs.some(r=>r.requestId===id)){try{sessionStorage.removeItem('aicc.pending');}catch{}setPending(null);}
        source=new EventSource('/api/events?after='+s.lastSeq);
        source.onopen=()=>{if(!disposed&&ticket===generation.current)setOnline(true);};
        source.onmessage=message=>{
          if(disposed||ticket!==generation.current)return;
          const incoming:AppEvent=JSON.parse(message.data);
          if(incoming.seq>seq.current+1||incoming.seq-s.lastSeq>200){void bootstrap();return;}
          const e=incoming;if(e.seq<=seq.current)return;seq.current=e.seq;
          if(taskIntentRef.current&&(e.kind.startsWith('session.')||(e.kind==='provider.status'&&e.data.status!=='ready')||(e.data.run&&!terminal((e.data.run as Run).execution))))cancelTask();
          // A selection changes the entire view. Reload an authoritative snapshot,
          // then replay from its cursor so later provider events cannot hide it.
          if(e.kind==='workspace.selected'){if(source){source.onmessage=null;source.onerror=null;source.close();}setOnline(false);void bootstrap();return;}
          setEvents(old=>[...old,e]);
          if(e.kind==='run.lost'||e.kind==='provider.status'||e.kind.startsWith('workspace.')||e.kind.startsWith('verification.')||e.kind.startsWith('model.')||e.kind.startsWith('merge.')||e.kind.startsWith('workflow.')||e.kind.startsWith('review.')||e.kind.startsWith('planning_suggestion.')||e.kind.startsWith('extensions.')||e.kind==='project.registered')void refreshState().catch(()=>{});
          setState(old=>{
            if(!old||e.seq<=old.lastSeq)return old;const next={...old,lastSeq:e.seq};
            if(e.kind==='provider.status'){next.provider=e.data.status as Snapshot['provider'];next.issue=e.data.issue as string|null;}
            if(e.kind.startsWith('session.')&&(e.data.workspaceId??null)===(old.selectedWorkspaceId??null))next.threadId=e.data.threadId as string;
            if(e.data.run){const run=e.data.run as Run;if((run.workspaceId??null)===(old.selectedWorkspaceId??null))next.runs=old.runs.some(r=>r.id===run.id)?old.runs.map(r=>r.id===run.id?run:r):[...old.runs,run];}
            return next;
          });
        };
        source.onerror=()=>{if(disposed||ticket!==generation.current)return;cancelTask();source?.close();setOnline(false);retry=setTimeout(bootstrap,2500);};
      }catch{if(!disposed&&ticket===generation.current){setOnline(false);retry=setTimeout(bootstrap,2500);}}
    }
    reload.current=bootstrap;
    void bootstrap();return()=>{disposed=true;++generation.current;source?.close();if(retry)clearTimeout(retry);};
  },[]);
  async function post(path:string,body:object){
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.current},body:JSON.stringify(body)});
    const data=await r.json();if(!r.ok)throw new Error(data.error==='WORKSPACE_MISMATCH'?'다른 탭에서 작업 공간이 바뀌었습니다. 현재 선택을 확인한 뒤 새 요청을 보내세요.':data.error==='POLICY_MISMATCH'?'작업 공간·네트워크·승인 정책이 일치하지 않아 연결을 차단했습니다.':errors[data.error]??acceptanceErrors[data.error]??data.error??'요청을 완료하지 못했습니다.');return data;
  }
  async function connect(){if(!workspaceMatchesProject(state,projectId))return;cancelTask();const ticket=generation.current;setBusy(true);setError('');try{const next:Snapshot=await post('/api/connect',{});setState(old=>acceptSnapshot(old,next,ticket===generation.current));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function workspaceAction(fn:()=>Promise<void>){cancelTask();setBusy(true);setError('');try{await fn();await refreshState();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function submit(e:React.FormEvent){
    e.preventDefault();if(submitting.current||taskIntentRef.current||pending||!workspaceMatchesProject(state,projectId)||!online||busy||state?.provider!=='ready'||state.runs.some(run=>!terminal(run.execution)))return;submitting.current=true;setBusy(true);setError('');
    const requestId=crypto.randomUUID();try{sessionStorage.setItem('aicc.pending',requestId);}catch{setError('브라우저가 전송 상태 보존을 허용하지 않아 요청을 보내지 않았습니다. 이 사이트의 세션 저장소 설정을 확인하세요.');submitting.current=false;setBusy(false);return;}setPending(requestId);
    try{await post('/api/runs',{requestId,prompt,workspaceId:state?.selectedWorkspaceId??null});sessionStorage.removeItem('aicc.pending');setPending(null);setPrompt('');}
    catch(e){setError((e as Error).message);}
    finally{submitting.current=false;setBusy(false);}
  }
  async function interrupt(id:string){cancelTask();setBusy(true);setError('');try{await post('/api/runs/'+id+'/interrupt',{});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function runTask(task:SavedTask){
    if(submitting.current||taskIntentRef.current||!taskContext.current.allowed||task.projectId!==projectId||!state?.selectedWorkspaceId)return;
    const intent:TaskIntent={task,workspaceId:state.selectedWorkspaceId,scope:taskContext.current.scope,generation:generation.current,returnPage:page==='start'?'start':'agents'};taskIntentRef.current=intent;setTaskIntent(intent);setError('');
  }
  function cancelTask(){taskIntentRef.current=null;setTaskIntent(null);}
  async function startTask(intent:TaskIntent,expectedAcceptanceDigest?:string){
    if(taskIntentRef.current!==intent||submitting.current||!taskContext.current.allowed||taskContext.current.scope!==intent.scope||generation.current!==intent.generation)return;
    if(expectedAcceptanceDigest!==undefined&&!/^[a-f0-9]{64}$/.test(expectedAcceptanceDigest))return;
    cancelTask();
    const requestId=crypto.randomUUID();
    try{sessionStorage.setItem('aicc.pending',requestId);}catch{setError('브라우저가 전송 상태 보존을 허용하지 않아 요청을 보내지 않았습니다.');return;}
    submitting.current=true;setPending(requestId);setBusy(true);setError('');
    try{await post(`/api/projects/${intent.task.projectId}/tasks/${intent.task.id}/run`,{requestId,workspaceId:intent.workspaceId,...(expectedAcceptanceDigest===undefined?{}:{expectedAcceptanceDigest})});sessionStorage.removeItem('aicc.pending');setPending(null);navigate(intent.returnPage);}
    catch(error){setError((error as Error).message);}
    finally{submitting.current=false;setBusy(false);}
  }
  const active=state?.runs.find(r=>!terminal(r.execution));
  const projectId=resolveProject(state?.projects??[],preferredProject,state);
  const selectedProject=state?.projects?.find(project=>project.id===projectId);
  const matches=workspaceMatchesProject(state,projectId);
  const planningBlocked=busy||!!state?.soloRecoveryRequired||!!active||!!state?.verificationBusy||!!state?.modelHubBusy||!!state?.mergeBusy||!!state?.workflowBusy||!!state?.reviewBusy||!!state?.extensionBusy||state?.provider==='connecting';
  const locked=planningBlocked||!!state?.planningBusy;
  const taskScope=JSON.stringify([projectId,state?.selectedWorkspaceId,state?.threadId,generation.current]);
  const taskAllowed=online&&!locked&&!pending&&matches&&state?.provider==='ready'&&!!state.selectedWorkspaceId;
  taskContext.current={scope:taskScope,allowed:taskAllowed};
  useEffect(()=>{if(taskIntentRef.current&&(!taskAllowed||taskIntentRef.current.scope!==taskScope))cancelTask();},[taskScope,taskAllowed]);
  const promptKey=projectId+':'+(matches?state?.selectedWorkspaceId??'readonly':'no-workspace');
  const prompt=promptDrafts[promptKey]??'';
  function setPrompt(value:string){setPromptDrafts(old=>({...old,[promptKey]:value}));}
  useEffect(()=>{setDevelopmentSelection(null);},[projectId,state?.selectedWorkspaceId]);
  function openResult(selection:DevelopmentSelection){if(matches&&state?.selectedWorkspaceId===selection.workspaceId&&state.runs.some(run=>run.id===selection.runId&&run.workspaceId===selection.workspaceId)){setDevelopmentSelection(selection);navigate('development');}}
  const currentPage=pages.find(item=>item.id===page)!;
  const agent=<AgentCenter state={state} online={online} busy={busy||!!state?.soloRecoveryRequired||!!state?.verificationBusy||!!state?.modelHubBusy||!!state?.mergeBusy||!!state?.workflowBusy||!!state?.planningBusy||!!state?.reviewBusy||!!state?.extensionBusy} matches={matches} prompt={prompt} setPrompt={setPrompt} pending={pending} connect={connect} submit={submit} interrupt={interrupt} clearPending={()=>{try{sessionStorage.removeItem('aicc.pending');}catch{}setPending(null);}} onProjects={()=>navigate('projects')} onActiveSession={()=>selectProject(state?.workspaces?.find(workspace=>workspace.id===state.selectedWorkspaceId)?.projectId??'')} onResult={openResult} issueMessage={state?.issue?errors[state.issue]??'연결이 종료됐습니다. 세션 이어받기로 다시 연결하세요.':''}/>;
  return <div className="shell">
    <a className="skip-link" href="#page-content" onClick={event=>{event.preventDefault();document.getElementById('page-content')?.focus();}}>본문으로 이동</a>
    <Navigation page={page} open={sidebarOpen} onNavigate={navigate} onClose={()=>setSidebarOpen(false)}/>
    <div className="app-body"><TopBar state={state} online={online} projectId={projectId} locked={busy||state?.provider==='connecting'} onProject={selectProject} onMenu={()=>setSidebarOpen(value=>!value)} onCommand={()=>{if(page!=='agents')setCommandOpen(true);else document.getElementById('prompt')?.focus();}} onSettings={()=>navigate('settings')}/>
    <main id="page-content" tabIndex={-1}>
      {state?.soloRecoveryRequired&&<div className="banner error" role="alert">종료를 확인하지 못한 Solo 실행이 있어 이 서버의 새 실행을 차단했습니다. 기록 조회는 가능합니다. 안전한 복구 기능은 준비 중이며 재시작이나 작업 공간 변경으로 자동 해제하지 않습니다.</div>}
      <header className="page-heading"><div><span className="eyebrow">{currentPage.name}</span><h1>{currentPage.label}</h1><p>{currentPage.description}</p></div>{selectedProject&&<span className="badge project-badge">{selectedProject.name}</span>}</header>
      {!online&&<div className="banner" role="status">서버 연결을 기다리고 있습니다. 다시 연결될 때 기록만 복원하며 프롬프트는 재전송하지 않습니다.</div>}
      {error&&<div className="banner error" role="alert">{error}</div>}
      {taskIntent&&taskAllowed&&taskIntent.scope===taskScope&&<TaskVerificationPreviewPanel projectId={taskIntent.task.projectId} workspaceId={taskIntent.workspaceId} taskId={taskIntent.task.id} taskTitle={taskIntent.task.title} scopeKey={taskIntent.scope} active={taskAllowed} onCancel={cancelTask} onRun={digest=>startTask(taskIntent,digest)}/>}
      {page==='dashboard'&&<Dashboard key={projectId} state={state} projectId={projectId} onNavigate={navigate}/>}
      {page==='start'&&<StartPage state={state} projectId={projectId} online={online} locked={locked||!!pending} planningBlocked={planningBlocked||!!pending} canRunTask={taskAllowed&&!taskIntent} post={post} onNavigate={navigate} onProject={selectProject} workspaceAction={workspaceAction} onConnect={connect} onRunTask={runTask} onInterrupt={interrupt}/>}
      {page==='projects'&&<WorkspacePanel state={state} projectId={projectId} onProject={selectProject} onPlanning={()=>navigate('planning')} online={online} locked={!online||locked} action={workspaceAction} post={post}/>}
      {(['planning','visualization'] as const).map(studio=>visited.has(studio)&&<div key={studio} hidden={page!==studio}><StudioPage projectId={projectId} page={studio} post={post} online={online} busy={busy} state={state} canRunTask={taskAllowed&&!taskIntent} onRunTask={runTask} onResult={openResult}/></div>)}
      {page==='agents'&&<><ExecutionModes/>{agent}{matches&&anchor&&state&&(anchor.selectedWorkspaceId??null)===(state.selectedWorkspaceId??null)&&<RunTimeline view={buildTimeline(anchor,events)} snapshot={state} onReload={()=>reload.current()}/>}
      <details className="events"><summary>최근 작업 이벤트 <span>{state?.lastSeq??0}개 보존</span></summary>{events.length?events.map(event=><div key={event.seq}><code>#{event.seq}</code> {event.kind}<time>{new Date(event.at).toLocaleTimeString('ko-KR')}</time></div>):<p>현재 연결 이후 발생한 이벤트가 표시됩니다. 이전 실행 기록은 대화에 복원됩니다.</p>}</details></>}
      {page==='development'&&<Development state={state} projectId={projectId} onProjects={()=>navigate('projects')} onVisualize={()=>navigate('visualization')} selection={developmentSelection} onSelectRun={setDevelopmentSelection} online={online} post={post}/>}
      {page==='providers'&&<><section className="surface"><div className="section-heading"><div><h2>Codex</h2><p>공식 CLI · 기존 ChatGPT 로그인 사용</p></div><span className="badge">{state?providerLabels[state.provider]:'상태 확인 중'}</span></div><button onClick={()=>navigate('agents')}>에이전트 센터에서 연결 관리 →</button></section><ModelHubPanel projectId={projectId} online={online} nativeBusy={busy||!!state?.soloRecoveryRequired||!!active||!!state?.verificationBusy||!!state?.mergeBusy||!!state?.workflowBusy||!!state?.planningBusy||!!state?.reviewBusy||!!state?.extensionBusy||state?.provider==='connecting'} post={post}/><CapabilityPanel online={online} status={state?.provider} post={post}/><fieldset className="studio-page" disabled={!online}><MockProviders connections={state?.connections} post={post}/></fieldset></>}
      {page==='extensions'&&<><ExtensionsPanel workspaceId={state?.selectedWorkspaceId??null} matches={matches} online={online} status={state?.provider} busy={locked} post={post}/><CapabilityPanel online={online} status={state?.provider} post={post} extensionsOnly/><section className="notice"><b>확장 설치·프로필 변경은 미연결입니다</b><p>출처·버전·실행 권한 검토와 격리 실험을 마친 뒤에만 도입합니다. 현재 실행 정책은 유지됩니다.</p></section></>}
      {page==='security'&&<PrivacySecurity state={state}/>}
      {page==='usage'&&<><ProjectAnalyticsPanel projectId={projectId} online={online}/><UsagePanel state={state} online={online} post={post}/></>}
      {page==='automation'&&<><GoalTrackingPanel projectId={projectId||null} online={online} post={post}/><WorkflowsPanel projectId={projectId} workspaceId={matches?state?.selectedWorkspaceId??null:null} online={online} busy={busy||!!state?.soloRecoveryRequired||!!active||!!state?.verificationBusy||!!state?.modelHubBusy||!!state?.mergeBusy||!!state?.planningBusy||!!state?.reviewBusy||!!state?.extensionBusy||state?.provider==='connecting'} post={post}/></>}
      {page==='settings'&&<UnavailablePage page={page}/>}
    </main></div>
    {commandOpen&&page!=='agents'&&<CommandPanel onClose={()=>setCommandOpen(false)}>{error&&<div className="banner error" role="alert">{error}</div>}{!online&&<div className="banner">로컬 서버 연결을 기다리는 중입니다.</div>}{agent}</CommandPanel>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
