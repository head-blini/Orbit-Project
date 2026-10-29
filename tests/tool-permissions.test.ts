import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {ToolPermissionStore} from '../server/tool-permissions.ts';
import {itemDigest} from '../server/tool-capability-ledger.ts';
import {AppError} from '../server/errors.ts';
import type {ToolItemMeta} from '../shared/tool-capabilities.ts';

const hex=(s:string)=>createHash('sha256').update(s).digest('hex');
const ITEM=hex('mcp:fixture');
const meta=(over:Partial<ToolItemMeta>={}):ToolItemMeta=>({kind:'mcp',id:ITEM,scope:'user',handlerType:null,nativeTrust:'trusted',pluginOwned:false,runtimeVersion:'1',adapterRevision:'a1',...over});
const key=(over:Record<string,unknown>={})=>({runtimeId:'codex',kind:'mcp',itemId:ITEM,...over});
const input=(over:Record<string,unknown>={})=>({requestId:'r1',projectId:'p1',taskId:'t1',key:key(),itemDigest:itemDigest(meta()),confirmed:true,...over});
const bind=(over:Record<string,unknown>={})=>({projectId:'p1',taskId:'t1',key:key(),itemDigest:itemDigest(meta()),...over});
const error=(code:string,status=409)=>(e:unknown)=>e instanceof AppError&&e.message===code&&e.status===status;
const fixture=()=>{const store=new Store(':memory:');return {store,tools:new ToolPermissionStore(store)};};

test('exact fields only, confirmation required',()=>{
  const {store,tools}=fixture();try{
    assert.throws(()=>tools.grant({...input(),extra:1}),error('INVALID_FIELDS',400));
    const {confirmed:_,...missing}=input();assert.throws(()=>tools.grant(missing),error('INVALID_FIELDS',400));
    assert.throws(()=>tools.grant(input({key:{...key(),label:'x'}})),error('INVALID_FIELDS',400));
    assert.throws(()=>tools.grant(input({confirmed:'true'})),error('TOOL_GRANT_CONFIRMATION_REQUIRED',400));
    const getter=input();Object.defineProperty(getter,'taskId',{get:()=>'t1',enumerable:true});
    assert.throws(()=>tools.grant(getter),error('INVALID_FIELDS',400));
    assert.equal(store.lastSeq(),0);
  }finally{store.close();}
});

test('free text, path, command, URL and secret-like input rejected',()=>{
  const {store,tools}=fixture();try{
    for(const itemId of ['my server','/usr/local/bin/mcp','npx -y @scope/server','https://example.com/mcp','ITEM',ITEM.toUpperCase()])
      assert.throws(()=>tools.grant(input({key:key({itemId})})),error('INVALID_FIELDS',400));
    assert.throws(()=>tools.grant(input({itemDigest:'../etc/passwd'})),error('INVALID_FIELDS',400));
    assert.throws(()=>tools.grant(input({projectId:'p 1; rm -rf /'})),error('INVALID_FIELDS',400));
    assert.throws(()=>tools.grant(input({requestId:'sk-abcdefghijklmnopqrstuvwxyz0123456789'})),error('TOOL_PERMISSION_CREDENTIAL_INPUT',400));
    assert.throws(()=>tools.grant(input({key:key({itemId:'sk-abcdefghijklmnopqrstuvwxyz0123456789'})})),error('TOOL_PERMISSION_CREDENTIAL_INPUT',400));
    assert.equal(store.lastSeq(),0);
  }finally{store.close();}
});

test('only Codex MCP is grantable',()=>{
  const {store,tools}=fixture();try{
    for(const kind of ['skill','plugin','hook','subagent','slash_command'])assert.throws(()=>tools.grant(input({key:key({kind})})),error('TOOL_NOT_GRANTABLE',403));
    assert.throws(()=>tools.grant(input({key:key({runtimeId:'claude-code'})})),error('TOOL_NOT_GRANTABLE',403));
    assert.throws(()=>tools.grant(input({key:key({kind:'tool'})})),error('INVALID_FIELDS',400));
    assert.throws(()=>tools.grant(input({key:key({runtimeId:'gemini'})})),error('INVALID_FIELDS',400));
    assert.equal(tools.validFor(key({kind:'skill'}) as never,itemDigest(meta()),'p1','t1'),null);
  }finally{store.close();}
});

