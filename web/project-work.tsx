import {useEffect,useState,type ReactNode} from 'react';
import type {PlanningVersion} from '../shared/parallel.ts';
import type {ProjectProgress,ConnectionFreshness} from '../shared/project-progress.ts';
import type {DeliverableList,Material} from '../shared/deliverables.ts';
import {workspaceMatchesProject} from './navigation.ts';
import {GeneralPlanCard,StartWorkspace,type StartProps} from './start.tsx';
import {takeNewTaskRequest,onNewTaskRequest} from './new-task.tsx';
import {PlanningAgentPanel} from './planning/PlanningAgent.tsx';
import {ProjectProgressPanel,blockerLabels} from './project-progress.tsx';
import {AiPreferencesPanel} from './ai-preferences.tsx';
import {evidenceLabel} from './deliverables.tsx';
import {useUiMode} from './ui-mode.ts';
import './project-work.css';

type RawPost=(path:string,body:object)=>Promise<Response>;
type Props=StartProps&{rawPost:RawPost;lastEventAt:string|null;freshness:ConnectionFreshness;
  /** Existing repository/workspace management, kept reachable as an advanced section. */children?:ReactNode};
import {projectSteps,nextAction,stepStateLabel,type Step} from './project-work-model.ts';
const kindLabel={general:'일반 작업',code:'코드 작업'} as const;
const scrollTo=(id:string)=>document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});

