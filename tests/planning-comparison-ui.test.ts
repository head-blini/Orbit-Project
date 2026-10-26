import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {PlanningComparison,PlanningComparisonProps} from '../shared/planning-revisions.ts';

async function components(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,nextLoad){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return nextLoad(url,context);
  }});
  try{return await import('../web/planning/PlanningComparison.tsx');}finally{hooks.deregister();}
}
const draft:PlanningVersion['draft']={schemaVersion:'1.0',title:'Fixture plan',goal:'Fixture goal',requirements:[
  {label:'REQ-01',description:'Changed description',acceptanceCriteria:['New criterion']},
  {label:'REQ-02',description:'Added description',acceptanceCriteria:['Added criterion']},
],constraints:[],openQuestions:[],source:'manual'};
const base:PlanningVersion={id:'plan-base',projectId:'project-a',lineageId:'lineage-a',revision:2,contentHash:'b'.repeat(64),state:'superseded',draft};
const target:PlanningVersion={...base,id:'plan-target',revision:3,contentHash:'c'.repeat(64),state:'approved'};
const older:PlanningVersion={...base,id:'plan-older',revision:1,contentHash:'a'.repeat(64)};
const preview:PlanningComparison={projectId:'project-a',base,target,fields:[{field:'goal',before:'Old goal',after:'<script>hostile()</script>'}],requirements:[
  {label:'REQ-01',status:'changed',before:{label:'REQ-01',description:'Old description',acceptanceCriteria:['Old criterion']},after:draft.requirements[0]},
  {label:'REQ-02',status:'added',before:null,after:draft.requirements[1]},
  {label:'REQ-OLD',status:'removed',before:{label:'REQ-OLD',description:'Removed description',acceptanceCriteria:['Removed criterion']},after:null},
],affectedTasks:[{taskId:'task-<img src=x>',planningVersionId:'plan-base',requirementLabels:['REQ-01'],reasons:['requirement_changed','plan_context_changed']}],targetCurrent:true,canReplan:true,previewDigest:'d'.repeat(64),availableLabels:['REQ-01','REQ-02'],existingLabels:[]};
const saved:SavedTask={id:'task-followup',projectId:'project-a',title:'Followup',description:'Followup description',acceptanceCriteria:['Criterion'],planningVersionId:'plan-target',requirementLabels:['REQ-02'],state:'draft',verification:'not_run',createdAt:'2026-10-26T00:00:00.000Z'};
const scope={projectId:'project-a',base,target,dirty:false,busy:false};
const callbacks={onCompare:async()=>preview,onReplan:async()=>[saved]};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('comparison choices exclude foreign projects, unrelated lineages and non-earlier saved versions',async()=>{
  const {planningComparisonChoices}=await components();
  const versions=[older,{...base,id:'foreign',projectId:'other'},target,{...base,id:'unrelated',lineageId:'other'},base,{...base,id:'newer',revision:4}];
  assert.deepEqual(planningComparisonChoices('project-a',versions,target).map(value=>value.id),['plan-base','plan-older']);
  assert.deepEqual(planningComparisonChoices('project-a',versions,{...target,contentHash:'stale'}),[]);
  assert.deepEqual(planningComparisonChoices('other',versions,target),[]);
  assert.deepEqual(planningComparisonChoices('project-a',versions,undefined),[]);
  assert.deepEqual(planningComparisonChoices('project-a',[{...older,lineageId:undefined},{...target,lineageId:undefined}],{...target,lineageId:undefined}),[],'unrelated legacy versions must not share an invented lineage');
});

test('comparison panel SSR is inert, defaults to latest earlier version and blocks unsaved or unavailable comparisons',async()=>{
  const {PlanningComparisonPanel}=await components();let calls=0;
  const props:PlanningComparisonProps={projectId:'project-a',selected:target,versions:[older,target,base],dirty:false,busy:false,onCompare:async()=>{calls++;return preview;},onReplan:async()=>{calls++;return [saved];}};
  const render=(changes:Partial<PlanningComparisonProps>={})=>renderToStaticMarkup(createElement(PlanningComparisonPanel,{...props,...changes}));
  const html=render();assert.match(html,/<option value="plan-base" selected=""/);assert.match(html,/저장 버전 비교/);assert.doesNotMatch(html,/<button[^>]*disabled/);assert.equal(calls,0);
  assert.doesNotMatch(html,/type="checkbox"/,'consent is only available after explicit preview');
  for(const changes of [{dirty:true},{busy:true},{selected:undefined},{versions:[target]},{projectId:'foreign'}])assert.match(render(changes),/<button[^>]*disabled[^>]*>저장 버전 비교/);
  const escaped=render({versions:[target,{...base,draft:{...draft,title:'<img src=x>'}}]});assert.match(escaped,/&lt;img src=x&gt;/);assert.doesNotMatch(escaped,/<img/);
});

