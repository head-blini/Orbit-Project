import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {randomUUID} from 'node:crypto';

const transport=await import('../server/providers/bedrock-transport.ts').catch(()=>null);
function api(){assert.ok(transport,'Bedrock transport must exist');return transport;}
const model='anthropic.claude-fixture-v1:0';
function fixture(){
  const tempRoot=mkdtempSync(join(tmpdir(),'orbit-bedrock-test-')),calls:any[]=[],states:string[]=[];let credentials=0,runtime=0;
  const config={providerId:'bedrock' as const,cliPath:process.platform==='win32'?'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe':'/usr/local/bin/aws',region:'us-east-1',approved:true,models:[model],timeoutMs:2000,maxOutputTokens:8,
    credential:()=>{credentials++;return {accessKeyId:'synthetic-access-key',secretAccessKey:'synthetic-secret-key',sessionToken:'synthetic-session-token'};},
    authorize:(request:any)=>request.operation==='models'?{allowed:true as const}:{allowed:true as const,messages:request.messages}};
  const deps={tempRoot,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,AWS_PROFILE:'forbidden-profile',AWS_ENDPOINT_URL:'https://forbidden.invalid',HTTPS_PROXY:'forbidden',HOME:'forbidden-home'},
    validateCli:()=>{runtime++;},invoke:async(request:any)=>{calls.push(request);
      const output=request.args[0]==='--version'?'aws-cli/2.31.0 Python/3.13 Windows/11 exe/AMD64\n':request.args[0]==='bedrock'?JSON.stringify({modelSummaries:[{modelId:model,outputModalities:['TEXT'],inferenceTypesSupported:['ON_DEMAND']},{modelId:'amazon.other-v1',outputModalities:['TEXT'],inferenceTypesSupported:['ON_DEMAND']}]}):JSON.stringify({output:{message:{role:'assistant',content:[{text:'Actual mock output'}]}},stopReason:'end_turn',usage:{inputTokens:2,outputTokens:3,totalTokens:5},metrics:{latencyMs:1}});
      return {stdout:Buffer.from(output),stderr:Buffer.alloc(0),exitCode:0,timedOut:false,aborted:false,overflow:false};}};
  return {tempRoot,calls,states,config,deps,get credentials(){return credentials;},get runtime(){return runtime;}};
}
async function events(provider:any,options:any){const found=[];for await(const event of provider.chat({model,messages:[{role:'user',content:'private prompt text'}]},options))found.push(event);return found;}

test('inert construction, exact consent before filesystem/env/process, and absent runtime before credential reads',async()=>{
  const m=api(),f=fixture();const denied=m.createBedrockProviderTransport({...f.config,authorize:()=>({allowed:false})},f.deps);
  assert.equal(f.runtime,0);assert.deepEqual(readdirSync(f.tempRoot),[]);
  await assert.rejects(denied.listModels(),/PROVIDER_OUTBOUND_DENIED/);await assert.rejects(events(denied,{requestId:randomUUID()}),/PROVIDER_OUTBOUND_DENIED/);
  assert.equal(f.runtime,0);assert.equal(f.credentials,0);assert.equal(f.calls.length,0);assert.deepEqual(readdirSync(f.tempRoot),[]);
  const absent=m.createBedrockProviderTransport(f.config,{...f.deps,validateCli:()=>{throw new Error('BEDROCK_CLI_NOT_FOUND');}});
  await assert.rejects(absent.listModels(),/BEDROCK_CLI_NOT_FOUND/);assert.equal(f.credentials,0);assert.equal(f.calls.length,0);
});

