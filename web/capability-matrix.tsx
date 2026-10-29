import {useEffect,useState} from 'react';
import type {OrchestrationRegistry,CapabilitySupport} from '../shared/capability-orchestration.ts';
import type {ProviderStatus} from '../shared/types.ts';
import type {ToolAggregate,ToolInstalled,ToolInvoked,ToolKind,ToolState} from '../shared/tool-capabilities.ts';
import {useUiMode,type UiMode} from './ui-mode.ts';
const installedLabel:Record<ToolInstalled,string>={discovered:'발견됨',absent:'없음',unknown:'미확인'};
const kindLabel:Record<ToolKind,string>={mcp:'MCP',skill:'스킬',plugin:'플러그인',hook:'훅',subagent:'서브에이전트',slash_command:'슬래시 명령'};
/** Display-only reasons mirroring TOOLS-D1 adopted defaults; they never grant anything. */
function policyReason(runtimeId:string,kind:ToolKind){
 if(kind==='mcp')return runtimeId==='claude-code'?'Claude MCP 차단 · command 주입이 필요해 허용 불가':null;
 if(kind==='hook'||kind==='subagent')return '발견 전용 · 허용·호출 불가';
 if(kind==='plugin')return '플러그인 로드 안 함';
 if(kind==='slash_command')return '슬래시 명령 미지원 · 허용·호출 불가';
 if(kind==='skill')return '스킬 미지원 · 항목 단위 제어 불가';
 return null;
}
const invokedText=(invoked:ToolInvoked)=>`native ${invoked.native} · mock ${invoked.mock} · unknown ${invoked.unknown}`;
/** Four states stay separate; mock/unknown invocations are never counted as verification. */
export function ToolStatePanel({tools,mode}:{tools?:ToolAggregate;mode?:UiMode}){
 const current=useUiMode(),shown=mode??current;
 if(!tools||!Array.isArray(tools.states)||!tools.totals)return <p>도구 상태 정보 없음</p>;
 const groups=new Map<string,{runtimeId:string;kind:ToolKind;states:ToolState[]}>();
 for(const state of tools.states){const id=state.key.runtimeId+'/'+state.key.kind;const group=groups.get(id)??{runtimeId:state.key.runtimeId,kind:state.key.kind,states:[]};group.states.push(state);groups.set(id,group);}
 const totals=tools.totals;
 return <section aria-label="도구 상태"><h4>도구 상태 (설치·허용·호출·검증은 각각 별개)</h4>
  <p>설치: 발견됨 {totals.installed}건 · 허용: 현재 작업 grant {totals.permitted}건 · 호출: {invokedText(totals.invoked)} · 검증: native {totals.verified}건</p>
  <p>mock/unknown 호출은 검증이 아닙니다. 설치·허용·호출만으로 검증을 표시하지 않습니다.</p>
  {[...groups.values()].map(group=>{const reason=policyReason(group.runtimeId,group.kind);
   return <div key={group.runtimeId+group.kind}><p><b>{group.runtimeId} · {kindLabel[group.kind]}</b>{reason&&<> · 정책: {reason}</>}</p>
    {shown==='advanced'&&<table><caption>{group.runtimeId} {kindLabel[group.kind]} 항목별 상태</caption><thead><tr><th>항목</th><th>설치</th><th>허용</th><th>호출</th><th>검증</th></tr></thead>
     <tbody>{group.states.map(state=><tr key={state.key.itemId}><th scope="row">{state.key.itemId.slice(0,12)}</th><td>{installedLabel[state.installed]}</td><td>{state.permitted?'현재 작업 grant 있음':'없음'}</td><td>{invokedText(state.invoked)}</td><td>native {state.verified}건</td></tr>)}</tbody></table>}
   </div>;})}
 </section>;
}
const support:Record<CapabilitySupport,string>={implemented:'구현됨',unsupported:'미지원',unknown:'unknown'};
export function CapabilityMatrixDetails({registry}:{registry:OrchestrationRegistry}){
 return <><p>구현 지원과 실제 성공은 다릅니다. 과거 실행 증거는 현재 실행의 성공이나 권한을 보장하지 않습니다.</p>
 {registry.providers.map(provider=><section key={provider.runtimeId}><h4>{provider.runtimeId} · {provider.version??'버전 unknown'}</h4>
  <table><caption>기능 유형별 지원</caption><thead><tr><th>기능</th><th>발견</th><th>호출</th><th>검증</th><th>권한 정책</th><th>과거 완료 실행 증거</th></tr></thead>
   <tbody>{provider.capabilities.map(capability=><tr key={capability.id}><th scope="row">{capability.id}</th><td>{support[capability.discovery]}</td><td>{support[capability.invocation]}</td><td>{support[capability.verification]}</td><td>{capability.policy==='allowed'?'정책 범위 내 · 실행 승인 별도':'차단'}</td><td>{capability.validation?<>native {capability.validation.nativeRuns} · mock {capability.validation.mockRuns} · unknown {capability.validation.unknownRuns}{capability.validation.lastRunId&&<details><summary>마지막 근거 실행</summary>{capability.validation.lastRunId}</details>}</>:'기록 없음'}</td></tr>)}</tbody>
  </table>
 </section>)}<ToolStatePanel tools={registry.tools}/><p>실제 모델: unknown · 등록 정보 조회는 실행 승인이 아닙니다.</p></>;
}
export function CapabilityMatrix({online,status}:{online:boolean;status?:ProviderStatus}){
 const [registry,setRegistry]=useState<OrchestrationRegistry|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{
  let active=true;setError('');
  if(online)void fetch('/api/capability-orchestration',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error();const value=await response.json();if(!Array.isArray(value?.providers)||value.actualModel!=='unknown')throw Error();if(active)setRegistry(value);}).catch(()=>{if(active)setError('기능별 지원 정보를 불러오지 못했습니다.');});
  return()=>{active=false;};
 },[online,status,revision]);
 return <section aria-label="기능 호출 지원 표"><h3>기능 호출 지원 표</h3><button disabled={!online} onClick={()=>setRevision(value=>value+1)}>저장된 지원 정보 새로고침</button>
  {!online&&<p>서버 연결 끊김 · 마지막으로 받은 지원 정보입니다.</p>}
  {registry?<CapabilityMatrixDetails registry={registry}/>:<p>지원 정보: unknown</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
