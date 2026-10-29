import {useRef,useState} from 'react';
import type {Material} from '../shared/deliverables.ts';
import {extensions,materialIssue} from './new-task-model.ts';

/**
 * Attached materials of a general project: add new files, or replace one file
 * with a new version. Orbit keeps the previous version; plans approved with the
 * old material must be confirmed again before they run.
 */
const messages:Record<string,string>={
  CREDENTIAL_LIKE_INPUT:'자료에 인증정보로 보이는 내용이 있어 저장하지 않았습니다.',PERSONAL_DATA_BLOCKED:'자료에 개인정보로 보이는 내용이 있어 저장하지 않았습니다.',
  INVALID_MATERIAL:'파일 이름은 문자·숫자로 시작하는 일반 이름이고, 내용은 UTF-8 텍스트여야 합니다.',
  MATERIAL_EXISTS:'같은 이름의 다른 자료가 이미 있습니다. 바꾸려면 그 자료의 ‘새 버전으로 교체’를 사용하세요.',
  MATERIAL_CHANGED:'자료가 그 사이에 바뀌었습니다. 목록을 새로 본 뒤 다시 교체하세요.',MATERIAL_NOT_FOUND:'교체할 자료를 찾지 못했습니다.',
  MATERIAL_HISTORY_FULL:'이전 버전 보관 한도에 도달해 교체하지 않았습니다.',MATERIALS_QUOTA:'자료 개수 한도에 도달했습니다.',
  RUN_ACTIVE:'실행 중인 작업이 끝난 뒤 다시 시도하세요.',
};

export function MaterialsCard({projectId,materials,online,locked,post,onChange}:{projectId:string;materials:Material[];online:boolean;locked:boolean;
  post:(path:string,body:object)=>Promise<any>;onChange:(items:Material[])=>void}){
  const [busy,setBusy]=useState(false),[issue,setIssue]=useState(''),[note,setNote]=useState('');
  const add=useRef<HTMLInputElement>(null),replace=useRef<HTMLInputElement>(null),target=useRef<Material|null>(null);
  const disabled=!online||locked||busy,base='/api/projects/'+encodeURIComponent(projectId)+'/materials';
  async function send(files:File[],material:Material|null){
    const problem=materialIssue(files);if(problem){setIssue(problem);return;}
    setBusy(true);setIssue('');setNote('');
    try{
      const contents=await Promise.all(files.map(async file=>({name:file.name,text:await file.text()})));
      const items=material
        ?await post(base+'/replace',{name:material.path.replace(/^inputs\//,''),text:contents[0].text,expectedSha256:material.sha256}) as Material[]
        :await post(base,{files:contents}) as Material[];
      if(Array.isArray(items))onChange(items);
      setNote(material?'새 버전으로 교체했습니다. 이전 버전은 보관됩니다. 이 자료로 승인한 실행 계획은 다시 확인해야 합니다.':'자료를 추가했습니다.');
    }catch(error){const code=error instanceof Error?error.message:'';setIssue(messages[code]??`자료를 저장하지 못했습니다(${code||'응답 확인 불가'}).`);}
    finally{setBusy(false);}
  }
  return <>
    {materials.length?<ul className="file-list">{materials.map(item=>{const name=item.path.replace(/^inputs\//,'');return <li key={item.path} title={item.path}><span>{name}</span>
      <small>{(item.size/1024).toFixed(1)} KB{item.previousVersions?` · 이전 버전 ${item.previousVersions}개 보관`:''}</small>
      <button type="button" className="ghost" disabled={disabled} aria-label={name+' 새 버전으로 교체'} onClick={()=>{target.current=item;replace.current?.click();}}>새 버전으로 교체</button></li>;})}</ul>
      :<p className="work-muted">첨부한 자료가 없습니다.</p>}
    <button type="button" disabled={disabled} onClick={()=>add.current?.click()}>{busy?'저장 중…':'＋ 자료 추가'}</button>
    <input ref={add} className="sr-only" type="file" multiple accept={extensions.join(',')} disabled={disabled} aria-label="자료 추가" tabIndex={-1}
      onChange={event=>{const files=[...(event.target.files??[])];event.target.value='';if(files.length)void send(files,null);}}/>
    <input ref={replace} className="sr-only" type="file" accept={extensions.join(',')} disabled={disabled} aria-label="교체할 새 버전 선택" tabIndex={-1}
      onChange={event=>{const files=[...(event.target.files??[])];event.target.value='';const material=target.current;target.current=null;if(material&&files.length===1)void send(files,material);}}/>
    <p className="work-muted">텍스트 자료({extensions.join(' ')}) · 파일당 128 KB. 같은 이름은 덮어쓰지 않고, 교체하면 이전 버전을 보관합니다. 비밀번호·API 키·개인정보는 넣지 마세요.</p>
    {note&&<p className="hint" role="status">{note}</p>}
    {issue&&<p role="alert" className="notice">{issue}</p>}
  </>;
}
