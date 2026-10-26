import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from './temp.ts';
import {join} from 'node:path';
const processModule=await import('../server/providers/bedrock-process.ts').catch(()=>null);
function api(){assert.ok(processModule,'bounded Bedrock subprocess must exist');return processModule;}
const request=(script:string)=>({executable:process.execPath,args:['-e',script],cwd:mkdtempSync(join(tmpdir(),'orbit-bedrock-process-')),env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},timeoutMs:2000,maxStdoutBytes:4096,maxStderrBytes:4096});
test('real Node stdout/stderr remain separate and nonzero status is preserved',async()=>{const got=await api().invokeBedrockProcess(request("process.stdout.write('json');process.stderr.write('private diagnostic');process.exitCode=7"));assert.equal(got.stdout.toString(),'json');assert.equal(got.stderr.toString(),'private diagnostic');assert.equal(got.exitCode,7);});
test('real Node timeout/abort/overflow wait for child close without publishing successful output',async()=>{
  const timed=await api().invokeBedrockProcess({...request('setTimeout(()=>{},30000)'),timeoutMs:50});assert.equal(timed.timedOut,true);
  const abort=new AbortController(),pending=api().invokeBedrockProcess({...request('setTimeout(()=>{},30000)'),signal:abort.signal});setTimeout(()=>abort.abort(),40);assert.equal((await pending).aborted,true);
  const overflow=await api().invokeBedrockProcess({...request("process.stdout.write('x'.repeat(10000))"),maxStdoutBytes:10});assert.equal(overflow.overflow,true);assert.ok(overflow.stdout.length<=10);
});
