import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {FailureFamilyView,FailureIndexView} from '../shared/failure-intelligence.ts';

async function load(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/failure-index.tsx');}finally{hooks.deregister();}
}
const family=(over:Partial<FailureFamilyView>):FailureFamilyView=>({familyId:'f'.repeat(64),category:'output_rejected' as const,code:'QUALITY_EVIDENCE_INVALID',source:'quality' as const,commandIdOrGate:null,runtime:'codex',taskId:null,bindingDigest:'a'.repeat(64),
  realCount:2,mockCount:0,unknownCount:0,lastSeen:'2026-10-29T01:02:03.000Z',failureIds:['quality:loop:l1'],realFailureIds:['quality:loop:l1'],...over});
const view:FailureIndexView={projectId:'p',families:[family({}),family({familyId:'e'.repeat(64),code:'RUNTIME_ERROR',category:'unknown',realCount:0,mockCount:3,realFailureIds:[]})],
  hypotheses:[{kind:'hypothesis',statement:'Repeated output rejection may indicate X; cause is unverified.',confidence:'rule',evidence:['a','b'],counterEvidence:[]}],
  cases:[{id:'c1',familyId:'f'.repeat(64),failureId:'quality:loop:l1',createdAt:'2026-10-29T01:02:03.000Z',sourceTable:'quality_loops'}]};

test('simple mode shows plain summary only; mock/unknown never counted as real; no codes or hypotheses',async()=>{
  const {FailureIndexBody}=await load();
  const html=renderToStaticMarkup(createElement(FailureIndexBody,{view,advanced:false}));
  assert.match(html,/반복되는 문제/);assert.match(html,/2번 반복/);assert.match(html,/실제 증거로 세지 않았습니다/);
  assert.ok(!html.includes('QUALITY_EVIDENCE_INVALID')&&!html.includes('가설')&&!html.includes('model_mistake')&&!html.includes('button'));
});

test('advanced mode separates mock/unknown, labels hypotheses, offers case actions only for real families',async()=>{
  const {FailureIndexBody}=await load();
  const html=renderToStaticMarkup(createElement(FailureIndexBody,{view,advanced:true,onCreate:()=>{},onDelete:()=>{}}));
  assert.match(html,/QUALITY_EVIDENCE_INVALID/);assert.match(html,/참고용 \(모의·출처 미확인 — 실제 증거 아님\)/);assert.match(html,/모의 3회/);
  assert.match(html,/가설 \(규칙 기반, 미검증\)/);assert.match(html,/반증 자료 없음/);assert.equal(html.split('재현 사례 만들기').length-1,1);
  assert.ok(html.indexOf('실제 실패 묶음')<html.indexOf('참고용')&&!html.includes('model_mistake'));
  const confirming=renderToStaticMarkup(createElement(FailureIndexBody,{view,advanced:true,onCreate:()=>{},confirming:'quality:loop:l1'}));
  assert.match(confirming,/확인하고 저장/);
});
