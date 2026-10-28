import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {Snapshot,Run} from '../shared/types.ts';
import {terminal} from '../shared/types.ts';
import type {SavedTask,PlanningVersion} from '../shared/parallel.ts';
import type {Material} from '../shared/deliverables.ts';
import {workspaceMatchesProject,executionLabels,providerLabels,type PageId} from './navigation.ts';
import {ProjectCreatePanel} from './project-create.tsx';
import {NewTaskPanel,takeNewTaskRequest,onNewTaskRequest} from './new-task.tsx';
import {PlanningAgentPanel} from './planning/PlanningAgent.tsx';
import {VerificationPanel} from './verification.tsx';
import {DevelopmentResultPanel} from './development-results.tsx';
import {createStartFlowCoordinator,currentStartPlans} from './start-flow.ts';
import {answerOpenQuestions} from './plan-answers.ts';
import {useUiMode} from './ui-mode.ts';
import {createStudioMutator} from './studio-client.ts';
import {serializePlanningDraft} from '../server/planning/parser.ts';
import './start.css';

export type StartProps={state:Snapshot|null;projectId:string;online:boolean;locked:boolean;planningBlocked:boolean;canRunTask:boolean;
  post:(path:string,body:object)=>Promise<any>;onNavigate:(page:PageId)=>void;onProject:(id:string)=>void;
  workspaceAction:(fn:()=>Promise<void>)=>Promise<void>;onConnect:()=>Promise<void>;
  onRunTask:(task:SavedTask)=>Promise<void>;onInterrupt:(id:string)=>Promise<void>};
type Step='plan'|'develop'|'verify'|'result';
const steps:readonly [Step,string][]=[['plan','기획'],['develop','개발'],['verify','검증'],['result','결과']];

export function StartPage(props:StartProps){
  const {state,projectId,online,locked}=props,project=state?.projects?.find(p=>p.id===projectId);
  const [fresh,setFresh]=useState(false);
  useEffect(()=>setFresh(false),[projectId]);
  if(!state)return <section className="surface"><h2>작업을 불러오고 있습니다</h2><p>서버 연결 후 프로젝트를 선택할 수 있습니다.</p></section>;
  // A new request never depends on the selected project, its workspace or Git.
  const home=<section className="surface start-welcome"><span className="eyebrow">NEW TASK</span><h2>목표를 말하면 기획부터 결과물까지 함께 만듭니다</h2><p>문서·조사·분석 같은 일반 작업을 자연어로 요청하세요. Git이나 작업 공간은 필요하지 않습니다.</p>
    {state.projectCreationAvailable?<NewTaskPanel online={online} locked={locked} post={props.post} onProject={id=>{setFresh(false);props.onProject(id);}}/>:<p className="notice">현재 서버에서 새 프로젝트를 준비할 수 없습니다. 서버 설정을 확인하세요.</p>}
    <div className="start-actions">{project&&<button onClick={()=>setFresh(false)}>{project.name}(으)로 돌아가기</button>}<button onClick={()=>props.onNavigate('projects')}>기존 프로젝트 선택</button></div>
    {state.projectCreationAvailable&&<details className="start-code-project"><summary>코드 작업(Git 저장소) 프로젝트 만들기</summary><ProjectCreatePanel projectId={projectId} projectCount={state.projects?.length??0} selectedWorkspaceId={state.selectedWorkspaceId??null} online={online} locked={locked} onProject={props.onProject} action={props.workspaceAction} post={props.post}/></details>}</section>;
  if(!project||fresh)return home;
  const newTask=<div className="start-new-task"><button onClick={()=>setFresh(true)}>+ 새 작업</button></div>;
  if(project.kind==='general')return <>{newTask}<StartGeneral key={projectId} {...props} projectName={project.name}/></>;
  if(!workspaceMatchesProject(state,projectId)||!state.selectedWorkspaceId||!project.writeEnabled||state.readOnly)return <>{newTask}<section className="surface"><h2>{project.name}의 작업 공간을 준비하세요</h2><p>프로젝트에 연결된 쓰기 가능한 작업 공간을 선택하면 기획부터 개발까지 이어갈 수 있습니다.</p><button className="primary" onClick={()=>props.onNavigate('projects')}>작업 공간 선택</button><button onClick={()=>props.onNavigate('planning')}>기획만 작성하기</button></section></>;
  return <>{newTask}<StartWorkspace key={projectId+':'+state.selectedWorkspaceId} {...props} workspaceId={state.selectedWorkspaceId}/></>;
}

