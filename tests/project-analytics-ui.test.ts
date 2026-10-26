import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {AnalyticsRecord,AnalyticsTotals,CheckCounts,ProjectAnalytics} from '../shared/analytics.ts';

async function components(){
  const webRoot=new URL('../web/',import.meta.url).href;
  assert.ok(existsSync(new URL('../web/project-analytics.tsx',import.meta.url)),'Project analytics UI is not implemented');
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/project-analytics.tsx');}finally{hooks.deregister();}
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const checks=():CheckCounts=>({total:3,passed:1,failed:1,interrupted:0,timedOut:0,stale:0,running:0,lost:1,notRun:0});
const totals=():AnalyticsTotals=>({records:12,completed:4,failed:1,active:2,interrupted:1,lost:1,timedOut:1,stale:1,unknown:1,tokenSubtotal:0,tokenKnownRecords:1,tokenUnknownRecords:11,tokenIncompleteRecords:2,durationSubtotalMs:1500,durationKnownRecords:3,durationUnknownRecords:9,workflowRetries:2,checks:checks()});
function record(id:string,changes:Partial<AnalyticsRecord>={}):AnalyticsRecord{return {id,kind:'coding',workspaceId:'workspace-a',taskId:'task-a',providerId:'codex',model:'model-a',modelChanged:false,execution:'completed',createdAt:'2026-10-26T01:00:00.000Z',finishedAt:'2026-10-26T01:00:01.500Z',durationMs:1500,tokens:{inputTokens:0,outputTokens:0,totalTokens:0},tokenSource:'codex_observed_delta',tokenStatus:'observed',observedAt:'2026-10-26T01:00:01.000Z',retryCount:null,retrySource:'unknown',retryNotices:1,checks:checks(),...changes};}
function page(projectId='project-a',records=[record('run-a')],nextCursor:string|null=null):ProjectAnalytics{return {projectId,generatedAt:'2026-10-26T02:00:00.000Z',source:'local_records',costUsd:null,totals:totals(),groups:[{kind:'coding',providerId:'codex',model:'model-a',totals:totals()}],records,nextCursor};}
const response=(data:ProjectAnalytics)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});

test('scope activation fetches only the selected online project with a bounded GET and same-scope renders do not request again',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();const calls:{path:string;options:RequestInit}[]=[];
  const coordinator=createProjectAnalyticsCoordinator(async(path,options)=>{calls.push({path,options});return response(page('project /?'));});
  await coordinator.setScope({projectId:null,online:true});await coordinator.refresh();await coordinator.nextPage();
  await coordinator.setScope({projectId:'project /?',online:false});await coordinator.refresh();assert.equal(calls.length,0);
  await coordinator.setScope({projectId:'project /?',online:true});await coordinator.setScope({projectId:'project /?',online:true});await coordinator.nextPage();
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/projects/project%20%2F%3F/analytics?limit=25');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.body,undefined);
  assert.equal(coordinator.getSnapshot().data?.projectId,'project /?');assert.equal(coordinator.getSnapshot().loading,null);
});

test('manual refresh supersedes initial GET and synchronous duplicate refreshes cannot unlock the newer request',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();const old=deferred<Response>(),fresh=deferred<Response>();let calls=0;
  const coordinator=createProjectAnalyticsCoordinator(()=>++calls===1?old.promise:fresh.promise);
  const initial=coordinator.setScope({projectId:'project-a',online:true});const refresh=coordinator.refresh();await coordinator.refresh();assert.equal(calls,2);
  old.resolve(response(page('project-a',[record('old')])));await initial;assert.equal(coordinator.getSnapshot().loading,'refresh');assert.equal(coordinator.getSnapshot().data,null);await coordinator.refresh();assert.equal(calls,2);
  fresh.resolve(response(page('project-a',[record('fresh')])));await refresh;assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>row.id),['fresh']);assert.equal(coordinator.getSnapshot().loading,null);
});

