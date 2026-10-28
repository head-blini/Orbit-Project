import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {PlanningDraft,PlanningVersion} from '../shared/parallel.ts';
import type {PlanningAgentPreview,PlanningAgentView,PlanningSuggestion} from '../shared/planning-agent.ts';

async function components(){
  const webRoot=new URL('../web/',import.meta.url).href,target=new URL('../web/planning/PlanningAgent.tsx',import.meta.url);assert.ok(existsSync(target),'Planning agent UI is not implemented');
  const hooks=registerHooks({load(url,context,nextLoad){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return nextLoad(url,context);
  }});
  try{return await import('../web/planning/PlanningAgent.tsx');}finally{hooks.deregister();}
}
const scope={projectId:'project-a',workspaceId:'workspace-a',online:true,busy:false};
const root='/api/projects/project-a/planning-suggestions';
const preview:PlanningAgentPreview={projectId:'project-a',workspaceId:'workspace-a',inputDigest:'a'.repeat(64),previewDigest:'b'.repeat(64),instructions:'Exact outbound instructions\n<script>input()</script>',timeoutMs:60000,turnLimit:1,scope:'Native read-only planning'};
const proposal:PlanningDraft={schemaVersion:'1.0',title:'Proposal <img src=x>',goal:'Goal <script>proposal()</script>',requirements:[{label:'REQ-01',description:'Validated requirement',acceptanceCriteria:['Acceptance']}],constraints:[],openQuestions:[],source:'manual',decisions:[{topic:'Storage',decision:'SQLite',rationale:'Local records'}],provenance:{kind:'in_app_agent',providerId:'codex',externalUrl:null}};
const row=(execution:PlanningSuggestion['execution']='completed'):PlanningSuggestion=>({id:'suggestion-a',requestId:'receipt-a',projectId:'project-a',workspaceId:'workspace-a',inputDigest:preview.inputDigest,previewDigest:preview.previewDigest,execution,proposal:execution==='completed'?proposal:null,outputDigest:execution==='completed'?'c'.repeat(64):null,issue:null,threadId:'thread-a',turnId:'turn-a',processStopped:execution!=='running'&&execution!=='lost',recoveredAt:null,createdAt:'2026-10-26T00:00:00Z',finishedAt:execution==='running'?null:'2026-10-26T00:00:01Z',durationMs:1000,timeoutMs:60000,turnLimit:1,savedPlanningVersionId:null});
const view=(records:PlanningSuggestion[]=[]):PlanningAgentView=>({projectId:'project-a',workspaceId:'workspace-a',records,busy:records.some(record=>record.execution==='running'),recoveryRequired:records.some(record=>record.execution!=='running'&&!record.processStopped&&!record.recoveredAt),timeoutMs:60000,turnLimit:1,scope:preview.scope});
const saved:PlanningVersion={id:'plan-new',projectId:'project-a',lineageId:'plan-new',revision:1,contentHash:'d'.repeat(64),state:'draft',draft:proposal};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);},values};}

test('production coordinator stays inert until explicit preview and start with separate consent and a receipt',async()=>{
  const {createPlanningAgentCoordinator}=await components();const posts:{path:string;body:Record<string,unknown>}[]=[],reads:string[]=[];const start=deferred<PlanningSuggestion>(),startPosted=deferred<void>();
  const order=createPlanningAgentCoordinator(scope,{get:async path=>{reads.push(path);return view();},post:async(path,body)=>{posts.push({path,body:body as Record<string,unknown>});if(path.endsWith('/preview'))return preview;startPosted.resolve(undefined);return start.promise;},onSaved:()=>{throw Error('Must not auto save');}});
  order.setText('Plan a local feature');order.activate();assert.equal(posts.length,0);assert.equal(reads.length,0);await order.preview();assert.equal(posts.length,0,'fresh GET is required');
  await order.refresh('poll');assert.deepEqual(reads,[root+'?workspaceId=workspace-a']);await order.preview();assert.equal(posts.length,1);assert.deepEqual(posts[0],{path:root+'/preview',body:{workspaceId:'workspace-a',text:'Plan a local feature'}});
  await order.start();assert.equal(posts.length,1);order.consent(true);const pending=order.start();await order.start();await startPosted.promise;await order.start();assert.equal(posts.length,2);assert.equal(order.getSnapshot().consent,false);
  assert.equal(posts[1].path,root+'/start');assert.match(String(posts[1].body.requestId),/^[a-f0-9-]{36}$/);assert.deepEqual({...posts[1].body,requestId:'receipt'}, {workspaceId:'workspace-a',text:'Plan a local feature',expectedPreviewDigest:'b'.repeat(64),confirmed:true,requestId:'receipt'});
  start.resolve(row('running'));await pending;assert.equal(order.getSnapshot().view?.records[0].execution,'running');assert.equal(posts.length,2);
});

