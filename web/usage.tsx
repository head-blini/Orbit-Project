import { useEffect,useRef,useState } from 'react';
import type { CodexUsage } from '../shared/usage.ts';
import type { Snapshot } from '../shared/types.ts';
const number=(value:number|null)=>value===null?'unknown':value.toLocaleString('ko-KR');
export function UsagePanel({state,online,post}:{state:Snapshot|null;online:boolean;post:(path:string,body:object)=>Promise<unknown>}){
  const [usage,setUsage]=useState<CodexUsage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),pending=useRef(false);
  useEffect(()=>{const ticket=++generation.current;setUsage(null);setError('');
    if(online)void fetch('/api/usage').then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<CodexUsage>;}).then(value=>{if(ticket===generation.current)setUsage(value);}).catch(()=>{if(ticket===generation.current)setError('사용량 상태를 불러오지 못했습니다.');});
    return()=>{++generation.current;};
  },[online,state?.provider,state?.selectedWorkspaceId]);
  async function refresh(){
    if(pending.current||!online||state?.provider!=='ready')return;
    // Manual refresh supersedes an in-flight initial GET for this same session.
    pending.current=true;setBusy(true);setError('');const ticket=++generation.current;
    try{const value=await post('/api/usage/refresh',{}) as CodexUsage;if(ticket===generation.current)setUsage(value);}
    catch{if(ticket===generation.current)setError('현재 연결에서 사용량을 확인하지 못했습니다.');}
    finally{pending.current=false;setBusy(false);}
  }
  return <section className="surface usage-panel">
    <div className="section-heading"><div><h2>Codex 계정 사용량</h2><p>계정 전체의 공식 조회값입니다. 현재 프로젝트만의 사용량이 아닙니다.</p></div><button disabled={!online||busy||state?.provider!=='ready'} onClick={refresh}>{busy?'조회 중…':'공식 사용량 조회'}</button></div>
    <p className="subtle">기존 Codex 연결에서 읽기 전용 API만 사용합니다. 조회 결과는 60초간 재사용합니다. 잔여량 초기화·크레딧 구매·API 과금 전환은 수행하지 않습니다.</p>
    {error&&<p role="alert">{error}</p>}
    {!usage?<p>사용량 상태 확인 중…</p>:<>
      <p>출처: {usage.source==='codex_app_server'?'Codex App Server':'아직 조회하지 않음'} · 갱신 {usage.checkedAt?new Date(usage.checkedAt).toLocaleString('ko-KR'):'unknown'} · {usage.status==='available'?'공식 응답 확인':usage.status==='partial'?'일부 항목만 확인':'unknown'}</p>
      <p>구독: {usage.billing==='chatgpt_subscription'?'현재 ChatGPT 로그인 연결':'unknown'} · API 비용: unknown</p>
      {!usage.buckets?.length?<p>사용량 한도와 초기화 시각: unknown. 연결 후 조회해도 공급자가 반환하지 않는 값은 추정하지 않습니다.</p>:<ul className="capability-list">{usage.buckets.map(bucket=><li key={bucket.id}><b>{bucket.id}</b>{(['primary','secondary'] as const).map(kind=><div key={kind}><p>{kind==='primary'?'주 한도':'추가 한도'}: {bucket[kind]?<>사용 {number(bucket[kind]!.usedPercent)}% · 잔여 {number(bucket[kind]!.remainingPercent)}%</>:'unknown'}</p>{bucket[kind]&&<p>기간 {number(bucket[kind]!.windowDurationMins)}분 · 초기화 {bucket[kind]!.resetsAt?new Date(bucket[kind]!.resetsAt!).toLocaleString('ko-KR'):'unknown'}</p>}</div>)}</li>)}</ul>}
      <dl className="policy-list"><div><dt>계정 누적 토큰</dt><dd>{number(usage.summary?.lifetimeTokens??null)}</dd></div><div><dt>최대 일일 토큰</dt><dd>{number(usage.summary?.peakDailyTokens??null)}</dd></div><div><dt>최장 실행</dt><dd>{usage.summary?.longestRunningTurnSec===null||usage.summary?.longestRunningTurnSec===undefined?'unknown':number(usage.summary.longestRunningTurnSec)+'초'}</dd></div></dl>
      {usage.daily&&<details><summary>공식 일별 토큰 기록 ({usage.daily.length})</summary><ul>{usage.daily.map(day=><li key={day.date}>{day.date} · {number(day.tokens)} tokens</li>)}</ul></details>}
      <p className="subtle">Codex 작업별 토큰·실제 청구·제공자 간 집계는 아직 미연결입니다. HTTP 요청별 공급자 토큰 응답은 Model Hub에서 확인하며 quota나 토큰 수치로 API 비용을 계산하지 않습니다.</p>
    </>}
  </section>;
}
