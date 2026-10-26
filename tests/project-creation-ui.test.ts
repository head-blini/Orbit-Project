import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {resolveProject} from '../web/navigation.ts';

const prepared={project:{id:'11111111-1111-4111-8111-111111111111',name:'우리 앱',path:'/fixture/project',createdAt:'2026-10-27T00:00:00Z',writeEnabled:true},workspace:{id:'22222222-2222-4222-8222-222222222222',projectId:'11111111-1111-4111-8111-111111111111',path:'/fixture/worktree',branch:'orbit/fixture',baseSha:'a'.repeat(40),createdAt:'2026-10-27T00:00:00Z',status:'ready'}};
const elements=(value:any):any[]=>Array.isArray(value)?value.flatMap(elements):value&&typeof value==='object'&&value.props?[value,...elements(value.props.children)]:[];
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):typeof value==='string'?value:'';
const storageFor=(values=new Map<string,string>())=>({getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}});

function load(file:string,hooks:object,storage:ReturnType<typeof storageFor>):any{
  const url=new URL('../web/'+file,import.meta.url),require=createRequire(url),module={exports:{} as any};
  const source=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','module','exports','sessionStorage',source)(
    (id:string)=>id==='react'?{...require('react'),...hooks}:id.endsWith('.tsx')?load(id.replace(/^\.\//,''),hooks,storage):require(id),module,module.exports,storage,
  );
  return module.exports;
}

// The HTTP boundary is deferred; generic hooks execute the actual form's handlers,
// receipt restoration and rendering without adding a DOM dependency.
function fixture(storage=storageFor()){
  const slots:any[]=[],effects=new Map<number,{deps:any[];cleanup?:()=>void}>();
  let cursor=0,dirty=true,alive=true,tree:any,pendingEffects:any[]=[];
  const requests:{path:string;body:any;resolve:(value:any)=>void;reject:(error:Error)=>void}[]=[],selected:string[]=[];
  let planning=0,actions=0;
  let props:any={projectId:'old-project',projectCount:1,selectedWorkspaceId:'old-workspace',online:true,locked:false,
    post:(path:string,body:any)=>new Promise((resolve,reject)=>requests.push({path,body,resolve,reject})),
    onProject:(id:string)=>{selected.push(id);props={...props,projectId:id};dirty=true;},onPlanning:()=>{planning++;},
    action:async(fn:()=>Promise<void>)=>{actions++;props={...props,locked:true};dirty=true;try{await fn();}finally{props={...props,locked:false};dirty=true;}},
  };
  const hooks={useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],(next:any)=>{if(!alive)return;const value=typeof next==='function'?next(slots[i]):next;if(!Object.is(value,slots[i])){slots[i]=value;dirty=true;}}];},useRef(initial:any){const i=cursor++;return slots[i]??={current:initial};},useEffect(run:any,deps:any[]){const i=cursor++,old=effects.get(i)?.deps;if(!old||old.length!==deps.length||deps.some((v,j)=>!Object.is(v,old[j])))pendingEffects.push({i,deps,run});}};
  const {ProjectCreatePanel}=load('project-create.tsx',hooks,storage);
  async function settle(){for(let i=0;i<30;i++){if(dirty){dirty=false;cursor=0;tree=ProjectCreatePanel(props);const next=pendingEffects;pendingEffects=[];for(const effect of next)effects.get(effect.i)?.cleanup?.();for(const effect of next){const cleanup=effect.run();effects.set(effect.i,{deps:effect.deps,cleanup});}}await new Promise<void>(resolve=>setImmediate(resolve));if(!dirty)return;}throw new Error('Component did not settle');}
  const button=(label:string)=>{const value=elements(tree).find(e=>e.type==='button'&&text(e.props.children)===label);assert.ok(value,'Missing button: '+label);return value;};
  return {settle,requests,selected,get planning(){return planning;},get actions(){return actions;},html:()=>renderToStaticMarkup(tree),
    input:()=>elements(tree).find(e=>e.type==='input'),
    async name(value:string){const input=elements(tree).find(e=>e.type==='input');assert.ok(input);input.props.onChange({target:{value}});await settle();},
    submitNow(){const form=elements(tree).find(e=>e.type==='form');assert.ok(form);form.props.onSubmit({preventDefault(){}});},
    async submit(){this.submitNow();await settle();},
    async click(label:string){const value=button(label);assert.ok(!value.props.disabled,'Disabled button: '+label);value.props.onClick();await settle();},
    async resolve(index:number,value:any){assert.ok(requests[index]);requests[index].resolve(value);await settle();},
    async reject(index:number,message:string){assert.ok(requests[index]);requests[index].reject(new Error(message));await settle();},
    async update(next:any){props={...props,...next};dirty=true;await settle();},
    dispose(){alive=false;for(const effect of effects.values())effect.cleanup?.();},
  };
}