test('late success and failure from earlier projects cannot replace current data, errors or request locks',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();const a=deferred<Response>(),b=deferred<Response>(),c=deferred<Response>();const requests=[a,b,c];let calls=0;
  const coordinator=createProjectAnalyticsCoordinator(()=>requests[calls++].promise);
  const first=coordinator.setScope({projectId:'project-a',online:true});const second=coordinator.setScope({projectId:'project-b',online:true});const third=coordinator.setScope({projectId:'project-c',online:true});
  a.resolve(response(page('project-a')));b.reject(new Error('PRIVATE_RESPONSE_PATH'));await Promise.all([first,second]);
  assert.equal(coordinator.getSnapshot().projectId,'project-c');assert.equal(coordinator.getSnapshot().loading,'initial');assert.equal(coordinator.getSnapshot().data,null);assert.equal(coordinator.getSnapshot().error,'');
  c.resolve(response(page('project-c')));await third;assert.equal(coordinator.getSnapshot().data?.projectId,'project-c');assert.equal(coordinator.getSnapshot().error,'');
});

test('offline and unmount invalidate pending reads and remount can load the same project afresh',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();const first=deferred<Response>(),second=deferred<Response>();let calls=0;
  const coordinator=createProjectAnalyticsCoordinator(()=>++calls===1?first.promise:calls===2?second.promise:Promise.resolve(response(page('project-a',[record('remounted')]))));
  const loading=coordinator.setScope({projectId:'project-a',online:true});await coordinator.setScope({projectId:'project-a',online:false});first.resolve(response(page()));await loading;
  assert.equal(coordinator.getSnapshot().data,null);assert.equal(coordinator.getSnapshot().loading,null);await coordinator.refresh();assert.equal(calls,1);
  const remount=coordinator.setScope({projectId:'project-a',online:true});coordinator.dispose();second.reject(new Error('late failure'));await remount;assert.equal(coordinator.getSnapshot().error,'');
  await coordinator.refresh();assert.equal(calls,2);
  await coordinator.setScope({projectId:'project-a',online:true});assert.equal(calls,3);assert.equal(coordinator.getSnapshot().error,'');assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>row.id),['remounted']);
});

test('pagination encodes opaque cursors, suppresses duplicate requests and deduplicates records by kind and id without adding summary totals',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();const pending=deferred<Response>();const paths:string[]=[];
  const coordinator=createProjectAnalyticsCoordinator(async path=>{paths.push(path);return paths.length===1?response(page('project-a',[record('same')],'cursor +/?=')):pending.promise;});
  await coordinator.setScope({projectId:'project-a',online:true});const next=coordinator.nextPage();await coordinator.nextPage();assert.equal(paths.length,2);assert.equal(paths[1],'/api/projects/project-a/analytics?limit=25&cursor=cursor%20%2B%2F%3F%3D');
  pending.resolve(response({...page('project-a',[record('same'),record('same',{kind:'planning'}),record('second')]),totals:{...totals(),records:900}}));await next;
  assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>[row.kind,row.id]),[['coding','same'],['planning','same'],['coding','second']]);assert.equal(coordinator.getSnapshot().data?.totals.records,12);
  await coordinator.nextPage();assert.equal(paths.length,2);
});

test('refresh invalidates a pending page, resets accumulated records and starts pagination from the fresh cursor',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();const oldPage=deferred<Response>(),fresh=deferred<Response>();const paths:string[]=[];
  const coordinator=createProjectAnalyticsCoordinator(path=>{paths.push(path);return paths.length===1?Promise.resolve(response(page('project-a',[record('old')],'old-cursor'))):paths.length===2?oldPage.promise:fresh.promise;});
  await coordinator.setScope({projectId:'project-a',online:true});const paging=coordinator.nextPage();const refreshing=coordinator.refresh();await coordinator.nextPage();assert.equal(paths.length,3);
  oldPage.resolve(response(page('project-a',[record('late')],'late-cursor')));await paging;assert.equal(coordinator.getSnapshot().loading,'refresh');assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>row.id),['old']);
  fresh.resolve(response(page('project-a',[record('new')],'new-cursor')));await refreshing;assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>row.id),['new']);assert.equal(coordinator.getSnapshot().data?.nextCursor,'new-cursor');
  await coordinator.nextPage();assert.equal(paths[3],'/api/projects/project-a/analytics?limit=25&cursor=new-cursor');
});

