import type React from 'react';
import type {DevelopmentSelection} from '../shared/development-results.ts';
import type { Snapshot } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import { executionLabels as execution } from './navigation.ts';
import {SoloOperationDetails} from './solo-operation.tsx';
export interface AgentCenterProps {
 state:Snapshot|null; online:boolean; busy:boolean; matches:boolean; prompt:string; pending:string|null;
 setPrompt:(value:string)=>void; connect:()=>Promise<void>; submit:(event:React.FormEvent)=>Promise<void>;
 interrupt:(id:string)=>Promise<void>; clearPending:()=>void; onProjects:()=>void; onActiveSession:()=>void; issueMessage:string;onResult?:(selection:DevelopmentSelection)=>void;
}
export function AgentCenter({state,online,busy,matches,prompt,pending,setPrompt,connect,submit,interrupt,clearPending,onProjects,onActiveSession,issueMessage,onResult}:AgentCenterProps) {
 const active=state?.runs.find(run=>!terminal(run.execution)),recovery=!!state?.soloRecoveryRequired;
 if(!matches)return <section className="empty-state"><h2>실행할 작업 공간을 선택하세요</h2><p>현재 프로젝트에 연결된 작업 공간이 없습니다. 기획과 시각화는 AI 연결 없이 사용할 수 있습니다.</p>{active?<><p role="status">다른 작업 공간에서 실행 중입니다. 해당 실행으로 이동해 상태를 확인하거나 중단할 수 있습니다.</p><button onClick={onActiveSession}>현재 실행으로 이동</button></>:<button onClick={onProjects}>프로젝트에서 작업 공간 선택</button>}</section>;
 return <div className="agent-center">
      {recovery&&<p className="banner error" role="alert">종료를 확인하지 못한 실행이 있어 새 실행과 세션 연결을 차단했습니다. 기록 조회는 가능합니다. 안전한 복구 기능은 준비 중이며 자동 해제하지 않습니다.</p>}
      <section className="session-bar"><div><b>{state?.selectedWorkspaceId?'격리된 작업 공간 세션':'읽기 전용 테스트 세션'}</b><small>{state?.workspace??'테스트 저장소 준비 중'} · {state?.threadId?'세션 '+state.threadId.slice(0,8):'세션 생성 전'}</small></div><button onClick={connect} disabled={!online||busy||recovery||!matches||!!active||state?.provider==='ready'||state?.provider==='connecting'}>{state?.provider==='connecting'?'연결 중…':state?.threadId?'세션 이어받기':'Codex 연결'}</button></section>
      {state?.issue&&<p className="hint">{issueMessage}</p>}
      <section className="conversation" aria-label="대화 기록">{state?.runs.length?state.runs.map(r=><article className="run" key={r.id}><div className="run-heading"><span>RUN {state.runs.indexOf(r)+1}</span><time>{new Date(r.createdAt).toLocaleTimeString('ko-KR')}</time><span className={'run-state '+r.execution}>{execution[r.execution]}</span></div><div className="message user"><label>사용자</label><p>{r.prompt}</p></div><div className="message assistant"><label>CODEX</label><pre>{r.response||(!terminal(r.execution)?'응답을 기다리고 있습니다…':'표시할 응답이 없습니다.')}</pre></div><div className="verification">검증 결과는 개발 화면에서 확인하세요. 응답 완료와 테스트 통과는 별개입니다.</div>{onResult&&r.workspaceId===state.selectedWorkspaceId&&r.workspaceId&&<button onClick={()=>onResult({workspaceId:r.workspaceId!,runId:r.id})}>이 실행의 결과 확인</button>}<SoloOperationDetails runId={r.id}/></article>):<div className="empty"><div className="empty-icon">⌘</div><h2>첫 작업을 시작하세요</h2><p>프로젝트와 작업 공간을 선택한 뒤 Codex를 연결하세요.<br/>수정할 파일과 변경 내용을 프롬프트에 지정하세요.</p></div>}</section>
      <form className="composer" onSubmit={submit}><label htmlFor="prompt">프롬프트</label><textarea id="prompt" value={prompt} onChange={e=>setPrompt(e.target.value)} maxLength={4000} placeholder="예: apply_patch로 지정한 소스 파일을 수정해줘." disabled={!online||busy||recovery||!!active||state?.provider!=='ready'||!matches||!!pending}/><div className="composer-bottom"><small>인증정보를 입력하지 마세요. 대화는 이 컴퓨터에 보존됩니다.</small><div>{active&&<button type="button" className="stop" onClick={()=>interrupt(active.id)} disabled={!online||busy||recovery||active.execution==='starting'||active.execution==='interrupting'}>실행 중단</button>}<button type="submit" className="primary" disabled={!online||busy||recovery||!!active||state?.provider!=='ready'||!matches||!prompt.trim()||!!pending}>프롬프트 전송 ↗</button></div></div></form>
      {pending&&!busy&&<div className="banner">이전 전송 결과를 확인해야 합니다. 실행 기록을 확인한 뒤 새 메시지를 작성하세요. <button onClick={clearPending}>확인했고 새 입력 허용</button></div>}

 </div>;
}
