import { useEffect,useState } from 'react';
import type { Snapshot } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import type { SavedTask } from '../shared/parallel.ts';
import { executionLabels,providerLabels,workspaceMatchesProject,type PageId } from './navigation.ts';
import { DiffPanel } from './workspaces.tsx';
import { VerificationPanel } from './verification.tsx';
import { SourceGraphPanel } from './source-graph.tsx';
import { MergePanel } from './merge.tsx';
import { ReviewPanel } from './reviews.tsx';
import {ControlPlanePanel} from './control-plane.tsx';
import {DevelopmentResultPanel,selectedDevelopmentRun} from './development-results.tsx';
import type {DevelopmentSelection} from '../shared/development-results.ts';

export function Dashboard({state,projectId,onNavigate}:{state:Snapshot|null;projectId:string;onNavigate:(page:PageId)=>void}) {
  const [tasks,setTasks]=useState<SavedTask[]|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{let disposed=false;setTasks(null);setFailed(false);if(!projectId)return;
    void fetch('/api/projects/'+encodeURIComponent(projectId)+'/tasks').then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<SavedTask[]>;}).then(rows=>{if(!disposed)setTasks(rows);}).catch(()=>{if(!disposed)setFailed(true);});return()=>{disposed=true;};
  },[projectId,retry]);
  const matching=workspaceMatchesProject(state,projectId),runs=matching?state?.runs??[]:[];
  const workspaces=state?.workspaces?.filter(workspace=>workspace.projectId===projectId)??[];
  const active=runs.find(run=>!terminal(run.execution));
  return <>
    <section className="status-grid dashboard-stats" aria-label="실제 상태 요약">
      <div className="card"><label>등록 프로젝트</label><strong>{state?state.projects?.length??0:'—'}<small>개</small></strong><span>이 컴퓨터의 로컬 저장소</span></div>
      <div className="card"><label>현재 AI 연결</label><strong>{state?providerLabels[state.provider]:'확인 중'}</strong><span>공식 Codex CLI</span></div>
      <div className="card"><label>선택 프로젝트 작업 공간</label><strong>{state?workspaces.length:'—'}<small>개</small></strong><span>{state?`${workspaces.filter(workspace=>workspace.status==='ready').length}개 사용 가능`:'상태 확인 중'}</span></div>
      <div className="card"><label>현재 작업 공간 실행</label><strong>{state?active?executionLabels[active.execution]:'실행 대기':'확인 중'}</strong><span>{matching?`${runs.length}회 기록 · 검증은 개발 화면에서 확인`:'실행 작업 공간 선택 필요'}</span></div>
    </section>
    <div className="dashboard-grid"><section className="surface"><div className="section-heading"><h2>프로젝트</h2><button onClick={()=>onNavigate('projects')}>프로젝트 관리 →</button></div>
      {state?.projects?.length?<ul className="record-list">{state.projects.map(project=><li key={project.id}><div><b>{project.name}</b><p>{project.path}</p></div><span className="badge">{project.id===projectId?'선택됨':project.writeEnabled?'쓰기 허용':'읽기 전용'}</span></li>)}</ul>:<div className="empty"><h3>{state?'등록된 프로젝트가 없습니다':'프로젝트를 불러오는 중입니다'}</h3><p>{state?.projectCreationAvailable?'이름만 입력해 새 프로젝트와 작업 공간을 준비할 수 있습니다.':'로컬 저장소를 등록하면 AI 연결 없이 기획을 시작할 수 있습니다.'}</p><button className="primary" onClick={()=>onNavigate('projects')}>{state?.projectCreationAvailable?'새 프로젝트 만들기':'프로젝트 등록'}</button></div>}
    </section><section className="surface"><div className="section-heading"><h2>저장된 Task 초안</h2><button onClick={()=>onNavigate('planning')}>기획 열기 →</button></div>
      {!projectId?<p className="subtle">프로젝트를 선택하세요.</p>:failed?<p role="alert">Task를 불러오지 못했습니다. <button onClick={()=>setRetry(value=>value+1)}>다시 시도</button></p>:tasks===null?<p role="status">Task를 불러오는 중…</p>:tasks.length?<ul className="record-list">{tasks.map(task=><li key={task.id}><div><b>{task.title}</b><p>초안 · 검증은 개발 화면에서 확인</p></div><span className="badge">실행 전</span></li>)}</ul>:<div className="empty"><h3>저장된 Task가 없습니다</h3><p>기획안을 저장·승인한 뒤 Task 초안을 생성하세요.</p></div>}
    </section></div>
    <section className="surface"><div className="section-heading"><h2>최근 실행</h2><button onClick={()=>onNavigate('agents')}>에이전트 센터 →</button></div>
      {runs.length?<ul className="record-list">{runs.slice(-5).reverse().map(run=><li key={run.id}><div><b>{run.prompt}</b><p>{new Date(run.createdAt).toLocaleString('ko-KR')} · 검증은 개발 화면에서 확인</p></div><span className="badge">{executionLabels[run.execution]}</span></li>)}</ul>:<p className="subtle">{matching?'현재 작업 공간에 실행 기록이 없습니다.':'프로젝트에서 실행할 작업 공간을 선택하면 해당 기록이 표시됩니다.'}</p>}
    </section>
  </>;
}

