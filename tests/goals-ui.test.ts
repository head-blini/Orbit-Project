import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {PlanningVersion} from '../shared/parallel.ts';
import type {TrackedGoal,TrackedGoalView} from '../shared/goals.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {GoalService} from '../server/goal-service.ts';
import {randomUUID} from 'node:crypto';

async function components(){
  const webRoot=new URL('../web/',import.meta.url).href;
  assert.ok(existsSync(new URL('../web/goals.tsx',import.meta.url)),'Goal Tracking UI is not implemented');
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/goals.tsx');}finally{hooks.deregister();}
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const hash='a'.repeat(64);
function plan(changes:Partial<PlanningVersion>={}):PlanningVersion{return {id:'plan-a',projectId:'project-a',lineageId:'lineage-a',revision:1,contentHash:hash,state:'approved',draft:{schemaVersion:'1.0',title:'추적할 기획',goal:'요구사항을 확인한다',requirements:[{label:'REQ-01',description:'첫 요구사항',acceptanceCriteria:['검증 조건']}],constraints:[],openQuestions:[],source:'manual'},...changes};}
function goal(changes:Partial<TrackedGoal>={}):TrackedGoal{return {id:'goal-a',projectId:'project-a',planningVersionId:'plan-a',planningHash:hash,revision:1,level:'tracking',state:'tracking',createdAt:'2026-10-27T00:00:00.000Z',updatedAt:'2026-10-27T00:00:00.000Z',...changes};}
function view(changes:Partial<TrackedGoalView>={}):TrackedGoalView{return {goal:goal(),title:'기획 목표',objective:'첫 번째 목표',planCurrent:true,requirements:[{label:'REQ-01',description:'첫 요구사항',acceptanceCriteria:['검증 조건'],taskIds:['task-a'],runs:[{id:'run-a',execution:'completed'}],runsTotal:102,acceptance:'unverified',evidence:[{kind:'check',id:'check-a',runId:'run-a',status:'passed',sourceDigest:hash,qualification:'reference_only'}],evidenceTotal:4}],blockers:['ACCEPTANCE_NOT_QUALIFIED'],evidenceScope:'저장된 기록의 참조만 표시',...changes};}
function memoryStorage(){const records=new Map<string,string>();return {records,getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);},removeItem:(key:string)=>{records.delete(key);}};}
const scope={projectId:'project-a',online:true};
const noPost=async()=>{throw new Error('Reads must not POST');};

test('tracking coordinator accepts actual service projections after creating an approved goal',async()=>{
  const store=new Store(':memory:');
  try{
    store.saveProject({id:'project-a',name:'Fixture',path:'never-opened',createdAt:'',writeEnabled:false});
    const studio=new Studio(store),goals=new GoalService(store);
    const draft=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Actual goal',goal:'Local tracking',requirements:[{id:'R1',description:'Persist',acceptance_criteria:['Restores']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
    studio.mutate('project-a','plans',draft.id,'approve',{expectedRevision:1});
    const {createGoalTrackingCoordinator}=await components();
    const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?studio.read('project-a','plans'):goals.list('project-a')),post:async(_path,body)=>goals.create('project-a',body as any)});
    await coordinator.setScope(scope);coordinator.selectPlan(draft.id);await coordinator.create();
    const state=coordinator.getSnapshot();assert.equal(state.loaded,true);assert.equal(state.error,'');assert.equal(state.goals.length,1);
    assert.equal(state.goals[0].requirements[0].runsTotal,0);assert.equal(store.runs().length,0);coordinator.dispose();
  }finally{store.close();}
});

