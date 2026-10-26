import {useEffect,useMemo,useRef,useState} from 'react';
import type {WorkflowDefinition,WorkflowPreview,WorkflowRun,WorkflowVersion,WorkflowView,SaveWorkflowInput,StartWorkflowInput} from '../shared/workflows.ts';
import type {VerificationCommandPreview} from '../shared/verification.ts';
import {createStudioMutator} from './studio-client.ts';

type Token={generation:number;sequence:number};
type ReadMode='poll'|'manual'|'after-action';
export function acknowledgeWorkflowRead(mode:ReadMode,succeeded:boolean){return mode==='manual'&&succeeded;}
/** Actual metadata/preview/write handlers share this order and immediate lock. */
export function createWorkflowRequestEpoch(){
  let live=false,generation=0,sequence=0,action:number|null=null;
  return {reset(){live=true;generation++;sequence++;action=null;},dispose(){live=false;generation++;sequence++;action=null;},
    read():Token|null{return !live||action!==null?null:{generation,sequence:++sequence};},
    beginAction():Token|null{if(!live||action!==null)return null;action=++sequence;return {generation,sequence};},
    isCurrent(token:Token){return live&&token.generation===generation&&token.sequence===sequence;},sameScope(token:Token){return live&&token.generation===generation;},
    finishAction(token:Token){if(!live||token.generation!==generation||action!==token.sequence)return false;action=null;return true;},
    invalidate(){if(!live||action!==null)return false;sequence++;return true;}};
}
const copyDefinition=(value:WorkflowDefinition):WorkflowDefinition=>({name:value.name,steps:value.steps.map(step=>({...step,dependsOn:[...step.dependsOn]}))});
const headVersion=(version:WorkflowVersion,versions:readonly WorkflowVersion[])=>!versions.some(value=>value.workflowId===version.workflowId&&value.revision>version.revision);
const commandKey=(command:VerificationCommandPreview)=>JSON.stringify([command.id,command.label,command.executable,command.args,command.timeoutMs,command.configDigest]);
export function workflowDraftIssue(definition:WorkflowDefinition,commands:readonly VerificationCommandPreview[]):string|null {
  if(!definition.name.trim()||definition.name.trim().length>120||/[\x00-\x1f\x7f]/.test(definition.name))return '이름은 제어문자 없이 1~120자로 작성하세요.';
  if(!definition.steps.length||definition.steps.length>12)return '등록 명령을 1~12단계로 선택하세요.';
  const ids=new Set(definition.steps.map(step=>step.id));if(ids.size!==definition.steps.length)return '단계 ID가 중복됐습니다.';
  let total=0;for(const step of definition.steps){
    const command=commands.find(value=>value.id===step.commandId);if(!command)return '현재 서버에 등록되지 않은 명령이 있습니다.';total+=command.timeoutMs;
    if(step.dependsOn.some(id=>id===step.id||!ids.has(id))||new Set(step.dependsOn).size!==step.dependsOn.length)return '의존 단계가 없거나 자기 자신을 참조합니다.';
  }
  if(total>600000)return '등록 명령의 timeout 합계가 10분을 초과합니다.';
  const done=new Set<string>();while(done.size<definition.steps.length){const next=definition.steps.find(step=>!done.has(step.id)&&step.dependsOn.every(id=>done.has(id)));if(!next)return '의존성에 순환이 있습니다. dependsOn을 수정하세요.';done.add(next.id);}return null;
}
type PreviewScope={projectId:string;workspaceId:string|null;version:WorkflowVersion;versions:readonly WorkflowVersion[];commands:readonly VerificationCommandPreview[]};
export function workflowPreviewMatches(preview:WorkflowPreview,scope:PreviewScope){
  const {version}=scope;
  if(!scope.workspaceId||preview.projectId!==scope.projectId||preview.workspaceId!==scope.workspaceId||version.projectId!==scope.projectId||preview.workflowId!==version.workflowId||preview.versionId!==version.id||preview.definitionDigest!==version.definitionDigest||!headVersion(version,scope.versions)||preview.steps.length!==version.definition.steps.length||new Set(preview.steps.map(step=>step.id)).size!==preview.steps.length)return false;
  let timeout=0;for(const step of preview.steps){
    const declared=version.definition.steps.find(value=>value.id===step.id),command=scope.commands.find(value=>value.id===step.commandId);
    if(!declared||!command||declared.commandId!==step.commandId||JSON.stringify(declared.dependsOn)!==JSON.stringify(step.dependsOn)||commandKey(command)!==commandKey(step.command))return false;timeout+=command.timeoutMs;
  }
  return timeout===preview.totalTimeoutMs&&timeout<=600000;
}
export function sameWorkflowPreview(a:WorkflowPreview,b:WorkflowPreview){
  const key=(value:WorkflowPreview)=>JSON.stringify([value.projectId,value.workspaceId,value.workflowId,value.versionId,value.definitionDigest,value.sourceDigest,value.baseSha,value.configDigest,value.previewDigest,value.totalTimeoutMs,value.steps.map(step=>[step.id,step.commandId,step.dependsOn,commandKey(step.command)])]);
  return key(a)===key(b);
}
export function workflowRetryMatches(run:WorkflowRun,preview:WorkflowPreview,runs:readonly WorkflowRun[]){
  return ['failed','interrupted','timed_out'].includes(run.status)&&run.attempt<3&&!runs.some(value=>value.retryOfId===run.id)
    &&run.projectId===preview.projectId&&run.workspaceId===preview.workspaceId&&run.workflowId===preview.workflowId&&run.versionId===preview.versionId&&run.definitionDigest===preview.definitionDigest&&run.sourceDigest===preview.sourceDigest&&run.baseSha===preview.baseSha&&run.configDigest===preview.configDigest;
}
const statuses={running:'실행 중',passed:'등록 명령 통과 · 리뷰·병합 아님',failed:'실패',interrupted:'중단 확인',timed_out:'시간 초과',stale:'소스 변경·무효',lost:'재시작·결과 미확인',pending:'실행 대기',skipped:'실행하지 않음'};
type Props={projectId:string;workspaceId:string|null;online:boolean;busy:boolean;post:(path:string,body:object)=>Promise<unknown>};
export function WorkflowsPanel(props:Props){return <ScopedWorkflows key={props.projectId} {...props}/>;}
function ScopedWorkflows({projectId,workspaceId,online,busy,post}:Props){
  const [view,setView]=useState<WorkflowView|null>(null),[selectedId,setSelectedId]=useState(''),[definition,setDefinition]=useState<WorkflowDefinition>({name:'',steps:[]}),[dirty,setDirty]=useState(false);
  const [preview,setPreview]=useState<WorkflowPreview|null>(null),[consent,setConsent]=useState<string|null>(null),[retryId,setRetryId]=useState<string|null>(null),[recoveryConsent,setRecoveryConsent]=useState<string|null>(null);
  const [loading,setLoading]=useState(false),[fresh,setFresh]=useState(false),[action,setAction]=useState<'save'|'preview'|'start'|'interrupt'|'recover'|null>(null),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[message,setMessage]=useState('');
  const order=useMemo(()=>createWorkflowRequestEpoch(),[]),postRef=useRef(post),reader=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),actionRef=useRef<Token|null>(null),reload=useRef<(mode:ReadMode)=>Promise<void>>(async()=>{});
  const previewRef=useRef<WorkflowPreview|null>(null),definitionRef=useRef(definition),selectedRef=useRef(selectedId),dirtyRef=useRef(dirty),viewRef=useRef(view);
  postRef.current=post;previewRef.current=preview;definitionRef.current=definition;selectedRef.current=selectedId;dirtyRef.current=dirty;viewRef.current=view;
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{}return createStudioMutator((path,data)=>postRef.current(path,data),storage);},[]);
  const versions=view?.versions.filter(version=>version.projectId===projectId)??[],commands=view?.commands??[],selected=versions.find(version=>version.id===selectedId),runs=view?.runs.filter(run=>run.projectId===projectId&&(!workspaceId||run.workspaceId===workspaceId))??[];
  const isHead=!!selected&&headVersion(selected,versions),issue=workflowDraftIssue(definition,commands),retry=runs.find(run=>run.id===retryId)??null;
  const bound=!!preview&&!!selected&&!dirty&&workflowPreviewMatches(preview,{projectId,workspaceId,version:selected,versions,commands});
  const consentKey=JSON.stringify([projectId,workspaceId,preview?.previewDigest,preview?.versionId,retryId]);
  const confirmed=bound&&consent===consentKey;
  const idle=online&&!!projectId&&fresh&&!loading&&!action&&!busy&&!view?.busy&&!uncertain&&!view?.recoveryRequired;
  const canSave=idle&&!issue&&(!selectedId||!!selected)&&(!selected||dirty)&&(!selected||isHead),canPreview=idle&&!!workspaceId&&!!selected&&!dirty&&isHead&&!issue;
  const canExecute=idle&&bound&&confirmed&&(!retryId||!!retry&&workflowRetryMatches(retry,preview!,runs));
  function discardPreview(){previewRef.current=null;setPreview(null);setConsent(null);setRecoveryConsent(null);}
  useEffect(()=>{order.reset();setView(null);setFresh(false);discardPreview();setRetryId(null);setAction(null);actionRef.current=null;setLoading(false);setLoadError('');
    async function load(mode:ReadMode){
      if(!online||!projectId)return;const token=order.read();if(!token)return;
      if(timer.current)clearTimeout(timer.current);reader.current?.abort();const controller=new AbortController();reader.current=controller;setLoading(true);
      try{
        const response=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/workflows'+(workspaceId?'?workspaceId='+encodeURIComponent(workspaceId):''),{signal:controller.signal});if(!response.ok)throw new Error();
        const result=await response.json() as WorkflowView;if(!order.isCurrent(token))return;
        if(result.projectId!==projectId||result.workspaceId!==workspaceId||!Array.isArray(result.versions)||!Array.isArray(result.commands)||!Array.isArray(result.runs))throw new Error();
        const previous=previewRef.current;
        if(previous){
          const version=result.versions.find(value=>value.id===selectedRef.current),scope=version?{projectId,workspaceId,version,versions:result.versions,commands:result.commands}:null;
          let valid=!dirtyRef.current&&!!scope&&workflowPreviewMatches(previous,scope)&&!result.busy&&!result.recoveryRequired;
          if(valid)try{
            const checked=await fetch('/api/workspaces/'+encodeURIComponent(workspaceId!)+'/workflows/preview?workflowId='+encodeURIComponent(previous.workflowId),{signal:controller.signal});if(!checked.ok)throw new Error();const current=await checked.json() as WorkflowPreview;valid=sameWorkflowPreview(previous,current)&&workflowPreviewMatches(current,scope!);
          }catch{valid=false;}
          if(!order.isCurrent(token))return;
          if(!valid){discardPreview();setMessage('소스·설정·버전이 바뀌었거나 현재성을 확인할 수 없어 미리보기와 동의를 폐기했습니다. 다시 미리보기를 만드세요.');}
        }
        if(!order.isCurrent(token))return;setView(result);setFresh(true);setLoadError('');
        if(acknowledgeWorkflowRead(mode,true)){setUncertain(false);setError('');setConsent(null);setRecoveryConsent(null);}
      }catch{if(order.isCurrent(token)&&!controller.signal.aborted){setFresh(false);discardPreview();setLoadError('워크플로 상태를 확인하지 못했습니다. 현재성을 확인할 때까지 새 실행은 차단합니다.');}}
      finally{if(order.isCurrent(token))setLoading(false);if(order.sameScope(token))timer.current=setTimeout(()=>void load('poll'),15000);}
    }
    reload.current=load;if(online&&projectId)void load('poll');
    return()=>{order.dispose();reader.current?.abort();if(timer.current)clearTimeout(timer.current);reload.current=async()=>{};};
  },[projectId,workspaceId,online,order]);
  function edit(next:WorkflowDefinition){if(!order.invalidate())return;reader.current?.abort();setLoading(false);setDefinition(copyDefinition(next));setDirty(true);discardPreview();setError('');setMessage('');}
  function choose(version?:WorkflowVersion,retryRun?:WorkflowRun){
    if(!order.invalidate())return;reader.current?.abort();setLoading(false);setSelectedId(version?.id??'');setDefinition(version?copyDefinition(version.definition):{name:'',steps:[]});setDirty(false);setRetryId(retryRun?.id??null);discardPreview();setError('');setMessage('');
  }
  async function act(kind:'save'|'preview'|'start'|'interrupt'|'recover',run?:WorkflowRun){
    if(kind==='save'&&!canSave||kind==='preview'&&!canPreview||kind==='start'&&!canExecute)return;
    if(kind==='interrupt'&&(!online||!run||run.projectId!==projectId||run.workspaceId!==workspaceId||run.status!=='running'))return;
    if(kind==='recover'&&(!online||busy||view?.busy||!run||run.projectId!==projectId||run.workspaceId!==workspaceId||run.status!=='lost'||run.recoveredAt||recoveryConsent!==run.id))return;
    const token=order.beginAction();if(!token)return;actionRef.current=token;reader.current?.abort();if(timer.current)clearTimeout(timer.current);setAction(kind);setConsent(null);setRecoveryConsent(null);setError('');setMessage('');
    try{
      if(kind==='save'){
        const data:Omit<SaveWorkflowInput,'requestId'>={name:definition.name,steps:copyDefinition(definition).steps,workflowId:selected?.workflowId??null,expectedRevision:selected?.revision??null};
        const value=await mutate('/api/projects/'+encodeURIComponent(projectId)+'/workflows',{...data}) as WorkflowVersion;
        if(!order.isCurrent(token))return;if(value.projectId!==projectId)throw new Error();setSelectedId(value.id);setDefinition(copyDefinition(value.definition));setDirty(false);discardPreview();setMessage('워크플로 버전을 저장했습니다. 실행하려면 현재 명령·소스를 다시 미리보기하세요.');
      }else if(kind==='preview'){
        const controller=new AbortController();reader.current=controller;
        const response=await fetch('/api/workspaces/'+encodeURIComponent(workspaceId!)+'/workflows/preview?workflowId='+encodeURIComponent(selected!.workflowId),{signal:controller.signal});if(!response.ok)throw new Error();const value=await response.json() as WorkflowPreview;
        if(!order.isCurrent(token))return;if(!workflowPreviewMatches(value,{projectId,workspaceId,version:selected!,versions,commands}))throw new Error();previewRef.current=value;setPreview(value);setMessage('조회 당시 전체 명령과 source를 표시했습니다. 실행은 별도 동의 후 서버가 다시 검증합니다.');
      }else if(kind==='start'){
        const data:Omit<StartWorkflowInput,'requestId'>={workspaceId:workspaceId!,workflowId:preview!.workflowId,expectedVersionId:preview!.versionId,expectedPreviewDigest:preview!.previewDigest,confirmed:true,retryOfId:retryId};
        await mutate('/api/workflows/start',{...data});if(!order.isCurrent(token))return;discardPreview();setRetryId(null);setUncertain(false);setMessage('명시 실행 요청을 보냈습니다. 실제 Run·단계의 최종 상태를 기록에서 확인하세요.');
      }else if(kind==='interrupt'){
        await postRef.current('/api/workflows/'+encodeURIComponent(run!.id)+'/interrupt',{workspaceId});if(!order.isCurrent(token))return;setMessage('중단 요청을 전달했습니다. 서버의 실제 최종 종료 상태를 확인하세요.');
      }else{
        await postRef.current('/api/workflows/recover',{runId:run!.id,confirmedStopped:true});if(!order.isCurrent(token))return;setUncertain(false);setMessage('이전 프로세스 종료 확인을 전달했습니다. 실행 결과를 통과로 바꾸거나 자동 재실행하지 않습니다.');
      }
    }catch{if(order.sameScope(token)){if(kind!=='preview')setUncertain(true);discardPreview();setError('요청 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 상태를 명시 새로고침하고 저장된 기록을 확인하세요.');}}
    finally{if(order.finishAction(token)&&actionRef.current===token){actionRef.current=null;setAction(null);setLoading(false);if(kind==='preview')timer.current=setTimeout(()=>void reload.current('poll'),15000);else{setFresh(false);await reload.current('after-action');}}}
  }
  return <section className="surface workflows-panel" aria-label="로컬 워크플로" aria-busy={!!action||!!view?.busy}>
    <div className="section-heading"><h2>로컬 고정 명령 워크플로</h2><button disabled={!online||!projectId||loading||!!action} onClick={()=>void reload.current('manual')}>워크플로 상태 새로고침</button></div>
    <p>명령은 sandbox 밖의 로컬 <b>OS 사용자 권한</b>으로 실행합니다. ignored 의존성·외부 부작용·중간 수정 후 원복을 격리하거나 증명하지 않습니다. 실행 통과는 AI Run·코드 리뷰 승인·병합으로 자동 승격되지 않습니다.</p>
    <p>최대 12단계의 DAG를 순차 실행하며 timeout 합계는 최대 10분입니다. 첫 실패에서 나머지를 실행하지 않습니다. AI·외부 서비스 작업 분배와 예약 scheduler는 미연결입니다.</p>
    {!projectId&&<p>프로젝트를 먼저 선택하세요.</p>}{!workspaceId&&<p>프로젝트의 실행할 작업 공간을 선택해야 명령 미리보기와 실행을 할 수 있습니다.</p>}
    {view&&!commands.length&&<p className="notice">현재 서버에 등록된 명령이 없습니다. 실행파일·인자·환경을 이 화면에서 추가하지 않습니다. 서버 설정 후 상태를 다시 조회하세요.</p>}
    {loadError&&<p role="alert">{loadError}</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {uncertain&&<p className="notice">이전 요청의 응답은 미확인입니다. 자동 전송은 하지 않습니다. 명시 상태 새로고침이 성공해야 다시 진행할 수 있으며 새 실행 동의와 서버 gate가 계속 필요합니다.</p>}
    <p className="subtle">자동 조회는 15초 간격이며 요청 중에는 멈춥니다. 상태와 미리보기는 조회 당시 값이며 실행 전 서버가 재검증합니다.</p>{view&&<p>{view.scope}</p>}
    <label htmlFor="workflow-version">저장된 template / version</label><select id="workflow-version" value={selectedId} disabled={!online||!!action} onChange={event=>choose(versions.find(value=>value.id===event.target.value))}>
      <option value="">새 워크플로</option>{versions.map(version=><option key={version.id} value={version.id}>{version.definition.name} · r{version.revision} · {version.workflowId.slice(0,8)}</option>)}
    </select>
    <button disabled={!online||!!action} onClick={()=>choose()}>새 워크플로 / 편집 버리기</button>
    <WorkflowEditor definition={definition} commands={commands} disabled={!online||!projectId||!!action} onChange={edit}/>
    {issue&&<p className="subtle">{issue}</p>}{selected&&!isHead&&<p>과거 버전입니다. 새 버전 저장·실행은 현재 최신 버전을 선택해 검토하세요.</p>}
    {view&&selectedId&&!selected&&<p>선택한 저장 버전이 현재 목록에 없습니다. 다른 저장 버전을 선택하거나 명시적으로 새 워크플로를 만드세요.</p>}
    <div className="actions"><button disabled={!canSave} onClick={()=>void act('save')}>{selected?'워크플로 새 버전 저장':'워크플로 저장'}</button><button disabled={!canPreview} onClick={()=>void act('preview')}>현재 명령·소스 미리보기</button></div>
    {dirty&&<p>미저장 편집이 있어 이전 미리보기와 실행 동의는 사용할 수 없습니다.</p>}
    {retryId&&<p className="notice">재시도 기준 {retryId}. 같은 버전·설정·소스에서만 최대 3회이며 이미 후속 재시도가 있으면 분기 재시도하지 않습니다. <button disabled={!!action} onClick={()=>{if(order.invalidate()){discardPreview();setRetryId(null);}}}>재시도 선택 해제</button></p>}
    {bound&&<WorkflowExecution preview={preview!} confirmed={confirmed} canExecute={!!canExecute} retryRun={retry} onConsent={value=>setConsent(value?consentKey:null)} onStart={()=>void act('start')}/>}
    {retryId&&bound&&(!retry||!workflowRetryMatches(retry,preview!,runs))&&<p>현재 미리보기는 선택한 실패 Run의 재시도 조건과 일치하지 않습니다. 수정했다면 재시도 선택을 해제하고 새 실행으로 검토하세요.</p>}
    <WorkflowHistory projectId={projectId} workspaceId={workspaceId} runs={runs} online={online} actionBusy={!!action} otherBusy={busy} recoveryConsent={recoveryConsent}
      onInterrupt={run=>void act('interrupt',run)} onRetry={run=>{const version=versions.find(value=>value.id===run.versionId);if(version)choose(version,run);else setError('재시도할 저장 버전이 현재 목록에 없습니다. 서버 상태와 버전 기록을 확인하세요.');}}
      onRecover={run=>void act('recover',run)} onRecoveryConsent={(id,value)=>setRecoveryConsent(value?id:null)}/>
  </section>;
}

