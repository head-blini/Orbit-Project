import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from './temp.ts';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {ModelHubService} from '../server/model-hub-service.ts';
import {readModelHubConfiguration} from '../server/providers/model-hub-configuration.ts';
import {createBedrockTemporary,writeBedrockRequest} from '../server/providers/bedrock-temporary.ts';
import type {BedrockTransportDependencies} from '../server/providers/bedrock-transport.ts';
import type {ModelHubRequest} from '../shared/model-hub.ts';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-bedrock-hub-')),projectPath=join(dir,'project');mkdirSync(projectPath);
  const store=new Store(join(dir,'test.sqlite')),project={id:randomUUID(),name:'fixture',path:projectPath,createdAt:new Date().toISOString(),writeEnabled:false};store.saveProject(project);
  const cliPath=join(dir,'missing',process.platform==='win32'?'aws.exe':'aws');
  const configs=readModelHubConfiguration(JSON.stringify([{id:'bedrock',label:'Bedrock missing CLI',providerId:'bedrock',enabled:true,projectPaths:[projectPath],models:['amazon.nova-micro-v1:0'],
    cliPath,region:'us-east-1',credentialEnvs:{accessKeyId:'ORBIT_BEDROCK_ACCESS_KEY',secretAccessKey:'ORBIT_BEDROCK_SECRET_KEY',sessionToken:null},timeoutMs:1000,maxOutputTokens:8}]));
  let reads=0;const hub=new ModelHubService(store,configs,()=>{reads++;throw new Error('credentials must not be read');});
  const consent={projectId:project.id,expectedConfigDigest:configs[0].configDigest,confirmed:true};
  return {dir,store,project,cliPath,configs,hub,consent,get reads(){return reads;},async close(){await hub.close();store.close();}};
}

test('Bedrock missing runtime is a precise consent-bound diagnostic without credential access, network or a fake request',async()=>{
  const f=fixture();try{
    const view=f.hub.view(f.project.id);assert.equal(view.providers.find(p=>p.id==='bedrock')?.implementation,'aws_cli_converse');
    assert.equal(view.destinations[0].transport,'aws_cli_converse');assert.equal(view.destinations[0].catalog.status,'not_queried');assert.equal(f.reads,0);
    assert.equal(JSON.stringify(view).includes('ORBIT_BEDROCK_'),false);assert.equal(JSON.stringify(view).includes(f.cliPath),false);
    await assert.rejects(f.hub.diagnose('bedrock',{...f.consent,confirmed:false}),/MODEL_HUB_REQUEST_DENIED/);
    const catalog=await f.hub.diagnose('bedrock',f.consent);assert.equal(catalog.status,'failed');assert.equal(catalog.issue,'BEDROCK_CLI_NOT_FOUND');assert.deepEqual(catalog.models,[]);
    assert.equal(f.reads,0);assert.equal(existsSync(f.cliPath),false);assert.equal(f.hub.view(f.project.id).requests.length,0);
    assert.throws(()=>f.hub.start({...f.consent,destinationId:'bedrock',requestId:randomUUID(),model:'amazon.nova-micro-v1:0',text:'ordinary input'}),/MODEL_CATALOG_REQUIRED/);
  }finally{await f.close();}
});

function mockDependencies(tempRoot:string){
  const calls:string[][]=[];let body:unknown=null;
  const deps:BedrockTransportDependencies={tempRoot,validateCli:()=>{},invoke:async request=>{
    calls.push([...request.args]);let text:string;
    if(request.args[0]==='--version')text='aws-cli/2.31.0 Python/3.13 Windows/11 exe/AMD64\n';
    else if(request.args[0]==='bedrock')text=JSON.stringify({modelSummaries:[{modelId:'amazon.nova-micro-v1:0',outputModalities:['TEXT'],inferenceTypesSupported:['ON_DEMAND']}]});
    else{body=JSON.parse(readFileSync(request.args[request.args.indexOf('--cli-input-json')+1].slice(7),'utf8'));
      text=JSON.stringify({output:{message:{role:'assistant',content:[{text:'mock response'}]}},stopReason:'end_turn',usage:{inputTokens:2,outputTokens:3,totalTokens:5}});}
    return {stdout:Buffer.from(text),stderr:Buffer.alloc(0),exitCode:0,timedOut:false,aborted:false,overflow:false};
  }};
  return {calls,deps,get body(){return body;}};
}
const syntheticCredential=(name:string)=>name==='ORBIT_BEDROCK_ACCESS_KEY'?'synthetic-access':'synthetic-secret';