test('managed creation is capability gated while existing Git registration and read-only guidance remain available',()=>{
  const {WorkspacePanel}=load('workspaces.tsx',{},storageFor());
  for(const available of [undefined,false,true]){
    const html=renderToStaticMarkup(React.createElement(WorkspacePanel,{state:{projectCreationAvailable:available,projects:[{id:'p',name:'Existing',path:'/fixture',writeEnabled:false}],workspaces:[]},projectId:'p',locked:false,onProject:()=>{},post:async()=>{},action:async(fn:any)=>fn()}));
    assert.equal(html.includes('새 프로젝트 이름'),available===true);
    assert.match(html,/로컬 Git 저장소 경로/);assert.match(html,/ORBIT_ALLOWED_PROJECTS/);
  }
});

test('one explicit name submission survives double clicks and selects the prepared workspace before offering planning',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.name('  우리 앱  ');
  panel.submitNow();panel.submitNow();await panel.settle();assert.equal(panel.requests.length,1);
  assert.equal(panel.requests[0].path,'/api/projects/create');assert.deepEqual(Object.keys(panel.requests[0].body).sort(),['name','requestId']);assert.equal(panel.requests[0].body.name,'우리 앱');assert.match(panel.requests[0].body.requestId,/^[0-9a-f-]{36}$/i);
  assert.equal(panel.actions,1);assert.equal(panel.planning,0);
  await panel.resolve(0,prepared);assert.equal(panel.requests.length,2);assert.equal(panel.requests[1].path,'/api/workspaces/select');assert.deepEqual(panel.requests[1].body,{workspaceId:prepared.workspace.id});assert.deepEqual(panel.selected,[]);
  await panel.resolve(1,{});await panel.update({selectedWorkspaceId:prepared.workspace.id});assert.deepEqual(panel.selected,[prepared.project.id]);
  assert.equal(panel.planning,0);await panel.click('기획으로 이동');assert.equal(panel.planning,1);
  assert.match(panel.html(),/AI 실행/);assert.match(panel.html(),/검증 명령/);
});

test('an uncertain creation pins its name and request across reload without an automatic POST',async t=>{
  const storage=storageFor(),first=fixture(storage);t.after(()=>first.dispose());await first.settle();await first.name('우리 앱');await first.submit();const request=first.requests[0].body;
  await first.reject(0,'Failed to fetch');assert.ok(first.input().props.disabled);first.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();assert.equal(restored.requests.length,0);assert.equal(restored.input().props.value,'우리 앱');assert.ok(restored.input().props.disabled);
  await restored.click('같은 요청으로 다시 확인');assert.equal(restored.requests.length,1);assert.deepEqual(restored.requests[0].body,request);
});

test('a failed workspace selection retries only selection, including after reload',async t=>{
  const storage=storageFor(),first=fixture(storage);t.after(()=>first.dispose());await first.settle();await first.name('우리 앱');await first.submit();await first.resolve(0,prepared);await first.reject(1,'Failed to fetch');
  assert.match(first.html(),/작업 공간/);first.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();assert.equal(restored.requests.length,0);
  await restored.click('작업 공간 선택 다시 시도');assert.deepEqual(restored.requests.map(r=>({path:r.path,body:r.body})),[{path:'/api/workspaces/select',body:{workspaceId:prepared.workspace.id}}]);
});

test('offline and changed project or workspace stop a late creation from selecting, but preserve its result for explicit selection',async t=>{
  for(const next of [{online:false},{projectId:'another-project'},{selectedWorkspaceId:'another-workspace'}]){
    const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.name('우리 앱');await panel.submit();await panel.update(next);await panel.resolve(0,prepared);
    assert.equal(panel.requests.length,1);assert.deepEqual(panel.selected,[]);assert.equal(panel.planning,0);
    await panel.update({online:true});await panel.click('작업 공간 선택 다시 시도');assert.equal(panel.requests.length,2);assert.equal(panel.requests[1].path,'/api/workspaces/select');
  }
});

