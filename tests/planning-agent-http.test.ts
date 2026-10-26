import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import type {RpcPort} from '../server/rpc.ts';
import type {PlanningAgentPreview,PlanningAgentView,PlanningSuggestion} from '../shared/planning-agent.ts';
import type {PlanningVersion} from '../shared/parallel.ts';

const proposalText=JSON.stringify({schema_version:'1.0',title:'Offline plan',goal:'Keep user state locally',requirements:[
  {id:'R1',description:'Preserve state',acceptance_criteria:['Restore saved state']}],constraints:['Use local storage'],open_questions:[],decisions:[]});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-planning-http-')),root=join(dir,'project');mkdirSync(root);
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,stdio:'pipe',windowsHide:true});
  git(root,'init','-q','-b','main');git(root,'config','core.autocrlf','false');writeFileSync(join(root,'source.txt'),'unchanged source\n');git(root,'add','.');
  git(root,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-qm','fixture');
  const database=join(dir,'test.sqlite'),store=new Store(database),writable=new Projects(store,join(dir,'managed'),[root]),project=writable.register(root);
  const workspace=writable.create(project.id),other=writable.create(project.id),projects=new Projects(store,join(dir,'managed'),[]);
  const stats={instances:0,turns:0,interrupts:0,hang:false,uncertainClose:false};
  class PlanningRpc extends EventEmitter implements RpcPort {
    async initialize(){}
    async close(){if(!stats.uncertainClose)this.emit('closed');}
    async request(method:string,params:any){
      if(method==='account/read')return {account:{type:'chatgpt'}};
      if(method==='config/read')return {config:{mcp_servers:{}}};
      if(method==='thread/start'){assert.equal(params.sandbox,'read-only');return {cwd:params.cwd,modelProvider:'openai',thread:{id:'planning-http-thread',cwd:params.cwd,ephemeral:true,modelProvider:'openai',status:{type:'idle'},turns:[]},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};}
      if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
      if(method==='turn/start'){
        stats.turns++;assert.equal(params.sandboxPolicy.type,'readOnly');assert.equal(params.sandboxPolicy.networkAccess,false);assert.ok(params.outputSchema);
        if(!stats.hang)setImmediate(()=>{this.emit('notification',{method:'item/completed',params:{threadId:'planning-http-thread',turnId:'planning-http-turn',item:{id:'planning-http-final',type:'agentMessage',phase:'final_answer',text:proposalText}}});
          this.emit('notification',{method:'turn/completed',params:{threadId:'planning-http-thread',turn:{id:'planning-http-turn',status:'completed',items:[],error:null}}});});
        return {turn:{id:'planning-http-turn',status:'inProgress',items:[]}};
      }
      if(method==='turn/interrupt'){stats.interrupts++;return {};}
      throw new Error('UNEXPECTED_FIXTURE_RPC');
    }
  }
  const factory=(path:string,write:boolean)=>{stats.instances++;assert.equal(path,workspace.path);assert.equal(write,false);return new PlanningRpc();};
  const controller=new Controller(store,createWorkspace(dir),factory,projects);await controller.selectWorkspace(workspace.id);
  const server=createHttpServer(controller,dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,session=await fetch(origin+'/api/session');
  const {csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
  const get=(path:string)=>fetch(origin+path,{headers:{cookie}});
  const post=(path:string,data:object,override:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(data)});
  const base=`/api/projects/${project.id}/planning-suggestions`;
  const preview=async(text='PRIVATE_PLANNING_REQUEST Keep an offline workspace')=>{
    const response=await post(base+'/preview',{workspaceId:workspace.id,text});assert.equal(response.status,200);return response.json() as Promise<PlanningAgentPreview>;
  };
  const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));stats.uncertainClose=false;await controller.close();store.close();};
  return {dir,root,database,store,projects,project,workspace,other,stats,controller,server,origin,cookie,headers,get,post,base,preview,factory,git,close};
}

test('planning HTTP preview is authenticated and inert in a selected workspace whose project is read-only',async()=>{
  const f=await fixture();try{
    assert.equal(f.projects.list()[0].writeEnabled,false);
    const viewPath=f.base+'?workspaceId='+f.workspace.id;
    assert.equal((await fetch(f.origin+viewPath)).status,401);
    const view=await f.get(viewPath);assert.equal(view.status,200);assert.deepEqual((await view.json() as PlanningAgentView).records,[]);
    const before=f.store.lastSeq();const preview=await f.preview();assert.equal(preview.workspaceId,f.workspace.id);assert.equal(preview.projectId,f.project.id);
    assert.match(preview.instructions,/PRIVATE_PLANNING_REQUEST/);assert.equal(f.stats.instances,0);assert.equal(f.stats.turns,0);assert.equal(f.store.lastSeq(),before);
  }finally{await f.close();}
});

