import {useState} from 'react';
import type {ClaudeRunRecovery} from '../shared/project-progress.ts';

const kst=(value:string)=>new Date(value).toLocaleString('ko-KR',{hour12:false,timeZone:'Asia/Seoul'})+' (KST)';
const reasons:Record<string,string>={SERVER_RESTART:'Orbit 서버가 다시 시작되어 실행을 놓쳤습니다.',EXIT_NOT_OBSERVED:'Claude 프로세스의 종료를 확인하지 못했습니다.',
  RESULT_NOT_OBSERVED:'Claude 프로세스는 끝났지만 결과를 확인하지 못했습니다.'};

/** Quota wait guidance: the reset time is shown only when observed, and work never resumes on its own. */
export function QuotaResumeNote({resetsAt}:{resetsAt:string|null|undefined}){
  if(resetsAt===undefined)return null;
  return <p className="progress-next" role="status">예상 초기화 시각: {resetsAt?kst(resetsAt):'알 수 없음'}. 초기화된 뒤 직접 다시 시작하세요. 자동으로 재개하지 않습니다.</p>;
}

/** Explicit recovery of a lost Claude run. Releasing only lifts the block; the run stays unconfirmed and is never retried. */
export function ClaudeRecoveryControl({recovery,advanced,busy,onRecover}:{recovery:ClaudeRunRecovery;advanced:boolean;busy:boolean;onRecover?:(runId:string)=>void}){
  const [confirmed,setConfirmed]=useState(false);
  const detail=advanced?` (실행 ${recovery.runId.slice(0,8)} · ${recovery.lostReason??'사유 기록 없음'})`:'';
  if(recovery.state==='released')return <section aria-label="실행 복구" className="progress-quality">
    <p role="status">차단 해제됨 · {recovery.basis==='exit_observed'?'종료 관측':'사용자가 종료 확인'}{recovery.releasedAt?` · ${kst(recovery.releasedAt)}`:''}{detail}. 이 실행의 결과는 여전히 미확인입니다. 새 실행은 직접 시작하세요.</p>
  </section>;
  return <section aria-label="실행 복구" className="progress-quality">
    <p role="alert">{reasons[recovery.lostReason??'']??'실행 종료를 확인하지 못했습니다.'}{detail} 이 작업의 새 실행은 차단되어 있습니다.</p>
    <p>{recovery.exitObserved?'종료는 관측되었습니다.':'Orbit은 Claude 프로세스가 멈췄는지 확인할 수 없습니다. 직접 확인한 경우에만 해제하세요.'} 해제해도 성공으로 처리하거나 자동으로 다시 실행하지 않습니다.</p>
    {onRecover&&<div className="progress-actions">
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> Claude 작업이 더 이상 실행 중이 아님을 확인했습니다</label>
      <button disabled={busy||!confirmed} onClick={()=>onRecover(recovery.runId)}>종료 확인하고 차단 해제</button>
    </div>}
  </section>;
}
