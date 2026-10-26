import {useEffect,useMemo,useRef,useState} from 'react';
import type {SavedTask} from '../../shared/parallel.ts';
import type {PlanningFeedback} from '../../shared/planning-handoff.ts';
import type {Snapshot} from '../../shared/types.ts';

type Epoch={generation:number;request:number};
/** Used by the actual preview and download paths, including immediate double clicks. */
export function createPlanningFeedbackEpoch(){
  let live=false,generation=0,request=0,pending=false;
  const current=(token:Epoch)=>live&&token.generation===generation&&token.request===request;
  return {
    reset(){live=true;generation++;request++;pending=false;},
    dispose(){live=false;generation++;request++;pending=false;},
    invalidate(){generation++;request++;pending=false;},
    begin():Epoch|null{if(!live||pending)return null;pending=true;return {generation,request:++request};},
    isCurrent:current,
    finish(token:Epoch){if(!current(token))return false;pending=false;return true;},
  };
}

/** Snapshot runs belong to the selected workspace; never invent a cross-workspace history. */
export function planningFeedbackChoices(projectId:string,tasks:readonly SavedTask[],state:Snapshot|null|undefined,taskId:string){
  const allowed=tasks.filter(task=>task.projectId===projectId);
  const workspace=state?.workspaces?.find(workspace=>workspace.id===state.selectedWorkspaceId&&workspace.projectId===projectId);
  return {tasks:allowed,runs:workspace&&allowed.some(task=>task.id===taskId)?state!.runs.filter(run=>run.workspaceId===workspace.id&&run.taskId===taskId):[]};
}
type Selection={projectId:string;taskId:string;runId:string;workspaceId:string};
export function matchesPlanningFeedback(value:PlanningFeedback,selection:Selection){
  return value?.projectId===selection.projectId&&value.task?.id===selection.taskId&&value.run?.id===selection.runId
    &&value.run.workspaceId===selection.workspaceId&&typeof value.markdown==='string'&&typeof value.filename==='string';
}
type Props={projectId:string;tasks:readonly SavedTask[];state?:Snapshot|null;
  onPreview:(input:{taskId:string;runId:string;question:string})=>Promise<PlanningFeedback>;
  onDownload:(feedback:PlanningFeedback)=>void|Promise<void>};
