import {useEffect,useRef,useState} from 'react';
import type {Deliverable,DeliverableList,DeliverablePreview,DeliverableVersion} from '../shared/deliverables.ts';

const formatLabels:Record<Deliverable['checks']['format'],string>={passed:'형식 확인',failed:'형식 오류',unsupported:'형식 검사 미지원'};
export function evidenceLabel(evidence:Deliverable['checks']['evidence']){
  if(!evidence)return '';
  if(evidence.status==='passed')return `표 수치 ${evidence.numbers}개 모두 자료에 있음`;
  if(evidence.status==='needs_review')return `표 수치 ${evidence.numbers}개 중 ${evidence.numbers-evidence.matched}개 자료에 없음 · 확인 필요: ${evidence.unmatched.join(', ')}`;
  return '근거 대조 불가(표 수치 또는 자료 없음)';
}
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
const when=(value:string)=>new Date(value).toLocaleString('ko-KR',{hour12:false});

/** Pure view of a general project's files. File checks never imply the content is correct. */
export function DeliverablesView({list,preview,onPreview,projectId,history,onHistory}:{list:DeliverableList;preview:DeliverablePreview|null;onPreview:(path:string)=>void;projectId?:string;history?:{id:string;versions:DeliverableVersion[]}|null;onHistory?:(id:string)=>void}){
  const inputs=list.items.filter(item=>item.role==='input'),outputs=list.items.filter(item=>item.role!=='input');
  return <section className="surface" aria-label="결과물">
    {!!inputs.length&&<><h2>입력 자료</h2><ul className="materials-list">{inputs.map(item=><li key={item.path}><code>{item.path}</code> · {size(item.size)} {item.previewable&&<button onClick={()=>onPreview(item.path)}>미리보기</button>}</li>)}</ul></>}
    <div className="section-heading"><div><h2>결과물</h2><p>프로젝트 폴더의 파일입니다. 파일 존재·읽기·형식과, 표의 수치가 입력 자료에 있는지만 확인합니다. 내용 적합성은 확인하지 않았습니다.</p></div></div>
    {outputs.length?<table className="progress-runs deliverables"><thead><tr><th>파일</th><th>작업</th><th>크기</th><th>수정 시각</th><th>확인</th><th></th></tr></thead>
      <tbody>{outputs.map(item=><tr key={item.path}>
        <td><code>{item.path}</code></td><td>{item.taskTitle??'—'}</td><td>{size(item.size)}</td><td>{when(item.modifiedAt)}</td>
        <td>{!item.checks.nonEmpty?'빈 파일 · ':''}{formatLabels[item.checks.format]}{item.checks.evidence&&<><br/><span className={'evidence-'+item.checks.evidence.status}>{evidenceLabel(item.checks.evidence)}</span></>}</td>
        <td>{projectId&&item.id&&<><a href={`/api/projects/${encodeURIComponent(projectId)}/deliverables/${encodeURIComponent(item.id)}/download`} download>파일 받기</a>{onHistory&&<button onClick={()=>onHistory(item.id!)}>이전 버전 보기</button>}</>}{item.previewable?<button onClick={()=>onPreview(item.path)}>미리보기</button>:<span className="progress-note">미리보기 미지원</span>}</td>
      </tr>)}</tbody></table>:<p className="progress-empty">아직 결과물 파일이 없습니다.</p>}
    {history&&<details open><summary>저장된 버전 기록 · 최근 최대 100개</summary>{history.versions.length?<ol>{history.versions.map(version=><li key={version.id}>
      {version.path} · {size(version.size)} · 관측 {when(version.observedAt)} · 생성 실행 {version.runId??'미확인'} · 실행 시각 {version.runAt?when(version.runAt):'미확인'}
      <small> SHA256 {version.sha256}</small>
      {version.available!==false&&projectId?<a href={`/api/projects/${encodeURIComponent(projectId)}/deliverables/${encodeURIComponent(history.id)}/versions/${encodeURIComponent(version.id)}/download`} download>{version.available===undefined?'보존 여부 확인 후 받기':'이 버전 받기'}</a>:<span>파일이 보존되어 있지 않아 받을 수 없습니다.</span>}
    </li>)}</ol>:<p>기록된 버전이 없습니다. 파일 변경 확인으로 현재 버전을 기록하세요.</p>}</details>}
    {list.skipped>0&&<p className="progress-note">{list.skipped}개 항목은 보안상 표시하지 않았습니다(숨김·인증·DB·키 파일, 링크).</p>}
    {list.truncated&&<p className="progress-note">파일이 많아 일부만 표시했습니다.</p>}
    {preview?.kind==='text'&&<div><p className="progress-note">{preview.path} 미리보기{preview.truncated?' · 일부만 표시':''}</p><pre className="progress-handoff">{preview.text}</pre></div>}
    {preview?.kind==='unsupported'&&<p className="progress-note">이 형식({preview.mediaType})은 미리보기를 지원하지 않습니다.</p>}
  </section>;
}

