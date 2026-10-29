import type {ProjectProgress} from '../shared/project-progress.ts';
import {taskImpact} from './project-work-model.ts';

const reverifyLabel={needed:'다시 확인 필요',running:'다시 확인 중'} as const;

/** A03 stale-baseline and A11 impact view. Read-only; derived from server-reported freshness only. */
export function ProgressImpact({progress,advanced}:{progress:ProjectProgress;advanced:boolean}){
  const planId=progress.plan?.id??null,items=progress.tasks.map(t=>taskImpact(t,planId)).filter(i=>!!i);
  if(!items.length)return null;
  const live=items.filter(i=>i.inProgress);
  return <section className="surface progress-impact" aria-label="기준 변경 영향">
    <div className="section-heading"><div><h2>기준 변경 영향</h2><p>작업 {progress.tasks.length}개 중 {items.length}개가 다시 확인 대상입니다. 이 작업들은 완료로 세지 않습니다.</p></div></div>
    {live.length>0&&<p role="alert">진행 중인 작업 {live.length}개가 이전 기준 또는 오래된 근거 위에 있습니다: {live.map(i=>i.title).join(', ')}. 이 실행이 끝나도 통과로 인정되지 않습니다.</p>}
    <p className="progress-next">다음 할 일: 기획 화면에서 현재 승인본을 확인한 뒤, 아래 작업을 현재 기준으로 다시 실행·검증하세요. 진행 중인 작업은 끝난 뒤 확인하세요.</p>
    <ul>{items.map(i=><li key={i.taskId}><strong>{i.title}</strong> · {i.onOldBaseline?'이전 기준':'기준 근거 오래됨'} · {reverifyLabel[i.reverify]}
      {advanced&&<> · {i.reasons.join(' / ')}{i.oldRunIds.length>0&&` · 이전 기획 버전 실행 ${i.oldRunIds.map(id=>id.slice(0,8)).join(', ')}`}</>}</li>)}</ul>
    {advanced&&<p className="work-muted">변경 원인(어떤 수정·요구사항 변경인지)과 이전 기획 버전 번호는 현재 진행 기록에 없어 표시하지 않습니다.</p>}
  </section>;
}