test('failed and cross-project responses remain explicit errors with no automatic retry and failed pages remain manually retryable',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();let calls=0;
  const coordinator=createProjectAnalyticsCoordinator(async()=>{calls++;if(calls===1)return new Response('PRIVATE_PROMPT',{status:500});if(calls===2)return response(page('other-project'));if(calls===3)return response(page('project-a',[record('first')],'next'));if(calls===4)throw new Error('/secret/native-thread');return response(page('project-a',[record('second')]));});
  await coordinator.setScope({projectId:'project-a',online:true});assert.equal(calls,1);assert.equal(coordinator.getSnapshot().data,null);assert.match(coordinator.getSnapshot().error,/불러오지 못/);assert.doesNotMatch(coordinator.getSnapshot().error,/PRIVATE|secret/);
  await coordinator.refresh();assert.equal(calls,2);assert.equal(coordinator.getSnapshot().data,null);assert.match(coordinator.getSnapshot().error,/불러오지 못/);
  await coordinator.refresh();await coordinator.nextPage();assert.equal(calls,4);assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>row.id),['first']);assert.equal(coordinator.getSnapshot().data?.nextCursor,'next');
  await coordinator.nextPage();assert.equal(calls,5);assert.equal(coordinator.getSnapshot().error,'');assert.deepEqual(coordinator.getSnapshot().data?.records.map(row=>row.id),['first','second']);
});

test('a repeated page cursor stops further requests with a visible recovery message',async()=>{
  const {createProjectAnalyticsCoordinator}=await components();let calls=0;
  const coordinator=createProjectAnalyticsCoordinator(async()=>response(page('project-a',[record(String(++calls))],'same-cursor')));
  await coordinator.setScope({projectId:'project-a',online:true});await coordinator.nextPage();await coordinator.nextPage();assert.equal(calls,2);assert.equal(coordinator.getSnapshot().data?.nextCursor,null);assert.match(coordinator.getSnapshot().error,/반복|새로고침/);
});

test('actual analytics view renders whole-project totals, coverage and historical checks separately from account quota and billing',async()=>{
  const {ProjectAnalyticsView}=await components();let actions=0;
  const data=page('project-a',[record('zero',{durationMs:0}),record('unknown',{kind:'model_hub',providerId:null,model:null,durationMs:null,tokens:{inputTokens:20,outputTokens:null,totalTokens:null},tokenSource:'provider',tokenStatus:'incomplete',retryCount:2,retrySource:'workflow_lineage',retryNotices:null})]);
  data.groups.push({kind:'review',providerId:'another-provider',model:'another-model',totals:{...totals(),records:7,tokenSubtotal:null,durationSubtotalMs:null}});
  const html=renderToStaticMarkup(createElement(ProjectAnalyticsView,{state:{projectId:'project-a',online:true,data,error:'',loading:null},onRefresh:()=>{actions++;},onNextPage:()=>{actions++;}}));
  assert.match(html,/프로젝트 활동 분석/);assert.match(html,/로컬/);assert.match(html,/토큰.*확인 1개.*미확인 11개.*불완전 2개/s);assert.match(html,/시간.*확인 3개.*미확인 9개/s);
  assert.match(html,/Codex 관측 차이/);assert.match(html,/제공자 응답 토큰/);assert.match(html,/계정.*별도/s);assert.match(html,/과금|청구/);assert.match(html,/작업 경과 시간/);assert.match(html,/추론 시간.*아닙/s);assert.match(html,/비용.*미확인/s);
  assert.match(html,/과거 검증/);assert.match(html,/현재.*승인.*뜻하지 않/s);assert.match(html,/실행 완료.*검증 통과.*별개/s);assert.match(html,/검증 통과 1/);assert.match(html,/검증 실패 1/);assert.match(html,/상태 유실 1/);
  assert.match(html,/another-provider/);assert.match(html,/another-model/);assert.match(html,/2.*12.*기록/s);assert.match(html,/0 ms/);assert.match(html,/1\.5초/);assert.match(html,/>0</);assert.match(html,/>미확인</);assert.equal(actions,0);
  assert.doesNotMatch(html,/<button[^>]*>[^<]*(승인|실행|중단)/);
});

