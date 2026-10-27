import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {Snapshot} from '../shared/types.ts';

const project={id:'project-a',name:'나의 앱',path:'/fixture',writeEnabled:true,createdAt:''},workspace={id:'workspace-a',projectId:project.id,path:'/fixture/work',branch:'orbit/work',baseSha:'a'.repeat(40),createdAt:'',status:'ready' as const};
const state:Snapshot={provider:'ready',issue:null,threadId:'thread',workspace:workspace.path,readOnly:false,runs:[],lastSeq:1,selectedWorkspaceId:workspace.id,projects:[project],workspaces:[workspace]};
const plan={id:'plan-a',projectId:project.id,revision:1,contentHash:'a'.repeat(64),state:'approved',draft:{title:'할 일 앱',goal:'목록 관리',requirements:[{label:'R1',description:'항목 추가',acceptanceCriteria:['항목이 표시된다']}],constraints:[],openQuestions:[]}};
const task={id:'task-a',projectId:project.id,planningVersionId:plan.id,title:'항목 추가',description:'추가하기',acceptanceCriteria:['항목이 표시된다'],requirementLabels:['R1'],state:'draft',verification:'not_run',createdAt:''};
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value?.props?[value,...nodes(value.props.children)]:[];
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):typeof value==='string'?value:'';
function fixture(overrides:any={},flowOverrides:any={}){
  let rendered:any,cursor=0;const slots:any[]=[],effects:(()=>void)[]=[];let flow:any={scope:{projectId:project.id,workspaceId:workspace.id,online:true,blocked:false,refreshKey:'1'},plans:[plan],tasks:[task],selectedPlanId:plan.id,loading:false,fresh:true,action:null,uncertain:false,error:'',...flowOverrides};
  const executed:any[]=[],actions:string[]=[],props:any={state,projectId:project.id,online:true,locked:false,planningBlocked:false,canRunTask:true,post:async()=>{throw Error('unexpected POST');},onNavigate:(page:string)=>actions.push(page),onProject:()=>{},workspaceAction:async(fn:any)=>fn(),onConnect:()=>actions.push('connect'),onRunTask:async(value:any)=>executed.push(value),onInterrupt:async(id:string)=>actions.push(id),...overrides};
  const coordinator={getSnapshot:()=>flow,subscribe:()=>()=>{},activate(){},dispose(){},configure(){},refresh:async()=>{},selectPlan:(id:string)=>{flow={...flow,selectedPlanId:id};},prepareTasks:async()=>true};
  const file=new URL('../web/start.tsx',import.meta.url),require=createRequire(file),module={exports:{} as any};
  const hooks={...require('react'),useState:(value:any)=>{const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},useRef:(value:any)=>{const i=cursor++;return slots[i]??={current:value};},useMemo:(fn:any)=>fn(),useEffect:(effect:()=>void)=>effects.push(effect),useLayoutEffect:()=>{},useSyncExternalStore:(_subscribe:any,get:any)=>get()};
  const stub=(name:string)=>(p:any)=>require('react').createElement('div',{'data-component':name,'data-workspace':p.workspaceId??'', 'data-run':p.runId??''},name);
  if(existsSync(file)){
    const source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    new Function('require','module','exports',source)((id:string)=>id==='react'?hooks:id.endsWith('.css')?{}:id==='./start-flow.ts'?{createStartFlowCoordinator:()=>coordinator,currentStartPlans:(plans:any[])=>plans.filter(p=>p.state!=='superseded')}:id==='./project-create.tsx'?{ProjectCreatePanel:stub('ProjectCreatePanel')}:id==='./planning/PlanningAgent.tsx'?{PlanningAgentPanel:stub('PlanningAgentPanel')}:id==='./verification.tsx'?{VerificationPanel:stub('VerificationPanel')}:id==='./development-results.tsx'?{DevelopmentResultPanel:stub('DevelopmentResultPanel')}:require(id),module,module.exports);
  }else module.exports={StartPage:()=>null,StartWorkspace:()=>null};
  const render=(inner=false)=>{cursor=0;effects.length=0;rendered=inner?module.exports.StartWorkspace({...props,workspaceId:workspace.id}):module.exports.StartPage(props);return renderToStaticMarkup(rendered);};
  return {render,executed,actions,props,setFlow:(next:any)=>{flow={...flow,...next};},flushEffects:()=>effects.splice(0).forEach(effect=>effect()),components:()=>nodes(rendered),buttons:()=>nodes(rendered).filter(e=>e.type==='button'),click(label:string){const button=this.buttons().find(e=>text(e.props.children)===label);assert.ok(button,'Missing button '+label);assert.equal(!!button.props.disabled,false);return button.props.onClick();}};
}
test('an empty catalog offers project creation on the default surface without native execution',()=>{
  const f=fixture({projectId:'',state:{...state,projects:[],workspaces:[],selectedWorkspaceId:null,projectCreationAvailable:true}});
  assert.match(f.render(),/ProjectCreatePanel/);assert.equal(f.executed.length,0);
});
test('a foreign selected workspace cannot mount the planning or execution flow',()=>{
  const f=fixture({state:{...state,selectedWorkspaceId:'foreign'}});const html=f.render();
  assert.match(html,/작업 공간/);assert.doesNotMatch(html,/PlanningAgentPanel/);assert.equal(f.executed.length,0);
});
test('the selected approved plan exposes the actual existing Task execution callback once clicked',async()=>{
  const f=fixture();const html=f.render(true);assert.match(html,/만들기 단계/);assert.match(html,/항목 추가/);assert.equal(f.executed.length,0);
  await f.click('이 작업 개발하기');assert.deepEqual(f.executed,[task]);
});
test('blocked or unobserved plans never expose an enabled Task action',()=>{
  for(const [props,flow] of [[{locked:true},{}],[{online:false},{}],[{canRunTask:false},{}],[{},{fresh:false}],[{},{uncertain:true}]] as any[]){
    const f=fixture(props,flow);assert.match(f.render(true),/만들기 단계/);assert.equal(f.buttons().some(b=>text(b.props.children)==='이 작업 개발하기'&&!b.props.disabled),false);
  }
});
test('planning progress does not invalidate its own consent or response while other work still blocks it',()=>{
  const f=fixture({state:{...state,planningBusy:true},locked:true,planningBlocked:false});f.render(true);
  assert.equal(f.components().find(node=>node.props.presentation==='simple')?.props.busy,false);
  const blocked=fixture({locked:true,planningBlocked:true});blocked.render(true);
  assert.equal(blocked.components().find(node=>node.props.presentation==='simple')?.props.busy,true);
});
test('planning and offline gates preserve the existing additional-request panel and plan',()=>{
  const f=fixture();assert.match(f.render(true),/추가 요청으로 새 기획 만들기/);
  f.props.locked=true;f.props.state={...state,planningBusy:true};
  assert.match(f.render(true),/추가 요청으로 새 기획 만들기/);
  f.props.online=false;assert.match(f.render(true),/기획을 확인하세요/);
  assert.match(f.render(true),/추가 요청으로 새 기획 만들기/);
});
test('a newly saved plan is selected after an already pending refresh finishes',()=>{
  const f=fixture({}, {loading:true});f.render(true);
  const next={...plan,id:'plan-new',draft:{...plan.draft,title:'새 수정 기획'}};
  f.components().find(node=>node.props.presentation==='simple').props.onSaved(next);
  f.render(true);f.flushEffects();
  f.setFlow({plans:[plan,next],loading:false,fresh:true});f.render(true);f.flushEffects();
  assert.match(f.render(true),/<h3>새 수정 기획<\/h3>/);
});
test('a completed foreign or older-plan Run cannot replace the current planning Task result',()=>{
  const oldRun={id:'old',workspaceId:workspace.id,taskId:task.id,planningVersionId:'old-plan',execution:'completed',prompt:'old',response:'',createdAt:'',updatedAt:''};
  const f=fixture({state:{...state,runs:[oldRun]}});const html=f.render(true);assert.match(html,/이 작업 개발하기/);assert.doesNotMatch(html,/검증 단계로/);
});