export function Development({state,projectId,onProjects,onVisualize=()=>{},selection=null,onSelectRun=()=>{},online=false,post=async()=>{throw new Error('OFFLINE');}}:{state:Snapshot|null;projectId:string;onProjects:()=>void;onVisualize?:()=>void;selection?:DevelopmentSelection|null;onSelectRun?:(selection:DevelopmentSelection)=>void;online?:boolean;post?:(path:string,body:object)=>Promise<unknown>}) {
  const workspaces=state?.workspaces?.filter(workspace=>workspace.projectId===projectId)??[];
  const matching=workspaceMatchesProject(state,projectId),latest=state?.runs.at(-1);
  const nativeBusy=!!state?.soloRecoveryRequired||state?.provider==='connecting'||!!state?.runs.some(run=>!terminal(run.execution));
  const mergeBusy=!!state?.mergeBusy;
  const otherBusy=!!state?.planningBusy||!!state?.extensionBusy||!!state?.verificationBusy||!!state?.modelHubBusy||!!state?.workflowBusy||nativeBusy;
  const reviewBusy=!!state?.reviewBusy;
  const selectedRun=matching?selectedDevelopmentRun(state,selection):null;
  const terminalRun=selectedRun&&terminal(selectedRun.execution)?selectedRun.id:null;
  return <>{matching&&state?.selectedWorkspaceId&&<DevelopmentResultPanel key={'result-'+state.selectedWorkspaceId} projectId={projectId} workspaceId={state.selectedWorkspaceId} runs={state.runs} selectedRun={selectedRun} onSelectRun={runId=>onSelectRun({workspaceId:state.selectedWorkspaceId!,runId})} online={online} locked={otherBusy||mergeBusy||reviewBusy} refreshKey={String(state.lastSeq)} post={post}/>}<section className="surface"><div className="section-heading"><h2>격리된 작업 공간</h2><button onClick={onProjects}>작업 공간 관리 →</button></div>
    {workspaces.length?<ul className="record-list">{workspaces.map(workspace=><li key={workspace.id}><div><b>{workspace.branch}</b><p>{workspace.path}</p><small>기준 커밋 {workspace.baseSha.slice(0,12)}</small></div><span className="badge">{workspace.id===state?.selectedWorkspaceId?'현재 작업 공간':workspace.status==='ready'?'사용 가능':workspace.status==='creating'?'생성 중':'생성 실패'}</span></li>)}</ul>:<p className="subtle">이 프로젝트에 작업 공간이 없습니다. 쓰기가 허용된 프로젝트에서 생성할 수 있습니다.</p>}
    </section>{matching&&state?.selectedWorkspaceId?<><DiffPanel workspaceId={state.selectedWorkspaceId} refreshKey={latest&&terminal(latest.execution)?latest.id+latest.execution:''}/><SourceGraphPanel key={'graph-'+state.selectedWorkspaceId} workspaceId={state.selectedWorkspaceId} online={online} locked={otherBusy||mergeBusy||reviewBusy} post={post} onVisualize={onVisualize}/><ReviewPanel key={'review-'+state.selectedWorkspaceId} workspaceId={state.selectedWorkspaceId} runId={terminalRun} online={online} busy={otherBusy||mergeBusy} post={post}/><VerificationPanel key={state.selectedWorkspaceId+':'+(terminalRun??'none')} workspaceId={state.selectedWorkspaceId} runId={terminalRun} online={online} agentActive={!!state.planningBusy||!!state.extensionBusy||!!state.modelHubBusy||!!state.workflowBusy||mergeBusy||nativeBusy||reviewBusy} post={post}/><MergePanel projectId={projectId} workspaceId={state.selectedWorkspaceId} runId={terminalRun} online={online} busy={otherBusy||reviewBusy} post={post}/></>:<section className="empty-state"><h2>Git Diff를 확인할 작업 공간을 선택하세요</h2><p>프로젝트의 원본 파일과 기존 변경 사항은 그대로 보존됩니다.</p><button onClick={onProjects}>작업 공간 선택</button></section>}</>;
}

