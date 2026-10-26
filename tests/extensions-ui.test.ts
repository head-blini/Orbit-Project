import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {ExtensionInventory} from '../shared/extensions.ts';

async function components(){
  const target=new URL('../web/extensions.tsx',import.meta.url).href;
  const hooks=registerHooks({load(url,context,nextLoad){if(url===target)return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return nextLoad(url,context);}});
  try{return await import('../web/extensions.tsx');}finally{hooks.deregister();}
}
const scope=(workspaceId='workspace-a')=>({workspaceId,matches:true,online:true,status:'ready' as const});
function inventory(workspaceId='workspace-a',name='Fixture skill'):ExtensionInventory{return {workspaceId,source:'codex_app_server',status:'available',checkedAt:'2026-10-26T00:00:00.000Z',sections:[
  {kind:'skills',status:'available',issue:null,items:[{id:'skill-1',name,scope:'project',configuredEnabled:true,effective:'unknown',version:null,handlerType:null,nativeTrust:'unknown',pluginOwned:false}]},
  {kind:'hooks',status:'available',issue:null,items:[{id:'hook-1',name:'preToolUse hook',scope:'user',configuredEnabled:true,effective:'blocked_policy',version:null,handlerType:'command',nativeTrust:'trusted',pluginOwned:null}]},
  {kind:'mcp',status:'available',issue:null,items:[{id:'mcp-1',name:'Fixture MCP',scope:'unknown',configuredEnabled:false,effective:'blocked_policy',version:null,handlerType:null,nativeTrust:'unknown',pluginOwned:null}]},
  {kind:'plugins',status:'not_connected',issue:null,items:[]},
]};}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('initial SSR sends no native request and explicit collection is gated by ready/current/online/idle scope',async()=>{
  const {ExtensionsPanel}=await components();let posts=0;
  const props={...scope(),busy:false,post:async()=>{posts++;throw new Error('SSR must not send');}};
  const html=renderToStaticMarkup(createElement(ExtensionsPanel,props));assert.equal(posts,0);
  assert.match(html,/<button(?![^>]*disabled)[^>]*>공식 확장 목록 조회/);assert.match(html,/목록 상태 새로고침/);assert.match(html,/60초/);
  for(const extra of [{online:false},{matches:false},{status:'disconnected' as const},{busy:true}])
    assert.match(renderToStaticMarkup(createElement(ExtensionsPanel,{...props,...extra})),/<button[^>]*disabled[^>]*>공식 확장 목록 조회/);
  assert.equal(posts,0);assert.match(html,/Skills/);assert.match(html,/Hooks/);assert.match(html,/MCP/);assert.match(html,/Plugins/);assert.match(html,/unknown/);
});

test('inventory renders escaped DTO metadata, unknown versions, configured/effective split and no raw private fields',async()=>{
  const {ExtensionsInventoryDetails}=await components(),value=inventory('workspace-a','<script>unsafe skill</script>');let privateReads=0;
  for(const key of ['path','command','env','dependencies','description','url','statusMessage'])Object.defineProperty(value.sections[0].items[0],key,{get(){privateReads++;throw new Error('PRIVATE_INVENTORY_FIELD');}});
  const html=renderToStaticMarkup(createElement(ExtensionsInventoryDetails,{inventory:value,workspaceId:'workspace-a',visible:true}));
  assert.match(html,/&lt;script&gt;unsafe skill&lt;\/script&gt;/);assert.doesNotMatch(html,/<script|PRIVATE_INVENTORY_FIELD/);assert.equal(privateReads,0);
  assert.match(html,/설정상.*켜짐/);assert.match(html,/현재 정책에서 비활성/);assert.match(html,/버전.*unknown/);assert.match(html,/Native 신뢰.*trusted/);assert.match(html,/Orbit 승인.*별개/);
  assert.match(html,/Claude.*미연결/);assert.match(html,/설치.*프로필.*미구현/);assert.doesNotMatch(html,/<input|<textarea|<a\s/);
});

