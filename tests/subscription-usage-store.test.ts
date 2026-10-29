import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {SubscriptionUsageStore} from '../server/subscription-usage.ts';
import {normalizeClaudeSubscriptionUsage} from '../server/usage.ts';
import {Controller} from '../server/controller.ts';
import {claudeFixture,tick} from './claude-task-fixture.ts';

const at='2026-10-29T00:00:00.000Z';
const observation=(connectionRef='connection-1')=>normalizeClaudeSubscriptionUsage({status:'allowed',windows:[{id:'five_hour',utilization:0.25,status:'allowed',resetsAt:'2026-10-29T01:00:00.000Z'}]},
  {providerId:'claude-code',runtimeId:'claude-code',connectionRef,evidence:'mock',observedAt:at,lastAttemptAt:at,now:at,connected:true});

test('restart restores disconnected observations without provider calls or account rebinding',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-subscription-')),db=join(root,'store.db');let store=new Store(db),calls=0;
  new SubscriptionUsageStore(store).record(observation());store.close();store=new Store(db);
  const controller=new Controller(store,root,()=>{calls++;throw Error('FORBIDDEN');});
  try{
    const [restored]=controller.subscriptionUsage.snapshot(at);
    assert.equal(restored.connected,false);assert.equal(restored.observation.freshness,'stale');assert.equal(restored.observation.observedAt,at);
    assert.equal(restored.observation.connectionRef,'connection-1');assert.equal(restored.observation.accountRef,null);
    controller.subscriptionUsage.record(observation('connection-2'));
    assert.equal(controller.subscriptionUsage.snapshot(at).length,2);
    assert.equal(controller.subscriptionUsage.snapshot(at)[0].connected,false);assert.equal(calls,0);
  }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('sanitized envelopes exclude secrets and raw provider extensions',()=>{
  const store=new Store(':memory:'),usage=new SubscriptionUsageStore(store),secret='sk-fixture-secret-0123456789';
  try{
    const value=observation();Object.assign(value,{raw:{token:secret}});Object.assign(value.buckets![0].primary!,{token:secret});
    value.accountRef=secret;value.identityStatus='observed';value.source.evidenceRefs=[secret,'event:1'];
    value.buckets!.push({...value.buckets![0],id:secret});usage.record(value);
    const serialized=JSON.stringify(store.eventsAfter(0));assert.ok(!serialized.includes(secret));assert.ok(!serialized.includes('"raw"'));
    const [entry]=usage.snapshot(at);assert.equal(entry.observation.accountRef,null);assert.equal(entry.observation.buckets?.length,1);
    entry.observation.buckets!.length=0;assert.equal(usage.snapshot(at)[0].observation.buckets?.length,1);
  }finally{store.close();}
});

test('first failed attempt records no quota or observation time',()=>{
  const store=new Store(':memory:'),usage=new SubscriptionUsageStore(store);
  try{usage.attempt('codex','connection-1',at);const [entry]=usage.snapshot(at);
    assert.equal(entry.observation.lastAttemptAt,at);assert.equal(entry.observation.observedAt,null);assert.equal(entry.observation.buckets,null);
  }finally{store.close();}
});

test('approved Claude quota events retain local event time and invoke no extra runner',async()=>{
  const f=claudeFixture();try{
    assert.equal(f.controller.subscriptionUsage.snapshot().length,0);assert.equal(f.runners.length,0);
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    f.runners[0].emit({kind:'quota',status:'allowed',windows:[{id:'five_hour',utilization:0.125,resetsAt:null,status:'allowed'}]});
    const event=f.store.eventsAfter(0).find(event=>event.kind==='claude.quota')!;
    const [entry]=f.controller.subscriptionUsage.snapshot();
    assert.equal(entry.observation.observedAt,event.at);assert.equal(entry.observation.lastAttemptAt,event.at);
    assert.equal(entry.observation.connectionRef,run.id);assert.equal(entry.observation.source.evidence,'mock');
    assert.deepEqual(entry.observation.source.evidenceRefs,['event:'+event.seq]);assert.equal(entry.observation.buckets?.[0].primary?.remainingPercent,87.5);
    assert.equal(entry.observation.accountRef,null);assert.equal(f.runners.length,1);assert.equal(f.launches.length,1);
    f.runners[0].finish();await tick();
  }finally{await f.close();}
});

test('latest values and failed attempts persist independently per runtime and connection',()=>{
  const store=new Store(':memory:'),usage=new SubscriptionUsageStore(store);
  try{
    usage.record(observation());usage.record({...observation(),runtimeId:'other-runtime'});usage.record(observation('connection-2'));
    const changed=observation();changed.buckets![0].primary!.remainingPercent=50;usage.record(changed);
    const attempted='2026-10-29T00:00:30.000Z';usage.attempt('claude-code','connection-1',attempted);
    const entries=new SubscriptionUsageStore(store).snapshot(attempted);assert.equal(entries.length,3);
    assert.deepEqual(entries.map(entry=>entry.observation.buckets?.[0].primary?.remainingPercent),[50,75,75]);
    assert.deepEqual(entries.map(entry=>entry.observation.lastAttemptAt),[attempted,at,at]);
    assert.ok(entries.every(entry=>!entry.connected&&entry.observation.freshness==='stale'));
  }finally{store.close();}
});

test('reads recompute freshness without appending events or refreshing values',()=>{
  const store=new Store(':memory:'),usage=new SubscriptionUsageStore(store);
  try{
    usage.record(observation());const seq=store.lastSeq();
    assert.equal(usage.snapshot(at)[0].observation.freshness,'fresh');
    assert.equal(usage.snapshot('2026-10-29T00:01:00.000Z')[0].observation.freshness,'stale');
    assert.equal(store.lastSeq(),seq);
    assert.equal(usage.snapshot()[0].observation.observedAt,at);
  }finally{store.close();}
});
