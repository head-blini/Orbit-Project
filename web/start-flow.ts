import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

export interface StartFlowScope {projectId:string;workspaceId:string|null;online:boolean;blocked:boolean;refreshKey:string;
  /** A general (non-Git) project prepares tasks without a workspace. */
  general?:boolean}
export interface StartFlowState {scope:StartFlowScope;plans:PlanningVersion[];tasks:SavedTask[];selectedPlanId:string|null;loading:boolean;fresh:boolean;action:null|'prepare';uncertain:boolean;error:string}
interface Dependencies {get(path:string):Promise<unknown>;post(path:string,body:Record<string,unknown>):Promise<unknown>;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):value is string=>typeof value==='string';
const id=(value:unknown):value is string=>text(value)&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(text);
function validPlan(value:unknown,projectId:string):value is PlanningVersion {
  if(!object(value)||!id(value.id)||value.projectId!==projectId||!Number.isSafeInteger(value.revision)||(value.revision as number)<1
    ||!text(value.contentHash)||!/^[a-f0-9]{64}$/.test(value.contentHash)||!['draft','approved','superseded'].includes(value.state as string)
    ||(value.lineageId!==undefined&&!id(value.lineageId))||!object(value.draft)
    ||['createdAt','approvedAt','approvedBy'].some(field=>value[field]!==undefined&&!text(value[field])))return false;
  const draft=value.draft;
  if(draft.provenance!==undefined){
    const provenance=draft.provenance;
    if(!object(provenance)||!text(provenance.kind)||(provenance.providerId!==null&&!text(provenance.providerId))
      ||(provenance.externalUrl!==null&&!text(provenance.externalUrl))||(provenance.author!==undefined&&!text(provenance.author))
      ||(provenance.references!==undefined&&(!Array.isArray(provenance.references)||!provenance.references.every(reference=>object(reference)&&text(reference.title)&&text(reference.url)))))return false;
  }
  return draft.schemaVersion==='1.0'&&text(draft.title)&&text(draft.goal)&&['manual','import'].includes(draft.source as string)
    &&strings(draft.constraints)&&strings(draft.openQuestions)&&Array.isArray(draft.requirements)
    &&draft.requirements.every(requirement=>object(requirement)&&id(requirement.label)&&text(requirement.description)&&strings(requirement.acceptanceCriteria))
    &&new Set(draft.requirements.map(requirement=>requirement.label)).size===draft.requirements.length
    &&(draft.decisions===undefined||(Array.isArray(draft.decisions)&&draft.decisions.every(decision=>object(decision)&&text(decision.topic)&&text(decision.decision)&&text(decision.rationale))));
}
function validTasks(value:unknown,plans:PlanningVersion[],projectId:string):value is SavedTask[] {
  return Array.isArray(value)&&value.every(task=>{
    if(!object(task)||!id(task.id)||task.projectId!==projectId||!id(task.planningVersionId)||task.state!=='draft'||task.verification!=='not_run'
      ||!text(task.title)||!text(task.description)||!text(task.createdAt)||!strings(task.acceptanceCriteria)||!task.acceptanceCriteria.length
      ||!strings(task.requirementLabels)||!task.requirementLabels.length)return false;
    if(task.replannedFrom!==undefined&&(!object(task.replannedFrom)||!id(task.replannedFrom.planningVersionId)
      ||!strings(task.replannedFrom.taskIds)||!task.replannedFrom.taskIds.every(id)))return false;
    const plan=plans.find(plan=>plan.id===task.planningVersionId);
    return !!plan&&plan.state==='approved'&&task.requirementLabels.every(label=>plan.draft.requirements.some(requirement=>requirement.label===label));
  })&&new Set(value.map(task=>task.id)).size===value.length;
}
const ready=(plan:PlanningVersion)=>!plan.draft.openQuestions.length&&!!plan.draft.title.trim()&&!!plan.draft.goal.trim()
  &&plan.draft.requirements.length>0&&plan.draft.requirements.every(requirement=>!!requirement.description.trim()&&requirement.acceptanceCriteria.length>0&&requirement.acceptanceCriteria.every(criterion=>!!criterion.trim()))
  &&(!plan.draft.decisions||plan.draft.decisions.every(decision=>!!decision.topic.trim()&&!!decision.decision.trim()&&!!decision.rationale.trim()));