test('scope identity changes invalidate previews for project, target, base, dirty, busy and saved head changes',async()=>{
  const {planningComparisonScopeKey}=await components();
  const props={projectId:'project-a',selected:target,versions:[base,target],dirty:false,busy:false};
  const initial=planningComparisonScopeKey(props);
  for(const change of [{projectId:'other'},{selected:{...target,state:'superseded' as const}},{selected:{...target,contentHash:'changed'}},{dirty:true},{busy:true},{versions:[{...base,contentHash:'changed'},target]},{versions:[base,target,{...target,id:'next',revision:4}]}])assert.notEqual(planningComparisonScopeKey({...props,...change}),initial);
  assert.equal(planningComparisonScopeKey({...props,versions:[target,base]}),initial,'list ordering alone does not invalidate consent');
});

test('production coordinator blocks duplicate compares and stale responses cannot release a newer request',async()=>{
  const {createPlanningComparisonCoordinator}=await components();const first=deferred<PlanningComparison>(),second=deferred<PlanningComparison>();let calls=0;
  const order=createPlanningComparisonCoordinator(scope,{...callbacks,onCompare:async()=>{calls++;return calls===1?first.promise:second.promise;}});
  order.activate();const old=order.compare();await order.compare();assert.equal(calls,1);assert.equal(order.getSnapshot().pending,'compare');
  order.dispose();order.activate();const current=order.compare();assert.equal(calls,2);
  first.resolve(preview);await old;assert.equal(order.getSnapshot().preview,null);assert.equal(order.getSnapshot().pending,'compare');
  await order.compare();assert.equal(calls,2,'old finally must not unlock the new request');
  second.resolve({...preview,previewDigest:'fresh'});await current;assert.equal(order.getSnapshot().preview?.previewDigest,'fresh');assert.equal(order.getSnapshot().pending,null);
  order.dispose();await order.compare();assert.equal(calls,2);
});

test('coordinator requires fresh matching preview, available labels, explicit consent and current approved target',async()=>{
  const {createPlanningComparisonCoordinator}=await components();let mutations=0;
  for(const changes of [{dirty:true},{busy:true},{target:{...target,state:'draft' as const}}]){
    const order=createPlanningComparisonCoordinator({...scope,...changes},{...callbacks,onReplan:async()=>{mutations++;return [saved];}});order.activate();await order.compare();order.select('REQ-02',true);order.consent(true);await order.replan();assert.equal(mutations,0);
  }
  for(const changes of [{targetCurrent:false},{canReplan:false}]){
    const order=createPlanningComparisonCoordinator(scope,{...callbacks,onCompare:async()=>({...preview,...changes}),onReplan:async()=>{mutations++;return [saved];}});order.activate();await order.compare();order.select('REQ-02',true);order.consent(true);await order.replan();assert.equal(mutations,0);
  }
  const order=createPlanningComparisonCoordinator(scope,{...callbacks,onCompare:async()=>({...preview,existingLabels:['REQ-01']}),onReplan:async()=>{mutations++;return [saved];}});order.activate();await order.replan();assert.equal(mutations,0);await order.compare();
  order.select('REQ-OLD',true);order.select('REQ-01',true);order.consent(true);await order.replan();assert.deepEqual(order.getSnapshot().selectedLabels,[]);assert.equal(mutations,0);
  order.select('REQ-02',true);await order.replan();assert.equal(mutations,0);order.consent(true);order.select('REQ-02',false);assert.equal(order.getSnapshot().consent,false);
});

test('successful creation submits exact selection once, clears consent and refreshes the preview digest',async()=>{
  const {createPlanningComparisonCoordinator}=await components();const creation=deferred<SavedTask[]>();const seen:unknown[]=[];let compares=0;
  const order=createPlanningComparisonCoordinator(scope,{onCompare:async(...args)=>{seen.push(args);return compares++===0?preview:{...preview,previewDigest:'fresh-after-create',existingLabels:['REQ-02']};},onReplan:async(...args)=>{seen.push(args);return creation.promise;}});
  order.activate();assert.equal(seen.length,0);await order.compare();order.select('REQ-02',true);order.consent(true);
  const pending=order.replan();await order.replan();assert.equal(seen.length,2);assert.equal(order.getSnapshot().consent,false);assert.equal(order.getSnapshot().pending,'replan');
  creation.resolve([saved]);await pending;
  assert.deepEqual(seen,[['project-a','plan-target','plan-base'],['project-a','plan-target',{baseVersionId:'plan-base',expectedPreviewDigest:'d'.repeat(64),requirementLabels:['REQ-02']}],['project-a','plan-target','plan-base']]);
  assert.equal(order.getSnapshot().preview?.previewDigest,'fresh-after-create');assert.deepEqual(order.getSnapshot().selectedLabels,[]);assert.equal(order.getSnapshot().consent,false);assert.match(order.getSnapshot().message,/모델.*실행되지/);
  order.consent(true);await order.replan();assert.equal(seen.length,3);
});

