import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {ReviewPreview,ReviewRecord,ReviewView} from '../shared/reviews.ts';
async function components(){
  const target=new URL('../web/reviews.tsx',import.meta.url).href;assert.ok(existsSync(new URL(target)),'Native Review UI is not implemented');
  const hooks=registerHooks({load(url,context,nextLoad){if(url===target)return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return nextLoad(url,context);}});
  try{return await import('../web/reviews.tsx');}finally{hooks.deregister();}
}
const preview:ReviewPreview={projectId:'project-a',workspaceId:'workspace-a',runId:'run-a',baseSha:'a'.repeat(40),sourceDigest:'b'.repeat(64),inputDigest:'c'.repeat(64),previewDigest:'d'.repeat(64),instructions:'Exact review instructions\n<script>untrusted diff</script>',files:[{path:'src/한글.ts',status:'modified',bytes:17}],patchBytes:17,timeoutMs:60000,turnLimit:1,scope:'Read-only text review'};
const view:ReviewView={workspaceId:preview.workspaceId,runId:preview.runId,records:[],sourceDigest:preview.sourceDigest,sourceIssue:null,busy:false,recoveryRequired:false,timeoutMs:60000,turnLimit:1,scope:preview.scope};
const record=(execution:ReviewRecord['execution']='completed'):ReviewRecord=>({id:'review-a',requestId:'receipt-a',projectId:'project-a',workspaceId:preview.workspaceId,runId:preview.runId,baseSha:preview.baseSha,sourceDigest:preview.sourceDigest,finishedDigest:preview.sourceDigest,inputDigest:preview.inputDigest,previewDigest:preview.previewDigest,files:preview.files,execution,response:'<script>provider output</script>',issue:null,threadId:null,turnId:null,processStopped:true,recoveredAt:null,createdAt:'2026-10-26T00:00:00Z',finishedAt:null,durationMs:12,timeoutMs:60000,turnLimit:1});

test('native review production epoch rejects old GET/POST, double clicks and disposed workspace/run responses',async()=>{
  const {createReviewRequestEpoch,acknowledgeReviewRead}=await components(),order=createReviewRequestEpoch();assert.equal(order.read(),null);order.reset();const read=order.read()!,post=order.beginAction()!;
  assert.equal(order.isCurrent(read),false);assert.equal(order.beginAction(),null);assert.equal(order.read(),null);assert.equal(order.endAction(post),true);const next=order.read()!;assert.equal(order.isCurrent(post),false);assert.equal(order.isCurrent(next),true);
  const old=order.beginAction()!;order.dispose();order.reset();assert.equal(order.isCurrent(old),false);assert.equal(order.endAction(old),false);
  assert.equal(acknowledgeReviewRead('manual',true),true);for(const [mode,ok] of [['manual',false],['poll',true],['after-action',true]] as const)assert.equal(acknowledgeReviewRead(mode,ok),false);
});

test('review preview and start require exact current source, selection, instructions and explicit fresh consent',async()=>{
  const {reviewPreviewMatches,sameReviewPreview,reviewAvailability}=await components(),scope={workspaceId:preview.workspaceId,runId:preview.runId},ready={online:true,busy:false,loading:false,fresh:true,uncertain:false,confirmed:true};
  assert.equal(reviewPreviewMatches(preview,view,scope),true);assert.equal(sameReviewPreview(preview,{...preview}),true);assert.deepEqual(reviewAvailability(view,preview,scope,ready),{preview:true,start:true});
  for(const patch of [{workspaceId:'foreign'},{runId:'other'},{sourceDigest:'e'.repeat(64)},{timeoutMs:120000},{turnLimit:2}])assert.equal(reviewPreviewMatches({...preview,...patch} as ReviewPreview,view,scope),false);
  for(const patch of [{instructions:'changed'},{inputDigest:'e'.repeat(64)},{previewDigest:'e'.repeat(64)},{files:[]}])assert.equal(sameReviewPreview(preview,{...preview,...patch}),false);
  for(const patch of [{sourceDigest:null},{sourceIssue:'SOURCE_UNKNOWN'},{recoveryRequired:true},{busy:true}])assert.equal(reviewAvailability({...view,...patch},preview,scope,ready).start,false);
  for(const patch of [{online:false},{busy:true},{loading:true},{fresh:false},{uncertain:true},{confirmed:false}])assert.equal(reviewAvailability(view,preview,scope,{...ready,...patch}).start,false);
  assert.equal(reviewAvailability(view,null,scope,ready).start,false);
});

