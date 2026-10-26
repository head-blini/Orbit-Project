import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-app-preview-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(join(root,'index.html'),'<!doctype html><h1>Actual workspace bytes</h1>');writeFileSync(join(root,'.gitignore'),'dist/\n');
  git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(join(dir,'test.sqlite')),projects=new Projects(store,join(dir,'managed'),[root]);
  const project=projects.register(root),workspace=projects.create(project.id),other=projects.create(project.id);let native=0;
  const controller=new Controller(store,createWorkspace(dir),()=>{native++;throw Error('NO_NATIVE_ALLOWED');},projects);await controller.selectWorkspace(workspace.id);
  writeFileSync(join(dir,'index.html'),'<!doctype html><html><head><title>fixture</title></head><body></body></html>');
  const server=createHttpServer(controller,dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),{csrfToken}=await response.json() as any;
  const headers={Cookie:response.headers.get('set-cookie')!.split(';')[0],Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const base='/api/workspaces/'+workspace.id+'/result';
  const run=store.createRun(randomUUID(),'fixture','PRIVATE_PROMPT_NOT_IN_RESULT',workspace.id);store.updateRun(run.id,{execution:'completed',response:'PRIVATE_RESPONSE_NOT_IN_RESULT'},'run.completed');
  const foreign=store.createRun(randomUUID(),'fixture-other','foreign',other.id);store.updateRun(foreign.id,{execution:'completed'},'run.completed');
  return {origin,base,workspace,other,run,foreign,store,controller,get native(){return native;},
    get:(path=base,custom=headers)=>fetch(origin+path,{headers:custom}),
    post:(body:object,path=base,custom=headers)=>fetch(origin+path,{method:'POST',headers:custom,body:JSON.stringify(body)}),
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();}};
}
test('result endpoint is authenticated, strictly scoped and does not execute or leak Run content',async()=>{
 const f=await fixture();try{
  assert.equal((await f.get(f.base,{} as any)).status,401);
  assert.equal((await f.get(f.base+'?unknown=1')).status,400);
  assert.equal((await f.get(f.base+'?runId='+f.run.id+'&runId='+f.run.id)).status,400);
  assert.equal((await f.get(f.base+'?runId=bad')).status,400);
  assert.equal((await f.get(f.base+'?runId='+f.foreign.id)).status,404);
  assert.equal((await f.get('/api/workspaces/'+f.other.id+'/result')).status,409);
  const before=f.store.lastSeq(),response=await f.get(f.base+'?runId='+f.run.id);assert.equal(response.status,200);
  const result=await response.json() as any;assert.equal(result.run.id,f.run.id);assert.equal(result.workspaceId,f.workspace.id);assert.equal(result.verification.canApprove,false);
  assert.equal(result.verification.commands.length,0);assert.ok(result.sourceDigest);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROMPT|PRIVATE_RESPONSE/);
  assert.equal(f.store.lastSeq(),before);assert.equal(f.native,0);assert.equal(f.store.runs().length,2);
  const none=await f.get();assert.equal(none.status,200);assert.equal((await none.json() as any).run,null);
 }finally{await f.close();}
});