test('requestId idempotent; different input conflicts; audit carries ids and codes only',()=>{
  const {store,tools}=fixture();try{
    const g=tools.grant(input());assert.equal(g.state,'active');assert.match(g.grantId,/^tg_/);
    assert.deepEqual(tools.grant(input()),g);
    assert.throws(()=>tools.grant(input({taskId:'t2'})),error('TOOL_GRANT_REQUEST_CONFLICT'));
    assert.throws(()=>tools.grant(input({itemDigest:hex('other')})),error('TOOL_GRANT_REQUEST_CONFLICT'));
    assert.deepEqual(store.eventsAfter(0).map(e=>[e.kind,e.data]),[['tool.grant.created',{grantId:g.grantId,projectId:'p1',taskId:'t1',code:'TOOL_GRANT_CREATED'}]]);
  }finally{store.close();}
});

test('validFor binds task and metadata digest; metadata change voids',()=>{
  const {store,tools}=fixture();try{
    const g=tools.grant(input()),d=itemDigest(meta());
    assert.deepEqual(tools.validFor(key() as never,d,'p1','t1'),{grantId:g.grantId,key:key(),itemDigest:d});
    assert.equal(tools.validFor(key() as never,d,'p1','t2'),null);
    assert.equal(tools.validFor(key() as never,d,'p2','t1'),null);
    assert.equal(tools.validFor(key({itemId:hex('other')}) as never,d,'p1','t1'),null);
    const changed=itemDigest(meta({runtimeVersion:'2'}));
    assert.equal(tools.validFor(key() as never,changed,'p1','t1'),null);
    assert.throws(()=>tools.consume(g.grantId,bind({itemDigest:changed})),error('TOOL_GRANT_METADATA_CHANGED'));
    assert.throws(()=>tools.consume(g.grantId,bind({taskId:'t2'})),error('TOOL_GRANT_BINDING_MISMATCH'));
    assert.equal(tools.revoke(g.grantId).state,'revoked');
  }finally{store.close();}
});

test('consume is one-time; revoke idempotent; used/revoked never count',()=>{
  const {store,tools}=fixture();try{
    const d=itemDigest(meta()),a=tools.grant(input()),b=tools.grant(input({requestId:'r2'}));
    assert.equal(tools.consume(a.grantId,bind()).state,'used');
    assert.throws(()=>tools.consume(a.grantId,bind()),error('TOOL_GRANT_NOT_ACTIVE'));
    assert.equal(tools.validFor(key() as never,d,'p1','t1')!.grantId,b.grantId);
    assert.equal(tools.revoke(a.grantId).state,'used');
    const seq=store.lastSeq(),revoked=tools.revoke(b.grantId);assert.equal(revoked.state,'revoked');
    assert.deepEqual(tools.revoke(b.grantId),revoked);assert.equal(store.lastSeq(),seq+1);
    assert.equal(tools.validFor(key() as never,d,'p1','t1'),null);
    assert.throws(()=>tools.consume(b.grantId,bind()),error('TOOL_GRANT_NOT_ACTIVE'));
    assert.throws(()=>tools.revoke('missing'),error('TOOL_GRANT_NOT_FOUND',404));
    assert.throws(()=>tools.revoke('../x'),error('INVALID_FIELDS',400));
    assert.deepEqual(store.eventsAfter(0).map(e=>e.data.code),['TOOL_GRANT_CREATED','TOOL_GRANT_CREATED','TOOL_GRANT_USED','TOOL_GRANT_REVOKED']);
  }finally{store.close();}
});

test('grants persist across Store restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-tool-permissions-')),path=join(dir,'orbit.db');
  try{
    let store=new Store(path),tools=new ToolPermissionStore(store);
    const a=tools.grant(input()),b=tools.grant(input({requestId:'r2'}));tools.consume(b.grantId,bind());
    store.close();store=new Store(path);tools=new ToolPermissionStore(store);
    try{
      assert.deepEqual(tools.grant(input()),a);
      assert.equal(tools.validFor(key() as never,itemDigest(meta()),'p1','t1')!.grantId,a.grantId);
      assert.throws(()=>tools.consume(b.grantId,bind()),error('TOOL_GRANT_NOT_ACTIVE'));
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
