import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { createHttpServer } from '../server/http.ts';
import type { Controller } from '../server/controller.ts';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(){
  const store=new Store(':memory:');let submissions=0;
  const controller={store,snapshot:()=>({provider:'disconnected',issue:null,threadId:null,workspace:'fixture',readOnly:true,runs:store.runs(),lastSeq:store.lastSeq()}),connect:async()=>{},submit:async(input:any)=>{submissions++;return {id:'r',...input};},interrupt:async()=>{}} as unknown as Controller;
  const assets=mkdtempSync(join(tmpdir(),'aicc-assets-'));writeFileSync(join(assets,'index.html'),'<!doctype html><title>Fixture</title>');
  const server=createHttpServer(controller,assets);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const response=await fetch(origin+'/api/session');const cookie=response.headers.get('set-cookie')!.split(';')[0];const {csrfToken}=await response.json() as any;
  return {origin,cookie,csrfToken,store,count:()=>submissions,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}};
}
test('loopback API requires session and rejects cross-origin, forged Host and CSRF before mutation',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+'/api/state')).status,401);
    assert.equal((await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie,Origin:'http://evil.test'}})).status,403);
    const forgedHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(f.origin+'/api/session',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    assert.equal(forgedHost,403);
    const base={method:'POST',headers:{cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json'},body:'{}'};
    assert.equal((await fetch(f.origin+'/api/connect',base)).status,403);
    assert.equal((await fetch(f.origin+'/api/connect',{...base,headers:{...base.headers,'X-CSRF-Token':f.csrfToken}})).status,200);
    assert.equal((await fetch(f.origin+'/api/runs',{...base,headers:{...base.headers,'X-CSRF-Token':f.csrfToken,Origin:'null'},body:'{"prompt":"x","requestId":"12345678"}'})).status,403);
    assert.equal(f.count(),0);
  }finally{await f.close();}
});
test('large SSE backlog drains in order without closing or crashing the server',async()=>{
  const f=await fixture();const abort=new AbortController();try{
    for(let i=0;i<100;i++)f.store.append('fixture.large',null,{text:'x'.repeat(4000)});
    const response=await fetch(f.origin+'/api/events?after=0',{headers:{cookie:f.cookie},signal:abort.signal});
    const reader=response.body!.getReader();let content='';
    while(!content.includes('id: 100\n')){const chunk=await reader.read();if(chunk.done)break;content+=new TextDecoder().decode(chunk.value);}
    assert.equal((content.match(/id: \d+\n/g)??[]).length,100);
    assert.equal((await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}})).status,200);
  }finally{abort.abort();await f.close();}
});
test('unknown path/CLI override keys and oversized body are rejected',async()=>{
  const f=await fixture();try{
    const headers={cookie:f.cookie,Origin:f.origin,'Content-Type':'application/json','X-CSRF-Token':f.csrfToken};
    for(const body of [JSON.stringify({prompt:'hi',requestId:'12345678',cwd:'C:/'}),'null','['.repeat(20000)]){
      const r=await fetch(f.origin+'/api/runs',{method:'POST',headers,body});assert.ok([400,413].includes(r.status));
    }
    assert.equal(f.count(),0);
  }finally{await f.close();}
});
test('state reload does not start a turn; SSE replays only events after cursor',async()=>{
  const f=await fixture();try{
    const first=f.store.append('fixture.first',null,{});f.store.append('fixture.second',null,{});
    await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}});await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}});assert.equal(f.count(),0);
    const abort=new AbortController();
    const r=await fetch(f.origin+'/api/events?after='+first.seq,{headers:{cookie:f.cookie},signal:abort.signal});
    const reader=r.body!.getReader();const text=new TextDecoder().decode((await reader.read()).value);
    assert.ok(text.includes('fixture.second'));assert.equal(text.includes('fixture.first'),false);abort.abort();
  }finally{await f.close();}
});
test('top-level navigation may arrive from another site, but cross-site API reads are rejected',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+'/',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,200);
    assert.equal((await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
  }finally{await f.close();}
});
