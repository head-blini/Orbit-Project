import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {VerificationSetupView} from '../shared/verification-setup.ts';

const workspace='22222222-2222-4222-8222-222222222222',project='11111111-1111-4111-8111-111111111111';
const candidate:VerificationSetupView={projectId:project,workspaceId:workspace,revision:0,lastRequestId:null,source:'none',commands:[],issue:null,scope:'실제 테스트에 한정된 검증',candidate:{profileId:'node-test-v1',label:'Node 테스트',sourceDigest:'a'.repeat(64),baseSha:'b'.repeat(40),tests:['tests/example.test.mjs'],previewDigest:'c'.repeat(64),command:{id:'node-test-v1',label:'Node 테스트',executable:'/fixture/node',args:['--test','--','tests/example.test.mjs'],timeoutMs:120000,configDigest:'d'.repeat(64),protectedFiles:['tests/example.test.mjs','package.json']}}};
const elements=(value:any):any[]=>Array.isArray(value)?value.flatMap(elements):value&&typeof value==='object'&&value.props?[value,...elements(value.props.children)]:[];
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):typeof value==='string'?value:'';
const storageFor=(values=new Map<string,string>())=>({getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}});
type Request={path:string;body?:any;resolve:(value:any)=>void;reject:(error:Error)=>void};

// Only HTTP and the browser storage boundary are deferred. The real component's
// hooks, rendering, consent handler and submit handler execute for every case.
function fixture(storage=storageFor(),initial:object={}){
  const slots:any[]=[],effects=new Map<number,{deps:any[];cleanup?:()=>void}>();
  let cursor=0,dirty=true,alive=true,tree:any,pendingEffects:any[]=[];
  const reads:Request[]=[],writes:Request[]=[],configured:string[]=[];
  let props:any={workspaceId:workspace,online:true,busy:false,post:(path:string,body:any)=>new Promise((resolve,reject)=>writes.push({path,body,resolve,reject})),onConfigured:()=>configured.push(props.workspaceId),...initial};
  const hooks={useState(initialValue:any){const i=cursor++;if(!(i in slots))slots[i]=typeof initialValue==='function'?initialValue():initialValue;return[slots[i],(next:any)=>{if(!alive)return;const value=typeof next==='function'?next(slots[i]):next;if(!Object.is(value,slots[i])){slots[i]=value;dirty=true;}}];},useRef(initialValue:any){const i=cursor++;return slots[i]??={current:initialValue};},useEffect(run:any,deps:any[]){const i=cursor++,old=effects.get(i)?.deps;if(!old||old.length!==deps.length||deps.some((v,j)=>!Object.is(v,old[j])))pendingEffects.push({i,deps,run});}};
  const url=new URL('../web/verification-setup.tsx',import.meta.url),require=createRequire(url),module={exports:{} as any};
  const source=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','module','exports','sessionStorage','fetch',source)((id:string)=>id==='react'?{...require('react'),...hooks}:require(id),module,module.exports,storage,(path:string)=>new Promise((resolve,reject)=>reads.push({path,resolve:value=>resolve({ok:true,json:async()=>value}),reject})));
  const Panel=module.exports.VerificationSetupPanel;
  async function settle(){for(let i=0;i<30;i++){if(dirty){dirty=false;cursor=0;tree=Panel(props);const next=pendingEffects;pendingEffects=[];for(const effect of next)effects.get(effect.i)?.cleanup?.();for(const effect of next){const cleanup=effect.run();effects.set(effect.i,{deps:effect.deps,cleanup});}}await new Promise<void>(resolve=>setImmediate(resolve));if(!dirty)return;}throw new Error('Component did not settle');}
  const button=(label:string)=>{const found=elements(tree).find(e=>e.type==='button'&&text(e.props.children)===label);assert.ok(found,'Missing button: '+label);return found;};
  const checkbox=()=>{const found=elements(tree).find(e=>e.type==='input'&&e.props.type==='checkbox');assert.ok(found,'Missing consent checkbox');return found;};
  return {settle,reads,writes,configured,storage,button,checkbox,html:()=>renderToStaticMarkup(tree),inputs:()=>elements(tree).filter(e=>e.type==='input'),
    submitHandler:()=>elements(tree).find(e=>e.type==='form').props.onSubmit,
    async load(value:VerificationSetupView=candidate,index=reads.length-1){assert.ok(reads[index],'Missing view GET');reads[index].resolve(value);await settle();},
    async consent(value=true){checkbox().props.onChange({target:{checked:value}});await settle();},
    submitNow(){const form=elements(tree).find(e=>e.type==='form');assert.ok(form,'Missing setup form');form.props.onSubmit({preventDefault(){}});},
    async submit(){this.submitNow();await settle();},
    async click(label:string){const value=button(label);assert.ok(!value.props.disabled,'Disabled button: '+label);value.props.onClick();await settle();},
    async resolve(index=0,overrides:object={}){assert.ok(writes[index]);writes[index].resolve({requestId:writes[index].body.requestId,projectId:project,workspaceId:workspace,revision:1,profileId:'node-test-v1',createdAt:'2026-10-27T00:00:00Z',...overrides});await settle();},
    async reject(message:string,index=0){assert.ok(writes[index]);writes[index].reject(new Error(message));await settle();},
    async update(next:object){props={...props,...next};dirty=true;await settle();},
    dispose(){alive=false;for(const effect of effects.values())effect.cleanup?.();},
  };
}

