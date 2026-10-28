import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {NativeReviewInput,NativeReviewResult} from '../server/codex-review.ts';
import type {RpcPort} from '../server/rpc.ts';
const module=await import('../server/codex-review.ts').catch(()=>null);
function runCodexReview(input:NativeReviewInput,factory:(path:string,write:boolean)=>RpcPort):Promise<NativeReviewResult>{assert.ok(module,'native review implementation must exist');return module.runCodexReview(input,factory);}

const threadId='review-thread',turnId='review-turn';
class FakeRpc extends EventEmitter {
  calls:{method:string;params:any}[]=[];closed=false;onReview?:()=>void;patch?:(method:string,value:any)=>any;closeMode:'normal'|'reject'|'no-event'='normal';
  emitReview(text='Only the frozen diff was reviewed.'){this.emit('notification',{method:'item/completed',params:{threadId,turnId,item:{id:'review-result',type:'exitedReviewMode',review:text}}});this.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[],error:null}}});}
  async initialize(){this.calls.push({method:'initialize',params:null});}
  async request(method:string,params:any):Promise<any>{
    this.calls.push({method,params});let result:any={};
    if(method==='account/read')result={account:{type:'chatgpt',email:'PRIVATE_ACCOUNT'}};
    if(method==='config/read')result={config:{mcp_servers:{fixture:{command:'PRIVATE_COMMAND',env:{SECRET:'PRIVATE_CONFIG'}}}}};
    if(method==='thread/start')result={thread:{id:threadId,status:{type:'idle'},turns:[]},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='mcpServerStatus/list')result={data:[{name:'fixture',runtimeStatus:'disabled',tools:{}}],nextCursor:null};
    if(method==='review/start'){if(this.onReview)this.onReview();else setTimeout(()=>this.emitReview(),0);result={reviewThreadId:threadId,turn:{id:turnId,status:'inProgress',items:[]}};}
    return this.patch?this.patch(method,result):result;
  }
  async close(){if(this.closeMode==='reject')throw new Error('PRIVATE_CLOSE_SECRET');if(this.closeMode==='normal'){this.closed=true;this.emit('closed');}}
}
function setup(){const rpc=new FakeRpc(),flags:boolean[]=[],input={workspacePath:process.cwd(),instructions:'Review only this supplied synthetic diff.',timeoutMs:1000};return {rpc,flags,input,factory:(_path:string,write:boolean)=>{flags.push(write);return rpc;}};}

test('thread configuration is not evidence of the actual review model',async()=>{
  const f=setup();f.rpc.patch=(method,value)=>method==='thread/start'?{...value,model:'configured-model',modelProvider:'openai'}:value;
  const result=await runCodexReview(f.input,f.factory);
  assert.equal(result.execution,'completed');
  assert.deepEqual(result.identity,{providerId:'openai',modelId:'unknown',sessionId:threadId,executionId:turnId,modelEvidence:'unknown'});
});

test('fresh readonly protocol orders policy/MCP validation before exactly one inline custom review',async()=>{
  const f=setup(),started:any[]=[];const result=await runCodexReview({...f.input,onStarted:ids=>started.push(ids)},f.factory);
  assert.equal(result.execution,'completed');assert.equal(result.processStopped,true);assert.equal(result.response,'Only the frozen diff was reviewed.');assert.deepEqual(f.flags,[false]);assert.deepEqual(started,[{threadId,turnId}]);
  assert.deepEqual(f.rpc.calls.map(c=>c.method),['initialize','account/read','config/read','thread/start','mcpServerStatus/list','review/start']);
  const start=f.rpc.calls.find(c=>c.method==='thread/start')!.params;assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'untrusted');assert.equal(start.approvalsReviewer,'user');assert.deepEqual(start.config.mcp_servers,{fixture:{enabled:false}});assert.match(start.developerInstructions,/text-only/);
  assert.deepEqual(f.rpc.calls.find(c=>c.method==='account/read')!.params,{refreshToken:false});assert.deepEqual(f.rpc.calls.find(c=>c.method==='config/read')!.params,{includeLayers:false,cwd:f.input.workspacePath});
  assert.deepEqual(f.rpc.calls.find(c=>c.method==='mcpServerStatus/list')!.params,{threadId,detail:'toolsAndAuthOnly',limit:100});
  assert.deepEqual(f.rpc.calls.find(c=>c.method==='review/start')!.params,{threadId,delivery:'inline',target:{type:'custom',instructions:f.input.instructions}});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('authentication, policy, active thread and MCP errors fail before starting a review',async()=>{
  const cases:[string,(value:any)=>any][]=[['account/read',()=>({account:{type:'apiKey'}})],['config/read',()=>({config:{mcp_servers:[]}})],['thread/start',v=>({...v,sandbox:{type:'readOnly',networkAccess:true}})],['thread/start',v=>({...v,approvalPolicy:'never'})],['thread/start',v=>({...v,thread:{...v.thread,status:{type:'active'}}})],['mcpServerStatus/list',()=>({data:[{name:'fixture',runtimeStatus:'ready',tools:{}}],nextCursor:null})],['mcpServerStatus/list',()=>({data:[{name:'unknown',runtimeStatus:'disabled',tools:{}}],nextCursor:null})],['mcpServerStatus/list',()=>({data:[],nextCursor:'more'})]];
  for(const [method,patch] of cases){const f=setup();f.rpc.patch=(m,v)=>m===method?patch(v):v;const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.processStopped,true);assert.equal(f.rpc.calls.some(c=>c.method==='review/start'),false);assert.equal(result.response,'');}
});