test('foreign workspace or disconnected inventory never appears and partial/unknown is not a fabricated empty result',async()=>{
  const {ExtensionsInventoryDetails}=await components(),value=inventory('workspace-a','FOREIGN_WORKSPACE_ROW');
  for(const props of [{workspaceId:'workspace-b',visible:true},{workspaceId:'workspace-a',visible:false}]){
    const html=renderToStaticMarkup(createElement(ExtensionsInventoryDetails,{inventory:value,...props}));assert.doesNotMatch(html,/FOREIGN_WORKSPACE_ROW/);assert.match(html,/미조회|unknown/);
  }
  value.status='partial';value.sections[0]={kind:'skills',status:'partial',issue:'EXTENSIONS_PARTIAL',items:[]};value.sections[2]={kind:'mcp',status:'unknown',issue:'MCP_ISOLATION_REQUIRED',items:[]};
  const html=renderToStaticMarkup(createElement(ExtensionsInventoryDetails,{inventory:value,workspaceId:'workspace-a',visible:true}));assert.match(html,/일부/);assert.match(html,/전체 목록.*unknown/);assert.match(html,/MCP_ISOLATION_REQUIRED/);
});

test('manual native POST supersedes an initial GET, duplicate POSTs share no second call, and a cache GET cannot replace the pending POST',async()=>{
  const {createExtensionsRequests}=await components(),get=deferred<ExtensionInventory>(),post=deferred<ExtensionInventory>(),calls:unknown[]=[],published:unknown[]=[];
  const requests=createExtensionsRequests({get:()=>get.promise,post:async workspaceId=>{calls.push(workspaceId);return post.promise;},publish:value=>published.push(value)});requests.reset(scope());
  const initial=requests.load(),refresh=requests.refresh(false);assert.equal(await requests.refresh(false),false);assert.equal(await requests.load(),false);assert.deepEqual(calls,['workspace-a']);
  post.resolve(inventory('workspace-a','fresh POST'));await refresh;assert.equal(requests.snapshot().inventory?.sections[0].items[0].name,'fresh POST');assert.equal(requests.snapshot().refreshing,false);
  get.resolve(inventory('workspace-a','stale GET'));await initial;assert.equal(requests.snapshot().inventory?.sections[0].items[0].name,'fresh POST');assert.equal(requests.snapshot().loading,false);assert.ok(published.length>0);requests.dispose();
});

test('workspace switch discards both old results and old finally while the new workspace POST stays pending',async()=>{
  const {createExtensionsRequests}=await components(),a=deferred<ExtensionInventory>(),b=deferred<ExtensionInventory>(),calls:(string|null)[]=[];
  const requests=createExtensionsRequests({get:async()=>inventory(),post:workspaceId=>{calls.push(workspaceId);return workspaceId==='workspace-a'?a.promise:b.promise;},publish:()=>{}});
  requests.reset(scope());const old=requests.refresh(false);requests.reset(scope('workspace-b'));const current=requests.refresh(false);
  a.resolve(inventory('workspace-a','OLD_A'));await old;assert.equal(requests.snapshot().refreshing,true);assert.equal(requests.snapshot().inventory,null);assert.equal(await requests.refresh(false),false);
  b.resolve(inventory('workspace-b','CURRENT_B'));await current;assert.equal(requests.snapshot().refreshing,false);assert.equal(requests.snapshot().inventory?.workspaceId,'workspace-b');assert.deepEqual(calls,['workspace-a','workspace-b']);requests.dispose();
});