test('activation reads selected online project only and never creates a goal or dispatches work',async()=>{
  const {createGoalTrackingCoordinator}=await components();const calls:{path:string;options:RequestInit}[]=[];
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:async(path,options)=>{calls.push({path,options});return json(path.endsWith('/plans')?[plan({projectId:'project /?'})]:[]);}});
  await coordinator.setScope({projectId:null,online:true});await coordinator.refresh();await coordinator.create();
  await coordinator.setScope({projectId:'project /?',online:false});await coordinator.refresh();assert.equal(calls.length,0);
  await coordinator.setScope({projectId:'project /?',online:true});await coordinator.setScope({projectId:'project /?',online:true});
  assert.deepEqual(calls.map(call=>call.path).sort(),['/api/projects/project%20%2F%3F/goals','/api/projects/project%20%2F%3F/plans']);
  assert.ok(calls.every(call=>call.options.method==='GET'&&call.options.body===undefined&&call.options.cache==='no-store'));
  assert.equal(coordinator.getSnapshot().selectedPlanId,'');assert.equal(coordinator.getSnapshot().loaded,true);
});

test('creation requires explicit selection of an approved current plan and carries its hash',async()=>{
  const {createGoalTrackingCoordinator}=await components();const requests:{path:string;body:object}[]=[];
  const plans=[plan(),plan({id:'old',lineageId:'revised',state:'approved'}),plan({id:'new-draft',lineageId:'revised',revision:2,state:'draft'}),plan({id:'superseded',lineageId:'other',state:'superseded'})];
  const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?plans:[]),post:async(path,body)=>{requests.push({path,body});return goal();}});
  await coordinator.setScope(scope);await coordinator.create();
  for(const id of ['old','new-draft','superseded','unknown']){coordinator.selectPlan(id);await coordinator.create();}
  assert.equal(requests.length,0);coordinator.selectPlan('plan-a');await coordinator.create();
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/projects/project-a/goals');
  assert.deepEqual(Object.keys(requests[0].body).sort(),['expectedPlanningHash','planningVersionId','requestId']);
  assert.equal((requests[0].body as any).planningVersionId,'plan-a');assert.equal((requests[0].body as any).expectedPlanningHash,hash);assert.match((requests[0].body as any).requestId,/^[0-9a-f-]{36}$/);
  assert.equal(coordinator.getSnapshot().selectedPlanId,'');
});

test('synchronous duplicate create is locked before hashing and acknowledged replay is replaced by the fresh list',async()=>{
  const {createGoalTrackingCoordinator}=await components();const pending=deferred<TrackedGoal>(),sent=deferred<void>();let writes=0,reads=0;
  const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?[plan()]:++reads===1?[]:[view({goal:goal({revision:4,state:'paused'})})]),post:async()=>{writes++;sent.resolve();return pending.promise;}});
  await coordinator.setScope(scope);coordinator.selectPlan('plan-a');const first=coordinator.create();await coordinator.create();await sent.promise;
  coordinator.selectPlan('');await coordinator.refresh();assert.equal(writes,1);assert.equal(reads,1);assert.equal(coordinator.getSnapshot().selectedPlanId,'plan-a');
  pending.resolve(goal());await first;assert.equal(coordinator.getSnapshot().goals[0].goal.revision,4);assert.equal(coordinator.getSnapshot().goals[0].goal.state,'paused');assert.equal(coordinator.getSnapshot().pending,null);
});

test('lost create response keeps only a hashed receipt and manual retry after remount reuses its request ID',async()=>{
  const {createGoalTrackingCoordinator}=await components();const storage=memoryStorage(),bodies:Record<string,unknown>[]=[];
  const get=async(path:string)=>json(path.endsWith('/plans')?[plan()]:[]);
  const first=createGoalTrackingCoordinator({storage,get,post:async(_path,body)=>{bodies.push(body);throw new Error('PRIVATE_SERVER_BODY');}});
  await first.setScope(scope);first.selectPlan('plan-a');await first.create();assert.equal(bodies.length,1);assert.equal(storage.records.size,1);
  assert.match(first.getSnapshot().error,/확인하지 못/);assert.doesNotMatch(first.getSnapshot().error,/PRIVATE/);
  for(const [key,value] of storage.records){assert.match(key,/^orbit\.studio\.request\.[0-9a-f]{64}$/);assert.equal(value,bodies[0].requestId);assert.doesNotMatch(value,/기획|요구|plan-a/);}
  first.dispose();const second=createGoalTrackingCoordinator({storage,get,post:async(_path,body)=>{bodies.push(body);return goal();}});
  await second.setScope(scope);assert.equal(bodies.length,1);second.selectPlan('plan-a');await second.create();
  assert.equal(bodies[1].requestId,bodies[0].requestId);assert.equal(storage.records.size,0);
});

