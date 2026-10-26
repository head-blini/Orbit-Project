import {useEffect,useState,useSyncExternalStore} from 'react';
import type {AnalyticsKind,AnalyticsRecord,AnalyticsTotals,CheckCounts,ProjectAnalytics} from '../shared/analytics.ts';
import './project-analytics.css';

interface AnalyticsScope {projectId:string|null;online:boolean}
export interface ProjectAnalyticsState extends AnalyticsScope {
  data:ProjectAnalytics|null;
  loading:'initial'|'refresh'|'page'|null;
  error:string;
}
type AnalyticsFetch=(path:string,options:RequestInit)=>Promise<Response>;
const emptyState=(scope:AnalyticsScope):ProjectAnalyticsState=>({...scope,data:null,loading:null,error:''});
const recordKey=(row:AnalyticsRecord)=>JSON.stringify([row.kind,row.id]);
function uniqueRecords(rows:AnalyticsRecord[]){
  const seen=new Set<string>();
  return rows.filter(row=>{const key=recordKey(row);if(seen.has(key))return false;seen.add(key);return true;});
}

/** Owns the same request lifetime used by the mounted panel. Reads never retry themselves. */
export function createProjectAnalyticsCoordinator(get:AnalyticsFetch=(path,options)=>fetch(path,options)){
  let state=emptyState({projectId:null,online:false}),generation=0,active=true;
  let visitedCursors=new Set<string>();
  const listeners=new Set<()=>void>();
  function update(next:ProjectAnalyticsState){state=next;for(const listener of listeners)listener();}
  async function read(mode:NonNullable<ProjectAnalyticsState['loading']>){
    if(!active||!state.projectId||!state.online)return;
    if(mode==='refresh'?state.loading==='refresh':state.loading!==null)return;
    const cursor=mode==='page'?state.data?.nextCursor:null;
    if(mode==='page'&&(cursor==null||visitedCursors.has(cursor)))return;
    const projectId=state.projectId,ticket=++generation;
    const current=()=>active&&generation===ticket&&state.projectId===projectId&&state.online;
    update({...state,loading:mode,error:''});
    try{
      const path='/api/projects/'+encodeURIComponent(projectId)+'/analytics?limit=25'+(cursor!=null?'&cursor='+encodeURIComponent(cursor):'');
      const response=await get(path,{method:'GET',cache:'no-store'});
      if(!response.ok)throw new Error('Analytics request failed');
      const value=await response.json() as ProjectAnalytics;
      if(!current())return;
      if(!value||value.projectId!==projectId||value.source!=='local_records'||!Array.isArray(value.records)||!Array.isArray(value.groups)||!value.totals||(value.nextCursor!==null&&typeof value.nextCursor!=='string'))throw new Error('Unexpected analytics scope');
      if(mode==='page'&&cursor!=null)visitedCursors.add(cursor);else visitedCursors=new Set();
      const repeated=value.nextCursor!==null&&visitedCursors.has(value.nextCursor);
      const data=mode==='page'&&state.data
        ?{...state.data,records:uniqueRecords([...state.data.records,...value.records]),nextCursor:repeated?null:value.nextCursor}
        :{...value,records:uniqueRecords(value.records)};
      update({...state,data,error:repeated?'기록 페이지가 반복되어 더 불러오기를 멈췄습니다. 새로고침해 다시 확인하세요.':''});
    }catch{
      if(current())update({...state,error:'프로젝트 활동을 불러오지 못했습니다. 서버 연결을 확인한 뒤 새로고침하거나 다음 기록을 다시 불러오세요.'});
    }finally{
      // A superseded request must not clear a newer request's lock.
      if(current())update({...state,loading:null});
    }
  }
  return {
    getSnapshot:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async setScope(scope:AnalyticsScope){
      if(active&&scope.projectId===state.projectId&&scope.online===state.online)return;
      generation++;active=true;visitedCursors=new Set();update(emptyState(scope));
      if(scope.projectId&&scope.online)await read('initial');
    },
    refresh:()=>read('refresh'),
    nextPage:()=>read('page'),
    dispose(){generation++;active=false;},
  };
}