test('setup reads the current preview without mutating and shows fixed command, tests and protected files',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();
  assert.equal(panel.reads[0]?.path,'/api/workspaces/'+workspace+'/verification-setup');assert.equal(panel.writes.length,0);await panel.load();
  assert.match(panel.html(),/tests\/example.test.mjs/);assert.match(panel.html(),/package.json/);assert.match(panel.html(),/--test/);assert.match(panel.html(),/OS/);assert.match(panel.html(),/실행하지 않/);
  assert.equal(panel.inputs().length,1);assert.equal(panel.inputs()[0].props.type,'checkbox');assert.ok(panel.button('검증 명령 등록').props.disabled);
});

test('explicit consent sends the exact preview body once despite synchronous duplicate submit and only then refreshes',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load();await panel.submit();assert.equal(panel.writes.length,0);
  await panel.consent();panel.submitNow();panel.submitNow();await panel.settle();assert.equal(panel.writes.length,1);
  const request=panel.writes[0];assert.equal(request.path,'/api/workspaces/'+workspace+'/verification-setup');assert.deepEqual(Object.keys(request.body).sort(),['confirmed','expectedPreviewDigest','profileId','requestId']);assert.equal(request.body.confirmed,true);assert.equal(request.body.profileId,'node-test-v1');assert.equal(request.body.expectedPreviewDigest,'c'.repeat(64));assert.match(request.body.requestId,/^[a-f0-9-]{36}$/i);assert.equal(panel.configured.length,0);
  await panel.resolve();assert.deepEqual(panel.configured,[workspace]);assert.equal(panel.writes.length,1);assert.equal(panel.reads.length,2);
});

test('uncertain outcomes preserve the exact request through reload and retry only on an explicit action',async t=>{
  const storage=storageFor(),first=fixture(storage);await first.settle();await first.load();await first.consent();await first.submit();const original=first.writes[0].body;
  await first.reject('Failed to fetch with password=private-secret');assert.doesNotMatch(first.html(),/private-secret/);assert.equal(first.configured.length,0);first.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();await restored.load();assert.equal(restored.writes.length,0);assert.ok(restored.button('검증 명령 등록').props.disabled);
  await restored.click('같은 등록 요청으로 다시 확인');assert.deepEqual(restored.writes.map(r=>r.body),[original]);await restored.resolve();assert.deepEqual(restored.configured,[workspace]);
});

test('a loaded matching lastRequestId reconciles an uncertain save without an automatic POST',async t=>{
  const storage=storageFor(),first=fixture(storage);await first.settle();await first.load();await first.consent();await first.submit();const request=first.writes[0].body;await first.reject('network');first.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();await restored.load({...candidate,source:'preset',revision:1,lastRequestId:request.requestId,commands:[candidate.candidate!.command]});
  assert.equal(restored.writes.length,0);assert.deepEqual(restored.configured,[workspace]);assert.equal(restored.checkbox().props.checked,false);
});

test('manual refresh removes previous consent even when the preview is unchanged',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load();await panel.consent();await panel.click('검증 설정 다시 확인');await panel.load();
  assert.equal(panel.checkbox().props.checked,false);await panel.submit();assert.equal(panel.writes.length,0);
});

