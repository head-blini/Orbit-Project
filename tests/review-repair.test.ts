import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Studio} from '../server/studio.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import {readVerificationConfiguration} from '../server/verification-service.ts';
import type {RpcPort} from '../server/rpc.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {ReviewRecord,ReviewPreview,ReviewView,ReviewRepairPreview} from '../shared/reviews.ts';

const FINDING='[P2] index.html:46-49 timezone edge case skips a calendar day.';
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-review-repair-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(join(root,'check.mjs'),'process.exit(0);');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(':memory:'),projects=new Projects(store,join(dir,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id),studio=new Studio(store);
  store.setMeta('selectedWorkspace',workspace.id);
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Date page',goal:'Show a date',requirements:[{id:'R1',description:'Date',acceptance_criteria:['Check passes']}],constraints:[],open_questions:[],depth:'standard'})}}) as PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion,[task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  const config=readVerificationConfiguration(JSON.stringify([{projectPath:root,id:'check',label:'Approved check',executable:process.execPath,args:['check.mjs'],timeoutMs:5000,protectedFiles:['check.mjs']}]));
  const turns:string[]=[] as string[];let reviewText=FINDING;
  class Rpc extends EventEmitter implements RpcPort {
    write:boolean;constructor(write:boolean){super();this.write=write;}
    async initialize(){}
    async close(){this.emit('closed');}
    async request(method:string,params:any){
      if(method==='account/read')return {account:{type:'chatgpt'}};
      if(method==='config/read')return {config:{mcp_servers:{}}};
      if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
      if(method==='thread/start')return {thread:{id:this.write?'main-thread':'review-thread',status:{type:'idle'}},sandbox:this.write?{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false},approvalPolicy:this.write?'on-request':'untrusted',approvalsReviewer:'user'};
      if(method==='turn/start'){turns.push(params.input[0].text);return {turn:{id:'turn-'+turns.length}};}
      if(method==='review/start'){setImmediate(()=>{this.emit('notification',{method:'item/completed',params:{threadId:'review-thread',turnId:'review-turn',item:{id:'review-item',type:'exitedReviewMode',review:reviewText}}});this.emit('notification',{method:'turn/completed',params:{threadId:'review-thread',turn:{id:'review-turn',status:'completed',items:[]}}});});return {reviewThreadId:'review-thread',turn:{id:'review-turn',status:'inProgress',items:[]}};}
      return {};
    }
  }
  const controller=new Controller(store,createWorkspace(dir),(_path:string,write:boolean)=>new Rpc(write),projects,config);await controller.selectWorkspace(workspace.id);
  writeFileSync(join(workspace.path,'index.html'),'<p>demo</p>\n');
  const acceptance=controller.taskVerificationPreview(project.id,task.id,workspace.id)!;
  const source=store.createRun(randomUUID(),'fixture','produce',workspace.id,{taskId:task.id,projectId:project.id,runtime:'codex',planningVersionId:plan.id,planningContentHash:plan.contentHash,requirementLabels:task.requirementLabels},undefined,acceptance);
  store.updateRun(source.id,{execution:'completed'},'run.completed');
  const server=createHttpServer(controller,dir);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const post=(path:string,data:object,override:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(data)}),get=(path:string)=>fetch(origin+path,{headers:{Cookie:cookie}});
  const review=async()=>{
    const preview=await(await get(`/api/workspaces/${workspace.id}/reviews/preview?runId=${source.id}`)).json() as ReviewPreview;
    const record=await(await post('/api/reviews/start',{requestId:randomUUID(),workspaceId:workspace.id,runId:source.id,expectedPreviewDigest:preview.previewDigest,confirmed:true})).json() as ReviewRecord;
    await controller.reviews.settle();return controller.reviews.record(record.id);
  };
  const repairPath=(id:string)=>`/api/workspaces/${workspace.id}/reviews/${id}/repair-preview`;
  const body=(p:ReviewRepairPreview,extra:object={})=>({requestId:randomUUID(),workspaceId:workspace.id,expectedPreviewDigest:p.previewDigest,confirmed:true,...extra});
  const close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();rmSync(dir,{recursive:true,force:true});};
  return {store,controller,workspace,source,turns,post,get,review,repairPath,body,close,setReview:(text:string)=>{reviewText=text;}};
}

