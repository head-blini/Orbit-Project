import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Controller} from '../server/controller.ts';
import {Store} from '../server/store.ts';
import {createWorkspace} from '../server/workspace.ts';
import {outboundDenial} from '../server/providers/policy.ts';
import {briefPiiInspectionText} from '../server/planning/execution.ts';
import {claudeFixture} from './claude-task-fixture.ts';

// Known digest containing the national-id-like run 8351692182046.
const BAD='3cb51b163060ad2e739df665332862c2b6a6130cd5c54cf8351692182046e5a2';
const RUN='8351692182046';
// Deterministic plan whose real sha256 contentHash trips the PII pattern (found by search; asserted below).
const badPlan=(title='Report',description='Write a report')=>({format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title,goal:'Compare local evidence 86',
  requirements:[{id:'REQ-1',description,acceptance_criteria:['Cite evidence']}],constraints:[],open_questions:[]})});
const error=(code:string)=>(e:any)=>e?.code===code||String(e?.message).includes(code);

function brief(input=badPlan()){
  const f=claudeFixture();
  const version=f.studio.mutate(f.project.id,'plans',undefined,undefined,{requestId:randomUUID(),input}) as any;
  f.studio.mutate(f.project.id,'plans',version.id,'approve',{expectedRevision:1});
  const [task]=f.studio.mutate(f.project.id,'plans',version.id,'task-drafts',{}) as any[];
  return {f,version,task,prompt:f.studio.execution(f.project.id,task.id).prompt};
}

test('brief inspection text blanks only leading UUID/digest identifier values',async()=>{
  const {f,version,task,prompt}=brief();try{
    const forged=prompt.replace(version.contentHash,BAD);
    assert.equal(outboundDenial(forged),'PERSONAL_DATA_BLOCKED');
    assert.equal(outboundDenial(briefPiiInspectionText(forged)),null);
    const text=briefPiiInspectionText(forged);
    for(const id of [task.id,version.id,BAD])assert.equal(text.includes(id),false);
    // Same digest outside the identifier fields, or a non-brief prompt, stays inspected.
    assert.equal(outboundDenial(briefPiiInspectionText(forged.replace('"Report"',`"Report ${BAD}"`))),'PERSONAL_DATA_BLOCKED');
    assert.equal(briefPiiInspectionText(`hash ${BAD}`),`hash ${BAD}`);
    assert.equal(outboundDenial(briefPiiInspectionText('x\n'+forged)),'PERSONAL_DATA_BLOCKED');
  }finally{await f.close();}
});

test('Claude path launches a brief whose real contentHash trips PII; free-text runs and credentials still block',async()=>{
  const ok=brief();try{
    assert.equal(outboundDenial(ok.prompt),'PERSONAL_DATA_BLOCKED','fixture digest no longer trips PII; re-search the goal suffix');
    await ok.f.controller.submitTask(ok.f.project.id,ok.task.id,{requestId:randomUUID()});
    assert.equal(ok.f.launches.length,1);assert.equal(ok.f.store.runs().length,1);
  }finally{await ok.f.close();}
  for(const [input,code] of [[badPlan(`Report ${RUN}`),'PERSONAL_DATA_BLOCKED'],[badPlan('Report',`Write ${RUN}`),'PERSONAL_DATA_BLOCKED'],
    [badPlan('Report sk-abcdefghijklmnopqrstuvwx'),'CREDENTIAL_LIKE_INPUT']] as const){
    const b=brief(input);try{
      await assert.rejects(b.f.controller.submitTask(b.f.project.id,b.task.id,{requestId:randomUUID()}),error(code));
      assert.equal(b.f.launches.length,0);assert.equal(b.f.store.runs().length,0);
    }finally{await b.f.close();}
  }
});

class FakeRpc extends EventEmitter {
  sent:any[]=[];
  async request(method:string,params:any):Promise<any>{
    this.sent.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-fixture',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    if(method==='turn/start'){this.emit('notification',{method:'turn/started',params:{threadId:'thread-fixture',turn:{id:'turn-fixture'}}});return {turn:{id:'turn-fixture'}};}
    return {};
  }
  async initialize(){}
  async close(){this.emit('closed');}
}

test('Codex input gate accepts the brief identifiers byte-identically and still blocks free text and credentials',async()=>{
  const {f,version,prompt}=brief();await f.close();
  const forged=prompt.replace(version.contentHash,BAD);
  const rpc=new FakeRpc(),store=new Store(':memory:'),c=new Controller(store,createWorkspace(mkdtempSync(join(tmpdir(),'orbit-brief-pii-'))),()=>rpc);
  try{
    await c.connect();
    for(const [i,bad,code] of [[1,forged.replace('"Report"',`"Report ${RUN}"`),'PERSONAL_DATA_BLOCKED'],[2,forged.replace('Write a report',`Write ${RUN}`),'PERSONAL_DATA_BLOCKED'],
      [3,forged.replace('"Report"','"Report sk-abcdefghijklmnopqrstuvwx"'),'CREDENTIAL_LIKE_INPUT']] as const)
      await assert.rejects(c.submit({requestId:`brief-pii-bad-${i}`,prompt:bad}),error(code));
    assert.equal(store.runs().length,0);
    await c.submit({requestId:'brief-pii-ok',prompt:forged});
    const turn=rpc.sent.find(s=>s.method==='turn/start');
    assert.equal(turn.params.input[0].text,forged);
  }finally{await c.close();store.close();}
});
