import {useEffect,useLayoutEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {PlanningVersion} from '../../shared/parallel.ts';
import type {PlanningAgentPanelProps,PlanningAgentPreview,PlanningAgentView,PlanningSuggestion} from '../../shared/planning-agent.ts';
import {createStudioMutator} from '../studio-client.ts';
import {PlanningPreview} from './PlanningStudio.tsx';
import './agent.css';

// A general (non-Git) project plans without a workspace: its scope is the project itself.
type PanelProps=PlanningAgentPanelProps&{general?:boolean};
type Scope=Pick<PanelProps,'projectId'|'workspaceId'|'online'|'busy'|'general'>;
const hasScope=(scope:Scope)=>!!scope.workspaceId||!!scope.general;
const runtimeLabel=(runtime:string|undefined)=>runtime==='claude-code'?'Claude Code':'Codex';
type Action='preview'|'start'|'interrupt'|'recover'|'save';
type ReadMode='poll'|'manual';
type ReceiptStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
interface Dependencies {get:(path:string)=>Promise<unknown>;post:PlanningAgentPanelProps['post'];onSaved:PlanningAgentPanelProps['onSaved'];storage?:ReceiptStorage}
interface AgentState {scope:Scope;text:string;view:PlanningAgentView|null;preview:PlanningAgentPreview|null;consent:boolean;recoveryConsent:string|null;loading:boolean;fresh:boolean;uncertain:boolean;action:Action|null;error:string;message:string}
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const scopeId=(scope:Scope)=>JSON.stringify([scope.projectId,scope.workspaceId]);
const rootPath=(scope:Scope)=>'/api/projects/'+encodeURIComponent(scope.projectId)+'/planning-suggestions';
const validText=(text:string)=>!!text.trim()&&text.length<=8000&&new TextEncoder().encode(text).length<=32768;
const matchesRecord=(record:PlanningSuggestion,scope:Scope)=>!!record&&record.projectId===scope.projectId&&record.workspaceId===scope.workspaceId&&typeof record.id==='string'&&!!record.id&&record.timeoutMs===60000&&record.turnLimit===1;
const matchesView=(view:PlanningAgentView,scope:Scope)=>!!view&&view.projectId===scope.projectId&&view.workspaceId===scope.workspaceId&&view.timeoutMs===60000&&view.turnLimit===1&&Array.isArray(view.records)&&view.records.every(record=>matchesRecord(record,scope));
const matchesPreview=(preview:PlanningAgentPreview,scope:Scope)=>!!preview&&preview.projectId===scope.projectId&&preview.workspaceId===scope.workspaceId&&preview.timeoutMs===60000&&preview.turnLimit===1&&digest(preview.inputDigest)&&digest(preview.previewDigest)&&typeof preview.instructions==='string'&&!!preview.instructions&&typeof preview.scope==='string';
const proposalReady=(record:PlanningSuggestion)=>record.execution==='completed'&&record.processStopped&&!!record.proposal&&digest(record.outputDigest);
export function planningAgentRecoveryKey(record:PlanningSuggestion,projectId:string,workspaceId:string|null){
  return record.projectId===projectId&&record.workspaceId===workspaceId&&record.execution!=='running'&&!record.processStopped&&!record.recoveredAt
    ?JSON.stringify([projectId,workspaceId,record.id,record.execution,record.inputDigest,record.outputDigest,record.processStopped,record.recoveredAt]):null;
}
function idle(state:AgentState){return state.scope.online&&hasScope(state.scope)&&!state.scope.busy&&!state.action&&!state.loading&&state.fresh&&!state.uncertain&&!!state.view&&!state.view.busy&&!state.view.recoveryRequired;}

/** Owns real UI requests, including synchronous locks before receipt hashing and scope changes. */
export function createPlanningAgentCoordinator(initial:Scope,deps:Dependencies){
  let scope={...initial},live=false,generation=0,sequence=0;
  const listeners=new Set<()=>void>(),memory=new Map<string,string>();
  // Only uncertainty flags and hashed request receipts are stored, never prompt text.
  const storage:ReceiptStorage={getItem(key){try{return deps.storage?.getItem(key)??memory.get(key)??null;}catch{return memory.get(key)??null;}},setItem(key,value){memory.set(key,value);try{deps.storage?.setItem(key,value);}catch{}},removeItem(key){memory.delete(key);try{deps.storage?.removeItem(key);}catch{}}};
  const uncertaintyKey=(value:Scope)=>'orbit.planning.uncertain.'+encodeURIComponent(scopeId(value));
  const uncertain=(value:Scope)=>storage.getItem(uncertaintyKey(value))==='1';
  const rememberUncertainty=(value:Scope,enabled:boolean)=>enabled?storage.setItem(uncertaintyKey(value),'1'):storage.removeItem(uncertaintyKey(value));
  let state:AgentState={scope,text:'',view:null,preview:null,consent:false,recoveryConsent:null,loading:false,fresh:false,uncertain:uncertain(scope),action:null,error:'',message:''};
  const publish=(next:Partial<AgentState>)=>{state={...state,...next};for(const listener of listeners)listener();};
  const token=()=>({generation,sequence:++sequence});
  type Token=ReturnType<typeof token>;
  const current=(value:Token)=>live&&generation===value.generation&&sequence===value.sequence;
  const discard={preview:null,consent:false,recoveryConsent:null} as const;
  function begin(kind:Action){if(!live||state.action||state.loading)return null;const value=token();publish({action:kind,consent:false,recoveryConsent:null,error:'',message:''});return value;}
  function recordById(id:string){return state.view?.records.find(record=>record.id===id&&matchesRecord(record,scope));}
  function putRecord(record:PlanningSuggestion){
    if(!state.view)return;
    const records=[record,...state.view.records.filter(old=>old.id!==record.id)].slice(0,100);
    publish({view:{...state.view,records,busy:records.some(value=>value.execution==='running'),recoveryRequired:records.some(value=>!!planningAgentRecoveryKey(value,scope.projectId,scope.workspaceId))}});
  }
  async function mutate(kind:Exclude<Action,'preview'>,id?:string){
    const record=id?recordById(id):undefined,preview=state.preview;
    if(kind==='start'&&(!idle(state)||!preview||!matchesPreview(preview,scope)||!state.consent||!validText(state.text)))return;
    if(kind==='save'&&(!idle(state)||!record||!proposalReady(record)))return;
    if(kind==='interrupt'&&(!scope.online||!state.fresh||state.loading||!record||record.execution!=='running'))return;
    if(kind==='recover'&&(!scope.online||scope.busy||state.loading||!state.fresh||state.uncertain||state.view?.busy||!state.view?.recoveryRequired||!record||!planningAgentRecoveryKey(record,scope.projectId,scope.workspaceId)||state.recoveryConsent!==planningAgentRecoveryKey(record,scope.projectId,scope.workspaceId)))return;
    const wasUncertain=state.uncertain,requestScope={...scope},text=state.text,request=begin(kind);if(!request)return;
    rememberUncertainty(requestScope,true);
    try{
      const path=rootPath(requestScope),workspaceId=requestScope.workspaceId??null;
      if(kind==='start'){
        // The callback captures this epoch: a disposed request cannot send after async hashing.
        const start=createStudioMutator(async(url,body)=>{
          if(!current(request))throw Error('STALE_SCOPE');
          const result=await deps.post(url,body) as PlanningSuggestion;
          // An unusable success response must retain its request receipt too.
          if(!matchesRecord(result,requestScope)||result.inputDigest!==preview!.inputDigest||result.previewDigest!==preview!.previewDigest)throw Error('SCOPE_MISMATCH');
          return result;
        },storage);
        const result=await start(path+'/start',{workspaceId,text,expectedPreviewDigest:preview!.previewDigest,confirmed:true}) as PlanningSuggestion;
        if(!current(request))return;
        putRecord(result);publish({...discard,message:'기획 제안 시작 요청을 확인했습니다. 최종 결과와 프로세스 종료 상태는 기록에서 확인하세요.'});
      }else if(kind==='save'){
        const result=await deps.post(path+'/'+encodeURIComponent(record!.id)+'/save',{workspaceId,expectedOutputDigest:record!.outputDigest}) as PlanningVersion;
        if(!current(request))return;
        if(!result||result.projectId!==requestScope.projectId||result.state!=='draft'||!result.id||!digest(result.contentHash)||(record!.savedPlanningVersionId&&record!.savedPlanningVersionId!==result.id))throw Error('SAVE_SCOPE_MISMATCH');
        deps.onSaved(result);if(!current(request))return;
        putRecord({...record!,savedPlanningVersionId:result.id});publish({...discard,message:'별도의 기획 초안을 저장 목록에 추가했습니다. 승인·Task 생성·실행은 시작하지 않았습니다.'});
      }else{
        await deps.post(kind==='interrupt'?path+'/'+encodeURIComponent(record!.id)+'/interrupt':path+'/recover',kind==='interrupt'?{workspaceId}:{workspaceId,suggestionId:record!.id,confirmedStopped:true});
        if(!current(request))return;
        publish({...discard,fresh:false,message:kind==='interrupt'?'기획 제안 중단을 요청했습니다. 기록에서 프로세스 종료 여부를 확인하세요.':'프로세스 종료 확인을 전달했습니다. 과거 결과를 성공으로 바꾸거나 자동 재실행하지 않습니다.'});
      }
      if(current(request)){rememberUncertainty(requestScope,wasUncertain);publish({uncertain:wasUncertain});}
    }catch{if(current(request))publish({...discard,uncertain:true,fresh:false,error:'변경 요청의 응답을 확인하지 못했습니다. 기획 상태 새로고침을 직접 눌러 현재 기록을 확인하세요. 자동 재전송하지 않습니다.'});}
    finally{if(current(request))publish({action:null});}
  }
  return {
    getSnapshot:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    activate(){if(!live){live=true;generation++;publish({uncertain:uncertain(scope)});}},
    dispose(){live=false;generation++;sequence++;publish({...discard,action:null,loading:false,fresh:false,uncertain:uncertain(scope)});},
    configure(next:Scope){
      if(scope.projectId===next.projectId&&scope.workspaceId===next.workspaceId&&scope.online===next.online&&scope.busy===next.busy&&!!scope.general===!!next.general)return;
      const changed=scopeId(scope)!==scopeId(next);scope={...next};generation++;sequence++;
      publish({...discard,scope,text:changed?'':state.text,view:changed?null:state.view,action:null,loading:false,fresh:false,uncertain:uncertain(scope),error:'',message:''});
    },
    setText(text:string){
      if(state.action&&state.action!=='preview')return;
      if(state.action==='preview')sequence++;
      publish({...discard,text,action:null,error:'',message:''});
    },
    async refresh(mode:ReadMode){
      if(!live||!scope.online||!hasScope(scope)||state.action||state.loading)return;
      const request=token(),requestScope={...scope};publish({loading:true});
      try{
        const result=await deps.get(rootPath(requestScope)+(requestScope.workspaceId?'?workspaceId='+encodeURIComponent(requestScope.workspaceId):'')) as PlanningAgentView;
        if(!current(request))return;if(!matchesView(result,requestScope))throw Error('VIEW_SCOPE_MISMATCH');
        const invalidate=mode==='manual'||result.busy||result.recoveryRequired||(!!state.preview&&result.scope!==state.preview.scope);
        if(mode==='manual')rememberUncertainty(requestScope,false);
        const recoveryStillCurrent=result.records.some(record=>planningAgentRecoveryKey(record,scope.projectId,scope.workspaceId)===state.recoveryConsent);
        publish({view:result,fresh:true,loading:false,uncertain:mode==='manual'?false:state.uncertain,error:'',...(invalidate?discard:{}),...(!recoveryStillCurrent?{recoveryConsent:null}:{})});
      }catch{if(current(request))publish({...discard,fresh:false,error:'기획 상태를 확인하지 못했습니다. 상태 새로고침으로 다시 확인하세요.'});}
      finally{if(current(request))publish({loading:false});}
    },
    async preview(){
      if(!idle(state)||!validText(state.text))return;
      const text=state.text,requestScope={...scope},request=begin('preview');if(!request)return;publish(discard);
      try{
        const result=await deps.post(rootPath(requestScope)+'/preview',{workspaceId:requestScope.workspaceId??null,text}) as PlanningAgentPreview;
        if(!current(request))return;if(!matchesPreview(result,requestScope)||result.scope!==state.view?.scope)throw Error('PREVIEW_SCOPE_MISMATCH');
        publish({preview:result,message:'전송할 정확한 기획 입력을 표시했습니다. 내용을 확인한 뒤 별도로 동의하세요.'});
      }catch{if(current(request))publish({...discard,error:'기획 요청 미리보기를 확인하지 못했습니다. 입력과 현재 상태를 확인한 뒤 다시 요청하세요.'});}
      finally{if(current(request))publish({action:null});}
    },
    consent(checked:boolean){publish({consent:checked&&live&&idle(state)&&!!state.preview&&matchesPreview(state.preview,scope)});},
    confirmStopped(id:string,checked:boolean){const record=recordById(id);if(!live||!scope.online||scope.busy||state.loading||state.action||!state.fresh||state.uncertain||state.view?.busy)return;publish({recoveryConsent:checked&&record?planningAgentRecoveryKey(record,scope.projectId,scope.workspaceId):null});},
    start:()=>mutate('start'),save:(id:string)=>mutate('save',id),interrupt:(id:string)=>mutate('interrupt',id),recover:(id:string)=>mutate('recover',id),
  };
}

export function PlanningAgentPanel(props:PanelProps){
  const callbacks=useRef(props);callbacks.current=props;
  const coordinator=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{}
    return createPlanningAgentCoordinator(props,{storage,get:async path=>{const response=await fetch(path);if(!response.ok)throw Error('PLANNING_HISTORY_FAILED');return response.json();},post:(path,body)=>callbacks.current.post(path,body),onSaved:version=>callbacks.current.onSaved(version)});
  },[]);
  const state=useSyncExternalStore(coordinator.subscribe,coordinator.getSnapshot,coordinator.getSnapshot);
  useLayoutEffect(()=>{coordinator.activate();return()=>coordinator.dispose();},[coordinator]);
  useLayoutEffect(()=>coordinator.configure(props),[coordinator,props.projectId,props.workspaceId,props.online,props.busy,props.general]);
  const scoped=!!props.workspaceId||!!props.general,label=runtimeLabel(state.preview?.runtime??state.view?.runtime);
  const running=!!state.view?.records.some(record=>record.execution==='running');
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){await coordinator.refresh('poll');if(!disposed)timer=setTimeout(()=>void poll(),running?1000:15000);}
    if(props.online&&scoped&&!state.action)void poll();
    return()=>{disposed=true;if(timer)clearTimeout(timer);};
  },[coordinator,props.projectId,props.workspaceId,props.general,props.online,props.busy,state.action,running]);
  const ready=idle(state),canPreview=ready&&validText(state.text),blocked=!props.online||!scoped||!!state.action;
  const simple=props.presentation==='simple';
  const explanation=<><p>공식 {label} CLI의 읽기 전용 세션을 사용하며, 읽기 전용도 네이티브 파일 읽기를 허용합니다. CLI의 컨텍스트 로딩·보존·공급자 전송은 Model Hub 게이트웨이 밖에서 처리됩니다.</p>
    <p>1 turn · 60초 제한과 프로세스 종료 확인을 사용합니다. 자동 시작·재시도·이어받기는 하지 않습니다. 검증된 제안도 별도로 저장해야 미승인 기획 초안이 됩니다.</p></>;
  return <section className="planning-agent" aria-label={label+' 기획 제안'} aria-busy={!!state.action||state.loading}>
    <h3>{simple?'무엇을 만들고 싶으세요?':label+' 기획 제안 · 선택 기능'}</h3>
    {simple?<><p>누가 사용할지, 어떤 일을 할 수 있으면 좋을지 적어 주세요. 기획 도우미의 제안을 검토하고 초안으로 저장할 수 있습니다.</p><details><summary>기획 도우미의 실행 범위와 제한</summary>{explanation}</details></>:explanation}
    {!scoped&&<p>등록한 격리 작업 공간을 선택하면 기획 제안을 요청할 수 있습니다. 수동 기획 작성은 계속 사용할 수 있습니다.</p>}
    {!props.online&&<p>서버 연결 후 기획 제안 상태를 확인할 수 있습니다.</p>}{props.busy&&<p>다른 작업이 진행 중입니다. 완료 후 새 기획 제안을 요청하세요.</p>}
    <button disabled={!props.online||!scoped||!!state.action||state.loading} onClick={()=>void coordinator.refresh('manual')}>기획 상태 새로고침</button>
    {state.error&&<p role="alert">{state.error}</p>}{state.message&&<p role="status">{state.message}</p>}
    {state.uncertain&&<p role="status">이전 변경 요청의 응답은 미확인입니다. 기획 상태 새로고침을 직접 눌러 성공적으로 조회해야 다시 시작할 수 있습니다. 자동 조회는 이 잠금을 해제하거나 요청을 재전송하지 않습니다.</p>}
    {state.view?.recoveryRequired&&<p>종료가 확인되지 않은 기획 프로세스가 있습니다. 실제 종료를 확인한 뒤 아래 별도 확인란으로 복구하세요.</p>}
    <label>{simple?'만들고 싶은 프로그램':'기획 요청'}<textarea rows={5} maxLength={8000} value={state.text} disabled={blocked} placeholder={simple?'예: 소규모 팀이 할 일을 추가하고 진행 상태를 확인하는 웹 앱을 만들고 싶어요. 담당자와 마감일을 정하고 완료한 일을 모아 볼 수 있으면 좋겠어요.':undefined} onChange={event=>coordinator.setText(event.target.value)}/></label>
    <p>최대 8,000자 · UTF-8 32 KiB. Orbit 실행 기록에는 요청 원문을 저장하지 않습니다. 네이티브 CLI의 컨텍스트·보존 정책은 별도로 적용됩니다.</p>
    <button disabled={!canPreview} onClick={()=>void coordinator.preview()}>기획 요청 미리보기</button>
    {state.preview&&<PlanningAgentExecutionPreview preview={state.preview} consent={state.consent} disabled={!ready} presentation={props.presentation} onConsent={coordinator.consent} onStart={()=>void coordinator.start()}/>}
    <PlanningAgentHistory projectId={props.projectId} workspaceId={props.workspaceId} records={state.view?.records??[]} online={props.online} busy={props.busy||!!state.view?.busy} loading={state.loading} fresh={state.fresh} uncertain={state.uncertain} action={state.action} recoveryConsent={state.recoveryConsent}
      onInterrupt={id=>void coordinator.interrupt(id)} onRecover={id=>void coordinator.recover(id)} onConfirmStopped={coordinator.confirmStopped} onSave={id=>void coordinator.save(id)}/>
  </section>;
}

