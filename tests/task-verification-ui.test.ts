import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const preview={projectId:'p',workspaceId:'w',taskId:'t',planningVersionId:'plan',planHash:'a'.repeat(64),baseSha:'b'.repeat(40),criteria:[{label:'TODO',description:'할 일 추가',acceptanceCriteria:['입력한 항목이 표시된다']}],commands:[{id:'test',label:'기존 테스트',configDigest:'c'.repeat(64),protectedFiles:['tests/app.test.ts']}],files:[{path:'tests/app.test.ts',mode:'100644',sha256:'d'.repeat(64)}],digest:'e'.repeat(64),scope:'선택 Task와 등록된 보호 파일'};
const task={id:'t',projectId:'p',title:'할 일 구현',planningVersionId:'plan',description:'fixture',acceptanceCriteria:[],requirementLabels:['TODO'],state:'draft',verification:'not_run',createdAt:'2026-10-27T00:00:00Z'};
const initialState={provider:'ready',issue:null,threadId:'thread-a',workspace:'/fixture',readOnly:false,runs:[],lastSeq:1,selectedWorkspaceId:'w',projects:[{id:'p',name:'Project',path:'/fixture',createdAt:'now',writeEnabled:true},{id:'q',name:'Other',path:'/other',createdAt:'now',writeEnabled:true}],workspaces:[{id:'w',projectId:'p',path:'/fixture/worktree',branch:'orbit/w',baseSha:'b'.repeat(40),createdAt:'now',status:'ready'}]};
const elements=(value:any):any[]=>Array.isArray(value)?value.flatMap(elements):value&&typeof value==='object'&&value.props?[value,...elements(value.props.children)]:[];
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):typeof value==='string'?value:'';

// Run actual TSX with generic hooks; sibling page components are inert so tests
// control only this component's HTTP requests and rendered action props.
function fixture(file:string,exportName:string,initialProps:any={}){
  const slots:any[]=[],effects=new Map<number,{deps:any[];cleanup?:()=>void}>(),stubs=new Map<string,any>();
  let cursor=0,dirty=true,alive=true,tree:any,props=initialProps,pendingEffects:any[]=[];
  const requests:{path:string;options:any;resolve:(value:any)=>void}[]=[],storage=new Map<string,string>();
  const eventSources:any[]=[];
  const hooks={useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],(next:any)=>{if(!alive)return;const value=typeof next==='function'?next(slots[i]):next;if(!Object.is(value,slots[i])){slots[i]=value;dirty=true;}}];},useRef(initial:any){const i=cursor++;return slots[i]??={current:initial};},useEffect(run:any,deps:any[]){const i=cursor++,old=effects.get(i)?.deps;if(!old||old.length!==deps.length||deps.some((v,j)=>!Object.is(v,old[j])))pendingEffects.push({i,deps,run});}};
  const stub=(name:string)=>{if(!stubs.has(name)){const component=()=>null;Object.defineProperty(component,'name',{value:name});stubs.set(name,component);}return stubs.get(name);};
  const url=new URL('../web/'+file,import.meta.url),require=createRequire(url);
  const source=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{} as any};
  const sessionStorage={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)};
  new Function('require','module','exports','fetch','window','document','sessionStorage','EventSource','setTimeout','clearTimeout',source)(
    (id:string)=>id==='react'?{...require('react'),...hooks}:id==='react-dom/client'?{createRoot:()=>({render:()=>{}})}:id.endsWith('.css')?{}:id.endsWith('.tsx')?new Proxy({},{get:(_,name)=>stub(String(name))}):require(id),module,module.exports,
    (path:string,options:any)=>new Promise(resolve=>requests.push({path,options,resolve})),
    {location:{hash:'#/planning'},localStorage:sessionStorage,scrollTo:()=>{},addEventListener:()=>{},removeEventListener:()=>{}},
    {title:'',getElementById:()=>({focus:()=>{}})},sessionStorage,
    class {onopen:any;onmessage:any;onerror:any;constructor(){eventSources.push(this);}close(){}},
    (callback:()=>void,delay:number)=>setTimeout(callback,delay).unref(),clearTimeout,
  );
  async function settle(){for(let i=0;i<30;i++){if(dirty){dirty=false;cursor=0;tree=module.exports[exportName](props);const next=pendingEffects;pendingEffects=[];for(const effect of next)effects.get(effect.i)?.cleanup?.();for(const effect of next){const cleanup=effect.run();effects.set(effect.i,{deps:effect.deps,cleanup});}}await new Promise<void>(resolve=>setImmediate(resolve));if(!dirty)return;}throw new Error('Component did not settle');}
  return {settle,requests,html:()=>renderToStaticMarkup(tree),nodes:()=>elements(tree),child:(name:string)=>elements(tree).find(e=>e.type===stubs.get(name)),
    async respond(index:number,value:any,ok=true){assert.ok(requests[index]);requests[index].resolve({ok,json:async()=>value});await settle();},
    async update(next:any){props={...props,...next};dirty=true;await settle();},
    async click(label:string){const button=elements(tree).find(e=>e.type==='button'&&text(e.props.children)===label);assert.ok(button,'Missing button '+label);assert.ok(!button.props.disabled);button.props.onClick();await settle();},
    async event(data:any){assert.ok(eventSources[0]);eventSources[0].onmessage({data:JSON.stringify(data)});await settle();},
    eventNow(data:any){eventSources[0].onmessage({data:JSON.stringify(data)});},offlineNow(){eventSources[0].onerror();},
    dispose(){alive=false;for(const effect of effects.values())effect.cleanup?.();},
  };
}
async function app(){const panel=fixture('main.tsx','App');await panel.settle();await panel.respond(0,{csrfToken:'csrf'});await panel.respond(1,structuredClone(initialState));return panel;}
const preflightProps=(onRun:(digest?:string)=>void,onCancel=()=>{})=>({projectId:'p',workspaceId:'w',taskId:'t',taskTitle:'할 일 구현',scopeKey:'session-a',active:true,onRun,onCancel});