test('only successful explicit GET clears mutation uncertainty, including busy, offline and same-scope remount changes',async()=>{
  const {createPlanningAgentCoordinator}=await components();const receipts=storage();let failRead=false,posts=0;
  const deps={storage:receipts,get:async()=>{if(failRead)throw Error('read unavailable');return view();},post:async(path:string)=>{posts++;if(path.endsWith('/preview'))return preview;throw Error('lost response');},onSaved:()=>{}};
  const order=createPlanningAgentCoordinator(scope,deps);order.activate();await order.refresh('poll');order.setText('Plan this');await order.preview();order.consent(true);await order.start();assert.equal(order.getSnapshot().uncertain,true);
  await order.refresh('poll');assert.equal(order.getSnapshot().uncertain,true);await order.preview();assert.equal(posts,2);
  for(const next of [{...scope,busy:true},{...scope,online:false},scope]){order.configure(next);assert.equal(order.getSnapshot().uncertain,true);}
  order.dispose();const remounted=createPlanningAgentCoordinator(scope,deps);remounted.activate();await remounted.refresh('poll');assert.equal(remounted.getSnapshot().uncertain,true);
  failRead=true;await remounted.refresh('manual');assert.equal(remounted.getSnapshot().uncertain,true);failRead=false;await remounted.refresh('manual');assert.equal(remounted.getSnapshot().uncertain,false);assert.equal(remounted.getSnapshot().preview,null);assert.equal(remounted.getSnapshot().consent,false);assert.equal(posts,2);
});

test('unusable start acknowledgement keeps the same receipt for an explicit identical retry without storing raw input',async()=>{
  const {createPlanningAgentCoordinator}=await components();const receipts=storage(),ids:string[]=[];let attempts=0;
  const order=createPlanningAgentCoordinator(scope,{storage:receipts,get:async()=>view(),post:async(path,body)=>{if(path.endsWith('/preview'))return preview;ids.push((body as {requestId:string}).requestId);return attempts++===0?{...row('running'),workspaceId:'foreign'}:row('running');},onSaved:()=>{}});
  order.activate();await order.refresh('manual');order.setText('PRIVATE_REQUEST_BODY');await order.preview();order.consent(true);await order.start();assert.equal(order.getSnapshot().uncertain,true);
  assert.doesNotMatch(JSON.stringify([...receipts.values]),/PRIVATE_REQUEST_BODY|Exact outbound instructions/);
  await order.refresh('manual');await order.preview();order.consent(true);await order.start();assert.equal(ids.length,2);assert.equal(ids[0],ids[1],'an invalid acknowledgement cannot discard the receipt of a potentially started process');
});

test('late GET cannot overwrite another workspace or release the new request lock',async()=>{
  const {createPlanningAgentCoordinator}=await components();const oldRead=deferred<PlanningAgentView>(),newRead=deferred<PlanningAgentView>();let reads=0;
  const order=createPlanningAgentCoordinator(scope,{get:async()=>++reads===1?oldRead.promise:newRead.promise,post:async()=>{throw Error('No POST');},onSaved:()=>{}});order.activate();const old=order.refresh('poll');order.configure({...scope,workspaceId:'workspace-b'});const next=order.refresh('manual');
  oldRead.resolve(view());await old;assert.equal(order.getSnapshot().view,null);assert.equal(order.getSnapshot().loading,true);await order.refresh('poll');assert.equal(reads,2);
  newRead.resolve({...view(),workspaceId:'workspace-b'});await next;assert.equal(order.getSnapshot().view?.workspaceId,'workspace-b');assert.equal(order.getSnapshot().loading,false);
});