test('review SSR is inert, previews exact escaped instructions and requires a separate consent without prompt editing',async()=>{
  const {ReviewPanel,ReviewExecutionPreview}=await components();const empty=renderToStaticMarkup(createElement(ReviewPanel,{workspaceId:'workspace-a',runId:null,online:false,busy:false,post:async()=>{throw Error('SSR must not POST');}}));
  for(const pattern of [/기존 ChatGPT 구독/,/Model Hub.*별도/,/native CLI.*보존/,/유료 API.*전환하지/,/테스트.*승인.*병합/,/자동.*연결/])assert.match(empty,pattern);
  const html=renderToStaticMarkup(createElement(ReviewExecutionPreview,{preview,confirmed:false,canStart:false,onConsent:()=>{},onStart:()=>{}}));
  for(const value of ['Exact review instructions','&lt;script&gt;untrusted diff&lt;/script&gt;','src/한글.ts',preview.sourceDigest,preview.previewDigest,'60000'])assert.ok(html.includes(value),value);
  assert.match(html,/1.*turn/);assert.match(html,/<button[^>]*disabled[^>]*>동의한 Native Review 시작/);assert.doesNotMatch(html,/<textarea|type="password"|<script>/);
});

test('review history preserves workspace-wide recovery, escapes output and never upgrades completion into verification',async()=>{
  const {ReviewHistory,reviewRecoveryKey}=await components(),running={...record('running'),id:'running',processStopped:false},lost={...record('lost'),id:'lost',runId:'old-run',processStopped:false},completed=record();
  const key=reviewRecoveryKey(lost,'workspace-a');assert.ok(key);assert.equal(reviewRecoveryKey(lost,'foreign'),null);assert.equal(reviewRecoveryKey(running,'workspace-a'),null);assert.equal(reviewRecoveryKey(completed,'workspace-a'),null);assert.notEqual(reviewRecoveryKey({...lost,execution:'failed'},'workspace-a'),key);
  const props={workspaceId:'workspace-a',records:[running,lost,completed,{...record(),id:'foreign',workspaceId:'foreign',response:'OTHER_WORKSPACE_PRIVATE'}],sourceDigest:preview.sourceDigest,online:true,actionBusy:false,otherBusy:true,fresh:true,uncertain:false,recoveryConsent:null,onInterrupt:()=>{},onRecover:()=>{},onRecoveryConsent:()=>{}};
  const html=renderToStaticMarkup(createElement(ReviewHistory,props));assert.match(html,/&lt;script&gt;provider output&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>|OTHER_WORKSPACE_PRIVATE/);assert.match(html,/리뷰 완료/);assert.match(html,/검증.*승인.*병합.*아닙니다/);assert.match(html,/재시작·결과 미확인/);assert.match(html,/old-run/);assert.match(html,/<button(?![^>]*disabled)[^>]*>Native Review 중단/);assert.match(html,/<button[^>]*disabled[^>]*>종료 확인 후 리뷰 복구/);
  const recovery=renderToStaticMarkup(createElement(ReviewHistory,{...props,otherBusy:false,recoveryConsent:key}));assert.match(recovery,/<button(?![^>]*disabled)[^>]*>종료 확인 후 리뷰 복구/);
  const stale=renderToStaticMarkup(createElement(ReviewHistory,{...props,records:[completed],sourceDigest:'e'.repeat(64)}));assert.match(stale,/현재 소스와 다름/);
});
