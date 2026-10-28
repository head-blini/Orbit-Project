import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Controller} from '../server/controller.ts';
import {Store} from '../server/store.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';

class FakeRpc extends EventEmitter {
  model='gpt-5.4';starts=0;earlyTerminal=false;missingEvents=false;
  async initialize(){}
  async request(method:string):Promise<any>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-fixture',sessionId:'session-fixture',status:{type:'idle'}},model:this.model,modelProvider:'openai',sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='turn/start'){
      this.starts++;if(!this.missingEvents)this.event('turn/started');if(this.earlyTerminal)this.event('turn/completed',{turn:{id:`turn-${this.starts}`,status:'completed'}});
      return {turn:{id:`turn-${this.starts}`,model:'unofficial-turn-model'}};
    }return {};
  }
  event(method:string,extra:object={}){this.emit('notification',{method,params:{threadId:'thread-fixture',turn:{id:`turn-${this.starts}`},...extra}});}
  async close(){this.emit('closed');}
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-model-controller-')),store=new Store(':memory:'),rpcs:FakeRpc[]=[];
  const controller=new Controller(store,createWorkspace(dir),()=>{const rpc=new FakeRpc();if(rpcs.length)rpc.model='gpt-5.5';rpcs.push(rpc);return rpc;});
  return {controller,store,rpcs,close:async()=>{await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('controller persists only native configuration evidence and preserves request replay',async()=>{
  const f=fixture();try{await f.controller.connect();const input={requestId:'model-evidence-request',prompt:'Fixture'},run=await f.controller.submit(input);const rpc=f.rpcs[0];
    rpc.event('turn/completed',{turn:{id:'turn-1',status:'completed'}});
    const value=f.store.getCodexModelAttribution(run.id)!;assert.equal(value.serverModelId,'gpt-5.4');assert.equal(value.nativeSessionId,'session-fixture');assert.equal(value.turnId,'turn-1');
    assert.equal(value.requestedModelId,null);assert.equal(value.selectedModelId,null);assert.equal(value.actualModelId,'unknown');assert.equal(value.actualModelEvidence,'unavailable');assert.equal(value.status,'completed');
    assert.equal((await f.controller.submit(input)).id,run.id);assert.equal(rpc.starts,1);assert.deepEqual(f.store.getCodexModelAttribution(run.id),value);
  }finally{await f.close();}
});
test('controller resume and settings change retain configuration semantics across interrupted turns',async()=>{
  const f=fixture();try{await f.controller.connect();const first=await f.controller.submit({requestId:'resume-first',prompt:'Fixture'});f.rpcs[0].event('turn/completed',{turn:{id:'turn-1',status:'completed'}});const prior=f.store.getCodexModelAttribution(first.id);
    await f.controller.close();await f.controller.connect();const run=await f.controller.submit({requestId:'resume-next',prompt:'Fixture'}),rpc=f.rpcs[1];
    rpc.event('thread/settings/updated',{threadSettings:{model:'gpt-5.6',modelProvider:'openai'}});await f.controller.interrupt(run.id);rpc.event('turn/completed',{turn:{id:'turn-1',status:'interrupted'}});
    const value=f.store.getCodexModelAttribution(run.id)!;assert.equal(value.resumed,true);assert.equal(value.serverModelId,'gpt-5.6');assert.equal(value.modelChanged,true);assert.equal(value.status,'interrupted');assert.equal(value.observationIncomplete,true);assert.equal(value.actualModelId,'unknown');
    assert.deepEqual(f.store.getCodexModelAttribution(first.id),prior);
    rpc.event('thread/settings/updated',{threadSettings:{model:'gpt-5.7',modelProvider:'openai'}});f.rpcs[0].event('thread/settings/updated',{threadSettings:{model:'stale-connection',modelProvider:'openai'}});
    assert.equal(f.store.getCodexModelAttribution(run.id)?.serverModelId,'gpt-5.6');
  }finally{await f.close();}
});
test('controller terminal-before-ack and missing-event transport loss remain uncertain',async()=>{
  const f=fixture();try{await f.controller.connect();f.rpcs[0].earlyTerminal=true;const run=await f.controller.submit({requestId:'early-terminal',prompt:'Fixture'});assert.equal(f.store.getCodexModelAttribution(run.id)?.status,'completed');assert.equal(f.store.getCodexModelAttribution(run.id)?.actualModelId,'unknown');
    f.rpcs[0].earlyTerminal=false;f.rpcs[0].missingEvents=true;const next=await f.controller.submit({requestId:'missing-events',prompt:'Fixture'});await f.rpcs[0].close();const value=f.store.getCodexModelAttribution(next.id)!;assert.equal(value.status,'lost');assert.equal(value.observationIncomplete,true);assert.equal(value.actualModelId,'unknown');
  }finally{await f.close();}
});
test('model identity HTTP read requires session, rejects query and never dispatches',async()=>{
  const f=fixture();const server=createHttpServer(f.controller,'unused',{nativeProbe:{get:()=>null,refresh:async()=>{throw Error('NO_PROBE');}}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{await f.controller.connect();const run=await f.controller.submit({requestId:'http-evidence',prompt:'Fixture'}),path=`/api/runs/${run.id}/model-identity`;
    assert.equal((await fetch(origin+path)).status,401);const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(origin+path+'?raw=1',{headers:{cookie}})).status,400);assert.equal((await fetch(origin+'/api/runs/00000000-0000-0000-0000-000000000000/model-identity',{headers:{cookie}})).status,404);
    const result=await fetch(origin+path,{headers:{cookie}});assert.equal(result.status,200);const body=await result.json() as any;assert.equal(body.runId,run.id);assert.equal(body.attribution.actualModelId,'unknown');assert.equal(body.attribution.serverModelId,'gpt-5.4');assert.equal(f.rpcs[0].starts,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
