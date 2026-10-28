import {NativeReadinessPanel} from './native-readiness.tsx';
import { useEffect,useRef,useState } from 'react';
import type { CapabilityRegistry,Capability,NativeProbe } from '../shared/capabilities.ts';
import type { ProviderStatus } from '../shared/types.ts';
import { providerLabels } from './navigation.ts';

const effective:Record<Capability['effective'],string>={available:'연결됨',connection_required:'Codex 연결 필요',blocked_policy:'현재 정책에서 비활성',not_connected:'Orbit 미연결'};
const documented:Record<Capability['documented'],string>={supported:'공식 지원',conditional:'조건부 지원',unknown:'확인 안 됨'};
const probeLabels:Record<NativeProbe['status'],string>={unknown:'미확인',found:'버전 확인',not_found_on_path:'현재 PATH에서 발견 못함',failed:'진단 실패'};
const extensions=new Set(['skills','mcp','hooks','plugins','subagents','teams']);
type Props={online:boolean;status?:ProviderStatus;post:(path:string,body:object)=>Promise<unknown>;extensionsOnly?:boolean};
export function CapabilityPanel({online,status,post,extensionsOnly=false}:Props){
  const [registry,setRegistry]=useState<CapabilityRegistry|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  const generation=useRef(0),probing=useRef(false);
  useEffect(()=>{
    const ticket=++generation.current;setRegistry(null);setError('');
    if(online)void fetch('/api/capabilities').then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<CapabilityRegistry>;})
      .then(value=>{if(ticket===generation.current)setRegistry(value);}).catch(()=>{if(ticket===generation.current)setError('기능 정보를 불러오지 못했습니다.');});
    return()=>{++generation.current;};
  },[online,status,retry]);
  async function probe(){
    if(!online||probing.current)return;
    probing.current=true;setBusy(true);setError('');const ticket=++generation.current;
    try{const value=await post('/api/capabilities/probe',{}) as CapabilityRegistry;if(ticket===generation.current)setRegistry(value);}
    catch{if(ticket===generation.current)setError('로컬 버전 진단을 완료하지 못했습니다.');}
    finally{probing.current=false;setBusy(false);}
  }
  return <section className="surface capability-panel" aria-label="Capability Registry">
    <div className="section-heading"><div><h2>{extensionsOnly?'공식 확장 기능 지원':'Capability Registry'}</h2><p>공식 기능과 현재 Orbit 연결·권한을 구분합니다.</p></div><button onClick={probe} disabled={!online||busy}>{busy?'진단 중…':'로컬 CLI 버전 확인'}</button></div>
    {!extensionsOnly&&<NativeReadinessPanel online={online} status={status} post={post}/>}
    <p className="subtle">버전 진단은 로컬 실행 파일의 버전만 확인합니다. 인증·구독 잔여량 확인과 모델 실행은 포함하지 않습니다. 결과는 60초간 재사용합니다.</p>
    {error&&<p role="alert">{error} <button onClick={()=>setRetry(value=>value+1)}>다시 불러오기</button></p>}
    {!registry?<p role="status">{online?'기능 정보를 불러오는 중…':'서버 연결 후 기능 정보를 확인할 수 있습니다.'}</p>:<CapabilityDetails registry={registry} extensionsOnly={extensionsOnly}/>}
  </section>;
}
export function CapabilityDetails({registry,extensionsOnly=false}:{registry:CapabilityRegistry;extensionsOnly?:boolean}){
  return <>
    <p className="subtle">공식 문서 확인 {registry.documentedAt} · 로컬 진단 {registry.probedAt?new Date(registry.probedAt).toLocaleString('ko-KR'):'미실행'}</p>
    {registry.providers.map(provider=><details key={provider.id} open={provider.id==='codex'} className="capability-provider">
      <summary><b>{provider.name}</b> · {provider.connection==='not_connected'?'Orbit 어댑터 미연결':providerLabels[provider.connection]}</summary>
      <p>로컬 CLI: {probeLabels[provider.nativeProbe.status]}{provider.nativeProbe.version?' · '+provider.nativeProbe.version:''} · 인증: {provider.authStatus==='connected'?'현재 세션 확인':provider.authStatus==='required'?'로그인 필요':'unknown'}</p>
      <p className="subtle">{provider.authPolicy}</p><p className="subtle">비용·잔여량·초기화 시각: unknown. {provider.billing.note}</p>
      <ul className="capability-list">{provider.capabilities.filter(capability=>!extensionsOnly||extensions.has(capability.id)).map(capability=><li key={capability.id}>
        <div><b>{capability.label}</b><span className="badge">{effective[capability.effective]}</span></div>
        <p>{documented[capability.documented]} · 현재 런타임 {capability.runtime==='confirmed'?'연결 확인':'미확인'} · {capability.verification==='contract_tests'?'계약 테스트 있음 / 실서비스 보증 아님':'제품 검증 미실행'}</p>
        <p>{capability.note}</p><details><summary>공식 인터페이스·근거</summary><p><code>{capability.interfaces.join(' · ')}</code></p>{capability.sources.map((source,index)=><a key={source} href={source} target="_blank" rel="noreferrer">공식 문서 {index+1} </a>)}</details>
      </li>)}</ul>
    </details>)}
    <ul className="subtle">{registry.boundaries.map(boundary=><li key={boundary}>{boundary}</li>)}</ul>
  </>;
}
