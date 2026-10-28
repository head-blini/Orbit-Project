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
