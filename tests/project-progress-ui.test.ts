import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {buildProjectProgress} from '../shared/project-progress.ts';
import type {Run} from '../shared/types.ts';
import type {SavedTask,PlanningVersion} from '../shared/parallel.ts';

async function view(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/project-progress.tsx');}finally{hooks.deregister();}
}
const plan:PlanningVersion={id:'v1',projectId:'p',revision:3,contentHash:'ab'.repeat(32),state:'approved',lineageId:'L',
  draft:{schemaVersion:'1.0',title:'시장 보고서',goal:'경쟁사 3곳 비교',requirements:[],constraints:[],openQuestions:[],source:'manual'}};
const task=(id:string,title:string):SavedTask=>({id,projectId:'p',title,description:'',acceptanceCriteria:['출처 3개'],planningVersionId:'v1',requirementLabels:['R1'],state:'draft',verification:'not_run',createdAt:''});
const run=(id:string,taskId:string,execution:Run['execution']):Run=>({id:id.padEnd(12,'0'),requestId:id,turnId:null,prompt:'',response:'',execution,verification:'not_run',
  createdAt:'2026-10-28T01:00:00.000Z',updatedAt:'2026-10-28T01:05:00.000Z',workspaceId:'w',taskId,planningVersionId:'v1'});

test('the board separates an AI response from verification and shows observed facts only',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v1'],checks:[],signals:{},
    tasks:[task('t1','자료 수집'),task('t2','초안 작성'),task('t3','검토')],runs:[run('a','t1','completed'),run('b','t2','lost')]});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'live',lastEventAt:null}));
  assert.match(html,/시장 보고서/);assert.match(html,/r3/);
  assert.match(html,/작업 3개 중 0개 검증 통과 \(작업 수 기준\)/);
  assert.match(html,/완료 조건 3개 중 0개 확인/);
  assert.match(html,/AI 응답 완료 · 검증 전/);
  assert.match(html,/연결 유실 · 결과 미확인/);
  assert.match(html,/같은 작업을 다시 실행하지 마세요/);
  assert.match(html,/담당 Codex/);assert.match(html,/담당 미지정/);
  assert.doesNotMatch(html,/\d+%/,'no invented percentage');
  assert.doesNotMatch(html,/ETA|예상 완료/);
});

test('blockers, quota waits and a stale connection are visible',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v1'],checks:[],runs:[],
    tasks:[task('t1','자료 수집')],signals:{quota:'exhausted',recoveryRequired:true}});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'offline',lastEventAt:null}));
  assert.match(html,/한도 대기/);assert.match(html,/자동 재시도하지 않습니다/);
  assert.match(html,/종료를 확인하지 못한 실행이 있어/);
  assert.match(html,/서버 연결 끊김 · 오래된 화면일 수 있음/);
});

test('a project without an approved plan renders an honest empty state',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[],currentPlanIds:[],checks:[],runs:[],tasks:[],signals:{}});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'quiet',lastEventAt:null}));
  assert.match(html,/승인된 기획 없음/);assert.match(html,/작업이 아직 없습니다/);assert.match(html,/관측 기록 없음/);
});