test('catalog and nonstream chat use isolated blank files, explicit env, bounded projection and cleanup before done',async()=>{
  const m=api(),f=fixture(),original=f.deps.invoke;let inspected=false;
  f.deps.invoke=async request=>{if(request.args[0]==='--version'){assert.equal(request.env.AWS_ACCESS_KEY_ID,undefined);assert.equal(f.credentials,f.calls.filter(call=>call.args[0]!=='--version').length);}
    else{assert.equal(request.env.AWS_PROFILE,undefined);assert.equal(request.env.AWS_ENDPOINT_URL,undefined);assert.equal(request.env.HTTPS_PROXY,undefined);
      assert.equal(request.env.AWS_MAX_ATTEMPTS,'1');assert.equal(request.env.AWS_EC2_METADATA_DISABLED,'true');assert.equal(readFileSync(request.env.AWS_CONFIG_FILE,'utf8'),'');assert.equal(readFileSync(request.env.AWS_SHARED_CREDENTIALS_FILE,'utf8'),'');assert.equal(readFileSync(request.env.BOTO_CONFIG,'utf8'),'');
      if(request.args[0]==='bedrock-runtime'){const input=request.args[request.args.indexOf('--cli-input-json')+1];const body=JSON.parse(readFileSync(input.slice(7),'utf8'));assert.equal(body.modelId,model);assert.equal(body.inferenceConfig.maxTokens,8);assert.equal(body.messages[0].content[0].text,'private prompt text');assert.ok(!request.args.join(' ').includes('private prompt'));inspected=true;}}
    return original(request);};
  const provider=m.createBedrockProviderTransport(f.config,f.deps);assert.deepEqual(await provider.listModels(),[model]);assert.deepEqual(readdirSync(f.tempRoot),[]);
  const requestId=randomUUID(),got=await events(provider,{requestId,onTemporaryInput:(state:string)=>f.states.push(state)});
  assert.equal(inspected,true);assert.deepEqual(got,[{type:'text',text:'Actual mock output'},{type:'done',usage:{promptTokens:2,completionTokens:3,totalTokens:5,source:'provider'}}]);assert.deepEqual(f.states,['present','removed']);assert.deepEqual(readdirSync(f.tempRoot),[]);
  assert.ok(!JSON.stringify(f.calls.map(c=>c.args)).includes('synthetic-secret'));
});