test('Task entry waits for preflight and sends the digest only after explicit confirmation',async t=>{
  const panel=await app();t.after(()=>panel.dispose());panel.child('StudioPage').props.onRunTask(task);await panel.settle();
  assert.equal(panel.requests.filter(r=>r.options?.method==='POST').length,0,'Opening a Task must not immediately dispatch it');
  const confirmation=panel.child('TaskVerificationPreviewPanel');assert.ok(confirmation);
  confirmation.props.onRun(preview.digest);confirmation.props.onRun(preview.digest);await panel.settle();
  const posts=panel.requests.filter(r=>r.options?.method==='POST');assert.equal(posts.length,1);
  assert.equal(posts[0].path,'/api/projects/p/tasks/t/run');assert.deepEqual(Object.keys(JSON.parse(posts[0].options.body)).sort(),['expectedAcceptanceDigest','requestId','workspaceId']);assert.equal(JSON.parse(posts[0].options.body).expectedAcceptanceDigest,preview.digest);
});

test('cancelled or changed-session preflight callbacks cannot dispatch a Task',async t=>{
  const panel=await app();t.after(()=>panel.dispose());panel.child('StudioPage').props.onRunTask(task);await panel.settle();
  const cancelled=panel.child('TaskVerificationPreviewPanel');assert.ok(cancelled);cancelled.props.onCancel();await panel.settle();cancelled.props.onRun(preview.digest);await panel.settle();
  assert.equal(panel.requests.filter(r=>r.options?.method==='POST').length,0);
  panel.child('StudioPage').props.onRunTask(task);await panel.settle();const previous=panel.child('TaskVerificationPreviewPanel');
  await panel.event({seq:2,kind:'session.started',at:'now',runId:null,data:{workspaceId:'w',threadId:'thread-b'}});
  previous.props.onRun(preview.digest);await panel.settle();assert.equal(panel.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('offline, project and session changes revoke confirmation before React commits the next render',async t=>{
  for(const change of ['offline','project','session','workspace','active-run']){
    const panel=await app();t.after(()=>panel.dispose());panel.child('StudioPage').props.onRunTask(task);await panel.settle();const previous=panel.child('TaskVerificationPreviewPanel');
    if(change==='offline')panel.offlineNow();else if(change==='project')panel.child('TopBar').props.onProject('q');else panel.eventNow({seq:2,kind:change==='workspace'?'workspace.selected':change==='active-run'?'run.started':'session.started',at:'now',runId:null,data:change==='active-run'?{run:{id:'other',workspaceId:'w',execution:'running'}}:{workspaceId:'w',threadId:'thread-b'}});
    previous.props.onRun(preview.digest);await panel.settle();assert.equal(panel.requests.filter(r=>r.options?.method==='POST').length,0,change);
  }
});

test('starting a workspace action revokes a pending Task confirmation before a busy render',async t=>{
  const panel=await app();t.after(()=>panel.dispose());panel.child('StudioPage').props.onRunTask(task);await panel.settle();const previous=panel.child('TaskVerificationPreviewPanel');
  panel.child('Navigation').props.onNavigate('projects');await panel.settle();
  void panel.child('WorkspacePanel').props.action(()=>new Promise(()=>{}));previous.props.onRun(preview.digest);await panel.settle();
  assert.equal(panel.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('legacy Task confirmation preserves the two-field run request',async t=>{
  const panel=await app();t.after(()=>panel.dispose());panel.child('StudioPage').props.onRunTask(task);await panel.settle();panel.child('TaskVerificationPreviewPanel').props.onRun();await panel.settle();
  const post=panel.requests.find(r=>r.options?.method==='POST');assert.ok(post);assert.deepEqual(Object.keys(JSON.parse(post.options.body)).sort(),['requestId','workspaceId']);
});

test('preflight displays criteria, command and protected bytes before accepting the exact digest',async t=>{
  const starts:any[]=[];const panel=fixture('task-verification-preview.tsx','TaskVerificationPreviewPanel',preflightProps(value=>starts.push(value)));t.after(()=>panel.dispose());await panel.settle();
  assert.equal(panel.requests[0].path,'/api/projects/p/tasks/t/verification-preview?workspaceId=w');await panel.respond(0,{preview});
  assert.deepEqual(starts,[]);assert.match(panel.html(),/입력한 항목이 표시된다/);assert.match(panel.html(),/tests\/app.test.ts/);assert.match(panel.html(),/기존 테스트/);assert.match(panel.html(),/명령 실행 승인/);
  const button=panel.nodes().find(e=>e.type==='button'&&text(e.props.children)==='기준 고정 후 Task 실행');button.props.onClick();button.props.onClick();await panel.settle();assert.deepEqual(starts,[preview.digest]);
});

test('legacy null preflight continues without a digest but failed or malformed preflight never starts',async t=>{
  for(const response of [{preview:null},{error:'INTERNAL_ERROR'},{}]){
    const starts:any[]=[];const panel=fixture('task-verification-preview.tsx','TaskVerificationPreviewPanel',preflightProps(value=>starts.push(value)));t.after(()=>panel.dispose());await panel.settle();await panel.respond(0,response,!('error' in response));
    if('preview' in response)assert.deepEqual(starts,[undefined]);else{assert.deepEqual(starts,[]);assert.match(panel.html(),/role="alert"/);}
  }
});

test('cancel and scope or offline changes reject a late preflight response',async t=>{
  for(const change of ['cancel','workspace','offline']){
    const starts:any[]=[];let cancelled=0;const panel=fixture('task-verification-preview.tsx','TaskVerificationPreviewPanel',preflightProps(value=>starts.push(value),()=>{cancelled++;}));t.after(()=>panel.dispose());await panel.settle();
    if(change==='cancel'){await panel.click('취소');assert.equal(cancelled,1);}else await panel.update(change==='workspace'?{workspaceId:'other',scopeKey:'session-b'}:{active:false});
    await panel.respond(0,{preview:null});assert.deepEqual(starts,[]);
  }
});

test('changed or unavailable acceptance blocks command and result approval while unbound remains explicit',async t=>{
  for(const state of ['changed','unavailable','unbound','current']){
    const posts:any[]=[];const panel=fixture('verification.tsx','VerificationPanel',{workspaceId:'w',runId:'r',online:true,agentActive:false,post:async(...args:any[])=>{posts.push(args);}});t.after(()=>panel.dispose());await panel.settle();
    await panel.respond(0,{workspaceId:'w',runId:'r',commands:[{id:'test',label:'Tests',executable:'node',args:[],timeoutMs:1000,configDigest:'c'.repeat(64)}],sourceDigest:'a'.repeat(64),sourceIssue:null,checks:[],quarantined:false,checkSetDigest:'f'.repeat(64),canApprove:true,approval:null,approvalCurrent:false,scope:'fixture',acceptance:{state,baseline:state==='unbound'?null:preview,issue:null}});
    const command=panel.nodes().find(e=>e.type==='button'&&text(e.props.children)==='명령 승인 후 실행');const approval=panel.nodes().find(e=>e.type==='button'&&text(e.props.children)==='Diff와 검증 결과 확인 후 승인');
    assert.equal(command.props.disabled,state==='changed'||state==='unavailable');assert.equal(approval.props.disabled,state==='changed'||state==='unavailable');
    if(state==='unbound')assert.match(panel.html(),/원래 테스트 보호/);else if(state!=='current')assert.match(panel.html(),/새 Task 실행/);
    assert.equal(posts.length,0);
  }
});