export function PlanningFeedbackPanel(props:Props){
  return <ScopedPlanningFeedback key={props.projectId+':'+(props.state?.selectedWorkspaceId??'none')} {...props}/>;
}
function ScopedPlanningFeedback({projectId,tasks,state,onPreview,onDownload}:Props){
  const [taskId,setTaskId]=useState(''),[runId,setRunId]=useState(''),[question,setQuestion]=useState('');
  const [preview,setPreview]=useState<{value:PlanningFeedback;token:Epoch;scope:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const order=useMemo(()=>createPlanningFeedbackEpoch(),[]),previewRef=useRef(onPreview),downloadRef=useRef(onDownload);
  previewRef.current=onPreview;downloadRef.current=onDownload;
  const choices=planningFeedbackChoices(projectId,tasks,state,taskId),selectedRun=choices.runs.find(run=>run.id===runId);
  const selectedTask=choices.tasks.find(task=>task.id===taskId);
  const scope=JSON.stringify({projectId,workspaceId:state?.selectedWorkspaceId??null,taskId,runId,question,
    taskVersion:selectedTask?.planningVersionId??null,runUpdatedAt:selectedRun?.updatedAt??null,execution:selectedRun?.execution??null,verification:selectedRun?.verification??null});
  const scopeRef=useRef(scope);scopeRef.current=scope;
  useEffect(()=>{order.reset();return()=>order.dispose();},[order]);
  function invalidate(){order.invalidate();setPreview(null);setBusy(false);setError('');setMessage('');}
  // A new snapshot may remove the selected Run or change its evidence while the
  // user is typing. Old responses must also be rejected before this effect runs.
  useEffect(()=>{invalidate();},[selectedTask?.planningVersionId,selectedRun?.id,selectedRun?.updatedAt,selectedRun?.execution,selectedRun?.verification]);
  const shown=preview?.scope===scope?preview:null;
  async function generate(){
    if(!selectedRun||!selectedTask||question.length>2000)return;
    const token=order.begin();if(!token)return;
    const requestedScope=scope,selection={projectId,taskId,runId,workspaceId:selectedRun.workspaceId!};
    setBusy(true);setPreview(null);setError('');setMessage('');
    try{
      const value=await previewRef.current({taskId,runId,question});
      if(!order.isCurrent(token)||scopeRef.current!==requestedScope)return;
      if(!matchesPlanningFeedback(value,selection))throw new Error('FEEDBACK_SCOPE_MISMATCH');
      setPreview({value,token,scope:requestedScope});
    }catch{if(order.isCurrent(token)&&scopeRef.current===requestedScope)setError('개발 증거 미리보기를 확인하지 못했습니다. Task·Run과 증거 상태를 확인한 뒤 다시 생성하세요.');}
    finally{if(order.finish(token))setBusy(false);}
  }
  async function download(){
    if(!shown||!order.isCurrent(shown.token)||scopeRef.current!==shown.scope)return;
    try{await downloadRef.current(shown.value);if(order.isCurrent(shown.token))setMessage('피드백 Markdown 다운로드를 요청했습니다. 내용을 검토한 뒤 수동으로 전달하세요.');}
    catch{if(order.isCurrent(shown.token))setError('피드백 다운로드를 준비하지 못했습니다. 다시 미리보기를 생성해 확인하세요.');}
  }
  return <section className="planning-feedback surface" aria-label="Planning handoff">
    <h3>개발 증거로 재기획 준비</h3>
    <p>현재 선택한 작업 공간의 snapshot에 표시된 Run만 선택할 수 있습니다. 다른 작업 공간의 실행은 프로젝트 화면에서 해당 작업 공간을 선택한 뒤 확인하세요.</p>
    <p>외부 AI로 자동 전송하지 않습니다. 생성 당시 증거와 질문을 검토한 뒤 수동으로 전달하세요. 기획 승인·Task·Run을 자동 변경하지 않으며 재기획은 새 초안으로 작성합니다.</p>
    <div className="planning-feedback-controls">
      <label htmlFor="planning-feedback-task">증거를 모을 Task</label><select id="planning-feedback-task" value={taskId} onChange={event=>{invalidate();setTaskId(event.target.value);setRunId('');}}>
        <option value="">Task 선택</option>{choices.tasks.map(task=><option key={task.id} value={task.id}>{task.title} · {task.requirementLabels.join(', ')}</option>)}
      </select>
      <label htmlFor="planning-feedback-run">Task에 연결된 Run</label><select id="planning-feedback-run" value={runId} disabled={!choices.runs.length} onChange={event=>{invalidate();setRunId(event.target.value);}}>
        <option value="">Run 선택</option>{choices.runs.map(run=><option key={run.id} value={run.id}>{run.id.slice(0,8)} · {run.execution} · 검증 {run.verification}</option>)}
      </select>
      <label htmlFor="planning-feedback-question">재기획 질문 (선택)</label><textarea id="planning-feedback-question" maxLength={2000} rows={3} value={question} onChange={event=>{invalidate();setQuestion(event.target.value);}}/>
      <p>질문은 이 요청에서만 사용하며 저장하지 않습니다. 인증정보와 개인정보를 입력하지 말고, 내려받기 전 직접 검토하세요.</p>
      <button disabled={busy||!selectedTask||!selectedRun||question.length>2000} onClick={()=>void generate()}>개발 증거 미리보기</button>
      {!choices.runs.length&&<p>선택할 연결 Run이 없습니다. 이 화면에서는 증거를 만들거나 실행을 자동 생성하지 않습니다.</p>}
    </div>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {shown&&<PlanningFeedbackPreview feedback={shown.value} disabled={busy} onDownload={()=>void download()}/>}
  </section>;
}

export function PlanningFeedbackPreview({feedback,disabled=false,onDownload}:{feedback:PlanningFeedback;disabled?:boolean;onDownload:()=>void}){
  return <div className="planning-feedback-preview">
    <h4>생성 당시 개발 증거 미리보기</h4>
    <p>생성 시각 {feedback.generatedAt} · 저장 기획 r{feedback.planning.revision} · {feedback.planning.state} · {feedback.planning.current?'현재 기획 버전':'과거 기획 버전'}</p>
    <p>Run {feedback.run.id} · 실행 {feedback.run.execution} · 검증 기록 {feedback.run.verification}. 이후 소스나 실행 상태가 바뀌면 다시 생성하세요.</p>
    <p>{feedback.verification.available?'검증 근거 조회됨':'검증 근거 확인 불가 · unknown'} · {feedback.verification.available?(feedback.verification.canApprove?'현재 검증 통과 근거 있음':'현재 검증 통과 근거 없음'):'현재 검증 통과 근거: unknown'} · {feedback.verification.available?(feedback.verification.approvalCurrent?'현재 리뷰 승인 유효':'현재 리뷰 승인 유효하지 않음'):'현재 리뷰 승인 유효성: unknown'} · {feedback.changes.available?'현재 작업 공간의 파일 상태 조회됨':'파일 상태 조회 불가'}. 근거 없음이나 unknown은 실패 판정이 아닙니다.</p>
    {!!feedback.verification.checks.length&&<div className="planning-feedback-checks"><table><caption>생성 당시 Check 기록 · 과거 verdict와 현재 소스 유효성은 별개</caption><thead><tr><th>명령 ID</th><th>실행</th><th>verdict</th><th>exit</th></tr></thead><tbody>{feedback.verification.checks.slice(0,100).map(check=><tr key={check.id}><td>{check.commandId}</td><td>{check.execution}</td><td>{check.verdict}</td><td>{check.exitCode??'unknown'}</td></tr>)}</tbody></table>{feedback.verification.checks.length>100&&<p>최근 문서의 Check 중 앞 100개만 표에 표시합니다. 전체 근거는 아래 원문에서 확인하세요.</p>}</div>}
    <p>아래 원문은 실행하거나 렌더링하지 않습니다. 외부 전달 전 민감 내용과 증거의 한계를 검토하세요.</p>
    <pre><code>{feedback.markdown}</code></pre>
    <button disabled={disabled} onClick={()=>{if(!disabled)onDownload();}}>피드백 Markdown 다운로드</button>
  </div>;
}
