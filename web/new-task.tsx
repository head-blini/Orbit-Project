import {useRef,useState} from 'react';
import type {CreatedProject} from '../shared/project-creation.ts';
import type {Material} from '../shared/deliverables.ts';
import {extensions,maxFiles,materialIssue,planningRequestText,projectNameFrom} from './new-task-model.ts';

/**
 * Home entry for a new general task: natural-language request, optional text materials
 * and the planning AI. It only prepares a Git-free project and hands the request to the
 * planning panel; sending to an AI still needs the planning preview and explicit consent.
 */
const storageKey='orbit.newtask.receipt';
const maxText=8000;
type Receipt={requestId:string;name:string;projectId:string|null};
// Request text stays in memory only (never in browser storage), keyed by the created project.
// The new project may be selected (via its catalog event) before the request is handed over.
const handed=new Map<string,string>(),listeners=new Set<()=>void>();
export function takeNewTaskRequest(projectId:string){const text=handed.get(projectId);handed.delete(projectId);return text;}
export function handNewTaskRequest(projectId:string,text:string){handed.set(projectId,text);for(const listener of listeners)listener();}
export function onNewTaskRequest(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}

const messages:Record<string,string>={
  CREDENTIAL_LIKE_INPUT:'자료에 인증정보로 보이는 내용이 있어 저장하지 않았습니다.',PERSONAL_DATA_BLOCKED:'자료에 개인정보로 보이는 내용이 있어 저장하지 않았습니다.',
  INVALID_MATERIAL:'자료 이름이나 내용을 확인하세요. 파일 이름은 문자·숫자로 시작하는 일반 이름이어야 하고 UTF-8 텍스트여야 합니다.',MATERIAL_EXISTS:'같은 이름의 다른 자료가 이미 있습니다.',
};
function readReceipt():Receipt|null{try{const value=JSON.parse(sessionStorage.getItem(storageKey)??'null');return value&&typeof value.requestId==='string'?value:null;}catch{return null;}}
function writeReceipt(value:Receipt|null){try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch{throw new Error('RECEIPT_UNAVAILABLE');}}

export function NewTaskPanel({online,locked,post,onProject}:{online:boolean;locked:boolean;post:(path:string,body:object)=>Promise<any>;onProject:(id:string)=>void}){
  const [text,setText]=useState(''),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false),[issue,setIssue]=useState('');
  const sending=useRef(false);
  const fileIssue=materialIssue(files);
  const disabled=!online||locked||busy;
  async function start(){
    if(sending.current||disabled||!text.trim()||text.length>maxText||fileIssue)return;
    sending.current=true;setBusy(true);setIssue('');
    try{
      const contents=await Promise.all(files.map(async file=>({name:file.name,text:await file.text()})));
      // Reuse an uncertain earlier request instead of creating a second project.
      let receipt=readReceipt()??{requestId:crypto.randomUUID(),name:projectNameFrom(text),projectId:null};writeReceipt(receipt);
      if(!receipt.projectId){
        const created=await post('/api/projects/create',{requestId:receipt.requestId,name:receipt.name,kind:'general'}) as CreatedProject;
        if(created?.project?.kind!=='general'||created.workspace!==null)throw new Error('UNCERTAIN_RESPONSE');
        receipt={...receipt,projectId:created.project.id};writeReceipt(receipt);
      }
      const materials=contents.length?await post(`/api/projects/${receipt.projectId}/materials`,{files:contents}) as Material[]:[];
      writeReceipt(null);
      handNewTaskRequest(receipt.projectId!,planningRequestText(text,materials.filter(item=>contents.some(file=>item.path==='inputs/'+file.name))));
      onProject(receipt.projectId!);
    }catch(error){
      const code=error instanceof Error?error.message:'';
      setIssue(messages[code]??(code==='RECEIPT_UNAVAILABLE'?'브라우저가 요청 기록을 보존하지 못해 보내지 않았습니다.':`작업을 준비하지 못했습니다(${code||'응답 확인 불가'}). 다시 시작하면 같은 요청으로 확인하며 새 프로젝트를 중복으로 만들지 않습니다.`));
    }finally{sending.current=false;setBusy(false);}
  }
  return <section className="new-task" aria-label="새 작업">
    <h3>무엇을 해 드릴까요?</h3>
    <label htmlFor="new-task-text">요청</label>
    <textarea id="new-task-text" rows={4} maxLength={maxText} value={text} disabled={disabled} placeholder="예: 첨부한 자료를 비교해서 표와 요약 보고서를 만들어 줘." onChange={event=>setText(event.target.value)}/>
    <div className="new-task-row">
      <label className="new-task-files">자료 첨부 <span className="subtle">(텍스트 {extensions.join(' ')} · 파일당 128 KB · 최대 {maxFiles}개)</span>
        <input type="file" multiple accept={extensions.join(',')} disabled={disabled} onChange={event=>setFiles([...(event.target.files??[])])}/></label>
      <fieldset className="new-task-ai"><legend>기획 AI</legend>
        <label><input type="radio" name="new-task-planner" checked readOnly/> Claude Code</label>
        <label className="unavailable" title="일반 작업 기획은 현재 Claude Code만 연결돼 있습니다."><input type="radio" name="new-task-planner" disabled/> Codex <span className="subtle">— 일반 작업에서는 Git 작업 공간이 필요해 아직 사용할 수 없음</span></label>
      </fieldset>
    </div>
    {!!files.length&&<ul className="materials-list">{files.map(file=><li key={file.name}>{file.name} · {(file.size/1024).toFixed(1)} KB</li>)}</ul>}
    {fileIssue&&<p role="alert" className="notice">{fileIssue}</p>}
    <button className="primary" disabled={disabled||!text.trim()||!!fileIssue} onClick={()=>void start()}>{busy?'준비 중…':'시작'}</button>
    <p className="subtle">시작하면 Git 없는 프로젝트를 만들고 자료를 그 폴더에 저장합니다. AI에 보내기 전에 기획 요청을 미리 보고 동의를 받습니다. 실행 AI는 기획 승인 후 고릅니다. 비밀번호·API 키·개인정보는 넣지 마세요.</p>
    {issue&&<p role="alert" className="notice">{issue}</p>}
  </section>;
}
