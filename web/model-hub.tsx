import {useEffect,useMemo,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import type {ModelHubView,ModelHubRequest,ModelProviderId} from '../shared/model-hub.ts';
import {createStudioMutator} from './studio-client.ts';
export interface ModelHubPanelProps {projectId:string;online:boolean;nativeBusy:boolean;post:(path:string,body:object)=>Promise<unknown>}
type Epoch={generation:number;epoch:number};
/** Shared by actual GET/poll/POST paths: only the newest response in a live scope may publish. */
export function createModelHubRequestEpoch(){
  let generation=0,epoch=0,live=false;
  return {reset(){generation++;epoch++;live=true;},dispose(){generation++;epoch++;live=false;},next(){return {generation,epoch:++epoch};},
    isCurrent(token:Epoch){return live&&token.generation===generation&&token.epoch===epoch;},sameScope(token:Epoch){return live&&token.generation===generation;}};
}
const providerNames={ 'openai-compatible':'OpenAI-compatible',litellm:'LiteLLM',vllm:'vLLM',freellmapi:'FreeLLMAPI',local:'Local',bedrock:'Bedrock',future:'향후 확장'};
const executionNames={running:'응답 생성 중',completed:'응답 완료',failed:'실패',interrupted:'중단 확인',lost:'재시작·결과 미확인'};
const destinationNames={configured:'이 프로젝트에서 사용 가능',disabled:'서버 설정에서 비활성',project_blocked:'현재 프로젝트 범위 밖'};
const number=(value:number|null)=>value===null?'unknown':value.toLocaleString('ko-KR');
const temporaryInputNames={none:'없음',possible:'존재 가능 · 확인 필요',present:'임시 입력 파일 남음',removed:'정리됨',cleanup_required:'정리 필요'};
/** Attestation is bound to the exact persisted record and can never authorize another scope or a running child. */
export function modelInputCleanupKey(request:ModelHubRequest,projectId:string):string|null{
  if(!projectId||request.projectId!==projectId||request.providerId!=='bedrock'||!['completed','failed','interrupted','lost'].includes(request.execution)||!['possible','present','cleanup_required'].includes(request.temporaryInput??''))return null;
  return JSON.stringify([projectId,request.id,request.destinationId,request.configDigest,request.execution,request.temporaryInput]);
}
export function modelHubRecoveryBlocksSend(providerId:ModelProviderId|undefined,recovery:ModelHubView['bedrockRecovery']):boolean{
  return providerId==='bedrock'&&!!recovery?.length;
}
export function BedrockDestinationDisclosure(){return <div className="notice model-hub-bedrock-disclosure">
  <p>공식 AWS CLI Converse는 비스트리밍입니다. 서버 기본 설정은 비활성이며 CLI 설치·인증·모델 접근 진단이 필요합니다. cross-region 추론과 profile 선택은 미지원입니다.</p>
  <p>기존 구독과 별도인 API 과금이며 비용은 unknown입니다. 토큰·시간 제한은 요금 상한이 아닙니다. 중단·timeout 이후에도 원격 완료·과금 여부는 미확인입니다.</p>
  <p>입력은 argv·DB·events에 저장하지 않지만 전송 동의 후 소유 임시 파일에 기록합니다. 정상 종료 시 정리하며 비정상 종료 후 파일이 남을 수 있습니다. 요청 기록에서 상태를 확인하고 프로세스 종료 확인 후 정리하세요.</p>
  </div>;}

/** Project switches unmount all draft/consent/request state instead of reusing another project's UI. */
export function ModelHubPanel(props:ModelHubPanelProps){return <ScopedModelHub key={props.projectId||'no-project'} {...props}/>;}
function ScopedModelHub({projectId,online,nativeBusy,post}:ModelHubPanelProps){
  const [view,setView]=useState<ModelHubView|null>(null),[destinationId,setDestinationId]=useState(''),[model,setModel]=useState(''),[text,setText]=useState('');
  const [consent,setConsent]=useState<string|null>(null),[busy,setBusy]=useState<'models'|'send'|'cleanup'|null>(null),[loading,setLoading]=useState(false);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState(''),[uncertain,setUncertain]=useState(false),[stoppingId,setStoppingId]=useState<string|null>(null),[stopAcceptedId,setStopAcceptedId]=useState<string|null>(null);
  const [cleanupConsentKey,setCleanupConsentKey]=useState<string|null>(null),[cleaningId,setCleaningId]=useState<string|null>(null),[cleanupUncertain,setCleanupUncertain]=useState(false);
  const order=useMemo(()=>createModelHubRequestEpoch(),[]),postRef=useRef(post),viewRef=useRef<ModelHubView|null>(null),mutation=useRef<Epoch|null>(null),stopping=useRef<string|null>(null);
  const reload=useRef<(mode?:'poll'|'manual')=>void>(()=>{});postRef.current=post;
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{/* Only ID/hash receipts are kept in memory when storage is unavailable. */}
    return createStudioMutator((path,data)=>postRef.current(path,data),storage);},[]);
  useEffect(()=>{
    order.reset();viewRef.current=null;setView(null);setConsent(null);setCleanupConsentKey(null);setCleaningId(null);setCleanupUncertain(false);setError('');setLoadError('');setLoading(false);mutation.current=null;stopping.current=null;setBusy(null);setStoppingId(null);setStopAcceptedId(null);
    let timer:ReturnType<typeof setTimeout>|undefined,reader:AbortController|null=null;
    const schedule=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>void load(),viewRef.current?.activeRequestId?1000:15000);};
    async function load(mode:'poll'|'manual'='poll'){
      if(!online)return;if(timer)clearTimeout(timer);
      if(mutation.current||stopping.current){timer=setTimeout(()=>void load(),1000);return;}
      const ticket=order.next();reader?.abort();const controller=new AbortController();reader=controller;setLoading(true);
      try{const response=await fetch('/api/model-hub'+(projectId?'?projectId='+encodeURIComponent(projectId):''),{signal:controller.signal});if(!response.ok)throw new Error();
        const result=await response.json() as ModelHubView;if(!order.isCurrent(ticket))return;viewRef.current=result;setView(result);setLoadError('');if(mode==='manual'){setCleanupUncertain(false);setError('');setCleanupConsentKey(null);}
      }catch{if(order.isCurrent(ticket)&&!controller.signal.aborted)setLoadError('Model Hub 상태를 불러오지 못했습니다. 다시 조회하세요.');}
      finally{if(order.isCurrent(ticket))setLoading(false);if(order.sameScope(ticket))schedule();}
    }
    reload.current=mode=>void load(mode);if(online)void load();
    return()=>{order.dispose();reader?.abort();if(timer)clearTimeout(timer);reload.current=()=>{};};
  },[projectId,online,order]);
  const destination=view?.destinations.find(item=>item.id===destinationId)??view?.destinations.find(item=>item.status==='configured')??view?.destinations[0];
  const models=destination?.catalog.status==='available'?destination.catalog.models.filter(id=>destination.configuredModels.includes(id)):[];
  const selectedModel=models.includes(model)?model:models[0]??'';
  const consentKey=JSON.stringify({projectId,destinationId:destination?.id??'',configDigest:destination?.configDigest??'',model:selectedModel,text});
  const confirmed=consent===consentKey;
  useEffect(()=>{setConsent(null);setCleanupConsentKey(null);},[destination?.id,destination?.configDigest,selectedModel]);
  const activeId=view?.activeRequestId??null,ownActive=activeId?view?.requests.find(request=>request.id===activeId&&request.projectId===projectId):undefined;
  const canCatalog=online&&!!projectId&&!!destination&&destination.status==='configured'&&!busy&&!stoppingId&&confirmed;
  const canSend=canCatalog&&!nativeBusy&&!activeId&&!!selectedModel&&!!text.trim()&&text.length<=4000&&!modelHubRecoveryBlocksSend(destination?.providerId,view?.bedrockRecovery);
  async function action(kind:'models'|'send'){
    if(mutation.current||stopping.current||(kind==='models'?!canCatalog:!canSend)||!destination)return;
    const ticket=order.next();mutation.current=ticket;setBusy(kind);setError('');
    const data={projectId,expectedConfigDigest:destination.configDigest,confirmed:true};
    try{
      if(kind==='models')await postRef.current('/api/model-hub/destinations/'+encodeURIComponent(destination.id)+'/models',data);
      else await mutate('/api/model-hub/requests',{...data,destinationId:destination.id,model:selectedModel,text});
      if(order.isCurrent(ticket)){setConsent(null);if(kind==='send'){setText('');setUncertain(false);}}
    }catch{if(order.isCurrent(ticket)){setError(kind==='models'?'모델 목록 조회 결과를 확인하지 못했습니다. 목적지와 서버 상태를 확인하세요.':'모델 요청 결과를 확인하지 못했습니다. 기록을 조회한 뒤 동일 입력으로 재시도할 수 있습니다.');if(kind==='send')setUncertain(true);}}
    finally{if(order.sameScope(ticket)&&mutation.current===ticket){mutation.current=null;setBusy(null);setConsent(null);reload.current();}}
  }
  async function interrupt(request:ModelHubRequest){
    if(!online||mutation.current||stopping.current||request.projectId!==projectId||request.execution!=='running')return;
    const ticket=order.next();stopping.current=request.id;setStoppingId(request.id);setError('');
    try{await postRef.current('/api/model-hub/requests/'+request.id+'/interrupt',{projectId});if(order.isCurrent(ticket))setStopAcceptedId(request.id);}
    catch{if(order.isCurrent(ticket))setError('중단 요청 응답을 확인하지 못했습니다. 서버의 실제 요청 상태를 다시 확인하세요.');}
    finally{if(order.sameScope(ticket)&&stopping.current===request.id){stopping.current=null;setStoppingId(null);reload.current();}}
  }
  async function cleanup(request:ModelHubRequest){
    const current=viewRef.current?.requests.find(value=>value.id===request.id),key=current?modelInputCleanupKey(current,projectId):null;
    if(!online||cleanupUncertain||mutation.current||stopping.current||viewRef.current?.activeRequestId||!key||cleanupConsentKey!==key||modelInputCleanupKey(request,projectId)!==key)return;
    const ticket=order.next();mutation.current=ticket;setBusy('cleanup');setCleaningId(request.id);setCleanupConsentKey(null);setConsent(null);setError('');
    try{
      const result=await postRef.current('/api/model-hub/requests/'+encodeURIComponent(request.id)+'/cleanup',{projectId,confirmedStopped:true}) as ModelHubRequest;
      if(!order.isCurrent(ticket))return;if(result.id!==request.id||result.projectId!==projectId||result.providerId!=='bedrock')throw new Error();setCleanupUncertain(false);
    }catch{if(order.isCurrent(ticket)){setCleanupUncertain(true);setError('임시 입력 정리 응답을 확인하지 못했습니다. 성공으로 판단하지 말고 상태를 명시 새로고침하세요. 자동 재시도하거나 모델 요청을 다시 보내지 않습니다.');}}
    finally{if(order.sameScope(ticket)&&mutation.current===ticket){mutation.current=null;setBusy(null);setCleaningId(null);reload.current();}}
  }
  function submit(event:FormEvent){event.preventDefault();void action('send');}
  return <section className="surface model-hub-panel" aria-label="Model Hub">
    <div className="section-heading"><div><h2>Model Hub</h2><p>서버에서 설정한 목적지로 보내는 텍스트 전용 요청입니다.</p></div><button onClick={()=>reload.current('manual')} disabled={!online||loading||!!busy||!!stoppingId} aria-busy={loading}>Model Hub 상태 새로고침</button></div>
    <ModelHubOverview view={view} projectId={projectId}/>
    {!online&&<p role="status">로컬 서버 연결 후 목적지와 요청 기록을 확인할 수 있습니다.</p>}
    {loadError&&<p role="alert">{loadError}</p>}{error&&<p role="alert">{error}</p>}
    {view&&!!view.destinations.length&&<div className="model-hub-controls">
      <label htmlFor="model-hub-destination">목적지</label><select id="model-hub-destination" value={destination?.id??''} disabled={!online||!!busy} onChange={event=>{setDestinationId(event.target.value);setModel('');setConsent(null);}}>
        {view.destinations.map(item=><option key={item.id} value={item.id}>{item.label} · {providerNames[item.providerId]} · {destinationNames[item.status]}</option>)}
      </select>
      {destination&&<div className="notice"><b>{destinationNames[destination.status]}</b><p>실제 목적지: <code>{destination.endpoint}</code></p>
        <p>{destination.providerId==='bedrock'?'AWS CLI 지역 목적지':destination.locality==='external'?'외부 HTTPS 목적지':'Loopback 목적지 · 무료/오프라인 보장 없음'} · 제한 {destination.timeoutMs/1000}초 · 요청 출력 상한 {destination.maxOutputTokens} tokens</p>
        <p>설정 digest: <code>{destination.configDigest}</code></p><p>인증: {destination.credential==='reference_configured'?'서버 인증정보 참조 설정됨 · 실제 인증 성공은 미확인':'인증정보 필수 설정 없음 · 실제 접근 가능 여부는 미확인'}</p>
        <p>서버 허용 목록: {destination.configuredModels.join(' · ')}</p>
        <p>모델 목록: {destination.catalog.status==='not_queried'?'미조회':destination.catalog.status==='available'?'명시적 조회 결과 있음':destination.catalog.status==='empty'?'허용 모델을 반환하지 않음':'조회 실패'}{destination.catalog.checkedAt?' · '+new Date(destination.catalog.checkedAt).toLocaleString('ko-KR'):''}</p>
        {destination.catalog.issue&&<p>조회 진단: <code>{destination.catalog.issue}</code></p>}
      </div>}
      {destination?.providerId==='bedrock'&&<BedrockDestinationDisclosure/>}
      <label htmlFor="model-hub-model">서버 허용 모델</label><select id="model-hub-model" value={selectedModel} disabled={!online||!!busy||!models.length} onChange={event=>{setModel(event.target.value);setConsent(null);}}>
        {!models.length&&<option value="">동의 후 모델 목록을 먼저 조회하세요</option>}{models.map(id=><option key={id} value={id}>{id}</option>)}
      </select>
      <form onSubmit={submit}>
        <label htmlFor="model-hub-prompt">모델 입력</label><textarea id="model-hub-prompt" maxLength={4000} value={text} disabled={!online||!!busy||!projectId} onChange={event=>{setText(event.target.value);setConsent(null);}} placeholder="최대 4,000자 · 개인정보와 인증정보를 입력하지 마세요."/>
        <label className="model-hub-consent" htmlFor="model-hub-consent"><input id="model-hub-consent" type="checkbox" checked={confirmed} disabled={!online||!!busy||!projectId||destination?.status!=='configured'} onChange={event=>setConsent(event.target.checked?consentKey:null)}/>목적지와 모델·제한을 확인했으며 모델 조회 또는 입력 전송에 동의합니다.{destination?.providerId==='bedrock'&&' 비스트리밍·별도 API 과금 unknown·원격 완료 미확인·전송 시 임시 입력 파일 사용과 비정상 종료 시 잔존 가능성을 확인했습니다.'}</label>
        <div className="composer-bottom"><span>{text.length.toLocaleString('ko-KR')} / 4,000자 · {destination?.providerId==='bedrock'?'입력 본문 DB 저장 없음 · 전송 동의 후 임시 파일 사용':'원문 자동 저장 없음'}</span><div><button type="button" onClick={()=>void action('models')} disabled={!canCatalog} aria-busy={busy==='models'}>모델 목록 조회</button><button type="submit" className="primary" disabled={!canSend} aria-busy={busy==='send'}>모델 요청 전송</button></div></div>
      </form>
      {nativeBusy&&<p role="status">현재 native 에이전트 또는 검증 작업이 진행 중이라 새 모델 전송은 차단됩니다. 기존 모델 요청은 중단할 수 있습니다.</p>}
      {activeId&&<p role="status">{ownActive?'현재 프로젝트에서 모델 요청이 진행 중입니다.':'다른 프로젝트에서 모델 요청이 진행 중입니다. 해당 프로젝트에서 기록·중단을 확인하세요.'} 동시에 새 요청을 보내지 않습니다.</p>}
    </div>}
    {uncertain&&<p className="notice" role="status">이전 전송의 응답을 확인하지 못했습니다. 기록을 확인한 뒤 같은 입력을 다시 승인하면 보존된 요청 ID로 복구합니다. 브라우저에는 요청 ID·digest만 보존하며 원문은 새로고침 후 복원되지 않습니다.</p>}
    {cleanupUncertain&&<p className="notice" role="status">임시 입력 정리 결과는 미확인입니다. Model Hub 상태 새로고침 후 기록의 임시 입력 상태를 확인하세요. 정리는 모델 요청을 재전송하지 않습니다.</p>}
    <ModelHubRequestHistory requests={view?.requests??[]} projectId={projectId} online={online} stoppingId={stoppingId} stopAcceptedId={stopAcceptedId} onInterrupt={request=>void interrupt(request)} cleaningId={cleaningId} cleanupConsentKey={cleanupConsentKey} cleanupBlocked={!!busy||!!stoppingId||!!activeId||cleanupUncertain} onConfirmCleanup={(request,value)=>setCleanupConsentKey(value?modelInputCleanupKey(request,projectId):null)} onCleanup={request=>void cleanup(request)}/>
  </section>;
}
export function ModelHubOverview({view,projectId}:{view:ModelHubView|null;projectId:string}){
  return <>
    <p className="notice">Native Codex/Claude 구독과 별도인 연결입니다. API 비용: unknown. 토큰 수나 로컬 주소로 무료·구독 차감을 추정하지 않습니다.</p>
    {!!view?.bedrockRecovery?.length&&<div className="notice model-hub-recovery" role="status"><p>미정리 Bedrock 입력이 있어 새 Bedrock 전송을 차단합니다. 해당 프로젝트를 선택한 뒤 이전 프로세스 종료를 확인하고 요청 기록에서 임시 입력 파일을 정리하세요. HTTP 목적지 전송과 모델 목록 진단은 이 복구 조건으로 차단하지 않습니다.</p><ul>{view.bedrockRecovery.map(item=><li key={item.projectId+':'+item.requestId}>프로젝트 <code>{item.projectId}</code> · 요청 <code>{item.requestId}</code></li>)}</ul></div>}
    {!projectId&&<p>프로젝트를 선택하면 허용된 목적지와 해당 프로젝트 기록을 확인할 수 있습니다.</p>}
    {view?<><ul className="capability-list model-hub-provider-list">{view.providers.map(provider=><li key={provider.id}><b>{providerNames[provider.id]}</b><span>{provider.implementation==='http_json_sse'?'HTTP JSON/SSE 조건부 지원 · 설정/동의/진단 필요':provider.implementation==='aws_cli_converse'?'공식 AWS CLI Converse 조건부 지원 · 비스트리밍 · CLI/인증/모델 접근 진단 필요':provider.implementation==='not_implemented'?'미구현':'향후 확장 지점 · 미연결'}</span></li>)}</ul>
      {!view.destinations.length&&<p>서버에 설정된 목적지가 없습니다. 서버 설정이 추가되기 전 외부 모델 요청은 보내지 않습니다.</p>}</>:<p role="status">서버 목적지 설정 확인 중…</p>}
    <p className="subtle">상태 조회는 저장된 메타데이터만 읽습니다. 실제 모델 목록 조회와 입력 전송은 아래 명시적 동의 버튼으로만 수행합니다. 공급자의 실제 출력 제한 준수 여부는 미확인입니다. 모델 응답 완료는 코드 변경·실제 검증·요금 상한 보장이 아닙니다.</p>
  </>;
}
interface ModelHubHistoryProps {requests:ModelHubRequest[];projectId:string;online:boolean;stoppingId:string|null;stopAcceptedId?:string|null;onInterrupt:(request:ModelHubRequest)=>void;
  cleanupConsentKey?:string|null;cleaningId?:string|null;cleanupBlocked?:boolean;onConfirmCleanup?:(request:ModelHubRequest,value:boolean)=>void;onCleanup?:(request:ModelHubRequest)=>void}
