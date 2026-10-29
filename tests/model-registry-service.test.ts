import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {ModelRegistryStore} from '../server/model-registry-store.ts';
import {ModelRegistryService,type RegistryServiceOptions} from '../server/model-registry-service.ts';
import {readModelHubConfiguration} from '../server/providers/model-hub-configuration.ts';
import {AppError} from '../server/errors.ts';

const provider=(id='provider',enabled=false)=>({id,kind:'provider',label:'Local API',enabled,connection:{adapterId:'local',endpoint:'http://127.0.0.1:8080/v1',locality:'loopback',auth:{kind:'none'},projectPaths:['/tmp/registry-project'],timeoutMs:1000,maxOutputTokens:100}});
const model=(enabled=true)=>({id:'model',kind:'model',label:'Model',providerId:'provider',modelId:'example/model',enabled});
const error=(code:string,status=400)=>(e:unknown)=>e instanceof AppError&&e.message===code&&e.status===status;
function fixture(options:RegistryServiceOptions={}){const store=new Store(':memory:');return {store,service:new ModelRegistryService(store,options)};}
function request(service:ModelRegistryService,id='provider',requestId='request',kind:'local'|'connection'='local'){
  const entry=service.get(id);return {requestId,kind,expectedRevision:entry.revision,expectedConfigDigest:entry.configDigest,...(kind==='connection'?{confirmed:true,projectPath:'/tmp/registry-project'}:{})};
}
function env(id='env-provider'){
  return readModelHubConfiguration(JSON.stringify([{id,label:'Environment',providerId:'local',endpoint:'http://127.0.0.1:9090/v1',locality:'loopback',enabled:true,projectPaths:['/tmp/registry-project'],models:['example/model'],requireCredential:true,credentialEnv:'ORBIT_MODEL_KEY_FIXTURE',timeoutMs:1000,maxOutputTokens:100}]));
}

test('CRUD, local evidence and provider revisions govern availability without calling a port',async()=>{
  let calls=0;const {store,service}=fixture({connection:async()=>{calls++;return {state:'passed'};}});
  try{
    assert.equal(service.create(provider()).enabled,false);
    service.update('provider',{expectedRevision:1,entry:provider('provider',true)});service.create(model());
    const local=await service.validate('model',request(service,'model'));
    assert.equal(local.state,'passed');assert.equal(local.code,'REGISTRY_LOCAL_VALID');assert.equal(calls,0);
    assert.equal(service.usable('model'),false);
    await service.validate('model',request(service,'model','connect','connection'));assert.equal(calls,1);assert.equal(service.usable('model'),true);
    const oldDigest=service.get('model').configDigest;
    service.disable('provider',{expectedRevision:2});assert.equal(service.usable('model'),false);
    service.update('provider',{expectedRevision:3,entry:provider('provider',true)});
    assert.notEqual(service.get('model').configDigest,oldDigest);assert.equal(service.usable('model'),false);
    assert.equal(service.validations('model').length,2);
  }finally{store.close();}
});

test('connection intent precedes dispatch; duplicate IDs never dispatch again',async()=>{
  let calls=0,release!:(value:{state:'passed'})=>void;
  const {store,service}=fixture({connection:async context=>{
    calls++;assert.equal(context.confirmed,true);assert.equal(context.projectPath,'/tmp/registry-project');
    assert.equal(context.provider.id,'provider');assert.equal(context.validation.configDigest,service.get('provider').configDigest);
    assert.equal(store.db.prepare('SELECT state FROM registry_validations').get()!.state,'intent');
    return new Promise(resolve=>{release=resolve;});
  }});
  try{
    service.create(provider('provider',true));const input=request(service,'provider','connection','connection');
    const pending=service.validate('provider',input);
    assert.equal((await service.validate('provider',input)).state,'intent');assert.equal(calls,1);
    release({state:'passed'});const result=await pending;
    assert.deepEqual(await service.validate('provider',input),result);assert.equal(calls,1);
    service.disable('provider',{expectedRevision:1});
    assert.deepEqual(await service.validate('provider',input),result);
    await assert.rejects(service.validate('provider',{...input,projectPath:'/tmp/another'}),error('REGISTRY_REQUEST_CONFLICT',409));
  }finally{store.close();}
});