test('credential echo, malformed JSON, nontext output, output overage, missing usage and raw stderr fail safely',async()=>{
  const m=api();
  for(const mode of ['echo','invalid','tools','over','unknown','nonzero','oversize'] as const){const f=fixture(),original=f.deps.invoke;
    f.deps.invoke=async request=>{if(request.args[0]==='--version')return original(request);
      const value:any={output:{message:{role:'assistant',content:[{text:mode==='echo'?'synthetic-secret-key api_key=fixture-value sk-fixture':'text'}]}},stopReason:'end_turn'};
      if(mode==='tools')value.output.message.content=[{toolUse:{secret:'RAW_SECRET'}}];if(mode==='over')value.usage={outputTokens:9};
      return {stdout:Buffer.from(mode==='invalid'?'RAW_SECRET invalid json':mode==='oversize'?'x'.repeat(256*1024+1):JSON.stringify(value)),stderr:Buffer.from('RAW_SECRET stderr'),exitCode:mode==='nonzero'?7:0,timedOut:false,aborted:false,overflow:false};};
    const pending=events(m.createBedrockProviderTransport(f.config,f.deps),{requestId:randomUUID()});
    if(mode==='echo'){const got=await pending;assert.ok(!JSON.stringify(got).includes('synthetic-secret-key'));assert.ok(!JSON.stringify(got).includes('fixture-value'));}
    else if(mode==='unknown'){assert.deepEqual((await pending).at(-1),{type:'done',usage:{promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'}});}
    else await assert.rejects(pending,(error:any)=>/^PROVIDER_/.test(error.message)&&!error.message.includes('RAW_SECRET'));
    assert.deepEqual(readdirSync(f.tempRoot),[]);
  }
});

test('version 1, invalid request ID and pre-aborted signal cannot access credentials or start inference',async()=>{
  const m=api(),f=fixture();f.deps.invoke=async request=>{f.calls.push(request);return {stdout:Buffer.from('aws-cli/1.0.0'),stderr:Buffer.alloc(0),exitCode:0,timedOut:false,aborted:false,overflow:false};};
  const provider=m.createBedrockProviderTransport(f.config,f.deps);await assert.rejects(events(provider,{requestId:randomUUID()}),/BEDROCK_CLI_UNSUPPORTED/);assert.equal(f.credentials,0);
  await assert.rejects(events(provider,{requestId:'../not-a-uuid'}),/INVALID_PROVIDER_REQUEST/);const calls=f.calls.length;
  await assert.rejects(events(provider,{requestId:randomUUID(),signal:AbortSignal.abort()}),/PROVIDER_ABORTED/);assert.equal(f.calls.length,calls);assert.deepEqual(readdirSync(f.tempRoot),[]);
});

test('temporary cleanup refuses unexpected entries, hardlinks and forged ownership without deleting any files',async()=>{
  const m=api();
  for(const mode of ['extra','hardlink','marker'] as const){const f=fixture(),requestId=randomUUID(),original=f.deps.invoke;let directory='';
    f.deps.invoke=async request=>{if(request.args[0]==='bedrock-runtime'){directory=request.cwd;if(mode==='extra')writeFileSync(join(directory,'unowned.txt'),'user data');if(mode==='hardlink')linkSync(join(directory,'request.json'),join(f.tempRoot,'outside-link'));if(mode==='marker')writeFileSync(join(directory,'owner.json'),'{}');}return original(request);};
    await assert.rejects(events(m.createBedrockProviderTransport(f.config,f.deps),{requestId,onTemporaryInput:(state:string)=>f.states.push(state)}),/BEDROCK_CLEANUP_REQUIRED/);
    assert.ok(existsSync(join(directory,'request.json')));assert.equal(f.states.at(-1),'cleanup_required');assert.throws(()=>m.cleanupBedrockInput(requestId,f.deps),/BEDROCK_CLEANUP_REQUIRED/);
  }
  const f=fixture();m.cleanupBedrockInput(randomUUID(),f.deps);assert.deepEqual(readdirSync(f.tempRoot),[]);
});

test('abort after final text suppresses done and cleanup has already removed the raw request',async()=>{
  const m=api(),f=fixture(),abort=new AbortController(),iterator=m.createBedrockProviderTransport(f.config,f.deps).chat({model,messages:[{role:'user',content:'prompt'}]},{requestId:randomUUID(),signal:abort.signal});
  assert.equal((await iterator.next()).value?.type,'text');assert.deepEqual(readdirSync(f.tempRoot),[]);abort.abort();await assert.rejects(iterator.next(),/PROVIDER_ABORTED/);
});

test('model accessors cannot run at construction and dependency mutation cannot redirect cleanup',async()=>{
  const m=api(),f=fixture();let reads=0;const models=[model];Object.defineProperty(models,'0',{get(){reads++;return model;}});
  assert.throws(()=>m.createBedrockProviderTransport({...f.config,models},f.deps),/INVALID_PROVIDER_CONFIGURATION/);assert.equal(reads,0);
  const original=f.deps.invoke,root=f.tempRoot;f.deps.invoke=async request=>{const result=await original(request);if(request.args[0]==='bedrock-runtime')f.deps.tempRoot=mkdtempSync(join(tmpdir(),'orbit-bedrock-other-'));return result;};
  await events(m.createBedrockProviderTransport(f.config,f.deps),{requestId:randomUUID()});assert.deepEqual(readdirSync(root),[]);
});

test('overlapping known credential strings are masked whole rather than exposing a suffix',async()=>{
  const m=api(),f=fixture(),original=f.deps.invoke;f.config.credential=()=>({accessKeyId:'synthetic',secretAccessKey:'synthetic-secret-key',sessionToken:'synthetic-secret-key-session'});
  f.deps.invoke=async request=>request.args[0]==='--version'?original(request):{stdout:Buffer.from(JSON.stringify({output:{message:{role:'assistant',content:[{text:'synthetic-secret-key-session synthetic-secret-key synthetic'}]}},stopReason:'end_turn'})),stderr:Buffer.alloc(0),exitCode:0,timedOut:false,aborted:false,overflow:false};
  const got=await events(m.createBedrockProviderTransport(f.config,f.deps),{requestId:randomUUID()});assert.equal(got[0].text,'[REDACTED] [REDACTED] [REDACTED]');
});
