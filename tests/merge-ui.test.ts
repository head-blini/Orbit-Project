import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {MergeRecord,MergeView} from '../shared/merge.ts';

async function components(){
  const target=new URL('../web/merge.tsx',import.meta.url).href;assert.ok(existsSync(new URL(target)),'Merge UI is not implemented');
  const hooks=registerHooks({load(url,context,nextLoad){if(url===target)return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return nextLoad(url,context);}});
  try{return await import('../web/merge.tsx');}finally{hooks.deregister();}
}
const row=(status:MergeRecord['status']='prepared'):MergeRecord=>({id:'record-a',projectId:'project-a',workspaceId:'workspace-a',runId:'run-a',sourceDigest:'a'.repeat(64),checkSetDigest:'b'.repeat(64),approvalId:'approval-a',
  target:{branch:'main',head:'c'.repeat(40),treeSha:'d'.repeat(40)},candidate:{commitSha:'e'.repeat(40),treeSha:'f'.repeat(40),branch:'orbit/candidate-a'},phase:status==='prepared'?'prepare':'apply',status,issue:null,completionBasis:status==='applied'?'git_and_bytes':null,createdAt:'',updatedAt:''});
const view=(record=row()):MergeView=>({projectId:'project-a',workspaceId:'workspace-a',runId:'run-a',available:true,issue:null,canPrepare:true,sourceDigest:record.sourceDigest,checkSetDigest:record.checkSetDigest,approvalId:record.approvalId,target:record.target,busy:false,recoveryRequired:false,records:[record],scope:'same-base clean primary only'});

test('production merge epoch prevents old GETs, duplicate POSTs and cross-scope publication',async()=>{
  const {createMergeRequestEpoch}=await components(),order=createMergeRequestEpoch();assert.equal(order.read(),null);order.reset();
  const first=order.read()!,mutation=order.beginMutation()!;assert.equal(order.isCurrent(first),false);assert.equal(order.read(),null);assert.equal(order.beginMutation(),null);assert.equal(order.changeSelection(),false);
  assert.equal(order.isCurrent(mutation),true);assert.equal(order.endMutation(mutation),true);const current=order.read()!;assert.equal(order.isCurrent(mutation),false);
  assert.equal(order.changeSelection(),true);assert.equal(order.isCurrent(current),false);
  const pending=order.beginMutation()!;order.dispose();assert.equal(order.isCurrent(pending),false);assert.equal(order.sameScope(pending),false);assert.equal(order.endMutation(pending),false);order.reset();assert.equal(order.isCurrent(pending),false);
});

test('only successful explicit manual read acknowledges uncertainty and fresh gates still require new consent',async()=>{
  const ui=await components();assert.equal(typeof ui.acknowledgeMergeRead,'function');
  const {acknowledgeMergeRead,mergeActionAvailability}=ui;
  assert.equal(acknowledgeMergeRead('manual',true),true);
  for(const mode of ['poll','after-mutation'] as const){assert.equal(acknowledgeMergeRead(mode,true),false);assert.equal(acknowledgeMergeRead(mode,false),false);}
  assert.equal(acknowledgeMergeRead('manual',false),false,'failed refresh cannot release an uncertain mutation');
  const ready={online:true,busy:false,fresh:true,uncertain:true,applyConfirmed:false,recoveryConfirmed:false};
  const unlocked={...ready,uncertain:!acknowledgeMergeRead('manual',true)};
  assert.equal(mergeActionAvailability(view(),row(),ready).prepare,false);assert.equal(mergeActionAvailability(view(),row(),unlocked).prepare,true);
  assert.equal(mergeActionAvailability(view(),row(),unlocked).apply,false,'acknowledgment never grants apply consent');
  assert.equal(mergeActionAvailability(view(),row(),{...unlocked,applyConfirmed:true}).apply,true);
  assert.equal(mergeActionAvailability({...view(),canPrepare:false},row(),{...unlocked,applyConfirmed:true}).apply,false,'unsafe server state remains blocked');
});