test('editing input invalidates an in-flight preview and old completion cannot unlock a newer preview',async()=>{
  const {createPlanningAgentCoordinator}=await components();const first=deferred<PlanningAgentPreview>(),second=deferred<PlanningAgentPreview>();let posts=0;
  const order=createPlanningAgentCoordinator(scope,{get:async()=>view(),post:async()=>++posts===1?first.promise:second.promise,onSaved:()=>{}});order.activate();await order.refresh('poll');order.setText('First input');const old=order.preview();await order.preview();assert.equal(posts,1);
  order.setText('Second input');const next=order.preview();first.resolve(preview);await old;assert.equal(order.getSnapshot().preview,null);assert.equal(order.getSnapshot().action,'preview');await order.preview();assert.equal(posts,2);
  second.resolve({...preview,previewDigest:'e'.repeat(64)});await next;assert.equal(order.getSnapshot().preview?.previewDigest,'e'.repeat(64));order.consent(true);order.setText('Third input');assert.equal(order.getSnapshot().preview,null);assert.equal(order.getSnapshot().consent,false);
});

test('preview rejects foreign, malformed and non-60-second single-turn bounds and other work blocks start',async()=>{
  const {createPlanningAgentCoordinator}=await components();
  for(const patch of [{projectId:'foreign'},{workspaceId:'foreign'},{timeoutMs:120000},{turnLimit:2},{inputDigest:'bad'},{instructions:''}]){
    const order=createPlanningAgentCoordinator(scope,{get:async()=>view(),post:async()=>({...preview,...patch}),onSaved:()=>{}});order.activate();await order.refresh('poll');order.setText('Request');await order.preview();assert.equal(order.getSnapshot().preview,null);assert.ok(order.getSnapshot().error);
  }
  for(const patch of [{workspaceId:null},{online:false},{busy:true}]){
    let posts=0;const order=createPlanningAgentCoordinator({...scope,...patch},{get:async()=>view(),post:async()=>{posts++;return preview;},onSaved:()=>{}});order.activate();await order.refresh('manual');order.setText('Request');await order.preview();order.consent(true);await order.start();assert.equal(posts,0);
  }
  let posts=0;const order=createPlanningAgentCoordinator(scope,{get:async()=>view(),post:async()=>{posts++;return preview;},onSaved:()=>{}});order.activate();await order.refresh('manual');
  for(const text of ['', '   ', 'a'.repeat(8001)]){order.setText(text);await order.preview();}assert.equal(posts,0);
});

test('completed validated proposal saves explicitly by digest and duplicate clicks notify the host once',async()=>{
  const {createPlanningAgentCoordinator}=await components();const response=deferred<PlanningVersion>(),posts:unknown[]=[],savedVersions:PlanningVersion[]=[];
  const order=createPlanningAgentCoordinator(scope,{get:async()=>view([row()]),post:async(path,body)=>{posts.push([path,body]);return response.promise;},onSaved:version=>savedVersions.push(version)});order.activate();await order.refresh('poll');assert.equal(posts.length,0);assert.equal(savedVersions.length,0);
  const first=order.save('suggestion-a');await order.save('suggestion-a');assert.equal(posts.length,1);assert.deepEqual(posts[0],[root+'/suggestion-a/save',{workspaceId:'workspace-a',expectedOutputDigest:'c'.repeat(64)}]);response.resolve(saved);await first;
  assert.deepEqual(savedVersions,[saved]);assert.equal(order.getSnapshot().view?.records[0].savedPlanningVersionId,'plan-new');assert.match(order.getSnapshot().message,/초안/);assert.match(order.getSnapshot().message,/승인/);
  await order.save('suggestion-a');assert.equal(posts.length,2,'explicit saved result recovery uses the server receipt rather than a new client request ID');assert.deepEqual(savedVersions,[saved,saved]);
});

