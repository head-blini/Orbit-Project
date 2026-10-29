import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.ts';
import {claudeFixture} from './claude-task-fixture.ts';

async function fixture(){
  const f=claudeFixture(),server=createHttpServer(f.controller,'.');
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){await f.close();throw error;}
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),cookie=response.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await response.json() as {csrfToken:string};
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const get=(path:string)=>fetch(origin+path,{headers});
  const post=(path:string,data:object,extra:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  return {...f,get,post,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}};
}

test('HTTP registry: CSRF, create disabled, local check bound to revision, server-mapped project, disable, no credential echo',async()=>{
  const f=await fixture();try{
    const provider={id:'user-api',kind:'provider',label:'User API',connection:{adapterId:'local',endpoint:'http://127.0.0.1:8080/v1',locality:'loopback',auth:{kind:'none'},projectPaths:[f.project.path],timeoutMs:1000,maxOutputTokens:100}};
    assert.equal((await f.post('/api/registry/entries',provider,{'X-CSRF-Token':''})).status,403);
    const created=await f.post('/api/registry/entries',provider);assert.equal(created.status,200);
    assert.equal((await created.json() as {enabled:boolean}).enabled,false,'user entries are saved disabled');
    const secret=await f.post('/api/registry/entries',{...provider,id:'leak',label:'sk-abcdefghijklmnopqrstuvwxyz012345'});
    assert.equal(secret.status,400);assert.doesNotMatch(await secret.text(),/sk-abcdef/,'secret-like input is not reflected');
    const list=await (await f.get('/api/registry')).json() as {entries:{id:string;origin:string;configDigest:string;revision:number}[]};
    const row=list.entries.find(entry=>entry.id==='user-api')!;assert.equal(row.origin,'user');
    assert.ok(list.entries.some(entry=>entry.origin==='builtin'),'native runtimes are projected read-only');
    const builtin=list.entries.find(entry=>entry.origin==='builtin')!;
    assert.equal((await f.post(`/api/registry/entries/${builtin.id}/disable`,{expectedRevision:builtin.revision})).status>=400,true,'builtin is read-only');
    const local=await f.post('/api/registry/entries/user-api/validate',{requestId:randomUUID(),kind:'local',expectedRevision:row.revision,expectedConfigDigest:row.configDigest});
    assert.equal(local.status,200);
    const stale=await f.post('/api/registry/entries/user-api/validate',{requestId:randomUUID(),kind:'local',expectedRevision:row.revision+1,expectedConfigDigest:row.configDigest});
    assert.equal(stale.status>=400,true,'stale revision refused');
    // A client-chosen path is never accepted; only a known project id is mapped by the server.
    const pathSmuggle=await f.post('/api/registry/entries/user-api/validate',{requestId:randomUUID(),kind:'connection',confirmed:true,projectPath:'/etc',expectedRevision:row.revision,expectedConfigDigest:row.configDigest});
    assert.equal(pathSmuggle.status,404);
    assert.equal((await f.post('/api/registry/entries/user-api/validate',{requestId:randomUUID(),kind:'local',projectId:f.project.id,expectedRevision:row.revision,expectedConfigDigest:row.configDigest})).status,400);
    const detail=await (await f.get('/api/registry/entries/user-api')).json() as {entry:{id:string};validations:unknown[]};
    assert.equal(detail.entry.id,'user-api');assert.equal(detail.validations.length,1);
    const seq=f.store.lastSeq();await f.get('/api/registry');await f.get('/api/registry/entries/user-api');assert.equal(f.store.lastSeq(),seq,'GET is read-only');
    assert.equal((await f.post('/api/registry/entries/user-api/disable',{expectedRevision:row.revision})).status,200);
    assert.equal((await f.get('/api/registry?x=1')).status,400);
  }finally{await f.close();}
});