async function error(response:Response,status:number,code:string){assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:code});}
const digest='a'.repeat(64);
async function launch(f:Awaited<ReturnType<typeof fixture>>,text='PRIVATE_PLANNING_REQUEST Keep an offline workspace'){
  const preview=await f.preview(text),input={requestId:randomUUID(),workspaceId:f.workspace.id,text,expectedPreviewDigest:preview.previewDigest,confirmed:true};
  const response=await f.post(f.base+'/start',input);assert.equal(response.status,200);
  return {input,record:await response.json() as PlanningSuggestion};
}
function sourceState(f:Awaited<ReturnType<typeof fixture>>){
  return [f.root,f.workspace.path].map(path=>({path,head:f.git(path,'rev-parse','HEAD').toString(),
    index:readFileSync(resolve(path,f.git(path,'rev-parse','--git-path','index').toString().trim())),source:readFileSync(join(path,'source.txt'))}));
}

test('planning routes enforce session, Origin, CSRF, exact fields, methods, query and selected workspace before RPC',async()=>{
  const f=await fixture();try{
    const id=randomUUID(),data={workspaceId:f.workspace.id,text:'Plan local state'};
    const mutations:[string,object][]=[['preview',data],['start',{requestId:randomUUID(),...data,expectedPreviewDigest:digest,confirmed:true}],
      ['recover',{workspaceId:f.workspace.id,suggestionId:id,confirmedStopped:true}],[id+'/interrupt',{workspaceId:f.workspace.id}],[id+'/save',{workspaceId:f.workspace.id,expectedOutputDigest:digest}]];
    for(const [path,body] of mutations){
      await error(await f.post(f.base+'/'+path,body,{cookie:''}),401,'SESSION_REQUIRED');
      await error(await f.post(f.base+'/'+path,body,{origin:'https://foreign.invalid'}),403,'ORIGIN_REJECTED');
      await error(await f.post(f.base+'/'+path,body,{'x-csrf-token':''}),403,'CSRF_REJECTED');
      await error(await f.post(f.base+'/'+path,{...body,extra:true}),400,'INVALID_FIELDS');
      await error(await f.post(f.base+'/'+path+'?extra=1',body),400,'INVALID_FIELDS');
      assert.equal((await f.get(f.base+'/'+path)).status,404);
      assert.equal((await fetch(f.origin+f.base+'/'+path,{method:'PUT',headers:f.headers,body:JSON.stringify(body)})).status,404);
    }
    for(const query of ['', '?workspaceId='+f.workspace.id+'&extra=1','?workspaceId='+f.workspace.id+'&workspaceId='+f.workspace.id])await error(await f.get(f.base+query),400,'INVALID_FIELDS');
    await error(await f.post(f.base+'/preview',{...data,workspaceId:f.other.id}),409,'WORKSPACE_MISMATCH');
    await error(await f.post(f.base+'/preview',{...data,text:'x'.repeat(8001)}),400,'INVALID_PLANNING_INPUT');
    assert.equal(f.stats.instances,0);assert.deepEqual(new Studio(f.store).read(f.project.id,'plans'),[]);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('8000 Korean characters preview and launch through HTTP, with explicit consent, stale protection and one durable request receipt',async()=>{
  const f=await fixture();try{
    const text='가'.repeat(8000);assert.equal(Buffer.byteLength(text),24000);const preview=await f.preview(text);
    const input={requestId:randomUUID(),workspaceId:f.workspace.id,text,expectedPreviewDigest:preview.previewDigest,confirmed:true};
    await error(await f.post(f.base+'/start',{...input,confirmed:false}),409,'PLANNING_CONFIRMATION_REQUIRED');
    await error(await f.post(f.base+'/start',{...input,text:'Changed request'}),409,'PLANNING_PREVIEW_STALE');assert.equal(f.stats.instances,0);
    const first=await f.post(f.base+'/start',input);assert.equal(first.status,200);const started=await first.json() as PlanningSuggestion;
    const duplicate=await f.post(f.base+'/start',input);assert.equal(duplicate.status,200);assert.equal((await duplicate.json() as PlanningSuggestion).id,started.id);
    await f.controller.planningSuggestions.settle();const result=f.controller.planningSuggestions.record(started.id);
    assert.equal(result.execution,'completed');assert.equal(f.stats.instances,1);assert.equal(f.stats.turns,1);
    assert.equal((await (await f.post(f.base+'/start',input)).json() as PlanningSuggestion).id,result.id);
    await error(await f.post(f.base+'/start',{...input,text:'Changed request'}),409,'IDEMPOTENCY_CONFLICT');assert.equal(f.stats.turns,1);
    assert.equal((new Studio(f.store).read(f.project.id,'plans') as unknown[]).length,0);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('validated suggestion saves only by explicit request as one unapproved draft and preserves source, HEAD and index',async()=>{
  const f=await fixture();try{
    const before=sourceState(f),{record}=await launch(f);await f.controller.planningSuggestions.settle();
    const result=f.controller.planningSuggestions.record(record.id),studio=new Studio(f.store);
    assert.equal(result.execution,'completed');assert.equal(result.processStopped,true);assert.deepEqual(studio.read(f.project.id,'plans'),[]);
    const body={workspaceId:f.workspace.id,expectedOutputDigest:result.outputDigest!};
    await error(await f.post(f.base+'/'+record.id+'/save',{...body,expectedOutputDigest:digest}),409,'PLANNING_PROPOSAL_STALE');
    const response=await f.post(f.base+'/'+record.id+'/save',body);assert.equal(response.status,200);const version=await response.json() as PlanningVersion;
    assert.equal(version.state,'draft');assert.equal(version.draft.title,'Offline plan');assert.equal(version.revision,1);
    assert.deepEqual(version.draft.provenance,{kind:'in_app_agent',providerId:'codex',externalUrl:null});
    assert.deepEqual(await (await f.post(f.base+'/'+record.id+'/save',body)).json(),version);
    assert.equal((studio.read(f.project.id,'plans') as unknown[]).length,1);assert.equal((studio.read(f.project.id,'tasks') as unknown[]).length,0);assert.equal(f.store.runs().length,0);
    assert.equal(f.controller.planningSuggestions.record(record.id).savedPlanningVersionId,version.id);assert.deepEqual(sourceState(f),before);
    const persisted=JSON.stringify(f.store.db.prepare('SELECT * FROM planning_suggestions').all())+JSON.stringify(f.store.eventsAfter(0));
    assert.doesNotMatch(persisted,/PRIVATE_PLANNING_REQUEST/);assert.equal(f.stats.instances,1);assert.equal(f.stats.turns,1);
  }finally{await f.close();}
});

async function assertExcluded(f:Awaited<ReturnType<typeof fixture>>,code:string){
  const w=f.workspace.id,requestId=randomUUID(),runId=null;
  const routes:[string,object][]=[['/api/connect',{}],['/api/workspaces/select',{workspaceId:f.other.id}],
    ['/api/model-hub/requests',{requestId,projectId:f.project.id,destinationId:'fixture',model:'fixture',text:'hello',expectedConfigDigest:digest,confirmed:true}],
    ['/api/reviews/start',{requestId,workspaceId:w,runId,expectedPreviewDigest:digest,confirmed:true}],
    ['/api/workflows/start',{requestId,workspaceId:w,workflowId:randomUUID(),expectedVersionId:randomUUID(),expectedPreviewDigest:digest,confirmed:true,retryOfId:null}],
    ['/api/workspaces/'+w+'/checks',{requestId,runId,commandId:'fixture',expectedSourceDigest:digest,expectedConfigDigest:digest}],
    ['/api/workspaces/'+w+'/review-approval',{requestId,runId,expectedSourceDigest:digest,expectedCheckSetDigest:digest}],
    ['/api/merges/prepare',{requestId,workspaceId:w,runId,expectedSourceDigest:digest,expectedCheckSetDigest:digest,expectedApprovalId:randomUUID(),expectedTargetBranch:'main',expectedTargetHead:'a'.repeat(40)}],
    [f.base+'/preview',{workspaceId:w,text:'Another request'}]];
  for(const [path,body] of routes)await error(await f.post(path,body),409,code);
  // This fixture has no connected coding session. Those entrypoints reject
  // before their later idle guard and must not open another RPC or create a Run.
  await error(await f.post('/api/extensions/refresh',{workspaceId:w}),409,'NOT_CONNECTED');
  await error(await f.post('/api/runs',{requestId,workspaceId:w,prompt:'Do not execute'}),409,'NOT_CONNECTED');
  assert.equal(f.controller.snapshot().selectedWorkspaceId,w);assert.equal(f.stats.instances,1);assert.equal(f.stats.turns,1);assert.equal(f.store.runs().length,0);
}

test('active planning blocks concurrent controller work and interruption stops only the selected suggestion',async()=>{
  const f=await fixture();try{
    f.stats.hang=true;const {record,input}=await launch(f);assert.equal(f.controller.planningSuggestions.active,true);await assertExcluded(f,'PLANNING_BUSY');
    const duplicate=await f.post(f.base+'/start',input);assert.equal((await duplicate.json() as PlanningSuggestion).id,record.id);
    await error(await f.post(f.base+'/'+record.id+'/interrupt',{workspaceId:f.other.id}),409,'WORKSPACE_MISMATCH');assert.equal(f.stats.interrupts,0);
    assert.equal((await f.post(f.base+'/'+record.id+'/interrupt',{workspaceId:f.workspace.id})).status,200);await f.controller.planningSuggestions.settle();
    const result=f.controller.planningSuggestions.record(record.id);assert.equal(result.execution,'interrupted');assert.equal(result.proposal,null);assert.equal(result.processStopped,true);
    assert.equal(f.stats.interrupts,1);assert.equal(f.controller.planningSuggestions.active,false);assert.equal(f.controller.snapshot().planningBusy,false);
    assert.equal((await f.post('/api/workspaces/select',{workspaceId:f.other.id})).status,200);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('uncertain closure quarantines launch paths until explicit recovery and cannot create a draft',async()=>{
  const f=await fixture();try{
    f.stats.uncertainClose=true;const {record}=await launch(f);await f.controller.planningSuggestions.settle();
    const result=f.controller.planningSuggestions.record(record.id);assert.equal(result.execution,'lost');assert.equal(result.proposal,null);assert.equal(result.processStopped,false);
    const view=await (await f.get(f.base+'?workspaceId='+f.workspace.id)).json() as PlanningAgentView;assert.equal(view.recoveryRequired,true);assert.equal(view.busy,false);
    await assertExcluded(f,'PLANNING_RECOVERY_REQUIRED');
    await error(await f.post(f.base+'/'+record.id+'/save',{workspaceId:f.workspace.id,expectedOutputDigest:digest}),409,'PLANNING_PROPOSAL_UNAVAILABLE');
    await error(await f.post(f.base+'/recover',{workspaceId:f.workspace.id,suggestionId:record.id,confirmedStopped:false}),409,'PLANNING_STOP_CONFIRMATION_REQUIRED');
    const response=await f.post(f.base+'/recover',{workspaceId:f.workspace.id,suggestionId:record.id,confirmedStopped:true});assert.equal(response.status,200);
    const recovered=await response.json() as PlanningSuggestion;assert.ok(recovered.recoveredAt);assert.equal(recovered.execution,'lost');
    await f.preview();assert.equal(f.stats.instances,1);assert.equal((new Studio(f.store).read(f.project.id,'plans') as unknown[]).length,0);
  }finally{await f.close();}
});

test('reopening durable running state records lost work without replaying inference or raw input',async()=>{
  const f=await fixture();let restored:Controller|undefined,store:Store|undefined;try{
    const {record,input}=await launch(f);await f.controller.planningSuggestions.settle();
    // Simulate the last durable row before a process crash, then reopen the real
    // SQLite database through a fresh Store and Controller.
    f.store.db.prepare('UPDATE planning_suggestions SET body=? WHERE id=?').run(JSON.stringify({...f.controller.planningSuggestions.record(record.id),execution:'running',processStopped:false,proposal:null,outputDigest:null}),record.id);
    store=new Store(f.database);const projects=new Projects(store,join(f.dir,'managed'),[]);restored=new Controller(store,createWorkspace(f.dir),f.factory,projects);
    const result=restored.planningSuggestions.record(record.id);assert.equal(result.execution,'lost');assert.equal(result.issue,'PLANNING_INTERRUPTED_BY_RESTART');
    assert.equal(result.proposal,null);assert.equal(result.processStopped,false);assert.equal(restored.planningSuggestions.view(f.project.id,f.workspace.id).recoveryRequired,true);
    assert.equal(restored.planningSuggestions.start(f.project.id,input).id,record.id);await restored.planningSuggestions.settle();
    assert.equal(f.stats.instances,1);assert.equal(f.stats.turns,1);assert.equal(store.runs().length,0);assert.equal((new Studio(store).read(f.project.id,'plans') as unknown[]).length,0);
    assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM planning_suggestions').all()),/PRIVATE_PLANNING_REQUEST/);
  }finally{await restored?.close();store?.close();await f.close();}
});