const kinds:Record<AnalyticsKind,string>={coding:'코딩',model_hub:'Model Hub',planning:'기획',review:'리뷰',workflow:'워크플로'};
const executionTitles:Record<string,string>={starting:'시작 중',running:'실행 중',interrupting:'중단 중',completed:'완료',passed:'완료',failed:'실패',interrupted:'중단',lost:'상태 유실',timed_out:'시간 초과',stale:'오래된 결과',unknown:'미확인'};
const tokenSources={codex_observed_delta:'Codex 관측 차이',provider:'제공자 응답 토큰',unknown:'출처 미확인'};
const tokenStatuses={observed:'관측됨',incomplete:'불완전',unknown:'미확인'};
const number=(value:number|null)=>value===null?'미확인':value.toLocaleString('ko-KR');
const duration=(value:number|null)=>value===null?'미확인':value<1000?number(value)+' ms':(value/1000).toLocaleString('ko-KR',{maximumFractionDigits:3})+'초';
const timestamp=(value:string|null)=>value?new Date(value).toLocaleString('ko-KR'):'미확인';
const checkLabels:ReadonlyArray<[keyof CheckCounts,string]>=[['total','전체 검증'],['passed','검증 통과'],['failed','검증 실패'],['interrupted','검증 중단'],['timedOut','시간 초과'],['stale','오래된 판정'],['running','검증 중'],['lost','상태 유실'],['notRun','미실행']];
const statusLabels:ReadonlyArray<[keyof Pick<AnalyticsTotals,'completed'|'failed'|'active'|'interrupted'|'lost'|'timedOut'|'stale'|'unknown'>,string]>=[['completed','완료'],['failed','실패'],['active','진행 중'],['interrupted','중단'],['lost','상태 유실'],['timedOut','시간 초과'],['stale','오래된 결과'],['unknown','상태 미확인']];
function Checks({checks}:{checks:CheckCounts}){
  return <ul className="analytics-counts">{checkLabels.map(([key,label])=><li key={key}>{label} {number(checks[key])}</li>)}</ul>;
}
function StatusCounts({totals}:{totals:AnalyticsTotals}){
  return <ul className="analytics-counts">{statusLabels.map(([key,label])=><li key={key}>{label} {number(totals[key])}</li>)}</ul>;
}
function TokenCoverage({totals}:{totals:AnalyticsTotals}){
  return <small>토큰 확인 {number(totals.tokenKnownRecords)}개 · 미확인 {number(totals.tokenUnknownRecords)}개 · 불완전 {number(totals.tokenIncompleteRecords)}개</small>;
}
function DurationCoverage({totals}:{totals:AnalyticsTotals}){
  return <small>시간 확인 {number(totals.durationKnownRecords)}개 · 미확인 {number(totals.durationUnknownRecords)}개</small>;
}
function AnalyticsRecordDetails({record}:{record:AnalyticsRecord}){
  return <details className="analytics-record-details"><summary>기록 상세</summary>
    <dl>
      <div><dt>기록 ID</dt><dd>{record.id}</dd></div>
      <div><dt>작업 공간 ID</dt><dd>{record.workspaceId??'미확인'}</dd></div>
      <div><dt>Task ID</dt><dd>{record.taskId??'미확인'}</dd></div>
      <div><dt>생성 시각</dt><dd>{timestamp(record.createdAt)}</dd></div>
      <div><dt>종료 시각</dt><dd>{timestamp(record.finishedAt)}</dd></div>
      <div><dt>입력 토큰</dt><dd>{number(record.tokens.inputTokens)}</dd></div>
      <div><dt>출력 토큰</dt><dd>{number(record.tokens.outputTokens)}</dd></div>
      <div><dt>전체 토큰</dt><dd>{number(record.tokens.totalTokens)}</dd></div>
      <div><dt>토큰 관측 시각</dt><dd>{timestamp(record.observedAt)}</dd></div>
      <div><dt>워크플로 재시도</dt><dd>{record.retrySource==='workflow_lineage'?number(record.retryCount):'미확인'}</dd></div>
      <div><dt>재시도 알림</dt><dd>{number(record.retryNotices)}<p className="subtle">관측된 알림 수이며 정확한 재시도 횟수는 아닙니다.</p></dd></div>
    </dl>
    <h4>이 기록의 과거 검증</h4><Checks checks={record.checks}/>
  </details>;
}

