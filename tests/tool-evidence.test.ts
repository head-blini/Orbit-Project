import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {AppEvent,Run} from '../shared/types.ts';
import {readToolInvocations,type ToolGrantBinding} from '../server/tool-evidence.ts';

const run:Run={id:'r1',runtime:'codex',projectId:'p1',taskId:'t1',turnId:'turn1',requestId:'request1',prompt:'',response:'',execution:'completed',verification:'not_run',createdAt:'',updatedAt:''};
const binding:ToolGrantBinding={projectId:'p1',taskId:'t1',runId:'r1',threadId:'thread1',grantId:'g1',itemDigest:'a'.repeat(64),approvedDigest:'b'.repeat(64),serverName:'fixture',toolName:'echo',key:{runtimeId:'codex',kind:'mcp',itemId:createHash('sha256').update(JSON.stringify(['mcp','fixture'])).digest('hex')}};
const event=(kind:string,data:Record<string,unknown>,seq=1):AppEvent=>({seq,kind,data,runId:run.id,at:'2026-10-29T00:00:00Z'});
const origin=(source='native',providerInterface='codex.app_server')=>event('run.runtime_source',{source,interface:providerInterface});
// Synthetic journal fixture, not a captured Codex notification or live integration proof.
const completed=(item:Record<string,unknown>={},bound:unknown=binding)=>event('item/completed',{
  threadId:'thread1',turnId:'turn1',binding:structuredClone(bound),
  item:{id:'call1',type:'mcpToolCall',status:'completed',server:'fixture',tool:'echo',...item},
},2);
const read=(events:AppEvent[],r=run,b=binding)=>readToolInvocations(events,r,b);
const source=(events:AppEvent[],r=run,b=binding)=>read(events,r,b)[0]?.evidenceSource;

test('exact completed fixture, observed native run and approved binding yield native',()=>{
  assert.deepEqual(read([origin(),completed()]),[{key:binding.key,evidenceSource:'native',grantId:'g1',itemDigest:binding.itemDigest}]);
});
test('forged server, tool or discovery item identity never yield native',()=>{
  for(const item of [{server:'other'},{tool:'other'},{server:'Fixture'},{tool:' echo'}])assert.equal(source([origin(),completed(item)]),'unknown');
  const forged={...binding,key:{...binding.key,itemId:'forged'}};
  assert.equal(source([origin(),completed({},forged)],run,forged),'unknown');
});
test('mock origin or outcome stays mock',()=>{
  assert.equal(source([origin('mock'),completed()]),'mock');
  assert.equal(source([origin(),completed(),event('run.runtime_outcome',{source:'mock'},3)]),'mock');
});
test('unknown provider or unobserved execution stays unknown',()=>{
  for(const events of [[completed()],[origin('unknown'),completed()],[origin('native','unknown'),completed()]])assert.equal(source(events),'unknown');
  assert.equal(source([origin(),completed()],{...run,turnId:null}),'unknown');
});
test('every approval binding field must match; missing binding is unknown',()=>{
  for(const field of ['projectId','taskId','runId','threadId','grantId','itemDigest','approvedDigest','serverName','toolName'] as const){
    assert.equal(source([origin(),completed({},{...binding,[field]:'wrong'})]),'unknown',field);
    assert.equal(source([origin(),completed()],run,{...binding,[field]:'wrong'}),'unknown',field);
  }
  assert.equal(source([origin(),completed({},null)]),'unknown');
  for(const field of ['projectId','taskId'] as const)assert.equal(source([origin(),completed()],{...run,[field]:'wrong'}),'unknown');
});
test('unknown or incomplete event shapes never yield native',()=>{
  for(const data of [{},{item:null},{item:{type:'mcpToolCall'}},{params:completed().data}, {...completed().data,turnId:'foreign'}]){
    assert.equal(source([origin(),event('item/completed',data,2)]),'unknown');
  }
  for(const item of [{status:'failed'},{status:'running'},{status:undefined},{id:''},{type:'futureToolCall'}])assert.equal(source([origin(),completed(item)]),'unknown');
});
test('duplicates count once; conflicting duplicate cannot promote evidence in either order',()=>{
  const one=completed(),duplicate={...completed(),seq:3},forged={...completed({tool:'forged'}),seq:4};
  assert.equal(read([origin(),one,duplicate]).length,1);
  for(const events of [[origin(),one,forged],[forged,one,origin()]]){
    assert.equal(read(events).length,1);assert.equal(source(events),'unknown');
  }
  assert.equal(read([origin(),one,completed({id:'call2'})]).length,2);
});
test('foreign run, ordinary messages and no call events do not count as invocations',()=>{
  assert.deepEqual(read([origin()]),[]);
  assert.deepEqual(read([origin(),{...completed(),runId:'foreign'}]),[]);
  assert.deepEqual(read([origin(),event('message.updated',{response:'tool completed'}),completed({type:'agentMessage'})]),[]);
  assert.equal(source([{...origin(),runId:'foreign'},completed()]),'unknown');
});
test('only Codex MCP can yield native; no input mutation or output aliasing',()=>{
  for(const key of [{...binding.key,runtimeId:'claude-code' as const},{...binding.key,kind:'skill' as const}]){
    const b={...binding,key};assert.equal(source([origin(),completed({},b)],run,b),'unknown');
  }
  assert.equal(source([origin(),completed()],{...run,runtime:'claude-code'}),'unknown');
  const events=[origin(),completed()],before=structuredClone({events,run,binding});
  const records=read(events);records[0].key.itemId='changed';
  assert.deepEqual({events,run,binding},before);
});
test('conflicting binding duplicates lose approval attribution in either order',()=>{
  const good=completed(),bad={...completed({},{...binding,approvedDigest:'wrong'}),seq:3};
  const forward=read([origin(),good,bad]),reverse=read([origin(),bad,good]);
  assert.deepEqual(forward,reverse);
  assert.deepEqual(forward,[{key:binding.key,evidenceSource:'unknown',grantId:null,itemDigest:null}]);
});
test('missing identity, empty approval, wrong thread and alternate tool event remain unknown',()=>{
  for(const b of [{...binding,approvedDigest:''},{...binding,grantId:''},{...binding,key:{...binding.key,itemId:''}}]){
    assert.equal(source([origin(),completed({},b)],run,b),'unknown');
  }
  assert.equal(source([origin(),event('item/completed',{...completed().data,threadId:'foreign'},2)]),'unknown');
  assert.equal(source([origin(),{...completed(),kind:'item/mcpToolCall/completed'}]),'unknown');
  const unknown=event('item/completed',{},2);
  assert.equal(read([origin(),unknown,structuredClone(unknown)]).length,1);
});
