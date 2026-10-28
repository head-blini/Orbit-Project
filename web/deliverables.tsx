import {useEffect,useRef,useState} from 'react';
import type {Deliverable,DeliverableList,DeliverablePreview} from '../shared/deliverables.ts';

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
export function DeliverablesView({list,preview,onPreview}:{list:DeliverableList;preview:DeliverablePreview|null;onPreview:(path:string)=>void}){
  const inputs=list.items.filter(item=>item.role==='input'),outputs=list.items.filter(item=>item.role!=='input');
  return <section className="surface" aria-label="결과물">
    {!!inputs.length&&<><h2>입력 자료</h2><ul className="materials-list">{inputs.map(item=><li key={item.path}><code>{item.path}</code> · {size(item.size)} {item.previewable&&<button onClick={()=>onPreview(item.path)}>미리보기</button>}</li>)}</ul></>}
    <div className="section-heading"><div><h2>결과물</h2><p>프로젝트 폴더의 파일입니다. 파일 존재·읽기·형식과, 표의 수치가 입력 자료에 있는지만 확인합니다. 내용 적합성은 확인하지 않았습니다.</p></div></div>
    {outputs.length?<table className="progress-runs deliverables"><thead><tr><th>파일</th><th>작업</th><th>크기</th><th>수정 시각</th><th>확인</th><th></th></tr></thead>
      <tbody>{outputs.map(item=><tr key={item.path}>
        <td><code>{item.path}</code></td><td>{item.taskTitle??'—'}</td><td>{size(item.size)}</td><td>{when(item.modifiedAt)}</td>
        <td>{!item.checks.nonEmpty?'빈 파일 · ':''}{formatLabels[item.checks.format]}{item.checks.evidence&&<><br/><span className={'evidence-'+item.checks.evidence.status}>{evidenceLabel(item.checks.evidence)}</span></>}</td>
        <td>{item.previewable?<button onClick={()=>onPreview(item.path)}>미리보기</button>:<span className="progress-note">미리보기 미지원</span>}</td>
      </tr>)}</tbody></table>:<p className="progress-empty">아직 결과물 파일이 없습니다.</p>}
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
  useEffect(()=>{setList(null);setPreview(null);setError('');},[projectId]);
  useEffect(()=>{
    if(!projectId||!online)return;
    const current=++ticket.current;
    const timer=setTimeout(async()=>{
      try{const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/deliverables`,{cache:'no-store'});if(!response.ok)throw new Error();
        const value=await response.json() as DeliverableList;if(current===ticket.current&&Array.isArray(value.items)){setList(value);setError('');}}
      catch{if(current===ticket.current)setError('결과물 목록을 불러오지 못했습니다.');}
    },lastSeq?600:0);
    return()=>clearTimeout(timer);
  },[projectId,online,lastSeq]);
  async function open(path:string){
    try{const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/deliverables/preview?path=${encodeURIComponent(path)}`,{cache:'no-store'});
      if(!response.ok)throw new Error();setPreview(await response.json() as DeliverablePreview);}
    catch{setError('미리보기를 불러오지 못했습니다.');}
  }
  return <>{error&&<div className="banner error" role="alert">{error}</div>}{list&&<DeliverablesView list={list} preview={preview} onPreview={path=>void open(path)}/>}</>;
}