test('initial locks and unavailable receipt storage prevent creation, and unmount prevents follow-up selection',async t=>{
  for(const next of [{online:false},{locked:true}]){
    const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.name('우리 앱');await panel.update(next);panel.submitNow();await panel.settle();assert.equal(panel.requests.length,0);
  }
  const unavailable=fixture({getItem:()=>null,setItem:()=>{throw new Error('disabled');},removeItem:()=>{}});t.after(()=>unavailable.dispose());await unavailable.settle();await unavailable.name('우리 앱');await unavailable.submit();assert.equal(unavailable.requests.length,0);assert.match(unavailable.html(),/role="alert"/);
  const storage=storageFor(),unmounted=fixture(storage);await unmounted.settle();await unmounted.name('우리 앱');await unmounted.submit();unmounted.dispose();await unmounted.resolve(0,prepared);assert.equal(unmounted.requests.length,1);
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();await restored.click('작업 공간 선택 다시 시도');assert.equal(restored.requests[0].path,'/api/workspaces/select');
});

test('the selection SSE reconnect does not erase its acknowledged success or automatically navigate',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.name('우리 앱');await panel.submit();await panel.resolve(0,prepared);
  await panel.update({online:false,selectedWorkspaceId:prepared.workspace.id});await panel.resolve(1,{});assert.deepEqual(panel.selected,[prepared.project.id]);assert.equal(panel.planning,0);
  await panel.update({online:true});await panel.click('기획으로 이동');assert.equal(panel.planning,1);
});

test('an authoritative invalid name rejection permits correction, but storage removal failure keeps the request pinned',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.name('AKIA0123456789ABCDEF');await panel.submit();const previous=panel.requests[0].body.requestId;
  await panel.reject(0,'INVALID_FIELDS');assert.equal(panel.input().props.disabled,false);await panel.name('Task-manager');await panel.submit();assert.equal(panel.requests.length,2);assert.equal(panel.requests[1].body.name,'Task-manager');assert.notEqual(panel.requests[1].body.requestId,previous);
  const storage=storageFor(),blocked=fixture({...storage,removeItem:()=>{throw new Error('disabled');}});t.after(()=>blocked.dispose());await blocked.settle();await blocked.name('AKIA0123456789ABCDEF');await blocked.submit();await blocked.reject(0,'INVALID_FIELDS');assert.equal(blocked.input().props.disabled,true);
});

test('a late response from an unmounted panel cannot overwrite a newer pending creation receipt',async t=>{
  const storage=storageFor(),first=fixture(storage);await first.settle();await first.name('우리 앱');await first.submit();await first.resolve(0,prepared);first.dispose();
  const next=fixture(storage);t.after(()=>next.dispose());await next.settle();await next.click('작업 공간 선택 다시 시도');await next.resolve(0,{});await next.update({selectedWorkspaceId:prepared.workspace.id});await next.click('다른 프로젝트 만들기');await next.name('다음 프로젝트');await next.submit();const request=next.requests[1].body;
  await first.resolve(1,{});next.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();assert.equal(restored.requests.length,0);assert.equal(restored.input().props.value,'다음 프로젝트');await restored.click('같은 요청으로 다시 확인');assert.deepEqual(restored.requests[0].body,request);
});

test('the empty catalog fallback caused by the first project event still selects its newly prepared workspace',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.update({projectId:resolveProject([],'',null),projectCount:0,selectedWorkspaceId:null});
  await panel.name('우리 앱');await panel.submit();
  // saveProject refreshes main's catalog before the creation HTTP response.
  await panel.update({projectId:resolveProject([prepared.project],'',null),projectCount:1});await panel.resolve(0,prepared);
  assert.equal(panel.requests.length,2);assert.equal(panel.requests[1].path,'/api/workspaces/select');assert.deepEqual(panel.requests[1].body,{workspaceId:prepared.workspace.id});
  await panel.resolve(1,{});await panel.update({selectedWorkspaceId:prepared.workspace.id});await panel.click('기획으로 이동');assert.equal(panel.planning,1);
});

test('first-project fallback does not forgive any transient unrelated project, workspace or connection change',async t=>{
  const fallback={projectId:resolveProject([prepared.project],'',null),projectCount:1};
  for(const transitions of [
    [{online:false},{online:true,...fallback}],
    [{selectedWorkspaceId:'unrelated'},{selectedWorkspaceId:null,...fallback}],
    [{projectId:'unrelated'},fallback],
    [fallback,{projectId:''},fallback],
    [{...fallback,projectCount:2}],
  ]){
    const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.update({projectId:'',projectCount:0,selectedWorkspaceId:null});await panel.name('우리 앱');await panel.submit();
    for(const transition of transitions)await panel.update(transition);
    await panel.resolve(0,prepared);assert.equal(panel.requests.length,1);assert.deepEqual(panel.selected,[]);assert.equal(panel.planning,0);
  }
});
