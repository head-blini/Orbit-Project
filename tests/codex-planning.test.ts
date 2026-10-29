import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {join,sep} from 'node:path';
import type {RpcPort} from '../server/rpc.ts';
import {runCodexPlanning,type NativePlanningInput} from '../server/codex-planning.ts';

const threadId='planning-thread',turnId='planning-turn';
const proposalText=()=>JSON.stringify({schema_version:'1.0',title:'Search',goal:'Find items',requirements:[
  {id:'REQ-1',description:'Show matches',acceptance_criteria:['Matching items appear']}],constraints:['Keep the public API'],open_questions:[],decisions:[]});
const finalItem=(text=proposalText(),id='planning-final')=>({id,type:'agentMessage',phase:'final_answer',text});
class FakeRpc extends EventEmitter {
  calls:{method:string;params:any}[]=[];onTurn?:()=>void;patch?:(method:string,value:any)=>any;
  closeMode:'normal'|'reject'|'no-event'|'hang'='normal';
  item(item:unknown,completed=true,ids={threadId,turnId}){this.emit('notification',{method:completed?'item/completed':'item/started',params:{...ids,item}});}
  terminal(items:unknown[]=[],status='completed',id=turnId){this.emit('notification',{method:'turn/completed',params:{threadId,turn:{id,status,items,error:null}}});}
  complete(text=proposalText()){this.item(finalItem(text));this.terminal();}
  async initialize(){this.calls.push({method:'initialize',params:null});}
  async request(method:string,params:any):Promise<any>{
    this.calls.push({method,params});let result:any={};
    if(method==='account/read')result={account:{type:'chatgpt',email:'PRIVATE_ACCOUNT'}};
    if(method==='config/read')result={config:{mcp_servers:{fixture:{command:'PRIVATE_COMMAND',env:{SECRET:'PRIVATE_CONFIG'}}}}};
    if(method==='thread/start')result={cwd:params.cwd,modelProvider:'openai',thread:{id:threadId,cwd:params.cwd,ephemeral:true,modelProvider:'openai',status:{type:'idle'},turns:[]},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='mcpServerStatus/list')result={data:[{name:'fixture',runtimeStatus:'disabled',tools:{}}],nextCursor:null};
    if(method==='turn/start'){if(this.onTurn)this.onTurn();else setImmediate(()=>this.complete());result={turn:{id:turnId,status:'inProgress',items:[]}};}
    return this.patch?this.patch(method,result):result;
  }
  async close(){
    if(this.closeMode==='reject')throw new Error('PRIVATE_CLOSE_ERROR');
    if(this.closeMode==='hang')return new Promise(()=>{});
    if(this.closeMode==='normal')this.emit('closed');
  }
}
function setup(){
  const rpc=new FakeRpc(),flags:boolean[]=[],paths:string[]=[];
  const input:NativePlanningInput={workspacePath:process.cwd(),instructions:'Generate a plan only from this supplied synthetic request.',timeoutMs:1000};
  return {rpc,input,flags,paths,factory:(path:string,write:boolean)=>{paths.push(path);flags.push(write);return rpc;}};
}
function noPrivate(result:unknown){assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|RAW_SECRET|person@example|fixture-token/);}

test('fresh read-only handshake starts exactly one stable structured turn and returns only a validated proposal',async()=>{
  const f=setup(),started:unknown[]=[];const result=await runCodexPlanning({...f.input,onStarted:ids=>started.push(ids)},f.factory);
  assert.equal(result.execution,'completed');assert.equal(result.issue,null);assert.equal(result.processStopped,true);
  assert.equal(result.proposal?.title,'Search');assert.equal(result.proposal?.requirements[0].label,'REQ-1');
  assert.deepEqual(f.flags,[false]);assert.deepEqual(f.paths,[f.input.workspacePath]);assert.deepEqual(started,[{threadId,turnId}]);
  assert.deepEqual(f.rpc.calls.map(call=>call.method),['initialize','account/read','config/read','thread/start','mcpServerStatus/list','turn/start']);
  const thread=f.rpc.calls.find(call=>call.method==='thread/start')!.params;
  assert.equal(thread.sandbox,'read-only');assert.equal(thread.approvalPolicy,'untrusted');assert.equal(thread.approvalsReviewer,'user');assert.equal(thread.ephemeral,true);assert.equal(thread.modelProvider,'openai');
  assert.deepEqual(thread.config.mcp_servers,{fixture:{enabled:false}});assert.match(thread.developerInstructions,/no tools|not use.*tools/i);
  const turn=f.rpc.calls.find(call=>call.method==='turn/start')!.params;
  assert.equal(turn.threadId,threadId);assert.equal(turn.cwd,f.input.workspacePath);assert.deepEqual(turn.input,[{type:'text',text:f.input.instructions,text_elements:[]}]);
  assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});assert.equal(turn.approvalPolicy,'untrusted');assert.equal(turn.approvalsReviewer,'user');
  assert.equal(turn.outputSchema.type,'object');assert.equal(turn.outputSchema.additionalProperties,false);assert.ok(turn.outputSchema.properties.requirements);
  assert.equal(Object.hasOwn(turn.outputSchema.properties,'source'),false);assert.equal(Object.hasOwn(turn,'collaborationMode'),false);
  assert.equal(Object.hasOwn(result,'response'),false);noPrivate(result);
});