test('pause resume cancel send CAS revisions and cancelled goals cannot be resumed',async()=>{
  const {createGoalTrackingCoordinator}=await components();let stored=goal();const requests:{path:string;body:Record<string,unknown>}[]=[];
  const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?[plan()]:[view({goal:stored})]),post:async(path,body)=>{requests.push({path,body});stored=goal({state:body.state as TrackedGoal['state'],revision:stored.revision+1});return stored;}});
  await coordinator.setScope(scope);await coordinator.setState('unknown','paused');await coordinator.setState('goal-a','tracking');assert.equal(requests.length,0);
  const pausing=coordinator.setState('goal-a','paused');await coordinator.setState('goal-a','cancelled');await pausing;
  await coordinator.setState('goal-a','tracking');await coordinator.setState('goal-a','cancelled');await coordinator.setState('goal-a','tracking');await coordinator.setState('goal-a','paused');
  assert.equal(requests.length,3);assert.ok(requests.every(row=>row.path==='/api/projects/project-a/goals/goal-a/state'));
  assert.deepEqual(requests.map(row=>[row.body.expectedRevision,row.body.state]),[[1,'paused'],[2,'tracking'],[3,'cancelled']]);assert.equal(coordinator.getSnapshot().goals[0].goal.state,'cancelled');
});

test('state retry uses its original receipt and never projects an old acknowledged state over current revision',async()=>{
  const {createGoalTrackingCoordinator}=await components();const requests:Record<string,unknown>[]=[];let latest=goal();
  const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?[plan()]:[view({goal:latest})]),post:async(_path,body)=>{requests.push(body);if(requests.length===1){latest=goal({state:'cancelled',revision:4});throw new Error('lost');}return goal({state:'paused',revision:2});}});
  await coordinator.setScope(scope);await coordinator.setState('goal-a','paused');assert.equal(requests.length,1);await coordinator.setState('goal-a','paused');
  assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(coordinator.getSnapshot().goals[0].goal.state,'cancelled');assert.equal(coordinator.getSnapshot().goals[0].goal.revision,4);
});

test('project switch discards late list success failure selection and locks without leaking another project',async()=>{
  const {createGoalTrackingCoordinator}=await components();const a=deferred<Response>(),b=deferred<Response>(),c=deferred<Response>();
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:path=>path.endsWith('/plans')?Promise.resolve(json([plan({projectId:path.split('/')[3]})])):path.includes('/project-a/')?a.promise:path.includes('/project-b/')?b.promise:c.promise});
  const first=coordinator.setScope(scope),second=coordinator.setScope({projectId:'project-b',online:true}),third=coordinator.setScope({projectId:'project-c',online:true});
  a.resolve(json([view()]));b.reject(new Error('PRIVATE'));await Promise.all([first,second]);
  assert.equal(coordinator.getSnapshot().projectId,'project-c');assert.equal(coordinator.getSnapshot().loading,true);assert.deepEqual(coordinator.getSnapshot().goals,[]);assert.equal(coordinator.getSnapshot().error,'');
  c.resolve(json([view({goal:goal({projectId:'project-c'})})]));await third;assert.equal(coordinator.getSnapshot().goals[0].goal.projectId,'project-c');assert.equal(coordinator.getSnapshot().loading,false);
});

