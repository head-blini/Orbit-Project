import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from './temp.ts';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
import { Controller } from '../server/controller.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-source-http-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe',windowsHide:true});
  git('init','-q','-b','main');writeFileSync(join(root,'lib.ts'),'export function greet(){return "before";}');
  writeFileSync(join(root,'main.ts'),'import {greet} from "./lib"; export function main(){return greet();}');
  git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  let store=new Store(join(dir,'test.sqlite')),projects=new Projects(store,join(dir,'managed'),[root]);
  const project=projects.register(root),workspace=projects.create(project.id);
  const create=()=>new Controller(store,createWorkspace(dir),()=>{throw new Error('AI_DISABLED_IN_FIXTURE');},projects);
  let controller=create();await controller.selectWorkspace(workspace.id);
  let server=createHttpServer(controller,dir),origin='',headers:Record<string,string>={};
  async function listen(){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const response=await fetch(origin+'/api/session'),{csrfToken}=await response.json() as any;
    headers={Cookie:response.headers.get('set-cookie')!.split(';')[0],Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};}
  await listen();
  const base='/api/workspaces/'+workspace.id+'/source-graph';
  const post=(path:string,body:object,overrides:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});
  const get=(path=base)=>fetch(origin+path,{headers:{Cookie:headers.Cookie}});
  async function stop(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();}
  return {root,workspace,project,base,post,get,get store(){return store;},get controller(){return controller;},close:stop,
    restart:async()=>{await stop();store=new Store(join(dir,'test.sqlite'));projects=new Projects(store,join(dir,'managed'),[root]);controller=create();server=createHttpServer(controller,dir);await listen();}};
}

test('source graph HTTP derives real files, exports a bound artifact, and retains stale evidence across restart',async()=>{
  const f=await fixture();try{
    assert.equal((await (await f.get()).json() as any).freshness,'missing');
    writeFileSync(join(f.workspace.path,'lib.ts'),'export function greet(){return "after";}');
    const response=await f.post(f.base,{});assert.equal(response.status,200);
    const view=await response.json() as any,record=view.record;
    assert.equal(view.freshness,'current');assert.equal(record.graph.coverage.files,2);
    assert.ok(record.graph.edges.some((edge:any)=>edge.kind==='calls'));
    assert.ok(record.graph.impact.fileIds.length>=2);
    assert.equal((await (await f.post(f.base,{})).json() as any).record.id,record.id);
    const main=record.graph.nodes.find((node:any)=>node.kind==='file'&&node.path==='main.ts');
    const source=await f.get(f.base+'/files/'+main.id+'?recordId='+record.id);
    assert.equal(source.status,200);assert.match((await source.json() as any).text,/return greet/);
    const request={requestId:randomUUID(),recordId:record.id,expectedSourceDigest:record.graph.sourceDigest};
    const artifactResponse=await f.post(f.base+'/artifact',request);assert.equal(artifactResponse.status,200);
    const artifact=await artifactResponse.json() as any;
    assert.equal(artifact.kind,'architecture');assert.equal(artifact.metadata.source_digest,record.graph.sourceDigest);
    const statusPath='/api/projects/'+f.project.id+'/artifacts/'+artifact.id+'/source-status?revision=1&hash='+artifact.contentHash;
    assert.equal((await (await f.get(statusPath)).json() as any).freshness,'current');
    assert.equal((await (await f.post(f.base+'/artifact',request)).json() as any).id,artifact.id);
    const editedDiagram=JSON.parse(artifact.source);editedDiagram.nodes[0].label='Manually edited';
    const revisedResponse=await f.post('/api/projects/'+f.project.id+'/artifacts/'+artifact.id+'/revisions',{requestId:randomUUID(),expectedRevision:1,input:{kind:'architecture',source:JSON.stringify(editedDiagram),metadata:artifact.metadata}});
    assert.equal(revisedResponse.status,200);const revised=await revisedResponse.json() as any;
    assert.equal((await (await f.get('/api/projects/'+f.project.id+'/artifacts/'+artifact.id+'/source-status?revision=2&hash='+revised.contentHash)).json() as any).freshness,'unverified','copied provenance must not certify manually edited source');
    const download=await f.get('/api/projects/'+f.project.id+'/artifacts/'+artifact.id+'/export?revision=1&hash='+artifact.contentHash+'&format=pptx');
    assert.equal(download.status,200);assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0,2).toString(),'PK');
    writeFileSync(join(f.workspace.path,'lib.ts'),'export function greet(){return "newer";}');
    assert.equal((await (await f.get()).json() as any).freshness,'stale');
    assert.equal((await (await f.get(statusPath)).json() as any).freshness,'stale');
    assert.equal((await f.post(f.base+'/artifact',{...request,requestId:randomUUID()})).status,409);
    assert.equal((await f.get(f.base+'/files/'+main.id+'?recordId='+record.id)).status,409);
    await f.restart();const restored=await (await f.get()).json() as any;
    assert.equal(restored.record.id,record.id);assert.equal(restored.freshness,'stale');
    assert.equal(readFileSync(join(f.root,'lib.ts'),'utf8'),'export function greet(){return "before";}');
  }finally{await f.close();}
});

