import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

test('the production planning page embeds optional native suggestions while preserving manual and offline controls',async()=>{
  const root=new URL('../web/',import.meta.url).href,hooks=registerHooks({load(url,context,next){
    if(url.startsWith(root)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{
    const {StudioPage}=await import('../web/studios.tsx');const html=renderToStaticMarkup(createElement(StudioPage,{projectId:'project-a',page:'planning',online:false,post:async()=>{throw new Error('SSR_MUST_NOT_POST');}}));
    assert.match(html,/Codex 기획 제안/);assert.match(html,/기획안 편집기/);assert.match(html,/수동 기획 작성은 계속/);assert.match(html,/<fieldset[^>]*disabled/);assert.match(html,/기획 요청 미리보기/);
  }finally{hooks.deregister();}
});