test('selection is capped at 100 and scope disposal drops consent, selection and late replan followup',async()=>{
  const {createPlanningComparisonCoordinator}=await components();const creation=deferred<SavedTask[]>();let compares=0;
  const labels=Array.from({length:101},(_,index)=>`REQ-${index}`);
  const order=createPlanningComparisonCoordinator(scope,{onCompare:async()=>{compares++;return {...preview,availableLabels:labels};},onReplan:async()=>creation.promise});order.activate();await order.compare();
  for(const label of labels)order.select(label,true);assert.equal(order.getSnapshot().selectedLabels.length,100);assert.equal(order.getSnapshot().selectedLabels.includes('REQ-100'),false);
  order.consent(true);const pending=order.replan();order.dispose();assert.equal(order.getSnapshot().preview,null);assert.equal(order.getSnapshot().consent,false);assert.deepEqual(order.getSnapshot().selectedLabels,[]);
  order.activate();await order.compare();creation.resolve([saved]);await pending;assert.equal(compares,2,'late successful mutation must not refresh another scope');assert.equal(order.getSnapshot().message,'');
});

test('mismatched preview is rejected and acknowledged creation remains visible if fresh comparison fails',async()=>{
  const {createPlanningComparisonCoordinator}=await components();
  for(const changes of [{projectId:'foreign'},{target:{...target,contentHash:'foreign'}},{base:{...base,id:'foreign'}}]){
    const order=createPlanningComparisonCoordinator(scope,{...callbacks,onCompare:async()=>({...preview,...changes})});order.activate();await order.compare();assert.equal(order.getSnapshot().preview,null);assert.ok(order.getSnapshot().error);
  }
  let calls=0;const order=createPlanningComparisonCoordinator(scope,{...callbacks,onCompare:async()=>{if(calls++)throw new Error('refresh unavailable');return preview;}});order.activate();await order.compare();order.select('REQ-02',true);order.consent(true);await order.replan();
  assert.equal(order.getSnapshot().preview,null);assert.match(order.getSnapshot().message,/초안/);assert.match(order.getSnapshot().error,/다시 비교/);assert.equal(order.getSnapshot().consent,false);
});

test('rejected or stale creation clears its digest and consent before another explicit compare',async()=>{
  const {createPlanningComparisonCoordinator}=await components();let compares=0,mutations=0;
  const order=createPlanningComparisonCoordinator(scope,{onCompare:async()=>{compares++;return preview;},onReplan:async()=>{mutations++;throw new Error('STALE_PREVIEW');}});
  order.activate();await order.compare();order.select('REQ-02',true);order.consent(true);await order.replan();
  const state=order.getSnapshot();assert.equal(state.pending,null);assert.equal(state.preview,null);assert.equal(state.consent,false);assert.deepEqual(state.selectedLabels,[]);assert.match(state.error,/다시 비교/);assert.equal(state.message,'');
  order.consent(true);await order.replan();assert.equal(mutations,1);assert.equal(compares,1);
  await order.compare();assert.equal(compares,2);assert.equal(order.getSnapshot().error,'');assert.equal(order.getSnapshot().consent,false);
});

test('preview SSR escapes before and after text, displays affected identities and requires unchecked separate consent',async()=>{
  const {PlanningComparisonPreview}=await components();let calls=0;
  const render=(changes:object={})=>renderToStaticMarkup(createElement(PlanningComparisonPreview,{comparison:preview,selectedLabels:[],consent:false,disabled:false,onSelect:()=>{calls++;},onConsent:()=>{calls++;},onCreate:()=>{calls++;},...changes}));
  const html=render();assert.equal(calls,0);assert.match(html,/Old goal/);assert.match(html,/&lt;script&gt;hostile\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script|<img|href="https:/);
  assert.match(html,/Old description/);assert.match(html,/Changed description/);assert.match(html,/Old criterion/);assert.match(html,/New criterion/);assert.match(html,/Removed description/);assert.match(html,/task-&lt;img src=x&gt;/);assert.match(html,/plan-base/);
  assert.match(html,/별도 동의/);assert.doesNotMatch(html,/checked=""/);assert.match(html,/<button[^>]*disabled[^>]*>선택한 후속 Task 초안 생성/);
  const ready=render({selectedLabels:['REQ-02'],consent:true});assert.doesNotMatch(ready,/<button[^>]*disabled/);
  for(const changes of [{disabled:true},{comparison:{...preview,targetCurrent:false}},{comparison:{...preview,canReplan:false}},{comparison:{...preview,target:{...target,state:'draft'}}},{selectedLabels:['REQ-OLD']},{selectedLabels:['REQ-02','REQ-02']},{comparison:{...preview,existingLabels:['REQ-02']}}])assert.match(render({selectedLabels:['REQ-02'],consent:true,...changes}),/<button[^>]*disabled[^>]*>선택한 후속 Task 초안 생성/);
});