test('returned workspace, ephemeral session and pinned provider must attest the requested thread before any turn',async()=>{
  const patches:((value:any)=>any)[]=[
    value=>({...value,cwd:undefined}),value=>({...value,cwd:'relative'}),value=>({...value,cwd:join(process.cwd(),'PRIVATE_OTHER_WORKSPACE')}),
    value=>({...value,cwd:process.cwd()+'\0PRIVATE_PATH'}),value=>({...value,cwd:process.cwd()+'\nPRIVATE_PATH'}),
    value=>({...value,cwd:process.cwd()+sep+'PRIVATE_LINK'+sep+'..'}),
    value=>({...value,thread:{...value.thread,cwd:undefined}}),value=>({...value,thread:{...value.thread,cwd:'relative'}}),
    value=>({...value,thread:{...value.thread,cwd:join(process.cwd(),'PRIVATE_OTHER_WORKSPACE')}}),
    value=>({...value,thread:{...value.thread,ephemeral:undefined}}),value=>({...value,thread:{...value.thread,ephemeral:false}}),
    value=>({...value,modelProvider:undefined}),value=>({...value,modelProvider:'PRIVATE_OTHER_PROVIDER'}),
    value=>({...value,thread:{...value.thread,modelProvider:undefined}}),value=>({...value,thread:{...value.thread,modelProvider:'PRIVATE_OTHER_PROVIDER'}}),
  ];
  for(const patch of patches){const f=setup();f.rpc.patch=(method,value)=>method==='thread/start'?patch(value):value;
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.issue,'POLICY_MISMATCH');
    assert.equal(result.proposal,null);assert.equal(result.processStopped,true);assert.equal(f.rpc.calls.some(call=>call.method==='turn/start'),false);noPrivate(result);
  }
});

test('equivalent platform-native absolute cwd spellings preserve the same planning workspace',async()=>{
  const f=setup();f.rpc.patch=(method,value)=>method==='thread/start'?{...value,cwd:value.cwd+sep,thread:{...value.thread,cwd:process.platform==='win32'?value.cwd.replace(/\\/g,'/').toUpperCase():value.cwd+sep}}:value;
  const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'completed');assert.equal(result.issue,null);
});

test('authentication, policy, freshness and MCP checks fail before any planning turn',async()=>{
  const cases:[string,(value:any)=>any][]=[['account/read',()=>({account:{type:'apiKey'}})],
    ['config/read',()=>({config:{mcp_servers:null}})],['config/read',()=>({config:{mcp_servers:[]}})],
    ['config/read',()=>({config:{mcp_servers:{'invalid/name':{}}}})],
    ['thread/start',value=>({...value,sandbox:{type:'readOnly',networkAccess:true}})],
    ['thread/start',value=>({...value,approvalPolicy:'never'})],['thread/start',value=>({...value,approvalsReviewer:'auto_review'})],
    ['thread/start',value=>({...value,thread:{...value.thread,status:{type:'active'}}})],
    ['thread/start',value=>({...value,thread:{...value.thread,turns:[{}]}})],
    ['mcpServerStatus/list',()=>({data:[{name:'fixture',runtimeStatus:'ready',tools:{}}],nextCursor:null})],
    ['mcpServerStatus/list',()=>({data:[{name:'unknown',runtimeStatus:'disabled',tools:{}}],nextCursor:null})],
    ['mcpServerStatus/list',()=>({data:[{name:'fixture',runtimeStatus:'disabled',tools:{run:{}}}],nextCursor:null})],
    ['mcpServerStatus/list',()=>({data:[],nextCursor:'more'})]];
  for(const [method,patch] of cases){const f=setup();f.rpc.patch=(name,value)=>name===method?patch(value):value;
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.proposal,null);assert.equal(result.processStopped,true);
    assert.equal(f.rpc.calls.some(call=>call.method==='turn/start'),false);noPrivate(result);
  }
});

