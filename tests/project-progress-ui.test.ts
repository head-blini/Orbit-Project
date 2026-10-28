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
