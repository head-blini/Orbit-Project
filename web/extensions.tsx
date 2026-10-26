import {useEffect,useMemo,useRef,useState} from 'react';
import type {ProviderStatus} from '../shared/types.ts';
import type {ExtensionInventory,ExtensionKind,ExtensionSection} from '../shared/extensions.ts';
export interface ExtensionsPanelProps {workspaceId:string|null;matches:boolean;online:boolean;status?:ProviderStatus;busy:boolean;post:(path:string,body:object)=>Promise<unknown>}
type Scope=Omit<ExtensionsPanelProps,'busy'|'post'>;
type RequestState={inventory:ExtensionInventory|null;loading:boolean;refreshing:boolean;error:string};
const empty=():RequestState=>({inventory:null,loading:false,refreshing:false,error:''});
type Ticket={generation:number;epoch:number};

/** Actual UI request coordinator. Only an explicit refresh invokes POST; scope
 * resets and cached GETs never collect native inventory. Late finally blocks
 * cannot unlock a newer scope's pending request. */
export function createExtensionsRequests(dependencies:{get:()=>Promise<ExtensionInventory>;post:(workspaceId:string|null)=>Promise<ExtensionInventory>;publish:(value:RequestState)=>void}){
  let scope:Scope={workspaceId:null,matches:false,online:false},state=empty(),live=false,generation=0,epoch=0,pending:Ticket|null=null;
  const current=(ticket:Ticket)=>live&&ticket.generation===generation&&ticket.epoch===epoch;
  const emit=(next:RequestState)=>{state=next;if(live)dependencies.publish(next);};
  function scoped(value:ExtensionInventory):ExtensionInventory|null{
    if(!scope.online||scope.status!=='ready'||!scope.matches)return null;
    if(value.workspaceId!==scope.workspaceId)throw new Error('WORKSPACE_MISMATCH');return value;
  }
  return {
    reset(next:Scope){generation++;epoch++;pending=null;live=true;scope={...next};emit(empty());},
    dispose(){live=false;generation++;epoch++;pending=null;},
    snapshot(){return state;},
    async load():Promise<boolean>{
      if(!live||!scope.online||pending||state.loading)return false;
      const ticket={generation,epoch:++epoch};emit({...state,loading:true,error:''});
      try{const value=await dependencies.get();if(!current(ticket))return false;emit({...state,inventory:scoped(value),error:''});return true;}
      catch{if(current(ticket))emit({...state,error:'확장 목록 상태를 불러오지 못했습니다. 다시 새로고침하세요.'});return false;}
      finally{if(current(ticket))emit({...state,loading:false});}
    },
    async refresh(busy:boolean):Promise<boolean>{
      if(!live||!scope.online||scope.status!=='ready'||!scope.matches||busy||pending)return false;
      const ticket={generation,epoch:++epoch},workspaceId=scope.workspaceId;pending=ticket;emit({...state,loading:false,refreshing:true,error:''});
      try{const value=await dependencies.post(workspaceId);if(!current(ticket))return false;emit({...state,inventory:scoped(value),error:''});return true;}
      catch{if(current(ticket))emit({...state,error:'현재 작업 공간의 공식 확장 목록을 조회하지 못했습니다. 연결과 작업 공간을 확인하세요.'});return false;}
      finally{if(pending===ticket){pending=null;if(current(ticket))emit({...state,refreshing:false});}}
    },
  };
}

export function ExtensionsPanel({workspaceId,matches,online,status,busy,post}:ExtensionsPanelProps){
  const [state,setState]=useState<RequestState>(empty),postRef=useRef(post);postRef.current=post;
  const requests=useMemo(()=>createExtensionsRequests({
    get:async()=>{const response=await fetch('/api/extensions');if(!response.ok)throw new Error();return response.json() as Promise<ExtensionInventory>;},
    post:async id=>postRef.current('/api/extensions/refresh',{workspaceId:id}) as Promise<ExtensionInventory>,publish:setState,
  }),[]);
  // busy can include this component's own native request. It must not reset or
  // discard that request when the server publishes extensionBusy=true.
  useEffect(()=>{requests.reset({workspaceId,matches,online,status});if(online)void requests.load();return()=>requests.dispose();},[workspaceId,matches,online,status,requests]);
  const visible=online&&status==='ready'&&matches;
  const canCollect=visible&&!busy&&!state.refreshing;
  return <section className="surface extensions-panel" aria-label="공식 확장 목록">
    <div className="section-heading"><div><h2>현재 세션 확장 목록</h2><p>현재 연결된 Codex의 읽기 전용 메타데이터입니다.</p></div><div className="extensions-actions">
      <button onClick={()=>void requests.refresh(busy)} disabled={!canCollect} aria-busy={state.refreshing}>{state.refreshing?'공식 목록 조회 중…':'공식 확장 목록 조회'}</button>
      <button onClick={()=>void requests.load()} disabled={!online||state.loading||state.refreshing} aria-busy={state.loading}>목록 상태 새로고침</button>
    </div></div>
    <p className="subtle">공식 목록 재수집은 조회 버튼을 눌렀을 때만 수행하며 결과는 60초 동안 재사용합니다. 목록 상태 새로고침은 서버 캐시만 읽고 재수집하지 않습니다.</p>
    {!matches?<p className="hint">현재 프로젝트의 작업 공간을 선택하세요.</p>:!online?<p className="hint">서버 연결 후 목록 상태를 확인할 수 있습니다.</p>:status!=='ready'?<p className="hint">현재 작업 공간에서 Codex를 연결한 뒤 명시적으로 조회하세요.</p>:busy&&!state.refreshing?<p className="hint">다른 작업이 진행 중입니다. 작업 종료 후 공식 목록을 조회하세요.</p>:null}
    {state.refreshing&&<p role="status">공식 확장 목록 조회 중…</p>}{state.loading&&<p role="status">서버 캐시 상태 확인 중…</p>}
    {state.error&&<p role="alert">{state.error}</p>}
    {matches&&workspaceId===null&&<p className="subtle">읽기 전용 세션의 목록입니다.</p>}
    <ExtensionsInventoryDetails inventory={state.inventory} workspaceId={workspaceId} visible={visible}/>
  </section>;
}