test('late save does not append into a new project or clear that scope pending request',async()=>{
  const {createPlanningAgentCoordinator}=await components();const savedResponse=deferred<PlanningVersion>(),newRead=deferred<PlanningAgentView>();let reads=0,notified=0;
  const order=createPlanningAgentCoordinator(scope,{get:async()=>++reads===1?view([row()]):newRead.promise,post:async()=>savedResponse.promise,onSaved:()=>{notified++;}});order.activate();await order.refresh('manual');const save=order.save('suggestion-a');order.configure({...scope,projectId:'project-b'});const next=order.refresh('poll');savedResponse.resolve(saved);await save;assert.equal(notified,0);assert.equal(order.getSnapshot().loading,true);
  newRead.resolve({...view(),projectId:'project-b'});await next;order.configure(scope);assert.equal(order.getSnapshot().uncertain,true,'leaving during a mutation requires explicit refresh when returning');
});

test('interrupt remains available for owned running work and recovery requires separate exact stopped attestation',async()=>{
  const {createPlanningAgentCoordinator}=await components();let records=[row('running')];const posts:unknown[]=[];
  const order=createPlanningAgentCoordinator({...scope,busy:true},{get:async()=>view(records),post:async(path,body)=>{posts.push([path,body]);return records[0];},onSaved:()=>{}});order.activate();await order.refresh('manual');await order.interrupt('suggestion-a');assert.deepEqual(posts[0],[root+'/suggestion-a/interrupt',{workspaceId:'workspace-a'}]);
  order.configure(scope);records=[row('lost')];await order.refresh('manual');await order.recover('suggestion-a');assert.equal(posts.length,1);order.confirmStopped('suggestion-a',true);await order.recover('suggestion-a');assert.deepEqual(posts[1],[root+'/recover',{workspaceId:'workspace-a',suggestionId:'suggestion-a',confirmedStopped:true}]);assert.equal(order.getSnapshot().recoveryConsent,null);
});

test('panel SSR is inert, disables missing workspace and explains native reads, transport and one-turn limits accurately',async()=>{
  const {PlanningAgentPanel}=await components();let posts=0;
  const html=renderToStaticMarkup(createElement(PlanningAgentPanel,{...scope,workspaceId:null,post:async()=>{posts++;throw Error('SSR POST');},onSaved:()=>{throw Error('SSR save');}}));
  assert.equal(posts,0);assert.match(html,/읽기 전용.*네이티브.*읽기/);assert.match(html,/컨텍스트.*보존.*공급자 전송.*Model Hub/);assert.match(html,/1 turn.*60초/);assert.match(html,/수동 기획/);assert.match(html,/maxLength="8000"/i);assert.match(html,/<button[^>]*disabled[^>]*>기획 요청 미리보기/);assert.doesNotMatch(html,/파일.*읽.*권한을 주지|파일을 읽을 수 없|<script|<iframe/);
});

test('outgoing preview is escaped and separate unchecked consent never invokes start during rendering',async()=>{
  const {PlanningAgentExecutionPreview}=await components();let calls=0;
  const html=renderToStaticMarkup(createElement(PlanningAgentExecutionPreview,{preview,consent:false,disabled:false,onConsent:()=>{calls++;},onStart:()=>{calls++;}}));
  assert.match(html,/Exact outbound instructions/);assert.match(html,/&lt;script&gt;input\(\)&lt;\/script&gt;/);assert.match(html,/별도 동의/);assert.doesNotMatch(html,/checked=""|<script|<a(?:\s|>)/);assert.match(html,/<button[^>]*disabled[^>]*>동의한 기획 제안 시작/);assert.equal(calls,0);
});