/** General (non-Git) projects: natural-language request → AI plan draft → approve in Planning → run from Progress. */
export function StartGeneral(props:StartProps&{projectName:string}){
  const [saved,setSaved]=useState<PlanningVersion|null>(null),[initialText,setInitialText]=useState(()=>takeNewTaskRequest(props.projectId));
  useEffect(()=>onNewTaskRequest(()=>{const text=takeNewTaskRequest(props.projectId);if(text)setInitialText(text);}),[props.projectId]);
  const [materials,setMaterials]=useState<Material[]|null>(null);
  useEffect(()=>{let live=true;if(props.online)void fetch('/api/projects/'+encodeURIComponent(props.projectId)+'/materials',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(value=>{if(live&&Array.isArray(value))setMaterials(value);}).catch(()=>{});return()=>{live=false;};},[props.projectId,props.online,props.state?.lastSeq]);
  return <div className="start-general">
    {!!materials?.length&&<section className="surface" aria-label="첨부 자료"><h3>첨부 자료</h3><p className="subtle">프로젝트 폴더에 저장된 읽기 전용 자료입니다. 기획과 실행 AI가 이 파일만 근거로 읽도록 안내합니다.</p><ul className="materials-list">{materials.map(item=><li key={item.path}><code>{item.path}</code> · {(item.size/1024).toFixed(1)} KB</li>)}</ul></section>}
    <section className="surface"><PlanningAgentPanel presentation="simple" general initialText={initialText} projectId={props.projectId} workspaceId={null} online={props.online} busy={props.planningBlocked} post={props.post} onSaved={version=>setSaved(version)}/></section>
    <GeneralPlanCard {...props} savedId={saved?.id??null}/>
    <section className="surface"><h3>{props.projectName} 진행 상황</h3><p>승인된 작업은 진행 현황에서 실행 AI를 확인하고 실행합니다. 실행·결과물·검증 상태도 그곳에서 봅니다.</p>
      <button onClick={()=>props.onNavigate('progress')}>진행 현황 열기</button></section>
  </div>;
}

/** Current plan of a general project: review, then approve and prepare tasks in one explicit step. */
export function GeneralPlanCard(props:StartProps&{savedId:string|null;
  /** On the project screen the tasks are on the same page; this scrolls there instead of leaving it. */onShowTasks?:()=>void}){
  const {projectId,online,locked,state}=props;
  const callbacks=useRef(props);callbacks.current=props;
  const scope={projectId,workspaceId:null,general:true,online,blocked:locked,refreshKey:String(state?.lastSeq??0)};
  const flow=useMemo(()=>{let storage:Storage|undefined;try{storage=window.sessionStorage;}catch{}
    return createStartFlowCoordinator(scope,{storage,get:async path=>{const response=await fetch(path);if(!response.ok)throw Error('START_LOAD_FAILED');return response.json();},post:(path,body)=>callbacks.current.post(path,body)});
  },[]);
  const view=useSyncExternalStore(flow.subscribe,flow.getSnapshot,flow.getSnapshot);
  useEffect(()=>{flow.activate();return()=>flow.dispose();},[flow]);
  useEffect(()=>{flow.configure(scope);if(!view.action)void flow.refresh();},[flow,projectId,online,locked,scope.refreshKey,view.action]);
  useEffect(()=>{if(props.savedId&&view.plans.some(plan=>plan.id===props.savedId))flow.selectPlan(props.savedId);},[flow,props.savedId,view.plans]);
  const plans=currentStartPlans(view.plans,projectId),plan=plans.find(item=>item.id===view.selectedPlanId)??null;
  const tasks=plan?view.tasks.filter(task=>task.planningVersionId===plan.id):[];
  const observed=online&&view.fresh&&!view.loading&&!view.uncertain;
  const canPrepare=observed&&!locked&&!view.action&&!!plan&&!plan.draft.openQuestions.length;
  const [answers,setAnswers]=useState<Record<number,string>>({}),[saving,setSaving]=useState(false),[answerIssue,setAnswerIssue]=useState('');
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=window.sessionStorage;}catch{}return createStudioMutator((path,body)=>callbacks.current.post(path,body),storage);},[]);
  useEffect(()=>{setAnswers({});setAnswerIssue('');},[plan?.id]);
  async function saveAnswers(){
    if(!plan||saving||!observed||locked||!Object.values(answers).some(value=>value.trim()))return;
    setSaving(true);setAnswerIssue('');
    try{
      const draft=answerOpenQuestions(plan.draft,answers);
      const next=await mutate('/api/projects/'+encodeURIComponent(projectId)+'/plans/'+encodeURIComponent(plan.id)+'/revisions',{expectedRevision:plan.revision,input:{format:'json',source:plan.draft.source,text:serializePlanningDraft(draft)}}) as PlanningVersion;
      await flow.refresh(true);if(next?.id)flow.selectPlan(next.id);
    }catch(error){setAnswerIssue('답변을 새 버전으로 저장하지 못했습니다: '+(error instanceof Error?error.message:'응답 확인 불가'));}
    finally{setSaving(false);}
  }
  const advanced=useUiMode()==='advanced';
  if(!plan)return null;
  // Once approved and prepared, the plan is a reference: show its summary and keep the full text one click away.
  const prepared=plan.state==='approved'&&tasks.length>0;
  const details=<>
    {!prepared&&<h3>{plan.draft.title}</h3>}<p>{plan.draft.goal}</p><ul>{plan.draft.requirements.map(requirement=><li key={requirement.label}><b>{requirement.description}</b><ul>{requirement.acceptanceCriteria.map((value,i)=><li key={i}>{value}</li>)}</ul></li>)}</ul>
    {!!plan.draft.constraints.length&&<><h4>지켜야 할 조건</h4><ul>{plan.draft.constraints.map((value,i)=><li key={i}>{value}</li>)}</ul></>}
    {!!plan.draft.nonGoals?.length&&<><h4>하지 않을 것</h4><ul>{plan.draft.nonGoals.map((value,i)=><li key={i}>{value}</li>)}</ul></>}
    {!!plan.draft.decisions?.length&&<details><summary>결정과 이유 {plan.draft.decisions.length}개</summary><ul>{plan.draft.decisions.map((item,i)=><li key={i}><b>{item.topic}</b> — {item.decision} <span className="subtle">({item.rationale})</span></li>)}</ul></details>}
    {!!plan.draft.openQuestions.length&&<div role="status" className="open-questions"><h4>먼저 결정할 내용 {plan.draft.openQuestions.length}개</h4><p className="subtle">답한 질문은 결정으로 기록되고 새 버전이 저장됩니다. 답하지 않은 질문이 남아 있으면 승인할 수 없습니다.</p>
      {plan.draft.openQuestions.map((value,i)=><label key={plan.id+i}>{value}<input value={answers[i]??''} maxLength={1000} disabled={saving||!observed||locked} placeholder="답변" onChange={event=>setAnswers(old=>({...old,[i]:event.target.value}))}/></label>)}
      <button disabled={saving||!observed||locked||!Object.values(answers).some(value=>value.trim())} onClick={()=>void saveAnswers()}>{saving?'저장 중…':'답변을 반영해 새 버전 저장'}</button>{answerIssue&&<p role="alert" className="notice">{answerIssue}</p>}</div>}
  </>;
  return <section className="surface start-plan" aria-label="현재 기획"><div className="section-heading"><h2>{prepared?plan.draft.title:'기획을 확인하세요'}</h2>{advanced&&<button onClick={()=>props.onNavigate('planning')}>기획 스튜디오에서 편집</button>}</div>

    {plans.length>1&&<label>현재 기획<select value={plan.id} disabled={!observed||!!view.action} onChange={event=>flow.selectPlan(event.target.value)}>{plans.map(p=><option key={p.id} value={p.id}>{p.draft.title} · 버전 {p.revision} · {p.state==='approved'?'승인됨':'초안'}</option>)}</select></label>}
    <p className="subtle">버전 {plan.revision} · {plan.state==='approved'?'승인됨':'초안(미승인)'} · 기준 {plan.contentHash.slice(0,12)}</p>
    {prepared?<details className="plan-details"><summary>기획 내용 보기 · 요구사항 {plan.draft.requirements.length}개</summary>{details}</details>:details}
    {view.error&&<p role="alert" className="notice">{view.error}</p>}
    {tasks.length?<><p role="status">승인된 기준으로 작업 {tasks.length}개를 준비했습니다. {props.onShowTasks?'아래 실행에서':'진행 현황에서'} 실행 AI를 확인하고 실행하세요.</p><button className="primary" onClick={()=>props.onShowTasks?props.onShowTasks():props.onNavigate('progress')}>{props.onShowTasks?'작업 실행으로 이동':'진행 현황에서 실행하기'}</button></>
      :<><button className="primary" disabled={!canPrepare} onClick={()=>void flow.prepareTasks()}>{view.action?'작업 준비 중…':plan.state==='approved'?'이 기획으로 작업 준비':'기획 승인하고 작업 준비'}</button><p className="subtle">승인하면 이 버전이 실행 기준이 됩니다. AI 실행은 다음 단계에서 따로 시작합니다.</p></>}
  </section>;
}

