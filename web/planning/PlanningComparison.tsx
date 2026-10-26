import {useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {PlanningVersion} from '../../shared/parallel.ts';
import type {PlanningComparison,PlanningComparisonProps,PlanningRequirement,PlanningVersionIdentity} from '../../shared/planning-revisions.ts';
import './comparison.css';

const lineage=(version:PlanningVersion)=>version.lineageId??version.id;
const sameIdentity=(left:PlanningVersionIdentity,right:PlanningVersionIdentity)=>left.id===right.id&&left.revision===right.revision&&left.contentHash===right.contentHash&&left.state===right.state;

export function planningComparisonChoices(projectId:string,versions:readonly PlanningVersion[],selected?:PlanningVersion){
  if(!selected||selected.projectId!==projectId||!versions.some(row=>row.projectId===projectId&&sameIdentity(row,selected)&&lineage(row)===lineage(selected)))return [];
  return versions.filter(row=>row.projectId===projectId&&lineage(row)===lineage(selected)&&row.id!==selected.id&&row.revision<selected.revision)
    .sort((left,right)=>right.revision-left.revision||left.id.localeCompare(right.id));
}

type PanelScope=Pick<PlanningComparisonProps,'projectId'|'versions'|'selected'|'dirty'|'busy'>;
/** A new saved head or editor scope must discard the preview and its consent together. */
export function planningComparisonScopeKey({projectId,versions,selected,dirty,busy}:PanelScope){
  const identity=(version:PlanningVersion)=>[version.projectId,version.id,version.revision,version.contentHash,version.state,lineage(version)];
  return JSON.stringify([projectId,selected?identity(selected):null,dirty,busy,versions.map(identity).sort((left,right)=>String(left[1]).localeCompare(String(right[1])))]);
}

interface ComparisonScope {projectId:string;base?:PlanningVersion;target?:PlanningVersion;dirty:boolean;busy:boolean}
type Callbacks=Pick<PlanningComparisonProps,'onCompare'|'onReplan'>;
interface ComparisonState {preview:PlanningComparison|null;selectedLabels:string[];consent:boolean;pending:'compare'|'replan'|null;error:string;message:string}
const emptyState=():ComparisonState=>({preview:null,selectedLabels:[],consent:false,pending:null,error:'',message:''});
const availableLabels=(comparison:PlanningComparison)=>[...new Set(comparison.availableLabels)].filter(label=>!comparison.existingLabels.includes(label));
const selectionValid=(comparison:PlanningComparison,labels:readonly string[])=>labels.length>0&&labels.length<=100&&new Set(labels).size===labels.length&&labels.every(label=>availableLabels(comparison).includes(label));
const previewAllowsReplan=(comparison:PlanningComparison)=>comparison.targetCurrent&&comparison.canReplan&&comparison.target.state==='approved';
function canCompare(scope:ComparisonScope){
  const {projectId,base,target,dirty,busy}=scope;
  return !dirty&&!busy&&!!base&&!!target&&base.projectId===projectId&&target.projectId===projectId&&base.id!==target.id&&lineage(base)===lineage(target)&&base.revision<target.revision;
}
function matchesPreview(value:PlanningComparison,scope:ComparisonScope){
  return !!scope.base&&!!scope.target&&value?.projectId===scope.projectId&&!!value.base&&!!value.target&&sameIdentity(value.base,scope.base)&&sameIdentity(value.target,scope.target)
    &&typeof value.previewDigest==='string'&&value.previewDigest.length>0;
}

/** The actual UI uses this coordinator: requests never rely on delayed React busy state. */
export function createPlanningComparisonCoordinator(scope:ComparisonScope,callbacks:Callbacks){
  let live=false,epoch=0,state=emptyState();
  const subscribers=new Set<()=>void>();
  const publish=(next:Partial<ComparisonState>)=>{state={...state,...next};for(const subscriber of subscribers)subscriber();};
  const current=(token:number)=>live&&epoch===token;
  const allowed=()=>canCompare(scope)&&scope.target?.state==='approved'&&!scope.target.draft.openQuestions.length&&!!state.preview&&previewAllowsReplan(state.preview);
  function begin(kind:'compare'|'replan'){
    if(!live||state.pending||!canCompare(scope))return null;
    const token=++epoch;publish({pending:kind,error:'',message:'',consent:false});return token;
  }
  async function freshPreview(){
    const value=await callbacks.onCompare(scope.projectId,scope.target!.id,scope.base!.id);
    if(!matchesPreview(value,scope))throw new Error('PLANNING_COMPARISON_SCOPE_MISMATCH');
    return value;
  }
  return {
    getSnapshot:()=>state,
    subscribe(listener:()=>void){subscribers.add(listener);return()=>{subscribers.delete(listener);};},
    activate(){if(!live){live=true;epoch++;}},
    dispose(){live=false;epoch++;publish(emptyState());},
    async compare(){
      const token=begin('compare');if(token===null)return;
      publish({preview:null,selectedLabels:[]});
      try{const value=await freshPreview();if(current(token))publish({preview:value});}
      catch{if(current(token))publish({error:'저장 버전 비교 결과를 확인하지 못했습니다. 저장 상태를 확인하고 다시 비교하세요.'});}
      finally{if(current(token))publish({pending:null});}
    },
    select(label:string,checked:boolean){
      if(!live||state.pending||!allowed()||!state.preview||!availableLabels(state.preview).includes(label))return;
      const selected=state.selectedLabels.filter(value=>value!==label);
      if(checked){if(selected.length>=100)return;selected.push(label);}
      publish({selectedLabels:selected,consent:false,error:'',message:''});
    },
    consent(checked:boolean){
      if(!live||state.pending)return;
      publish({consent:checked&&allowed()&&!!state.preview&&selectionValid(state.preview,state.selectedLabels)});
    },
    async replan(){
      const preview=state.preview,labels=[...state.selectedLabels];
      if(!allowed()||!preview||!state.consent||!selectionValid(preview,labels))return;
      const token=begin('replan');if(token===null)return;
      let acknowledged=false;
      try{
        const tasks=await callbacks.onReplan(scope.projectId,scope.target!.id,{baseVersionId:scope.base!.id,expectedPreviewDigest:preview.previewDigest,requirementLabels:labels});
        if(!current(token))return;
        acknowledged=true;
        publish({preview:null,selectedLabels:[],consent:false,message:`후속 Task 초안 ${tasks.length}개를 확인했습니다. 에이전트와 모델은 실행되지 않았습니다.`});
        const refreshed=await freshPreview();
        if(current(token))publish({preview:refreshed});
      }catch{
        if(current(token))publish({preview:null,selectedLabels:[],consent:false,error:acknowledged
          ?'Task 초안은 생성됐으나 최신 비교를 불러오지 못했습니다. 다시 비교한 뒤 후속 작업을 선택하세요.'
          :'후속 Task 생성 결과를 확인하지 못했습니다. 다시 비교해 현재 기획과 기존 Task를 확인하세요.'});
      }finally{if(current(token))publish({pending:null});}
    },
  };
}

export function PlanningComparisonPanel(props:PlanningComparisonProps){
  return <ScopedPlanningComparison key={planningComparisonScopeKey(props)} {...props}/>;
}
function ScopedPlanningComparison(props:PlanningComparisonProps){
  const choices=planningComparisonChoices(props.projectId,props.versions,props.selected);
  const [baseId,setBaseId]=useState(()=>choices[0]?.id??'');
  const base=choices.find(version=>version.id===baseId);
  return <section className="planning-comparison" aria-label="저장 기획 버전 비교">
    <h3>저장 기획 버전 비교</h3>
    <p>이전 버전과 변경 내용을 비교하고, 필요한 요구사항의 후속 Task 초안을 선택해 만듭니다. 기존 Task와 실행 기록은 유지됩니다.</p>
    <label>비교 기준 버전<select value={baseId} disabled={props.busy||props.dirty||!choices.length} onChange={event=>setBaseId(event.target.value)}>
      {!choices.length&&<option value="">이전 저장 버전 없음</option>}
      {choices.map(version=><option key={version.id} value={version.id}>{version.draft.title||'제목 없음'} · r{version.revision} · {version.id}</option>)}
    </select></label>
    {props.selected&&<p>비교 대상: r{props.selected.revision} · {props.selected.state} · {props.selected.id}</p>}
    {props.dirty&&<p>편집 내용을 새 버전으로 저장한 뒤 비교하세요.</p>}
    {!choices.length&&<p>같은 프로젝트·계보에 속한 이전 저장 버전이 있어야 비교할 수 있습니다.</p>}
    <PlanningComparisonSession key={baseId} {...props} base={base}/>
  </section>;
}
function PlanningComparisonSession({base,...props}:PlanningComparisonProps&{base?:PlanningVersion}){
  const callbacks=useRef(props);callbacks.current=props;
  // The enclosing keys cover every scope field and base id. Callback identity
  // changes alone must not clear a preview or repeat an already pending request.
  const coordinator=useMemo(()=>createPlanningComparisonCoordinator({projectId:props.projectId,base,target:props.selected,dirty:props.dirty,busy:props.busy},{
    onCompare:(...args)=>callbacks.current.onCompare(...args),onReplan:(...args)=>callbacks.current.onReplan(...args),
  }),[]);
  const state=useSyncExternalStore(coordinator.subscribe,coordinator.getSnapshot,coordinator.getSnapshot);
  useLayoutEffect(()=>{coordinator.activate();return()=>coordinator.dispose();},[coordinator]);
  const disabled=props.dirty||props.busy||!!state.pending;
  return <div aria-busy={!!state.pending}>
    <button disabled={disabled||!base||!props.selected} onClick={()=>void coordinator.compare()}>저장 버전 비교</button>
    {state.pending&&<p role="status">{state.pending==='compare'?'저장 버전을 비교하는 중…':'후속 Task 초안을 만들고 최신 비교를 확인하는 중…'}</p>}
    {state.error&&<p role="alert">{state.error}</p>}{state.message&&<p role="status">{state.message}</p>}
    {state.preview&&<PlanningComparisonPreview comparison={state.preview} selectedLabels={state.selectedLabels} consent={state.consent} disabled={disabled}
      onSelect={coordinator.select} onConsent={coordinator.consent} onCreate={()=>void coordinator.replan()}/>}
  </div>;
}

const fieldTitles={title:'제목',goal:'목표',constraints:'제약 사항',openQuestions:'미결정 사항',source:'출처',requirementOrder:'요구사항 순서'};
const changeTitles={added:'추가',removed:'삭제',changed:'변경',unchanged:'동일'};
const reasonTitles={requirement_changed:'요구사항 변경',requirement_removed:'요구사항 삭제',plan_context_changed:'기획 맥락 변경'};
function FieldValue({value}:{value:string|string[]}){
  return Array.isArray(value)?value.length?<ol>{value.map((item,index)=><li key={index}>{item}</li>)}</ol>:<span>없음</span>:<p>{value||'없음'}</p>;
}
function RequirementValue({value}:{value:PlanningRequirement|null}){
  return value?<><p>{value.description}</p><ul>{value.acceptanceCriteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul></>:<span>없음</span>;
}
interface PreviewProps {comparison:PlanningComparison;selectedLabels:readonly string[];consent:boolean;disabled?:boolean;onSelect:(label:string,checked:boolean)=>void;onConsent:(checked:boolean)=>void;onCreate:()=>void}
export function PlanningComparisonPreview({comparison,selectedLabels,consent,disabled=false,onSelect,onConsent,onCreate}:PreviewProps){
  const available=availableLabels(comparison),eligible=!disabled&&previewAllowsReplan(comparison),valid=selectionValid(comparison,selectedLabels),canCreate=eligible&&valid&&consent;
  return <div className="planning-comparison-preview">
    <h4>r{comparison.base.revision} → r{comparison.target.revision} 변경 내용</h4>
    <p>{comparison.targetCurrent?'현재 기획 버전':'과거 기획 버전'} · {comparison.target.state}. {comparison.canReplan?'선택 후 별도 동의로 후속 Task 초안을 만들 수 있습니다.':'현재 승인된 기획과 미결정 사항을 확인하세요. 이 비교에서는 후속 Task를 만들 수 없습니다.'}</p>
    {comparison.fields.length?<div className="planning-comparison-table"><table><caption>기획 필드 변경</caption><thead><tr><th>항목</th><th>이전</th><th>이후</th></tr></thead>
      <tbody>{comparison.fields.map(change=><tr key={change.field}><th scope="row">{fieldTitles[change.field]}</th><td><FieldValue value={change.before}/></td><td><FieldValue value={change.after}/></td></tr>)}</tbody></table></div>:<p>기획 필드 변경 없음</p>}
    <div className="planning-comparison-table"><table><caption>요구사항 변경</caption><thead><tr><th>식별자 · 상태</th><th>이전</th><th>이후</th></tr></thead>
      <tbody>{comparison.requirements.map(change=><tr key={change.label}><th scope="row">{change.label} · {changeTitles[change.status]}</th><td><RequirementValue value={change.before}/></td><td><RequirementValue value={change.after}/></td></tr>)}</tbody></table></div>
    <div className="planning-comparison-table"><table><caption>영향을 받는 기존 Task · {comparison.affectedTasks.length}개</caption><thead><tr><th>Task ID</th><th>기획 버전 ID</th><th>요구사항</th><th>영향 근거</th></tr></thead>
      <tbody>{comparison.affectedTasks.map(task=><tr key={task.taskId}><td>{task.taskId}</td><td>{task.planningVersionId}</td><td>{task.requirementLabels.join(', ')}</td><td>{task.reasons.map(reason=>reasonTitles[reason]).join(', ')}</td></tr>)}</tbody></table></div>
    {!comparison.affectedTasks.length&&<p>영향을 받는 기존 Task가 없습니다.</p>}
    <fieldset disabled={!eligible} className="planning-comparison-selection"><legend>후속 Task 요구사항 선택 · {selectedLabels.length}/100</legend>
      {available.map(label=><label key={label}><input type="checkbox" checked={selectedLabels.includes(label)} disabled={!eligible||(!selectedLabels.includes(label)&&selectedLabels.length>=100)} onChange={event=>{if(eligible)onSelect(label,event.target.checked);}}/>{label}</label>)}
      {!available.length&&<p>추가로 생성할 요구사항이 없습니다.</p>}
    </fieldset>
    {!!comparison.existingLabels.length&&<p>대상 버전에 Task가 이미 있음: {comparison.existingLabels.join(', ')}</p>}
    <p>1–100개를 선택하세요. 삭제된 요구사항은 후속 Task 생성 대상에서 제외됩니다. 새 Task는 초안으로 생성되며 에이전트나 모델 실행을 시작하지 않습니다.</p>
    <label className="planning-comparison-consent"><input type="checkbox" checked={consent} disabled={!eligible||!valid} onChange={event=>{if(eligible&&valid)onConsent(event.target.checked);}}/>별도 동의: 위 변경과 영향을 확인했고 선택한 후속 Task 초안 생성을 승인합니다.</label>
    <button disabled={!canCreate} onClick={()=>{if(canCreate)onCreate();}}>선택한 후속 Task 초안 생성</button>
  </div>;
}
