import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {WorkflowDefinition,WorkflowVersion,WorkflowPreview,WorkflowRun} from '../shared/workflows.ts';
import type {VerificationCommandPreview} from '../shared/verification.ts';
async function components(){
  const target=new URL('../web/workflows.tsx',import.meta.url).href;assert.ok(existsSync(new URL(target)),'Workflow UI is not implemented');
  const hooks=registerHooks({load(url,context,nextLoad){if(url===target)return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return nextLoad(url,context);}});
  try{return await import('../web/workflows.tsx');}finally{hooks.deregister();}
}
const commands:VerificationCommandPreview[]=[{id:'check-a',label:'Registered check',executable:'fixed-node',args:['--test','fixture.test.mjs'],timeoutMs:2000,configDigest:'a'.repeat(64)}];
const definition:WorkflowDefinition={name:'Local fixture',steps:[{id:'step-1',commandId:'check-a',dependsOn:[]},{id:'step-2',commandId:'check-a',dependsOn:['step-1']}]};
const version:WorkflowVersion={id:'version-a',workflowId:'workflow-a',projectId:'project-a',revision:1,definition,definitionDigest:'b'.repeat(64),createdAt:''};
const preview:WorkflowPreview={projectId:'project-a',workspaceId:'workspace-a',workflowId:'workflow-a',versionId:version.id,definitionDigest:version.definitionDigest,sourceDigest:'c'.repeat(64),baseSha:'d'.repeat(40),configDigest:'e'.repeat(64),previewDigest:'f'.repeat(64),name:definition.name,steps:definition.steps.map(step=>({...step,command:commands[0]})),totalTimeoutMs:4000,scope:'Registered local OS commands only'};
const run=(status:WorkflowRun['status']='failed'):WorkflowRun=>({id:'run-a',projectId:'project-a',workspaceId:'workspace-a',workflowId:version.workflowId,versionId:version.id,definitionDigest:version.definitionDigest,sourceDigest:preview.sourceDigest,baseSha:preview.baseSha,configDigest:preview.configDigest,status,steps:definition.steps.map((step,index)=>({...step,status:index?'skipped':status,startedAt:'',finishedAt:'',exitCode:index?null:7,durationMs:1,output:'<script>untrusted()</script>',truncated:false,sourceDigest:preview.sourceDigest,finishedDigest:preview.sourceDigest})),retryOfId:null,attempt:1,createdAt:'',finishedAt:null,recoveredAt:null,issue:null});

test('workflow production epoch rejects stale reads, duplicate actions, edits and disposed scopes',async()=>{
  const {createWorkflowRequestEpoch,acknowledgeWorkflowRead}=await components(),epoch=createWorkflowRequestEpoch();assert.equal(epoch.read(),null);epoch.reset();
  const read=epoch.read()!,post=epoch.beginAction()!;assert.equal(epoch.isCurrent(read),false);assert.equal(epoch.beginAction(),null);assert.equal(epoch.read(),null);assert.equal(epoch.invalidate(),false);
  assert.equal(epoch.finishAction(post),true);const next=epoch.read()!;assert.equal(epoch.invalidate(),true);assert.equal(epoch.isCurrent(next),false);
  const old=epoch.beginAction()!;epoch.dispose();epoch.reset();assert.equal(epoch.isCurrent(old),false);assert.equal(epoch.finishAction(old),false);
  assert.equal(acknowledgeWorkflowRead('manual',true),true);assert.equal(acknowledgeWorkflowRead('manual',false),false);assert.equal(acknowledgeWorkflowRead('poll',true),false);assert.equal(acknowledgeWorkflowRead('after-action',true),false);
});

test('workflow editor accepts registered bounded DAGs and rejects cycles, missing dependencies and timeout overflow',async()=>{
  const {workflowDraftIssue}=await components();assert.equal(workflowDraftIssue(definition,commands),null);
  assert.ok(workflowDraftIssue({...definition,steps:[]},commands));assert.ok(workflowDraftIssue({...definition,steps:[{id:'one',commandId:'arbitrary-command',dependsOn:[]}]},commands));
  assert.ok(workflowDraftIssue({...definition,steps:[{id:'a',commandId:'check-a',dependsOn:['b']},{id:'b',commandId:'check-a',dependsOn:['a']}]},commands));
  assert.ok(workflowDraftIssue({...definition,steps:[{id:'a',commandId:'check-a',dependsOn:['missing']}]},commands));
  assert.ok(workflowDraftIssue(definition,[{...commands[0],timeoutMs:400000}]));assert.ok(workflowDraftIssue({...definition,steps:Array.from({length:13},(_,index)=>({id:'s'+index,commandId:'check-a',dependsOn:[]}))},commands));
});