/** Repository rows are in creation order; approval does not make an ancestor current. */
export function currentStartPlans(plans:PlanningVersion[],projectId:string):PlanningVersion[]{
  const heads=new Map<string,PlanningVersion>();
  for(const plan of plans){
    if(!validPlan(plan,projectId))continue;
    const lineage=plan.lineageId??plan.id,previous=heads.get(lineage);
    if(!previous||plan.revision>=previous.revision)heads.set(lineage,plan);
  }
  return plans.filter(plan=>plan.projectId===projectId&&heads.get(plan.lineageId??plan.id)===plan&&plan.state!=='superseded');
}
export function createStartFlowCoordinator(initial:StartFlowScope,deps:Dependencies){
  let scope={...initial},live=false,epoch=0,sequence=0;
  const listeners=new Set<()=>void>(),memory=new Map<string,string>();
  const key=(value:StartFlowScope)=>'orbit.start.uncertain.'+encodeURIComponent(JSON.stringify([value.projectId,value.workspaceId]));
  function uncertain(value:StartFlowScope){try{return (deps.storage?.getItem(key(value))??memory.get(key(value)))==='1';}catch{return memory.get(key(value))==='1';}}
  function remember(value:StartFlowScope,enabled:boolean){
    if(enabled)memory.set(key(value),'1');else memory.delete(key(value));
    try{if(enabled)deps.storage?.setItem(key(value),'1');else deps.storage?.removeItem(key(value));}catch{}
  }
  let state:StartFlowState={scope,plans:[],tasks:[],selectedPlanId:null,loading:false,fresh:false,action:null,uncertain:uncertain(scope),error:''};
  const publish=(next:Partial<StartFlowState>)=>{state={...state,...next};for(const listener of listeners)listener();};
  const token=()=>({epoch,sequence:++sequence});
  const current=(request:ReturnType<typeof token>)=>live&&request.epoch===epoch&&request.sequence===sequence;
  const path=(value:StartFlowScope)=>'/api/projects/'+encodeURIComponent(value.projectId);
  return {
    getSnapshot:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    activate(){if(!live){live=true;epoch++;publish({fresh:false,uncertain:uncertain(scope)});}},
    dispose(){live=false;epoch++;sequence++;publish({fresh:false,action:null,loading:false,uncertain:uncertain(scope)});},
    configure(next:StartFlowScope){
      const changed=scope.projectId!==next.projectId||scope.workspaceId!==next.workspaceId;
      const gateChanged=changed||scope.online!==next.online||scope.blocked!==next.blocked;
      if(!gateChanged&&scope.refreshKey===next.refreshKey)return;
      scope={...next};
      // Approval itself emits an SSE update. That event cannot cancel the explicit operation.
      if(!gateChanged&&state.action){publish({scope});return;}
      epoch++;sequence++;
      publish({scope,fresh:false,loading:false,action:null,uncertain:uncertain(scope),error:'',...(changed?{plans:[],tasks:[],selectedPlanId:null}:{})});
    },
    async refresh(manual=false){
      if(!live||!scope.online||!scope.projectId||state.action||state.loading)return;
      const request=token(),requestScope={...scope};publish({loading:true,error:''});
      try{
        const [plans,tasks]=await Promise.all([deps.get(path(requestScope)+'/plans'),deps.get(path(requestScope)+'/tasks')]);
        if(!current(request))return;
        if(!Array.isArray(plans)||!plans.every(plan=>validPlan(plan,requestScope.projectId))||new Set(plans.map(plan=>plan.id)).size!==plans.length
          ||!validTasks(tasks,plans,requestScope.projectId))throw Error('INVALID_START_STATE');
        const heads=currentStartPlans(plans,requestScope.projectId);
        const selectedPlanId=heads.some(plan=>plan.id===state.selectedPlanId)?state.selectedPlanId:heads.at(-1)?.id??null;
        if(manual)remember(requestScope,false);
        publish({plans,tasks,selectedPlanId,fresh:true,uncertain:manual?false:state.uncertain});
      }catch{if(current(request))publish({fresh:false,error:'기획과 작업 상태를 확인하지 못했습니다. 상태 새로고침으로 다시 확인하세요.'});}
      finally{if(current(request))publish({loading:false});}
    },
    selectPlan(selectedPlanId:string){
      if(!live||state.action||!currentStartPlans(state.plans,scope.projectId).some(plan=>plan.id===selectedPlanId))return;
      publish({selectedPlanId,error:''});
    },
    async prepareTasks():Promise<boolean>{
      if(!live||!scope.online||(!scope.workspaceId&&!scope.general)||scope.blocked||state.action||state.loading||!state.fresh||state.uncertain)return false;
      const selected=currentStartPlans(state.plans,scope.projectId).find(plan=>plan.id===state.selectedPlanId);
      if(!selected||!ready(selected))return false;
      if(selected.state==='approved'&&selected.draft.requirements.every(requirement=>state.tasks.some(task=>task.planningVersionId===selected.id&&task.requirementLabels.includes(requirement.label))))return true;
      const request=token(),requestScope={...scope};publish({action:'prepare',error:''});
      remember(requestScope,true);
      try{
        let approved=selected;
        const endpoint=path(requestScope)+'/plans/'+encodeURIComponent(selected.id);
        if(selected.state==='draft'){
          const response=await deps.post(endpoint+'/approve',{expectedRevision:selected.revision});
          if(!current(request))return false;
          if(!validPlan(response,requestScope.projectId)||response.id!==selected.id||response.revision!==selected.revision
            ||response.contentHash!==selected.contentHash||response.state!=='approved'||response.lineageId!==selected.lineageId
            ||JSON.stringify(response.draft)!==JSON.stringify(selected.draft))throw Error('INVALID_APPROVAL_RESPONSE');
          approved=response;publish({plans:state.plans.map(plan=>plan.id===approved.id?approved:plan)});
        }
        if(!current(request)||!scope.online||scope.blocked||scope.workspaceId!==requestScope.workspaceId)return false;
        const tasks=await deps.post(endpoint+'/task-drafts',{});
        if(!current(request))return false;
        if(!validTasks(tasks,[approved],requestScope.projectId)||!tasks.length
          ||!approved.draft.requirements.every(requirement=>tasks.some(task=>task.requirementLabels.includes(requirement.label))))throw Error('INVALID_TASK_RESPONSE');
        remember(requestScope,false);
        publish({tasks:[...state.tasks.filter(task=>task.planningVersionId!==approved.id),...tasks],uncertain:false,fresh:true});
        return true;
      }catch{
        if(current(request))publish({uncertain:true,fresh:false,error:'작업 준비 요청의 결과를 확인하지 못했습니다. 상태 새로고침을 직접 눌러 확인하세요. 자동 재전송하지 않습니다.'});
        return false;
      }finally{if(current(request))publish({action:null});}
    },
  };
}
