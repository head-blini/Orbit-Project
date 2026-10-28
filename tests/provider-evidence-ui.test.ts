import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {CapabilityExecutionRecord} from '../shared/capability-execution.ts';
async function view(module='capability-execution'){
 const hooks=registerHooks({load(url,context,next){if(url.startsWith(new URL('../web/',import.meta.url).href)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});
 try{return await import(`../web/${module}.tsx`);}finally{hooks.deregister();}
}
const record={id:'execution',projectId:'p',taskId:'t',routeId:'route',runtimeId:'claude-code',updatedAt:'2026-10-28',status:'quality_passed',issue:null,runId:'run',quality:null,qualityLoopId:null,recoveryRequired:false,planDigest:'plan-digest',baseline:{planningVersionId:'plan',planningContentHash:'hash'},adapter:{version:'1.0',revision:1},models:{selectedModelId:'selected',requestedModelId:'requested',serverModelId:'configured',actualModelId:'unknown',source:'unknown'}} as CapabilityExecutionRecord;
const evidence={source:'mock' as const,interface:'claude.print' as const,executionObserved:true,responseDigest:'response-evidence',quality:'passed' as const,livePipelineVerified:false,costUsd:null,remainingQuota:null};
test('mock quality success is labelled as mock in both modes, never live verification',async()=>{
 const {CapabilityExecutionEvidence}=await view();
 for(const advanced of [false,true]){
  const html=renderToStaticMarkup(createElement(CapabilityExecutionEvidence,{record:{...record,providerEvidence:evidence},advanced}));
  assert.match(html,/모의 품질 검증 통과/);assert.match(html,/Mock · 모의 검증/);assert.match(html,/모의 실행 관측: 확인/);assert.match(html,/실 Provider 전체 흐름: 검증 대기/);
  assert.match(html,/실제 비용 \(USD\): unknown · 잔여 사용량: unknown/);assert.doesNotMatch(html,/실 Provider 전체 흐름: 검증됨/);
  if(advanced)assert.match(html,/response-evidence/);else assert.doesNotMatch(html,/response-evidence/);
 }
});
test('native execution observation does not imply a verified live pipeline or model identity',async()=>{
 const {CapabilityExecutionEvidence}=await view();
 const html=renderToStaticMarkup(createElement(CapabilityExecutionEvidence,{record:{...record,providerEvidence:{...evidence,source:'native'}},advanced:false}));
 assert.match(html,/실제 네이티브 Provider/);assert.match(html,/실제 실행 관측: 확인/);assert.match(html,/실 Provider 전체 흐름: 검증 대기/);assert.match(html,/실제 실행 모델: unknown/);
});
test('unknown and legacy records never promote quality success into live success',async()=>{
 const {ProviderEvidence}=await view();
 for(const providerEvidence of [undefined,{...evidence,source:'unknown' as const,livePipelineVerified:true},{...evidence,livePipelineVerified:true}]){
  const html=renderToStaticMarkup(createElement(ProviderEvidence,{record:{...record,providerEvidence},advanced:true}));
  assert.match(html,/실 Provider 전체 흐름: 검증 대기/);assert.doesNotMatch(html,/실 Provider 전체 흐름: 검증됨/);
 }
 const native=renderToStaticMarkup(createElement(ProviderEvidence,{record:{...record,providerEvidence:{...evidence,source:'native',livePipelineVerified:true}},advanced:true}));
 assert.match(native,/실 Provider 전체 흐름: 검증됨/);assert.match(native,/실제 비용 \(USD\): unknown/);assert.match(native,/잔여 사용량: unknown/);
});


test('readiness separates install authentication connection from live execution and billing',async()=>{
 const {NativeReadinessDetails,NativeReadinessPanel}=await view('native-readiness');
 const report={codex:{installation:{status:'found',version:'0.162.1'},authentication:'unknown',connection:'disconnected'},claude:{installation:{status:'found',version:'2.1.119'},authentication:{checkedAt:'2026-10-28',authentication:'subscription',source:'claude.auth.status',issue:null}},actualModel:'unknown',liveValidation:'approval_required',costUsd:null,remainingQuota:null};
 const html=renderToStaticMarkup(createElement(NativeReadinessDetails,{report}));
 assert.match(html,/설치 버전 확인/);assert.match(html,/인증: unknown/);assert.match(html,/구독 인증 확인/);assert.match(html,/실제 실행 모델: unknown/);assert.match(html,/별도 실행 승인 필요/);assert.match(html,/실제 비용 \(USD\): unknown · 잔여 사용량: unknown/);
 const panel=renderToStaticMarkup(createElement(NativeReadinessPanel,{online:false,post:async()=>{throw Error('render must not POST');}}));
 assert.match(panel,/<button disabled="">설치·인증 상태 확인/);assert.match(panel,/저장된 준비 상태: unknown/);assert.match(panel,/모델 작업을 실행하거나 로그인 정보를 표시하지 않습니다/);
});
