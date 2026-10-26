import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {ModelHubView,ModelHubRequest} from '../shared/model-hub.ts';

const view=():ModelHubView=>({providers:[...(['openai-compatible','litellm','vllm','freellmapi','local'] as const).map(id=>({id,implementation:'http_json_sse' as const})),
  {id:'bedrock',implementation:'not_implemented'},{id:'future',implementation:'extension_point'}],destinations:[],requests:[],activeRequestId:null,billing:'separate_from_native_subscription',costSource:'unknown'});
const row=(projectId:string,id='request-a'):ModelHubRequest=>({id,requestId:'receipt-a',projectId,destinationId:'local-fixture',providerId:'local',model:'fixture-model',configDigest:'a'.repeat(64),execution:'running',
  response:'<script>untrusted response</script>',issue:null,usage:{promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'},costUsd:null,createdAt:'2026-10-26T00:00:00.000Z',finishedAt:null,durationMs:null,timeoutMs:30000,maxOutputTokens:1024});
async function components(){
  const target=new URL('../web/model-hub.tsx',import.meta.url).href;
  const hooks=registerHooks({load(url,context,nextLoad){if(url===target){return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};}return nextLoad(url,context);}});
  try{return await import('../web/model-hub.tsx');}finally{hooks.deregister();}
}

test('a POST supersedes an initial or polling GET and disposed project scopes reject every old response',async()=>{
  const {createModelHubRequestEpoch}=await components(),order=createModelHubRequestEpoch();order.reset();
  const get=order.next(),post=order.next();assert.equal(order.isCurrent(get),false);assert.equal(order.isCurrent(post),true);assert.equal(order.sameScope(get),true);
  order.dispose();assert.equal(order.isCurrent(post),false);assert.equal(order.sameScope(post),false);
  order.reset();const current=order.next();assert.equal(order.isCurrent(post),false);assert.equal(order.isCurrent(current),true);
});

test('Model Hub overview describes all seven implementation states and empty configuration without key or endpoint forms',async()=>{
  const {ModelHubOverview,ModelHubPanel}=await components();
  const html=renderToStaticMarkup(createElement(ModelHubOverview,{view:view(),projectId:'project-a'}));
  for(const name of ['OpenAI-compatible','LiteLLM','vLLM','FreeLLMAPI','Local','Bedrock','향후 확장'])assert.ok(html.includes(name),name);
  assert.match(html,/조건부/);assert.match(html,/Bedrock.*미구현/);assert.match(html,/설정된 목적지가 없습니다/);assert.match(html,/구독.*별도/);assert.match(html,/API 비용.*unknown/);
  assert.doesNotMatch(html,/<input|<textarea|password/);
  const empty=renderToStaticMarkup(createElement(ModelHubPanel,{projectId:'',online:false,nativeBusy:false,post:async()=>{throw new Error('SSR must not send');}}));
  assert.match(empty,/프로젝트를 선택/);assert.doesNotMatch(empty,/type="password"|name="endpoint"/);
});

test('Model Hub history escapes provider output, keeps usage unknown, separates verification, and offers current-project interruption',async()=>{
  const {ModelHubRequestHistory}=await components();
  const html=renderToStaticMarkup(createElement(ModelHubRequestHistory,{requests:[row('project-a'),{...row('project-b','foreign-request'),response:'FOREIGN_PROJECT_PRIVATE'}],projectId:'project-a',online:true,stoppingId:null,onInterrupt:()=>{}}));
  assert.match(html,/&lt;script&gt;untrusted response&lt;\/script&gt;/);assert.doesNotMatch(html,/<script|FOREIGN_PROJECT_PRIVATE/);
  assert.match(html,/unknown/);assert.match(html,/검증/);assert.match(html,/1024/);assert.match(html,/요청 중단/);
  assert.match(html,/<button(?![^>]*disabled)[^>]*>요청 중단/);
});

test('Bedrock CLI support and destination disclosure keep service, billing and temporary input limits explicit',async()=>{
  const {ModelHubOverview,BedrockDestinationDisclosure}=await components(),configured=view();configured.providers[5]={id:'bedrock',implementation:'aws_cli_converse'};
  const overview=renderToStaticMarkup(createElement(ModelHubOverview,{view:configured,projectId:'project-a'}));
  assert.match(overview,/공식 AWS CLI Converse/);assert.match(overview,/비스트리밍/);assert.match(overview,/CLI\/인증\/모델 접근 진단 필요/);assert.doesNotMatch(overview,/Bedrock<\/b><span>향후 확장/);
  const disclosure=renderToStaticMarkup(createElement(BedrockDestinationDisclosure));
  for(const pattern of [/서버.*비활성/,/별도.*API.*과금/,/unknown/,/토큰.*시간.*요금 상한.*아닙니다/,/중단.*timeout.*원격.*완료.*과금.*미확인/,/cross-region.*profile.*미지원/,/동의.*임시 파일/,/argv.*DB.*events/,/비정상 종료.*남을 수/])assert.match(disclosure,pattern);
  assert.doesNotMatch(disclosure,/원문 자동 저장 없음|<input|password/);
});

test('Bedrock temporary input cleanup requires a terminal current-project record and fresh stopped attestation',async()=>{
  const {ModelHubRequestHistory,modelInputCleanupKey}=await components();
  const request:ModelHubRequest={...row('project-a','bedrock-request'),providerId:'bedrock',execution:'lost',temporaryInput:'possible'};
  const key=modelInputCleanupKey(request,'project-a');assert.equal(typeof key,'string');assert.ok(key);
  for(const changed of [{...request,execution:'running' as const},{...request,providerId:'local' as const},{...request,temporaryInput:'removed' as const},{...request,temporaryInput:'none' as const}])assert.equal(modelInputCleanupKey(changed,'project-a'),null);
  assert.equal(modelInputCleanupKey(request,'project-b'),null);assert.notEqual(modelInputCleanupKey({...request,configDigest:'b'.repeat(64)},'project-a'),key);assert.notEqual(modelInputCleanupKey({...request,temporaryInput:'cleanup_required'},'project-a'),key);
  const props={requests:[request,{...request,id:'foreign-request',projectId:'project-b',response:'FOREIGN_TEMP'}],projectId:'project-a',online:true,stoppingId:null,onInterrupt:()=>{},onConfirmCleanup:()=>{},onCleanup:()=>{}};
  const locked=renderToStaticMarkup(createElement(ModelHubRequestHistory,props));assert.match(locked,/임시 입력.*존재 가능/);assert.match(locked,/이전 AWS CLI 프로세스가 종료되었음을 확인/);assert.match(locked,/<button[^>]*disabled[^>]*>임시 입력 파일 정리/);assert.doesNotMatch(locked,/FOREIGN_TEMP/);
  const approved=renderToStaticMarkup(createElement(ModelHubRequestHistory,{...props,cleanupConsentKey:key}));assert.match(approved,/<button(?![^>]*disabled)[^>]*>임시 입력 파일 정리/);
  for(const extra of [{online:false},{cleaningId:request.id},{cleanupBlocked:true},{cleanupConsentKey:'stale-key'}])assert.match(renderToStaticMarkup(createElement(ModelHubRequestHistory,{...props,cleanupConsentKey:key,...extra})),/<button[^>]*disabled[^>]*>임시 입력 파일 정리/);
  const removed=renderToStaticMarkup(createElement(ModelHubRequestHistory,{...props,requests:[{...request,temporaryInput:'removed'}],cleanupConsentKey:key}));assert.match(removed,/임시 입력.*정리됨/);assert.doesNotMatch(removed,/임시 입력 파일 정리/);
  const active=renderToStaticMarkup(createElement(ModelHubRequestHistory,{...props,requests:[{...request,execution:'running',temporaryInput:'present'}]}));assert.doesNotMatch(active,/임시 입력 파일 정리|이전 AWS CLI 프로세스/);
  const completed=renderToStaticMarkup(createElement(ModelHubRequestHistory,{...props,requests:[{...request,execution:'completed',temporaryInput:'removed'}]}));assert.match(completed,/응답 수신 · 실제 청구액 unknown/);assert.doesNotMatch(completed,/원격 완료·과금 여부 미확인/);
  assert.match(locked,/원격 완료·과금 여부 미확인/);
});

test('global Bedrock recovery stays discoverable through metadata and blocks only new Bedrock sends',async()=>{
  const {ModelHubOverview,modelHubRecoveryBlocksSend}=await components(),recovery=[{projectId:'other-project',requestId:'<old-request>',body:'HIDDEN_OTHER_INPUT'}];
  assert.equal(modelHubRecoveryBlocksSend('bedrock',recovery),true);for(const id of ['local','openai-compatible','litellm','vllm','freellmapi',undefined] as const)assert.equal(modelHubRecoveryBlocksSend(id,recovery),false);
  assert.equal(modelHubRecoveryBlocksSend('bedrock',undefined),false);assert.equal(modelHubRecoveryBlocksSend('bedrock',[]),false);
  const html=renderToStaticMarkup(createElement(ModelHubOverview,{view:{...view(),bedrockRecovery:recovery},projectId:'project-a'}));
  assert.match(html,/미정리 Bedrock 입력/);assert.match(html,/새 Bedrock 전송.*차단/);assert.match(html,/해당 프로젝트.*선택.*종료.*확인.*정리/);assert.match(html,/other-project/);assert.match(html,/&lt;old-request&gt;/);assert.doesNotMatch(html,/HIDDEN_OTHER_INPUT|<old-request>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ModelHubOverview,{view:view(),projectId:'project-a'})),/미정리 Bedrock 입력/);
});
