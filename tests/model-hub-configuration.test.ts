import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {readModelHubConfiguration,authorizeConfiguredRequest,type ConfiguredModelHubRequest} from '../server/providers/model-hub-configuration.ts';

const projectPath=process.platform==='win32'?'C:\\Projects\\Fixture':'/projects/fixture';
const configuration=()=>({id:'fixture',label:'Fixture local model',providerId:'local',endpoint:'http://127.0.0.1:8000/v1',locality:'loopback',enabled:true,
  projectPaths:[projectPath],models:['fixture-model'],requireCredential:false,credentialEnv:null,timeoutMs:1000,maxOutputTokens:1024});
const read=(patch:object={})=>readModelHubConfiguration(JSON.stringify([{...configuration(),...patch}]))[0];
function request(digest:string,patch:Partial<ConfiguredModelHubRequest>={}):ConfiguredModelHubRequest{return {projectPath,expectedConfigDigest:digest,operation:'chat',confirmed:true,model:'fixture-model',messages:[{role:'user',content:'ordinary text'}],...patch};}

test('unset configuration is empty and valid configuration is inert, detached, frozen and digest-bound',t=>{
  for(const raw of [undefined,'',' \n ']){const empty=readModelHubConfiguration(raw);assert.deepEqual(empty,[]);assert.ok(Object.isFrozen(empty));}
  t.mock.method(http,'request',()=>{throw new Error('UNEXPECTED_HTTP');});t.mock.method(https,'request',()=>{throw new Error('UNEXPECTED_HTTPS');});t.mock.method(dns,'lookup',()=>{throw new Error('UNEXPECTED_DNS');});
  const source=configuration(),raw=JSON.stringify([source]),configs=readModelHubConfiguration(raw),config=configs[0];source.models.push('changed');
  assert.ok(Object.isFrozen(configs));assert.ok(Object.isFrozen(config));assert.ok(Object.isFrozen(config.models));assert.ok(Object.isFrozen(config.projectPaths));
  assert.deepEqual(config.models,['fixture-model']);assert.match(config.configDigest,/^[a-f0-9]{64}$/);assert.equal(readModelHubConfiguration(raw)[0].configDigest,config.configDigest);
});

test('a trusted enabled config authorizes explicit project-scoped models and clean chat snapshots',()=>{
  const config=read();assert.deepEqual(authorizeConfiguredRequest(config,{projectPath,expectedConfigDigest:config.configDigest,operation:'models',confirmed:true}),{allowed:true});
  const input=request(config.configDigest),result=authorizeConfiguredRequest(config,input);assert.equal(result.allowed,true);
  if(result.allowed){assert.deepEqual(result.messages,[{role:'user',content:'ordinary text'}]);assert.ok(Object.isFrozen(result.messages));assert.ok(Object.isFrozen(result.messages![0]));}
  (input.messages as {role:'user';content:string}[])[0].content='changed later';if(result.allowed)assert.equal(result.messages![0].content,'ordinary text');
});

test('all configuration fields contribute to a canonical digest including limits, policy and credential reference',()=>{
  const config=read();for(const patch of [{label:'Other'},{endpoint:'http://127.0.0.1:8001/v1'},{enabled:false},{models:['another']},{projectPaths:[]},
    {timeoutMs:2000},{maxOutputTokens:2048},{credentialEnv:'ORBIT_MODEL_KEY_SYNTHETIC'},{requireCredential:true,credentialEnv:'ORBIT_MODEL_KEY_SYNTHETIC'},
    {providerId:'vllm'},{locality:'external',endpoint:'https://models.example.test/v1'}])assert.notEqual(read(patch).configDigest,config.configDigest);
  const reversed=Object.fromEntries(Object.entries(configuration()).reverse());assert.equal(readModelHubConfiguration(JSON.stringify([reversed]))[0].configDigest,config.configDigest);
  assert.equal(config.configDigest,createHash('sha256').update(JSON.stringify(configuration())).digest('hex'),'adding provider kinds preserves the prior HTTP canonical configuration digest');
});