test('stale-preview rejection frees the rejected request and requires new preview consent',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load();await panel.consent();await panel.submit();const previous=panel.writes[0].body.requestId;await panel.reject('VERIFICATION_SETUP_PREVIEW_STALE');
  assert.match(panel.html(),/변경/);await panel.click('검증 설정 다시 확인');await panel.load({...candidate,candidate:{...candidate.candidate!,previewDigest:'e'.repeat(64)}});await panel.submit();assert.equal(panel.writes.length,1);
  await panel.consent();await panel.submit();assert.notEqual(panel.writes[1].body.requestId,previous);assert.equal(panel.writes[1].body.expectedPreviewDigest,'e'.repeat(64));
});

test('offline or active transitions revoke consent and block stale submit handlers',async t=>{
  for(const next of [{online:false},{busy:true}]){
    const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load();await panel.consent();const oldSubmit=panel.submitHandler();await panel.update(next);
    oldSubmit({preventDefault(){}});await panel.settle();assert.equal(panel.writes.length,0);
    await panel.update({online:true,busy:false});await panel.load();oldSubmit({preventDefault(){}});await panel.settle();assert.equal(panel.checkbox().props.checked,false);await panel.submit();assert.equal(panel.writes.length,0);
  }
});

test('late GET results cannot replace the new workspace or restore a view after disconnect',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.update({workspaceId:'another-workspace'});await panel.load(candidate,0);assert.doesNotMatch(panel.html(),/tests\/example.test.mjs/);
  await panel.load({...candidate,workspaceId:'another-workspace',candidate:{...candidate.candidate!,tests:['new.test.js']}});assert.match(panel.html(),/new.test.js/);await panel.update({online:false});assert.doesNotMatch(panel.html(),/new.test.js/);assert.equal(panel.writes.length,0);
});

test('stale POST responses never notify another workspace, after a transient disconnect, an active transition or unmount',async t=>{
  for(const transition of ['workspace','offline','busy','unmount']){
    const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load();await panel.consent();await panel.submit();
    if(transition==='workspace')await panel.update({workspaceId:'other'});
    if(transition==='offline'){await panel.update({online:false});await panel.update({online:true});}
    if(transition==='busy'){await panel.update({busy:true});await panel.update({busy:false});}
    if(transition==='unmount')panel.dispose();
    await panel.resolve();assert.deepEqual(panel.configured,[]);assert.ok(panel.storage.getItem('orbit.verification.setup.pending.'+workspace));
  }
});

test('workspace-scoped pending storage never replays a request in a different workspace',async t=>{
  const storage=storageFor(),first=fixture(storage);await first.settle();await first.load();await first.consent();await first.submit();await first.reject('network');first.dispose();
  const other=fixture(storage,{workspaceId:'other'});t.after(()=>other.dispose());await other.settle();await other.load({...candidate,workspaceId:'other'});await other.consent();await other.submit();
  assert.equal(other.writes[0].path,'/api/workspaces/other/verification-setup');assert.notEqual(other.writes[0].body.requestId,first.writes[0].body.requestId);
});

test('no-test and host configurations expose useful read-only guidance and never admit a preset write',async t=>{
  for(const value of [{...candidate,issue:'NO_NODE_TEST_FILES' as const,candidate:null},{...candidate,source:'host' as const,issue:'HOST_CONFIGURATION' as const,candidate:null,commands:[candidate.candidate!.command]}]){
    const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load(value);assert.equal(panel.writes.length,0);assert.equal(panel.inputs().length,0);
    if(value.source==='host'){assert.match(panel.html(),/호스트/);assert.match(panel.html(),/--test/);assert.match(panel.html(),/덮어쓸 수 없/);}else assert.match(panel.html(),/\*\.test.js, \*\.test.mjs, \*\.test.cjs 작성 후 다시 확인/);
  }
});