export function PrivacySecurity({state}:{state:Snapshot|null}) {
  const policies=[['HTTP 모델 목적지',state?.modelHubConfigured?'서버에 설정된 목적지만 명시 승인 후 사용':'서버 미설정 · 모델 요청 비활성',state?.externalApiEnabled?'외부 HTTPS 목적지가 설정되어 있습니다. Model Hub에서 목적지·본문·과금 가능성을 확인한 뒤 전송합니다.':'외부 HTTPS 목적지는 비활성입니다. loopback 서버도 외부 서비스를 중계하거나 요금을 부과할 수 있습니다.'],['반출 정책','프로젝트·목적지·모델·사용자 확인에 결합','개인정보·인증정보 패턴은 전송 전에 차단합니다. 기존 모의 정책 검사(mock-only)는 실제 제공자에 전송하지 않습니다.'],['민감 입력','인증정보·개인정보 패턴 차단','이메일·전화번호·식별번호 등을 제한된 패턴으로 검사합니다. 포괄적인 개인정보 탐지 기능은 아닙니다.'],['실행 승인 및 도구','승인 기본 거절 · MCP 격리 검사','정책 확인에 실패하면 Codex 실행을 차단합니다. 검증·리뷰 승인 뒤 후보 생성과 대상 branch 반영을 각각 명시 승인해야 하며 자동 병합하지 않습니다.'],['프로젝트 쓰기','허용한 기존 경로와 Orbit이 직접 만든 저장소만','에이전트는 격리된 source worktree에서 수정합니다. 별도의 사용자 승인과 서버 재검증을 거친 같은 base·clean primary branch에는 ff-only로 반영할 수 있습니다. 원 source worktree를 보존하며 민감 파일의 Diff 내용은 숨깁니다.'],['로컬 연결','loopback · 세션 · Origin · CSRF 검사','브라우저는 서버 API를 사용합니다. 인증 파일과 토큰은 UI에서 읽지 않습니다.']];
  return <><ControlPlanePanel refreshKey={state?.provider??'unknown'}/><div className="notice"><b>기존 Codex 연결은 별도입니다</b><p>Codex는 공식 CLI와 기존 로그인을 사용합니다. AI 추론까지 이 컴퓨터 안에서 수행된다는 의미는 아닙니다.</p></div><section className="surface"><h2>현재 보호 정책</h2><dl className="policy-list">{policies.map(([title,status,description])=><div key={title}><dt>{title}</dt><dd><b>{status}</b><p>{description}</p></dd></div>)}</dl></section><section className="surface"><h2>현재 연결 상태</h2><p>{state?providerLabels[state.provider]:'상태를 불러오는 중입니다.'}</p>{state?.issue&&<p className="hint">차단·연결 진단: {state.issue}</p>}<p className="subtle">기획 저장·승인은 코드 실행 권한을 부여하지 않습니다. 응답 완료와 검증 성공은 별도로 표시합니다.</p></section></>;
}

export function UnavailablePage({page}:{page:'automation'|'extensions'|'usage'|'settings'}) {
  const content={automation:['자동화 기능 준비 중','예약 실행과 자동 Runner는 아직 제공하지 않습니다.'],extensions:['확장 기능 관리 준비 중','MCP · Skills · Plugins의 설치·연결 관리 UI는 아직 제공하지 않습니다. 현재 Codex 실행의 MCP 격리 정책은 유지됩니다.'],usage:['사용량 및 분석 준비 중','토큰·비용·할당량 집계가 연결되지 않았습니다. 추정치나 가상 사용량을 표시하지 않습니다.'],settings:['추가 설정 준비 중','테마와 언어 전환, 개인 설정 편집은 아직 제공하지 않습니다.']}[page];
  return <>{page==='settings'&&<section className="surface"><h2>현재 인터페이스</h2><dl className="policy-list"><div><dt>테마</dt><dd>다크</dd></div><div><dt>기본 언어</dt><dd>한국어</dd></div><div><dt>페이지 기억</dt><dd>URL에 현재 메뉴 유지</dd></div><div><dt>프로젝트 기억</dt><dd>이 브라우저에 선택한 프로젝트 ID 저장 · 저장소 접근이 차단되면 현재 화면에서만 유지</dd></div></dl></section>}<section className="empty-state"><span className="badge">준비 중</span><h2>{content[0]}</h2><p>{content[1]}</p></section></>;
}