export function WorkflowEditor({definition,commands,disabled,onChange}:{definition:WorkflowDefinition;commands:readonly VerificationCommandPreview[];disabled:boolean;onChange:(value:WorkflowDefinition)=>void}){
  const update=(index:number,next:WorkflowDefinition['steps'][number])=>onChange({...definition,steps:definition.steps.map((step,i)=>i===index?next:step)});
  return <div className="workflow-editor"><label htmlFor="workflow-name">워크플로 이름</label><input id="workflow-name" value={definition.name} maxLength={120} disabled={disabled} onChange={event=>onChange({...definition,name:event.target.value})}/>
    {definition.steps.map((step,index)=><fieldset className="workflow-step" key={step.id} disabled={disabled}><legend>단계 {step.id}</legend>
      <label>등록 명령<select value={step.commandId} aria-label={step.id+' 등록 명령'} onChange={event=>update(index,{...step,commandId:event.target.value})}>
        {!commands.some(command=>command.id===step.commandId)&&<option value={step.commandId}>미등록: {step.commandId}</option>}{commands.map(command=><option key={command.id} value={command.id}>{command.label} · {command.id}</option>)}
      </select></label><div className="workflow-dependencies">dependsOn · 선행 단계{definition.steps.filter(other=>other.id!==step.id).map(other=><label key={other.id}><input type="checkbox" checked={step.dependsOn.includes(other.id)} onChange={event=>update(index,{...step,dependsOn:event.target.checked?[...step.dependsOn,other.id]:step.dependsOn.filter(id=>id!==other.id)})}/>{other.id}</label>)}</div>
      <button onClick={()=>onChange({...definition,steps:definition.steps.filter(value=>value.id!==step.id).map(value=>({...value,dependsOn:value.dependsOn.filter(id=>id!==step.id)}))})}>단계 제거</button>
    </fieldset>)}
    <button disabled={disabled||!commands.length||definition.steps.length>=12} onClick={()=>{let number=1;while(definition.steps.some(step=>step.id==='step-'+number))number++;onChange({...definition,steps:[...definition.steps,{id:'step-'+number,commandId:commands[0].id,dependsOn:[]}]});}}>등록 명령 단계 추가</button>
  </div>;
}
export function WorkflowExecution({preview,confirmed,canExecute,retryRun,onConsent,onStart}:{preview:WorkflowPreview;confirmed:boolean;canExecute:boolean;retryRun:WorkflowRun|null;onConsent:(value:boolean)=>void;onStart:()=>void}){
  return <section className="workflow-preview" aria-label="워크플로 실행 미리보기"><h3>조회 당시 실행 미리보기</h3><p>{preview.name} · 총 timeout {preview.totalTimeoutMs} ms · 기준 commit <code>{preview.baseSha}</code></p><p>source <code>{preview.sourceDigest}</code><br/>config <code>{preview.configDigest}</code><br/>preview <code>{preview.previewDigest}</code></p><p>{preview.scope}</p>
    <ol>{preview.steps.map(step=><li key={step.id}><b>{step.id} · {step.command.label}</b><pre>{JSON.stringify([step.command.executable,...step.command.args])}</pre><p>timeout {step.command.timeoutMs} ms · dependsOn {step.dependsOn.join(', ')||'없음'} · config <code>{step.command.configDigest}</code></p></li>)}</ol>
    {retryRun&&<p>명시 재시도: {retryRun.id} · 이전 attempt {retryRun.attempt}. 조건은 서버에서 다시 확인합니다.</p>}
    <label className="workflow-consent"><input id="workflow-execution-consent" type="checkbox" checked={confirmed} onChange={event=>onConsent(event.target.checked)}/>전체 명령·제한·source를 검토했고 이 로컬 실행에 동의합니다.</label>
    <button disabled={!canExecute} onClick={()=>{if(canExecute)onStart();}}>{retryRun?'동일 조건으로 명시 재시도':'승인한 워크플로 실행'}</button>
  </section>;
}
type HistoryProps={projectId:string;workspaceId:string|null;runs:readonly WorkflowRun[];online:boolean;actionBusy:boolean;otherBusy:boolean;recoveryConsent:string|null;onInterrupt:(run:WorkflowRun)=>void;onRetry:(run:WorkflowRun)=>void;onRecover:(run:WorkflowRun)=>void;onRecoveryConsent:(runId:string,value:boolean)=>void};
export function WorkflowHistory(props:HistoryProps){
  const rows=props.runs.filter(run=>run.projectId===props.projectId&&(!props.workspaceId||run.workspaceId===props.workspaceId)).slice().sort((a,b)=>Number(b.status==='lost'&&!b.recoveredAt)-Number(a.status==='lost'&&!a.recoveredAt)||b.createdAt.localeCompare(a.createdAt)).slice(0,20);
  return <section className="workflow-history" aria-label="워크플로 실행 기록"><h3>실제 실행 기록 · 미확인 우선 · 최대 20개</h3>{!rows.length&&<p>저장된 실행이 없습니다. 실행이나 통과 기록을 생성하지 않았습니다.</p>}
    <ul className="record-list">{rows.map(run=><li key={run.id}><div><b>{statuses[run.status]}</b><p>Run {run.id} · version {run.versionId} · attempt {run.attempt} · workspace {run.workspaceId}</p><p>생성 {run.createdAt} · 종료 {run.finishedAt??'unknown'} · source <code>{run.sourceDigest}</code></p>{run.issue&&<p>진단 <code>{run.issue}</code></p>}
      <details><summary>단계 결과와 정제된 출력</summary>{run.steps.map(step=><article key={step.id}><h4>{step.id} · {step.commandId} · {statuses[step.status]}</h4><p>exit {step.exitCode??'unknown'} · 시간 {step.durationMs??'unknown'} ms · 종료 {step.finishedAt??'unknown'}</p>{(step.truncated||step.output.length>64000)&&<p>출력이 제한되거나 잘렸습니다.</p>}<pre>{step.output.slice(0,64000)||'출력 없음'}</pre></article>)}</details>
      {['failed','interrupted','timed_out'].includes(run.status)&&<button disabled={!props.online||props.actionBusy||run.attempt>=3||props.runs.some(value=>value.retryOfId===run.id)||run.workspaceId!==props.workspaceId} onClick={()=>props.onRetry(run)}>이 실패 실행을 재시도 대상으로 선택</button>}
      {run.status==='lost'&&!run.recoveredAt&&<div className="workflow-recovery"><p>이전 프로세스가 종료됐는지 직접 확인해야 새 실행 차단을 해제할 수 있습니다. 결과는 unknown이며 복구가 재실행이나 통과를 뜻하지 않습니다.</p><label className="workflow-consent"><input type="checkbox" checked={props.recoveryConsent===run.id} disabled={!props.online||props.actionBusy||props.otherBusy||run.workspaceId!==props.workspaceId} onChange={event=>props.onRecoveryConsent(run.id,event.target.checked)}/>이전 프로세스가 종료되었음을 확인</label><button disabled={!props.online||props.actionBusy||props.otherBusy||run.workspaceId!==props.workspaceId||props.recoveryConsent!==run.id} onClick={()=>props.onRecover(run)}>종료 확인 후 복구</button></div>}
      {run.status==='lost'&&run.recoveredAt&&<p>프로세스 종료 확인 {run.recoveredAt} · 실행 결과는 미확인으로 보존하며 자동 재실행하지 않았습니다.</p>}
    </div>{run.status==='running'&&<button disabled={!props.online||props.actionBusy||run.workspaceId!==props.workspaceId} onClick={()=>props.onInterrupt(run)}>워크플로 중단</button>}</li>)}</ul>
  </section>;
}
