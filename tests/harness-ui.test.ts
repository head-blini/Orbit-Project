import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {HarnessEvaluationView,HarnessProjectView,HarnessTargetView,HarnessVersionView} from '../shared/harness.ts';

async function load(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/harness.tsx');}finally{hooks.deregister();}
}
const v0:HarnessVersionView={versionId:'harness-v0-claude_task',revision:0,digest:'0'.repeat(64),parentId:null,origin:'baseline',createdAt:null,lines:[],evidence:null,
  classification:{status:'eligible'},evaluations:[],approvals:[],windows:[]};
const evaluation=(over:Partial<HarnessEvaluationView>):HarnessEvaluationView=>({evaluationId:'e1',state:'ok',verdict:'unverified',runnerMode:'fake',reasons:['HARNESS_EVAL_FAKE_RUNNER'],
  createdAt:'2026-10-29T01:00:00.000Z',evaluationDigest:'e'.repeat(64),verified:false,...over});
const candidate=(over:Partial<HarnessVersionView>):HarnessVersionView=>({versionId:'v1',revision:1,digest:'1'.repeat(64),parentId:v0.versionId,origin:'rule',createdAt:'2026-10-29T00:00:00.000Z',
  lines:['관찰한 결과만 보고한다.'],evidence:{familyIds:['f'],caseIds:['c'],indexerVersion:'fe-2'},classification:{status:'eligible'},evaluations:[],approvals:[],windows:[],...over});
const target=(versions:HarnessVersionView[]):HarnessTargetView=>({target:'claude_task',state:'ok',error:null,activeVersionId:v0.versionId,activeRevision:0,pointerSequence:0,history:[],versions:[v0,...versions]});
const view=(versions:HarnessVersionView[]):HarnessProjectView=>({projectId:'p',runnerMode:'fake',targets:[target(versions),
  {target:'repair',state:'error',error:'HARNESS_INTEGRITY',activeVersionId:null,activeRevision:null,pointerSequence:null,history:[],versions:[]}]});
const actions={generate:()=>{},propose:()=>{},evaluate:()=>{},approve:()=>{},promote:()=>{},rollback:()=>{}};
const button=(html:string,label:string)=>html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0]??'';

test('simple mode: plain language, unverified evaluation is never an improvement, no actions',async()=>{
  const {HarnessBody}=await load();
  const html=renderToStaticMarkup(createElement(HarnessBody,{view:view([candidate({evaluations:[evaluation({})]})]),advanced:false,actions}));
  assert.match(html,/작업 지침 개선 제안/);assert.match(html,/검증되지 않음/);assert.match(html,/기본 지침 사용 중/);
  assert.ok(!html.includes('<button')&&!html.includes('HARNESS_')&&!html.includes('검증됨')&&!html.includes('개선됨'));
  const verified=renderToStaticMarkup(createElement(HarnessBody,{view:view([candidate({evaluations:[evaluation({verdict:'passed',runnerMode:'live',verified:true,reasons:[]})]})]),advanced:false}));
  assert.match(verified,/승인 필요/);
});

test('advanced mode: promotion button is disabled unless a fresh approval exists',async()=>{
  const {HarnessBody}=await load();
  const passed=evaluation({verdict:'passed',runnerMode:'live',verified:true,reasons:[]});
  const approval={requestId:'a1',evaluationId:'e1',approvedAt:'2026-10-29T02:00:00.000Z',evaluationDigest:'e'.repeat(64),candidateDigest:'1'.repeat(64)};
  const render=(v:HarnessVersionView)=>renderToStaticMarkup(createElement(HarnessBody,{view:view([v]),advanced:true,actions}));
  const unverified=render(candidate({evaluations:[evaluation({})]}));
  assert.match(unverified,/검증되지 않음 \(개선으로 세지 않음\)/);assert.match(unverified,/모의/);
  assert.match(button(unverified,'적용 승인'),/disabled/);assert.match(button(unverified,'승인된 지침 적용'),/disabled/);
  // A passed fake evaluation (should never exist) still does not count.
  assert.match(button(render(candidate({evaluations:[evaluation({verdict:'passed',runnerMode:'fake',verified:false})]})),'적용 승인'),/disabled/);
  const stale=render(candidate({evaluations:[passed],approvals:[{...approval,fresh:false}]}));
  assert.ok(!/disabled/.test(button(stale,'적용 승인')));assert.match(button(stale,'승인된 지침 적용'),/disabled/);assert.match(stale,/만료됨/);
  const fresh=render(candidate({evaluations:[passed],approvals:[{...approval,fresh:true}]}));
  assert.ok(button(fresh,'승인된 지침 적용')&&!/disabled/.test(button(fresh,'승인된 지침 적용')));
  const blocked=render(candidate({evaluations:[passed],approvals:[{...approval,fresh:true}],classification:{status:'blocked',reasons:['HARNESS_POLICY_OVERRIDE']}}));
  assert.match(button(blocked,'승인된 지침 적용'),/disabled/);assert.match(blocked,/HARNESS_POLICY_OVERRIDE/);
  assert.match(fresh,/HARNESS_INTEGRITY/);// broken target surfaced, not hidden
});

