import {useEffect,useRef,useState} from 'react';
import type {TaskVerificationPreview} from '../shared/acceptance.ts';

export function TaskAcceptanceDetails({preview}:{preview:TaskVerificationPreview}){
  return <div>
    <p>{preview.scope}</p><p className="subtle">기획 {preview.planningVersionId} · 기준 커밋 <code>{preview.baseSha.slice(0,12)}</code> · 고정 기준 <code>{preview.digest.slice(0,16)}</code></p>
    <h3>인수 조건</h3><ul>{preview.criteria.map((criterion,index)=><li key={index}><b>{criterion.label}</b> · {criterion.description}<ul>{criterion.acceptanceCriteria.map((item,i)=><li key={i}>{item}</li>)}</ul></li>)}</ul>
    <h3>등록 명령과 보호 범위</h3><ul>{preview.commands.map(command=><li key={command.id}><b>{command.label}</b> · {command.id} · 설정 <code>{command.configDigest.slice(0,16)}</code><ul>{command.protectedFiles.map(path=><li key={path}><code>{path}</code></li>)}</ul></li>)}</ul>
    <details><summary>고정할 보호 파일 {preview.files.length}개</summary><ul>{preview.files.map(file=><li key={file.path}><code>{file.path}</code> · 모드 {file.mode} · SHA-256 <code>{file.sha256}</code></li>)}</ul></details>
  </div>;
}
type Props={projectId:string;workspaceId:string;taskId:string;taskTitle:string;scopeKey:string;active:boolean;onRun:(digest?:string)=>void|Promise<void>;onCancel:()=>void};
export function TaskVerificationPreviewPanel({projectId,workspaceId,taskId,taskTitle,scopeKey,active,onRun,onCancel}:Props){
  const key=JSON.stringify([projectId,workspaceId,taskId,scopeKey,active]);
  const [result,setResult]=useState<{key:string;preview:TaskVerificationPreview}|null>(null),[error,setError]=useState(''),[sending,setSending]=useState(false);
  const generation=useRef(0),latest=useRef(key),cancelled=useRef(false),started=useRef(false);latest.current=key;
  useEffect(()=>{
    const ticket=++generation.current;cancelled.current=false;started.current=false;setResult(null);setError('');setSending(false);
    const current=()=>ticket===generation.current&&latest.current===key&&!cancelled.current&&active;
    if(active)void (async()=>{
      try{
        const response=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/tasks/'+encodeURIComponent(taskId)+'/verification-preview?workspaceId='+encodeURIComponent(workspaceId));
        if(!response.ok)throw new Error();const data=await response.json();if(!current())return;
        if(!data||!Object.prototype.hasOwnProperty.call(data,'preview'))throw new Error();
        if(data.preview===null){started.current=true;setSending(true);await onRun();return;}
        const preview=data.preview as TaskVerificationPreview;
        if(preview.projectId!==projectId||preview.workspaceId!==workspaceId||preview.taskId!==taskId||!/^[a-f0-9]{64}$/.test(preview.digest))throw new Error();
        setResult({key,preview});
      }catch{if(current())setError('Task 실행 기준을 확인하지 못했습니다. 서버 연결과 현재 작업 공간을 확인한 뒤 다시 시도하세요. 실행은 시작하지 않았습니다.');}
    })();
    return()=>{generation.current++;};
  },[key]);
  const preview=result?.key===key?result.preview:null;
  function confirm(){if(!active||!preview||cancelled.current||started.current||latest.current!==key)return;started.current=true;setSending(true);void onRun(preview.digest);}
  return <section className="surface" aria-label="Task 실행 기준 확인">
    <div className="section-heading"><h2>Task 실행 기준 확인 · {taskTitle}</h2><button onClick={()=>{cancelled.current=true;generation.current++;onCancel();}}>취소</button></div>
    <p>AI가 작업하기 전에 인수 조건과 등록된 기존 테스트·보호 파일을 고정합니다. 이 동의는 명령 실행 승인이 아니며 검증 명령을 자동 실행하지 않습니다.</p>
    {error?<p role="alert">{error}</p>:!active?<p role="status">연결 또는 작업 선택이 바뀌었습니다. Task를 다시 선택하세요.</p>:!preview?<p role="status">실행 기준 확인 중…</p>:<><TaskAcceptanceDetails preview={preview}/><button className="primary" disabled={sending} onClick={confirm}>기준 고정 후 Task 실행</button></>}
  </section>;
}
