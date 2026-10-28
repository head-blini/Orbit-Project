import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

async function view(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/ai-preferences.tsx');}finally{hooks.deregister();}
}
test('only runnable runtimes are selectable, matching the server rules',async()=>{
  const {runtimeOptions}=await view();
  const available=(kind:'code'|'general',stage:'planning'|'execution')=>runtimeOptions(kind,stage).filter(o=>o.available).map(o=>o.runtime);
  assert.deepEqual(available('general','planning'),['claude-code']);assert.deepEqual(available('general','execution'),['claude-code']);
  assert.deepEqual(available('code','planning'),['codex','claude-code']);assert.deepEqual(available('code','execution'),['codex']);
});
test('the view shows disabled options with a reason and saves only when changed',async()=>{
  const {AiPreferencesView}=await view();
  const value={planning:'claude-code' as const,execution:'claude-code' as const,revision:0,updatedAt:null};
  const html=renderToStaticMarkup(createElement(AiPreferencesView,{kind:'general',value,draft:value,busy:false,onChange:()=>{},onSave:()=>{}}));
  assert.match(html,/<option value="codex" disabled="">Codex \(Git 작업 공간이 필요합니다\)<\/option>/);
  assert.match(html,/<button class="primary" disabled="">선택 저장<\/button>/);assert.match(html,/기본값/);
  assert.match(html,/승인된 기준·결정 이유는 그대로 유지/);
  const code={planning:'codex' as const,execution:'codex' as const,revision:2,updatedAt:'2026-10-28T00:00:00.000Z'};
  const changed=renderToStaticMarkup(createElement(AiPreferencesView,{kind:'code',value:code,draft:{...code,planning:'claude-code'},busy:false,onChange:()=>{},onSave:()=>{}}));
  assert.match(changed,/<button class="primary">선택 저장<\/button>/);assert.match(changed,/r2/);
  assert.match(changed,/Claude Code \(코드 프로젝트 실행 연결 전\)/);
});