test('pre-ack final events are replayed only for the acknowledged thread and turn',async()=>{
  const f=setup();f.rpc.onTurn=()=>{
    f.rpc.item(finalItem('RAW_SECRET'),true,{threadId:'foreign-thread',turnId});
    f.rpc.item(finalItem(proposalText(),'foreign-result'),true,{threadId,turnId:'foreign-turn'});
    f.rpc.item({id:'foreign-tool',type:'commandExecution'},false,{threadId,turnId:'foreign-turn'});
    f.rpc.complete();
  };
  const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'completed');assert.equal(result.proposal?.title,'Search');noPrivate(result);
});

test('terminal and final notifications may arrive in either order or together in the terminal payload',async()=>{
  for(const mode of ['terminal-first','terminal-items','ack-completed'] as const){const f=setup();
    if(mode==='terminal-first')f.rpc.onTurn=()=>{f.rpc.terminal();setImmediate(()=>f.rpc.item(finalItem()));};
    if(mode==='terminal-items')f.rpc.onTurn=()=>setImmediate(()=>f.rpc.terminal([finalItem()]));
    if(mode==='ack-completed'){f.rpc.onTurn=()=>{};f.rpc.patch=(method,value)=>method==='turn/start'?{turn:{id:turnId,status:'completed',items:[finalItem()]}}:value;}
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'completed',mode);assert.equal(result.proposal?.title,'Search');
  }
});

test('commentary, partial answers, deltas and reasoning never become proposals or raw retained text',async()=>{
  const f=setup();f.rpc.onTurn=()=>{
    f.rpc.emit('notification',{method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'delta',delta:'RAW_SECRET'}});
    f.rpc.emit('notification',{method:'item/reasoning/textDelta',params:{threadId,turnId,text:'RAW_SECRET'}});
    for(const phase of ['commentary','partial_answer'])f.rpc.item({id:phase,type:'agentMessage',phase,text:'RAW_SECRET'});
    f.rpc.item({id:'reasoning',type:'reasoning',content:['RAW_SECRET']});f.rpc.complete();
  };
  const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'completed');noPrivate(result);
});

test('missing or null final phase and asynchronous questions fail closed',async()=>{
  for(const patch of [{phase:undefined},{phase:null},{phase:'unknown'},{delivery:'async'},{questions:[{question:'RAW_SECRET'}]}]){
    const f=setup();f.rpc.onTurn=()=>{f.rpc.item({...finalItem(),...patch});f.rpc.terminal();};
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.proposal,null);noPrivate(result);
  }
});

test('a completed turn without a final answer cannot succeed and closure resolves the missing result',async()=>{
  const f=setup();f.rpc.onTurn=()=>setImmediate(()=>{f.rpc.item({...finalItem(),phase:'commentary'});f.rpc.terminal();f.rpc.emit('closed');});
  const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.issue,'PLANNING_RESULT_MISSING');assert.equal(result.proposal,null);
});

test('identical final snapshots deduplicate while competing final IDs or contents fail',async()=>{
  const same=setup();same.rpc.onTurn=()=>{same.rpc.item(finalItem());same.rpc.item(finalItem());same.rpc.terminal([finalItem()]);};
  assert.equal((await runCodexPlanning(same.input,same.factory)).execution,'completed');
  for(const item of [finalItem(proposalText(),'another-final'),finalItem(proposalText().replace('Search','Other plan'))]){
    const f=setup();f.rpc.onTurn=()=>{f.rpc.item(finalItem());f.rpc.item(item);f.rpc.terminal();};
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.proposal,null);
  }
});