test('confirmation, revision, digest, project and malformed input fail before intent or dispatch',async()=>{
  let calls=0;const {store,service}=fixture({connection:async()=>{calls++;return {state:'passed'};}});
  try{
    service.create(provider());const input=request(service,'provider','connection','connection');
    await assert.rejects(service.validate('provider',{...input,confirmed:false}),error('REGISTRY_CONFIRMATION_REQUIRED',403));
    const {confirmed,...missing}=input;await assert.rejects(service.validate('provider',missing),error('REGISTRY_CONFIRMATION_REQUIRED',403));
    await assert.rejects(service.validate('provider',{...input,expectedRevision:2}),error('REGISTRY_REVISION_STALE',409));
    await assert.rejects(service.validate('provider',{...input,expectedConfigDigest:'0'.repeat(64)}),error('REGISTRY_CONFIG_STALE',409));
    await assert.rejects(service.validate('provider',{...input,projectPath:'/tmp/another'}),error('REGISTRY_PROJECT_DENIED',403));
    await assert.rejects(service.validate('provider',{...input,extra:true}),error('INVALID_FIELDS'));
    await assert.rejects(service.validate('provider',{...input,requestId:'sk-fixture-secret'}),error('REGISTRY_CREDENTIAL_INPUT'));
    assert.equal(calls,0);assert.equal(service.validations('provider').length,0);
  }finally{store.close();}
});

test('unsupported adapters and missing port never become usable',async()=>{
  const {store,service}=fixture();try{
    service.create(provider('provider',true));
    assert.equal((await service.validate('provider',request(service,'provider','missing','connection'))).state,'unsupported');
    for(const adapterId of ['other-cli','web']){
      service.create({id:adapterId,kind:'provider',label:adapterId,enabled:true,connection:{adapterId,auth:{kind:'declared',method:'unknown'}}});
      assert.equal((await service.validate(adapterId,request(service,adapterId,adapterId))).state,'unsupported');
      assert.equal(service.usable(adapterId),false);
    }
    assert.equal(service.usable('provider'),false);
  }finally{store.close();}
});

test('read-only env and builtin projections preserve source order, digest and credential references',()=>{
  const configs=env();const {store,service}=fixture({configurations:configs,configuredCredentialRefs:['ORBIT_MODEL_KEY_FIXTURE']});
  try{
    const list=service.list();assert.deepEqual(list.collisions,[]);
    const entry=service.get('env-provider');assert.equal(entry.origin,'env');assert.equal(entry.configDigest,configs[0].configDigest);
    assert.deepEqual(entry.authReferences,[{name:'ORBIT_MODEL_KEY_FIXTURE',configured:true}]);
    assert.equal(list.entries[0].id,'env-provider');
    for(const id of ['env-provider','codex','claude-code']){
      assert.equal(service.usable(id),false);
      assert.throws(()=>service.update(id,{expectedRevision:1,entry:provider(id)}),error('REGISTRY_READ_ONLY',403));
      assert.throws(()=>service.disable(id,{expectedRevision:1}),error('REGISTRY_READ_ONLY',403));
      assert.throws(()=>service.create(provider(id)),error('REGISTRY_ID_CONFLICT',409));
    }
    assert.equal(service.get('codex').kind,'runtime');assert.equal(service.get('claude-code').origin,'builtin');
    assert.deepEqual(new ModelRegistryStore(store).list(),[]);assert.equal(store.lastSeq(),0);
    assert.throws(()=>new ModelRegistryService(store,{configurations:[{...configs[0],endpoint:'http://user:password@127.0.0.1:9090/v1'}]}),/MODEL_HUB_CONFIGURATION_INVALID/);
  }finally{store.close();}
});

test('startup collisions remain visible and block lookup, writes and child availability',()=>{
  const store=new Store(':memory:');try{
    const registry=new ModelRegistryStore(store);registry.create(provider('provider',true));registry.create(model());registry.create(provider('codex'));
    const service=new ModelRegistryService(store,{configurations:env('provider')});
    const list=service.list();assert.deepEqual(list.collisions,[{id:'provider',origins:['env','user']},{id:'codex',origins:['builtin','user']}]);
    assert.equal(list.entries.filter(entry=>entry.id==='provider').length,2);
    assert.throws(()=>service.get('provider'),error('REGISTRY_ID_CONFLICT',409));
    assert.throws(()=>service.disable('provider',{expectedRevision:1}),error('REGISTRY_ID_CONFLICT',409));
    assert.equal(service.usable('model'),false);assert.equal(service.usable('codex'),false);
  }finally{store.close();}
});