test('source graph HTTP keeps path and execution boundaries, hides credentials, and rejects unsupported source',async()=>{
  const f=await fixture();try{
    assert.equal((await f.post(f.base,{}, {'X-CSRF-Token':'0'.repeat(64)})).status,403);
    assert.equal((await f.post(f.base,{path:f.root})).status,400);
    assert.equal((await f.get(f.base+'?path=../../auth.json')).status,400);
    const run=f.store.createRun(randomUUID(),'fixture','synthetic active',f.workspace.id);
    assert.equal((await f.post(f.base,{})).status,409);f.store.updateRun(run.id,{execution:'completed'},'run.completed');
    const secret='sk-'+'SYNTHETIC_TEST_ONLY_'.repeat(3);
    writeFileSync(join(f.workspace.path,'lib.ts'),'export function greet(){const api_key="'+secret+'";return "after";}');
    const response=await f.post(f.base,{});assert.equal(response.status,200);const view=await response.json() as any;
    assert.ok(!JSON.stringify(view).includes(secret));
    const file=view.record.graph.nodes.find((node:any)=>node.kind==='file'&&node.path==='lib.ts');
    const code=await (await f.get(f.base+'/files/'+file.id+'?recordId='+view.record.id)).json() as any;
    assert.ok(!code.text.includes(secret));assert.equal(code.redacted,true);
    assert.equal((await f.get(f.base+'/files/'+file.id+'?recordId='+randomUUID())).status,404);
    writeFileSync(join(f.workspace.path,secret+'.ts'),'export function redactedPath(){return "correct file";}');
    const masked=await (await f.post(f.base,{})).json() as any;
    const maskedFile=masked.record.graph.nodes.find((node:any)=>node.kind==='file'&&!['lib.ts','main.ts'].includes(node.path));
    assert.ok(maskedFile&&!maskedFile.path.includes(secret));
    const maskedSource=await f.get(f.base+'/files/'+maskedFile.id+'?recordId='+masked.record.id);
    assert.equal(maskedSource.status,200);assert.match((await maskedSource.json() as any).text,/correct file/);
    writeFileSync(join(f.workspace.path,'lib.ts'),'/* '+'sk- '.repeat(15000)+'*/\nexport const visible = true;');
    const expanded=await (await f.post(f.base,{})).json() as any;
    const expandedFile=expanded.record.graph.nodes.find((node:any)=>node.kind==='file'&&node.path==='lib.ts');
    const expandedSource=await (await f.get(f.base+'/files/'+expandedFile.id+'?recordId='+expanded.record.id)).json() as any;
    assert.equal(expandedSource.truncated,true);assert.equal(expandedSource.text.length,64000);
    writeFileSync(join(f.workspace.path,'.env'),'SYNTHETIC_MUST_NOT_READ');
    assert.equal((await f.post(f.base,{})).status,409);
    const denied=await (await f.get()).json() as any;assert.equal(denied.freshness,'unavailable');assert.equal(denied.currentSourceDigest,null);
    assert.ok(!JSON.stringify(f.store.eventsAfter(0)).includes(secret));
  }finally{await f.close();}
});