const kinds:ExtensionKind[]=['skills','hooks','mcp','plugins'];
const labels:Record<ExtensionKind,string>={skills:'Skills',hooks:'Hooks',mcp:'MCP',plugins:'Plugins'};
const sectionLabels:Record<ExtensionSection['status'],string>={available:'목록 응답 확인',partial:'일부 항목만 확인',unknown:'미조회 · unknown',not_connected:'Orbit 미연결'};
const configured=(value:boolean|null)=>value===true?'켜짐':value===false?'꺼짐':'unknown';
const checked=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR'):'unknown';
const handlers={command:'명령형',mcpTool:'MCP 도구형',prompt:'프롬프트형',agent:'에이전트형'};

export function ExtensionsInventoryDetails({inventory,workspaceId,visible}:{inventory:ExtensionInventory|null;workspaceId:string|null;visible:boolean}){
  const value=visible&&inventory?.workspaceId===workspaceId?inventory:null;
  return <>
    <p className="subtle extensions-summary">출처: {value?.source==='codex_app_server'?'Codex App Server':'아직 조회하지 않음'} · 갱신 {checked(value?.checkedAt??null)} · {value?value.status==='available'?'목록 응답 확인':value.status==='partial'?'일부 결과 · 전체 목록 unknown':'unknown':'unknown'}</p>
    <p className="subtle">설정상 enabled와 Orbit 실행 가능 상태는 별개입니다. 버전은 unknown으로 표시하며 설치·실행 성공을 추정하지 않습니다. Native 신뢰 상태는 Orbit 승인과 별개입니다. MCP의 설정상 값은 현재 스레드의 disabled override이며 원래 전역 설정을 뜻하지 않습니다.</p>
    <div className="extensions-sections">{kinds.map(kind=>{
      const section:ExtensionSection=kind==='plugins'?{kind,status:'not_connected',issue:null,items:[]}:value?.sections.find(section=>section.kind===kind)??{kind,status:'unknown',issue:null,items:[]};
      return <section key={kind} className="extension-section" aria-label={labels[kind]} data-extension-kind={kind}>
        <div className="section-heading"><h3>{labels[kind]}</h3><span className="badge">{sectionLabels[section.status]}</span></div>
        {section.status==='partial'&&<p className="subtle">표시된 항목은 일부 결과이며 전체 목록은 unknown입니다.</p>}
        {section.issue&&<p className="hint">진단 코드: <code>{section.issue}</code></p>}
        {!section.items.length?<p className="subtle">{kind==='plugins'?'Plugins 조회·설치는 미연결입니다.':section.status==='available'?'조회된 항목 없음':section.status==='partial'?'표시할 항목 없음 · 전체 목록 unknown':'목록 미조회 · unknown'}</p>:<ul className="capability-list extensions-items">{section.items.map(item=><li key={item.id}>
          <div><b>{item.name}</b><span className="badge">{item.effective==='blocked_policy'?'현재 정책에서 비활성':'실행 가능 여부 unknown'}</span></div>
          <p>범위: {item.scope} · 버전: unknown</p><p>설정상 enabled: {configured(item.configuredEnabled)} · Orbit 실행: {item.effective==='blocked_policy'?'현재 정책에서 비활성':'unknown'}</p>
          {kind==='hooks'&&<p>Native 신뢰 상태: {item.nativeTrust} · Orbit 승인과 별개</p>}
          {item.handlerType&&<p>핸들러 유형: {handlers[item.handlerType]}</p>}
          {item.pluginOwned!==null&&<p>플러그인 소유: {item.pluginOwned?'예':'아니오'}</p>}
        </li>)}</ul>}
      </section>;
    })}</div>
    <p className="subtle extensions-boundary">Claude 어댑터와 확장 조회는 미연결입니다. 확장 설치·설정 변경·프로필·백업/복원은 미구현입니다. 현재 Codex 실행의 MCP 격리 정책은 유지됩니다.</p>
  </>;
}
