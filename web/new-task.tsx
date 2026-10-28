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
  const [text,setText]=useState(''),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false),[issue,setIssue]=useState(''),[note,setNote]=useState('');
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
  const fileInput=useRef<HTMLInputElement>(null);
  return <section className="new-task" aria-label="새 작업">
    <label htmlFor="new-task-text" className="sr-only">요청</label>
    <div className="task-composer">
      <textarea id="new-task-text" rows={5} maxLength={maxText} value={text} disabled={disabled} placeholder="예: 첨부한 견적서 두 개를 비교해서 표와 요약 보고서를 만들어 줘." onChange={event=>setText(event.target.value)}
        onKeyDown={event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void start();}}}/>
      {!!files.length&&<ul className="task-composer-files" aria-label="첨부한 자료">{files.map(file=><li key={file.name}><span>{file.name}</span><small>{(file.size/1024).toFixed(1)} KB</small>
        <button type="button" className="chip-remove" aria-label={file.name+' 첨부 취소'} disabled={disabled} onClick={()=>setFiles(old=>old.filter(item=>item!==file))}>×</button></li>)}</ul>}
      <div className="task-composer-bar">
        <button type="button" className="ghost" disabled={disabled} onClick={()=>fileInput.current?.click()}>＋ 자료 첨부</button>
        <input ref={fileInput} className="sr-only" type="file" multiple accept={extensions.join(',')} disabled={disabled} aria-label="자료 첨부" tabIndex={-1}
          onChange={event=>{const picked=[...(event.target.files??[])];setFiles(old=>[...old.filter(item=>!picked.some(file=>file.name===item.name)),...picked]);event.target.value='';}}/>
        <label className="task-composer-ai">기획 AI
          <select value="claude-code" disabled={disabled} onChange={()=>{}}>
            <option value="claude-code">Claude Code</option>
            <option value="codex" disabled>Codex — 일반 작업은 Git 작업 공간이 없어 사용할 수 없음</option>
          </select></label>
        <button className="primary task-composer-start" disabled={disabled||!text.trim()||!!fileIssue} onClick={()=>void start()}>{busy?'준비 중…':'작업 시작'}</button>
      </div>
    </div>
    <p className="task-composer-hint">텍스트 자료({extensions.join(' ')}) · 파일당 128 KB · 최대 {maxFiles}개. 기획 AI 자동 추천은 아직 없어 직접 선택합니다. AI에 보내기 전에 보낼 내용을 보여 주고 동의를 받습니다. 비밀번호·API 키·개인정보는 넣지 마세요.</p>
    {fileIssue&&<p role="alert" className="notice">{fileIssue}</p>}
    {issue&&<p role="alert" className="notice">{issue}</p>}
    <div className="examples" aria-label="예시">
      <span>예시</span>
      {examples.map(example=><button type="button" key={example.label} className="example" disabled={disabled||!example.text} title={example.note} onClick={()=>{if(example.text){setText(example.text);setNote(example.note??'');}}}>{example.label}{!example.text&&<small> · 미연결</small>}</button>)}
    </div>
    {note&&<p className="task-composer-hint" role="status">{note}</p>}
  </section>;
}

const examples:{label:string;text:string;note?:string}[]=[
  {label:'자료 분석',text:'첨부한 자료를 비교해서 표와 요약 보고서를 만들어 줘.'},
  {label:'문서 정리',text:'첨부한 회의 메모를 정리해서 결정 사항과 할 일 목록 문서로 만들어 줘.'},
  {label:'조사 계획',text:'신규 서비스 시장 조사를 위한 질문 목록과 조사 계획 문서를 만들어 줘.',note:'현재 일반 작업 실행기는 웹 검색 도구를 쓰지 않습니다. 계획과 문서는 만들 수 있지만 외부 자료 수집은 하지 않습니다.'},
  {label:'업무 자동화',text:'매주 반복하는 보고서 작성 업무를 자동화할 수 있는 단계별 계획을 만들어 줘.',note:'자동 실행 연결은 아직 없습니다. 계획 문서까지 만듭니다.'},
  {label:'프로그램 개발',text:'팀이 할 일을 추가하고 진행 상태를 볼 수 있는 간단한 웹 앱을 만들고 싶어.',note:'실제 코드 실행·테스트는 Git 저장소가 있는 코드 작업 프로젝트에서 합니다. 아래 ‘코드 작업 프로젝트 만들기’를 사용하세요.'},
  {label:'이미지',text:'',note:'이미지 생성 도구는 아직 연결되지 않았습니다.'},
];
