import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
async function view(){
 const hooks=registerHooks({load(url,context,next){if(url.startsWith(new URL('../web/',import.meta.url).href)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});
 try{return await import('../web/capability-execution.tsx');}finally{hooks.deregister();}
}
const decision={id:'route',projectId:'p',taskId:'t',status:'recommended',intent:'execution',runtimeId:'claude-code'} as CapabilityRouteDecision;
const record={id:'execution',projectId:'p',taskId:'t',routeId:'route',runtimeId:'claude-code',updatedAt:'2026-10-28',status:'awaiting_approval',issue:null,runId:null,quality:null,qualityLoopId:null,recoveryRequired:false,planDigest:'plan-digest',baseline:{planningVersionId:'plan',planningContentHash:'hash'},adapter:{version:'1.0',revision:1},models:{selectedModelId:'selected',requestedModelId:'requested',serverModelId:'configured',actualModelId:'unknown',source:'unknown'}} as CapabilityExecutionRecord;
const post=async()=>{throw Error('render must never execute');};
test('plan creation requires available planning context and is never an execution grant',async()=>{
 const {CapabilityExecution}=await view();
 const general=renderToStaticMarkup(createElement(CapabilityExecution,{decision,advanced:false,post,canPlan:true}));
 assert.match(general,/실행 계획 확인/);assert.doesNotMatch(general,/승인하고 실행/);
 const code=renderToStaticMarkup(createElement(CapabilityExecution,{decision,advanced:false,post}));assert.match(code,/작업 공간과 검증 기준/);assert.doesNotMatch(code,/<button/);
 const blocked=renderToStaticMarkup(createElement(CapabilityExecution,{decision:{...decision,status:'blocked'},advanced:false,post,canPlan:true}));assert.doesNotMatch(blocked,/<button/);
});
test('both modes require unchecked explicit approval and keep actual model unknown',async()=>{
 const {CapabilityExecution}=await view();
 for(const advanced of [false,true]){
 const html=renderToStaticMarkup(createElement(CapabilityExecution,{decision,records:[record],advanced,post,canPlan:true}));
 assert.match(html,/<button disabled="">승인하고 실행/);assert.doesNotMatch(html,/checked=""/);assert.match(html,/작업 내용이 제공자에게 전송/);assert.match(html,/실제 실행 모델: unknown/);
 if(advanced){assert.match(html,/사용자 선택: selected/);assert.match(html,/요청 모델: requested/);assert.match(html,/서버 설정 모델: configured/);}else assert.doesNotMatch(html,/plan-digest|configured|selected/);
 }
});
test('lost execution permits observation recovery but never redispatch',async()=>{
 const {CapabilityExecution}=await view();
 const html=renderToStaticMarkup(createElement(CapabilityExecution,{decision,records:[{...record,status:'recovery_required',recoveryRequired:true}],advanced:false,post}));
 assert.match(html,/기존 실행 종료 확인/);assert.doesNotMatch(html,/승인하고 실행|실행 계획 확인|품질 검증 계획 확인/);
});
test('completed execution exposes quality preview before approval; foreign records are excluded',async()=>{
 const {CapabilityExecution}=await view();
 const html=renderToStaticMarkup(createElement(CapabilityExecution,{decision,records:[{...record,status:'execution_completed',runId:'run'}],advanced:false,post}));
 assert.match(html,/응답 완료 · 품질 검증 전/);assert.match(html,/독립성이 확인되어야/);assert.match(html,/<button disabled="">품질 검증 계획 확인/);assert.doesNotMatch(html,/승인하고 품질 검증/);
 const foreign=renderToStaticMarkup(createElement(CapabilityExecution,{decision,records:[{...record,projectId:'other'}],advanced:false,post,canPlan:true}));assert.doesNotMatch(foreign,/실행 승인 대기/);
});


test('progress reads scoped execution contracts without dispatching or altering durable state',async()=>{
 const {fixture}=await import('./capability-fixtures.ts');
 const {ProjectProgressService}=await import('../server/project-progress.ts');
 const f=fixture();try{
  f.store.db.exec('CREATE TABLE capability_executions(id TEXT PRIMARY KEY,project_id TEXT,body TEXT)');
  const stored={...record,taskId:f.task.id,dispatchRequestId:'request-no-run'};
  const insert=f.store.db.prepare('INSERT INTO capability_executions VALUES(?,?,?)');
  insert.run('execution','p',JSON.stringify(stored));insert.run('other-task','p',JSON.stringify({...stored,id:'other-task',taskId:'other'}));
  const before=f.store.lastSeq(),service=new ProjectProgressService(f.store,f.studio);
  const progress=service.read('p',{});assert.deepEqual(progress.tasks[0].capabilityExecutions?.map(r=>r.id),['execution']);
  assert.equal(progress.tasks[0].capabilityExecutions?.[0].models.actualModelId,'unknown');
  assert.equal(f.store.lastSeq(),before);assert.equal(f.store.runs().length,0);
  assert.equal(f.store.db.prepare('SELECT body FROM capability_executions WHERE id=?').get('execution')?.body,JSON.stringify(stored));
 }finally{f.store.close();}
});
