import {useEffect,useState} from 'react';
import type {ProjectAiPreferences,ProjectAiRuntime} from '../shared/project-ai-preferences.ts';

type Kind='code'|'general';
const labels:Record<ProjectAiRuntime,string>={codex:'Codex','claude-code':'Claude Code'};
/** Mirrors the server: only runnable combinations are selectable; the rest show why not. */
export function runtimeOptions(kind:Kind,stage:'planning'|'execution'):{runtime:ProjectAiRuntime;available:boolean;reason:string|null}[]{
  if(kind==='general')return [{runtime:'claude-code',available:true,reason:null},{runtime:'codex',available:false,reason:'Git 작업 공간이 필요합니다'}];
  if(stage==='planning')return [{runtime:'codex',available:true,reason:null},{runtime:'claude-code',available:true,reason:null}];
  return [{runtime:'codex',available:true,reason:null},{runtime:'claude-code',available:false,reason:'코드 프로젝트 실행 연결 전'}];
}

export function AiPreferencesView({kind,value,draft,busy,onChange,onSave}:{kind:Kind;value:ProjectAiPreferences;draft:Pick<ProjectAiPreferences,'planning'|'execution'>;busy:boolean;
  onChange:(next:Pick<ProjectAiPreferences,'planning'|'execution'>)=>void;onSave:()=>void}){
  const dirty=draft.planning!==value.planning||draft.execution!==value.execution;
  const select=(stage:'planning'|'execution')=><label>{stage==='planning'?'기획 AI':'실행 AI'}
    <select value={draft[stage]} disabled={busy} onChange={event=>onChange({...draft,[stage]:event.target.value as ProjectAiRuntime})}>
      {runtimeOptions(kind,stage).map(option=><option key={option.runtime} value={option.runtime} disabled={!option.available}>{labels[option.runtime]}{option.reason?` (${option.reason})`:''}</option>)}
    </select></label>;
  return <section className="surface ai-preferences" aria-label="프로젝트 AI 선택">
    <div className="section-heading"><div><h2>AI 선택</h2><p>이 프로젝트의 기획과 실행에 쓸 AI입니다. 저장한 선택이 실제 실행기와 같으며, 바꿔도 승인된 기준·결정 이유는 그대로 유지됩니다. 진행 중인 실행은 바뀌지 않습니다.</p></div>
      <span className="badge">{value.revision?`r${value.revision}`:'기본값'}</span></div>
    <div className="progress-actions">{select('planning')}{select('execution')}<button className="primary" disabled={busy||!dirty} onClick={onSave}>선택 저장</button></div>
  </section>;
}

export function AiPreferencesPanel({projectId,kind,online,post}:{projectId:string;kind:Kind;online:boolean;post:(path:string,body:object)=>Promise<Response>}){
  const [value,setValue]=useState<ProjectAiPreferences|null>(null),[draft,setDraft]=useState<Pick<ProjectAiPreferences,'planning'|'execution'>|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const path=`/api/projects/${encodeURIComponent(projectId)}/ai-preferences`;
  useEffect(()=>{
    let alive=true;setValue(null);setDraft(null);setError('');
    if(online)void fetch(path,{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then((next:ProjectAiPreferences)=>{if(alive){setValue(next);setDraft({planning:next.planning,execution:next.execution});}}).catch(()=>{if(alive)setError('AI 선택을 불러오지 못했습니다.');});
    return()=>{alive=false;};
  },[path,online]);
  async function save(){
    if(!value||!draft||busy)return;setBusy(true);setError('');
    try{
      const response=await post(path,{expectedRevision:value.revision,...draft});const data=await response.json().catch(()=>null);
      if(response.ok){setValue(data);setDraft({planning:data.planning,execution:data.execution});}
      else setError(data?.error==='AI_PREFERENCES_STALE'?'다른 곳에서 선택이 바뀌었습니다. 새로고침 후 다시 선택하세요.':data?.error==='GIT_REQUIRED'?'Codex는 Git 작업 공간이 있는 코드 프로젝트에서만 쓸 수 있습니다.':data?.error==='RUNTIME_NOT_SUPPORTED'?'이 조합은 아직 실행할 수 없습니다.':'AI 선택을 저장하지 못했습니다.');
    }catch{setError('저장 결과를 확인하지 못했습니다. 새로고침해 현재 선택을 확인하세요.');}
    finally{setBusy(false);}
  }
  return <>{error&&<div className="banner error" role="alert">{error}</div>}{value&&draft&&<AiPreferencesView kind={kind} value={value} draft={draft} busy={busy||!online} onChange={setDraft} onSave={()=>void save()}/>}</>;
}