test('offline before request hashing finishes prevents dispatch and late acknowledged writes cannot publish into a new project',async()=>{
  const {createGoalTrackingCoordinator}=await components();const sent=deferred<void>(),pending=deferred<TrackedGoal>();let writes=0;
  const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?[plan({projectId:path.split('/')[3]})]:[]),post:async()=>{writes++;sent.resolve();return pending.promise;}});
  await coordinator.setScope(scope);coordinator.selectPlan('plan-a');const cancelled=coordinator.create();await coordinator.setScope({...scope,online:false});await cancelled;assert.equal(writes,0);
  await coordinator.refresh();await coordinator.create();assert.equal(writes,0);
  await coordinator.setScope(scope);coordinator.selectPlan('plan-a');const writing=coordinator.create();await sent.promise;
  await coordinator.setScope({projectId:'project-b',online:true});pending.resolve(goal());await writing;
  assert.equal(coordinator.getSnapshot().projectId,'project-b');assert.deepEqual(coordinator.getSnapshot().goals,[]);assert.equal(coordinator.getSnapshot().message,'');assert.equal(coordinator.getSnapshot().pending,null);
});

test('manual refresh supersedes an initial read and failure invalidates action freshness with no automatic retry',async()=>{
  const {createGoalTrackingCoordinator}=await components();const old=deferred<Response>(),fresh=deferred<Response>();let reads=0;
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:path=>path.endsWith('/plans')?Promise.resolve(json([plan()])):++reads===1?old.promise:reads===2?fresh.promise:Promise.resolve(new Response('PRIVATE',{status:500}))});
  const initial=coordinator.setScope(scope),refresh=coordinator.refresh();await coordinator.refresh();assert.equal(reads,2);
  old.resolve(json([view({title:'old'})]));await initial;assert.deepEqual(coordinator.getSnapshot().goals,[]);assert.equal(coordinator.getSnapshot().loading,true);
  fresh.resolve(json([view({title:'fresh'})]));await refresh;coordinator.selectPlan('plan-a');await coordinator.refresh();
  assert.equal(reads,3);assert.equal(coordinator.getSnapshot().loaded,false);assert.match(coordinator.getSnapshot().error,/불러오지 못/);assert.doesNotMatch(coordinator.getSnapshot().error,/PRIVATE/);
  await coordinator.create();await coordinator.setState('goal-a','paused');assert.equal(reads,3);
});

test('unmount invalidates pending reads and same project remount can fetch afresh',async()=>{
  const {createGoalTrackingCoordinator}=await components();const pending=deferred<Response>();let reads=0;
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:path=>path.endsWith('/plans')?Promise.resolve(json([plan()])):++reads===1?pending.promise:Promise.resolve(json([view()]))});
  const loading=coordinator.setScope(scope);coordinator.dispose();pending.reject(new Error('PRIVATE'));await loading;await coordinator.refresh();assert.equal(reads,1);
  await coordinator.setScope(scope);assert.equal(reads,2);assert.equal(coordinator.getSnapshot().loaded,true);assert.equal(coordinator.getSnapshot().error,'');
});

test('foreign or malformed lists and mismatched write acknowledgements never become actionable data',async()=>{
  const {createGoalTrackingCoordinator}=await components();
  for(const bad of [[view({goal:goal({projectId:'foreign'})})],[{...view(),requirements:null}],[view({goal:{...goal(),state:'achieved'} as any})]]){
    const coordinator=createGoalTrackingCoordinator({get:async path=>json(path.endsWith('/plans')?[plan()]:bad),post:noPost});await coordinator.setScope(scope);assert.equal(coordinator.getSnapshot().loaded,false);assert.deepEqual(coordinator.getSnapshot().goals,[]);assert.match(coordinator.getSnapshot().error,/불러오지 못/);
  }
  const storage=memoryStorage();const coordinator=createGoalTrackingCoordinator({storage,get:async path=>json(path.endsWith('/plans')?[plan()]:[]),post:async()=>goal({projectId:'foreign'})});
  await coordinator.setScope(scope);coordinator.selectPlan('plan-a');await coordinator.create();assert.deepEqual(coordinator.getSnapshot().goals,[]);assert.match(coordinator.getSnapshot().error,/확인하지 못/);assert.equal(storage.records.size,1);
});

