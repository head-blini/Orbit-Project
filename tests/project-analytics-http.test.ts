import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import type {ProjectAnalytics} from '../shared/analytics.ts';

test('project analytics GET is authenticated, exact, readonly and usable disconnected without workspace access',async()=>{
  const store=new Store(':memory:');let factories=0;
  const controller=new Controller(store,'/never-read',()=>{factories++;throw new Error('NO_PROVIDER');});
  const projectId=randomUUID();store.saveProject({id:projectId,name:'Project',path:'/never-read',createdAt:new Date().toISOString(),writeEnabled:false});
  const server=createHttpServer(controller,'.');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,path=`/api/projects/${projectId}/analytics`;
  try{
    assert.equal((await fetch(origin+path)).status,401);
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
    const get=(query='')=>fetch(origin+path+query,{headers:{cookie}}),seq=store.lastSeq();
    const response=await get();assert.equal(response.status,200);const view=await response.json() as ProjectAnalytics;assert.equal(view.projectId,projectId);assert.equal(view.totals.records,0);assert.equal(view.totals.tokenSubtotal,null);
    assert.equal((await get('?limit=50')).status,200);
    for(const query of ['?limit=0','?limit=51','?limit=2.5','?limit=01','?limit=','?cursor=','?cursor=invalid','?limit=1&limit=2','?extra=1','?cursor=x&cursor=y'])assert.equal((await get(query)).status,400,query);
    assert.equal((await fetch(origin+path,{headers:{cookie,origin:'https://foreign.invalid'}})).status,403);
    assert.equal((await fetch(origin+path,{headers:{cookie,'sec-fetch-site':'cross-site'}})).status,403);
    assert.equal((await fetch(origin+`/api/projects/${randomUUID()}/analytics`,{headers:{cookie}})).status,404);
    for(const method of ['POST','PUT','DELETE'])assert.equal((await fetch(origin+path,{method,headers:{cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json'},body:'{}'})).status,404);
    assert.equal(factories,0);assert.equal(store.lastSeq(),seq);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();}
});
