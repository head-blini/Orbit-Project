import {useEffect,useState} from 'react';
import type {TaskGraphNodeState,TaskGraphRevision,TaskGraphState} from '../shared/task-graph.ts';
import {useUiMode} from './ui-mode.ts';
import type {UiMode} from './ui-mode.ts';

/** Mirrors Controller.workerIntegrationQueue (server/controller.ts); only the fields shown here. */
export interface QueueItemView {id:string;status:'queued'|'building'|'verifying'|'applying'|'applied'|'refused'|'blocked';reason:string|null;attempts?:number;targetBranch?:string|null}
export interface QueueRefusalView {reservationId:string;reason:string;status:'refused';released:boolean}
export interface IntegrationQueueView {enabled:boolean;reason:string|null;refusals:QueueRefusalView[];items:QueueItemView[]}

export const nodeStateNames:Record<TaskGraphNodeState['state'],string>={ready:'준비됨',waiting:'대기 중',blocked:'막힘',stale:'기준 변경(오래됨)',done:'완료(검증됨)'};
export const queueStatusNames:Record<QueueItemView['status'],string>={queued:'대기열',building:'후보 생성 중',verifying:'검증 중',applying:'적용 중',applied:'적용됨',refused:'거부됨',blocked:'막힘'};
const order=['ready','waiting','blocked','stale','done'] as const;

export interface GraphSummary {counts:Record<TaskGraphNodeState['state'],number>;total:number;stale:boolean;mainReason:string|null}
/** Counts come only from server-reported states; 'done' is never inferred. */
export function summarizeGraphState(state:TaskGraphState):GraphSummary{
  const counts={ready:0,waiting:0,blocked:0,stale:0,done:0},reasons=new Map<string,number>();
  for(const node of state.nodes){counts[node.state]++;
    if(node.state==='blocked'||node.state==='stale')for(const code of node.reasonCodes)reasons.set(code,(reasons.get(code)??0)+1);}
  const main=[...reasons].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];
  return {counts,total:state.nodes.length,stale:state.stale,mainReason:main?main[0]:null};
}
/** One-line description of a node; waiting lists its predecessors, blocked/stale list reason codes. */
export function nodeDetail(node:TaskGraphNodeState):string{
  if(node.state==='waiting')return '선행 작업: '+(node.predecessors.join(', ')||'없음');
  if(node.state==='blocked'||node.state==='stale')return '사유 코드: '+node.reasonCodes.join(', ');
  return '';
}
export function queueRowLabel(item:QueueItemView):string{
  return queueStatusNames[item.status]+(item.reason?' · 사유 '+item.reason:'');
}
export const refusalLabel=(r:QueueRefusalView)=>'거부됨 · 사유 '+r.reason+(r.released?' · 예약 해제됨':'');

export function TaskGraphView({graph,state,queue,mode}:{graph:Pick<TaskGraphRevision,'revision'|'contentHash'>|null;state:TaskGraphState|null;queue:IntegrationQueueView|null;mode:UiMode}){
  const summary=state?summarizeGraphState(state):null,adv=mode==='advanced';
  return <div>
    <h3>작업 그래프</h3>
    {!state||!summary?<p>불러오는 중…</p>:<>
      <p>{graph?`그래프 r${graph.revision}`:'그래프'} · {summary.stale?'기준이 바뀌어 오래된 그래프입니다. 모든 작업은 오래됨으로 표시됩니다.':'현재 기준과 일치'}{adv&&graph?` · 해시 ${graph.contentHash.slice(0,12)}`:''}</p>
      <p>{order.map(k=>`${nodeStateNames[k]} ${summary.counts[k]}`).join(' · ')}</p>
      {summary.mainReason&&<p>주요 막힘 사유: {summary.mainReason}</p>}
      {adv&&<table className="progress-runs"><thead><tr><th>작업</th><th>상태</th><th>상세</th></tr></thead>
        <tbody>{state.nodes.map(n=><tr key={n.taskId}><td>{n.taskId}</td><td>{nodeStateNames[n.state]}</td><td>{nodeDetail(n)}</td></tr>)}</tbody></table>}
    </>}
    <h3>통합 대기열</h3>
    {!queue?<p>불러오는 중…</p>:<>
      {!queue.enabled&&<p>통합이 꺼져 있습니다{queue.reason?' · 사유 '+queue.reason:''}</p>}
      {!queue.items.length&&!queue.refusals.length?<p>대기열이 비어 있습니다.</p>:<ul>
        {queue.items.map(i=><li key={i.id}>{queueRowLabel(i)}{adv?` · ${i.id.slice(0,8)}`:''}</li>)}
        {queue.refusals.map(r=><li key={r.reservationId}>{refusalLabel(r)}{adv?` · ${r.reservationId.slice(0,8)}`:''}</li>)}</ul>}
    </>}
  </div>;
}

/** Read-only: GET only, no actions. */
export function TaskGraphPanel({projectId,planningVersionId,online}:{projectId:string;planningVersionId:string;online:boolean}){
  const mode=useUiMode(),[graph,setGraph]=useState<TaskGraphRevision|null>(null),[state,setState]=useState<TaskGraphState|null>(null),[queue,setQueue]=useState<IntegrationQueueView|null>(null),[error,setError]=useState('');
  useEffect(()=>{let live=true;if(!online)return;
    const get=<T,>(path:string)=>fetch(path,{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<T>:Promise.reject(new Error(String(r.status))));
    const base='/api/projects/'+encodeURIComponent(projectId)+'/task-graphs/'+encodeURIComponent(planningVersionId);
    setError('');
    get<TaskGraphRevision>(base).then(v=>{if(live)setGraph(v);}).catch(()=>{});
    get<TaskGraphState>(base+'/state').then(v=>{if(live&&Array.isArray(v?.nodes))setState(v);}).catch(()=>{if(live)setError('작업 그래프를 불러오지 못했습니다.');});
    get<IntegrationQueueView>('/api/projects/'+encodeURIComponent(projectId)+'/integration-queue').then(v=>{if(live&&Array.isArray(v?.items))setQueue(v);}).catch(()=>{if(live)setError('통합 대기열을 불러오지 못했습니다.');});
    return()=>{live=false;};},[online,projectId,planningVersionId]);
  return <section className="surface" aria-labelledby="task-graph-title">
    <h2 id="task-graph-title">작업 그래프·통합 대기열</h2>
    <p className="work-muted">읽기 전용입니다. 이 화면에서는 실행·제출·승인·적용·재시도를 하지 않으며, 완료는 서버가 검증됨으로 보고한 경우에만 표시합니다.</p>
    {error&&<p role="alert">{error}</p>}
    {!online?<p>오프라인입니다.</p>:<TaskGraphView graph={graph} state={state} queue={queue} mode={mode}/>}
  </section>;
}
