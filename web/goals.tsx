import {useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {GoalEvidenceReference,TrackedGoal,TrackedGoalView,TrackingState} from '../shared/goals.ts';
import type {PlanningVersion} from '../shared/parallel.ts';
import {createStudioMutator} from './studio-client.ts';

interface GoalScope {projectId:string|null;online:boolean}
type GoalFetch=(path:string,options:RequestInit)=>Promise<Response>;
type GoalPost=(path:string,body:Record<string,unknown>)=>Promise<unknown>;
type ReceiptStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export interface GoalTrackingState extends GoalScope {
  goals:TrackedGoalView[];plans:PlanningVersion[];selectedPlanId:string;
  loaded:boolean;loading:boolean;pending:'create'|'state'|null;error:string;message:string;
  history:{goalId:string;versions:TrackedGoal[]}|null;historyLoading:string|null;historyError:string;
}
const emptyState=(scope:GoalScope):GoalTrackingState=>({...scope,goals:[],plans:[],selectedPlanId:'',loaded:false,loading:false,pending:null,error:'',message:'',history:null,historyLoading:null,historyError:''});
const trackingStates:TrackingState[]=['tracking','paused','cancelled'];
const textArray=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
function validGoal(value:TrackedGoal,projectId:string){
  return !!value&&value.projectId===projectId&&typeof value.id==='string'&&!!value.id&&value.level==='tracking'&&trackingStates.includes(value.state)
    &&Number.isSafeInteger(value.revision)&&value.revision>0&&typeof value.planningVersionId==='string'&&typeof value.planningHash==='string'
    &&typeof value.createdAt==='string'&&typeof value.updatedAt==='string';
}
function validView(value:TrackedGoalView,projectId:string){
  return !!value&&validGoal(value.goal,projectId)&&typeof value.title==='string'&&typeof value.objective==='string'&&typeof value.planCurrent==='boolean'
    &&typeof value.evidenceScope==='string'&&textArray(value.blockers)&&Array.isArray(value.requirements)&&value.requirements.every(requirement=>
      !!requirement&&typeof requirement.label==='string'&&typeof requirement.description==='string'&&textArray(requirement.acceptanceCriteria)&&textArray(requirement.taskIds)
      &&requirement.acceptance==='unverified'&&Number.isSafeInteger(requirement.runsTotal)&&requirement.runsTotal>=0&&Array.isArray(requirement.runs)&&requirement.runs.every(run=>!!run&&typeof run.id==='string'&&typeof run.execution==='string')
      &&Number.isSafeInteger(requirement.evidenceTotal)&&requirement.evidenceTotal>=0&&Array.isArray(requirement.evidence)&&requirement.evidence.every(evidence=>
        !!evidence&&['run','check','review','approval','merge'].includes(evidence.kind)&&evidence.qualification==='reference_only'
        &&typeof evidence.id==='string'&&typeof evidence.runId==='string'&&typeof evidence.status==='string'&&(evidence.sourceDigest===null||typeof evidence.sourceDigest==='string')));
}
function validPlan(value:PlanningVersion,projectId:string){
  return !!value&&value.projectId===projectId&&typeof value.id==='string'&&!!value.id&&Number.isSafeInteger(value.revision)&&value.revision>0
    &&typeof value.contentHash==='string'&&['draft','approved','superseded'].includes(value.state)&&!!value.draft&&typeof value.draft.title==='string';
}
function approvedPlans(state:GoalTrackingState){
  return state.plans.filter(plan=>plan.projectId===state.projectId&&plan.state==='approved'&&!state.goals.some(view=>view.goal.projectId===state.projectId&&view.goal.planningVersionId===plan.id)&&!state.plans.some(other=>
    other.projectId===plan.projectId&&(other.lineageId??other.id)===(plan.lineageId??plan.id)&&other.revision>plan.revision));
}
const canAct=(state:GoalTrackingState)=>!!state.projectId&&state.online&&state.loaded&&!state.loading&&!state.pending;
const basePath=(projectId:string)=>'/api/projects/'+encodeURIComponent(projectId);

/** The mounted panel uses this coordinator; locks are synchronous and reads never dispatch work. */
export function createGoalTrackingCoordinator(deps:{post:GoalPost;get?:GoalFetch;storage?:ReceiptStorage}){
  const get=deps.get??((path,options)=>fetch(path,options));
  let state=emptyState({projectId:null,online:false}),active=false,generation=0,readSequence=0,historySequence=0;
  let readMode:'initial'|'refresh'|null=null,reader:AbortController|null=null,historyReader:AbortController|null=null;
  const listeners=new Set<()=>void>(),receipts=new Map<string,string>();
  // Preserve uncertain receipts in memory even if browser storage becomes unavailable.
  const storage:ReceiptStorage={
    getItem(key){let saved:string|null=null;try{saved=deps.storage?.getItem(key)??null;}catch{}return receipts.get(key)??saved;},
    setItem(key,value){receipts.set(key,value);try{deps.storage?.setItem(key,value);}catch{}},
    removeItem(key){receipts.delete(key);try{deps.storage?.removeItem(key);}catch{}},
  };
  function update(next:Partial<GoalTrackingState>){state={...state,...next};for(const listener of listeners)listener();}
  const currentScope=(ticket:number,projectId:string)=>active&&generation===ticket&&state.projectId===projectId&&state.online;
  function invalidateHistory(){historySequence++;historyReader?.abort();historyReader=null;update({history:null,historyLoading:null,historyError:''});}
  async function read(mode:'initial'|'refresh'){
    if(!active||!state.projectId||!state.online||state.pending||readMode==='refresh')return;
    const projectId=state.projectId,ticket=generation,sequence=++readSequence;
    const current=()=>currentScope(ticket,projectId)&&sequence===readSequence;
    reader?.abort();const controller=new AbortController();reader=controller;readMode=mode;invalidateHistory();update({loading:true,loaded:false,error:''});
    try{
      const options={method:'GET',cache:'no-store',signal:controller.signal} satisfies RequestInit;
      const responses=await Promise.all([get(basePath(projectId)+'/goals',options),get(basePath(projectId)+'/plans',options)]);
      if(responses.some(response=>!response.ok))throw new Error('Goal read failed');
      const [goals,plans]=await Promise.all(responses.map(response=>response.json())) as [TrackedGoalView[],PlanningVersion[]];
      if(!current())return;
      if(!Array.isArray(goals)||!goals.every(goal=>validView(goal,projectId))||!Array.isArray(plans)||!plans.every(plan=>validPlan(plan,projectId)))throw new Error('Goal scope mismatch');
      const next={...state,goals,plans};
      update({goals,plans,loaded:true,selectedPlanId:approvedPlans(next).some(plan=>plan.id===state.selectedPlanId)?state.selectedPlanId:''});
    }catch{
      if(current())update({loaded:false,error:'목표 추적을 불러오지 못했습니다. 서버 연결을 확인하고 새로고침하세요. 최신 상태를 확인할 때까지 변경할 수 없습니다.'});
    }finally{
      if(current()){readMode=null;reader=null;update({loading:false});}
    }
  }
  async function change(kind:'create'|'state',goalId?:string,target?:TrackingState){
    if(!active||!canAct(state))return;
    const projectId=state.projectId!,ticket=generation,selected=approvedPlans(state).find(plan=>plan.id===state.selectedPlanId);
    const goal=state.goals.find(view=>view.goal.id===goalId)?.goal;
    if(kind==='create'&&!selected)return;
    if(kind==='state'&&(!goal||!target||!trackingStates.includes(target)||goal.state==='cancelled'||goal.state===target))return;
    const path=basePath(projectId)+'/goals'+(kind==='state'?'/'+encodeURIComponent(goal!.id)+'/state':'');
    const body:Record<string,unknown>=kind==='create'?{planningVersionId:selected!.id,expectedPlanningHash:selected!.contentHash}:{expectedRevision:goal!.revision,state:target};
    const current=()=>currentScope(ticket,projectId);
    invalidateHistory();update({pending:kind,error:'',message:''});
    // A per-action closure checks the scope after async hashing, before the actual POST.
    const mutate=createStudioMutator(async(url,data)=>{
      if(!current())throw new Error('Goal scope changed');
      const result=await deps.post(url,data) as TrackedGoal;
      if(!validGoal(result,projectId)||result.planningVersionId!==(selected&&kind==='create'?selected.id:goal!.planningVersionId)
        ||result.planningHash!==(selected&&kind==='create'?selected.contentHash:goal!.planningHash)
        ||(kind==='create'?(result.state!=='tracking'||result.revision!==1):(result.id!==goal!.id||result.state!==target||result.revision!==goal!.revision+1)))throw new Error('Unexpected goal acknowledgement');
      return result;
    },storage);
    let acknowledged=false;
    try{
      await mutate(path,body);
      if(!current())return;
      acknowledged=true;update({loaded:false,selectedPlanId:kind==='create'?'':state.selectedPlanId,message:'추적 요청의 저장 응답을 확인했습니다. 최신 기록을 다시 조회합니다.'});
    }catch{
      if(current())update({error:'추적 요청 결과를 확인하지 못했습니다. 새로고침으로 저장 상태를 확인하거나 같은 요청을 다시 시도하세요.'});
    }finally{
      if(current())update({pending:null});
    }
    // A receipt may describe an older revision. Only a fresh GET supplies the displayed state.
    if(acknowledged&&current())await read('refresh');
  }
  return {
    getSnapshot:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async setScope(scope:GoalScope){
      if(active&&scope.projectId===state.projectId&&scope.online===state.online)return;
      generation++;readSequence++;historySequence++;reader?.abort();historyReader?.abort();readMode=null;active=true;update(emptyState(scope));
      if(scope.projectId&&scope.online)await read('initial');
    },
    refresh:()=>read('refresh'),
    selectPlan(id:string){if(active&&canAct(state))update({selectedPlanId:approvedPlans(state).some(plan=>plan.id===id)?id:'',error:'',message:''});},
    create:()=>change('create'),
    setState:(goalId:string,target:TrackingState)=>change('state',goalId,target),
    async showHistory(goalId:string){
      if(!active||!canAct(state)||state.historyLoading)return;
      const goal=state.goals.find(view=>view.goal.id===goalId)?.goal;if(!goal)return;
      const projectId=state.projectId!,ticket=generation,sequence=++historySequence;
      const current=()=>currentScope(ticket,projectId)&&sequence===historySequence;
      const controller=new AbortController();historyReader=controller;update({history:null,historyLoading:goalId,historyError:''});
      try{
        const response=await get(basePath(projectId)+'/goals/'+encodeURIComponent(goalId)+'/history',{method:'GET',cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('Goal history read failed');const versions=await response.json() as TrackedGoal[];
        if(!current())return;
        if(!Array.isArray(versions)||!versions.every(version=>validGoal(version,projectId)&&version.id===goalId&&version.planningVersionId===goal.planningVersionId&&version.planningHash===goal.planningHash))throw new Error('Goal history scope mismatch');
        update({history:{goalId,versions}});
      }catch{if(current())update({historyError:'변경 이력을 불러오지 못했습니다. 변경 이력 버튼으로 다시 조회하세요.'});}
      finally{if(current()){historyReader=null;update({historyLoading:null});}}
    },
    dispose(){active=false;generation++;readSequence++;historySequence++;reader?.abort();historyReader?.abort();readMode=null;},
  };
}

const stateLabels:Record<TrackingState,string>={tracking:'추적 중',paused:'추적 일시정지',cancelled:'추적 취소됨'};
const runLabels:Record<string,string>={starting:'시작 중',running:'실행 중',interrupting:'중단 중',completed:'실행 완료',failed:'실행 실패',interrupted:'중단',lost:'상태 유실'};
const evidenceLabels:Record<GoalEvidenceReference['kind'],string>={run:'실행',check:'검증',review:'리뷰',approval:'승인',merge:'병합'};
const blockerLabels:Record<string,string>={ACCEPTANCE_NOT_QUALIFIED:'신뢰할 수 있는 요구사항 수용 판정이 아직 없습니다.',PLAN_NOT_CURRENT:'기획이 개정되어 이 목표의 연결 버전은 현재 기획이 아닙니다.',RUN_RECOVERY_UNRESOLVED:'상태가 유실된 실행이 있습니다. 복구 상태를 확인해야 합니다.',EVIDENCE_RECOVERY_UNRESOLVED:'연결된 검증 기록에 복구가 필요한 상태가 있습니다. 개발 화면에서 확인하세요.'};
function evidenceStatus(evidence:GoalEvidenceReference){return evidence.kind==='check'?(evidence.status==='passed'?'검증 통과':evidence.status==='failed'?'검증 실패':runLabels[evidence.status]??evidence.status):evidence.status;}
const timestamp=(value:string)=>Number.isNaN(Date.parse(value))?value:new Date(value).toLocaleString('ko-KR');
interface GoalTrackingViewProps {
  state:GoalTrackingState;onRefresh:()=>void;onSelectPlan:(id:string)=>void;onCreate:()=>void;
  onSetState:(goalId:string,state:TrackingState)=>void;onHistory:(goalId:string)=>void;
}
export function GoalTrackingView({state,onRefresh,onSelectPlan,onCreate,onSetState,onHistory}:GoalTrackingViewProps){
  const {projectId,online,loading,pending}=state,idle=canAct(state),plans=approvedPlans(state),selected=plans.find(plan=>plan.id===state.selectedPlanId);
  const goals=state.goals.filter(view=>view.goal.projectId===projectId);
  return <section className="surface workflows-panel" aria-label="Goal Tracking" aria-busy={loading||pending!==null}>
    <div className="section-heading"><h2>Goal Tracking · 목표 추적</h2><button disabled={!projectId||!online||loading||!!pending} onClick={onRefresh}>새로고침</button></div>
    <p>승인된 기획에 목표를 연결해 요구사항과 저장된 근거를 확인합니다. 추적을 만들거나 재개해도 에이전트·모델·도구를 실행하지 않습니다.</p>
    {!projectId?<p>프로젝트를 선택하면 목표를 추적할 수 있습니다.</p>:!online?<p>서버 연결 후 목표 추적을 조회하고 변경할 수 있습니다.</p>:<>
      {loading&&<p role="status">목표 추적을 불러오는 중…</p>}
      {pending&&<p role="status">추적 요청을 저장하는 중…</p>}
      {state.error&&<p role="alert">{state.error}</p>}{state.message&&<p role="status">{state.message}</p>}
      <label>현재 승인된 기획 <select aria-label="추적할 승인 기획" style={{display:'block',width:'100%',minWidth:0,margin:'8px 0 14px'}} disabled={!idle} value={state.selectedPlanId} onChange={event=>onSelectPlan(event.target.value)}>
        <option value="">기획을 직접 선택하세요</option>{plans.map(plan=><option key={plan.id} value={plan.id}>{plan.draft.title} · v{plan.revision} · {plan.id}</option>)}
      </select></label>
      <div className="actions"><button className="primary" disabled={!idle||!selected} onClick={onCreate}>목표 추적 만들기</button></div>
      {state.loaded&&plans.length===0&&<p>새로 추적할 현재 승인 기획이 없습니다. 이미 연결한 기획은 아래 목표에서 확인하세요. 새 기획은 Planning Studio에서 저장하고 승인할 수 있습니다.</p>}
      <p className="subtle">수용 판정: 미확인. 실행 완료나 과거 검증 통과는 목표 달성을 뜻하지 않습니다. 추적 일시정지·취소는 실행 중인 작업을 중단하지 않습니다.</p>
      {state.loaded&&goals.length===0&&<p>저장된 목표 추적이 없습니다.</p>}
      {goals.length>0&&!state.loaded&&<p className="subtle">아래는 마지막으로 조회한 기록입니다. 현재 상태를 다시 확인해야 합니다.</p>}
      {goals.map(view=>{const {goal}=view;return <article key={goal.id} className="workflow-preview" style={{overflowWrap:'anywhere'}}>
        <div className="section-heading"><h3>{view.title}</h3><span className="badge">{stateLabels[goal.state]}</span></div>
        <p>{view.objective}</p><p className="subtle">목표 {goal.id} · 개정 {goal.revision} · {timestamp(goal.updatedAt)}</p>
        <p><b>{view.planCurrent?'현재 승인 기획':'이전 기획 · 현재성 상실'}</b> · {goal.planningVersionId}</p>
        {!view.planCurrent&&<p className="subtle">이 목표는 기존 기획에 연결된 기록입니다. 새 기획은 별도의 목표 추적으로 연결하세요.</p>}
        <details><summary>기획 연결 정보</summary><p className="subtle">기획 해시: <code>{goal.planningHash}</code></p><p className="subtle">생성: {timestamp(goal.createdAt)}</p></details>
        <div className="actions">
          {goal.state!=='cancelled'&&<><button disabled={!idle} onClick={()=>onSetState(goal.id,goal.state==='paused'?'tracking':'paused')}>{goal.state==='paused'?'추적 재개':'추적 일시정지'}</button><button disabled={!idle} onClick={()=>onSetState(goal.id,'cancelled')}>추적 취소</button></>}
          <button disabled={!idle||!!state.historyLoading} onClick={()=>onHistory(goal.id)}>변경 이력</button>
        </div>
        {goal.state==='cancelled'&&<p className="subtle">취소된 추적은 재개할 수 없습니다. 저장된 기록은 유지됩니다.</p>}
        {view.blockers.length>0&&<details open><summary>미해결 사항</summary><ul>{view.blockers.map((blocker,index)=><li key={index}>{blockerLabels[blocker]??blocker}</li>)}</ul></details>}
        <h4>요구사항 · 수용 판정 미확인</h4>
        {view.requirements.length===0?<p>연결된 요구사항이 없습니다.</p>:view.requirements.map((requirement,index)=><details key={requirement.label+index} open>
          <summary>{requirement.label} · 수용 판정 미확인</summary><p>{requirement.description}</p>
          <p className="subtle">수용 조건</p><ul>{requirement.acceptanceCriteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul>
          <p className="subtle">연결 Task: {requirement.taskIds.join(', ')||'없음'}</p>
          <p className="subtle">과거 실행 · 참조 전용 · 실행 기록 {requirement.runsTotal}개 중 {requirement.runs.length}개 표시</p>{requirement.runs.length===0?<p>연결된 실행이 없습니다.</p>:<ul>{requirement.runs.map(run=><li key={run.id}>{run.id} · {runLabels[run.execution]??run.execution}</li>)}</ul>}
          <p className="subtle">과거 근거 · 참조 전용 · {requirement.evidence.length} / {requirement.evidenceTotal}개 표시</p>
          {requirement.evidence.length===0?<p>표시할 근거가 없습니다.</p>:<ul>{requirement.evidence.map((evidence,index)=><li key={evidence.kind+evidence.id+index}>
            {evidenceLabels[evidence.kind]} {evidence.id} · {evidenceStatus(evidence)} · 참조 전용<br/><small>실행 {evidence.runId} · 소스 {evidence.sourceDigest??'미확인'}</small>
          </li>)}</ul>}
        </details>)}
        <p className="subtle">근거 범위: {view.evidenceScope}</p>
        {state.historyLoading===goal.id&&<p role="status">변경 이력을 불러오는 중…</p>}
        {state.history?.goalId===goal.id&&<details open><summary>저장된 변경 이력</summary><ol>{state.history.versions.map(version=><li key={version.revision}>개정 {version.revision} · {stateLabels[version.state]} · {timestamp(version.updatedAt)}</li>)}</ol><p className="subtle">각 변경 시점의 추적 상태입니다.</p></details>}
      </article>;})}
      {state.historyError&&<p role="alert">{state.historyError}</p>}
    </>}
  </section>;
}

export function GoalTrackingPanel({projectId,online,post}:{projectId:string|null;online:boolean;post:(path:string,body:object)=>Promise<unknown>}){
  const postRef=useRef(post);postRef.current=post;
  const [coordinator]=useState(()=>{
    let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{}
    return createGoalTrackingCoordinator({post:(path,body)=>postRef.current(path,body),storage});
  });
  const state=useSyncExternalStore(coordinator.subscribe,coordinator.getSnapshot,coordinator.getSnapshot);
  useLayoutEffect(()=>{void coordinator.setScope({projectId,online});return()=>coordinator.dispose();},[coordinator,projectId,online]);
  const visible=state.projectId===projectId&&state.online===online?state:emptyState({projectId,online});
  return <GoalTrackingView state={visible} onRefresh={()=>void coordinator.refresh()} onSelectPlan={coordinator.selectPlan} onCreate={()=>void coordinator.create()} onSetState={(id,value)=>void coordinator.setState(id,value)} onHistory={id=>void coordinator.showHistory(id)}/>;
}
