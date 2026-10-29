import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {Controller,type ControllerRegistryOptions} from '../server/controller.ts';
import {ModelHubService,type ModelHubTransports} from '../server/model-hub-service.ts';
import {ModelRegistryStore} from '../server/model-registry-store.ts';
import {readModelHubConfiguration,type ModelHubConfiguration} from '../server/providers/model-hub-configuration.ts';
import {createNativeProbeService} from '../server/capability-probe.ts';
import {createClaudeAuthenticationService} from '../server/native-readiness.ts';

const provider=(enabled=true)=>({id:'user-api',kind:'provider',label:'User API',enabled,connection:{adapterId:'local',endpoint:'http://127.0.0.1:8080/v1',locality:'loopback',auth:{kind:'none'},projectPaths:['/tmp/registry-project'],timeoutMs:1000,maxOutputTokens:100}});
const model=()=>({id:'model',kind:'model',label:'Model',providerId:'user-api',modelId:'fixture-model',enabled:true});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function fakeTransports(){
  const calls:string[]=[];
  let beforeSend:(()=>Promise<void>)|undefined,afterSend:(()=>Promise<void>)|undefined;
  let failure:string|undefined;
  const factory:NonNullable<ModelHubTransports['http']>=(config,guard=()=>{})=>({
    async listModels(){
      const authorization=await config.authorize({providerId:config.providerId,endpoint:config.endpoint,operation:'models'});
      assert.equal(authorization.allowed,true);
      await beforeSend?.();guard();calls.push('models');if(failure)throw new Error(failure);return [...config.models];
    },
    async *chat(_input,options={}){
      const authorization=await config.authorize({providerId:config.providerId,endpoint:config.endpoint,operation:'chat',..._input});
      assert.equal(authorization.allowed,true);
      await beforeSend?.();guard();calls.push('chat');await afterSend?.();
      if(options.signal?.aborted)throw new Error('aborted');
      if(failure)throw new Error(failure);
      yield {type:'text' as const,text:'Fixture response'};
      yield {type:'done' as const,usage:{promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown' as const}};
    }
  });
  const transports:ModelHubTransports={http:factory,bedrock:(config,_deps,guard)=>factory({...config,providerId:'local',endpoint:'http://127.0.0.1:8080/v1',locality:'loopback',requireCredential:false,credential:()=>undefined,authorize:request=>config.authorize({providerId:'bedrock',region:config.region,operation:request.operation,...(request.operation==='chat'?{model:request.model,messages:request.messages}:{})})},guard)};
  return {calls,transports,set beforeSend(value:typeof beforeSend){beforeSend=value;},set afterSend(value:typeof afterSend){afterSend=value;},set failure(value:typeof failure){failure=value;}};
}
function fixture(configs:readonly ModelHubConfiguration[]=[],options:ControllerRegistryOptions={},store=new Store(':memory:')){
  const fake=fakeTransports();
  if(!store.projects().length)store.saveProject({id:'project',name:'Fixture',path:'/tmp/registry-project',createdAt:new Date().toISOString(),writeEnabled:false});
  const controller=new Controller(store,'/tmp/registry-project',()=>{throw new Error('Unexpected native call');},undefined,[],configs,{},{},{},{transports:fake.transports,...options});
  const registry=controller.modelRegistry,hub=controller.modelHub;
  const input=()=>({requestId:randomUUID(),projectId:'project',destinationId:'user-api',expectedConfigDigest:hub.view('project').destinations.find(d=>d.id==='user-api')!.configDigest,confirmed:true,model:'fixture-model',text:'Hello'});
  const validation=(id='user-api')=>{const entry=registry.get(id);return {requestId:randomUUID(),kind:'connection',expectedRevision:entry.revision,expectedConfigDigest:entry.configDigest,confirmed:true,projectPath:'/tmp/registry-project'};};
  const register=()=>{registry.create(provider());registry.create(model());};
  return {store,controller,registry,hub,fake,input,validation,register,async close(){await controller.close();store.close();}};
}

test('user destination requires confirmed durable connection validation; local validation cannot authorize transport',async()=>{
  const f=fixture();try{
    f.register();assert.equal(f.hub.configured,true);assert.equal(f.hub.view('project').destinations.length,1);
    assert.throws(()=>f.hub.start(f.input()),/REGISTRY_DISPATCH_DENIED/);
    const connection=f.validation();
    await assert.rejects(f.registry.validate('user-api',{...connection,confirmed:false}),/REGISTRY_CONFIRMATION_REQUIRED/);
    await f.registry.validate('user-api',{requestId:randomUUID(),kind:'local',expectedRevision:1,expectedConfigDigest:connection.expectedConfigDigest});
    assert.throws(()=>f.hub.start(f.input()),/REGISTRY_DISPATCH_DENIED/);assert.deepEqual(f.fake.calls,[]);
    f.fake.beforeSend=async()=>{assert.equal(f.registry.validations('user-api').at(-1)!.state,'intent');};
    assert.equal((await f.registry.validate('user-api',connection)).state,'passed');f.fake.beforeSend=undefined;
    assert.deepEqual(f.fake.calls,['models']);
    await f.registry.validate('user-api',connection);assert.deepEqual(f.fake.calls,['models']);
    const input=f.input(),record=f.hub.start(input);await f.hub.settle();
    const result=f.hub.view('project').requests[0];assert.equal(result.execution,'completed');assert.equal(result.response,'Fixture response');assert.equal(result.costUsd,null);
    assert.equal(f.hub.start(input).id,record.id);assert.deepEqual(f.fake.calls,['models','chat']);
  }finally{await f.close();}
});

for(const change of ['disable','edit','stale-validation','model-disable'] as const){
  test(`${change} after queueing refuses dispatch with zero new transport calls`,async()=>{
    const f=fixture();try{
      f.register();await f.registry.validate('user-api',f.validation());const before=f.fake.calls.length;
      f.hub.start(f.input());
      if(change==='disable')f.registry.disable('user-api',{expectedRevision:1});
      if(change==='edit')f.registry.update('user-api',{expectedRevision:1,entry:{...provider(),label:'Edited'}});
      if(change==='model-disable')f.registry.disable('model',{expectedRevision:1});
      if(change==='stale-validation'){
        const record=f.registry.validations('user-api')[0];
        f.store.db.prepare('UPDATE registry_validations SET state=?,body=? WHERE id=?').run('unknown',JSON.stringify({...record,state:'unknown',code:'REGISTRY_VALIDATION_UNKNOWN'}),record.id);
      }
      await f.hub.settle();const result=f.hub.view('project').requests[0];
      assert.equal(result.execution,'failed');assert.equal(result.issue,'REGISTRY_DISPATCH_DENIED');assert.equal(f.fake.calls.length,before);
      assert.throws(()=>f.hub.start(f.input()),/REGISTRY_DISPATCH_DENIED/);
    }finally{await f.close();}
  });
}

test('final transport hook rechecks registry after asynchronous preparation',async()=>{
  const f=fixture();try{
    f.register();await f.registry.validate('user-api',f.validation());const gate=deferred(),entered=deferred();
    f.fake.beforeSend=async()=>{entered.resolve();await gate.promise;};
    f.hub.start(f.input());await entered.promise;f.registry.disable('user-api',{expectedRevision:1});gate.resolve();await f.hub.settle();
    assert.deepEqual(f.fake.calls,['models']);assert.equal(f.hub.view('project').requests[0].issue,'REGISTRY_DISPATCH_DENIED');
  }finally{await f.close();}
});

test('already dispatched request preserves snapshot and remains observable and interruptible after disable',async()=>{
  const f=fixture();try{
    f.register();await f.registry.validate('user-api',f.validation());const gate=deferred(),entered=deferred();
    f.fake.afterSend=async()=>{entered.resolve();await gate.promise;};
    const input=f.input(),record=f.hub.start(input);await entered.promise;
    f.registry.disable('user-api',{expectedRevision:1});
    assert.equal(f.hub.view('project').requests[0].execution,'running');assert.equal(f.hub.view('project').requests[0].configDigest,input.expectedConfigDigest);
    f.hub.interrupt('project',record.id);gate.resolve();await f.hub.settle();
    assert.equal(f.hub.view('project').requests[0].execution,'interrupted');assert.deepEqual(f.fake.calls,['models','chat']);
  }finally{await f.close();}
});

test('disable and re-enable cannot revive prior approval or connection evidence',async()=>{
  const f=fixture();try{
    f.register();await f.registry.validate('user-api',f.validation());const old=f.input();
    f.registry.disable('user-api',{expectedRevision:1});f.registry.update('user-api',{expectedRevision:2,entry:provider()});
    assert.throws(()=>f.hub.start(f.input()),/REGISTRY_DISPATCH_DENIED/);
    await f.registry.validate('user-api',f.validation());assert.notEqual(f.input().expectedConfigDigest,old.expectedConfigDigest);
    assert.throws(()=>f.hub.start(old),/MODEL_HUB_REQUEST_DENIED/);assert.deepEqual(f.fake.calls,['models','models']);
  }finally{await f.close();}
});

function env(id='environment'){
  return readModelHubConfiguration(JSON.stringify([{id,label:'Environment',providerId:'local',endpoint:'http://127.0.0.1:9090/v1',locality:'loopback',enabled:true,projectPaths:['/tmp/registry-project'],models:['fixture-model'],requireCredential:false,credentialEnv:null,timeoutMs:1000,maxOutputTokens:100}]));
}
test('env-only constructor and Controller preserve digest, catalog, request and replay behavior',async()=>{
  const configs=env(),f=fixture(configs);const hub=new ModelHubService(f.store,configs,()=>{throw new Error('No credential read');},{},()=>{},undefined,f.fake.transports);
  try{
    assert.deepEqual(hub.view('project'),f.hub.view('project'));
    const consent={projectId:'project',expectedConfigDigest:configs[0].configDigest,confirmed:true};
    await hub.diagnose('environment',consent);
    const input={...consent,requestId:randomUUID(),destinationId:'environment',model:'fixture-model',text:'Hello'},record=hub.start(input);await hub.settle();
    assert.equal(hub.view('project').requests[0].execution,'completed');assert.equal(hub.start(input).id,record.id);assert.deepEqual(f.fake.calls,['models','chat']);
  }finally{await hub.close();await f.close();}
});

test('startup env ID collision is visible and refused without merging or sending',async()=>{
  const store=new Store(':memory:');new ModelRegistryStore(store).create(provider());const f=fixture(env('user-api'),{},store);
  try{
    assert.deepEqual(f.registry.list().collisions,[{id:'user-api',origins:['env','user']}]);
    assert.equal(f.hub.view('project').destinations.length,1);
    assert.throws(()=>f.hub.start(f.input()),/REGISTRY_ID_CONFLICT/);
    await assert.rejects(f.hub.diagnose('user-api',f.input()),/REGISTRY_ID_CONFLICT/);assert.deepEqual(f.fake.calls,[]);
  }finally{await f.close();}
});

test('validation changed before transport remains unusable and sends nothing',async()=>{
  const f=fixture();try{
    f.register();const pending=f.registry.validate('user-api',f.validation());f.registry.disable('user-api',{expectedRevision:1});
    assert.equal((await pending).state,'unknown');assert.deepEqual(f.fake.calls,[]);assert.equal(f.registry.usable('user-api'),false);
  }finally{await f.close();}
});

test('restart recovers unfinished validation unknown with zero port calls and no automatic retry',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-registry-r3-')),path=join(dir,'test.sqlite');let f=fixture([],{},new Store(path));
  try{
    f.register();const input=f.validation();
    const gate=deferred(),entered=deferred();f.fake.beforeSend=async()=>{entered.resolve();await gate.promise;};
    const pending=f.registry.validate('user-api',input);await entered.promise;
    const restarted=fixture([],{},new Store(path));
    assert.equal(restarted.registry.validations('user-api')[0].state,'unknown');
    assert.equal((await restarted.registry.validate('user-api',input)).state,'unknown');assert.deepEqual(restarted.fake.calls,[]);
    gate.resolve();assert.equal((await pending).state,'unknown');assert.deepEqual(f.fake.calls,[]);
    await f.close();f=restarted;
  }finally{await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('fake credential failures never appear in Registry or Hub views, events, errors or stored records',async()=>{
  const f=fixture([], {configuredCredentialRefs:['ORBIT_MODEL_KEY_FIXTURE']});try{
    const secret='synthetic-credential-value-never-persist';
    f.registry.create({...provider(),connection:{...provider().connection,auth:{kind:'env_ref',env:'ORBIT_MODEL_KEY_FIXTURE'}}});f.registry.create(model());
    assert.deepEqual(f.registry.get('user-api').authReferences,[{name:'ORBIT_MODEL_KEY_FIXTURE',configured:true}]);
    f.fake.failure=secret;assert.equal((await f.registry.validate('user-api',f.validation())).state,'failed');
    f.fake.failure=undefined;await f.registry.validate('user-api',f.validation());f.fake.failure=secret;f.hub.start(f.input());await f.hub.settle();
    assert.equal(f.hub.view('project').requests[0].issue,'PROVIDER_REQUEST_FAILED');
    const publicData=[f.registry.list(),f.registry.validations('user-api'),f.hub.view('project'),f.store.eventsAfter(0),f.store.db.prepare('SELECT body FROM model_hub_requests').all()];
    assert.equal(JSON.stringify(publicData).includes(secret),false);
  }finally{await f.close();}
});

for(const adapter of ['codex','claude-code'] as const){
  test(`native ${adapter} uses only explicit readiness refresh with intent already saved`,async()=>{
    let calls=0,authCalls=0;let f:ReturnType<typeof fixture>;
    const nativeProbe=createNativeProbeService(async()=>{calls++;assert.equal(f.registry.validations('native')[0].state,'intent');return {checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.165.0'},claude:{status:'found',version:'2.1.259'}};});
    const claudeAuthentication=createClaudeAuthenticationService(async()=>{authCalls++;return {checkedAt:new Date().toISOString(),authentication:'subscription',source:'claude.auth.status',issue:null};});
    f=fixture([],{nativeProbe,claudeAuthentication});try{
      f.registry.create({id:'native',kind:'provider',label:'Native',enabled:true,connection:{adapterId:adapter,auth:{kind:'native_session'}}});
      assert.equal(f.registry.get('native').nativeStatus!.installation,'unknown');assert.equal(calls,0);
      await assert.rejects(f.registry.validate('native',{...f.validation('native'),confirmed:false}),/REGISTRY_CONFIRMATION_REQUIRED/);assert.equal(calls,0);
      const result=await f.registry.validate('native',f.validation('native'));
      assert.equal(result.state,adapter==='codex'?'unknown':'passed');assert.equal(calls,1);assert.equal(authCalls,adapter==='codex'?0:1);assert.deepEqual(f.fake.calls,[]);
      assert.equal(f.registry.get('native').nativeStatus!.installation,'found');
    }finally{await f.close();}
  });
}

test('Bedrock user validation dispatches only its catalog adapter',async()=>{
  const f=fixture();try{
    f.registry.create({...provider(),connection:{adapterId:'bedrock',cliPath:'/usr/local/bin/aws',region:'us-east-1',auth:{kind:'aws_env_refs',accessKeyId:'ORBIT_BEDROCK_ACCESS',secretAccessKey:'ORBIT_BEDROCK_SECRET',sessionToken:null},projectPaths:['/tmp/registry-project'],timeoutMs:1000,maxOutputTokens:100}});
    f.registry.create({...model(),modelId:'example.model'});
    assert.equal((await f.registry.validate('user-api',f.validation())).state,'passed');assert.deepEqual(f.fake.calls,['models']);
    assert.equal(f.hub.view('project').destinations[0].providerId,'bedrock');
  }finally{await f.close();}
});

test('provider without models exposes no invented model and cannot dispatch',async()=>{
  const f=fixture();try{
    f.registry.create(provider());
    assert.deepEqual(f.hub.view('project').destinations[0].configuredModels,[]);
    await f.registry.validate('user-api',f.validation());
    assert.throws(()=>f.hub.start({...f.input(),model:'registry-placeholder'}),/REGISTRY_DISPATCH_DENIED/);
  }finally{await f.close();}
});

test('R1 aggregate model count beyond Hub limit blocks only the user destination, preserving env dispatch',async()=>{
  const f=fixture(env());try{
    f.registry.create(provider());
    for(let index=0;index<101;index++)f.registry.create({...model(),id:'model-'+index,modelId:'fixture-'+index});
    assert.equal(f.hub.view('project').destinations.length,2);
    assert.throws(()=>f.hub.start(f.input()),/REGISTRY_DISPATCH_DENIED/);
    const config=env()[0],consent={projectId:'project',expectedConfigDigest:config.configDigest,confirmed:true};
    await f.hub.diagnose('environment',consent);
    f.hub.start({...consent,requestId:randomUUID(),destinationId:'environment',model:'fixture-model',text:'Hello'});await f.hub.settle();
    assert.equal(f.hub.view('project').requests[0].execution,'completed');assert.deepEqual(f.fake.calls,['models','chat']);
  }finally{await f.close();}
});