test('restart preserves finished evidence and turns unfinished intents unknown without port calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-registry-service-')),path=join(dir,'test.sqlite');let store=new Store(path);
  try{
    let service=new ModelRegistryService(store,{connection:()=>new Promise(()=>{})});service.create(provider());
    const localInput=request(service),local=await service.validate('provider',localInput);
    const input=request(service,'provider','pending','connection');void service.validate('provider',input);
    assert.equal(service.validations('provider')[1].state,'intent');store.close();store=new Store(path);
    let calls=0;service=new ModelRegistryService(store,{connection:async()=>{calls++;return {state:'passed'};}});
    assert.deepEqual(await service.validate('provider',localInput),local);
    const recovered=await service.validate('provider',input);assert.equal(recovered.state,'unknown');assert.equal(recovered.code,'REGISTRY_VALIDATION_UNKNOWN');
    assert.ok(recovered.finishedAt);assert.equal(calls,0);assert.equal(service.usable('provider'),false);
    assert.equal(new ModelRegistryService(store).validations('provider')[1].state,'unknown');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('port errors and raw result fields cannot leak credentials or grant availability',async()=>{
  for(const connection of [async()=>{throw new Error('sk-fixture-secret');},async()=>({state:'passed' as const,evidenceRefs:['sk-fixture-secret']}),async()=>({state:'passed' as const,raw:'sk-fixture-secret'})]){
    const {store,service}=fixture({connection});try{
      service.create(provider('provider',true));const result=await service.validate('provider',request(service,'provider','connection','connection'));
      assert.equal(result.state,'unknown');assert.equal(service.usable('provider'),false);
      assert.equal(JSON.stringify(service.validations('provider')).includes('sk-fixture-secret'),false);
      assert.equal(JSON.stringify(store.eventsAfter(0)).includes('sk-fixture-secret'),false);
      assert.throws(()=>service.create({...provider('secret'),label:'sk-fixture-secret'}),error('REGISTRY_CREDENTIAL_INPUT'));
    }finally{store.close();}
  }
});

test('edit during connection keeps historical evidence but does not validate new configuration',async()=>{
  let release!:(value:{state:'passed'})=>void;const {store,service}=fixture({connection:()=>new Promise(resolve=>{release=resolve;})});
  try{
    service.create(provider('provider',true));const input=request(service,'provider','pending','connection');const pending=service.validate('provider',input);
    service.update('provider',{expectedRevision:1,entry:{...provider('provider',true),label:'Changed'}});release({state:'passed'});
    assert.equal((await pending).revision,1);assert.equal(service.usable('provider'),false);
  }finally{store.close();}
});

test('validation rejects malformed wrappers and accessors without executing user code',async()=>{
  const {store,service}=fixture();try{
    service.create(provider());let calls=0;
    const getter={...request(service)};Object.defineProperty(getter,'kind',{enumerable:true,get(){calls++;return 'local';}});
    for(const input of [null,[],42,{},getter,{...request(service),expectedRevision:NaN},{...request(service),confirmed:true}]){
      await assert.rejects(service.validate('provider',input),error('INVALID_FIELDS'));
    }
    assert.equal(calls,0);assert.equal(service.validations('provider').length,0);
  }finally{store.close();}
});

test('cached native readiness is projected without turning builtin or API models into runtimes',async()=>{
  let calls=0;const {store,service}=fixture({nativeReadiness:{codex:{installation:{status:'found',version:'fixture'},authentication:'confirmed',connection:'ready'},claude:{installation:{status:'found',version:'fixture'},authentication:{checkedAt:'2026-10-29T00:00:00.000Z',authentication:'subscription',source:'claude.auth.status',issue:null}},actualModel:'unknown',liveValidation:'approval_required',costUsd:null,remainingQuota:null},connection:async()=>{calls++;return {state:'passed',evidenceRefs:['native:fixture']};}});
  try{
    assert.deepEqual(service.get('codex').nativeStatus,{installation:'found',authentication:'confirmed',connection:'ready'});
    assert.equal(service.get('claude-code').nativeStatus!.authentication,'subscription');assert.equal(calls,0);
    service.create({id:'native-provider',kind:'provider',label:'Native',enabled:true,connection:{adapterId:'codex',auth:{kind:'native_session'}}});
    service.create({id:'native-runtime',kind:'runtime',label:'Native runtime',enabled:true,providerId:'native-provider',adapterId:'codex'});
    service.create({id:'native-model',kind:'model',label:'Model declaration',enabled:true,providerId:'native-provider',modelId:'example'});
    assert.equal((await service.validate('native-model',request(service,'native-model','model'))).state,'unsupported');
    const result=await service.validate('native-runtime',request(service,'native-runtime','native','connection'));
    assert.deepEqual(result.evidenceRefs,['native:fixture']);assert.equal(service.usable('native-runtime'),true);assert.equal(calls,1);
    await assert.rejects(service.validate('codex',request(service,'codex')),error('REGISTRY_READ_ONLY',403));
  }finally{store.close();}
});

test('Bedrock references preserve source digests and returned entries cannot mutate projections',()=>{
  const configurations=readModelHubConfiguration(JSON.stringify([{id:'aws',label:'AWS',providerId:'bedrock',enabled:false,projectPaths:['/tmp/registry-project'],models:['example.model'],cliPath:'/usr/local/bin/aws',region:'us-east-1',credentialEnvs:{accessKeyId:'ORBIT_BEDROCK_ACCESS',secretAccessKey:'ORBIT_BEDROCK_SECRET',sessionToken:null},timeoutMs:1000,maxOutputTokens:100}]));
  const {store,service}=fixture({configurations});try{
    const view=service.get('aws');assert.equal(view.configDigest,configurations[0].configDigest);
    assert.deepEqual(view.authReferences,[{name:'ORBIT_BEDROCK_ACCESS',configured:false},{name:'ORBIT_BEDROCK_SECRET',configured:false}]);
    const entry=service.list().entries.find(e=>e.kind==='model'&&e.origin==='env')!;
    assert.equal(entry.kind==='model'&&entry.modelId,'example.model');
    if(view.kind==='provider'&&view.connection.adapterId==='bedrock')view.connection.region='eu-west-1';
    assert.equal(service.get('aws').configDigest,configurations[0].configDigest);
  }finally{store.close();}
});

test('unsupported connection never invokes injected port; latest failed connection supersedes passed',async()=>{
  let calls=0;const {store,service}=fixture({connection:async()=>({state:++calls===1?'passed':'failed'})});try{
    service.create({id:'web-provider',kind:'provider',label:'Web',enabled:true,connection:{adapterId:'web',auth:{kind:'declared',method:'unknown'}}});
    assert.equal((await service.validate('web-provider',request(service,'web-provider','web','connection'))).state,'unsupported');assert.equal(calls,0);
    service.create(provider('provider',true));await service.validate('provider',request(service,'provider','first','connection'));assert.equal(service.usable('provider'),true);
    const failure=await service.validate('provider',request(service,'provider','second','connection'));
    assert.equal(failure.code,'REGISTRY_VALIDATION_FAILED');assert.equal(service.usable('provider'),false);
    await service.validate('provider',request(service,'provider','local'));assert.equal(service.usable('provider'),false);
  }finally{store.close();}
});

test('parent edit rejects old child digest before dispatch',async()=>{
  let calls=0;const {store,service}=fixture({connection:async()=>{calls++;return {state:'passed'};}});try{
    service.create(provider('provider',true));service.create(model());const input=request(service,'model','child','connection');
    service.disable('provider',{expectedRevision:1});
    await assert.rejects(service.validate('model',input),error('REGISTRY_CONFIG_STALE',409));assert.equal(calls,0);assert.deepEqual(service.validations('model'),[]);
  }finally{store.close();}
});

test('late completion cannot replace recovered unknown and persistence failure never dispatches',async()=>{
  let release!:(value:{state:'passed'})=>void,calls=0;const {store,service}=fixture({connection:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  try{
    service.create(provider('provider',true));const input=request(service,'provider','pending','connection');const pending=service.validate('provider',input);
    const recovered=new ModelRegistryService(store);release({state:'passed'});
    assert.equal((await pending).state,'unknown');assert.equal(recovered.usable('provider'),false);assert.equal(calls,1);
    store.db.exec("CREATE TRIGGER fail_validation BEFORE INSERT ON registry_validations BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END");
    await assert.rejects(service.validate('provider',request(service,'provider','failure','connection')),/fixture persistence failure/);
    assert.equal(calls,1);assert.equal(service.validations('provider').length,1);
  }finally{store.close();}
});

test('configuration change at intent persistence blocks dispatch',async()=>{
  let calls=0;const {store,service}=fixture({connection:async()=>{calls++;return {state:'passed'};}});try{
    service.create(provider('provider',true));const input=request(service,'provider','change-at-intent','connection');
    store.db.exec(`CREATE TRIGGER change_at_intent AFTER INSERT ON registry_validations BEGIN
      UPDATE registry_entries SET revision=revision+1,enabled=0,body=json_set(body,'$.revision',revision+1,'$.enabled',json('false')) WHERE id='provider';
    END`);
    assert.equal((await service.validate('provider',input)).state,'unknown');assert.equal(calls,0);assert.equal(service.usable('provider'),false);
  }finally{store.close();}
});