export function StartWorkspace(props:StartProps&{workspaceId:string}){
  const {state,projectId,workspaceId,online,locked}=props;
  const callbacks=useRef(props);callbacks.current=props;
  const scope={projectId,workspaceId,online,blocked:locked,refreshKey:String(state?.lastSeq??0)};
  const flow=useMemo(()=>{let storage:Storage|undefined;try{storage=window.sessionStorage;}catch{}
    return createStartFlowCoordinator(scope,{storage,get:async path=>{const response=await fetch(path);if(!response.ok)throw Error('START_LOAD_FAILED');return response.json();},post:(path,body)=>callbacks.current.post(path,body)});
  },[]);
  const view=useSyncExternalStore(flow.subscribe,flow.getSnapshot,flow.getSnapshot);
  const alive=useRef(true),[chosenStep,setStep]=useState<Step|null>(null),[resultRunId,setResultRunId]=useState<string|null>(null),[savedPlanId,setSavedPlanId]=useState<string|null>(null);
  useEffect(()=>{alive.current=true;flow.activate();return()=>{alive.current=false;flow.dispose();};},[flow]);
  useEffect(()=>{flow.configure(scope);if(!view.action)void flow.refresh();},[flow,projectId,workspaceId,online,locked,scope.refreshKey,view.action]);
  const sameScope=view.scope.projectId===projectId&&view.scope.workspaceId===workspaceId;
  const observed=sameScope&&view.scope.online===online&&view.scope.blocked===locked&&online&&view.fresh&&!view.loading&&!view.uncertain;
  const currentPlans=sameScope?currentStartPlans(view.plans,projectId):[];
  const plan=currentPlans.find(item=>item.id===view.selectedPlanId)??null;
  const tasks=plan?view.tasks.filter(task=>task.projectId===projectId&&task.planningVersionId===plan.id):[];
  const runs=state?.runs.filter(run=>run.workspaceId===workspaceId)??[];
  const active=runs.find(run=>!terminal(run.execution));
  const linked=(task:SavedTask)=>runs.filter(run=>run.taskId===task.id&&run.planningVersionId===task.planningVersionId).at(-1);
  const latestTaskRun=runs.filter(run=>run.planningVersionId===plan?.id&&tasks.some(task=>task.id===run.taskId)).at(-1);
  const suggested:Step=state?.planningBusy?'plan':active?'develop':!plan||plan.state!=='approved'||!tasks.length?'plan':latestTaskRun?.execution==='completed'?'verify':'develop';
  const step=chosenStep??suggested;
  const selectedRun=resultRunId===null?(latestTaskRun??runs.at(-1)??null):runs.find(run=>run.id===resultRunId)??null;
  const runnable=observed&&!locked&&!view.action&&props.canRunTask&&plan?.state==='approved'&&!plan.draft.openQuestions.length;
  const canPrepare=observed&&!locked&&!view.action&&!!plan&&!plan.draft.openQuestions.length;
  useEffect(()=>{if(savedPlanId&&sameScope&&view.fresh&&!view.loading&&currentPlans.some(item=>item.id===savedPlanId)){flow.selectPlan(savedPlanId);setSavedPlanId(null);}},[flow,savedPlanId,sameScope,view.fresh,view.loading,view.plans]);
  async function saved(version:PlanningVersion){if(!alive.current)return;setSavedPlanId(version.id);setStep('plan');await flow.refresh(true);}
  async function prepare(){if(!canPrepare)return;const ok=await flow.prepareTasks();if(ok&&alive.current)setStep('develop');}
  function showRun(run:Run,target:Step){setResultRunId(run.id);setStep(target);}
  return <div className="start-flow">
    <section className="surface start-progress"><div><span className="eyebrow">BUILD WITH ORBIT</span><h2>{state?.planningBusy?'AI가 기획을 만들고 있습니다':active?'AI가 작업하고 있습니다':'아이디어에서 실행 가능한 결과까지'}</h2><p>{locked?'진행 중이거나 확인이 필요한 작업이 있습니다. 현재 기록을 확인하세요.':'요구사항을 기획하고, 작업별로 개발·검증한 뒤 결과를 확인하세요.'}</p></div>
      <button disabled={!online||!!view.action||view.loading} onClick={()=>void flow.refresh(true)}>진행 상태 새로고침</button>
      <nav aria-label="만들기 단계">{steps.map(([id,label],index)=><button key={id} className={step===id?'selected':''} aria-current={step===id?'step':undefined} onClick={()=>setStep(id)}><span>{index+1}</span>{label}</button>)}</nav>
    </section>
    {view.error&&sameScope&&<p role="alert" className="notice">{view.error}</p>}
    {!observed&&<p role="status">{!online?'서버 연결 후 현재 작업을 확인할 수 있습니다.':view.uncertain?'이전 요청 결과를 진행 상태 새로고침으로 확인하세요. 자동 재실행하지 않습니다.':'현재 기획과 작업 상태를 확인하고 있습니다.'}</p>}
    <div hidden={step!=='plan'}>
      {!plan?<section className="surface"><PlanningAgentPanel presentation="simple" projectId={projectId} workspaceId={workspaceId} online={online} busy={props.planningBlocked} post={props.post} onSaved={version=>void saved(version)}/></section>:<>
        <section className="surface start-plan"><div className="section-heading"><h2>기획을 확인하세요</h2><button onClick={()=>props.onNavigate('planning')}>자세히 편집</button></div>
          {currentPlans.length>1&&<label>현재 기획<select value={plan.id} disabled={!observed||!!view.action} onChange={event=>flow.selectPlan(event.target.value)}>{currentPlans.map(p=><option key={p.id} value={p.id}>{p.draft.title} · 버전 {p.revision}</option>)}</select></label>}
          <h3>{plan.draft.title}</h3><p>{plan.draft.goal}</p><ul>{plan.draft.requirements.map(requirement=><li key={requirement.label}><b>{requirement.description}</b><ul>{requirement.acceptanceCriteria.map((value,i)=><li key={i}>{value}</li>)}</ul></li>)}</ul>
          {!!plan.draft.constraints.length&&<><h4>지켜야 할 조건</h4><ul>{plan.draft.constraints.map((value,i)=><li key={i}>{value}</li>)}</ul></>}
          {!!plan.draft.openQuestions.length&&<div role="status"><h4>먼저 결정할 내용</h4><ul>{plan.draft.openQuestions.map((value,i)=><li key={i}>{value}</li>)}</ul><p>자세히 편집에서 결정 사항을 반영한 뒤 작업을 준비하세요.</p></div>}
          <button className="primary" disabled={!canPrepare} onClick={()=>void prepare()}>{view.action?'작업 준비 중…':plan.state==='approved'?'이 기획으로 작업 준비':'기획 승인하고 작업 준비'}</button><p className="subtle">검토한 기획을 승인하고 개발할 작업 목록을 만듭니다. AI 코딩은 다음 단계에서 시작합니다.</p>
        </section><details className="surface"><summary>추가 요청으로 새 기획 만들기</summary><PlanningAgentPanel presentation="simple" projectId={projectId} workspaceId={workspaceId} online={online} busy={props.planningBlocked} post={props.post} onSaved={version=>void saved(version)}/></details>
      </>}
      <button onClick={()=>props.onNavigate('planning')}>직접 기획 작성 또는 가져오기</button>
    </div>
    {step==='develop'&&<section className="surface start-develop"><div className="section-heading"><h2>작업을 개발하세요</h2><button onClick={()=>props.onNavigate('agents')}>실행 상세</button></div>
      <p>첫 개발에 동작을 확인할 테스트도 포함하세요. 검증 단계에서 테스트를 등록하면 다음 작업부터 원래 테스트를 고정해 보호할 수 있습니다.</p>
      {state?.provider!=='ready'&&<div className="notice"><p>{state?providerLabels[state.provider]:'연결 확인 중'} · 현재 코딩 실행기는 Codex입니다.</p><button disabled={!online||locked} onClick={()=>void props.onConnect()}>Codex 연결</button></div>}
      {active&&<article aria-label="진행 중인 작업"><b>{executionLabels[active.execution]}</b><p>{tasks.find(task=>task.id===active.taskId)?.title??'선택한 작업 공간에서 개발 중입니다.'}</p><pre>{active.response||'첫 응답을 기다리고 있습니다.'}</pre><details><summary>실행에 전달한 내용</summary><pre>{active.prompt}</pre></details><button disabled={!online||active.execution==='interrupting'} onClick={()=>void props.onInterrupt(active.id)}>현재 작업 중단</button></article>}
      {!tasks.length?<p>기획 단계에서 승인할 내용을 확인하고 작업을 준비하세요.</p>:tasks.map(task=>{const run=linked(task);return <article className="start-task" key={task.id}><h3>{task.title}</h3><p>{task.description}</p><ul>{task.acceptanceCriteria.map((value,i)=><li key={i}>{value}</li>)}</ul>
        {run&&<p>{executionLabels[run.execution]} · 검증 상태는 별도로 확인합니다.</p>}
        <button className="primary" disabled={!runnable} onClick={()=>{if(runnable)void props.onRunTask(task);}}>이 작업 개발하기</button>
        {run&&terminal(run.execution)&&<button onClick={()=>showRun(run,'verify')}>검증 단계로</button>}
      </article>;})}
    </section>}
    {step==='verify'&&<><section className="surface"><h2>실제로 동작하는지 확인하세요</h2><p>테스트 파일이 없으면 먼저 개발 작업에 테스트 작성을 요청하세요. 명령을 등록한 후 별도로 실행해야 검사 결과가 생깁니다.</p><button onClick={()=>setStep('develop')}>개발 작업으로</button><button onClick={()=>setStep('result')}>결과 미리보기로</button></section>
      <label className="start-run-select">검증할 실행<select value={selectedRun?.id??''} onChange={event=>setResultRunId(event.target.value)}><option value="">완료된 실행 선택</option>{runs.filter(run=>terminal(run.execution)).map(run=><option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString('ko-KR')} · {executionLabels[run.execution]} · {run.id.slice(0,8)}</option>)}</select></label>
      <VerificationPanel key={workspaceId+':'+selectedRun?.id} workspaceId={workspaceId} runId={selectedRun&&terminal(selectedRun.execution)?selectedRun.id:null} online={online} agentActive={locked} post={props.post}/></>}
    {step==='result'&&<><DevelopmentResultPanel projectId={projectId} workspaceId={workspaceId} runs={runs} selectedRun={selectedRun} onSelectRun={setResultRunId} online={online} locked={locked} refreshKey={scope.refreshKey} post={props.post}/>
      <section className="surface"><h2>결과를 확인하고 이어서 개선하세요</h2><p>화면과 실제 검사 결과를 함께 확인하세요. 추가 요구사항은 기획 단계에서 새 기획으로 남길 수 있습니다.</p><div className="start-actions"><button className="primary" onClick={()=>setStep('plan')}>추가 수정 요청</button><button onClick={()=>props.onNavigate('development')}>코드와 변경 보기</button><button onClick={()=>props.onNavigate('visualization')}>시각화와 문서</button><button onClick={()=>props.onNavigate('projects')}>프로젝트 열기</button></div></section></>}
  </div>;
}
