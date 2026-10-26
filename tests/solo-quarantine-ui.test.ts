import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {Snapshot} from '../shared/types.ts';

test('Solo recovery is disclosed and reconnect/submit remain disabled even with a ready provider',async()=>{
  const hooks=registerHooks({load(url,context,next){
    if(url.endsWith('/web/agent-center.tsx')||url.endsWith('/web/solo-operation.tsx'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};
    return next(url,context);
  }});
  try{
    const {AgentCenter}=await import('../web/agent-center.tsx');
    for(const provider of ['disconnected','ready'] as const){
      const state:Snapshot={provider,issue:null,threadId:'old-thread',workspace:'fixture',readOnly:true,runs:[],lastSeq:0,soloRecoveryRequired:true};
      const html=renderToStaticMarkup(createElement(AgentCenter,{state,online:true,busy:false,matches:true,prompt:'New work',pending:null,setPrompt:()=>{},connect:async()=>{},submit:async()=>{},interrupt:async()=>{},clearPending:()=>{},onProjects:()=>{},onActiveSession:()=>{},issueMessage:''}));
      assert.match(html,/종료를 확인하지 못한 실행/);assert.match(html,/자동 해제/);
      assert.match(html,/<button[^>]*disabled[^>]*>세션 이어받기/);assert.match(html,/<button[^>]*disabled[^>]*>프롬프트 전송/);
    }
  }finally{hooks.deregister();}
});
