import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.ts';
import {generalPlanningFixture} from './general-planning-fixture.ts';

async function fixture(){
  const f=generalPlanningFixture(),server=createHttpServer(f.controller,'.');
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){await f.close();throw error;}
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),cookie=response.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await response.json() as {csrfToken:string};
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  return {...f,origin,headers,base:`/api/projects/${f.project.id}`,
    get:(path:string)=>fetch(origin+path,{headers}),post:(path:string,data:object)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(data)}),
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}};
}
test('HTTP AI preferences GET/POST enforce CSRF, CAS, validation and inert defaults',async()=>{
  const f=await fixture();try{
    const path=f.base+'/ai-preferences',seq=f.store.lastSeq();
    const get=await f.get(path);assert.equal(get.status,200);assert.deepEqual(await get.json(),{planning:'claude-code',execution:'claude-code',revision:0,updatedAt:null});
    assert.equal(f.store.lastSeq(),seq);
    // A general project can only store what it can run; a Codex planner or executor needs Git.
    for(const bad of [{expectedRevision:0,planning:'codex',execution:'claude-code'},{expectedRevision:0,planning:'codex',execution:'codex'}])assert.deepEqual(await (await f.post(path,bad)).json(),{error:'GIT_REQUIRED'});
    // CAS and validation are exercised on a code project, where switching the planner is real.
    const code=f.projects.createProject({requestId:randomUUID(),name:'Code',kind:'code'}).project,codePath=`/api/projects/${code.id}/ai-preferences`;
    const input={expectedRevision:0,planning:'claude-code',execution:'codex'};
    assert.equal((await fetch(f.origin+codePath,{method:'POST',headers:{...f.headers,'X-CSRF-Token':''},body:JSON.stringify(input)})).status,403);
    const changed=await f.post(codePath,input);assert.equal(changed.status,200);const saved=await changed.json() as any;assert.equal(saved.revision,1);assert.ok(saved.updatedAt);
    assert.equal((await f.post(codePath,input)).status,409);
    assert.deepEqual(await (await f.post(codePath,{...input,expectedRevision:1})).json(),saved);
    assert.deepEqual(await (await f.post(codePath,{expectedRevision:1,planning:'codex',execution:'claude-code'})).json(),{error:'RUNTIME_NOT_SUPPORTED'});
    assert.equal((await f.post(codePath,{...input,planning:'unknown'})).status,400);
    assert.equal((await f.get(path+'?extra=1')).status,400);assert.equal((await f.post(path+'?extra=1',input)).status,400);
    assert.equal((await f.get(`/api/projects/${randomUUID()}/ai-preferences`)).status,404);
    assert.equal(f.runners.length,0);assert.equal(f.nativeCalls,0);assert.deepEqual(f.store.runs(),[]);
  }finally{await f.close();}
});
test('HTTP general planning permits omitted/null workspace and creates a draft only after explicit save',async()=>{
  const f=await fixture();try{
    const path=f.base+'/planning-suggestions';
    const view=await f.get(path);assert.equal(view.status,200);assert.equal((await view.json() as any).workspaceId,null);
    const preview=await f.post(path+'/preview',{text:f.text});assert.equal(preview.status,200);const value=await preview.json() as any;assert.equal(value.runtime,'claude-code');
    const input={requestId:randomUUID(),workspaceId:null,text:f.text,confirmed:true,expectedPreviewDigest:value.previewDigest};
    assert.equal((await fetch(f.origin+path+'/start',{method:'POST',headers:{...f.headers,'X-CSRF-Token':''},body:JSON.stringify(input)})).status,403);
    assert.equal((await f.post(path+'/start',{...input,confirmed:false})).status,409);
    const started=await f.post(path+'/start',input);assert.equal(started.status,200);const record=await started.json() as any;
    assert.equal((await (await f.post(path+'/start',input)).json() as any).id,record.id);
    await f.complete();assert.deepEqual(f.studio.read(f.project.id,'plans'),[]);
    const complete=f.service.record(record.id);const saved=await f.post(path+'/'+record.id+'/save',{expectedOutputDigest:complete.outputDigest});
    assert.equal(saved.status,200);assert.equal((await saved.json() as any).state,'draft');
    assert.equal((await f.get(path+'?workspaceId='+randomUUID())).status,409);
    assert.equal((await f.post(path+'/preview',{text:f.text,workspaceId:randomUUID()})).status,409);
    assert.equal((await f.post(path+'/preview',{text:f.text,cwd:f.dir})).status,400);
    assert.deepEqual(f.store.runs(),[]);assert.equal(f.nativeCalls,0);
  }finally{await f.close();}
});