test('early notifications are bounded/replayed only for the acknowledged thread and turn',async()=>{
  const f=setup();f.rpc.onReview=()=>{f.rpc.emit('notification',{method:'item/completed',params:{threadId:'foreign',turnId,item:{id:'x',type:'exitedReviewMode',review:'FOREIGN_SECRET'}}});f.rpc.emit('notification',{method:'item/started',params:{threadId,turnId:'foreign-turn',item:{id:'x',type:'commandExecution'}}});f.rpc.emitReview('early final review');};
  const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'completed');assert.equal(result.response,'early final review');assert.doesNotMatch(JSON.stringify(result),/FOREIGN_SECRET/);
});

test('wrong review thread or missing final review cannot become completion',async()=>{
  for(const mode of ['thread','missing','failed','malformed'] as const){const f=setup();
    if(mode==='thread')f.rpc.patch=(method,v)=>method==='review/start'?{...v,reviewThreadId:'other-thread'}:v;
    f.rpc.onReview=()=>{if(mode==='malformed')f.rpc.emit('notification',{method:'item/completed',params:{threadId,turnId,item:{id:'result',type:'exitedReviewMode',review:7}}});f.rpc.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status:mode==='failed'?'failed':'completed',items:[],error:mode==='failed'?{message:'RAW_SECRET_ERROR'}:null}}});};
    const result=await runCodexReview(f.input,f.factory);assert.notEqual(result.execution,'completed');assert.equal(result.response,'');assert.doesNotMatch(JSON.stringify(result),/RAW_SECRET/);
  }
});

test('only exitedReviewMode text is retained, credentials are masked and output is capped',async()=>{
  const f=setup();f.rpc.onReview=()=>{f.rpc.emit('notification',{method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'a',delta:'RAW_AGENT_SECRET'}});f.rpc.emit('notification',{method:'item/reasoning/textDelta',params:{threadId,turnId,text:'RAW_REASONING_SECRET'}});f.rpc.emitReview('api_key=synthetic-secret\n'+'public '.repeat(8000));};
  const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'completed');assert.ok(result.response.length<=64000);assert.match(result.response,/REDACTED/);assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|RAW_AGENT|RAW_REASONING/);
});

test('approval requests and command/file/tool items fail closed then interrupt and close the owned RPC',async()=>{
  for(const kind of ['approval','commandExecution','fileChange','mcpToolCall','webSearch'] as const){const f=setup();f.rpc.onReview=()=>{setTimeout(()=>{if(kind==='approval')f.rpc.emit('approval',{method:'item/commandExecution/requestApproval',threadId,turnId});else f.rpc.emit('notification',{method:'item/started',params:{threadId,turnId,item:{id:'danger',type:kind,secret:'RAW_SECRET'}}});},0);};
    const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.processStopped,true);assert.equal(result.response,'');assert.ok(f.rpc.calls.some(c=>c.method==='turn/interrupt'));assert.doesNotMatch(JSON.stringify(result),/RAW_SECRET/);
  }
});

test('abort and timeout interrupt when known, await close, and never report completion',async()=>{
  const f=setup(),abort=new AbortController();f.rpc.onReview=()=>setTimeout(()=>abort.abort(),10);const result=await runCodexReview({...f.input,signal:abort.signal},f.factory);assert.equal(result.execution,'interrupted');assert.equal(result.processStopped,true);assert.ok(f.rpc.calls.some(c=>c.method==='turn/interrupt'));
  const g=setup();g.rpc.onReview=()=>{};const timed=await runCodexReview(g.input,g.factory);assert.equal(timed.execution,'timed_out');assert.equal(timed.processStopped,true);assert.ok(g.rpc.calls.some(c=>c.method==='turn/interrupt'));
});

