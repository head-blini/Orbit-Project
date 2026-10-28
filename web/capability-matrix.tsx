import {useEffect,useState} from 'react';
import type {OrchestrationRegistry,CapabilitySupport} from '../shared/capability-orchestration.ts';
import type {ProviderStatus} from '../shared/types.ts';
const support:Record<CapabilitySupport,string>={implemented:'구현됨',unsupported:'미지원',unknown:'unknown'};
export function CapabilityMatrixDetails({registry}:{registry:OrchestrationRegistry}){
 return <><p>구현 지원과 실제 성공은 다릅니다. 과거 실행 증거는 현재 실행의 성공이나 권한을 보장하지 않습니다.</p>
 {registry.providers.map(provider=><section key={provider.runtimeId}><h4>{provider.runtimeId} · {provider.version??'버전 unknown'}</h4>
  <table><caption>기능 유형별 지원</caption><thead><tr><th>기능</th><th>발견</th><th>호출</th><th>검증</th><th>권한 정책</th><th>과거 완료 실행 증거</th></tr></thead>
   <tbody>{provider.capabilities.map(capability=><tr key={capability.id}><th scope="row">{capability.id}</th><td>{support[capability.discovery]}</td><td>{support[capability.invocation]}</td><td>{support[capability.verification]}</td><td>{capability.policy==='allowed'?'정책 범위 내 · 실행 승인 별도':'차단'}</td><td>{capability.validation?<>native {capability.validation.nativeRuns} · mock {capability.validation.mockRuns} · unknown {capability.validation.unknownRuns}{capability.validation.lastRunId&&<details><summary>마지막 근거 실행</summary>{capability.validation.lastRunId}</details>}</>:'기록 없음'}</td></tr>)}</tbody>
  </table>
 </section>)}<p>실제 모델: unknown · 등록 정보 조회는 실행 승인이 아닙니다.</p></>;
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
