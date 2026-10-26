import React, { useEffect, useState } from 'react';
import type { Snapshot, WorkspaceDiff } from '../shared/types.ts';

export function WorkspacePanel({state,projectId,onProject,locked,action,post}:{state:Snapshot|null;projectId:string;onProject:(id:string)=>void;locked:boolean;action:(fn:()=>Promise<void>)=>Promise<void>;post:(path:string,body:object)=>Promise<any>}){
  const [path,setPath]=useState('');
  const projects=state?.projects??[],workspaces=(state?.workspaces??[]).filter(w=>w.projectId===projectId);
  const selected=projects.find(p=>p.id===projectId);
  return <section className="workspace-panel" aria-label="프로젝트와 작업 공간">
    <div className="section-heading"><h2>프로젝트 & 작업 공간</h2><span className="pill">GIT WORKTREE</span></div>
    <form onSubmit={e=>{e.preventDefault();void action(async()=>{const p=await post('/api/projects',{path});onProject(p.id);setPath('');});}} className="register-project">
      <label htmlFor="project-path">로컬 Git 저장소 경로</label><div><input id="project-path" value={path} onChange={e=>setPath(e.target.value)} placeholder="C:\\Projects\\my-project" disabled={locked}/><button disabled={locked||!path.trim()}>프로젝트 등록</button></div>
    </form>
    {selected&&<div className="workspace-controls"><div className="project-location"><b>{selected.name}</b><p>{selected.path}</p></div><button disabled={locked||!selected.writeEnabled} onClick={()=>void action(async()=>{const w=await post('/api/workspaces',{projectId:selected.id});await post('/api/workspaces/select',{workspaceId:w.id});})}>새 작업 공간 만들기</button></div>}
    {selected&&!selected.writeEnabled&&<p className="hint">등록은 완료됐으며 쓰기는 잠겨 있습니다. 검증을 마친 저장소의 정확한 경로만 서버의 ORBIT_ALLOWED_PROJECTS에 추가하세요.</p>}
    {workspaces.length>0&&<label className="workspace-select">실행할 작업 공간<select aria-label="실행할 작업 공간" disabled={locked} value={workspaces.some(w=>w.id===state?.selectedWorkspaceId)?state?.selectedWorkspaceId??'':''} onChange={e=>void action(async()=>{await post('/api/workspaces/select',{workspaceId:e.target.value});})}><option value="" disabled>작업 공간 선택</option>{workspaces.map(w=><option key={w.id} value={w.id} disabled={w.status!=='ready'}>{w.branch} · {w.status==='ready'?'사용 가능':w.status==='creating'?'생성 중':'생성 실패'}</option>)}</select></label>}
    <p className="subtle">커밋된 HEAD에서 별도 브랜치를 만듭니다. 원본의 미커밋 변경은 복사하지 않으며, 중단·실패해도 작업 공간을 보존합니다.</p>
  </section>;
}

export function DiffPanel({workspaceId,refreshKey}:{workspaceId:string|null;refreshKey:string}){
  const [diff,setDiff]=useState<WorkspaceDiff|null>(null),[file,setFile]=useState(''),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(false);
  useEffect(()=>{let disposed=false;setDiff(null);setError('');if(!workspaceId)return;setLoading(true);
    void fetch('/api/workspaces/'+workspaceId+'/diff').then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);if(!disposed){setDiff(d);setFile(old=>d.files.some((f:any)=>f.path===old)?old:d.files[0]?.path??'');}}).catch(e=>{if(!disposed)setError(e.message);}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};
  },[workspaceId,refreshKey,refresh]);
  if(!workspaceId)return null;const current=diff?.files.find(f=>f.path===file);
  return <section className="diff-panel" aria-label="변경 파일과 Git Diff"><div className="section-heading"><h2>변경 파일 <span>{diff?.files.length??'—'}</span></h2><button disabled={loading} onClick={()=>setRefresh(n=>n+1)}>Diff 새로고침</button></div>
    <p className="subtle">기준 커밋 {diff?.baseSha.slice(0,12)??'확인 중'} → 현재 작업 공간 · 테스트 상태와 별개입니다.</p>
    {error&&<p role="alert" className="hint">Diff를 표시하지 못했습니다: {error}</p>}{loading&&<p role="status">변경 확인 중…</p>}
    {diff?.files.length===0&&<p className="subtle">변경된 파일이 없습니다.</p>}
    {!!diff?.files.length&&<div className="diff-layout"><nav aria-label="변경 파일">{diff.files.map(f=><button className={f.path===file?'selected':''} key={f.path} onClick={()=>setFile(f.path)}><span>{f.status}</span>{f.path}</button>)}</nav><div className="patch"><h3>{current?.path}</h3>{current?.patch!==null?<pre aria-label="Git Diff">{current?.patch}</pre>:<p>내용 표시 제외: {current?.omitted==='sensitive'?'민감 파일':current?.omitted==='binary'?'바이너리 파일':'크기 제한'}</p>}</div></div>}
  </section>;
}