export function ProjectWorkPage(props:Props){
  const {state,projectId,online}=props,project=state?.projects?.find(item=>item.id===projectId);
  const mode=useUiMode();
  if(!state)return <section className="work-empty"><p>프로젝트를 불러오는 중입니다…</p></section>;
  if(!project){
    const projects=[...(state.projects??[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return <section className="work-empty" aria-label="프로젝트 선택">
      <h2>프로젝트를 고르세요</h2><p>프로젝트를 선택하면 목표·기획·실행·결과물을 한 화면에서 이어갈 수 있습니다.</p>
      {projects.length?<ul className="recent-list">{projects.map(item=><li key={item.id}><button className="recent-item" title={item.name} onClick={()=>props.onProject(item.id)}><span className="recent-name">{item.name}</span><span className="recent-meta"><span className={'kind kind-'+item.kind}>{kindLabel[item.kind]}</span></span></button></li>)}</ul>
        :<p>아직 프로젝트가 없습니다.</p>}
      <button className="primary" onClick={()=>props.onNavigate('start')}>새 작업 시작</button>
      {props.children}
    </section>;
  }
  return <div className="work">
    {project.kind==='general'?<GeneralWork key={projectId} {...props} name={project.name}/>:<CodeWork key={projectId} {...props} name={project.name}/>}
    {mode==='advanced'?<div id="work-advanced-tools">{props.children}</div>:<details id="work-advanced-tools" className="work-advanced"><summary>저장소·작업 공간 관리 (고급)</summary>{props.children}</details>}
    {!online&&<p className="notice" role="status">서버 연결이 끊겼습니다. 다시 연결되면 기록만 다시 읽으며 실행을 재전송하지 않습니다.</p>}
  </div>;
}

function Header({name,kind,progress,steps,action,onAction}:{name:string;kind:'general'|'code';progress:ProjectProgress|null;steps:Step[];action:{text:string}|null;onAction:()=>void}){
  return <header className="work-header">
    <div className="work-title"><span className={'kind kind-'+kind}>{kindLabel[kind]}</span><h2 title={name}>{name}</h2>
      <p>{progress?.plan?progress.plan.goal:'아직 승인된 목표가 없습니다. AI에게 요청해 기획을 받고 승인하세요.'}</p></div>
    {action&&<div className="work-next"><span>다음 할 일</span><button className="primary" onClick={onAction}>{action.text}</button></div>}
    {!!progress?.blockers.length&&<ul className="work-blockers" role="alert">{progress.blockers.map(item=><li key={item.code}>{blockerLabels[item.code]??item.code}</li>)}</ul>}
    <ol className="work-steps" aria-label="진행 단계">{steps.map((step,index)=><li key={step.id} className={'step step-'+step.state} aria-current={step.state==='active'?'step':undefined}>
      <span className="step-index" aria-hidden="true">{step.state==='done'?'✓':index+1}</span>
      <span className="step-text"><b>{step.label}</b><small>{stepStateLabel[step.state]} · {step.detail}</small></span></li>)}</ol>
  </header>;
}

function GeneralWork(props:Props&{name:string}){
  const {projectId,online}=props;
  const [progress,setProgress]=useState<ProjectProgress|null>(null),[list,setList]=useState<DeliverableList|null>(null),[materials,setMaterials]=useState<Material[]>([]);
  const [saved,setSaved]=useState<PlanningVersion|null>(null),[initialText,setInitialText]=useState(()=>takeNewTaskRequest(projectId));
  useEffect(()=>onNewTaskRequest(()=>{const text=takeNewTaskRequest(projectId);if(text)setInitialText(text);}),[projectId]);
  const lastSeq=props.state?.lastSeq??0;
  useEffect(()=>{let live=true;if(!online)return;
    const timer=setTimeout(()=>{
      void fetch('/api/projects/'+encodeURIComponent(projectId)+'/deliverables',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(value=>{if(live&&value&&Array.isArray(value.items))setList(value);}).catch(()=>{});
      void fetch('/api/projects/'+encodeURIComponent(projectId)+'/materials',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(value=>{if(live&&Array.isArray(value))setMaterials(value);}).catch(()=>{});
    },lastSeq?600:0);
    return()=>{live=false;clearTimeout(timer);};},[projectId,online,lastSeq]);
  // Files a task produced; the project README and other untasked files stay on the 결과물 page.
  const outputs=list?.items.filter(item=>item.role!=='input'&&item.taskId)??[];
  const steps=projectSteps(progress,outputs.length),action=nextAction(progress,outputs.length);
  const act=()=>action.target==='results'?props.onNavigate('results'):scrollTo('work-'+action.target);
  const approved=progress?.plan?.state==='approved'&&!!progress.tasks.length;
  const followup=<>
          <section id="work-followup" className="work-section" aria-labelledby="work-followup-title">
          <h3 id="work-followup-title">{progress?.plan?'AI에게 추가 지시':'AI에게 요청'}</h3>
          <PlanningAgentPanel presentation="simple" general initialText={initialText} projectId={projectId} workspaceId={null} online={online} busy={props.planningBlocked} post={props.post} onSaved={version=>{setSaved(version);scrollTo('work-plan');}}/>
        </section>
  </>;
  return <>
    <Header name={props.name} kind="general" progress={progress} steps={steps} action={action} onAction={act}/>
    <div className="work-grid">
      <div className="work-main">
        {!progress?.plan&&!saved&&followup}
        <section id="work-plan" className="work-section" aria-labelledby="work-plan-title">
          <h3 id="work-plan-title">기획</h3>
          {approved&&<p className="work-muted">현재 승인된 기획입니다. 바꾸려면 ‘AI에게 추가 지시’로 새 버전을 만드세요.</p>}
          <GeneralPlanCard {...props} savedId={saved?.id??null} onShowTasks={()=>scrollTo('work-tasks')}/>
          {!progress?.plan&&!saved&&<p className="work-muted">‘AI에게 요청’에서 기획 제안을 받아 저장하면 여기에서 검토·승인합니다.</p>}
        </section>
        <section id="work-tasks" className="work-section" aria-labelledby="work-tasks-title">
          <h3 id="work-tasks-title">실행</h3>
          <p className="work-muted">작업을 펼쳐 실행하고, 담당 AI·마지막 관측·검증 상태를 확인합니다. AI 응답 완료는 검증 통과가 아닙니다.</p>
          <ProjectProgressPanel projectId={projectId} projectKind="general" online={online} lastSeq={lastSeq} lastEventAt={props.lastEventAt} freshness={props.freshness} post={props.rawPost} compact onProgress={setProgress}/>
        </section>
        {(!!progress?.plan||!!saved)&&followup}
      </div>
      <div className="work-aside" role="complementary" aria-label="프로젝트 정보">
        <section className="work-card" aria-label="AI 선택"><AiPreferencesPanel projectId={projectId} kind="general" online={online} post={props.rawPost}/></section>
        <section className="work-card" aria-labelledby="work-materials-title"><h3 id="work-materials-title">첨부 자료</h3>
          {materials.length?<ul className="file-list">{materials.map(item=><li key={item.path} title={item.path}><span>{item.path.replace(/^inputs\//,'')}</span><small>{(item.size/1024).toFixed(1)} KB</small></li>)}</ul>:<p className="work-muted">첨부한 자료가 없습니다.</p>}</section>
        <section className="work-card" aria-labelledby="work-results-title"><h3 id="work-results-title">결과물</h3>
          {!list?<p className="work-muted">불러오는 중…</p>:outputs.length?<ul className="file-list">{outputs.slice(0,5).map(item=><li key={item.path} title={item.path}><span>{item.taskTitle??item.path}</span>
            {item.checks.evidence&&<small className={'evidence-'+item.checks.evidence.status}>{evidenceLabel(item.checks.evidence)}</small>}</li>)}</ul>:<p className="work-muted">아직 결과물이 없습니다.</p>}
          {outputs.length>5&&<p className="work-muted">외 {outputs.length-5}개</p>}
          <button onClick={()=>props.onNavigate('results')}>결과물 열기</button></section>
      </div>
    </div>
  </>;
}

function CodeWork(props:Props&{name:string}){
  const {state,projectId}=props,project=state!.projects!.find(item=>item.id===projectId)!;
  const ready=workspaceMatchesProject(state,projectId)&&!!state!.selectedWorkspaceId&&project.writeEnabled&&!state!.readOnly;
  const steps:Step[]=[{id:'goal',label:'목표',state:'active',detail:'기획에서 정합니다'},{id:'plan',label:'기획',state:'pending',detail:'아래 흐름에서 확인'},{id:'run',label:'실행',state:'pending',detail:'Codex 실행'},
    {id:'cross',label:'교차 검증',state:'unavailable',detail:'다른 AI의 독립 검증은 아직 연결되지 않았습니다'},{id:'fix',label:'수정·재검증',state:'pending',detail:'검증 명령으로 확인'},{id:'result',label:'결과물',state:'pending',detail:'코드 변경·미리보기'}];
  return <>
    <Header name={props.name} kind="code" progress={null} steps={steps} action={ready?null:{text:'작업 공간 선택'}} onAction={()=>{const element=document.getElementById('work-advanced-tools');if(element instanceof HTMLDetailsElement)element.open=true;scrollTo('work-advanced-tools');}}/>
    {ready?<StartWorkspace key={projectId+':'+state!.selectedWorkspaceId} {...props} workspaceId={state!.selectedWorkspaceId!}/>
      :<section className="work-section"><h3>작업 공간이 필요합니다</h3><p className="work-muted">코드 프로젝트는 쓰기 가능한 격리 작업 공간을 선택해야 기획·실행할 수 있습니다. 아래 ‘저장소·작업 공간 관리’에서 선택하세요.</p></section>}
  </>;
}
