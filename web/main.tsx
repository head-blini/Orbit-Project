import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, AppEvent, Run } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import './style.css';

const execution:Record<string,string>={starting:'시작 중',running:'응답 중',interrupting:'중단 요청 중',completed:'응답 완료',interrupted:'중단됨',failed:'실패',lost:'연결 유실 · 결과 미확인'};
const provider:Record<string,string>={disconnected:'연결 안 됨',connecting:'연결 중',ready:'Codex 연결됨',auth_required:'ChatGPT 로그인 필요',not_installed:'Codex 설치 필요',error:'연결 오류'};
const errors:Record<string,string>={CHATGPT_LOGIN_REQUIRED:'터미널에서 codex login으로 ChatGPT 계정에 로그인하세요.',CODEX_NOT_INSTALLED:'Codex 실행 파일을 찾지 못했습니다. README의 AICC_CODEX_BIN 설정을 확인하세요.',CONNECTION_FAILED:'Codex에 연결하지 못했습니다. CLI 로그인과 정상 사용자 환경을 확인한 뒤 다시 연결하세요.',SUBMIT_UNCERTAIN:'전송 결과를 확인하지 못했습니다. 자동으로 재전송하지 않습니다.',RUN_ACTIVE:'다른 실행이 진행 중입니다.',CREDENTIAL_LIKE_INPUT:'인증정보로 보이는 내용은 전송할 수 없습니다.',CSRF_REJECTED:'웹 연결이 만료됐습니다. 새로고침하세요.',NOT_CONNECTED:'먼저 Codex를 연결하세요.',POLICY_MISMATCH:'읽기 전용·네트워크·승인 정책이 일치하지 않아 연결을 차단했습니다.',MCP_ISOLATION_REQUIRED:'MCP 도구 격리를 확인하지 못해 연결을 차단했습니다. README의 MCP 격리 안내를 확인하세요.',THREAD_STILL_ACTIVE:'저장된 세션이 아직 실행 중입니다. 기존 실행 상태를 확인하세요.'};
function App(){
  const [state,setState]=useState<Snapshot|null>(null),[prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[online,setOnline]=useState(false),[events,setEvents]=useState<AppEvent[]>([]);
  const [pending,setPending]=useState(sessionStorage.getItem('aicc.pending'));
  const csrf=useRef(''),seq=useRef(0),submitting=useRef(false);
  useEffect(()=>{
    let disposed=false,source:EventSource|null=null,retry:ReturnType<typeof setTimeout>|undefined;
    async function bootstrap(){
      try{
        const session=await fetch('/api/session');if(!session.ok)throw new Error();csrf.current=(await session.json()).csrfToken;
        const r=await fetch('/api/state');if(!r.ok)throw new Error();const s:Snapshot=await r.json();if(disposed)return;
        setState(s);seq.current=s.lastSeq;setOnline(true);
        const id=sessionStorage.getItem('aicc.pending');if(id&&s.runs.some(r=>r.requestId===id)){sessionStorage.removeItem('aicc.pending');setPending(null);}
        source=new EventSource('/api/events?after='+s.lastSeq);
        source.onopen=()=>setOnline(true);
        source.onmessage=message=>{
          const e:AppEvent=JSON.parse(message.data);if(e.seq<=seq.current)return;seq.current=e.seq;
          setEvents(old=>[...old,e].slice(-30));
          setState(old=>{
            if(!old)return old;const next={...old,lastSeq:e.seq};
            if(e.kind==='provider.status'){next.provider=e.data.status as Snapshot['provider'];next.issue=e.data.issue as string|null;}
            if(e.data.run){const run=e.data.run as Run;next.runs=old.runs.some(r=>r.id===run.id)?old.runs.map(r=>r.id===run.id?run:r):[...old.runs,run];}
            return next;
          });
        };
        source.onerror=()=>{source?.close();setOnline(false);if(!disposed)retry=setTimeout(bootstrap,2500);};
      }catch{if(!disposed){setOnline(false);retry=setTimeout(bootstrap,2500);}}
    }
    void bootstrap();return()=>{disposed=true;source?.close();if(retry)clearTimeout(retry);};
  },[]);
  async function post(path:string,body:object){
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.current},body:JSON.stringify(body)});
    const data=await r.json();if(!r.ok)throw new Error(errors[data.error]??data.error??'요청을 완료하지 못했습니다.');return data;
  }
  async function connect(){setBusy(true);setError('');try{setState(await post('/api/connect',{}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function submit(e:React.FormEvent){
    e.preventDefault();if(submitting.current||pending)return;submitting.current=true;setBusy(true);setError('');
    const requestId=crypto.randomUUID();sessionStorage.setItem('aicc.pending',requestId);setPending(requestId);
    try{await post('/api/runs',{requestId,prompt});sessionStorage.removeItem('aicc.pending');setPending(null);setPrompt('');}
    catch(e){setError((e as Error).message);}
    finally{submitting.current=false;setBusy(false);}
  }
  async function interrupt(id:string){setBusy(true);setError('');try{await post('/api/runs/'+id+'/interrupt',{});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const active=state?.runs.find(r=>!terminal(r.execution));
  const latest=state?.runs.at(-1);
  return <div className="shell">
    <aside><div className="brand"><span className="brand-mark">CC</span><div>CONTROL CENTER<small>LOCAL DEVELOPMENT</small></div></div><div className="nav-label">WORKSPACE</div><div className="nav-item">◉ &nbsp; Codex 세션</div><div className="sidebar-note"><span className="pill">READ ONLY</span><p>안전한 테스트 저장소에서<br/>응답 흐름을 확인합니다.</p><small>기존 사용자 프로젝트는<br/>실행 대상으로 받지 않습니다.</small></div><footer>PHASE 1 <span>첫 번째 웹 슬라이스</span></footer></aside>
    <main><header><div><span className="eyebrow">LOCAL / CODEX</span><h1>세션 관제</h1><p>프롬프트부터 응답, 중단까지 한곳에서 확인하세요.</p></div><div className={'connection '+(online?'ok':'offline')}><i/>{online?'로컬 웹 연결됨':'로컬 서버 연결 끊김'}</div></header>
      {!online&&<div className="banner" role="status">서버 연결을 기다리고 있습니다. 다시 연결될 때 기록만 불러오며 프롬프트는 재전송하지 않습니다.</div>}
      {error&&<div className="banner error" role="alert">{error}</div>}
      <section className="status-grid"><div className="card"><label>PROVIDER</label><strong>{state?provider[state.provider]:'상태 확인 중'}</strong><small>기존 ChatGPT 로그인 사용</small></div><div className="card"><label>EXECUTION</label><strong>{latest?execution[latest.execution]:'실행 대기'}</strong><small>{state?.runs.length??0}회 실행 기록</small></div><div className="card"><label>VERIFICATION</label><strong>미검증</strong><small>응답 완료와 테스트 통과는 별개입니다.</small></div></section>
      <section className="session-bar"><div><b>읽기 전용 테스트 세션</b><small>{state?.workspace??'테스트 저장소 준비 중'} · {state?.threadId?'세션 '+state.threadId.slice(0,8):'세션 생성 전'}</small></div><button onClick={connect} disabled={!online||busy||state?.provider==='ready'}>{state?.provider==='connecting'?'연결 중…':state?.threadId?'세션 이어받기':'Codex 연결'}</button></section>
      {state?.issue&&<p className="hint">{errors[state.issue]??'연결이 종료됐습니다. 세션 이어받기로 다시 연결하세요.'}</p>}
      <section className="conversation" aria-label="대화 기록">{state?.runs.length?state.runs.map(r=><article className="run" key={r.id}><div className="run-heading"><span>RUN {state.runs.indexOf(r)+1}</span><time>{new Date(r.createdAt).toLocaleTimeString('ko-KR')}</time><span className={'run-state '+r.execution}>{execution[r.execution]}</span></div><div className="message user"><label>YOU</label><p>{r.prompt}</p></div><div className="message assistant"><label>CODEX</label><pre>{r.response||(!terminal(r.execution)?'응답을 기다리고 있습니다…':'표시할 응답이 없습니다.')}</pre></div><div className="verification">검증 상태: 미검증</div></article>):<div className="empty"><div className="empty-icon">⌘</div><h2>첫 응답을 시작하세요</h2><p>Codex를 연결한 다음 짧은 테스트 프롬프트를 보내세요.<br/>이 버전은 텍스트 응답과 세션 제어를 검증합니다.</p></div>}</section>
      <form className="composer" onSubmit={submit}><label htmlFor="prompt">프롬프트</label><textarea id="prompt" value={prompt} onChange={e=>setPrompt(e.target.value)} maxLength={4000} placeholder="예: 도구를 사용하지 말고, 이 테스트의 목적을 한 문장으로 설명해줘." disabled={!online||busy||!!active||state?.provider!=='ready'||!!pending}/><div className="composer-bottom"><small>인증정보를 입력하지 마세요. 대화는 이 컴퓨터에 보존됩니다.</small><div>{active&&<button type="button" className="stop" onClick={()=>interrupt(active.id)} disabled={!online||busy||active.execution==='starting'||active.execution==='interrupting'}>실행 중단</button>}<button type="submit" className="primary" disabled={!online||busy||!!active||state?.provider!=='ready'||!prompt.trim()||!!pending}>프롬프트 전송 ↗</button></div></div></form>
      {pending&&!busy&&<div className="banner">이전 전송 결과를 확인해야 합니다. 실행 기록을 확인한 뒤 새 메시지를 작성하세요. <button onClick={()=>{sessionStorage.removeItem('aicc.pending');setPending(null);}}>확인했고 새 입력 허용</button></div>}
      <details className="events"><summary>최근 작업 이벤트 <span>{state?.lastSeq??0}개 보존</span></summary>{events.length?events.map(e=><div key={e.seq}><code>#{e.seq}</code> {e.kind}<time>{new Date(e.at).toLocaleTimeString('ko-KR')}</time></div>):<p>현재 연결 이후 발생한 이벤트가 여기에 표시됩니다. 이전 실행 기록은 위 대화에 복원됩니다.</p>}</details>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
