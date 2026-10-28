import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// A TypeScript/React rendering check, explicitly not an esbuild bundle or browser interaction test.
test('dedicated Studio pages render only their editor, preserve safe preview and unavailable export',async()=>{
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,nextLoad){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx')){
      const source=ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
      return {format:'module',source,shortCircuit:true};
    }
    return nextLoad(url,context);
  }});
  try{
    const {StudioPage,MockProviders}=await import('../web/studios.tsx');
    const post=async()=>{throw new Error('SSR must not call APIs');};
    const html=renderToStaticMarkup(createElement(StudioPage,{projectId:'p',page:'planning',online:true,post}));
    assert.match(html,/Planning Studio/);assert.doesNotMatch(html,/Orbit Studios|Visualization Studio|모의 제공자 정책/,'Planning page must not mount unrelated studios');
    assert.match(html,/저장된 Task 초안/);
    const viz=renderToStaticMarkup(createElement(StudioPage,{projectId:'p',page:'visualization',online:true,post}));
    assert.match(viz,/Visualization Studio/);assert.doesNotMatch(viz,/Planning Studio|저장된 Task 초안|모의 제공자 정책/);
    assert.match(viz,/<svg/);assert.doesNotMatch(viz,/<script|foreignObject|<iframe/);
    assert.match(viz,/<button[^>]*disabled=""[^>]*>PPTX 내보내기/);
    assert.match(viz,/클래스 예제 불러오기/);assert.match(viz,/classDiagram/);assert.match(viz,/직접 작성한 클래스/);
    const empty=renderToStaticMarkup(createElement(StudioPage,{projectId:'',page:'planning',online:false,post}));
    assert.match(empty,/<fieldset[^>]*disabled/);assert.match(empty,/#\/projects/);assert.doesNotMatch(empty,/textarea/);
    const providers=renderToStaticMarkup(createElement(MockProviders,{connections:[{id:'bedrock',status:'mock_only',externalApiEnabled:false,coding:false}],post}));
    assert.match(providers,/mock_only/);assert.match(providers,/실제 모델 연결은 비활성화/);
    const {CapabilityDetails,CapabilityPanel}=await import('../web/capabilities.tsx');
    const {buildCapabilityRegistry}=await import('../server/capabilities.ts');
    const registry=renderToStaticMarkup(createElement(CapabilityDetails,{registry:buildCapabilityRegistry('ready',null)}));
    assert.match(registry,/Claude Code/);assert.match(registry,/Orbit 어댑터 미연결/);assert.match(registry,/현재 정책에서 비활성/);
    assert.match(registry,/비용·잔여량·초기화 시각: unknown/);assert.match(registry,/제품 검증 미실행/);
    assert.doesNotMatch(registry,/<button|<input/,'registry metadata cannot change permissions or install extensions');
    const noConnection=renderToStaticMarkup(createElement(CapabilityPanel,{online:false,post}));
    assert.match(noConnection,/<button[^>]*disabled=""[^>]*>로컬 CLI 버전 확인/);
    const {ExecutionModes}=await import('../web/execution-modes.tsx');
    const modes=renderToStaticMarkup(createElement(ExecutionModes));
    for(const name of ['Solo','Cross Review','Debate','Race','Cooperate','Goal'])assert.ok(modes.includes(name));
    assert.match(modes,/나머지 모드 미연결/);assert.match(modes,/독립 worktree/);assert.match(modes,/비교 불가/);
    assert.doesNotMatch(modes,/<button|<select/,'unconnected executors must not be offered as launch actions');
    const {Navigation}=await import('../web/shell.tsx');
    const {pages}=await import('../web/navigation.ts');
    // Contract change (2026-10-28, first-flow acceptance 2): simple mode shows only the new-task pages plus the
    // current page; the original all-14 contract below still holds once 고급 메뉴 is on.
    const {simpleMenu,advancedMenuKey}=await import('../web/shell.tsx');
    const storage=new Map<string,string>(),previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
    for(const page of pages){
      const simple=renderToStaticMarkup(createElement(Navigation,{page:page.id,open:false,onNavigate:()=>{},onClose:()=>{}}));
      assert.equal((simple.match(/class="nav-item /g)??[]).length,simpleMenu.length+(simpleMenu.includes(page.id)?0:1));
      assert.match(simple,new RegExp(`href="#/${page.id}"[^>]*aria-current="page"`));
      assert.match(simple,/고급 모드로 전환/);
    }
    storage.set(advancedMenuKey,'1');
    for(const page of pages){
      const nav=renderToStaticMarkup(createElement(Navigation,{page:page.id,open:false,onNavigate:()=>{},onClose:()=>{}}));
      assert.equal((nav.match(/aria-current="page"/g)??[]).length,1);
      assert.match(nav,new RegExp(`href="#/${page.id}"[^>]*aria-current="page"`));
      assert.equal((nav.match(/class="nav-item /g)??[]).length,pages.length);
      assert.ok(nav.indexOf('title="Automation"')<nav.indexOf('aria-label="관리 메뉴"'));
      assert.ok(nav.indexOf('aria-label="관리 메뉴"')<nav.indexOf('title="Model Providers"'));
    }
    if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;
    const {WorkspacePanel}=await import('../web/workspaces.tsx');
    const state={provider:'ready' as const,issue:null,threadId:'t',workspace:'A-workspace',readOnly:false,lastSeq:0,runs:[],selectedWorkspaceId:'wa',projects:[{id:'a',name:'A',kind:'code' as const,path:'A-path',writeEnabled:true,createdAt:''},{id:'b',name:'B',kind:'code' as const,path:'B-path',writeEnabled:false,createdAt:''}],workspaces:[{id:'wa',projectId:'a',path:'A-workspace',branch:'a-branch',status:'ready' as const,baseSha:'sha',createdAt:''},{id:'wb',projectId:'b',path:'B-workspace',branch:'b-branch',status:'ready' as const,baseSha:'sha',createdAt:''}]};
    const workspace=renderToStaticMarkup(createElement(WorkspacePanel,{state,projectId:'b',onProject:()=>{},locked:false,action:async()=>{},post}));
    assert.match(workspace,/b-branch/);assert.doesNotMatch(workspace,/a-branch|A-path/);assert.match(workspace,/<option value="" disabled="" selected=""/);
    const {AgentCenter}=await import('../web/agent-center.tsx');
    const agentProps={state,online:true,busy:false,matches:false,prompt:'draft',pending:null,setPrompt:()=>{},connect:async()=>{},submit:async()=>{},interrupt:async()=>{},clearPending:()=>{},onProjects:()=>{},onActiveSession:()=>{},issueMessage:''};
    const mismatched=renderToStaticMarkup(createElement(AgentCenter,agentProps));
    assert.doesNotMatch(mismatched,/textarea|Codex 연결|프롬프트 전송/);assert.match(mismatched,/작업 공간을 선택/);
    const disconnected=renderToStaticMarkup(createElement(AgentCenter,{...agentProps,matches:true,online:false}));
    assert.match(disconnected,/<textarea[^>]*disabled=""/);assert.match(disconnected,/<button[^>]*disabled=""[^>]*>프롬프트 전송/);
    const foreignActive=renderToStaticMarkup(createElement(AgentCenter,{...agentProps,state:{...state,runs:[{workspaceId:'wa',id:'r',requestId:'q',turnId:'t',prompt:'fixture',response:'',execution:'running',verification:'not_run',createdAt:'',updatedAt:''}]}}));
    assert.match(foreignActive,/현재 실행으로 이동/,'an active run in another context must offer a recovery path');
    const {UnavailablePage,Dashboard,Development,PrivacySecurity}=await import('../web/pages.tsx');
    for(const page of ['automation','extensions','usage','settings'] as const){const unavailable=renderToStaticMarkup(createElement(UnavailablePage,{page}));assert.match(unavailable,/준비 중/);assert.doesNotMatch(unavailable,/<button|<input|<select/);}
    const dashboard=renderToStaticMarkup(createElement(Dashboard,{state,projectId:'b',onNavigate:()=>{}}));
    assert.match(dashboard,/실행 작업 공간 선택 필요/);assert.doesNotMatch(dashboard,/검증 성공|테스트 통과/);
    const development=renderToStaticMarkup(createElement(Development,{state,projectId:'b',onProjects:()=>{}}));
    assert.match(development,/b-branch/);assert.doesNotMatch(development,/a-branch|Git Diff 새로고침|A-workspace/);
    const security=renderToStaticMarkup(createElement(PrivacySecurity,{state}));assert.match(security,/mock-only/);assert.match(security,/포괄적인 개인정보 탐지 기능은 아닙니다/);
  }finally{hooks.deregister();}
});