test('history displays only stopped completed proposals, escapes content and separates recovery from saving',async()=>{
  const {PlanningAgentHistory}=await components();let calls=0;const current=row(),lost={...row('lost'),id:'lost'},failed={...row('failed'),id:'failed',proposal:{...proposal,title:'RAW_FAILED_PROPOSAL'}},foreign={...row(),id:'foreign',workspaceId:'other',proposal:{...proposal,title:'FOREIGN_PROPOSAL'}},unclosed={...row(),id:'unclosed',processStopped:false,proposal:{...proposal,title:'UNCLOSED_PROPOSAL'}};
  const html=renderToStaticMarkup(createElement(PlanningAgentHistory,{projectId:scope.projectId,workspaceId:scope.workspaceId,records:[current,lost,failed,foreign,unclosed],online:true,busy:false,loading:false,fresh:true,uncertain:false,action:null,recoveryConsent:null,onInterrupt:()=>{calls++;},onRecover:()=>{calls++;},onConfirmStopped:()=>{calls++;},onSave:()=>{calls++;}}));
  assert.match(html,/Proposal &lt;img src=x&gt;/);assert.match(html,/Goal &lt;script&gt;proposal\(\)&lt;\/script&gt;/);assert.match(html,/SQLite/);assert.match(html,/Local records/);assert.match(html,/제안을 새 기획 초안으로 저장/);assert.match(html,/프로세스.*종료/);assert.match(html,/<button[^>]*disabled[^>]*>종료 확인 후 기획 복구/);assert.doesNotMatch(html,/RAW_FAILED_PROPOSAL|FOREIGN_PROPOSAL|UNCLOSED_PROPOSAL|<img|<script|<a(?:\s|>)/);assert.equal(calls,0);
});

test('native proposal attribution is not described as explicitly user-authored or verified identity',async()=>{
  const {PlanningAgentHistory}=await components();
  const html=renderToStaticMarkup(createElement(PlanningAgentHistory,{projectId:scope.projectId,workspaceId:scope.workspaceId,records:[row()],online:true,busy:false,loading:false,fresh:true,uncertain:false,action:null,recoveryConsent:null,onInterrupt:()=>{},onRecover:()=>{},onConfirmStopped:()=>{},onSave:()=>{}}));
  assert.match(html,/in_app_agent/);assert.match(html,/codex/);assert.match(html,/<h4>출처 정보 · 미검증<\/h4>/);assert.match(html,/직접 입력·가져오기 또는 Orbit 기획 제안 경로에서 저장된 표기/);
  assert.match(html,/신원과 내용은 검증하지 않았으며 기획 승인 근거가 아닙니다/);assert.doesNotMatch(html,/사용자가 입력한 표기|사용자 제공 출처 정보/);
});
test('a general project plans without a workspace: no workspace query, null workspace in bodies, runtime shown',async()=>{
  const {createPlanningAgentCoordinator,PlanningAgentPanel}=await components();
  const general={projectId:'project-a',workspaceId:null,online:true,busy:false,general:true};
  const g=(value:object)=>({...value,workspaceId:null,runtime:'claude-code'});
  const reads:string[]=[],posts:{path:string;body:Record<string,unknown>}[]=[];
  const coordinator=createPlanningAgentCoordinator(general as never,{get:async path=>{reads.push(path);return g(view());},post:async(path,body)=>{posts.push({path,body:body as Record<string,unknown>});return g(preview);},onSaved:()=>{},storage:storage()});
  coordinator.activate();await coordinator.refresh('manual');
  assert.deepEqual(reads,[root],'no workspaceId query for a general project');
  coordinator.setText('시장 조사 보고서를 만들고 싶어요');await coordinator.preview();
  assert.deepEqual(posts,[{path:root+'/preview',body:{workspaceId:null,text:'시장 조사 보고서를 만들고 싶어요'}}]);
  assert.equal(coordinator.getSnapshot().preview?.runtime,'claude-code');
  const html=renderToStaticMarkup(createElement(PlanningAgentPanel,{...general,post:async()=>({}),onSaved:()=>{}} as never));
  assert.doesNotMatch(html,/격리 작업 공간을 선택하면/);assert.doesNotMatch(html,/<textarea[^>]*disabled/);
  const code=renderToStaticMarkup(createElement(PlanningAgentPanel,{projectId:'project-a',workspaceId:null,online:true,busy:false,post:async()=>({}),onSaved:()=>{}} as never));
  assert.match(code,/격리 작업 공간을 선택하면/,'code projects still need a workspace');
});
