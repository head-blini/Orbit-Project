import {useEffect,useRef,useState} from 'react';
import type {SoloOperationView} from '../shared/solo-operation.ts';
import {executionLabels} from './navigation.ts';

export function SoloOperationDetails({runId}:{runId:string}){
  const [view,setView]=useState<SoloOperationView|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[runId]);
  async function load(){
    const ticket=++epoch.current;setLoading(true);setError('');
    try{
      const response=await fetch('/api/runs/'+encodeURIComponent(runId)+'/operation');if(!response.ok)throw new Error();
      const value=await response.json() as SoloOperationView;if(value.runId!==runId)throw new Error();
      if(ticket===epoch.current)setView(value);
    }catch{if(ticket===epoch.current)setError('실행 식별 기록을 불러오지 못했습니다.');}
    finally{if(ticket===epoch.current)setLoading(false);}
  }
  return <details className="operation-details" onToggle={event=>{if(event.currentTarget.open&&!view&&!loading)void load();}}>
    <summary>실행 출처와 상태 변경 이력</summary>
    <p className="subtle">실행 출처를 확인하는 기록입니다. 프로세스 종료나 복구 해제를 증명하지 않습니다.</p>
    {loading&&<p role="status">기록을 불러오는 중…</p>}{error&&<p role="alert">{error}</p>}
    {view?.identity==='legacy_unknown'&&<p>소유 식별 정보가 저장되기 전의 실행입니다. 이전 관리자·세션을 추정하지 않습니다.</p>}
    {view?.record&&<>
      <dl className="policy-list"><div><dt>실행기</dt><dd>{view.record.runtimeId}</dd></div><div><dt>관리자 식별자</dt><dd><code>{view.record.ownerIncarnation}</code></dd></div>
        <div><dt>연결 세대</dt><dd>{view.record.generation}</dd></div><div><dt>네이티브 세션</dt><dd><code>{view.record.nativeSessionId}</code></dd></div>
        <div><dt>네이티브 실행</dt><dd><code>{view.record.nativeTurnId??'응답 미확인'}</code></dd></div></dl>
      <ol>{view.history.map(item=><li key={item.revision}>개정 {item.revision} · {executionLabels[item.execution]} · {new Date(item.updatedAt).toLocaleString('ko-KR')}</li>)}</ol>
    </>}
    <button type="button" disabled={loading} onClick={()=>void load()}>실행 이력 새로고침</button>
  </details>;
}
