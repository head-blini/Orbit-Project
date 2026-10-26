import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {PlanningFeedback} from '../shared/planning-handoff.ts';
import type {Snapshot,Run} from '../shared/types.ts';

async function components(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,nextLoad){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return nextLoad(url,context);
  }});
  try{const studio=await import('../web/planning/PlanningStudio.tsx'),feedback=await import('../web/planning/PlanningFeedback.tsx');return {studio,feedback:async()=>feedback};}finally{hooks.deregister();}
}
const version:PlanningVersion={id:'plan-a',projectId:'project-a',revision:3,contentHash:'a'.repeat(64),state:'approved',draft:{schemaVersion:'1.0',title:'Saved plan',goal:'Fixture goal',requirements:[],constraints:[],openQuestions:[],source:'manual'}};
const task=(projectId='project-a',id='task-a'):SavedTask=>({id,projectId,title:id,description:'Fixture task',acceptanceCriteria:['Fixture criterion'],planningVersionId:'plan-a',requirementLabels:['REQ-01'],state:'draft',verification:'not_run',createdAt:'2026-10-26T00:00:00.000Z'});
const run=(id='run-a',taskId='task-a',workspaceId='workspace-a'):Run=>({id,taskId,workspaceId,requestId:'request-a',turnId:null,prompt:'PROMPT_MUST_NOT_APPEAR',response:'RESPONSE_MUST_NOT_APPEAR',execution:'failed',verification:'not_run',createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:01.000Z'});
const state:Snapshot={provider:'disconnected',issue:null,threadId:null,workspace:'fixture',readOnly:false,lastSeq:0,selectedWorkspaceId:'workspace-a',runs:[run(),run('other-workspace-run','task-a','workspace-b'),run('foreign-task-run','task-b')],
  workspaces:[{id:'workspace-a',projectId:'project-a',path:'fixture',branch:'fixture',baseSha:'b'.repeat(40),createdAt:'',status:'ready'}]};
const feedback:PlanningFeedback={projectId:'project-a',generatedAt:'2026-10-26T00:00:02.000Z',filename:'fixture-feedback.md',markdown:'# Review\n<script>hostile()</script>\n![remote](https://example.invalid/image)',
  planning:{id:'plan-a',revision:3,contentHash:'a'.repeat(64),state:'approved',current:false},task:{id:'task-a',requirementLabels:['REQ-01']},run:{id:'run-a',workspaceId:'workspace-a',execution:'failed',verification:'not_run',createdAt:'',updatedAt:''},
  verification:{available:false,sourceDigest:null,quarantined:null,canApprove:false,approvalCurrent:false,approvalId:null,checks:[]},changes:{available:false,baseSha:null,files:[]}};

test('saved-version export controls require the same project, a saved unchanged version and an available callback',async()=>{
  const {studio}=await components();assert.equal(typeof studio.PlanningExportActions,'function');
  const render=(props:object)=>renderToStaticMarkup(createElement(studio.PlanningExportActions,{projectId:'project-a',version,dirty:false,busy:false,onExport:async()=>{throw new Error('SSR must not export');},...props}));
  const ready=render({});assert.match(ready,/저장 버전 Markdown 내보내기/);assert.match(ready,/저장 버전 JSON 내보내기/);assert.doesNotMatch(ready,/<button[^>]*disabled/);
  for(const props of [{version:undefined},{dirty:true},{busy:true},{onExport:undefined},{projectId:'project-b'}])assert.equal((render(props).match(/<button[^>]*disabled/g)??[]).length,2);
});

test('production feedback epoch blocks double clicks and discards late selection, question and project responses',async()=>{
  const {createPlanningFeedbackEpoch}=await (await components()).feedback();const order=createPlanningFeedbackEpoch();
  assert.equal(order.begin(),null);order.reset();const first=order.begin()!;assert.ok(first);assert.equal(order.begin(),null);assert.equal(order.isCurrent(first),true);
  order.invalidate();assert.equal(order.isCurrent(first),false);const next=order.begin()!;assert.ok(next);assert.equal(order.finish(first),false);assert.equal(order.isCurrent(next),true);
  assert.equal(order.finish(next),true);assert.equal(order.isCurrent(next),true,'accepted preview remains downloadable until its inputs change');
  const newer=order.begin()!;assert.equal(order.isCurrent(next),false);order.dispose();assert.equal(order.isCurrent(newer),false);assert.equal(order.begin(),null);
  order.reset();assert.equal(order.isCurrent(newer),false);assert.ok(order.begin());
});

test('feedback choices include only current-project tasks and their runs in the selected workspace snapshot',async()=>{
  const {planningFeedbackChoices,matchesPlanningFeedback}=await (await components()).feedback();
  const choices=planningFeedbackChoices('project-a',[task(),task('project-b','task-b')],state,'task-a');
  assert.deepEqual(choices.tasks.map(value=>value.id),['task-a']);assert.deepEqual(choices.runs.map(value=>value.id),['run-a']);
  assert.equal(planningFeedbackChoices('project-b',[task('project-b')],state,'task-a').runs.length,0);
  assert.equal(planningFeedbackChoices('project-a',[task()],{...state,selectedWorkspaceId:null},'task-a').runs.length,0);
  const selection={projectId:'project-a',taskId:'task-a',runId:'run-a',workspaceId:'workspace-a'};
  assert.equal(matchesPlanningFeedback(feedback,selection),true);
  for(const changed of [{projectId:'foreign'},{task:{...feedback.task,id:'foreign'}},{run:{...feedback.run,id:'foreign'}},{run:{...feedback.run,workspaceId:'foreign'}}])assert.equal(matchesPlanningFeedback({...feedback,...changed},selection),false);
});

test('feedback SSR is inert, requires a run, describes manual handoff and escapes preview Markdown',async()=>{
  const {PlanningFeedbackPanel,PlanningFeedbackPreview}=await (await components()).feedback();
  const html=renderToStaticMarkup(createElement(PlanningFeedbackPanel,{projectId:'project-a',tasks:[task(),task('project-b','FOREIGN_TASK')],state:{...state,runs:[]},onPreview:async()=>{throw new Error('SSR must not POST');},onDownload:()=>{throw new Error('SSR must not download');}}));
  assert.match(html,/개발 증거 미리보기/);assert.match(html,/<button[^>]*disabled[^>]*>개발 증거 미리보기/);assert.match(html,/현재 선택한 작업 공간/);assert.match(html,/수동/);assert.match(html,/maxLength="2000"/i);
  assert.doesNotMatch(html,/FOREIGN_TASK|PROMPT_MUST_NOT_APPEAR|RESPONSE_MUST_NOT_APPEAR/);
  const preview=renderToStaticMarkup(createElement(PlanningFeedbackPreview,{feedback,onDownload:()=>{}}));
  assert.match(preview,/&lt;script&gt;hostile\(\)&lt;\/script&gt;/);assert.doesNotMatch(preview,/<script|<img|href="https:/);assert.match(preview,/피드백 Markdown 다운로드/);assert.match(preview,/생성 당시/);assert.match(preview,/failed/);
  assert.match(preview,/과거 기획 버전/);assert.match(preview,/검증 근거 확인 불가.*unknown/);assert.match(preview,/현재 검증 통과 근거: unknown/);assert.match(preview,/현재 리뷰 승인 유효성: unknown/);assert.match(preview,/파일 상태 조회 불가/);
  const checked={...feedback,run:{...feedback.run,execution:'completed' as const},verification:{...feedback.verification,available:true,canApprove:true,checks:[{id:'check-a',commandId:'fixture-node',configDigest:'c'.repeat(64),sourceDigest:'d'.repeat(64),finishedDigest:'d'.repeat(64),createdAt:'',completedAt:'',execution:'completed' as const,verdict:'passed' as const,exitCode:0,durationMs:2}]}};
  const current=renderToStaticMarkup(createElement(PlanningFeedbackPreview,{feedback:checked,onDownload:()=>{}}));
  assert.match(current,/검증 근거 조회됨/);assert.match(current,/현재 검증 통과 근거 있음/);assert.match(current,/현재 리뷰 승인 유효하지 않음/);assert.match(current,/<table/);assert.match(current,/fixture-node/);assert.match(current,/passed/);assert.doesNotMatch(current,/검증 실패|실행 실패/);
  // A sentence explicitly saying unknown is not a failure is valid; reject a
  // positive failure label while keeping the exact current-evidence assertions.
  const stale=renderToStaticMarkup(createElement(PlanningFeedbackPreview,{feedback:{...checked,verification:{...checked.verification,canApprove:false}},onDownload:()=>{}}));assert.match(stale,/현재 검증 통과 근거 없음/);assert.match(stale,/passed/);assert.match(stale,/근거 없음이나 unknown은 실패 판정이 아닙니다/);assert.doesNotMatch(stale,/검증 실패|실행 실패/);
  const disabled=renderToStaticMarkup(createElement(PlanningFeedbackPreview,{feedback,disabled:true,onDownload:()=>{}}));assert.match(disabled,/<button[^>]*disabled[^>]*>피드백 Markdown 다운로드/);
});
