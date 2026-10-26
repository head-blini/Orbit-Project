import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { readModelHubConfiguration } from '../server/providers/model-hub-configuration.ts';
import { ModelHubService } from '../server/model-hub-service.ts';

async function fixture(mode:'normal'|'hang'|'over_limit'='normal'){
  const requests:{url:string;body:any}[]=[],dir=mkdtempSync(join(tmpdir(),'orbit-model-hub-')),projectPath=join(dir,'project');mkdirSync(projectPath);
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();requests.push({url:req.url!,body:raw?JSON.parse(raw):null});
    if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'fixture-model'},{id:'not-allowed'}]}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'Fixture response'}}]})+'\n\n');
    if(mode==='hang')return;
    res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:mode==='over_limit'?99:3,total_tokens:mode==='over_limit'?101:5}})+'\n\n');res.end('data: [DONE]\n\n');
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1';
  const store=new Store(join(dir,'test.sqlite')),project={id:randomUUID(),name:'fixture',path:projectPath,createdAt:new Date().toISOString(),writeEnabled:false};store.saveProject(project);
  const raw=[{id:'local-fixture',label:'Local fixture',providerId:'local',endpoint,locality:'loopback',enabled:true,projectPaths:[projectPath],models:['fixture-model'],requireCredential:false,credentialEnv:null,timeoutMs:2000,maxOutputTokens:8}];
  const configs=readModelHubConfiguration(JSON.stringify(raw));let credentialReads=0;
  const hub=new ModelHubService(store,configs,()=>{credentialReads++;return undefined;});
  const consent={projectId:project.id,expectedConfigDigest:configs[0].configDigest,confirmed:true};
  const input=()=>({...consent,requestId:randomUUID(),destinationId:'local-fixture',model:'fixture-model',text:'Hello local fixture'});
  return {requests,store,hub,raw,configs,project,consent,input,get credentialReads(){return credentialReads;},close:async()=>{await hub.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}};
}

test('Model Hub is inert until consent, streams one bounded local request, and replays without a second send',async()=>{
  const f=await fixture();try{
    const initial=f.hub.view(f.project.id);assert.equal(initial.providers.length,7);assert.equal(initial.destinations[0].catalog.status,'not_queried');assert.equal(f.requests.length,0);assert.equal(f.credentialReads,0);
    await assert.rejects(f.hub.diagnose('local-fixture',{...f.consent,confirmed:false}),/MODEL_HUB_REQUEST_DENIED/);assert.equal(f.requests.length,0);
    const catalog=await f.hub.diagnose('local-fixture',f.consent);assert.deepEqual(catalog.models,['fixture-model']);
    const input=f.input(),request=f.hub.start(input);assert.equal(request.execution,'running');await f.hub.settle();
    const result=f.hub.view(f.project.id).requests[0];assert.equal(result.id,request.id);assert.equal(result.execution,'completed');assert.equal(result.response,'Fixture response');assert.equal(result.usage.completionTokens,3);assert.equal(result.costUsd,null);assert.ok(result.durationMs!==null);
    assert.equal(f.requests[1].body.max_tokens,8);assert.equal(f.requests[1].body.messages[0].content,input.text);
    assert.equal(f.hub.start(input).id,request.id);assert.equal(f.requests.length,2);
    assert.throws(()=>f.hub.start({...input,text:'different input'}),/IDEMPOTENCY_CONFLICT/);
    assert.ok(!JSON.stringify(f.store.eventsAfter(0)).includes(input.text),'prompt text is not persisted in audit events');
    const restored=new ModelHubService(f.store,f.configs,()=>undefined);assert.equal(restored.view(f.project.id).requests[0].id,result.id);await restored.close();
  }finally{await f.close();}
});

test('Model Hub denies private input, stale configuration, unavailable models and concurrent sends before network',async()=>{
  const f=await fixture('hang');try{
    assert.throws(()=>f.hub.start(f.input()),/MODEL_CATALOG_REQUIRED/);assert.equal(f.requests.length,0);
    await f.hub.diagnose('local-fixture',f.consent);const before=f.requests.length;
    for(const update of [{text:'fixture-person@example.invalid'},{expectedConfigDigest:'0'.repeat(64)},{confirmed:false},{model:'other-model'}])assert.throws(()=>f.hub.start({...f.input(),...update}));
    assert.equal(f.requests.length,before);assert.equal(f.credentialReads,0);
    const request=f.hub.start(f.input());assert.throws(()=>f.hub.start(f.input()),/MODEL_REQUEST_ACTIVE/);
    f.hub.interrupt(f.project.id,request.id);await f.hub.settle();assert.equal(f.hub.view(f.project.id).requests[0].execution,'interrupted');
  }finally{await f.close();}
});

test('Model Hub never labels over-limit or uncertain recovery as completion',async()=>{
  const f=await fixture('over_limit');try{
    await f.hub.diagnose('local-fixture',f.consent);const request=f.hub.start(f.input());await f.hub.settle();
    const result=f.hub.view(f.project.id).requests[0];assert.equal(result.execution,'failed');assert.equal(result.issue,'PROVIDER_OUTPUT_LIMIT');assert.equal(result.usage.completionTokens,null);
    f.store.db.prepare('UPDATE model_hub_requests SET body=? WHERE id=?').run(JSON.stringify({...result,execution:'running',finishedAt:null}),request.id);
    const restored=new ModelHubService(f.store,f.configs,()=>undefined);assert.equal(restored.view(f.project.id).requests[0].execution,'lost');assert.equal(f.requests.length,2);await restored.close();
  }finally{await f.close();}
});

test('Model Hub reserves UTF-8 and JSON-expanded output space before any new request',async()=>{
  const f=await fixture();try{
    await f.hub.diagnose('local-fixture',f.consent);f.hub.start(f.input());await f.hub.settle();
    const record=f.hub.view(f.project.id).requests[0],target=16*1024*1024-200000;
    let used=Number(f.store.db.prepare('SELECT SUM(length(CAST(body AS BLOB))) AS bytes FROM model_hub_requests').get()!.bytes);
    const insert=f.store.db.prepare('INSERT INTO model_hub_requests VALUES(?,?,?,?,?)');
    while(used<target-2000){
      const copy={...record,id:randomUUID(),requestId:randomUUID(),response:''},overhead=Buffer.byteLength(JSON.stringify(copy));
      copy.response='가'.repeat(Math.min(64000,Math.floor((target-used-overhead)/3)));
      const body=JSON.stringify(copy);insert.run(copy.id,copy.requestId,'fixture-history',copy.projectId,body);used+=Buffer.byteLength(body);
    }
    const before=f.requests.length;assert.throws(()=>f.hub.start(f.input()),/MODEL_HISTORY_QUOTA/);assert.equal(f.requests.length,before);
  }finally{await f.close();}
});
