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
const plan:PlanningVersion={id:'v2',projectId:'p',revision:4,contentHash:'cd'.repeat(32),state:'approved',lineageId:'L',
  draft:{schemaVersion:'1.0',title:'보고서',goal:'목표',requirements:[],constraints:[],openQuestions:[],source:'manual'}};
const task=(id:string,title:string,pv:string):SavedTask=>({id,projectId:'p',title,description:'',acceptanceCriteria:['a'],planningVersionId:pv,requirementLabels:[],state:'draft',verification:'not_run',createdAt:''});
const run=(id:string,taskId:string,execution:Run['execution'],pv:string):Run=>({id:id.padEnd(12,'0'),requestId:id,turnId:null,prompt:'',response:'',execution,verification:'not_run',
  createdAt:'2026-10-28T01:00:00.000Z',updatedAt:'2026-10-28T01:05:00.000Z',workspaceId:'w',taskId,planningVersionId:pv});
const progress=()=>buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v2'],checks:[],signals:{},
  tasks:[task('t1','옛 기준 작업','v1'),task('t2','현재 작업','v2')],runs:[run('a','t1','running','v1'),run('b','t2','completed','v2')]});

test('plain status never calls an unverified or old-baseline task done',async()=>{
  await view();const {plainStatus,taskImpact}=await import('../web/project-work-model.ts');const p=progress();
  assert.equal(plainStatus(p.tasks[0]).label,'기준이 바뀌어 다시 확인해야 함');
  assert.equal(plainStatus(p.tasks[1]).label,'AI 응답 받음 · 아직 확인 전');
  assert.equal(taskImpact(p.tasks[1],'v2'),null);
  const i=taskImpact(p.tasks[0],'v2')!;assert.equal(i.inProgress,true);assert.equal(i.reverify,'needed');assert.deepEqual(i.oldRunIds,['a00000000000']);
});
test('stale baseline view lists in-progress old runs and next step; unknown run baseline is not listed as old',async()=>{
  const {ProjectProgressView}=await view();const p=progress();
  const html=renderToStaticMarkup(createElement(ProjectProgressView,{progress:p,freshness:'live',lastEventAt:null}));
  assert.match(html,/기준 변경 영향/);assert.match(html,/진행 중인 작업 1개가 이전 기준/);assert.match(html,/다음 할 일/);
  assert.match(html,/끝나도 통과로 인정되지 않습니다/);assert.doesNotMatch(html,/끝났고 확인됨/);
  const none=buildProjectProgress({projectId:'p',plans:[plan],currentPlanIds:['v2'],checks:[],signals:{},tasks:[task('t2','현재','v2')],runs:[]});
  assert.doesNotMatch(renderToStaticMarkup(createElement(ProjectProgressView,{progress:none,freshness:'live',lastEventAt:null})),/기준 변경 영향/);
});
test('task graph panel mounts read-only only when online is given and a plan exists',async()=>{
  const {ProjectProgressView}=await view();const p=progress();
  const on=renderToStaticMarkup(createElement(ProjectProgressView,{progress:p,freshness:'live',lastEventAt:null,online:true}));
  assert.match(on,/작업 그래프·통합 대기열/);assert.match(on,/읽기 전용/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ProjectProgressView,{progress:p,freshness:'live',lastEventAt:null})),/작업 그래프·통합 대기열/);
});