export function ProjectAnalyticsView({state,onRefresh,onNextPage}:{state:ProjectAnalyticsState;onRefresh:()=>void;onNextPage:()=>void}){
  const {projectId,online,loading,error}=state;
  const data=projectId&&online&&state.data?.projectId===projectId?state.data:null;
  return <section className="surface project-analytics" aria-label="프로젝트 활동 분석" aria-busy={loading!==null}>
    <div className="section-heading"><h2>프로젝트 활동 분석</h2><button disabled={!projectId||!online||loading==='refresh'} onClick={onRefresh}>새로고침</button></div>
    <p>선택한 프로젝트에 저장된 로컬 실행 기록입니다. 모델을 호출하지 않고 기록만 조회합니다.</p>
    {!projectId?<p>프로젝트를 선택하면 활동을 확인할 수 있습니다.</p>:!online?<p>서버 연결 후 활동을 조회할 수 있습니다.</p>:<>
      {loading&&<p role="status">{loading==='page'?'다음 기록을 불러오는 중…':'프로젝트 활동을 불러오는 중…'}</p>}
      {error&&<p role="alert">{error}</p>}
      {data&&<>
        <p className="subtle">집계 조회 시각: {timestamp(data.generatedAt)} · 아래 집계는 프로젝트 전체 기록 기준입니다.</p>
        <div className="analytics-metrics">
          <article><span>실행 기록</span><strong>{number(data.totals.records)}</strong><small>로컬에 저장된 기록 수</small></article>
          <article><span>토큰 관측 소계</span><strong>{number(data.totals.tokenSubtotal)}</strong><TokenCoverage totals={data.totals}/></article>
          <article><span>작업 경과 시간 소계</span><strong>{duration(data.totals.durationSubtotalMs)}</strong><DurationCoverage totals={data.totals}/></article>
          <article><span>비용</span><strong>미확인</strong><small>이 기록으로 비용을 계산하지 않습니다.</small></article>
        </div>
        <StatusCounts totals={data.totals}/>
        <p className="subtle">워크플로 재시도 {number(data.totals.workflowRetries)}회 · 재시도 관계가 저장된 워크플로 기록만 집계합니다.</p>
        <details className="analytics-explanation"><summary>측정 범위와 출처</summary>
          <ul>
            <li><b>Codex 관측 차이:</b> 같은 연결에서 연속으로 확인한 누적 사용량의 차이입니다. 기준 관측이 없거나 연결·관측이 불완전하면 미확인 또는 불완전으로 표시합니다.</li>
            <li><b>제공자 응답 토큰:</b> 제공자 응답에 포함된 토큰 정보입니다. Codex 관측 차이와 측정 방식이 다릅니다.</li>
            <li><b>계정 사용량:</b> 구독 한도는 별도 계정 사용량 영역에서 확인합니다. 프로젝트에 배분하거나 이 소계에 더하지 않습니다.</li>
            <li>토큰 소계는 확인된 값만 더한 관측치이며 과금·청구 합계가 아닙니다. 미확인 값은 0으로 취급하지 않습니다. 불완전 기록 수는 확인·미확인 범위와 겹칠 수 있습니다.</li>
            <li>작업 경과 시간은 측정된 작업의 경과 시간이며 순수 추론 시간이 아닙니다. 동시에 진행된 작업의 시간도 각각 더합니다. 측정값이 없는 과거·유실 기록은 시각 차이로 추정하지 않습니다.</li>
          </ul>
        </details>
        <section aria-label="과거 검증 결과"><h3>과거 검증 결과</h3><p className="subtle">저장된 Check의 당시 판정입니다. 실행 완료와 검증 통과는 별개이며 현재 소스의 검증 상태·승인을 뜻하지 않습니다.</p><Checks checks={data.totals.checks}/></section>
        <section aria-label="유형과 제공자별 집계"><h3>유형 · 제공자 · 모델별 집계</h3>
          {data.groups.length===0?<p>집계할 기록이 없습니다.</p>:<div className="analytics-table-scroll"><table>
            <thead><tr><th scope="col">유형 · 제공자 · 모델</th><th scope="col">실행 기록</th><th scope="col">토큰 관측 소계</th><th scope="col">작업 경과 시간</th><th scope="col">과거 검증 · 재시도</th></tr></thead>
            <tbody>{data.groups.map(group=><tr key={JSON.stringify([group.kind,group.providerId,group.model])}>
              <th scope="row">{kinds[group.kind]}<small>{group.providerId??'제공자 미확인'}</small><small>{group.model??'모델 미확인'}</small></th>
              <td>{number(group.totals.records)}개<details><summary>실행 상태</summary><StatusCounts totals={group.totals}/></details></td>
              <td>{number(group.totals.tokenSubtotal)}<TokenCoverage totals={group.totals}/></td>
              <td>{duration(group.totals.durationSubtotalMs)}<DurationCoverage totals={group.totals}/></td>
              <td><details><summary>검증 {number(group.totals.checks.total)}개</summary><Checks checks={group.totals.checks}/></details><small>워크플로 재시도 {number(group.totals.workflowRetries)}회</small></td>
            </tr>)}</tbody>
          </table></div>}
        </section>
        <section aria-label="실행 기록"><h3>실행 기록</h3><p className="subtle">{number(data.records.length)} / {number(data.totals.records)}개 기록 표시 · 새로고침하면 첫 기록부터 다시 조회합니다.</p>
          {data.records.length===0?<p>이 프로젝트에 저장된 실행 기록이 없습니다.</p>:<div className="analytics-table-scroll"><table>
            <thead><tr><th scope="col">시각 · 유형</th><th scope="col">제공자 · 모델</th><th scope="col">실행 상태</th><th scope="col">작업 경과 시간</th><th scope="col">토큰 · 출처</th><th scope="col">상세</th></tr></thead>
            <tbody>{data.records.map(record=><tr key={recordKey(record)}>
              <th scope="row">{timestamp(record.createdAt)}<small>{kinds[record.kind]}</small></th>
              <td>{record.providerId??'제공자 미확인'}<small>{record.model??'모델 미확인'}</small>{record.modelChanged&&<small>실행 중 모델 변경 · 귀속 불확실</small>}</td>
              <td>{executionTitles[record.execution]??'미확인'}</td><td>{duration(record.durationMs)}</td>
              <td>{number(record.tokens.totalTokens)}<small>{tokenSources[record.tokenSource]}</small><small>{tokenStatuses[record.tokenStatus]}</small></td>
              <td><AnalyticsRecordDetails record={record}/></td>
            </tr>)}</tbody>
          </table></div>}
          {data.nextCursor!==null&&<button disabled={loading!==null} onClick={onNextPage}>다음 기록</button>}
        </section>
      </>}
    </>}
  </section>;
}

export function ProjectAnalyticsPanel({projectId,online}:AnalyticsScope){
  const [coordinator]=useState(()=>createProjectAnalyticsCoordinator());
  const state=useSyncExternalStore(coordinator.subscribe,coordinator.getSnapshot,coordinator.getSnapshot);
  useEffect(()=>{void coordinator.setScope({projectId,online});return()=>coordinator.dispose();},[coordinator,projectId,online]);
  // Hide the previous project's snapshot during the render before the scope effect runs.
  const visible=state.projectId===projectId&&state.online===online?state:emptyState({projectId,online});
  return <ProjectAnalyticsView state={visible} onRefresh={()=>void coordinator.refresh()} onNextPage={()=>void coordinator.nextPage()}/>;
}