test('storage failure blocks dispatch, invalid receipts stay unresolved, and read errors redact details',async t=>{
  const blocked=fixture({getItem:()=>null,setItem:()=>{throw Error('blocked');},removeItem:()=>{}});t.after(()=>blocked.dispose());await blocked.settle();await blocked.load();await blocked.consent();await blocked.submit();assert.equal(blocked.writes.length,0);assert.match(blocked.html(),/세션 저장소/);
  const malformed=fixture();t.after(()=>malformed.dispose());await malformed.settle();await malformed.load();await malformed.consent();await malformed.submit();await malformed.resolve(0,{workspaceId:'unrelated'});assert.equal(malformed.configured.length,0);assert.ok(malformed.storage.getItem('orbit.verification.setup.pending.'+workspace));
  const failed=fixture();t.after(()=>failed.dispose());await failed.settle();failed.reads[0].reject(Error('/private/auth.json secret'));await failed.settle();assert.match(failed.html(),/role="alert"/);assert.doesNotMatch(failed.html(),/auth.json|secret/);
});

test('receipt and reload reconciliation must match the saved target revision as well as request identity',async t=>{
  const storage=storageFor(),first=fixture(storage);await first.settle();await first.load({...candidate,source:'preset',revision:3});await first.consent();await first.submit();const request=first.writes[0].body;
  await first.resolve(0,{revision:2});assert.deepEqual(first.configured,[]);first.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();await restored.load({...candidate,source:'preset',revision:2,lastRequestId:request.requestId});assert.deepEqual(restored.configured,[]);assert.ok(restored.storage.getItem('orbit.verification.setup.pending.'+workspace));
  await restored.click('검증 설정 다시 확인');await restored.load({...candidate,source:'preset',revision:4,lastRequestId:request.requestId});assert.deepEqual(restored.configured,[workspace]);assert.equal(restored.writes.length,0);
});

test('corrupt pending storage and mismatched API scope prevent configuration instead of inventing a fresh request',async t=>{
  const corrupt=fixture(storageFor(new Map([['orbit.verification.setup.pending.'+workspace,'{"requestId":"bad"}']])));t.after(()=>corrupt.dispose());await corrupt.settle();await corrupt.load();assert.match(corrupt.html(),/세션 저장소/);assert.ok(corrupt.checkbox().props.disabled);await corrupt.consent();await corrupt.submit();assert.equal(corrupt.writes.length,0);
  const mismatched=fixture();t.after(()=>mismatched.dispose());await mismatched.settle();await mismatched.load({...candidate,workspaceId:'other'});assert.match(mismatched.html(),/role="alert"/);assert.equal(mismatched.inputs().length,0);assert.equal(mismatched.writes.length,0);
});

test('late obsolete success cannot remove a newer request persisted by a remounted panel',async t=>{
  const storage=storageFor(),first=fixture(storage);await first.settle();await first.load();await first.consent();await first.submit();const initial=first.writes[0].body;first.dispose();
  const next=fixture(storage);t.after(()=>next.dispose());await next.settle();await next.load({...candidate,revision:1,source:'preset',lastRequestId:initial.requestId});await next.consent();await next.submit();const replacement=next.writes[0].body;
  await first.resolve();assert.equal(first.configured.length,0);await next.reject('network');next.dispose();
  const restored=fixture(storage);t.after(()=>restored.dispose());await restored.settle();await restored.load({...candidate,revision:1,source:'preset',lastRequestId:initial.requestId});await restored.click('같은 등록 요청으로 다시 확인');assert.deepEqual(restored.writes[0].body,replacement);
});

test('save storage removal failure preserves the pending request and does not announce unconfirmed reconciliation',async t=>{
  const source=storageFor(),panel=fixture({...source,removeItem:()=>{throw Error('disabled');}});t.after(()=>panel.dispose());await panel.settle();await panel.load();await panel.consent();await panel.submit();await panel.resolve();assert.match(panel.html(),/세션 저장소/);assert.deepEqual(panel.configured,[]);assert.ok(source.getItem('orbit.verification.setup.pending.'+workspace));
});

test('server-supported non-UUID request IDs render a saved preset and allow the next registration revision',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();await panel.load({...candidate,source:'preset',revision:3,lastRequestId:'setup-1',commands:[candidate.candidate!.command]});
  assert.doesNotMatch(panel.html(),/role="alert"/);assert.match(panel.html(),/저장된 프리셋/);assert.match(panel.html(),/revision 3/);assert.equal(panel.writes.length,0);
  await panel.consent();await panel.submit();assert.equal(panel.writes.length,1);await panel.resolve(0,{revision:4});assert.deepEqual(panel.configured,[workspace]);
});