test('record details escape attribution and identities, expose only allowlisted metadata and never link or render raw payload fields',async()=>{
  const {ProjectAnalyticsView}=await components();
  const row=Object.assign(record('record <script>bad()</script>',{providerId:'provider <img src=x>',model:'model <svg onload=bad()>',modelChanged:true,taskId:'task <iframe>',workspaceId:'workspace <b>',execution:'completed'}),{prompt:'PRIVATE_PROMPT',response:'PRIVATE_RESPONSE',path:'/PRIVATE_PATH',threadId:'PRIVATE_NATIVE_THREAD',endpoint:'https://PRIVATE_ENDPOINT',raw:{payload:'PRIVATE_PAYLOAD'}});
  const data=page('project-a',[row]);
  const html=renderToStaticMarkup(createElement(ProjectAnalyticsView,{state:{projectId:'project-a',online:true,data,error:'',loading:null},onRefresh:()=>{},onNextPage:()=>{}}));
  assert.match(html,/record &lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.match(html,/provider &lt;img src=x&gt;/);assert.match(html,/model &lt;svg onload=bad\(\)&gt;/);assert.match(html,/task &lt;iframe&gt;/);assert.match(html,/workspace &lt;b&gt;/);assert.match(html,/모델 변경/);
  assert.match(html,/재시도 알림/);assert.match(html,/정확한 재시도 횟수.*아닙/s);assert.match(html,/토큰 관측 시각/);assert.doesNotMatch(html,/PRIVATE_|<script|<svg|<iframe|<img|<a(?:\s|>)|<[^>]+\s(?:href|src)=/);
});

test('actual panel is inert on server render and no-project, offline, loading and error states keep unavailable actions disabled',async t=>{
  const {ProjectAnalyticsPanel,ProjectAnalyticsView}=await components();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('SSR must not fetch');});
  const empty=renderToStaticMarkup(createElement(ProjectAnalyticsPanel,{projectId:null,online:true}));assert.match(empty,/프로젝트를 선택/);assert.match(empty,/<button[^>]*disabled[^>]*>새로고침/);
  const offline=renderToStaticMarkup(createElement(ProjectAnalyticsPanel,{projectId:'project-a',online:false}));assert.match(offline,/서버 연결/);assert.match(offline,/<button[^>]*disabled[^>]*>새로고침/);
  renderToStaticMarkup(createElement(ProjectAnalyticsPanel,{projectId:'project-a',online:true}));assert.equal(calls,0);
  const loading=renderToStaticMarkup(createElement(ProjectAnalyticsView,{state:{projectId:'project-a',online:true,data:page('project-a',[record('first')],'next'),error:'',loading:'refresh'},onRefresh:()=>{},onNextPage:()=>{}}));
  assert.match(loading,/aria-busy="true"/);assert.match(loading,/<button[^>]*disabled[^>]*>새로고침/);assert.match(loading,/<button[^>]*disabled[^>]*>다음 기록/);
  const failed=renderToStaticMarkup(createElement(ProjectAnalyticsView,{state:{projectId:'project-a',online:true,data:null,error:'서버에서 <error>가 발생했습니다.',loading:null},onRefresh:()=>{},onNextPage:()=>{}}));assert.match(failed,/role="alert"/);assert.match(failed,/&lt;error&gt;/);assert.doesNotMatch(failed,/<button[^>]*disabled[^>]*>새로고침/);
});