/** Loads the list on scope change and after new events; previews only on explicit request. */
export function DeliverablesPanel({projectId,online,lastSeq}:{projectId:string;online:boolean;lastSeq:number}){
  const [list,setList]=useState<DeliverableList|null>(null),[preview,setPreview]=useState<DeliverablePreview|null>(null),[error,setError]=useState('');
  const ticket=useRef(0);
  const [history,setHistory]=useState<{id:string;versions:DeliverableVersion[]}|null>(null),[saving,setSaving]=useState(false);
  const scope=useRef('');scope.current=online?projectId:'';
  useEffect(()=>{setList(null);setPreview(null);setHistory(null);setError('');},[projectId]);
  useEffect(()=>{
    if(!projectId||!online)return;
    const current=++ticket.current;
    const timer=setTimeout(async()=>{
      try{const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/deliverables`,{cache:'no-store'});if(!response.ok)throw new Error();
        const value=await response.json() as DeliverableList;if(current===ticket.current&&Array.isArray(value.items)){setList(value);setError('');}}
      catch{if(current===ticket.current)setError('결과물 목록을 불러오지 못했습니다.');}
    },lastSeq?600:0);
    return()=>{clearTimeout(timer);ticket.current++;};
  },[projectId,online,lastSeq]);
  async function historyFor(id:string){
    const current=scope.current;if(!current)return;
    try{const response=await fetch(`/api/projects/${encodeURIComponent(current)}/deliverables/${encodeURIComponent(id)}/versions`,{cache:'no-store'});
      if(!response.ok)throw Error();const versions=await response.json() as DeliverableVersion[];
      if(scope.current===current)setHistory({id,versions});
    }catch{if(scope.current===current)setError('버전 기록을 불러오지 못했습니다.');}
  }
  async function observe(){
    const current=scope.current;if(!current||saving)return;setSaving(true);
    try{
      const session=await fetch('/api/session',{cache:'no-store'});if(!session.ok)throw Error();
      const {csrfToken}=await session.json();if(scope.current!==current)return;
      const response=await fetch(`/api/projects/${encodeURIComponent(current)}/deliverables/observe`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:'{}'});
      if(!response.ok)throw Error();const value=await response.json() as DeliverableList;
      if(scope.current===current){setList(value);setHistory(null);setError('');}
    }catch{if(scope.current===current)setError('파일 변경을 확인하지 못했습니다. 다시 시도하세요.');}
    finally{setSaving(false);}
  }
  async function open(path:string){
    try{const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/deliverables/preview?path=${encodeURIComponent(path)}`,{cache:'no-store'});
      if(!response.ok)throw new Error();setPreview(await response.json() as DeliverablePreview);}
    catch{setError('미리보기를 불러오지 못했습니다.');}
  }
  return <><button disabled={!online||saving} onClick={()=>void observe()}>파일 변경 확인</button>{error&&<div className="banner error" role="alert">{error}</div>}{list&&<DeliverablesView list={list} projectId={online?projectId:undefined} history={history} onHistory={online?id=>void historyFor(id):undefined} preview={preview} onPreview={path=>void open(path)}/>}</>;
}