test('rollback is offered only to previously active ancestors or v0, and recurrence only proposes it',async()=>{
  const {HarnessBody}=await load();
  const v1=candidate({windows:[{startSequence:1,startedAt:'2026-10-29T03:00:00.000Z',endedAt:null,status:'recurrence_observed',rollbackProposed:true,families:[]}]});
  const t:HarnessTargetView={...target([v1]),activeVersionId:'v1',activeRevision:1,pointerSequence:1,
    history:[{sequence:1,kind:'promotion',versionId:'v1',fromVersionId:v0.versionId,requestId:'a1',createdAt:'2026-10-29T03:00:00.000Z'}]};
  const html=renderToStaticMarkup(createElement(HarnessBody,{view:{projectId:'p',runnerMode:null,targets:[t]},advanced:true,actions}));
  assert.match(html,/추가 지침 v1 사용 중/);assert.match(html,/되돌리는 것을 검토해 보세요. 자동으로 되돌리지 않습니다/);
  assert.equal(html.split('기본 지침으로 되돌리기').length-1,1);assert.ok(!html.includes('v1(으)로 되돌리기'));
});

test('suite: simple mode shows plain-language counts only; advanced mode lists manifests with register/remove controls',async()=>{
  const {HarnessBody}=await load();
  const suiteCase={caseId:'case-1',projectId:'p',target:'claude_task' as const,protected:true,runId:'run-1',taskId:'task-1',completionBindingDigest:'b'.repeat(64),
    policyDigest:'c'.repeat(64),artifactDigest:null,digest:'d'.repeat(64),requestId:'r',registeredAt:'2026-10-30T00:00:00.000Z'};
  const withSuite:HarnessProjectView={...view([]),suite:{state:'ok',error:null,cases:[suiteCase],targets:[
    {target:'claude_task',normal:0,protected:1,digest:'e'.repeat(64)},{target:'repair',normal:0,protected:0,digest:'f'.repeat(64)}]}};
  const simple=renderToStaticMarkup(createElement(HarnessBody,{view:withSuite,advanced:false,actions:{...actions,registerSuite:()=>{},removeSuite:()=>{}}}));
  assert.match(simple,/정상 작업 0개 · 보호 작업 1개/);assert.match(simple,/둘 다 1개 이상 있어야 평가할 수 있습니다/);
  assert.ok(!simple.includes('<button')&&!simple.includes('run-1')&&!simple.includes('<form'));
  const advanced=renderToStaticMarkup(createElement(HarnessBody,{view:withSuite,advanced:true,actions:{...actions,registerSuite:()=>{},removeSuite:()=>{}}}));
  assert.match(advanced,/<code>run-1<\/code>/);assert.ok(button(advanced,'평가 기준에서 빼기'));assert.match(advanced,/통과 작업 등록/);
  const broken=renderToStaticMarkup(createElement(HarnessBody,{view:{...withSuite,suite:{state:'error',error:'HARNESS_INTEGRITY',cases:[],targets:[]}},advanced:false}));
  assert.match(broken,/읽을 수 없습니다/);assert.ok(!broken.includes('HARNESS_'));
});
