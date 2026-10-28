import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.ts';
import {AppError} from '../server/errors.ts';
import type {ClaudeTaskServiceOptions} from '../server/claude-task-service.ts';
import {claudeFixture,outcome,planningInput,session,tick} from './claude-task-fixture.ts';

async function fixture(options:ClaudeTaskServiceOptions={}){
  const f=claudeFixture(options),server=createHttpServer(f.controller,'.');
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){await f.close();throw error;}
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),cookie=response.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await response.json() as {csrfToken:string};
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const post=(path:string,data:object)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(data)});
  return {...f,origin,headers,post,path:(taskId:string)=>`/api/projects/${f.project.id}/tasks/${taskId}/run`,
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}};
}

test('HTTP general task uses requestId only, replays the same Run, refuses a second owner and routes interrupt to Claude',async()=>{
  const f=await fixture();try{
    const {task}=f.plan(),requestId=randomUUID(),path=f.path(task.id);
    const response=await f.post(path,{requestId});assert.equal(response.status,200);
    const run=await response.json() as {id:string;runtime:string;projectId:string};
    assert.equal(run.runtime,'claude-code');assert.equal(run.projectId,f.project.id);
    const replay=await f.post(path,{requestId});assert.equal(replay.status,200);assert.equal((await replay.json() as {id:string}).id,run.id);
    const second=await f.post(path,{requestId:randomUUID()});assert.equal(second.status,409);assert.deepEqual(await second.json(),{error:'RUN_ACTIVE'});
    f.runners[0].emit(session);
    assert.equal((await f.post(`/api/runs/${run.id}/interrupt`,{})).status,200);
    assert.equal(f.store.getRun(run.id)!.execution,'interrupting');assert.equal(f.runners[0].interrupts,1);
    f.runners[0].finish(outcome('interrupted'));await tick();assert.equal(f.store.getRun(run.id)!.execution,'interrupted');
    const count=f.store.runs().length,seq=f.store.lastSeq();
    await fetch(f.origin+'/api/state',{headers:f.headers});await fetch(f.origin+`/api/projects/${f.project.id}/tasks`,{headers:f.headers});
    assert.equal(f.store.runs().length,count);assert.equal(f.store.lastSeq(),seq);assert.equal(f.runners.length,1);
  }finally{await f.close();}
});

test('HTTP general dispatch preserves session/CSRF checks and rejects workspace, digest, prompt and path fields',async()=>{
  const f=await fixture();try{
    const {task}=f.plan(),path=f.path(task.id),request={requestId:randomUUID()};
    assert.equal((await fetch(f.origin+path,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify(request)})).status,401);
    assert.equal((await fetch(f.origin+path,{method:'POST',headers:{...f.headers,'X-CSRF-Token':''},body:JSON.stringify(request)})).status,403);
    // A workspace-bound request takes the code-project path and is refused before any Run (C1 contract).
    const workspaceBound=await f.post(path,{...request,workspaceId:randomUUID()});assert.equal(workspaceBound.status,409);assert.deepEqual(await workspaceBound.json(),{error:'GIT_REQUIRED'});
    for(const extra of [{expectedAcceptanceDigest:'a'.repeat(64)},{prompt:'override'},{cwd:f.dir},{path:f.dir}]){
      const response=await f.post(path,{...request,...extra});assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'INVALID_FIELDS'});
    }
    const invalid=await f.post(path,{requestId:'invalid_id'});assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'INVALID_REQUEST_ID'});
    assert.equal(f.runners.length,0);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('HTTP general dispatch rejects stale baseline and reports missing Claude before creating any Run',async()=>{
  const f=await fixture({findExecutable:()=>{throw new AppError('CLAUDE_NOT_INSTALLED',503);}});try{
    const {version,task}=f.plan(),path=f.path(task.id);
    const missing=await f.post(path,{requestId:randomUUID()});assert.equal(missing.status,503);assert.deepEqual(await missing.json(),{error:'CLAUDE_NOT_INSTALLED'});
    f.studio.mutate(f.project.id,'plans',version.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:planningInput});
    const stale=await f.post(path,{requestId:randomUUID()});assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'PLANNING_VERSION_STALE'});
    assert.equal(f.runners.length,0);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('HTTP code project still requires a workspace and validates the acceptance digest before dispatch',async()=>{
  const f=await fixture();try{
    const {project,workspace}=f.projects.createProject({requestId:randomUUID(),name:'Code project',kind:'code'});
    const path=`/api/projects/${project.id}/tasks/${randomUUID()}/run`,requestId=randomUUID();
    for(const data of [{requestId},{requestId,workspaceId:workspace!.id,expectedAcceptanceDigest:'invalid'},{requestId,workspaceId:workspace!.id,prompt:'override'}]){
      const response=await f.post(path,data);assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'INVALID_FIELDS'});
    }
    const response=await f.post(path,{requestId,workspaceId:workspace!.id});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'WORKSPACE_MISMATCH'});
    assert.equal(f.runners.length,0);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});