test('a finished review never repairs by itself; the explicit user action creates exactly one repair run, replays idempotently and then refuses on budget',async()=>{
  const f=await fixture();
  try{
    const record=await f.review();assert.equal(record.execution,'completed');assert.equal(record.response,FINDING);
    assert.equal(f.store.runs().length,1,'review created no run');assert.deepEqual(f.turns,[]);
    // GET stays read-only.
    const events=()=>f.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n,before=events();
    const preview=await(await f.get(f.repairPath(record.id))).json() as ReviewRepairPreview;
    const view=await(await f.get(`/api/workspaces/${f.workspace.id}/reviews`)).json() as ReviewView;
    assert.equal(events(),before);assert.equal(f.store.runs().length,1);assert.deepEqual(f.turns,[]);
    assert.equal(preview.issue,null);assert.deepEqual(preview.budget,{used:0,max:1});assert.equal(preview.findings.text,FINDING);assert.deepEqual(view.repairBudgets,{[record.id]:{used:0,max:1}});
    assert.equal((await f.get(f.repairPath(record.id)+'?x=1')).status,400);
    const path=`/api/reviews/${record.id}/repair`,input=f.body(preview);
    assert.equal((await f.post(path,input,{'X-CSRF-Token':''})).status,403);
    assert.equal((await f.post(path,{...input,prompt:'override'})).status,400);
    assert.equal((await f.post(path,{...input,confirmed:false})).status,409);
    assert.equal((await f.post(path,{...input,requestId:randomUUID(),expectedPreviewDigest:'0'.repeat(64)})).status,409);
    assert.equal(f.store.runs().length,1);assert.deepEqual(f.turns,[]);
    assert.equal((await f.post('/api/connect',{})).status,200);
    const response=await f.post(path,input);assert.equal(response.status,200);const run=await response.json() as {id:string;taskId:string};
    assert.equal(f.store.runs().length,2);assert.equal(f.turns.length,1);
    const sent=f.turns[0] as string;assert.match(sent,/"reviewFindings"/);assert.ok(sent.includes('timezone edge case'));assert.equal(sent.includes('"confirmed"'),false);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND kind='run.repair_source'").get(run.id)!.n,1);
    // Duplicate request: same run, no second turn.
    const again=await f.post(path,input);assert.equal(again.status,200);assert.equal((await again.json() as {id:string}).id,run.id);assert.equal(f.turns.length,1);assert.equal(f.store.runs().length,2);
    assert.equal((await f.post(path,{...input,workspaceId:randomUUID()})).status,409);
    // Budget exhausted: clear code on preview and start, control data says used.
    f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    const used=await(await f.get(f.repairPath(record.id))).json() as ReviewRepairPreview;
    assert.equal(used.issue,'REVIEW_REPAIR_BUDGET_EXHAUSTED');assert.deepEqual(used.budget,{used:1,max:1});
    const refused=await f.post(path,{...input,requestId:randomUUID()});assert.equal(refused.status,409);assert.equal((await refused.json() as {error:string}).error,'REVIEW_REPAIR_BUDGET_EXHAUSTED');
    assert.equal(f.store.runs().length,2);assert.equal(f.turns.length,1);
    assert.deepEqual(((await(await f.get(`/api/workspaces/${f.workspace.id}/reviews`)).json()) as ReviewView).repairBudgets,{[record.id]:{used:1,max:1}});
  }finally{await f.close();}
});

test('credential-like review text is refused before any run is created',async()=>{
  const f=await fixture();
  try{
    const record=await f.review(),secret='sk-abcdefghijklmnopqrstuvwx';
    f.store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify({...record,response:'leaked '+secret}),record.id);
    assert.equal((await f.post('/api/connect',{})).status,200);
    const preview=await(await f.get(f.repairPath(record.id))).json() as ReviewRepairPreview;assert.equal(preview.issue,'CREDENTIAL_LIKE_INPUT');
    const refused=await f.post(`/api/reviews/${record.id}/repair`,f.body(preview));assert.equal(refused.status,400);assert.equal((await refused.json() as {error:string}).error,'CREDENTIAL_LIKE_INPUT');
    assert.equal(f.store.runs().length,1);assert.deepEqual(f.turns,[]);
    assert.ok(f.store.db.prepare("SELECT 1 FROM events WHERE kind='guardrail.denied'").get());
  }finally{await f.close();}
});

test('review findings have their own size cap, independent of the plan brief bound',async()=>{
  const f=await fixture();
  try{
    const record=await f.review(),set=(response:string)=>f.store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify({...record,response}),record.id);
    // 4,500 chars alone would have pushed brief+findings past 4,000; the verification repair path never counted its suffix either.
    set('리뷰 지적: '+'x'.repeat(4500));
    const fits=await f.get(f.repairPath(record.id));assert.equal(fits.status,200);const preview=await fits.json() as ReviewRepairPreview;
    assert.equal(preview.issue,null);assert.ok(preview.promptChars>4000&&preview.promptChars<=preview.maxPromptChars);
    set('x'.repeat(6001));
    const over=await f.get(f.repairPath(record.id));assert.equal(over.status,422);assert.equal((await over.json() as {error:string}).error,'REVIEW_REPAIR_TOO_LARGE');
    assert.equal(f.store.runs().length,1);
  }finally{await f.close();}
});

test('changed source or a non-completed review is not eligible',async()=>{
  const f=await fixture();
  try{
    const record=await f.review();
    writeFileSync(join(f.workspace.path,'index.html'),'<p>changed after review</p>\n');
    const preview=await(await f.get(f.repairPath(record.id))).json() as ReviewRepairPreview;assert.equal(preview.issue,'REVIEW_REPAIR_SOURCE_CHANGED');
    assert.equal((await f.post('/api/connect',{})).status,200);
    assert.equal((await f.post(`/api/reviews/${record.id}/repair`,f.body(preview))).status,409);assert.equal(f.store.runs().length,1);assert.deepEqual(f.turns,[]);
    f.store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify({...record,execution:'failed'}),record.id);
    assert.equal((await f.get(f.repairPath(record.id))).status,409);
  }finally{await f.close();}
});
