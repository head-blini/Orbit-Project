import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { Controller } from '../server/controller.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';

class Fake extends EventEmitter {
  usageCalls=0;hold:Promise<unknown>|null=null;
  async initialize(){}async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'fixture-usage-thread',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user'};
    if(method==='mcpServerStatus/list')return {data:[]};
    if(method==='account/rateLimits/read'){this.usageCalls++;if(this.hold)return this.hold;return {rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1792940000},secondary:null}};}
    if(method==='account/usage/read'){this.usageCalls++;return {summary:{lifetimeTokens:123},dailyUsageBuckets:null};}
    throw new Error('UNEXPECTED_METHOD');
  }
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'orbit-usage-controller-')),store=new Store(':memory:'),rpc=new Fake();
  const controller=new Controller(store,createWorkspace(root),()=>rpc);
  return {store,rpc,controller,close:async()=>{await controller.close();store.close();}};
}

test('usage reads are explicit, share pending work and keep quota separate from unknown API cost',async()=>{
  const f=fixture();try{
    assert.equal(f.controller.usageSnapshot().source,'not_queried');assert.equal(f.rpc.usageCalls,0);
    assert.throws(()=>f.controller.refreshUsage(),/NOT_CONNECTED/);
    await f.controller.connect();assert.equal(f.rpc.usageCalls,0);
    const one=f.controller.refreshUsage(),two=f.controller.refreshUsage();assert.equal(one,two);
    const report=await one;assert.equal(f.rpc.usageCalls,2);assert.equal(report.buckets?.[0].primary?.remainingPercent,75);
    assert.equal(report.apiCostUsd,null);assert.equal(report.summary?.lifetimeTokens,123);
    report.buckets!.length=0;assert.equal(f.controller.usageSnapshot().buckets!.length,1);
    await f.controller.refreshUsage();assert.equal(f.rpc.usageCalls,2);
    await f.controller.close();assert.equal(f.controller.usageSnapshot().source,'not_queried');
  }finally{await f.close();}
});

test('a quota response from a closed connection cannot populate a later session snapshot',async()=>{
  const f=fixture();let finish!:(value:unknown)=>void;
  try{
    await f.controller.connect();f.rpc.hold=new Promise(resolve=>{finish=resolve;});
    const pending=f.controller.refreshUsage();await f.controller.close();
    finish({rateLimits:{limitId:'codex',primary:{usedPercent:99}}});
    assert.equal((await pending).source,'not_queried');
    assert.equal(f.controller.usageSnapshot().source,'not_queried');
  }finally{await f.close();}
});

test('HTTP cached usage is inert; refresh requires session Origin CSRF and empty body',async()=>{
  const f=fixture();const server=createHttpServer(f.controller,'.');
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    assert.equal((await fetch(origin+'/api/usage')).status,401);
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as any,cookie=session.headers.get('set-cookie')!.split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
    assert.equal((await fetch(origin+'/api/usage',{headers:{Cookie:cookie}})).status,200);assert.equal(f.rpc.usageCalls,0);
    const post=(body:object,patch:Record<string,string>={})=>fetch(origin+'/api/usage/refresh',{method:'POST',headers:{...headers,...patch},body:JSON.stringify(body)});
    assert.equal((await post({}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await post({consumeCredits:true})).status,400);
    assert.equal((await post({})).status,409);assert.equal(f.rpc.usageCalls,0);
    await f.controller.connect();assert.equal((await post({})).status,200);assert.equal(f.rpc.usageCalls,2);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('subscription observations drop old generations without clearing the new pending refresh',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-usage-generation-')),store=new Store(':memory:');
  const old=new Fake(),next=new Fake();let calls=0,finishOld!:(value:unknown)=>void,finishNext!:(value:unknown)=>void;
  const controller=new Controller(store,createWorkspace(root),()=>calls++===0?old:next);
  try{
    await controller.connect();old.hold=new Promise(resolve=>{finishOld=resolve;});const first=controller.refreshUsage();
    old.emit('closed');await controller.connect();next.hold=new Promise(resolve=>{finishNext=resolve;});
    const second=controller.refreshUsage();assert.notEqual(first,second);
    finishOld({rateLimits:{primary:{usedPercent:99}}});await first;
    assert.equal(controller.subscriptionUsage.snapshot().length,0);
    assert.equal(controller.refreshUsage(),second);
    finishNext({rateLimits:{primary:{usedPercent:25}}});await second;
    const [entry]=controller.subscriptionUsage.snapshot();assert.equal(entry.observation.buckets?.[0].primary?.remainingPercent,75);
    assert.equal(entry.observation.accountRef,null);assert.equal(entry.observation.identityStatus,'unknown');
    assert.equal(old.usageCalls,2);assert.equal(next.usageCalls,2);
  }finally{await controller.close();store.close();}
});

test('failed quota refresh changes only lastAttemptAt, including activity-only success',async t=>{
  const f=fixture();const start=new Date('2026-10-29T00:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:start});
  try{
    await f.controller.connect();await f.controller.refreshUsage();
    const before=f.controller.subscriptionUsage.snapshot()[0].observation;
    t.mock.timers.tick(61000);
    f.rpc.hold=Promise.reject(new Error('fixture failure'));
    await f.controller.refreshUsage();
    const after=f.controller.subscriptionUsage.snapshot()[0].observation;
    assert.equal(after.lastAttemptAt,'2026-10-29T00:01:01.000Z');assert.equal(after.freshness,'stale');
    assert.deepEqual({...after,lastAttemptAt:before.lastAttemptAt,freshness:before.freshness},before);
    assert.equal(f.rpc.usageCalls,4);
  }finally{await f.close();}
});

test('subscription persistence adds no RPCs and excludes raw account and quota secrets',async()=>{
  const f=fixture(),methods:string[]=[],secret='sk-fixture-private-0123456789',request=f.rpc.request.bind(f.rpc);
  f.rpc.request=async(method,params)=>{
    methods.push(method);const value=await request(method,params);
    if(method==='account/read')return {...value,account:{...value.account,email:'private@example.test',token:secret}};
    if(method==='account/rateLimits/read')return {...value,raw:{token:secret}};
    return value;
  };
  try{
    await f.controller.connect();methods.length=0;await f.controller.refreshUsage();
    assert.deepEqual(methods,['account/rateLimits/read','account/usage/read']);
    const events=JSON.stringify(f.store.eventsAfter(0));assert.ok(!events.includes(secret));assert.ok(!events.includes('private@example.test'));
    const [entry]=f.controller.subscriptionUsage.snapshot();assert.equal(entry.observation.accountRef,null);
    f.controller.subscriptionUsage.snapshot();await f.controller.refreshUsage();assert.equal(methods.length,2);
  }finally{await f.close();}
});
