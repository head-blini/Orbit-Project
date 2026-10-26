import {useEffect,useState} from 'react';
import type {ControlPlaneStatus} from '../shared/control-plane.ts';
export function PolicyReport({report}:{report:ControlPlaneStatus}) {
  const owners={orbit:'Orbit 직접 통제',runtime:'네이티브 런타임 의존',unverified:'미검증'};
  const states={enforced:'명시된 범위에서 강제',attested:'설정 응답 확인',unknown:'확인되지 않음'};
  return <section className="surface" aria-label="제어 계층 정책 범위"><h2>제어 계층과 실행 수준</h2>
    <p>Goal Tracking: 목표 추적 · Assisted Execution: 통합 검증 전 · Autonomous Execution: 비활성</p>
    <dl className="policy-list">{report.policies.map(policy=><div key={policy.id}><dt>{policy.label}</dt><dd><b>{owners[policy.owner]} · {states[policy.status]}</b><p>{policy.scope}</p></dd></div>)}</dl>
    {report.limitations.map(text=><p className="subtle" key={text}>{text}</p>)}
  </section>;
}
export function ControlPlanePanel({refreshKey}:{refreshKey:string}) {
  const [report,setReport]=useState<ControlPlaneStatus|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{let disposed=false;setReport(null);setFailed(false);
    void fetch('/api/control-plane').then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<ControlPlaneStatus>;})
      .then(value=>{if(!disposed)setReport(value);}).catch(()=>{if(!disposed)setFailed(true);});return()=>{disposed=true;};
  },[refreshKey,retry]);
  return report?<PolicyReport report={report}/>:<section className="surface"><h2>제어 계층 정책</h2>{failed?<p role="alert">정책 상태를 확인하지 못했습니다. <button onClick={()=>setRetry(v=>v+1)}>다시 조회</button></p>:<p role="status">정책 상태 조회 중…</p>}</section>;
}
