import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import type {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
test('policy GET requires local session and exposes no execution or trusted-facts input route',async()=>{
  const store=new Store(':memory:');let sideEffects=0;
  const controller={store,snapshot:()=>({provider:'ready'}),connect:async()=>{sideEffects++;},submit:async()=>{sideEffects++;}} as unknown as Controller;
  const server=createHttpServer(controller,'unused',{nativeProbe:{get:()=>{sideEffects++;return null;},refresh:async()=>{throw new Error('MUST_NOT_PROBE');}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    assert.equal((await fetch(origin+'/api/control-plane')).status,401);
    const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as {csrfToken:string};
    const seq=store.lastSeq();
    for(let i=0;i<2;i++){const response=await fetch(origin+'/api/control-plane',{headers:{cookie}});assert.equal(response.status,200);assert.equal((await response.json() as any).levels.autonomous,'disabled');}
    assert.equal((await fetch(origin+'/api/control-plane?safety=qualified',{headers:{cookie}})).status,400);
    assert.equal((await fetch(origin+'/api/control-plane',{headers:{cookie,Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await fetch(origin+'/api/control-plane',{method:'POST',headers:{cookie,Origin:origin,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:'{"autonomous":true}'})).status,404);
    assert.equal(sideEffects,0);assert.equal(store.lastSeq(),seq);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