test('malformed, authority-bearing, private and oversized output never becomes a proposal',async()=>{
  for(const text of ['RAW_SECRET invalid JSON',proposalText().replace('"Search"','"person@example.invalid"'),
    JSON.stringify({...JSON.parse(proposalText()),source:{kind:'approved',provider_id:'fake',external_url:null}}),
    JSON.stringify({...JSON.parse(proposalText()),state:'approved'}),proposalText().replace('Find items','Bearer fixture-token'),
    'x'.repeat(64001),'한'.repeat(90000)]){
    const f=setup();f.rpc.onTurn=()=>f.rpc.complete(text);const result=await runCodexPlanning(f.input,f.factory);
    assert.equal(result.execution,'failed');assert.equal(result.proposal,null);assert.equal(result.processStopped,true);noPrivate(result);
  }
});

test('raw final output at the character boundary remains valid without truncation',async()=>{
  const value=JSON.parse(proposalText());value.goal='';value.goal='x'.repeat(64000-JSON.stringify(value).length);const text=JSON.stringify(value);assert.equal(text.length,64000);
  // This checks output integrity, not latency; allow headroom for validation under concurrent test load.
  const f=setup();f.rpc.onTurn=()=>f.rpc.complete(text);const result=await runCodexPlanning({...f.input,timeoutMs:5000},f.factory);
  assert.equal(result.execution,'completed');assert.equal(result.proposal?.goal,value.goal);
});

test('tools and approvals fail closed, interrupt the acknowledged turn and close its process',async()=>{
  for(const kind of ['approval','commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageGeneration','collabAgentToolCall','enteredReviewMode','unknownTool']){
    const f=setup();f.rpc.onTurn=()=>setImmediate(()=>{
      if(kind==='approval')f.rpc.emit('approval',{method:'item/commandExecution/requestApproval',threadId,turnId});
      else f.rpc.item({id:'tool',type:kind,text:'RAW_SECRET'},false);
    });
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed',kind);assert.equal(result.proposal,null);assert.equal(result.processStopped,true);
    assert.ok(f.rpc.calls.some(call=>call.method==='turn/interrupt'));noPrivate(result);
  }
});

test('tool-specific notifications and tools in terminal items invalidate otherwise valid output',async()=>{
  for(const mode of ['tool-delta','terminal-tool','closing-tool']){
    const f=setup();f.rpc.onTurn=()=>{
      f.rpc.item(finalItem());
      if(mode==='tool-delta')f.rpc.emit('notification',{method:'item/commandExecution/outputDelta',params:{threadId,turnId,delta:'RAW_SECRET'}});
      f.rpc.terminal(mode==='terminal-tool'?[{id:'tool',type:'fileChange'}]:[]);
    };
    if(mode==='closing-tool')f.rpc.close=async()=>{f.rpc.item({id:'tool',type:'commandExecution'},false);f.rpc.emit('closed');};
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.proposal,null);noPrivate(result);
  }
});

test('abort, timeout and failed turns cannot publish a final proposal',async()=>{
  const f=setup(),abort=new AbortController();f.rpc.onTurn=()=>setImmediate(()=>abort.abort());
  const interrupted=await runCodexPlanning({...f.input,signal:abort.signal},f.factory);assert.equal(interrupted.execution,'interrupted');assert.equal(interrupted.proposal,null);
  assert.ok(f.rpc.calls.some(call=>call.method==='turn/interrupt'));
  const timeout=setup();timeout.rpc.onTurn=()=>{};assert.equal((await runCodexPlanning(timeout.input,timeout.factory)).execution,'timed_out');
  for(const status of ['failed','interrupted']){const failed=setup();failed.rpc.onTurn=()=>{failed.rpc.item(finalItem());failed.rpc.terminal([],status);};
    const result=await runCodexPlanning(failed.input,failed.factory);assert.equal(result.execution,status);assert.equal(result.proposal,null);
  }
});

test('unconfirmed close stays lost, and abort during closure remains interrupted',async()=>{
  for(const mode of ['reject','no-event','hang'] as const){const f=setup();f.rpc.closeMode=mode;
    const began=Date.now(),result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'lost');assert.equal(result.processStopped,false);
    assert.equal(result.proposal,null);assert.ok(Date.now()-began<4000);noPrivate(result);
  }
  const f=setup(),abort=new AbortController();f.rpc.close=async()=>{abort.abort();f.rpc.emit('closed');};
  const result=await runCodexPlanning({...f.input,signal:abort.signal},f.factory);assert.equal(result.execution,'interrupted');assert.equal(result.proposal,null);
});

