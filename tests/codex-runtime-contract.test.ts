import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {codexArgs} from '../server/codex.ts';
import {compatibleRuntimeVersion} from '../server/capability-runtime-adapters.ts';
const evidence=JSON.parse(readFileSync(new URL('./fixtures/codex-0.165.0-contract.json',import.meta.url),'utf8'));
const previous=JSON.parse(readFileSync(new URL('./fixtures/codex-0.162.1-model-schema.json',import.meta.url),'utf8'));
const schema=(name:string)=>evidence.schemas[name].projection;

test('Codex 0.165.0 offline schema keeps prior model identity limits; allowlisting does not claim live execution',()=>{
 assert.equal(evidence.cliVersion,'0.165.0');assert.equal(evidence.evidenceKind,'offline_generated_contract_not_live_execution');
 for(const [name,entry] of Object.entries(previous.schemas) as [string,any][]){
  const current=schema(name),prior=entry.projection;
  assert.deepEqual(current.propertyNames,prior.propertyNames,name);
  for(const key of Object.keys(prior.properties??{}))assert.deepEqual(current.properties[key],prior.properties[key],name+'.'+key);
  for(const field of ['type','title','description','enum','required'])assert.deepEqual(current[field],prior[field],name+'.'+field);
 }
 for(const item of Object.values(evidence.schemas) as any[])assert.match(item.source.jsonSha256,/^[a-f0-9]{64}$/);
 assert.ok(!schema('Turn').propertyNames.includes('model'));assert.match(schema('Thread').properties.model.description,/not per-turn execution telemetry/);
 assert.equal(compatibleRuntimeVersion('codex','0.165.0'),true);assert.equal(compatibleRuntimeVersion('codex','0.165.1'),false);
});
test('generated request contracts retain exact Orbit session, policy, execution and interruption inputs',()=>{
 const methods:{[method:string]:string}={'initialize':'InitializeParams','thread/start':'ThreadStartParams','thread/resume':'ThreadResumeParams','turn/start':'TurnStartParams','turn/interrupt':'TurnInterruptParams','account/read':'GetAccountParams','config/read':'ConfigReadParams','mcpServerStatus/list':'ListMcpServerStatusParams'};
 for(const [method,name] of Object.entries(methods))assert.equal(evidence.requests.methods[method].$ref,'#/definitions/'+name);
 for(const name of ['ThreadStartParams','ThreadResumeParams'])for(const field of ['cwd','config','sandbox','approvalPolicy','approvalsReviewer','developerInstructions'])assert.ok(schema(name).propertyNames.includes(field),name+'.'+field);
 assert.deepEqual(schema('TurnStartParams').required,['input','threadId']);assert.deepEqual(schema('TurnInterruptParams').required,['threadId','turnId']);
 assert.ok(schema('TurnStartParams').propertyNames.includes('sandboxPolicy'));assert.ok(schema('ThreadResumeParams').propertyNames.includes('excludeTurns'));
 assert.ok(schema('ApprovalsReviewer').enum.includes('user'));
 assert.ok(schema('AskForApproval').oneOf.some((item:any)=>item.enum?.includes('untrusted')));
 for(const kind of ['readOnly','workspaceWrite'])assert.ok(schema('SandboxPolicy').oneOf.some((item:any)=>item.properties?.type?.enum?.includes(kind)));
 for(const field of ['threadId','detail','limit'])assert.ok(schema('ListMcpServerStatusParams').propertyNames.includes(field));
 assert.deepEqual(schema('ListMcpServerStatusParams').properties.detail.anyOf[0].$ref,'#/definitions/McpServerStatusDetail');
});
test('installed CLI accepts every Orbit restricted flag and offline feature projection records the exact enabled states',()=>{
 for(const write of [false,true]){
  const mode=evidence.featureFlags[write?'write':'read'];assert.match(mode.sourceSha256,/^[a-f0-9]{64}$/);
  const args=codexArgs(write);assert.deepEqual(args.slice(0,3),['app-server','--listen','stdio://']);
  for(let i=0;i<args.length;i++)if(args[i]==='--enable'||args[i]==='--disable')assert.equal(mode.values[args[i+1]],args[i]==='--enable',args[i+1]);
  assert.equal(mode.values.code_mode_host,write);assert.equal(mode.values.hooks,false);assert.equal(mode.values.plugins,false);assert.equal(mode.values.skill_mcp_dependency_install,false);
 }
});
