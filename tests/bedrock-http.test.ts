import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import type {ModelHubRequest} from '../shared/model-hub.ts';

test('Bedrock temporary-input cleanup requires exact session/project/stopped consent and never replays lost work',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-bedrock-http-')),path=join(dir,'project');mkdirSync(path);
  const store=new Store(join(dir,'test.sqlite')),project={id:randomUUID(),name:'Fixture',path,createdAt:new Date().toISOString(),writeEnabled:false};store.saveProject(project);
  const foreign={...project,id:randomUUID(),name:'Other'};store.saveProject(foreign);
  const controller=new Controller(store,createWorkspace(dir),()=>{throw new Error('NO_AI');});
  const record:ModelHubRequest={id:randomUUID(),requestId:randomUUID(),projectId:project.id,destinationId:'removed-server-config',providerId:'bedrock',model:'amazon.nova-micro-v1:0',configDigest:'a'.repeat(64),
    execution:'lost',response:'',issue:'RESULT_UNCERTAIN',usage:{promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'},costUsd:null,
    createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:null,timeoutMs:1000,maxOutputTokens:8,temporaryInput:'possible'};
  store.db.prepare('INSERT INTO model_hub_requests VALUES(?,?,?,?,?)').run(record.id,record.requestId,'fixture',project.id,JSON.stringify(record));
  store.setMeta('bedrockTemporaryRoot',dir);
  const server=createHttpServer(controller,dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
    const route='/api/model-hub/requests/'+record.id+'/cleanup',input={projectId:project.id,confirmedStopped:true};
    const post=(body:object,tail='',override:object={})=>fetch(origin+route+tail,{method:'POST',headers:{...headers,...override},body:JSON.stringify(body)});
    assert.equal((await post(input,'',{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await post({...input,path:dir})).status,400);assert.equal((await post(input,'?path=override')).status,400);
    assert.equal((await post({...input,confirmedStopped:false})).status,409);
    assert.equal((await post({...input,projectId:foreign.id})).status,404);
    assert.equal(controller.modelHub.view(project.id).requests[0].temporaryInput,'possible');
    const response=await post(input);assert.equal(response.status,200);const result=await response.json() as ModelHubRequest;
    assert.equal(result.temporaryInput,'removed');assert.equal(result.execution,'lost');assert.equal(result.issue,'RESULT_UNCERTAIN');assert.equal(result.costUsd,null);
    assert.equal((await post(input)).status,200);assert.equal(controller.modelHub.view(project.id).requests.length,1);assert.equal(controller.modelHub.active,false);assert.equal(store.runs().length,0);
    const restored=new Controller(store,createWorkspace(dir),()=>{throw new Error('NO_AI');});
    assert.equal(restored.modelHub.view(project.id).requests[0].temporaryInput,'removed');assert.equal(restored.modelHub.view(project.id).requests[0].execution,'lost');await restored.close();
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();store.close();}
});