export function ModelHubRequestHistory({requests,projectId,online,stoppingId,stopAcceptedId=null,onInterrupt,cleanupConsentKey=null,cleaningId=null,cleanupBlocked=false,onConfirmCleanup,onCleanup}:ModelHubHistoryProps){
  const rows=requests.filter(request=>request.projectId===projectId);
  return <section className="model-hub-history" aria-label="Model Hub 요청 기록"><h3>모델 요청 기록</h3>
    <p className="subtle">입력 본문을 DB의 별도 필드로 저장하지 않으며 모델 응답에 포함될 수 있습니다. Bedrock 전송은 별도 동의 후 임시 파일을 사용하며 아래 상태를 확인해야 합니다.</p>
    {!rows.length?<p className="subtle">이 프로젝트에 저장된 모델 요청이 없습니다.</p>:<ul className="record-list">{rows.map(request=><li key={request.id}><div>
      <b>{providerNames[request.providerId]} · {request.model} · {executionNames[request.execution]}</b>
      <p>{new Date(request.createdAt).toLocaleString('ko-KR')} · 목적지 {request.destinationId} · 요청 {request.id}</p>
      <p>경과 {request.durationMs===null?'unknown':(request.durationMs/1000).toFixed(2)+'초'} · 제한 {request.timeoutMs/1000}초 · 요청 출력 상한 {request.maxOutputTokens} tokens · API 비용 unknown</p>
      <p>토큰 출처: {request.usage.source==='provider'?'공급자 응답':'unknown'} · 입력 {number(request.usage.promptTokens)} · 출력 {number(request.usage.completionTokens)} · 합계 {number(request.usage.totalTokens)}</p>
      {request.providerId==='bedrock'&&<div className="model-hub-temporary-input"><p>임시 입력: {request.temporaryInput?temporaryInputNames[request.temporaryInput]:'미확인'} · 비스트리밍 · {request.execution==='completed'?'응답 수신 · 실제 청구액 unknown':'원격 완료·과금 여부 미확인'}</p>
        {modelInputCleanupKey(request,projectId)&&<><label className="model-hub-consent"><input type="checkbox" aria-label={'임시 입력 정리 종료 확인 '+request.id} checked={cleanupConsentKey===modelInputCleanupKey(request,projectId)} disabled={!online||cleanupBlocked||!!cleaningId||!!stoppingId||!onConfirmCleanup} onChange={event=>onConfirmCleanup?.(request,event.target.checked)}/>이전 AWS CLI 프로세스가 종료되었음을 확인</label>
          <button onClick={()=>onCleanup?.(request)} disabled={!online||cleanupBlocked||!!cleaningId||!!stoppingId||!onCleanup||cleanupConsentKey!==modelInputCleanupKey(request,projectId)} aria-busy={cleaningId===request.id}>임시 입력 파일 정리</button><p>서버가 소유 임시 파일만 정리합니다. 모델 재전송·결과 검증·원격 중단 확인은 하지 않습니다.</p></>}
      </div>}
      <details><summary>요청 증거</summary><p>설정 digest: <code>{request.configDigest}</code></p><p>요청 ID: <code>{request.requestId}</code></p></details>
      {request.issue&&<p>진단: <code>{request.issue}</code></p>}
      <pre className="model-hub-response">{request.response||(request.execution==='running'?'응답을 기다립니다…':'반환된 텍스트 없음')}</pre>
      <p className="subtle">응답 완료와 코드·테스트 검증은 별개입니다. 비용은 공급자 요금 상한을 증명하지 않습니다.</p>
      {stopAcceptedId===request.id&&request.execution==='running'&&<p role="status">중단 요청을 보냈습니다. 서버의 최종 종료 상태를 기다립니다.</p>}
    </div>{request.execution==='running'&&<button onClick={()=>onInterrupt(request)} disabled={!online||stoppingId!==null||stopAcceptedId===request.id} aria-busy={stoppingId===request.id}>요청 중단</button>}</li>)}</ul>}
  </section>;
}