test('Bedrock service commits one consented mock result, removes the real temp input and never replays a receipt',async()=>{
  const f=fixture(),mock=mockDependencies(f.dir),hub=new ModelHubService(f.store,f.configs,syntheticCredential,mock.deps);
  try{
    assert.equal((await hub.diagnose('bedrock',f.consent)).status,'available');
    const input={...f.consent,destinationId:'bedrock',requestId:randomUUID(),model:'amazon.nova-micro-v1:0',text:'ordinary approved fixture input'};
    assert.throws(()=>hub.start({...input,text:'person@example.invalid'}),/MODEL_HUB_REQUEST_DENIED/);assert.equal(mock.calls.length,2);
    const record=hub.start(input);await hub.settle();const result=hub.view(f.project.id).requests[0];
    assert.equal(result.id,record.id);assert.equal(result.execution,'completed');assert.equal(result.temporaryInput,'removed');assert.equal(result.response,'mock response');assert.equal(result.usage.totalTokens,5);assert.equal(result.costUsd,null);
    assert.equal(existsSync(join(f.dir,'orbit-bedrock-'+record.id)),false);assert.equal((mock.body as any).messages[0].content[0].text,input.text);
    assert.equal(mock.calls.length,4);assert.equal(hub.start(input).id,record.id);assert.equal(mock.calls.length,4);
    const persisted=JSON.stringify(f.store.db.prepare('SELECT body FROM model_hub_requests').all())+JSON.stringify(f.store.eventsAfter(0));
    assert.ok(!persisted.includes(input.text));assert.ok(!persisted.includes('synthetic-secret'));assert.ok(!JSON.stringify(mock.calls).includes(input.text));
  }finally{await hub.close();await f.close();}
});

test('lost Bedrock input remains visible behind recent HTTP history and blocks new calls until exact owned cleanup',async()=>{
  const f=fixture(),mock=mockDependencies(f.dir),hub=new ModelHubService(f.store,f.configs,syntheticCredential,mock.deps);
  let restored:ModelHubService|undefined;
  try{
    await hub.diagnose('bedrock',f.consent);const input={...f.consent,destinationId:'bedrock',requestId:randomUUID(),model:'amazon.nova-micro-v1:0',text:'ordinary fixture input'};
    const record=hub.start(input);await hub.settle();const result=hub.view(f.project.id).requests[0];
    const temporary=createBedrockTemporary(record.id,f.dir);writeBedrockRequest(temporary,Buffer.from('approved crash fixture input'));
    f.store.db.prepare('UPDATE model_hub_requests SET body=? WHERE id=?').run(JSON.stringify({...result,execution:'running',temporaryInput:'present'}),record.id);
    for(let i=0;i<21;i++){const recent:ModelHubRequest={...result,id:randomUUID(),requestId:randomUUID(),providerId:'local',temporaryInput:'none'};f.store.db.prepare('INSERT INTO model_hub_requests VALUES(?,?,?,?,?)').run(recent.id,recent.requestId,'fixture',recent.projectId,JSON.stringify(recent));}
    const changedTempRoot=join(f.dir,'changed-server-temp');mkdirSync(changedTempRoot);
    restored=new ModelHubService(f.store,f.configs,syntheticCredential,{...mock.deps,tempRoot:changedTempRoot});
    const recovered=restored.view(f.project.id).requests.find(row=>row.id===record.id);assert.ok(recovered,'unresolved input must remain reachable, even when older than 20 records');
    assert.equal(recovered.execution,'lost');assert.equal(recovered.temporaryInput,'possible');assert.equal(mock.calls.length,4);
    assert.throws(()=>restored!.start({...input,requestId:randomUUID()}),/BEDROCK_RECOVERY_REQUIRED/);
    await assert.rejects(restored.cleanup(f.project.id,record.id,false),/BEDROCK_STOP_CONFIRMATION_REQUIRED/);assert.equal(existsSync(temporary.path),true);
    const cleaned=await restored.cleanup(f.project.id,record.id,true);assert.equal(cleaned.execution,'lost');assert.equal(cleaned.temporaryInput,'removed');assert.equal(existsSync(temporary.path),false);assert.equal(mock.calls.length,4);
    const next=restored.start({...input,requestId:randomUUID()});await restored.settle();assert.equal(restored.view(f.project.id).requests.find(row=>row.id===next.id)?.execution,'completed');assert.equal(mock.calls.length,6);
  }finally{await restored?.close();await hub.close();await f.close();}
});

