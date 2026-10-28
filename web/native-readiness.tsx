import {useEffect,useRef,useState} from 'react';
import type {NativeReadinessReport,ClaudeAuthentication} from '../shared/native-readiness.ts';
import type {ProviderStatus} from '../shared/types.ts';
import type {NativeProbe} from '../shared/capabilities.ts';
import {providerLabels} from './navigation.ts';
const installationLabels:Record<NativeProbe['status'],string>={found:'설치 버전 확인',not_found_on_path:'현재 PATH에서 발견 못함',failed:'확인 실패',unknown:'unknown'};
const authenticationLabels:Record<ClaudeAuthentication,string>={subscription:'구독 인증 확인',not_authenticated:'로그인 필요',unsupported:'지원 인증 방식 아님',unknown:'unknown',not_installed:'실행기 없음'};
export function NativeReadinessDetails({report}:{report:NativeReadinessReport}){
 const installation=(probe:NativeProbe)=>`${installationLabels[probe.status]??'unknown'} · 버전 ${probe.version??'unknown'}`;
 return <>
  <p>Codex 설치: {installation(report.codex.installation)} · 인증: {report.codex.authentication==='confirmed'?'현재 연결 세션 확인':'unknown'} · 연결: {providerLabels[report.codex.connection]??'unknown'}</p>
  <p>Claude Code 설치: {installation(report.claude.installation)} · 인증: {authenticationLabels[report.claude.authentication?.authentication??'unknown']??'unknown'}</p>
  <p>Claude 인증 확인 시각: {report.claude.authentication?.checkedAt??'미확인'}</p>
  <p>실제 실행 모델: unknown · 실 Provider 검증: 별도 실행 승인 필요</p>
  <p>실제 비용 (USD): unknown · 잔여 사용량: unknown</p>
 </>;
}
export function NativeReadinessPanel({online,status,post}:{online:boolean;status?:ProviderStatus;post:(path:string,body:object)=>Promise<unknown>}){
 const [report,setReport]=useState<NativeReadinessReport|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),pending=useRef(false);
 function accept(value:unknown,ticket:number){
  const report=value as NativeReadinessReport;
  if(!report?.codex?.installation||!report?.claude?.installation||report.actualModel!=='unknown'||report.liveValidation!=='approval_required')throw Error();
  if(generation.current===ticket)setReport(report);
 }
 useEffect(()=>{
  const ticket=++generation.current;setError('');setBusy(false);
  if(online)void fetch('/api/capability-orchestration/readiness',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error();accept(await response.json(),ticket);}).catch(()=>{if(ticket===generation.current)setError('저장된 준비 상태를 불러오지 못했습니다.');});
  return()=>{generation.current++;};
 },[online,status]);
 async function refresh(){
  if(!online||pending.current)return;
  pending.current=true;setBusy(true);setError('');const ticket=++generation.current;
  try{accept(await post('/api/capability-orchestration/readiness/refresh',{}),ticket);}
  catch{if(ticket===generation.current)setError('준비 상태를 확인하지 못했습니다. 마지막으로 받은 기록을 표시합니다.');}
  finally{pending.current=false;if(ticket===generation.current)setBusy(false);}
 }
 return <section aria-label="실행기 준비 상태">
  <h3>실행기 준비 상태</h3>
  <p>저장된 설치·인증·연결 상태입니다. 설치와 로그인 확인만으로 실제 실행 성공을 판정하지 않습니다.</p>
  <button disabled={!online||busy} onClick={()=>void refresh()}>{busy?'준비 상태 확인 중':'설치·인증 상태 확인'}</button>
  <p>확인 버튼은 로컬 CLI 진단만 수행합니다. 모델 작업을 실행하거나 로그인 정보를 표시하지 않습니다.</p>
  {!online&&<p role="status">서버 연결 끊김 · 표시된 기록이 오래되었을 수 있습니다.</p>}
  {report?<NativeReadinessDetails report={report}/>:<p>저장된 준비 상태: unknown</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
