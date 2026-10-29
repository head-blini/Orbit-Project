import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import type {FailureIndexView} from '../shared/failure-intelligence.ts';

const at='2026-10-29T01:02:03.000Z',hash='a'.repeat(64),P='project-1',SECRET='sk-ant-api03-PLANTEDSECRETvalue000000000000';
async function setup(){
  const store=new Store(':memory:'),db=store.db;
  db.exec('CREATE TABLE verification_checks(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)');
  store.saveProject({id:P,name:'P',path:'/never-read',createdAt:at,writeEnabled:false});
  const check=(id:string,evidenceSource:string)=>db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(id,'r-'+id,JSON.stringify({id,projectId:P,taskId:'t',
    commandId:'unit',execution:'completed',verdict:'failed',output:SECRET,evidenceSource,createdAt:at,completedAt:at,planningContentHash:hash}));
  check('c1','local');check('c2','local');check('c3','mock');
  const controller=new Controller(store,'/never-read',()=>{throw new Error('NO_PROVIDER');});
  const server=createHttpServer(controller,'.');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const post=(path:string,body:object,headers:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();};
  return {store,origin,cookie,post,close,get:(path:string)=>fetch(origin+path,{headers:{cookie}})};
}

test('failure index GET is authenticated, exact, read-only, splits mock and leaks nothing',async()=>{
  const t=await setup();
  try{
    const path=`/api/projects/${P}/failure-index`;
    assert.equal((await fetch(t.origin+path)).status,401);
    const changes=(t.store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,seq=t.store.lastSeq();
    const response=await t.get(path),text=await response.text();assert.equal(response.status,200);
    const view=JSON.parse(text) as FailureIndexView;
    assert.equal(view.projectId,P);assert.equal(view.families.length,1);
    assert.equal(view.families[0].realCount,2);assert.equal(view.families[0].mockCount,1);assert.equal(view.families[0].category,'unknown');assert.equal(view.families[0].commandIdOrGate,'unit');
    assert.equal(view.families[0].realFailureIds.length,2);assert.deepEqual(view.cases,[]);
    assert.ok(!text.includes(SECRET)&&!text.includes('model_mistake'));
    assert.equal((await t.get(path+'?x=1')).status,400);
    assert.equal((await t.get('/api/projects/nope/failure-index')).status,404);
    assert.equal((t.store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes);assert.equal(t.store.lastSeq(),seq);
    assert.equal(t.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='failure_cases'").get(),undefined);
  }finally{await t.close();}
});

test('failure case create/delete need CSRF, exact fields, confirmation; create is idempotent and project-scoped',async()=>{
  const t=await setup();
  try{
    const base=`/api/projects/${P}/failure-cases`,id=((await (await t.get(`/api/projects/${P}/failure-index`)).json()) as FailureIndexView).families[0].realFailureIds[0];
    const body={requestId:'11111111-2222-3333-4444-555555555555',failureId:id,confirmed:true};
    assert.equal((await t.post(base,body,{'x-csrf-token':'0'.repeat(64)})).status,403);
    assert.equal((await t.post(base,{...body,extra:1})).status,400);
    assert.equal((await t.post(base,{...body,confirmed:false})).status,400);
    assert.equal((await t.post(base,{...body,failureId:'check:check:missing'})).status,404);
    assert.equal((await t.post('/api/projects/nope/failure-cases',body)).status,404);
    const first=await t.post(base,body),created=await first.json() as {id:string};assert.equal(first.status,200);
    assert.equal(((await (await t.post(base,body)).json()) as {id:string}).id,created.id);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM failure_cases').get()!.n,1);
    assert.equal((await t.post(base,{...body,failureId:'check:check:c2'})).status,409);
    const view=await (await t.get(`/api/projects/${P}/failure-index`)).json() as FailureIndexView;assert.equal(view.cases.length,1);assert.equal(view.cases[0].id,created.id);
    assert.equal((await t.post(`${base}/${created.id}/delete`,{confirmed:false})).status,400);
    assert.equal((await t.post(`${base}/nope/delete`,{confirmed:true})).status,404);
    assert.equal((await t.post(`${base}/${created.id}/delete`,{confirmed:true})).status,200);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM failure_cases').get()!.n,0);
  }finally{await t.close();}
});
