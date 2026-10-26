import test from 'node:test';
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
  const base='/api/workspaces/'+workspace.id+'/app-preview';
  return {origin,base,workspace,other,store,controller,get native(){return native;},
    get:(path=base,custom=headers)=>fetch(origin+path,{headers:custom}),
    post:(body:object,path=base,custom=headers)=>fetch(origin+path,{method:'POST',headers:custom,body:JSON.stringify(body)}),
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();}};
}
test('authenticated preview API uses selected real workspace and does not dispatch native work',async()=>{
  const f=await fixture();try{
    const response=await f.get();assert.equal(response.status,200);const catalog=await response.json() as any;
    assert.deepEqual(catalog.entries,['index.html']);
    const input={entryPath:'index.html',expectedSourceDigest:catalog.sourceDigest},created=await f.post(input);assert.equal(created.status,200);
    const preview=await created.json() as any;assert.equal(preview.workspaceId,f.workspace.id);
    const page=await fetch(preview.url,{headers:{'Sec-Fetch-Dest':'iframe'}});assert.equal(page.status,200);assert.match(await page.text(),/Actual workspace bytes/);
    const csp=response.headers.get('content-security-policy')!;
    assert.ok(csp.includes('frame-src '+new URL(preview.url).origin));assert.ok(csp.includes("script-src 'self'"));assert.ok(!csp.includes('unsafe-inline'));
    assert.ok((await (await f.get('/')).text()).includes('<meta name="orbit-preview-origin" content="'+new URL(preview.url).origin+'">'));
    writeFileSync(join(f.workspace.path,'index.html'),'CHANGED');assert.equal((await f.post(input)).status,409);
    mkdirSync(join(f.workspace.path,'dist'));writeFileSync(join(f.workspace.path,'dist','index.html'),'ignored');
    assert.deepEqual((await (await f.get()).json() as any).entries,['index.html']);
    const latest=await (await f.get()).json() as any;
    assert.equal((await f.post({...input,expectedSourceDigest:latest.sourceDigest,entryPath:'dist/index.html'})).status,422);
    writeFileSync(join(f.workspace.path,'.env'),'SYNTHETIC_MUST_NOT_READ');assert.equal((await f.get()).status,409);
    assert.equal(f.native,0);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});
test('preview API rejects auth, CSRF, unexpected fields/query and other workspace',async()=>{
  const f=await fixture();try{
    assert.equal((await f.get(f.base,{} as any)).status,401);
    const catalog=await (await f.get()).json() as any,input={entryPath:'index.html',expectedSourceDigest:catalog.sourceDigest};
    assert.equal((await f.post(input,f.base,{} as any)).status,401);
    assert.equal((await f.post({...input,command:'npm run dev'})).status,400);
    assert.equal((await f.post(input,f.base+'?extra=1')).status,400);
    assert.equal((await f.get(f.base+'?extra=1')).status,400);
    assert.equal((await f.get('/api/workspaces/'+f.other.id+'/app-preview')).status,409);
    // Same cookie with missing CSRF and hostile Origin are separate boundaries.
    const session=await fetch(f.origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0];
    const missing={Cookie:cookie,Origin:f.origin,'Content-Type':'application/json'};
    assert.equal((await f.post(input,f.base,missing as any)).status,403);
    assert.equal((await f.post(input,f.base,{...missing,Origin:'http://evil.invalid'} as any)).status,403);
    assert.equal(f.native,0);
  }finally{await f.close();}
});