test('disconnect/reconnect and disposal invalidate old connection results without automatically collecting again',async()=>{
  const {createExtensionsRequests}=await components(),pending=deferred<ExtensionInventory>();let posts=0,published=0;
  const requests=createExtensionsRequests({get:()=>pending.promise,post:async()=>{posts++;return inventory();},publish:()=>{published++;}});
  requests.reset(scope());const old=requests.load();requests.reset({...scope(),online:false,status:'disconnected'});pending.resolve(inventory('workspace-a','OLD_CONNECTION'));await old;
  assert.equal(requests.snapshot().inventory,null);assert.equal(requests.snapshot().loading,false);requests.reset(scope());assert.equal(posts,0);assert.equal(requests.snapshot().inventory,null);
  const late=deferred<ExtensionInventory>(),second=createExtensionsRequests({get:()=>late.promise,post:async()=>inventory(),publish:()=>{published++;}});second.reset(scope());const loading=second.load();second.dispose();const count=published;late.resolve(inventory());await loading;assert.equal(published,count);requests.dispose();
});

test('native collection is denied for unavailable scopes and busy work, while cache reads are inert',async()=>{
  const {createExtensionsRequests}=await components();let posts=0,gets=0;
  const requests=createExtensionsRequests({get:async()=>{gets++;return inventory();},post:async()=>{posts++;return inventory();},publish:()=>{}});
  for(const extra of [{matches:false},{online:false},{status:'connecting' as const}]){requests.reset({...scope(),...extra});assert.equal(await requests.refresh(false),false);}
  requests.reset(scope());assert.equal(await requests.refresh(true),false);assert.equal(posts,0);await requests.load();assert.equal(gets,1);assert.equal(posts,0);requests.dispose();
});

test('the existing read-only null workspace can explicitly collect its own inventory and never displays a managed workspace response',async()=>{
  const {ExtensionsPanel,ExtensionsInventoryDetails,createExtensionsRequests}=await components(),value:ExtensionInventory={...inventory(),workspaceId:null},calls:(string|null)[]=[];
  const props={workspaceId:null,matches:true,online:true,status:'ready' as const,busy:false,post:async()=>value};
  const html=renderToStaticMarkup(createElement(ExtensionsPanel,props));assert.match(html,/<button(?![^>]*disabled)[^>]*>공식 확장 목록 조회/);
  const requests=createExtensionsRequests({get:async()=>value,post:async id=>{calls.push(id);return value;},publish:()=>{}});requests.reset(props);assert.equal(await requests.refresh(false),true);assert.deepEqual(calls,[null]);assert.equal(requests.snapshot().inventory?.sections[0].items[0].name,'Fixture skill');
  const shown=renderToStaticMarkup(createElement(ExtensionsInventoryDetails,{inventory:value,workspaceId:null,visible:true}));assert.match(shown,/Fixture skill/);
  const hidden=renderToStaticMarkup(createElement(ExtensionsInventoryDetails,{inventory:inventory(),workspaceId:null,visible:true}));assert.doesNotMatch(hidden,/Fixture skill/);requests.dispose();
});

test('errors are fixed text, mismatched POST workspace is rejected and stale GET errors cannot erase a fresh result',async()=>{
  const {createExtensionsRequests}=await components(),get=deferred<ExtensionInventory>();
  const requests=createExtensionsRequests({get:()=>get.promise,post:async()=>inventory('workspace-a','CURRENT'),publish:()=>{}});requests.reset(scope());const old=requests.load();await requests.refresh(false);
  get.reject(new Error('PRIVATE_NATIVE_CONFIGURATION'));await old;assert.equal(requests.snapshot().inventory?.sections[0].items[0].name,'CURRENT');assert.equal(requests.snapshot().error,'');requests.dispose();
  const wrong=createExtensionsRequests({get:async()=>inventory(),post:async()=>inventory('workspace-b','FOREIGN'),publish:()=>{}});wrong.reset(scope());await wrong.refresh(false);assert.equal(wrong.snapshot().inventory,null);assert.ok(wrong.snapshot().error);assert.doesNotMatch(wrong.snapshot().error,/FOREIGN|workspace-b/);assert.equal(wrong.snapshot().refreshing,false);wrong.dispose();
});
