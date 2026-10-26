import test from 'node:test';
import assert from 'node:assert/strict';
import {readModelHubConfiguration,authorizeConfiguredRequest} from '../server/providers/model-hub-configuration.ts';

const projectPath=process.platform==='win32'?'C:\\Projects\\Fixture':'/projects/fixture';
const cliPath=process.platform==='win32'?'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe':'/opt/aws-cli/aws';
const raw=()=>({id:'bedrock',label:'Bedrock',providerId:'bedrock',enabled:false,projectPaths:[projectPath],models:['amazon.nova-micro-v1:0'],
  cliPath,region:'us-east-1',credentialEnvs:{accessKeyId:'ORBIT_BEDROCK_ACCESS_KEY',secretAccessKey:'ORBIT_BEDROCK_SECRET_KEY',sessionToken:null},timeoutMs:5000,maxOutputTokens:32});
const read=(patch:object={})=>readModelHubConfiguration(JSON.stringify([{...raw(),...patch}]))[0];

test('Bedrock config is inert and frozen, derives the regional endpoint, and binds all authority to its digest',()=>{
  const config=read();assert.equal(config.providerId,'bedrock');if(config.providerId!=='bedrock')throw new Error('wrong type');
  assert.equal(config.endpoint,'https://bedrock-runtime.us-east-1.amazonaws.com');assert.equal(config.locality,'external');
  assert.ok(Object.isFrozen(config.credentialEnvs));assert.equal(config.requireCredential,true);assert.equal(config.credentialEnv,null);
  for(const patch of [{cliPath:cliPath.replace('AWSCLIV2','AWSCLIV3').replace('/opt/','/other/')},{region:'eu-west-1'},{enabled:true},{maxOutputTokens:64},
    {credentialEnvs:{...raw().credentialEnvs,sessionToken:'ORBIT_BEDROCK_SESSION_TOKEN'}}]){
    assert.notEqual(read(patch).configDigest,config.configDigest);
  }
  const reversed=Object.fromEntries(Object.entries(raw()).reverse());assert.equal(readModelHubConfiguration(JSON.stringify([reversed]))[0].configDigest,config.configDigest);
});

test('Bedrock forbids endpoint/profile/region routing and executable or credential overrides',()=>{
  for(const patch of [{endpoint:'https://example.test'},{profile:'default'},{locality:'loopback'},{requireCredential:false},{credentialEnv:null},
    {region:'cn-north-1'},{region:'us-gov-west-1'},{region:'us-east-1 --debug'},{cliPath:'aws'},
    {cliPath:projectPath+(process.platform==='win32'?'\\aws.exe':'/aws')},{cliPath:cliPath.replace(/aws(?:\.exe)?$/,'aws.cmd')},
    {credentialEnvs:{...raw().credentialEnvs,accessKeyId:'AWS_ACCESS_KEY_ID'}},{credentialEnvs:{...raw().credentialEnvs,secretAccessKey:'ORBIT_BEDROCK_ACCESS_KEY'}},
    {credentialEnvs:{...raw().credentialEnvs,sessionToken:undefined}},{models:['us.anthropic.claude-example-v1:0']},{models:['arn:aws:bedrock:us-east-1:123:model/test']},
    {models:['global.anthropic.claude-example-v1:0']},{models:['amazon.nova/other']}])
    assert.throws(()=>read(patch),/^Error: MODEL_HUB_CONFIGURATION_INVALID$/,JSON.stringify(patch));
});

test('Bedrock reuses exact project/model/consent and outbound privacy gates',()=>{
  const config=read({enabled:true}),input={projectPath,expectedConfigDigest:config.configDigest,operation:'chat' as const,confirmed:true,model:'amazon.nova-micro-v1:0',messages:[{role:'user' as const,content:'ordinary text'}]};
  assert.equal(authorizeConfiguredRequest(config,input).allowed,true);
  for(const patch of [{confirmed:false},{projectPath:projectPath+'-other'},{model:'us.amazon.nova-micro-v1:0'},{messages:[{role:'user' as const,content:'person@example.invalid'}]}])
    assert.equal(authorizeConfiguredRequest(config,{...input,...patch}).allowed,false);
  assert.equal(authorizeConfiguredRequest({...config},input).allowed,false);
});