test('malformed, unknown, duplicate and unbounded configuration rejects with fixed diagnostics',()=>{
  for(const raw of ['{','{}','null',JSON.stringify([configuration(),configuration()]),JSON.stringify(Array.from({length:17},(_,index)=>({...configuration(),id:'config-'+index})))])
    assert.throws(()=>readModelHubConfiguration(raw),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/);
  for(const patch of [{extra:true},{timeoutMs:999},{timeoutMs:60001},{timeoutMs:null},{maxOutputTokens:0},{maxOutputTokens:8193},{maxOutputTokens:1.5},
    {models:[]},{models:['fixture-model','fixture-model']},{models:Array.from({length:101},(_,index)=>'model-'+index)},
    {projectPaths:Array(33).fill(projectPath)},{projectPaths:[projectPath,projectPath]},{enabled:'true'},{requireCredential:undefined}])
    assert.throws(()=>read(patch),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/);
});

test('unsupported provider kinds and secret-bearing public config are never accepted as future working connections',()=>{
  for(const providerId of ['codex','claude','unknown'])assert.throws(()=>read({providerId}),/^Error: MODEL_HUB_PROVIDER_UNSUPPORTED$/);
  assert.throws(()=>read({providerId:'bedrock'}),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/,'Bedrock requires its own strict configuration');
  for(const patch of [{id:'ghp_SYNTHETIC'},{label:'api_key=synthetic'},{models:['sk-synthetic-model']},{projectPaths:[projectPath+'/sk-synthetic']},
    {endpoint:'https://sk-synthetic.example.test/v1',locality:'external'},{credentialEnv:'OPENAI_API_KEY'},{credentialEnv:'ORBIT_MODEL_KEY_'},
    {requireCredential:true,credentialEnv:null},{credentialEnv:'ORBIT_MODEL_KEY_'+ 'A'.repeat(51)}])
    assert.throws(()=>read(patch),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/);
});

test('endpoint restrictions match the native transport and project paths are canonical lexical absolute names only',()=>{
  for(const endpoint of ['http://user:synthetic@127.0.0.1/v1','http://127.0.0.1/v1?key=synthetic','http://127.0.0.1/v1#part',
    'http://127.1/v1','http://localhost/v1','http://127.0.0.1/a/../v1','http://127.0.0.1/%2e/v1'])
    assert.throws(()=>read({endpoint}),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/);
  for(const endpoint of ['http://external.example.test/v1','https://127.0.0.1/v1','https://[::ffff:127.0.0.1]/v1','https://models.internal/v1'])
    assert.throws(()=>read({endpoint,locality:'external'}),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/);
  for(const path of ['relative','/projects/../other','/projects/./fixture','/projects//fixture','/projects/fixture/','C:\\Projects\\..\\other','C:/Projects/Fixture','\\\\server\\share','C:\\Projects\\NUL','C:\\Projects\\file:stream'])
    assert.throws(()=>read({projectPaths:[path]}),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/);
});