test('history is an explicit deduplicated GET and rejects cross-goal records without changing the current goal',async()=>{
  const {createGoalTrackingCoordinator}=await components();const pending=deferred<Response>();let reads=0;
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:async(path,options)=>{if(path.endsWith('/history')){reads++;assert.equal(path,'/api/projects/project-a/goals/goal-a/history');assert.equal(options.method,'GET');return reads===1?pending.promise:json([goal({id:'foreign'})]);}return json(path.endsWith('/plans')?[plan()]:[view({goal:goal({revision:3,state:'paused'})})]);}});
  await coordinator.setScope(scope);assert.equal(reads,0);await coordinator.showHistory('unknown');const first=coordinator.showHistory('goal-a');await coordinator.showHistory('goal-a');assert.equal(reads,1);
  pending.resolve(json([goal(),goal({state:'paused',revision:2})]));await first;assert.deepEqual(coordinator.getSnapshot().history?.versions.map(row=>row.revision),[1,2]);assert.equal(coordinator.getSnapshot().goals[0].goal.revision,3);
  await coordinator.showHistory('goal-a');assert.equal(coordinator.getSnapshot().history,null);assert.match(coordinator.getSnapshot().historyError,/이력/);
});

test('view renders reference-only runs checks stale plans and unknown acceptance without completion or execution controls',async()=>{
  const {GoalTrackingView,createGoalTrackingCoordinator}=await components();const row=view({planCurrent:false,title:'목표 <script>bad()</script>',goal:goal({state:'paused'})});Object.assign(row,{raw:'PRIVATE_RAW',prompt:'PRIVATE_PROMPT'});
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:async path=>json(path.endsWith('/plans')?[plan()]:[row])});await coordinator.setScope(scope);
  const html=renderToStaticMarkup(createElement(GoalTrackingView,{state:coordinator.getSnapshot(),onRefresh:()=>{},onSelectPlan:()=>{},onCreate:()=>{},onSetState:()=>{},onHistory:()=>{}}));
  assert.match(html,/Goal Tracking/);assert.match(html,/이전 기획/);assert.match(html,/수용 판정.*미확인/s);assert.match(html,/참조 전용/);assert.match(html,/실행 완료/);assert.match(html,/검증 통과/);assert.match(html,/목표 달성.*뜻하지 않/s);
  assert.match(html,/REQ-01/);assert.match(html,/검증 조건/);assert.match(html,/task-a/);assert.match(html,/run-a/);assert.match(html,/check-a/);assert.match(html,/1.*4.*표시/s);assert.match(html,/추적 재개/);assert.match(html,/추적 취소/);assert.match(html,/변경 이력/);
  assert.match(html,/목표 &lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/PRIVATE_|<script|<button[^>]*>[^<]*(달성 처리|실행 시작|병합|승인)/);
});

test('actual panel is inert during server render and unavailable states disable mutations',async t=>{
  const {GoalTrackingPanel,GoalTrackingView,createGoalTrackingCoordinator}=await components();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('SSR fetched');});
  const callbacks={onRefresh:()=>{},onSelectPlan:()=>{},onCreate:()=>{},onSetState:()=>{},onHistory:()=>{}};
  const empty=renderToStaticMarkup(createElement(GoalTrackingPanel,{projectId:null,online:true,post:noPost}));assert.match(empty,/프로젝트를 선택/);assert.match(empty,/<button[^>]*disabled[^>]*>새로고침/);
  const offline=renderToStaticMarkup(createElement(GoalTrackingPanel,{projectId:'project-a',online:false,post:noPost}));assert.match(offline,/서버 연결/);assert.match(offline,/<button[^>]*disabled[^>]*>새로고침/);
  renderToStaticMarkup(createElement(GoalTrackingPanel,{projectId:'project-a',online:true,post:noPost}));assert.equal(calls,0);
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:async path=>json(path.endsWith('/plans')?[plan(),plan({id:'untracked',lineageId:'untracked'})]:[view()])});await coordinator.setScope(scope);
  const initial=renderToStaticMarkup(createElement(GoalTrackingView,{state:coordinator.getSnapshot(),...callbacks}));assert.match(initial,/<button[^>]*disabled[^>]*>목표 추적 만들기/);
  coordinator.selectPlan('untracked');const selected=renderToStaticMarkup(createElement(GoalTrackingView,{state:coordinator.getSnapshot(),...callbacks}));assert.doesNotMatch(selected,/<button[^>]*disabled[^>]*>목표 추적 만들기/);
  const loading=renderToStaticMarkup(createElement(GoalTrackingView,{state:{...coordinator.getSnapshot(),loading:true},...callbacks}));assert.match(loading,/aria-busy="true"/);assert.match(loading,/<button[^>]*disabled[^>]*>추적 일시정지/);
});