export function PlanningAgentExecutionPreview({preview,consent,disabled,presentation,onConsent,onStart}:{preview:PlanningAgentPreview;consent:boolean;disabled:boolean;presentation?:PlanningAgentPanelProps['presentation'];onConsent:(checked:boolean)=>void;onStart:()=>void}){
  const simple=presentation==='simple';
  const input=<><p>input <code>{preview.inputDigest}</code> · preview <code>{preview.previewDigest}</code></p><pre>{preview.instructions}</pre></>;
  return <section className="planning-agent-preview" aria-label="기획 요청 전송 미리보기"><h4>{simple?'기획 도우미 실행 확인':'정확한 전송 입력'}</h4>
    <p>{preview.turnLimit} turn · {simple?`${preview.timeoutMs/1000}초`:`${preview.timeoutMs} ms`} · {preview.scope}</p>
    {simple?<details><summary>정확한 전송 입력 확인</summary>{input}</details>:input}
    <label className="planning-agent-consent"><input type="checkbox" checked={consent} disabled={disabled} onChange={event=>{if(!disabled)onConsent(event.target.checked);}}/>별도 동의: 위 입력과 네이티브 읽기·컨텍스트·보존·공급자 전송 범위를 확인하고 기획 제안 시작에 동의합니다.</label>
    <button disabled={disabled||!consent} onClick={()=>{if(!disabled&&consent)onStart();}}>동의한 기획 제안 시작</button>
  </section>;
}
const statuses={running:'기획 제안 실행 중',completed:'기획 제안 완료 · 미승인',failed:'기획 제안 실패',interrupted:'기획 제안 중단',timed_out:'기획 제안 시간 초과',lost:'재시작·결과 미확인'};
interface HistoryProps {projectId:string;workspaceId:string|null;records:PlanningSuggestion[];online:boolean;busy:boolean;loading:boolean;fresh:boolean;uncertain:boolean;action:Action|null;recoveryConsent:string|null;onInterrupt:(id:string)=>void;onRecover:(id:string)=>void;onConfirmStopped:(id:string,checked:boolean)=>void;onSave:(id:string)=>void}
export function PlanningAgentHistory(props:HistoryProps){
  const rows=props.records.filter(record=>record.projectId===props.projectId&&record.workspaceId===props.workspaceId).slice(0,100);
  const observed=props.online&&!props.loading&&!props.action&&props.fresh,canMutate=observed&&!props.busy&&!props.uncertain;
  return <section className="planning-agent-history" aria-label="기획 제안 기록"><h4>현재 작업 공간 기획 제안 기록</h4>
    <p>자동 조회는 저장된 상태만 읽습니다. 제안 완료는 기획 승인·Task 생성·코딩 실행이 아닙니다.</p>
    {!rows.length&&<p>기획 제안 기록이 없습니다.</p>}
    {rows.map(record=>{const recoveryKey=planningAgentRecoveryKey(record,props.projectId,props.workspaceId),canRecover=canMutate&&!!recoveryKey&&props.recoveryConsent===recoveryKey,canSave=canMutate&&proposalReady(record)&&!rows.some(value=>!!planningAgentRecoveryKey(value,props.projectId,props.workspaceId));return <article key={record.id}>
      <h5>{statuses[record.execution]}</h5><p>제안 {record.id} · {record.createdAt} · 프로세스 {record.processStopped?'종료 확인됨':'종료 확인 불가'} · {record.timeoutMs} ms · {record.turnLimit} turn</p>
      {record.issue&&<p>진단 <code>{record.issue}</code></p>}
      {record.execution==='running'&&<button disabled={!observed} onClick={()=>{if(observed)props.onInterrupt(record.id);}}>기획 제안 중단</button>}
      {recoveryKey&&<div><p>이전 네이티브 기획 프로세스가 실제로 종료됐는지 직접 확인하세요.</p>
        <label className="planning-agent-consent"><input type="checkbox" checked={props.recoveryConsent===recoveryKey} disabled={!canMutate} onChange={event=>{if(canMutate)props.onConfirmStopped(record.id,event.target.checked);}}/>별도 종료 확인: 이전 기획 프로세스가 종료되었음을 확인했습니다.</label>
        <button disabled={!canRecover} onClick={()=>{if(canRecover)props.onRecover(record.id);}}>종료 확인 후 기획 복구</button></div>}
      {record.recoveredAt&&<p>사용자 프로세스 종료 확인: {record.recoveredAt}. 이전 결과를 성공으로 바꾸지 않았습니다.</p>}
      {proposalReady(record)&&<><h5>형식·입력 정책 검사를 통과한 제안</h5><PlanningPreview draft={record.proposal!}/>
        {record.savedPlanningVersionId&&<p>저장된 기획 초안: {record.savedPlanningVersionId}</p>}
        <button disabled={!canSave} onClick={()=>{if(canSave)props.onSave(record.id);}}>{record.savedPlanningVersionId?'저장된 기획 초안 다시 확인':'제안을 새 기획 초안으로 저장'}</button></>}
    </article>;})}
  </section>;
}
