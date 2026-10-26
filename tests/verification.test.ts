import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { runVerification,type VerificationCommand,type VerificationContext } from '../server/verification.ts';

const digest='a'.repeat(64),baseSha='b'.repeat(40);
function fixture(source:string){
  const cwd=mkdtempSync(join(tmpdir(),'orbit-verification-')),script=join(cwd,'check.mjs');writeFileSync(script,source);
  const command:VerificationCommand={id:'fixture-check',label:'Fixture check',executable:process.execPath,args:[script],timeoutMs:2000};
  const context:VerificationContext={workspaceId:'fixture-workspace',cwd,baseSha,fingerprint:()=>digest};
  return {command,context,cwd};
}

test('executes only the supplied approved executable and arguments and reports actual exit evidence',async()=>{
  const f=fixture('console.log("verified");');
  const result=await runVerification(f.command,f.context);
  assert.equal(result.status,'passed');assert.equal(result.exitCode,0);assert.match(result.output,/verified/);
  assert.equal(result.commandId,f.command.id);assert.equal(result.workspaceId,f.context.workspaceId);assert.equal(result.baseSha,baseSha);
  assert.equal(result.sourceDigest,digest);assert.equal(result.finishedDigest,digest);assert.ok(Number.isFinite(Date.parse(result.startedAt)));assert.ok(result.durationMs>=0);
  assert.equal('args' in result,false);assert.equal('cwd' in result,false);assert.equal('executable' in result,false);
});

test('a real nonzero exit never becomes verification passed',async()=>{
  const f=fixture('console.error("synthetic failure");process.exit(7);');
  const result=await runVerification(f.command,f.context);
  assert.equal(result.status,'failed');assert.equal(result.exitCode,7);assert.match(result.output,/synthetic failure/);
});

test('validation snapshots command arguments before fingerprint callbacks can mutate original configuration',async()=>{
  const f=fixture('console.log("approved arguments");');
  const result=await runVerification(f.command,{...f.context,fingerprint:()=>{f.command.args.splice(0,f.command.args.length,'-e','console.log("MUTATED ARGUMENTS")');return digest;}});
  assert.equal(result.status,'passed');assert.match(result.output,/approved arguments/);assert.equal(result.output.includes('MUTATED ARGUMENTS'),false);
});

test('changed or unavailable fingerprints invalidate otherwise successful evidence',async()=>{
  const f=fixture('process.exit(0);');let calls=0;
  const stale=await runVerification(f.command,{...f.context,fingerprint:()=>++calls===1?digest:'c'.repeat(64)});
  assert.equal(stale.status,'stale');assert.equal(stale.exitCode,0);assert.notEqual(stale.sourceDigest,stale.finishedDigest);
  calls=0;
  const missing=await runVerification(f.command,{...f.context,fingerprint:()=>{if(++calls>1)throw new Error('SYNTHETIC_PRIVATE_DETAILS');return digest;}});
  assert.equal(missing.status,'stale');assert.equal(missing.finishedDigest,null);assert.equal(JSON.stringify(missing).includes('SYNTHETIC_PRIVATE_DETAILS'),false);
});

test('failed initial fingerprint does not start a process or disclose fingerprint values',async()=>{
  const f=fixture('import {writeFileSync} from "node:fs";writeFileSync("started","yes");');
  for(const fingerprint of [()=>{throw new Error('SYNTHETIC_PRIVATE_DETAILS');},()=> 'AWS_SECRET_ACCESS_KEY=synthetic-fixture']){
    const result=await runVerification(f.command,{...f.context,fingerprint});
    assert.equal(result.status,'stale');assert.equal(result.exitCode,null);assert.equal(result.sourceDigest,null);
    assert.equal(existsSync(join(f.cwd,'started')),false);assert.equal(JSON.stringify(result).includes('synthetic-fixture'),false);assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DETAILS'),false);
  }
});

test('timeout and explicit interruption terminate the owned process and remain distinct',async()=>{
  const f=fixture('setInterval(()=>{},1000);');
  const timed=await runVerification({...f.command,timeoutMs:80},f.context);
  assert.equal(timed.status,'timed_out');assert.equal(timed.exitCode,124);
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),80);
  try{const interrupted=await runVerification(f.command,{...f.context,signal:abort.signal});assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.exitCode,130);}finally{clearTimeout(timer);}
  const before=new AbortController();before.abort();
  const interrupted=await runVerification(f.command,{...f.context,signal:before.signal});assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.exitCode,130);
});

test('combined stdout and stderr redact synthetic credentials and never exceed 64k',async()=>{
  const f=fixture('console.log("AWS_SECRET_ACCESS_KEY=synthetic-output-secret");console.error("\\\"api_key\\\":\\\"synthetic-json-secret\\\"");console.log("glpat-SYNTHETICGITLABTOKEN");console.log("-----BEGIN PRIVATE KEY-----\\nSYNTHETIC_PRIVATE_BODY\\n-----END PRIVATE KEY-----");console.log("x".repeat(90000));');
  const result=await runVerification(f.command,f.context);
  assert.equal(result.status,'passed');assert.ok(result.output.length<=64000);
  for(const secret of ['synthetic-output-secret','synthetic-json-secret','SYNTHETICGITLABTOKEN','SYNTHETIC_PRIVATE_BODY'])assert.equal(result.output.includes(secret),false);
  assert.match(result.output,/REDACTED/);
});

test('command configuration rejects invalid identifiers, relative executables, shell scripts and unbounded inputs before spawn',async()=>{
  const f=fixture('process.exit(0);');const script=join(f.cwd,'test.cmd');writeFileSync(script,'@exit /b 0');
  for(const patch of [{id:'bad id'},{label:'api_key=synthetic-secret'},{executable:'node'},{executable:f.cwd},{executable:script},{args:['x'.repeat(4097)]},{args:Array(65).fill('x')},{args:['bad\0value']},{timeoutMs:0},{timeoutMs:300001},{timeoutMs:1.5},{shell:true}]){
    await assert.rejects(runVerification({...f.command,...patch} as VerificationCommand,f.context),/^Error: INVALID_VERIFICATION_COMMAND$/);
  }
  const accessor={...f.command};Object.defineProperty(accessor,'label',{get(){throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
  await assert.rejects(runVerification(accessor,f.context),/^Error: INVALID_VERIFICATION_COMMAND$/);
  await assert.rejects(runVerification(Object.create(f.command) as VerificationCommand,f.context),/^Error: INVALID_VERIFICATION_COMMAND$/);
  const args=[] as string[];Object.defineProperty(args,0,{get(){throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
  await assert.rejects(runVerification({...f.command,args},f.context),/^Error: INVALID_VERIFICATION_COMMAND$/);
});

test('invalid execution context returns fixed errors rather than raw details',async()=>{
  const f=fixture('process.exit(0);');
  for(const patch of [{workspaceId:'bad id'},{cwd:'.'},{cwd:join(f.cwd,'missing')},{baseSha:'not-a-commit'},{fingerprint:'raw details'}])await assert.rejects(runVerification(f.command,{...f.context,...patch} as VerificationContext),/^Error: INVALID_VERIFICATION_CONTEXT$/);
});
