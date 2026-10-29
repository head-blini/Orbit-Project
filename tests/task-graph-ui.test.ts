import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import type {TaskGraphState} from '../shared/task-graph.ts';

async function load(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/task-graph-panel.tsx');}finally{hooks.deregister();}
}
const stale:TaskGraphState={stale:true,nodes:[{taskId:'a',state:'stale',reasonCodes:['TASK_GRAPH_BASELINE_CHANGED']},{taskId:'b',state:'stale',reasonCodes:['TASK_GRAPH_BASELINE_CHANGED']}]};
const mixed:TaskGraphState={stale:false,nodes:[{taskId:'a',state:'ready'},{taskId:'b',state:'waiting',predecessors:['a','c']},{taskId:'c',state:'blocked',reasonCodes:['TASK_RUN_FAILED']}]};
const queue={enabled:true,reason:null,items:[{id:'item-12345678',status:'blocked',reason:'INTEGRATION_RESTART_RECOVERY_REQUIRED'}],refusals:[{reservationId:'res-12345678',reason:'INTEGRATION_TARGET_PROTECTED',status:'refused',released:true}]} as any;
const graph={revision:3,contentHash:'f'.repeat(64)};

test('stale graph shows every node stale and no done',async()=>{
  const {summarizeGraphState}=await load();const s=summarizeGraphState(stale);
  assert.equal(s.stale,true);assert.deepEqual(s.counts,{ready:0,waiting:0,blocked:0,stale:2,done:0});assert.equal(s.mainReason,'TASK_GRAPH_BASELINE_CHANGED');
});
test('blocked reasons surface, waiting lists predecessors, done is not invented',async()=>{
  const {summarizeGraphState,nodeDetail}=await load();const s=summarizeGraphState(mixed);
  assert.deepEqual(s.counts,{ready:1,waiting:1,blocked:1,stale:0,done:0});assert.equal(s.mainReason,'TASK_RUN_FAILED');
  assert.equal(nodeDetail(mixed.nodes[1]),'선행 작업: a, c');assert.equal(nodeDetail(mixed.nodes[2]),'사유 코드: TASK_RUN_FAILED');
  assert.equal(summarizeGraphState({stale:false,nodes:[]}).mainReason,null);
});
test('queue reasons and refusals are shown',async()=>{
  const {queueRowLabel,refusalLabel}=await load();
  assert.equal(queueRowLabel(queue.items[0]),'막힘 · 사유 INTEGRATION_RESTART_RECOVERY_REQUIRED');
  assert.equal(queueRowLabel({id:'x',status:'queued',reason:null}),'대기열');
  assert.equal(refusalLabel(queue.refusals[0]),'거부됨 · 사유 INTEGRATION_TARGET_PROTECTED · 예약 해제됨');
});
test('markup is read-only (no buttons) and mode-dependent',async()=>{
  const {TaskGraphView}=await load();
  const html=(mode:string,state=mixed)=>renderToStaticMarkup(createElement(TaskGraphView,{graph,state,queue,mode} as any));
  for(const mode of ['simple','advanced'])for(const state of [mixed,stale]){const h=html(mode,state);assert.ok(!/<button|<form|<input/.test(h));}
  const simple=html('simple'),adv=html('advanced');
  assert.ok(simple.includes('주요 막힘 사유: TASK_RUN_FAILED')&&!simple.includes('<table'));
  assert.ok(adv.includes('선행 작업: a, c')&&adv.includes('해시 ffffffffffff'));
  assert.ok(simple.includes('INTEGRATION_TARGET_PROTECTED'));
  assert.ok(html('simple',stale).includes('오래된 그래프'));
});
