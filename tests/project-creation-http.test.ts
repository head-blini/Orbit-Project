import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';

async function fixture(enabled=true){
  const dir=mkdtempSync(join(tmpdir(),'orbit-project-create-http-')),store=new Store(':memory:');
  const projects=new Projects(store,join(dir,'workspaces'),[],enabled?join(dir,'projects'):undefined);let nativeCalls=0;
  const controller=new Controller(store,createWorkspace(dir),()=>{nativeCalls++;throw new Error('NATIVE_FORBIDDEN');},projects);
  const server=createHttpServer(controller,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string};
  const headers={Origin:origin,Cookie:session.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  return {dir,store,projects,controller,origin,headers,nativeCalls:()=>nativeCalls,
    post:(path:string,data:unknown,customHeaders=headers)=>fetch(origin+path,{method:'POST',headers:customHeaders,body:JSON.stringify(data)}),
    close:async()=>{await controller.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('browser can prepare a new named repository and isolated workspace without host allowlist or AI execution',async()=>{
  const f=await fixture();try{
    const state=await (await fetch(f.origin+'/api/state',{headers:f.headers})).json() as any;
    assert.equal(state.projectCreationAvailable,true);
    const response=await f.post('/api/projects/create',{requestId:randomUUID(),name:'나의 첫 프로젝트'});
    assert.equal(response.status,200);const result=await response.json() as any;
    assert.equal(result.project.name,'나의 첫 프로젝트');assert.equal(result.project.writeEnabled,true);
    assert.equal(result.workspace.projectId,result.project.id);assert.equal(result.workspace.status,'ready');
    assert.match(readFileSync(join(result.workspace.path,'README.md'),'utf8'),/ready for planning/);
    assert.equal(f.controller.snapshot().selectedWorkspaceId,null,'selection remains an explicit existing action');
    assert.equal((await f.post('/api/workspaces/select',{workspaceId:result.workspace.id})).status,200);
    assert.equal(f.controller.snapshot().selectedWorkspaceId,result.workspace.id);
    const checks=f.controller.verification.view(result.workspace.id,null);
    assert.deepEqual(checks.commands,[]);assert.deepEqual(checks.checks,[]);assert.equal(checks.canApprove,false);
    assert.equal(f.nativeCalls(),0);assert.deepEqual(f.store.runs(),[]);
  }finally{await f.close();}
});
test('creation is authenticated, exact and cannot accept browser paths, commands or capability overrides',async()=>{
  const f=await fixture();try{
    const input={requestId:randomUUID(),name:'새 프로젝트'};
    assert.equal((await fetch(f.origin+'/api/projects/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
    assert.equal((await f.post('/api/projects/create',input,{...f.headers,'X-CSRF-Token':''})).status,403);
    assert.equal((await f.post('/api/projects/create',input,{...f.headers,Origin:'http://foreign.invalid'})).status,403);
    for(const data of [{...input,path:f.dir},{...input,writeEnabled:true},{...input,command:'git'},{...input,name:2},{...input,requestId:'--bad'},{}]){
      assert.equal((await f.post('/api/projects/create',data)).status,400,JSON.stringify(data));
    }
    assert.equal((await f.post('/api/projects/create?root=elsewhere',input)).status,400);
    assert.deepEqual(f.projects.list(),[]);assert.deepEqual(f.projects.workspaces(),[]);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});
test('duplicate HTTP delivery returns one project and one workspace; conflicting input cannot allocate another',async()=>{
  const f=await fixture();try{
    const input={requestId:randomUUID(),name:'중복 없는 프로젝트'};
    const replies=await Promise.all([f.post('/api/projects/create',input),f.post('/api/projects/create',input)]);
    assert.deepEqual(replies.map(r=>r.status),[200,200]);const [a,b]=await Promise.all(replies.map(r=>r.json()));assert.deepEqual(a,b);
    const conflict=await f.post('/api/projects/create',{...input,name:'다른 이름'});
    assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'IDEMPOTENCY_CONFLICT'});
    assert.equal(f.projects.list().length,1);assert.equal(f.projects.workspaces().length,1);
    assert.equal(readdirSync(join(f.dir,'projects')).length,1);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});
test('uncertain existing execution blocks creation before allocating files or project records',async()=>{
  const f=await fixture();try{
    const run=f.store.createRun(randomUUID(),'fixture','incomplete fixture');f.store.updateRun(run.id,{execution:'lost'},'run.lost');
    const response=await f.post('/api/projects/create',{requestId:randomUUID(),name:'생성 차단'});
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'SOLO_RECOVERY_REQUIRED'});
    assert.equal(f.projects.list().length,0);assert.equal(f.projects.workspaces().length,0);assert.deepEqual(readdirSync(join(f.dir,'projects')),[]);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});
test('hosts without a creation root do not expose project creation or create folders implicitly',async()=>{
  const f=await fixture(false);try{
    assert.equal(f.controller.snapshot().projectCreationAvailable,false);
    const response=await f.post('/api/projects/create',{requestId:randomUUID(),name:'비활성 프로젝트'});
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'PROJECT_CREATION_UNAVAILABLE'});
    assert.deepEqual(f.projects.list(),[]);assert.equal(f.nativeCalls(),0);
  }finally{await f.close();}
});

test('general project HTTP supports planning, artifacts and goals without Git or workspace allocation',async()=>{
  const f=await fixture();try{
    const request={requestId:randomUUID(),name:'Research',kind:'general'};
    const response=await f.post('/api/projects/create',request);assert.equal(response.status,200);
    const created=await response.json() as any;assert.equal(created.project.kind,'general');assert.equal(created.workspace,null);
    assert.deepEqual(await (await f.post('/api/projects/create',request)).json(),created);
    const base='/api/projects/'+created.project.id;
    const get=(path:string)=>fetch(f.origin+path,{headers:f.headers});
    const state=await (await get('/api/state')).json() as any;
    assert.equal(state.projects[0].kind,'general');assert.deepEqual(state.workspaces,[]);assert.equal(state.selectedWorkspaceId,null);
    const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Research',goal:'Write report',requirements:[{id:'R1',description:'Local evidence',acceptance_criteria:['Sources included']}],constraints:[],open_questions:[]})};
    const planResponse=await f.post(base+'/plans',{requestId:randomUUID(),input});assert.equal(planResponse.status,200);
    const plan=await planResponse.json() as any;
    assert.equal((await f.post(base+'/plans/'+plan.id+'/approve',{expectedRevision:1})).status,200);
    const tasks=await f.post(base+'/plans/'+plan.id+'/task-drafts',{});assert.equal(tasks.status,200);assert.equal((await tasks.json() as any[]).length,1);
    const artifactResponse=await f.post(base+'/artifacts',{requestId:randomUUID(),input:{kind:'mermaid',source:'flowchart TD\na["Evidence"]\nb["Report"]\na --> b',metadata:{title:'Research flow'}}});
    assert.equal(artifactResponse.status,200);const artifact=await artifactResponse.json() as any;
    assert.equal((await get(base+'/artifacts/'+artifact.id+'/export?revision=1&hash='+artifact.contentHash+'&format=markdown')).status,200);
    const goal=await f.post(base+'/goals',{requestId:randomUUID(),planningVersionId:plan.id,expectedPlanningHash:plan.contentHash});assert.equal(goal.status,200);
    for(const route of ['plans','tasks','artifacts','goals']){
      const result=await get(base+'/'+route);assert.equal(result.status,200);assert.equal((await result.json() as any[]).length,1);
    }
    const workspace='/api/workspaces/'+created.project.id;
    for(const suffix of ['diff','merge','verification','verification-setup','source-graph']){
      const result=await get(workspace+'/'+suffix);assert.equal(result.status,409,suffix);assert.deepEqual(await result.json(),{error:'GIT_REQUIRED'});
    }
    for(const [path,data] of [
      ['/api/workspaces',{projectId:created.project.id}],['/api/workspaces/select',{workspaceId:created.project.id}],
      [workspace+'/source-graph',{}],
      [workspace+'/checks',{requestId:randomUUID(),runId:null,commandId:'test',expectedSourceDigest:'0'.repeat(64),expectedConfigDigest:'0'.repeat(64)}],
      ['/api/merges/prepare',{requestId:randomUUID(),workspaceId:created.project.id,runId:null,expectedSourceDigest:'0'.repeat(64),expectedCheckSetDigest:'0'.repeat(64),expectedApprovalId:randomUUID(),expectedTargetBranch:'main',expectedTargetHead:'0'.repeat(40)}],
      ['/api/runs',{requestId:randomUUID(),workspaceId:created.project.id,prompt:'Write report'}],
      [base+'/tasks/'+randomUUID()+'/run',{requestId:randomUUID(),workspaceId:randomUUID()}]
    ] as const){const result=await f.post(path,data);assert.equal(result.status,409,path);assert.deepEqual(await result.json(),{error:'GIT_REQUIRED'});}
    assert.deepEqual(f.projects.workspaces(),[]);assert.deepEqual(f.store.runs(),[]);assert.equal(f.nativeCalls(),0);
    assert.equal(readdirSync(created.project.path).includes('.git'),false);
    assert.deepEqual(readdirSync(join(f.dir,'workspaces')),[]);
  }finally{await f.close();}
});

test('general HTTP creation keeps strict optional kind and credential-name validation',async()=>{
  const f=await fixture();try{
    for(const extra of [{kind:null},{kind:'other'},{kind:1},{kind:'general',path:f.dir},{kind:'general',name:'credentials'},{kind:'general',command:'git init'}]){
      const response=await f.post('/api/projects/create',{requestId:randomUUID(),name:'Report',...extra});
      assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'INVALID_FIELDS'});
    }
    assert.deepEqual(f.store.projects(),[]);assert.deepEqual(f.store.workspaces(),[]);assert.deepEqual(readdirSync(join(f.dir,'projects')),[]);
  }finally{await f.close();}
});