test('interrupt waits for the owned invocation, cleans its input and preserves uncertain remote usage',async()=>{
  const f=fixture(),mock=mockDependencies(f.dir),original=mock.deps.invoke!;
  let notifyStarted!:()=>void;const started=new Promise<void>(resolve=>{notifyStarted=resolve;});
  mock.deps.invoke=async request=>{
    if(request.args[0]!=='bedrock-runtime')return original(request);
    notifyStarted();await new Promise<void>(resolve=>{if(request.signal?.aborted)resolve();else request.signal?.addEventListener('abort',()=>resolve(),{once:true});});
    return {stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:1,timedOut:false,aborted:true,overflow:false};
  };
  const hub=new ModelHubService(f.store,f.configs,syntheticCredential,mock.deps);
  try{
    await hub.diagnose('bedrock',f.consent);const record=hub.start({...f.consent,destinationId:'bedrock',requestId:randomUUID(),model:'amazon.nova-micro-v1:0',text:'ordinary interrupt input'});
    await started;assert.equal(hub.view(f.project.id).requests[0].temporaryInput,'present');
    await assert.rejects(hub.cleanup(f.project.id,record.id,true),/BEDROCK_CLEANUP_UNAVAILABLE/);
    hub.interrupt(f.project.id,record.id);await hub.settle();const result=hub.view(f.project.id).requests[0];
    assert.equal(result.execution,'interrupted');assert.equal(result.temporaryInput,'removed');assert.equal(result.issue,'PROVIDER_ABORTED');assert.equal(result.usage.totalTokens,null);assert.equal(result.costUsd,null);
    assert.equal(existsSync(join(f.dir,'orbit-bedrock-'+record.id)),false);assert.equal(hub.active,false);
  }finally{await hub.close();await f.close();}
});

test('cleanup failure cannot report model completion, remove unexpected data or silently unblock a new call',async()=>{
  const f=fixture(),mock=mockDependencies(f.dir),original=mock.deps.invoke!;let unexpected='';
  mock.deps.invoke=async request=>{const result=await original(request);if(request.args[0]==='bedrock-runtime'){unexpected=join(request.cwd,'unexpected.txt');writeFileSync(unexpected,'retain fixture');}return result;};
  const hub=new ModelHubService(f.store,f.configs,syntheticCredential,mock.deps);
  try{
    await hub.diagnose('bedrock',f.consent);const input={...f.consent,destinationId:'bedrock',requestId:randomUUID(),model:'amazon.nova-micro-v1:0',text:'ordinary cleanup fixture'};
    const record=hub.start(input);await hub.settle();const result=hub.view(f.project.id).requests[0];
    assert.equal(result.execution,'failed');assert.equal(result.response,'');assert.equal(result.temporaryInput,'cleanup_required');assert.equal(result.issue,'BEDROCK_CLEANUP_REQUIRED');
    assert.deepEqual(hub.view(f.project.id).bedrockRecovery,[{projectId:f.project.id,requestId:record.id}]);assert.equal(readFileSync(unexpected,'utf8'),'retain fixture');
    await assert.rejects(hub.cleanup(f.project.id,record.id,true),/BEDROCK_CLEANUP_REQUIRED/);assert.equal(readFileSync(unexpected,'utf8'),'retain fixture');
    assert.throws(()=>hub.start({...input,requestId:randomUUID()}),/BEDROCK_RECOVERY_REQUIRED/);assert.equal(mock.calls.length,4);
    unlinkSync(unexpected);await hub.cleanup(f.project.id,record.id,true);assert.deepEqual(hub.view(f.project.id).bedrockRecovery,[]);assert.equal(existsSync(join(f.dir,'orbit-bedrock-'+record.id)),false);
  }finally{await hub.close();await f.close();}
});