test('close rejection or missing close proof stays lost with no raw close diagnostics',async()=>{
  for(const mode of ['reject','no-event'] as const){const f=setup();f.rpc.closeMode=mode;const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'lost');assert.equal(result.processStopped,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CLOSE_SECRET/);}
});

test('a terminal Turn payload may carry the final review, but observed tools still invalidate it',async()=>{
  for(const tool of [false,true]){const f=setup();f.rpc.onReview=()=>f.rpc.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{id:'review-final',type:'exitedReviewMode',review:'terminal final'},...(tool?[{id:'tool',type:'dynamicToolCall'}]:[])]}}});
    const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,tool?'failed':'completed');assert.equal(result.response,tool?'':'terminal final');}
});

test('invalid inputs and pre-aborted execution do not create an RPC; RPC errors are fixed',async()=>{
  const f=setup();for(const patch of [{timeoutMs:999},{workspacePath:'relative'},{instructions:''},{instructions:'x'.repeat(64001)}]){const result=await runCodexReview({...f.input,...patch},f.factory);assert.equal(result.execution,'failed');}assert.deepEqual(f.flags,[]);
  const stopped=await runCodexReview({...f.input,signal:AbortSignal.abort()},f.factory);assert.equal(stopped.execution,'interrupted');assert.deepEqual(f.flags,[]);
  const g=setup();g.rpc.patch=()=>{throw new Error('RAW_RPC_SECRET');};const error=await runCodexReview(g.input,g.factory);assert.equal(error.execution,'failed');assert.doesNotMatch(JSON.stringify(error),/RAW_RPC_SECRET/);
});

test('null MCP configuration cannot masquerade as an empty verified inventory',async()=>{
  const f=setup();f.rpc.patch=(method,value)=>method==='config/read'?{config:{mcp_servers:null}}:method==='mcpServerStatus/list'?{data:[],nextCursor:null}:value;
  const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(f.rpc.calls.some(c=>c.method==='review/start'),false);
});

test('an abort while awaiting process closure remains interrupted rather than publishing success',async()=>{
  const f=setup(),abort=new AbortController();f.rpc.close=async()=>{abort.abort();await new Promise(r=>setTimeout(r,5));f.rpc.emit('closed');};
  const result=await runCodexReview({...f.input,signal:abort.signal},f.factory);assert.equal(result.execution,'interrupted');assert.equal(result.processStopped,true);assert.equal(result.response,'');
});

test('early event limits and a hanging close fail boundedly without retaining raw payloads',async()=>{
  const f=setup();f.rpc.onReview=()=>{for(let index=0;index<129;index++)f.rpc.emit('notification',{method:'item/completed',params:{threadId,turnId:'foreign-'+index,item:{id:'item-'+index,type:'exitedReviewMode',review:'public',private:'RAW_SECRET'}}});};
  const limited=await runCodexReview(f.input,f.factory);assert.equal(limited.execution,'failed');assert.equal(limited.issue,'REVIEW_NOTIFICATION_LIMIT');assert.doesNotMatch(JSON.stringify(limited),/RAW_SECRET/);
  const g=setup();g.rpc.close=()=>new Promise(()=>{});const started=Date.now(),lost=await runCodexReview(g.input,g.factory);assert.equal(lost.execution,'lost');assert.equal(lost.processStopped,false);assert.ok(Date.now()-started<4000);
});

test('persistence callback failure interrupts known IDs and never exposes its error or a result',async()=>{
  const f=setup();const result=await runCodexReview({...f.input,onStarted:()=>{throw new Error('PRIVATE_CALLBACK');}},f.factory);assert.equal(result.execution,'failed');assert.equal(result.response,'');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CALLBACK/);assert.ok(f.rpc.calls.some(c=>c.method==='turn/interrupt'));
});

test('oversized raw final reviews fail rather than completing with a silently truncated fragment',async()=>{
  for(const text of ['x'.repeat(64001),'한'.repeat(90000)]){const f=setup();f.rpc.onReview=()=>setTimeout(()=>f.rpc.emitReview(text),0);
    const result=await runCodexReview(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.issue,'REVIEW_OUTPUT_LIMIT');assert.equal(result.response,'');assert.equal(result.processStopped,true);assert.ok(f.rpc.calls.some(c=>c.method==='turn/interrupt'));
  }
  const exact=setup();exact.rpc.onReview=()=>exact.rpc.emitReview('한'.repeat(64000));const result=await runCodexReview(exact.input,exact.factory);assert.equal(result.execution,'completed');assert.equal(result.response.length,64000);
});