test('preview bindings require the current saved version, workspace and exact command configuration',async()=>{
  const {workflowPreviewMatches,sameWorkflowPreview}=await components();const scope={projectId:'project-a',workspaceId:'workspace-a',version,versions:[version],commands};
  assert.equal(workflowPreviewMatches(preview,scope),true);assert.equal(sameWorkflowPreview(preview,{...preview}),true);
  for(const change of [{projectId:'foreign'},{workspaceId:'foreign'},{versionId:'old'},{definitionDigest:'old'}])assert.equal(workflowPreviewMatches({...preview,...change},scope),false);
  assert.equal(workflowPreviewMatches(preview,{...scope,versions:[version,{...version,id:'new-version',revision:2}]}),false);
  assert.equal(workflowPreviewMatches(preview,{...scope,commands:[{...commands[0],configDigest:'changed'}]}),false);
  assert.equal(workflowPreviewMatches({...preview,steps:[preview.steps[0],preview.steps[0]]},scope),false,'duplicate preview steps cannot stand in for the complete saved definition');
  for(const change of [{sourceDigest:'changed'},{configDigest:'changed'},{baseSha:'changed'},{previewDigest:'changed'}])assert.equal(sameWorkflowPreview(preview,{...preview,...change}),false);
});

test('explicit retry requires the same unchanged context and never branches or retries lost, stale or passed work',async()=>{
  const {workflowRetryMatches}=await components();assert.equal(workflowRetryMatches(run(),preview,[run()]),true);
  for(const status of ['lost','passed','running','stale'] as const)assert.equal(workflowRetryMatches(run(status),preview,[run(status)]),false);
  assert.equal(workflowRetryMatches({...run(),attempt:3},preview,[]),false);
  assert.equal(workflowRetryMatches(run(),{...preview,sourceDigest:'changed'},[]),false);
  assert.equal(workflowRetryMatches(run(),preview,[run(),{...run(),id:'child',retryOfId:'run-a',attempt:2}]),false);
});

test('workflow SSR is inert and exposes only registered command editing plus full preview and separate consent',async()=>{
  const {WorkflowsPanel,WorkflowEditor,WorkflowExecution}=await components();
  const empty=renderToStaticMarkup(createElement(WorkflowsPanel,{projectId:'',workspaceId:null,online:false,busy:false,post:async()=>{throw Error('SSR must not POST');}}));assert.match(empty,/OS 사용자 권한/);assert.match(empty,/예약/);assert.match(empty,/AI/);assert.match(empty,/프로젝트/);assert.doesNotMatch(empty,/type="password"/);
  const editor=renderToStaticMarkup(createElement(WorkflowEditor,{definition,commands,disabled:false,onChange:()=>{}}));assert.match(editor,/Registered check/);assert.match(editor,/dependsOn/);assert.doesNotMatch(editor,/<input[^>]*name="(?:executable|args|cwd|env)"|<textarea/);
  const ready=renderToStaticMarkup(createElement(WorkflowExecution,{preview,confirmed:false,canExecute:false,retryRun:null,onConsent:()=>{},onStart:()=>{}}));assert.match(ready,/fixed-node/);assert.match(ready,/--test/);assert.match(ready,/fixture.test.mjs/);assert.match(ready,/2000/);assert.match(ready,new RegExp(preview.sourceDigest));assert.match(ready,/<button[^>]*disabled[^>]*>승인한 워크플로 실행/);
});

test('workflow history escapes output, separates passed from review approval and permits running interruption during other busy work',async()=>{
  const {WorkflowHistory}=await components(),running=run('running'),lost={...run('lost'),id:'lost'};
  const props={projectId:'project-a',workspaceId:'workspace-a',runs:[running,lost,{...run('passed'),id:'passed'},{...run(),id:'foreign',projectId:'project-b',issue:'FOREIGN_PRIVATE'}],online:true,actionBusy:false,otherBusy:true,recoveryConsent:null,onInterrupt:()=>{},onRetry:()=>{},onRecover:()=>{},onRecoveryConsent:()=>{}};
  const html=renderToStaticMarkup(createElement(WorkflowHistory,props));assert.match(html,/&lt;script&gt;untrusted\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script|FOREIGN_PRIVATE/);assert.match(html,/리뷰·병합 아님/);assert.match(html,/재시작·결과 미확인/);
  assert.match(html,/<button(?![^>]*disabled)[^>]*>워크플로 중단/);assert.match(html,/이전 프로세스가 종료되었음을 확인/);assert.match(html,/<button[^>]*disabled[^>]*>종료 확인 후 복구/);
});
