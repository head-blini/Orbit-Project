import { useEffect,useRef,useState,type ReactNode } from 'react';
import type { Snapshot } from '../shared/types.ts';
import { pages,providerLabels,type PageId } from './navigation.ts';

export function Icon({name}:{name:string}) {
  const paths:Record<string,string>={dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',folder:'M3 7V5h6l2 2h10v13H3z',plan:'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',agent:'M7 8h10a3 3 0 0 1 3 3v7H4v-7a3 3 0 0 1 3-3z M12 4v4 M8 12v2 M16 12v2 M9 18v3 M15 18v3',code:'m8 6-6 6 6 6 m8-12 6 6-6 6 m-3-15-2 18',diagram:'M9 3h6v5H9z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4',bolt:'m13 2-9 12h7l-1 8 10-13h-7z',provider:'M12 3 3 8l9 5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',extension:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 17h7 M17.5 14v7',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-5',chart:'M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',menu:'M4 6h16 M4 12h16 M4 18h16',close:'m6 6 12 12 M18 6 6 18'};
  return <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]??paths.folder}/></svg>;
}
export const advancedMenuKey='orbit.nav.advanced';
export const simpleMenu:readonly PageId[]=['start','progress','projects','planning'];
export function Navigation({page,open,onNavigate,onClose}:{page:PageId;open:boolean;onNavigate:(page:PageId)=>void;onClose:()=>void}) {
  // Simple mode shows only what a new task needs. Every page stays reachable via 고급 메뉴 or its URL.
  const [advanced,setAdvanced]=useState(()=>{try{return localStorage.getItem(advancedMenuKey)==='1';}catch{return false;}});
  function toggle(){const next=!advanced;setAdvanced(next);try{localStorage.setItem(advancedMenuKey,next?'1':'0');}catch{/* In-memory only. */}}
  const visible=(id:PageId)=>advanced||simpleMenu.includes(id)||id===page;
  const nav=(group:string)=><nav aria-label={group==='main'?'주 메뉴':'관리 메뉴'}>{pages.filter(item=>item.group===group&&visible(item.id)).map(item=><a key={item.id} href={'#/'+item.id} className={'nav-item '+(page===item.id?'selected':'')} aria-current={page===item.id?'page':undefined} title={item.name} onClick={()=>{onNavigate(item.id);onClose();}}><Icon name={item.icon}/><span>{item.label}</span></a>)}</nav>;
  return <><button className={'nav-backdrop '+(open?'visible':'')} aria-label="메뉴 닫기" onClick={onClose} tabIndex={open?0:-1}/><aside className={'sidebar '+(open?'is-open':'')} id="orbit-navigation" onKeyDown={event=>{if(event.key==='Escape')onClose();}}>
    <a className="brand" href="#/start" onClick={()=>{onNavigate('start');onClose();}}><span className="brand-mark">O</span><div>Orbit<small>AI WORKSPACE</small></div></a>
    <div className="nav-label">작업 공간</div>{nav('main')}{(advanced||pages.some(item=>item.group==='manage'&&item.id===page))&&<div className="management-nav"><div className="nav-label">관리</div>{nav('manage')}</div>}
    <button className="nav-advanced" aria-expanded={advanced} onClick={toggle}>{advanced?'고급 메뉴 숨기기':'고급 메뉴 보기'}</button>
    <footer><span className="local-dot"/> 로컬 작업 플랫폼 <small>실행 완료 ≠ 검증 완료</small></footer>
  </aside></>;
}
export function TopBar({state,online,projectId,locked,onProject,onMenu,onCommand,onSettings}:{state:Snapshot|null;online:boolean;projectId:string;locked:boolean;onProject:(id:string)=>void;onMenu:()=>void;onCommand:()=>void;onSettings:()=>void}) {
  return <div className="topbar"><button className="menu-toggle icon-button" aria-label="메뉴 열기" aria-controls="orbit-navigation" onClick={onMenu}><Icon name="menu"/></button>
    <label className="project-switcher"><Icon name="folder"/><span className="sr-only">현재 프로젝트</span><select aria-label="현재 프로젝트" value={projectId} disabled={!online||locked} onChange={event=>onProject(event.target.value)}>{!state?.selectedWorkspaceId&&<option value="">{state?'읽기 전용 테스트 세션':'프로젝트 불러오는 중'}</option>}{state?.projects?.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <div className={'connection '+(online&&state?.provider==='ready'?'ok':'offline')} role="status"><i/>{!online?'로컬 서버 연결 끊김':state?'Codex '+providerLabels[state.provider]:'상태 확인 중'}</div>
    <button className="command-trigger" onClick={onCommand}><Icon name="agent"/>AI 명령</button><button className="icon-button" aria-label="설정 열기" onClick={onSettings}><Icon name="settings"/></button>
  </div>;
}
export function CommandPanel({onClose,children}:{onClose:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const element=dialog.current;const previous=document.activeElement as HTMLElement|null;element?.showModal();return()=>{element?.close();previous?.focus();};},[]);
  return <dialog className="command-panel" ref={dialog} aria-labelledby="command-title" onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><div className="command-inner"><div className="section-heading"><div><span className="eyebrow">AGENT CENTER</span><h2 id="command-title">AI 명령</h2></div><button className="icon-button" aria-label="AI 명령 패널 닫기" onClick={onClose}><Icon name="close"/></button></div>{children}</div></dialog>;
}
