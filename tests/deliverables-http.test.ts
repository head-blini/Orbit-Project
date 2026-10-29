import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import type {DeliverableList} from '../shared/deliverables.ts';

test('deliverables HTTP lists and previews only the general project folder, read-only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-deliverables-http-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const general=projects.createProject({requestId:randomUUID(),name:'Report',kind:'general'}).project;
  const code=projects.createProject({requestId:randomUUID(),name:'App',kind:'code'}).project;
  writeFileSync(join(general.path,'summary.md'),'# Summary\n');writeFileSync(join(general.path,'.env'),'SECRET=1');
  const controller=new Controller(store,dir,()=>{throw new Error('NATIVE_FORBIDDEN');},projects);
  const server=createHttpServer(controller,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,base=`/api/projects/${general.id}/deliverables`;
  try{
    assert.equal((await fetch(origin+base)).status,401);
    const cookie=(await fetch(origin+'/api/session')).headers.get('set-cookie')!.split(';')[0],get=(path:string)=>fetch(origin+path,{headers:{cookie}});
    const seq=store.lastSeq();
    const list=await (await get(base)).json() as DeliverableList;
    assert.deepEqual(list.items.map(i=>i.path),['README.md','summary.md']);assert.equal(list.skipped,1);
    const preview=await (await get(base+'/preview?path=summary.md')).json() as {kind:string;text:string};
    assert.equal(preview.kind,'text');assert.equal(preview.text,'# Summary\n');
    assert.equal((await get(base+'/preview?path=..%2Fstate.sqlite')).status,400);
    assert.equal((await get(base+'/preview?path=.env')).status,400);
    assert.equal((await get(base+'?run=1')).status,400);assert.equal((await get(base+'/preview?path=a.md&x=1')).status,400);
    assert.equal((await get(`/api/projects/${code.id}/deliverables`)).status,409);
    assert.equal((await get(`/api/projects/${randomUUID()}/deliverables`)).status,404);
    assert.equal(store.lastSeq(),seq,'reads append no events');assert.deepEqual(store.runs(),[]);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('download authentication, origin, exact IDs, attachment headers, history and explicit observation CSRF',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-download-http-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const {project}=projects.createProject({requestId:randomUUID(),name:'Download',kind:'general'});
  writeFileSync(join(project.path,'result.html'),'<script>inert</script>');
  const controller=new Controller(store,dir,()=>{throw Error('NATIVE_FORBIDDEN');},projects);
  const server=createHttpServer(controller,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,base=`/api/projects/${project.id}/deliverables`;
  try{
    const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
    const get=(path:string,extra:Record<string,string>={})=>fetch(origin+path,{headers:{cookie,...extra}});
    const post=(body:object,csrf=csrfToken,suffix='')=>fetch(origin+base+'/observe'+suffix,{method:'POST',headers:{cookie,Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const list=await (await get(base)).json() as DeliverableList,id=list.items.find(i=>i.path==='result.html')!.id!,download=base+'/'+id+'/download';
    assert.equal((await fetch(origin+download)).status,401);
    assert.equal((await get(download,{Origin:'http://evil.invalid'})).status,403);
    assert.equal((await get(download,{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await get(download,{'Referer':'http://evil.invalid/'})).status,403);
    assert.equal((await get(download+'?path=inputs/source.txt')).status,400);
    assert.equal((await get(base+'/result.html/download')).status,404);
    assert.equal((await get(base+'/'+'0'.repeat(64)+'/download')).status,404);
    const response=await get(download);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'),'attachment; filename="result.html"');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(await response.text(),'<script>inert</script>');
    assert.equal((await post({},'0'.repeat(64))).status,403);assert.equal((await post({path:'result.html'})).status,400);assert.equal((await post({},csrfToken,'?x=1')).status,400);
    assert.equal((await post({})).status,200);
    const history=await (await get(base+'/'+id+'/versions')).json() as {id:string;available:boolean}[];assert.equal(history.length,1);assert.equal(history[0].available,undefined,'byte availability is checked only at download');
    const old=base+'/'+id+'/versions/'+history[0].id+'/download';assert.equal((await get(old)).status,200);
    writeFileSync(join(project.path,'result.html'),'changed');assert.equal((await get(old)).status,409);
    assert.equal((await post({})).status,200);assert.equal(((await (await get(base+'/'+id+'/versions')).json()) as unknown[]).length,2);
    const changes=store.db.prepare('SELECT total_changes() AS n').get()!.n;await get(base);await get(download);await get(base+'/'+id+'/versions');
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.equal(store.runs().length,0);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