test('authorization gates precede reading message content and forged config copies cannot authorize anything',()=>{
  const config=read();let inspected=0;const dangerous=new Proxy([],{get(){inspected++;throw new Error('SYNTHETIC_PRIVATE_DETAILS');},getPrototypeOf(){inspected++;throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
  for(const patch of [{projectPath:'/foreign'},{expectedConfigDigest:'0'.repeat(64)},{confirmed:false},{model:'foreign-model'}])
    assert.deepEqual(authorizeConfiguredRequest(config,request(config.configDigest,{messages:dangerous,...patch})),{allowed:false,code:'MODEL_HUB_REQUEST_DENIED'});
  const disabled=read({enabled:false});assert.equal(authorizeConfiguredRequest(disabled,request(disabled.configDigest,{messages:dangerous})).allowed,false);assert.equal(inspected,0);
  assert.equal(authorizeConfiguredRequest({...config},request(config.configDigest)).allowed,false);
});

test('every message role blocks credential and personal-data patterns with no original text in denials',()=>{
  const config=read();for(const role of ['system','user','assistant'] as const)for(const content of ['api_key=synthetic-secret','glpat-SYNTHETIC','person@example.test','010-1234-5678','900101-1234567']){
    const decision=authorizeConfiguredRequest(config,request(config.configDigest,{messages:[{role,content}]}));
    assert.deepEqual(decision,{allowed:false,code:'MODEL_HUB_REQUEST_DENIED'});assert.equal(JSON.stringify(decision).includes(content),false);
  }
});

test('models rejects chat fields and chat rejects missing, extra, malformed, accessor or inherited fields',()=>{
  const config=read(),base={projectPath,expectedConfigDigest:config.configDigest,operation:'models' as const,confirmed:true};
  assert.equal(authorizeConfiguredRequest(config,{...base,model:'fixture-model'}).allowed,false);
  assert.equal(authorizeConfiguredRequest(config,{...base,messages:[]}).allowed,false);
  for(const patch of [{model:undefined},{messages:undefined},{messages:[]},{messages:[{role:'tool',content:'ordinary'}]},{messages:[{role:'user',content:'ordinary',extra:true}]},{endpoint:'http://127.0.0.1:1'}])
    assert.equal(authorizeConfiguredRequest(config,{...request(config.configDigest),...patch} as ConfiguredModelHubRequest).allowed,false);
  let accessed=false;const input=request(config.configDigest);Object.defineProperty(input,'confirmed',{get(){accessed=true;return true;}});
  assert.equal(authorizeConfiguredRequest(config,input).allowed,false);assert.equal(accessed,false);
  assert.equal(authorizeConfiguredRequest(config,Object.create(request(config.configDigest))).allowed,false);
});

test('project matching follows native Windows case semantics without granting parent or child paths',()=>{
  const config=read();for(const path of [projectPath+'/child',projectPath+'-other'])assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{projectPath:path})).allowed,false);
  if(process.platform==='win32')assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{projectPath:projectPath.toLowerCase()})).allowed,true);
  const denied=read({projectPaths:[]});assert.equal(authorizeConfiguredRequest(denied,request(denied.configDigest)).allowed,false);
});

test('cross-message credential assignments and nested content accessors fail without exposing their values',()=>{
  const config=read();assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{messages:[{role:'system',content:'api_key='},{role:'user',content:'synthetic-cross-message-value'}]})).allowed,false);
  let accessed=false;const message={role:'user'};Object.defineProperty(message,'content',{enumerable:true,get(){accessed=true;return 'SYNTHETIC_PRIVATE';}});
  assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{messages:[message as {role:'user';content:string}]})).allowed,false);assert.equal(accessed,false);
});

test('message count, cumulative character and serialized byte limits are explicit and never truncate input',()=>{
  const config=read();assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{messages:Array.from({length:100},()=>({role:'user' as const,content:'ordinary'}))})).allowed,true);
  assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{messages:Array.from({length:101},()=>({role:'user' as const,content:'ordinary'}))})).allowed,false);
  const accepted=authorizeConfiguredRequest(config,request(config.configDigest,{messages:[{role:'user',content:'x'.repeat(64000)}]}));
  assert.equal(accepted.allowed,true);if(accepted.allowed)assert.equal(accepted.messages![0].content.length,64000);
  for(const content of ['x'.repeat(64001),'\0'.repeat(64000)])assert.equal(authorizeConfiguredRequest(config,request(config.configDigest,{messages:[{role:'user',content}]})).allowed,false);
});

test('maximum configured limits and credential references remain metadata and never imply a provider is connected',()=>{
  const configs=readModelHubConfiguration(JSON.stringify(Array.from({length:16},(_,index)=>({...configuration(),id:'config-'+index,timeoutMs:60000,maxOutputTokens:8192,
    models:Array.from({length:100},(_,model)=>'model-'+model),requireCredential:true,credentialEnv:'ORBIT_MODEL_KEY_SYNTHETIC_ONLY'}))));
  assert.equal(configs.length,16);assert.equal(configs[0].models.length,100);assert.equal(configs[0].credentialEnv,'ORBIT_MODEL_KEY_SYNTHETIC_ONLY');
  assert.equal('credential' in configs[0],false);assert.equal('connected' in configs[0],false);
});
