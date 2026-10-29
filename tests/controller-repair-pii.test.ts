import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Controller} from '../server/controller.ts';
import {Store} from '../server/store.ts';
import {createWorkspace} from '../server/workspace.ts';
import {outboundDenial} from '../server/providers/policy.ts';
import {briefPiiInspectionText} from '../server/planning/execution.ts';
import {repairPiiInspectionText} from '../server/repair-pii.ts';

// Known digest containing the national-id-like run 8351692182046.
const BAD='3cb51b163060ad2e739df665332862c2b6a6130cd5c54cf8351692182046e5a2';
const RUN='8351692182046';
const UUID='5f0e8a1c-8351-4692-9182-0466a1b2c3d4';
const HEAD='Execution brief\n실패 항목만 수정하고 승인 기준과 통과 항목을 보존하세요.\n';

class FakeRpc extends EventEmitter {
  turns:string[]=[];
  async request(method:string,params:any):Promise<any>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-fixture',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='turn/start'){this.turns.push(params.input[0].text);return {turn:{id:'turn-fixture'}};}
    return {};
  }
  async initialize(){}
  async close(){this.emit('closed');}
}
const setup=()=>{const rpc=new FakeRpc(),store=new Store(':memory:'),dir=createWorkspace(mkdtempSync(join(tmpdir(),'orbit-repair-pii-')));return {rpc,store,c:new Controller(store,dir,()=>rpc)};};
// Same shape as Controller.repairQuality's Codex branch: brief head + JSON.stringify({baseline,failures}).
const json=(evidence='Missing citation.',checkIds:string[]=[BAD])=>JSON.stringify({baseline:{id:UUID,digest:BAD,criteria:['Cite']},failures:[{reviewerId:'verification',criterion:null,status:'not_met',evidence,checkIds}]});
const launch=(c:Controller,id:string,body:string)=>(c as any).start({requestId:id,prompt:HEAD+body},undefined,undefined,undefined,undefined,briefPiiInspectionText(HEAD)+repairPiiInspectionText(body));

test('Codex repair launches with digest/UUID identifiers; free-text runs and credentials still block; bytes unchanged',async()=>{
  const {c,rpc,store}=setup();
  try{
    await c.connect();
    assert.equal(outboundDenial(HEAD+json()),'PERSONAL_DATA_BLOCKED','fixture digest no longer trips PII');
    for(const [id,body,code] of [['repair-pii-run-1',json(`Total ${RUN} is wrong`),/PERSONAL_DATA_BLOCKED/],['repair-pii-run-2',json('x',[`id ${RUN}`]),/PERSONAL_DATA_BLOCKED/],
      ['repair-pii-cred-1',json('key sk-abcdefghijklmnopqrstuvwx'),/CREDENTIAL_LIKE_INPUT/],['repair-pii-cred-2',json('x',['sk-abcdefghijklmnopqrstuvwx']),/CREDENTIAL_LIKE_INPUT/]] as const){
      await assert.rejects(launch(c,id,body),code);
      assert.equal(rpc.turns.length,0);assert.equal(store.runs().length,0);
    }
    const body=json();await launch(c,'repair-pii-ok-1',body);
    assert.deepEqual(rpc.turns,[HEAD+body]);
  }finally{await c.close();store.close();}
});

test('verification failure evidence keeps the check id out of free text',async()=>{
  const {c,store}=setup();
  try{
    const run={id:'run-1',workspaceId:'ws-1'},check={id:UUID,commandId:'npm-test',execution:'completed',verdict:'failed',finishedDigest:BAD};
    Object.assign(c as any,{guardQuality(){},ownQualityStep:(f:()=>unknown)=>f(),startBoundVerification:()=>check,
      verification:Object.assign(Object.create((c as any).verification),{view:()=>({sourceDigest:BAD,commands:[{id:'npm-test',configDigest:BAD}],checks:[check]}),settle:async()=>{},interrupt(){}})});
    const result=await (c as any).verifyQuality({sourceRun:run,stepId:'step-1',artifact:{id:'a',digest:BAD},signal:new AbortController().signal});
    assert.equal(result.status,'failed');assert.deepEqual(result.checkIds,[UUID]);
    assert.deepEqual(result.failures,[{reviewerId:'verification',criterion:null,status:'not_met',evidence:'npm-test: failed',checkIds:[UUID]}]);
    assert.equal(outboundDenial(repairPiiInspectionText(JSON.stringify({baseline:{id:UUID,digest:BAD,criteria:[]},failures:result.failures}))),null);
  }finally{await c.close();store.close();}
});
