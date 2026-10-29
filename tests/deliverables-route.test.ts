import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,writeFileSync,mkdirSync,symlinkSync,linkSync,truncateSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import {MAX_DOWNLOAD} from '../server/deliverables.ts';
import {deliverableId} from '../server/deliverable-versions.ts';

/** Exercise the real HTTP handler without opening a listener in restricted sandboxes. */
test('socketless HTTP: session, Origin, CSRF, exact parameters and guarded download/history',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-route-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const {project}=projects.createProject({requestId:randomUUID(),name:'Files',kind:'general'});
  const {project:other}=projects.createProject({requestId:randomUUID(),name:'Other',kind:'general'});
  const controller=new Controller(store,dir,()=>{throw Error('NATIVE_FORBIDDEN');},projects),server=createHttpServer(controller,'unused');
  server.address=()=>({address:'127.0.0.1',family:'IPv4',port:12345});
  const origin='http://127.0.0.1:12345',base=`/api/projects/${project.id}/deliverables`;
  async function request(url:string,headers:Record<string,string>={},body?:object){
    return new Promise<{status:number;headers:Record<string,string>;bytes:Buffer}>(resolve=>{
      const req=Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{url,method:body?'POST':'GET',headers:{host:'127.0.0.1:12345',...headers}});
      const res={headersSent:false,status:200,headers:{} as Record<string,string>,setHeader(k:string,v:string){this.headers[k.toLowerCase()]=v;},writeHead(status:number,values:Record<string,string>){this.status=status;this.headersSent=true;for(const [k,v] of Object.entries(values))this.setHeader(k,v);},end(data=''){resolve({status:this.status,headers:this.headers,bytes:Buffer.from(data)});}};
      server.emit('request',req,res);
    });
  }
  try{
    writeFileSync(join(project.path,'result.txt'),'first');mkdirSync(join(project.path,'inputs'));writeFileSync(join(project.path,'inputs','source.txt'),'private input');
    const id=deliverableId(project.id,'result.txt'),path=base+'/'+id+'/download';
    assert.equal((await request(path)).status,401);
    const session=await request('/api/session'),cookie=session.headers['set-cookie'].split(';')[0],csrf=JSON.parse(session.bytes.toString()).csrfToken;
    const auth={cookie},post={cookie,origin,'content-type':'application/json','x-csrf-token':csrf};
    for(const headers of [{origin:'http://evil.invalid'},{'sec-fetch-site':'cross-site'},{referer:'http://evil.invalid/'},{host:'evil.invalid'}] as Record<string,string>[])assert.equal((await request(path,{...auth,...headers})).status,403);
    for(const suffix of ['?path=inputs/source.txt','?version=x&version=y'])assert.equal((await request(path+suffix,auth)).status,400);
    assert.equal((await request(base+'/result.txt/download',auth)).status,404);
    assert.equal((await request(base+'/'+deliverableId(project.id,'inputs/source.txt')+'/download',auth)).status,404);
    assert.equal((await request(`/api/projects/${other.id}/deliverables/${id}/download`,auth)).status,404);
    const file=await request(path,auth);assert.equal(file.status,200);assert.equal(file.bytes.toString(),'first');assert.equal(file.headers['content-disposition'],'attachment; filename="result.txt"');assert.equal(file.headers['x-content-type-options'],'nosniff');
    assert.equal((await request(base+'/observe',{...post,'x-csrf-token':'0'.repeat(64)},{})).status,403);
    assert.equal((await request(base+'/observe',post,{path:'result.txt'})).status,400);
    assert.equal((await request(base+'/observe?extra=1',post,{})).status,400);
    assert.equal((await request(base+'/observe',post,{})).status,200);
    const history=JSON.parse((await request(base+'/'+id+'/versions',auth)).bytes.toString());assert.equal(history.length,1);
    const version=base+'/'+id+'/versions/'+history[0].id+'/download';assert.equal((await request(version,auth)).status,200);
    writeFileSync(join(project.path,'result.txt'),'changed');assert.equal((await request(version,auth)).status,409);
    await request(base+'/observe',post,{});assert.equal(JSON.parse((await request(base+'/'+id+'/versions',auth)).bytes.toString()).length,2);
    const changes=store.db.prepare('SELECT total_changes() AS n').get()!.n;await request(path,auth);await request(base+'/'+id+'/versions',auth);assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
    symlinkSync(join(project.path,'inputs','source.txt'),join(project.path,'link.txt'));assert.equal((await request(base+'/'+deliverableId(project.id,'link.txt')+'/download',auth)).status,404);
    linkSync(join(project.path,'inputs','source.txt'),join(project.path,'hard.txt'));assert.equal((await request(base+'/'+deliverableId(project.id,'hard.txt')+'/download',auth)).status,404);
    writeFileSync(join(project.path,'large.bin'),'');truncateSync(join(project.path,'large.bin'),MAX_DOWNLOAD+1);assert.equal((await request(base+'/'+deliverableId(project.id,'large.bin')+'/download',auth)).status,413);
    assert.equal(store.runs().length,0);
  }finally{await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
