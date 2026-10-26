import { useEffect,useMemo,useRef,useState } from 'react';
import type {DevelopmentSelection} from '../shared/development-results.ts';
import type { Snapshot } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import type { ArtifactRecord,SavedTask } from '../shared/parallel.ts';
import { PlanningStudio } from './planning/index.tsx';
import { PlanningFeedbackPanel } from './planning/PlanningFeedback.tsx';
import type { PlanningFeedback } from '../shared/planning-handoff.ts';
import { VisualizationStudio } from './visualization/index.tsx';
import { createStudioMutator,mergeStudioRecords } from './studio-client.ts';
import './studios.css';
type Post=(path:string,data:object)=>Promise<any>;
type StudioPageId='planning'|'visualization';
type TaskActions={state?:Snapshot|null;busy?:boolean;canRunTask?:boolean;onRunTask?:(task:SavedTask)=>Promise<void>;onResult?:(selection:DevelopmentSelection)=>void};
async function get<T>(path:string):Promise<T>{const response=await fetch(path);if(!response.ok)throw new Error('LOAD_FAILED');return response.json() as Promise<T>;}
function downloadStudioBlob(blob:Blob,filename:string){
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function StudioPage({projectId,page,post,online,...taskActions}:{projectId:string;page:StudioPageId;post:Post;online:boolean}&TaskActions) {
 return <fieldset className="studio-page" disabled={!online}>{projectId?<ProjectStudio key={projectId} projectId={projectId} page={page} post={post} online={online} {...taskActions}/>:<div className="empty-state"><h2>프로젝트를 먼저 등록하세요</h2><p>기획과 시각화는 Codex 연결 없이 사용할 수 있습니다.</p><a className="button-link" href="#/projects">프로젝트 등록으로 이동</a></div>}</fieldset>;
}
function ProjectStudio({projectId,page,post,online,state,busy,canRunTask,onRunTask,onResult}:{projectId:string;page:StudioPageId;post:Post;online:boolean}&TaskActions){
  const [artifacts,setArtifacts]=useState<ArtifactRecord[]>([]),[tasks,setTasks]=useState<SavedTask[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const alive=useRef(false),postRef=useRef(post);postRef.current=post;
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{/* Retain requests in memory if browser storage is unavailable. */}return createStudioMutator((path,data)=>postRef.current(path,data),storage);},[]);
  const root='/api/projects/'+encodeURIComponent(projectId);
  async function reload(){
    setLoading(true);setError('');
    try{const [a,t]=await Promise.all([page==='visualization'?get<ArtifactRecord[]>(root+'/artifacts'):Promise.resolve([]),page==='planning'?get<SavedTask[]>(root+'/tasks'):Promise.resolve([])]);if(alive.current){setArtifacts(old=>mergeStudioRecords(old,a));setTasks(old=>mergeStudioRecords(old,t));}}
    catch{if(alive.current)setError('저장 기록을 불러오지 못했습니다. 다시 불러오기를 눌러 확인하세요.');}
    finally{if(alive.current)setLoading(false);}
  }
  useEffect(()=>{alive.current=true;void reload();return()=>{alive.current=false;};},[projectId]);
  return <>
    {error&&<p role="alert">{error}</p>}<button disabled={loading} onClick={()=>void reload()}>저장 기록 다시 불러오기</button>
    {page==='planning'&&<div>
      <PlanningStudio projectId={projectId} showTaskPreview={false} list={()=>get(root+'/plans')}
        agentPlanning={{post,online,workspaceId:state?.workspaces?.find(workspace=>workspace.id===state.selectedWorkspaceId&&workspace.projectId===projectId)?.id??null,
          busy:!!busy||!!state?.extensionBusy||!!state?.verificationBusy||!!state?.mergeBusy||!!state?.workflowBusy||!!state?.reviewBusy||!!state?.modelHubBusy||state?.provider==='connecting'||!!state?.runs.some(run=>!terminal(run.execution))}}
        onExport={async(_project,version,format)=>{
          const response=await fetch(`${root}/plans/${version.id}/export?revision=${version.revision}&hash=${encodeURIComponent(version.contentHash)}&format=${format}`);
          if(!response.ok)throw new Error('PLANNING_EXPORT_FAILED');
          const blob=await response.blob();if(!alive.current)return;
          downloadStudioBlob(blob,`orbit-plan-${version.id}-v${version.revision}.${format==='json'?'json':'md'}`);
        }}
        create={(_project,input)=>mutate(root+'/plans',{input})}
        revise={(_project,id,expectedRevision,input)=>mutate(`${root}/plans/${id}/revisions`,{expectedRevision,input})}
        approve={(_project,id,expectedRevision)=>post(`${root}/plans/${id}/approve`,{expectedRevision})}
        onCompare={(_project,targetId,baseId)=>get(`${root}/plans/${targetId}/diff?baseVersionId=${encodeURIComponent(baseId)}`)}
        onReplan={async(_project,targetId,input)=>{const saved:SavedTask[]=await mutate(`${root}/plans/${targetId}/replan`,{...input});if(alive.current)setTasks(old=>mergeStudioRecords(old,saved));return saved;}}
        toTasks={async(_project,id)=>{const saved:SavedTask[]=await post(`${root}/plans/${id}/task-drafts`,{});if(alive.current)setTasks(old=>[...old.filter(task=>task.planningVersionId!==id),...saved]);return saved;}}/>
      <section className="saved-tasks" aria-label="저장된 Task 초안"><h3>저장된 Task 초안</h3><p>현재 승인된 기획의 목표·인수조건·제약으로 실행합니다. 미결정 질문이 있으면 실행을 차단합니다.</p>
        {onRunTask&&!canRunTask&&<p>프로젝트의 작업 공간을 선택하고 에이전트 센터에서 Codex를 연결하세요. 진행 중이거나 결과가 불확실한 요청이 있으면 먼저 확인하세요.</p>}
        {!loading&&!tasks.length&&<p className="subtle">저장된 Task 초안이 없습니다. 기획안을 승인한 뒤 Task 초안을 생성하세요.</p>}{tasks.map(task=>{const run=taskResultRun(projectId,task,state);return <article key={task.id}><h4>{task.title}</h4><p>{task.description}</p><ul>{task.acceptanceCriteria.map((criterion,i)=><li key={i}>{criterion}</li>)}</ul><small>기획 {task.planningVersionId} · {run?run.execution:'현재 작업 공간의 연결 실행 없음'} · {run?'검증은 개발 화면에서 확인':'다른 작업 공간 기록은 여기서 조회하지 않습니다'}</small>{onRunTask&&<button disabled={!canRunTask} onClick={()=>void onRunTask(task)}>이 Task를 Codex로 실행</button>}{run?.workspaceId&&onResult&&<button onClick={()=>onResult({workspaceId:run.workspaceId!,runId:run.id})}>현재 작업 공간 결과 확인</button>}</article>;})}
      </section>
      <PlanningTaskProvenance tasks={tasks}/>
      <PlanningFeedbackPanel projectId={projectId} tasks={tasks} state={state}
        onPreview={input=>post(root+'/planning-feedback',input) as Promise<PlanningFeedback>}
        onDownload={feedback=>{if(alive.current)downloadStudioBlob(new Blob([feedback.markdown],{type:'text/markdown; charset=utf-8'}),`orbit-planning-feedback-${feedback.run.id}.md`);}}/>
    </div>}{page==='visualization'&&<div><VisualizationStudio projectId={projectId} artifacts={artifacts}
      onExportArtifact={async(artifact,format)=>{
        const response=await fetch(`${root}/artifacts/${artifact.id}/export?revision=${artifact.revision}&hash=${artifact.contentHash}&format=${format}`);
        if(!response.ok)throw new Error('EXPORT_FAILED');
        const blob=await response.blob();if(!alive.current)return;
        downloadStudioBlob(blob,`orbit-${artifact.id}-v${artifact.revision}.${format==='pptx'?'pptx':'md'}`);
      }}
      onHistory={id=>get(`${root}/artifacts/${id}/history`)}
      onSave={async({id,expectedRevision,...input})=>{
        const saved:ArtifactRecord=await mutate(id?`${root}/artifacts/${id}/revisions`:root+'/artifacts',id?{input,expectedRevision}:{input});
        if(alive.current)setArtifacts(old=>[...old.filter(a=>a.id!==saved.id),saved]);return saved;
      }}/></div>}
  </>;
}


