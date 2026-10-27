import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import {createStartFlowCoordinator,currentStartPlans,type StartFlowScope} from '../web/start-flow.ts';

const scope:StartFlowScope={projectId:'project-a',workspaceId:'workspace-a',online:true,blocked:false,refreshKey:'0'};
function plan(id='plan-a',patch:Partial<PlanningVersion>={}):PlanningVersion{return {id,projectId:'project-a',lineageId:id,revision:1,contentHash:'a'.repeat(64),state:'draft',createdAt:'2026-10-27T00:00:00.000Z',draft:{schemaVersion:'1.0',title:'Greeting',goal:'Create greeting',requirements:[{label:'R1',description:'Show greeting',acceptanceCriteria:['Greeting is visible']}],constraints:[],openQuestions:[],source:'manual'},...patch};}
function task(version=plan()):SavedTask{return {id:'task-a',projectId:version.projectId,planningVersionId:version.id,title:'Greeting',description:'Show greeting',acceptanceCriteria:['Greeting is visible'],requirementLabels:['R1'],state:'draft',verification:'not_run',createdAt:'2026-10-27T00:00:01.000Z'};}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(plans:unknown= [plan()],tasks:unknown=[]){
  const calls:{path:string;body:Record<string,unknown>}[]=[],memory=new Map<string,string>();
  const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>{memory.set(key,value);},removeItem:(key:string)=>{memory.delete(key);}};
  const h={plans,tasks,calls,storage,post:async(path:string,_body:Record<string,unknown>):Promise<unknown>=>path.endsWith('/approve')?{...plan(),state:'approved'}:[task()]};
  const deps={storage,get:async(path:string)=>path.endsWith('/plans')?h.plans:h.tasks,post:async(path:string,body:Record<string,unknown>)=>{calls.push({path,body});return h.post(path,body);}};
  return {...h,deps,create:()=>createStartFlowCoordinator(scope,deps),setPlans:(value:unknown)=>{h.plans=value;},setTasks:(value:unknown)=>{h.tasks=value;},setPost:(value:typeof h.post)=>{h.post=value;}};
}
test('lineage heads exclude an older approval and keep independent current approvals in creation order',()=>{
  const old=plan('old',{state:'approved'}),other=plan('other',{state:'approved'}),latest=plan('latest',{lineageId:'old',revision:2});
  assert.deepEqual(currentStartPlans([old,other,latest,plan('foreign',{projectId:'other'})],'project-a').map(p=>p.id),['other','latest']);
  assert.deepEqual(currentStartPlans([plan('gone',{state:'superseded'})],'project-a'),[]);
  assert.deepEqual(currentStartPlans([plan('legacy-a',{lineageId:undefined,state:'approved'}),plan('legacy-b',{lineageId:undefined})],'project-a').map(p=>p.id),['legacy-a','legacy-b']);
});
test('only explicit prepare approves the exact revision then creates tasks; double submission is locked synchronously',async()=>{
  const h=harness(),c=h.create();c.activate();await c.refresh();assert.equal(c.getSnapshot().selectedPlanId,'plan-a');assert.equal(h.calls.length,0);
  const approval=deferred<unknown>();h.setPost(async path=>path.endsWith('/approve')?approval.promise:[task()]);
  const first=c.prepareTasks();assert.equal(await c.prepareTasks(),false);assert.equal(c.getSnapshot().action,'prepare');
  approval.resolve({...plan(),state:'approved'});assert.equal(await first,true);
  assert.deepEqual(h.calls,[{path:'/api/projects/project-a/plans/plan-a/approve',body:{expectedRevision:1}},{path:'/api/projects/project-a/plans/plan-a/task-drafts',body:{}}]);
  assert.equal(c.getSnapshot().plans[0].state,'approved');assert.equal(c.getSnapshot().tasks[0].id,'task-a');assert.equal(c.getSnapshot().uncertain,false);
});
test('already approved head skips approval and existing bound tasks need no POST',async()=>{
  const approved=plan('plan-a',{state:'approved'}),h=harness([approved]),c=h.create();c.activate();await c.refresh();assert.equal(await c.prepareTasks(),true);
  assert.deepEqual(h.calls.map(call=>call.path),['/api/projects/project-a/plans/plan-a/task-drafts']);
  assert.equal(await c.prepareTasks(),true);assert.equal(h.calls.length,1);
});
test('scope transitions after approval starts suppress task creation and late state',async()=>{
  for(const patch of [{projectId:'project-b'},{workspaceId:'workspace-b'},{online:false},{blocked:true}]){
    const h=harness(),c=h.create(),approval=deferred<unknown>();c.activate();await c.refresh();h.setPost(async()=>approval.promise);
    const pending=c.prepareTasks();c.configure({...scope,...patch});approval.resolve({...plan(),state:'approved'});
    assert.equal(await pending,false);assert.equal(h.calls.length,1);assert.equal(c.getSnapshot().fresh,false);assert.equal(c.getSnapshot().action,null);
    assert.equal(c.getSnapshot().scope.projectId,patch.projectId??scope.projectId);
  }
});
test('same-scope approval SSE refresh key does not cancel its continuation',async()=>{
  const h=harness(),c=h.create(),approval=deferred<unknown>();c.activate();await c.refresh();h.setPost(async path=>path.endsWith('/approve')?approval.promise:[task()]);
  const pending=c.prepareTasks();c.configure({...scope,refreshKey:'approval-sse'});await c.refresh();approval.resolve({...plan(),state:'approved'});
  assert.equal(await pending,true);assert.equal(h.calls.length,2);assert.equal(c.getSnapshot().scope.refreshKey,'approval-sse');
});
test('lost task result survives reload and polling; a successful manual read reconciles without replay',async()=>{
  const h=harness(),c=h.create();c.activate();await c.refresh();h.setPost(async path=>{if(path.endsWith('/approve'))return {...plan(),state:'approved'};throw Error('connection lost');});
  assert.equal(await c.prepareTasks(),false);assert.equal(c.getSnapshot().plans[0].state,'approved');assert.equal(c.getSnapshot().uncertain,true);c.dispose();
  const reloaded=h.create();reloaded.activate();h.setPlans([plan('plan-a',{state:'approved'})]);h.setTasks([task()]);await reloaded.refresh();
  assert.equal(reloaded.getSnapshot().uncertain,true);assert.equal(await reloaded.prepareTasks(),false);assert.equal(h.calls.length,2);
  await reloaded.refresh(true);assert.equal(reloaded.getSnapshot().uncertain,false);assert.equal(await reloaded.prepareTasks(),true);assert.equal(h.calls.length,2);
});
test('foreign or malformed GET records cannot authorize a mutation',async()=>{
  for(const [plans,tasks] of [[[{...plan(),projectId:'foreign'}],[]],[[{...plan(),contentHash:'bad'}],[]],[[{...plan(),draft:{}}],[]],[[plan()],[{...task(),projectId:'foreign'}]],[[plan()],[{...task(),planningVersionId:'unknown'}]],[[plan('plan-a',{state:'approved'})],[{...task(),requirementLabels:['R999']}]],[[plan()],{}]]){
    const h=harness(plans,tasks),c=h.create();c.activate();await c.refresh();assert.equal(c.getSnapshot().fresh,false);assert.equal(await c.prepareTasks(),false);assert.equal(h.calls.length,0);assert.ok(c.getSnapshot().error);
  }
});
test('an unusable approval response cannot create tasks or clear uncertainty',async()=>{
  for(const patch of [{id:'foreign'},{projectId:'foreign'},{revision:2},{contentHash:'b'.repeat(64)},{state:'draft'}]){
    const h=harness(),c=h.create();c.activate();await c.refresh();h.setPost(async()=>({...plan(),state:'approved',...patch}));assert.equal(await c.prepareTasks(),false);assert.equal(h.calls.length,1);assert.equal(c.getSnapshot().uncertain,true);assert.equal(c.getSnapshot().plans[0].state,'draft');
  }
});
test('foreign, empty, or incomplete task responses never report successful preparation',async()=>{
  const approved=plan('plan-a',{state:'approved'});
  for(const response of [[],[task(plan('foreign'))],[{...task(),projectId:'foreign'}],[{...task(),acceptanceCriteria:null}]]){
    const h=harness([approved]),c=h.create();c.activate();await c.refresh();h.setPost(async()=>response);assert.equal(await c.prepareTasks(),false);assert.equal(c.getSnapshot().tasks.length,0);assert.equal(c.getSnapshot().uncertain,true);
  }
});
test('selection is retained only for current heads and unresolved questions block preparation',async()=>{
  const h=harness([plan('first'),plan('last')]),c=h.create();c.activate();await c.refresh();assert.equal(c.getSnapshot().selectedPlanId,'last');c.selectPlan('first');
  await c.refresh();assert.equal(c.getSnapshot().selectedPlanId,'first');h.setPlans([plan('first',{state:'approved'}),plan('last'),plan('new',{lineageId:'first',revision:2})]);await c.refresh();assert.equal(c.getSnapshot().selectedPlanId,'new');
  c.selectPlan('first');assert.equal(c.getSnapshot().selectedPlanId,'new');const question=plan();question.draft.openQuestions=['Choose a provider'];h.setPlans([question]);await c.refresh();assert.equal(await c.prepareTasks(),false);assert.equal(h.calls.length,0);
});
test('late reads from a previous workspace do not replace current data',async()=>{
  const pending=deferred<unknown>();const c=createStartFlowCoordinator(scope,{get:async path=>path.endsWith('/plans')?pending.promise:[],post:async()=>assert.fail('no POST')});c.activate();const read=c.refresh();assert.equal(c.getSnapshot().loading,true);c.configure({...scope,workspaceId:'other'});pending.resolve([plan()]);await read;
  assert.equal(c.getSnapshot().plans.length,0);assert.equal(c.getSnapshot().fresh,false);
});
test('malformed optional plan and task metadata fail closed before rendering or preparation',async()=>{
  for(const patch of [{provenance:{kind:3}},{provenance:{kind:'file',providerId:null,externalUrl:null,references:[null]}},{decisions:[{topic:'a',decision:'b',rationale:3}]}]){
    const version=plan();Object.assign(version.draft,patch);const h=harness([version]),c=h.create();c.activate();await c.refresh();assert.equal(c.getSnapshot().fresh,false);assert.equal(await c.prepareTasks(),false);
  }
  const h=harness([plan('plan-a',{state:'approved'})],[{...task(),replannedFrom:{planningVersionId:1,taskIds:null}}]),c=h.create();c.activate();await c.refresh();assert.equal(c.getSnapshot().fresh,false);
});
test('in-flight uncertainty is scoped, persists through disposal, and manual malformed reads cannot clear it',async()=>{
  const h=harness(),approval=deferred<unknown>(),c=h.create();c.activate();await c.refresh();h.setPost(async()=>approval.promise);
  const operation=c.prepareTasks();c.dispose();approval.resolve({...plan(),state:'approved'});assert.equal(await operation,false);assert.equal(h.calls.length,1);
  c.activate();await c.refresh();assert.equal(c.getSnapshot().uncertain,true);h.setTasks({broken:true});await c.refresh(true);assert.equal(c.getSnapshot().uncertain,true);assert.equal(c.getSnapshot().fresh,false);
  c.configure({...scope,workspaceId:'other'});h.setTasks([]);await c.refresh();assert.equal(c.getSnapshot().uncertain,false);c.configure(scope);assert.equal(c.getSnapshot().uncertain,true);
});
test('a partial set of newly returned tasks cannot mark all requirements prepared',async()=>{
  const approved=plan('plan-a',{state:'approved'});approved.draft.requirements.push({label:'R2',description:'Store greeting',acceptanceCriteria:['Greeting persists']});
  const h=harness([approved]),c=h.create();c.activate();await c.refresh();assert.equal(await c.prepareTasks(),false);assert.equal(c.getSnapshot().uncertain,true);assert.equal(c.getSnapshot().tasks.length,0);
});
test('real Studio prepare uses existing approval and idempotent task drafts without creating any Run',async()=>{
  const store=new Store(':memory:'),studio=new Studio(store);try{
    store.saveProject({id:'project-a',name:'Start',path:'fixture',createdAt:'',writeEnabled:true});
    const input={format:'markdown',source:'manual',text:'# Greeting\n## Goal\nCreate greeting\n## Requirements\n### R1\nShow greeting\n#### Acceptance criteria\n- Greeting is visible\n## Constraints\n## Open questions\n'};
    const old=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
    studio.mutate('project-a','plans',old.id,'approve',{expectedRevision:1});
    const next=studio.mutate('project-a','plans',old.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input}) as PlanningVersion;
    // Keep the HTTP boundary literal while all underlying persistence and approval are real.
    const integrated=createStartFlowCoordinator(scope,{get:async path=>studio.read('project-a',path.endsWith('/plans')?'plans':'tasks'),post:async(path,body)=>{const match=/\/plans\/([^/]+)\/(approve|task-drafts)$/.exec(path);assert.ok(match);return studio.mutate('project-a','plans',match[1],match[2],body);}});
    integrated.activate();await integrated.refresh();assert.equal(integrated.getSnapshot().selectedPlanId,next.id);assert.equal(await integrated.prepareTasks(),true);
    assert.equal(integrated.getSnapshot().tasks[0].planningVersionId,next.id);assert.equal(store.runs().length,0);assert.equal((studio.read('project-a','tasks') as SavedTask[]).length,1);assert.equal(await integrated.prepareTasks(),true);
  }finally{store.close();}
});
test('real Studio partial replan is completed through task-drafts while preserving existing task identity',async()=>{
  const store=new Store(':memory:'),studio=new Studio(store);try{
    store.saveProject({id:'project-a',name:'Start',path:'fixture',createdAt:'',writeEnabled:true});
    const input={format:'markdown',source:'manual',text:'# Greeting\n## Goal\nCreate greeting\n## Requirements\n### R1\nShow greeting\n#### Acceptance criteria\n- Greeting is visible\n### R2\nStore greeting\n#### Acceptance criteria\n- Greeting persists\n## Constraints\n## Open questions\n'};
    const base=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
    studio.mutate('project-a','plans',base.id,'approve',{expectedRevision:1});
    const historical=studio.mutate('project-a','plans',base.id,'task-drafts',{}) as SavedTask[];
    const next=studio.mutate('project-a','plans',base.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input}) as PlanningVersion;
    studio.mutate('project-a','plans',next.id,'approve',{expectedRevision:2});
    const comparison=studio.comparePlanning('project-a',next.id,base.id);
    const [partial]=studio.mutate('project-a','plans',next.id,'replan',{requestId:randomUUID(),baseVersionId:base.id,expectedPreviewDigest:comparison.previewDigest,requirementLabels:['R1']}) as SavedTask[];
    const calls:{path:string;body:Record<string,unknown>}[]=[];
    const coordinator=createStartFlowCoordinator(scope,{get:async path=>studio.read('project-a',path.endsWith('/plans')?'plans':'tasks'),post:async(path,body)=>{
      calls.push({path,body});const match=/\/plans\/([^/]+)\/(approve|task-drafts)$/.exec(path);assert.ok(match);return studio.mutate('project-a','plans',match[1],match[2],body);
    }});
    coordinator.activate();await coordinator.refresh();assert.equal(coordinator.getSnapshot().selectedPlanId,next.id);
    assert.equal(await coordinator.prepareTasks(),true);
    const prepared=coordinator.getSnapshot().tasks.filter(task=>task.planningVersionId===next.id);
    assert.deepEqual(prepared.flatMap(task=>task.requirementLabels),['R1','R2']);
    assert.deepEqual(prepared.find(task=>task.id===partial.id),partial);
    assert.deepEqual(calls,[{path:'/api/projects/project-a/plans/'+next.id+'/task-drafts',body:{}}]);
    assert.deepEqual((studio.read('project-a','tasks') as SavedTask[]).filter(task=>task.planningVersionId===base.id),historical);
    assert.deepEqual((studio.read('project-a','tasks') as SavedTask[]).filter(task=>task.planningVersionId===next.id),prepared);
    assert.equal(await coordinator.prepareTasks(),true);assert.equal(calls.length,1);assert.equal(store.runs().length,0);
  }finally{store.close();}
});