test('a plan already tracked including cancelled goals cannot create a duplicate tracking record',async()=>{
  const {createGoalTrackingCoordinator,GoalTrackingView}=await components();let writes=0;
  const coordinator=createGoalTrackingCoordinator({post:async()=>{writes++;return goal();},get:async path=>json(path.endsWith('/plans')?[plan()]:[view({goal:goal({state:'cancelled'})})])});
  await coordinator.setScope(scope);coordinator.selectPlan('plan-a');await coordinator.create();assert.equal(writes,0);assert.equal(coordinator.getSnapshot().selectedPlanId,'');
  const html=renderToStaticMarkup(createElement(GoalTrackingView,{state:coordinator.getSnapshot(),onRefresh:()=>{},onSelectPlan:()=>{},onCreate:()=>{},onSetState:()=>{},onHistory:()=>{}}));
  assert.match(html,/이미 연결한 기획/);assert.doesNotMatch(html,/<button[^>]*>추적 재개/);
});

test('truncated historical run references disclose total versus displayed count and preserve acceptance as unverified',async()=>{
  const {createGoalTrackingCoordinator,GoalTrackingView}=await components();const coordinator=createGoalTrackingCoordinator({post:noPost,get:async path=>json(path.endsWith('/plans')?[plan()]:[view()])});
  await coordinator.setScope(scope);const html=renderToStaticMarkup(createElement(GoalTrackingView,{state:coordinator.getSnapshot(),onRefresh:()=>{},onSelectPlan:()=>{},onCreate:()=>{},onSetState:()=>{},onHistory:()=>{}}));
  assert.match(html,/실행 기록 102개 중 1개 표시/);assert.match(html,/수용 판정.*미확인/s);assert.doesNotMatch(html,/ACCEPTANCE_NOT_QUALIFIED/);
});

test('acknowledged creation followed by failed refresh clears selection and cannot submit the creation again',async()=>{
  const {createGoalTrackingCoordinator}=await components();let reads=0,writes=0;
  const coordinator=createGoalTrackingCoordinator({get:async path=>path.endsWith('/plans')?json([plan()]):++reads===1?json([]):new Response('unavailable',{status:503}),post:async()=>{writes++;return goal();}});
  await coordinator.setScope(scope);coordinator.selectPlan('plan-a');await coordinator.create();
  assert.equal(coordinator.getSnapshot().selectedPlanId,'');assert.equal(coordinator.getSnapshot().loaded,false);assert.match(coordinator.getSnapshot().message,/저장/);assert.match(coordinator.getSnapshot().error,/불러오지 못/);
  coordinator.selectPlan('plan-a');await coordinator.create();assert.equal(writes,1);
});

test('late history from an earlier project cannot repopulate the panel',async()=>{
  const {createGoalTrackingCoordinator}=await components();const pending=deferred<Response>();
  const coordinator=createGoalTrackingCoordinator({post:noPost,get:async path=>path.endsWith('/history')?pending.promise:json(path.endsWith('/plans')?[plan({projectId:path.split('/')[3]})]:[view({goal:goal({projectId:path.split('/')[3]})})])});
  await coordinator.setScope(scope);const history=coordinator.showHistory('goal-a');await coordinator.setScope({projectId:'project-b',online:true});pending.resolve(json([goal()]));await history;
  assert.equal(coordinator.getSnapshot().history,null);assert.equal(coordinator.getSnapshot().historyLoading,null);assert.equal(coordinator.getSnapshot().historyError,'');
});
