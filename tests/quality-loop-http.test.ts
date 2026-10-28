import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';

test('quality HTTP requires session/CSRF, scopes reads and never dispatches on GET',async()=>{
 const store=new Store(':memory:');store.saveProject({id:'p',name:'Report',kind:'general',path:'unused',createdAt:'',writeEnabled:false});
 let starts=0,resumes=0;
 const qualityLoops={records:(projectId:string)=>[{projectId}],preview:(projectId:string,sourceRunId:string,reviewers:unknown,limits:unknown)=>({projectId,sourceRunId,reviewers,limits}),start:(value:unknown)=>{starts++;return value;},record:()=>({projectId:'other'}),resume:()=>{resumes++;}};
 const controller={store,qualityLoops} as unknown as Controller;
 const server=createHttpServer(controller,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,path='/api/projects/p/quality-loops';
 try{
  assert.equal((await fetch(origin+path)).status,401);
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json'};
  const seq=store.lastSeq();assert.deepEqual(await (await fetch(origin+path,{headers:{cookie}})).json(),{records:[{projectId:'p'}]});assert.equal(store.lastSeq(),seq);assert.equal(starts,0);
  assert.equal((await fetch(origin+path+'?start=1',{headers:{cookie}})).status,400);
  assert.equal((await fetch(origin+'/api/projects/absent/quality-loops',{headers:{cookie}})).status,404);
  assert.equal((await fetch(origin+path+'/start',{method:'POST',headers:{cookie},body:'{}'})).status,403);
  const input={sourceRunId:'source',reviewers:[],limits:{maxRepairs:1,maxCalls:3,timeoutMs:1000}};
  assert.equal((await fetch(origin+path+'/preview',{method:'POST',headers,body:JSON.stringify(input)})).status,200);
  assert.equal(starts,0);
  assert.equal((await fetch(origin+path+'/start',{method:'POST',headers,body:JSON.stringify({...input,requestId:'request1',expectedPreviewDigest:'a'.repeat(64),confirmed:true,producer:{modelId:'forged'}})})).status,400);
  assert.equal((await fetch(origin+path+'/start',{method:'POST',headers,body:JSON.stringify({...input,requestId:'request1',expectedPreviewDigest:'a'.repeat(64),confirmed:true})})).status,200);assert.equal(starts,1);
  assert.equal((await fetch(origin+path+'/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/resume',{method:'POST',headers,body:'{}'})).status,404);assert.equal(resumes,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
