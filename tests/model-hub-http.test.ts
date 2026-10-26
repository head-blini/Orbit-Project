import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from './temp.ts';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { Controller } from '../server/controller.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';
import { readModelHubConfiguration } from '../server/providers/model-hub-configuration.ts';

test('Model Hub HTTP requires exact consent and CSRF, then returns actual local text and unknown cost',async()=>{
  let network=0,hang=false;
  const mock=createServer((req,res)=>{network++;if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"data":[{"id":"fixture-model"}]}');}
    else{res.writeHead(200,{'Content-Type':'text/event-stream'});if(hang){res.write('data: {"choices":[{"delta":{"content":"Waiting"}}]}\n\n');return;}res.end('data: {"choices":[{"delta":{"content":"Actual HTTP fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}});
  await new Promise<void>(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(tmpdir(),'orbit-model-http-')),path=join(dir,'project');mkdirSync(path);
  const store=new Store(join(dir,'test.sqlite')),project={id:randomUUID(),name:'Fixture',path,createdAt:new Date().toISOString(),writeEnabled:false};store.saveProject(project);
  const config=readModelHubConfiguration(JSON.stringify([{id:'fixture',label:'Fixture',providerId:'local',endpoint:'http://127.0.0.1:'+(mock.address() as {port:number}).port+'/v1',locality:'loopback',enabled:true,projectPaths:[path],models:['fixture-model'],requireCredential:false,credentialEnv:null,timeoutMs:2000,maxOutputTokens:8}]));
  const controller=new Controller(store,createWorkspace(dir),()=>{throw new Error('NO_AI');},undefined,[],config);
  const server=createHttpServer(controller,dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as any,cookie=session.headers.get('set-cookie')!.split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
    const get=()=>fetch(origin+'/api/model-hub?projectId='+project.id,{headers:{Cookie:cookie}});
    const post=(path:string,body:object,override:object={})=>fetch(origin+path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(body)});
    const view=await (await get()).json() as any;assert.equal(view.providers.length,7);assert.equal(view.destinations[0].status,'configured');assert.equal(network,0);
    const consent={projectId:project.id,expectedConfigDigest:config[0].configDigest,confirmed:true};
    assert.equal((await post('/api/model-hub/destinations/fixture/models',consent,{'X-CSRF-Token':'0'.repeat(64)})).status,403);
    assert.equal((await post('/api/model-hub/destinations/fixture/models',{...consent,endpoint:'http://127.0.0.1:1'})).status,400);assert.equal(network,0);
    assert.equal((await post('/api/model-hub/destinations/fixture/models',consent)).status,200);assert.equal(network,1);
    const input={...consent,requestId:randomUUID(),destinationId:'fixture',model:'fixture-model',text:'hello fixture'};
    assert.equal((await post('/api/model-hub/requests',{...input,text:'person@example.invalid'})).status,403);assert.equal(network,1);
    const started=await post('/api/model-hub/requests',input);assert.equal(started.status,200);const request=await started.json() as any;
    await controller.modelHub.settle();const result=await (await get()).json() as any;
    assert.equal(result.requests[0].response,'Actual HTTP fixture');assert.equal(result.requests[0].execution,'completed');assert.equal(result.requests[0].costUsd,null);assert.equal(result.requests[0].usage.totalTokens,null);
    assert.equal((await post('/api/model-hub/requests',input)).status,200);assert.equal(network,2);
    assert.equal((await post('/api/model-hub/requests/'+request.id+'/interrupt',{projectId:project.id})).status,200);
    assert.equal((await fetch(origin+'/api/model-hub?projectId='+project.id+'&endpoint=override',{headers:{Cookie:cookie}})).status,400);
    hang=true;const activeResponse=await post('/api/model-hub/requests',{...input,requestId:randomUUID()});assert.equal(activeResponse.status,200);const activeRequest=await activeResponse.json() as any;
    assert.equal(controller.snapshot().modelHubBusy,true);assert.equal((await post('/api/connect',{})).status,409);
    assert.equal((await post('/api/model-hub/requests/'+activeRequest.id+'/interrupt',{projectId:project.id})).status,200);await controller.modelHub.settle();
    assert.equal(controller.snapshot().modelHubBusy,false);
    const native=store.createRun(randomUUID(),'fixture','synthetic native execution');const before=network;
    const blocked=await post('/api/model-hub/requests',{...input,requestId:randomUUID()});assert.equal(blocked.status,409);assert.equal((await blocked.json() as any).error,'RUN_ACTIVE');assert.equal(network,before);
    store.updateRun(native.id,{execution:'completed'},'run.completed');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();mock.closeAllConnections();await new Promise<void>(resolve=>mock.close(()=>resolve()));}
});