const actions=(over:Record<string,unknown>={})=>({runtimeLabel:'Claude Code',canRun:true,busy:false,pendingTaskId:null,handoff:null,onRun:()=>{},onInterrupt:()=>{},onHandoff:()=>{},...over});
test('run buttons appear only for runnable stages; a lost run is never offered a retry',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v1'],checks:[],signals:{},
    tasks:[task('t1','새 작업'),task('t2','유실'),task('t3','실행 중')],runs:[run('b','t2','lost'),run('c','t3','running')]});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'live',lastEventAt:null,actions:actions()}));
  assert.equal((html.match(/Claude Code로 실행/g)??[]).length,1);
  assert.doesNotMatch(html,/다시 실행<\/button>/);
  assert.equal((html.match(/중단 요청<\/button>/g)??[]).length,1);
  assert.equal((html.match(/인계 자료 보기/g)??[]).length,3);
});
test('a pinned uncertain request is re-checked with the same request, and other runs wait for it',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v1'],checks:[],signals:{},runs:[],tasks:[task('t1','첫 작업'),task('t2','둘째 작업')]});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'live',lastEventAt:null,actions:actions({pendingTaskId:'t1'})}));
  assert.match(html,/같은 요청으로 다시 확인/);
  assert.match(html,/<button class="primary" disabled="">Claude Code로 실행<\/button>/);
});
test('code projects show records and handoff but no run controls on the board',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v1'],checks:[],signals:{},runs:[run('c','t1','running')],tasks:[task('t1','코드 작업'),task('t2','대기')]});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'live',lastEventAt:null,actions:actions({canRun:false,runtimeLabel:'Codex'})}));
  assert.doesNotMatch(html,/로 실행|중단 요청<\/button>/);assert.match(html,/인계 자료 보기/);
});
test('handoff markdown renders as inert text',async()=>{
  const {ProjectProgressView}=await view();
  const progress=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v1'],checks:[],signals:{},runs:[],tasks:[task('t1','작업')]});
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress,freshness:'live',lastEventAt:null,actions:actions({handoff:{taskId:'t1',markdown:'# 인계\n<script>alert(1)</script>'}})}));
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('quality loop simple labels and advanced evidence stay separate from check approval',async()=>{
 const {QualityLoopStatus}=await view();
 const loop={id:'loop',result:{status:'reviewing',repairs:1,rounds:[{failures:[{criterion:'출처',evidence:'근거 없음'}]}],issue:null},recoveryRequired:false,
 producer:{providerId:'anthropic',modelId:'unknown',sessionId:'source-session',runId:'source-run'},reviewers:[{providerId:'openai',modelId:'selected-model'}],
 verification:{status:'unknown'},version:{id:'approved-v1'},baseline:{digest:'baseline-digest'},steps:[{id:'step',kind:'repair',state:'completed',evidence:{providerId:'anthropic',modelId:'actual-model',sessionId:'repair-session',runId:'repair-run',source:'native_observed'}}]} as unknown as import('../shared/quality-loop-record.ts').QualityLoopRecord;
 const simple=renderToStaticMarkup(createElement(QualityLoopStatus,{loop,advanced:false}));assert.match(simple,/재검증 중/);assert.match(simple,/문제 1개/);assert.match(simple,/unknown/);assert.match(simple,/사용자 승인과 별개/);assert.doesNotMatch(simple,/repair-session|baseline-digest|근거 없음/);
 const advanced=renderToStaticMarkup(createElement(QualityLoopStatus,{loop,advanced:true}));assert.match(advanced,/repair-session/);assert.match(advanced,/수정자/);assert.match(advanced,/baseline-digest/);assert.match(advanced,/근거 없음/);
});

test('Codex configuration is shown separately from actual execution evidence',async()=>{
  const {CodexModelEvidence}=await view();
  const html=renderToStaticMarkup(createElement(CodexModelEvidence,{value:{selectedModelId:'selected-model',requestedModelId:'requested-model',
    serverModelId:'configured-model',serverProviderId:'openai',serverSource:'thread/resume',actualModelId:'unknown',actualModelEvidence:'unavailable',
    threadId:'thread-identity',nativeSessionId:'session-identity',turnId:'turn-identity',status:'lost',modelChanged:true,observationIncomplete:true,resumed:true,observations:[]}}));
  assert.match(html,/사용자 선택: selected-model/);assert.match(html,/요청 모델: requested-model/);
  assert.match(html,/서버 설정 모델: configured-model/);assert.match(html,/실제 실행 모델: unknown/);
  assert.match(html,/독립 모델 검증 근거 없음/);assert.match(html,/관측 불완전/);
  assert.match(html,/thread-identity/);assert.match(html,/session-identity/);assert.match(html,/turn-identity/);
});