test('merge action gates require current bindings, explicit consent, and terminal uncertainty recovery',async()=>{
  const {mergeActionAvailability}=await components(),record=row(),current=view(record),ready={online:true,busy:false,fresh:true,uncertain:false,applyConfirmed:false,recoveryConfirmed:false};
  assert.deepEqual(mergeActionAvailability(current,record,ready),{prepare:true,apply:false,recover:false});assert.equal(mergeActionAvailability(current,record,{...ready,applyConfirmed:true}).apply,true);
  for(const changed of [{sourceDigest:'x'},{checkSetDigest:'x'},{approvalId:'x'},{target:{...record.target,head:'x'}},{target:{...record.target,branch:'other'}},{runId:'other'}])assert.equal(mergeActionAvailability({...current,...changed},record,{...ready,applyConfirmed:true}).apply,false);
  for(const changed of [{busy:true},{fresh:false},{online:false},{uncertain:true}]){const state=mergeActionAvailability(current,record,{...ready,...changed,applyConfirmed:true});assert.equal(state.prepare,false);assert.equal(state.apply,false);}
  for(const status of ['failed','lost','unknown','applying','applied'] as const)assert.equal(mergeActionAvailability(view(row(status)),row(status),{...ready,applyConfirmed:true}).apply,false);
  const lost=row('lost'),recovery={...view(lost),canPrepare:false,recoveryRequired:true};assert.equal(mergeActionAvailability(recovery,lost,ready).recover,false);assert.equal(mergeActionAvailability(recovery,lost,{...ready,uncertain:true,recoveryConfirmed:true}).recover,true);
  assert.equal(mergeActionAvailability({...recovery,busy:true},lost,{...ready,recoveryConfirmed:true}).recover,false);
});

test('merge SSR separates candidate creation from primary writes and never presents unknown as applied',async()=>{
  const {MergePanel,MergeControls,MergeHistory}=await components();
  const empty=renderToStaticMarkup(createElement(MergePanel,{projectId:'project-a',workspaceId:'workspace-a',runId:null,online:false,busy:false,post:async()=>{throw new Error('SSR must not mutate');}}));
  assert.match(empty,/승인 내용의 병합 후보 만들기/);assert.match(empty,/승인한 후보를 대상 브랜치에 반영/);assert.match(empty,/primary/);assert.match(empty,/자동 재시도/);assert.doesNotMatch(empty,/<input[^>]*type="text"|<textarea/);
  const base={view:view(),record:row(),online:true,busy:false,fresh:true,uncertain:false,applyConfirmed:false,recoveryConfirmed:false,onPrepare:()=>{},onApply:()=>{},onRecover:()=>{},onApplyConsent:()=>{},onRecoveryConsent:()=>{}};
  const controls=renderToStaticMarkup(createElement(MergeControls,base));assert.match(controls,/표시된 대상 branch에 반영 승인/);assert.match(controls,/<button[^>]*disabled[^>]*>승인한 후보를 대상 브랜치에 반영/);assert.match(controls,/main/);assert.match(controls,new RegExp('e'.repeat(40)));
  const approved=renderToStaticMarkup(createElement(MergeControls,{...base,applyConfirmed:true}));assert.match(approved,/<button(?![^>]*disabled)[^>]*>승인한 후보를 대상 브랜치에 반영/);
  const recovery=renderToStaticMarkup(createElement(MergeControls,{...base,view:{...view(row('lost')),recoveryRequired:true,canPrepare:false},record:row('lost')}));assert.match(recovery,/다른 작업 공간/);assert.match(recovery,/href="#\/projects"/);assert.match(recovery,/이전 Git 프로세스가 종료되었음을 확인/);assert.match(recovery,/<button[^>]*disabled[^>]*>프로세스 종료 확인 후 상태 재확인/);
  const records=[row('failed'),{...row('lost'),id:'lost'},{...row('unknown'),id:'unknown'}, {...row('applied'),id:'no-basis',completionBasis:null}, {...row('applied'),id:'observed',completionBasis:'observed_after_recovery' as const}, {...row(),id:'foreign',projectId:'project-b',issue:'FOREIGN_PRIVATE'}];
  const history=renderToStaticMarkup(createElement(MergeHistory,{projectId:'project-a',workspaceId:'workspace-a',records}));
  assert.match(history,/실패/);assert.match(history,/재시작·결과 미확인/);assert.match(history,/결과 불확실/);assert.match(history,/적용 근거 확인 불가/);assert.match(history,/복구 조회로 적용 관찰/);assert.doesNotMatch(history,/FOREIGN_PRIVATE/);
  const hostile=renderToStaticMarkup(createElement(MergeHistory,{projectId:'project-a',workspaceId:'workspace-a',records:[{...row(),issue:'<script>hostile()</script>'}]}));assert.match(hostile,/&lt;script&gt;/);assert.doesNotMatch(hostile,/<script/);
  const bounded=renderToStaticMarkup(createElement(MergeHistory,{projectId:'project-a',workspaceId:'workspace-a',records:Array.from({length:25},(_,index)=>({...row(),id:'record-'+index}))}));assert.equal((bounded.match(/<li>/g)??[]).length,20);assert.doesNotMatch(bounded,/record-20/);
});