test('transport loss before completion and callback failure preserve fixed diagnostics only',async()=>{
  const f=setup();f.rpc.onTurn=()=>setImmediate(()=>f.rpc.emit('closed'));const lost=await runCodexPlanning(f.input,f.factory);assert.equal(lost.execution,'lost');assert.equal(lost.proposal,null);
  const g=setup();const callback=await runCodexPlanning({...g.input,onStarted:()=>{throw new Error('PRIVATE_CALLBACK');}},g.factory);
  assert.equal(callback.execution,'failed');assert.equal(callback.proposal,null);assert.ok(g.rpc.calls.some(call=>call.method==='turn/interrupt'));noPrivate(callback);
});

test('pre-ack event count and byte budgets bound retained notifications',async()=>{
  for(const mode of ['count','bytes']){const f=setup();f.rpc.onTurn=()=>{
    if(mode==='count')for(let index=0;index<129;index++)f.rpc.item(finalItem(proposalText(),'item-'+index));
    else for(let index=0;index<6;index++)f.rpc.item(finalItem('x'.repeat(64000),'item-'+index));
  };
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed');assert.equal(result.issue,'PLANNING_NOTIFICATION_LIMIT');assert.equal(result.proposal,null);
  }
});

test('invalid inputs, accessor-bearing protocol objects and pre-aborted runs never expose private data',async()=>{
  const f=setup();for(const patch of [{workspacePath:'relative'},{timeoutMs:999},{timeoutMs:60001},{instructions:''},{instructions:'x'.repeat(64001)}]){
    const result=await runCodexPlanning({...f.input,...patch},f.factory);assert.equal(result.execution,'failed');assert.equal(result.issue,'INVALID_PLANNING_INPUT');
  }
  assert.equal((await runCodexPlanning({...f.input,signal:AbortSignal.abort()},f.factory)).execution,'interrupted');assert.equal(f.flags.length,0);
  const g=setup();g.rpc.patch=(method,value)=>{if(method==='thread/start')Object.defineProperty(value,'thread',{get(){throw new Error('PRIVATE_GETTER');}});return value;};
  const result=await runCodexPlanning(g.input,g.factory);assert.equal(result.execution,'failed');assert.equal(result.proposal,null);noPrivate(result);
});

test('invalid acknowledgements, malformed final text and terminal errors never publish raw diagnostics',async()=>{
  for(const mode of ['invalid-id','invalid-status','malformed-text','terminal-error','error-event']){
    const f=setup();f.rpc.onTurn=()=>setImmediate(()=>{
      if(mode==='malformed-text')f.rpc.item({...finalItem(),text:7});
      if(mode==='terminal-error')f.rpc.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[finalItem()],error:{message:'RAW_SECRET'}}}});
      if(mode==='error-event')f.rpc.emit('notification',{method:'error',params:{threadId,turnId,message:'RAW_SECRET'}});
    });
    if(mode==='invalid-id'||mode==='invalid-status')f.rpc.patch=(method,value)=>method==='turn/start'?{turn:{id:mode==='invalid-id'?'../PRIVATE_ID':turnId,status:mode==='invalid-status'?'PRIVATE_STATUS':'inProgress',items:[]}}:value;
    const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'failed',mode);assert.equal(result.proposal,null);noPrivate(result);
  }
});

test('foreign notifications and approvals after acknowledgement cannot replace or interrupt the selected proposal',async()=>{
  const f=setup();f.rpc.onTurn=()=>setImmediate(()=>{
    f.rpc.item({id:'foreign-tool',type:'commandExecution'},false,{threadId,turnId:'foreign-turn'});
    f.rpc.item({...finalItem('RAW_SECRET'),phase:undefined},true,{threadId:'foreign-thread',turnId});
    f.rpc.emit('approval',{threadId,turnId:'foreign-turn'});f.rpc.terminal([], 'failed','foreign-turn');f.rpc.complete();
  });
  const result=await runCodexPlanning(f.input,f.factory);assert.equal(result.execution,'completed');assert.equal(result.proposal?.title,'Search');noPrivate(result);
});