export function PlanningTaskProvenance({tasks}:{tasks:SavedTask[]}){
  const linked=tasks.filter(task=>task.replannedFrom);
  return linked.length?<section className="planning-task-provenance" aria-label="후속 Task 이력"><h3>후속 Task 이력</h3>{linked.map(task=><p key={task.id}>{task.title} · 이전 기획 {task.replannedFrom!.planningVersionId} · {task.replannedFrom!.taskIds.length?`이전 Task ${task.replannedFrom!.taskIds.join(', ')}`:'연결된 이전 Task 없음'}</p>)}</section>:null;
}

export function MockProviders({connections,post}:{connections:Snapshot['connections'];post:Post}){
  const [providerId,setProviderId]=useState('bedrock'),[text,setText]=useState('합성 기획 요청 테스트'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  return <section className="surface mock-providers" aria-label="모의 제공자 정책"><h3>모의 제공자 정책 검사</h3>
    <p>이 영역은 모의 정책 검사입니다. 이 검사의 실제 모델 연결은 비활성화되어 있습니다. 설정된 HTTP 목적지의 진단·전송은 Model Hub에서, Codex 세션은 에이전트 센터에서 관리합니다.</p>
    <ul>{connections?.map(connection=><li key={connection.id}>{connection.id}: 모의 전용 ({connection.status}) · 코딩 미지원</li>)}</ul>
    <label>모의 제공자 <select value={providerId} disabled={busy} onChange={e=>setProviderId(e.target.value)}>{['bedrock','litellm','vllm','freellmapi'].map(id=><option key={id}>{id}</option>)}</select></label>
    <label>합성 테스트 입력<textarea value={text} maxLength={4000} disabled={busy} onChange={e=>setText(e.target.value)}/></label>
    <button disabled={busy||!text.trim()} onClick={async()=>{setBusy(true);setMessage('');try{const result=await post('/api/providers/mock/send',{providerId,text});setMessage(result.text);}catch(error){setMessage(error instanceof Error?error.message:'요청 실패');}finally{setBusy(false);}}}>모의 정책 검사</button>
    <p role="status">{message}</p><p>이메일·전화번호·식별번호 패턴과 인증정보 패턴을 차단합니다. 검출은 휴리스틱이며 실제 개인정보를 넣지 마세요.</p>
  </section>;
}

export function taskResultRun(projectId:string,task:SavedTask,state:Snapshot|null|undefined){
  if(task.projectId!==projectId||!state?.workspaces?.some(workspace=>workspace.id===state.selectedWorkspaceId&&workspace.projectId===projectId))return null;
  return state.runs.filter(run=>run.workspaceId===state.selectedWorkspaceId&&run.taskId===task.id&&run.planningVersionId===task.planningVersionId).at(-1)??null;
}
