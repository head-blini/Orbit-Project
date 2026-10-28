import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import type {ChildProcess} from 'node:child_process';
import {probeClaudeAuthentication,createClaudeAuthenticationService} from '../server/native-readiness.ts';
import type {ClaudeAuthenticationReport} from '../shared/native-readiness.ts';
const secret='SYNTHETIC_PRIVATE_email@example.test';
function child(output:string,code=0,stderr=''){
 const process=new EventEmitter() as EventEmitter&{stdout:EventEmitter;stderr:EventEmitter;kill:(signal?:string)=>boolean};
 process.stdout=new EventEmitter();process.stderr=new EventEmitter();process.kill=()=>{queueMicrotask(()=>process.emit('close',null,'SIGTERM'));return true;};
 queueMicrotask(()=>{process.stdout.emit('data',output);process.stderr.emit('data',stderr);process.emit('close',code,null);});return process as unknown as ChildProcess;
}
const probe=(output:string,code=0)=>probeClaudeAuthentication({findExecutable:()=>'/fake/claude',spawn:()=>child(output,code)});
test('explicit auth status uses isolated cwd, fixed arguments and filtered environment without exposing identity fields',async()=>{
 let cwd='';const report=await probeClaudeAuthentication({findExecutable:()=>'/fake/claude',env:{PATH:'/safe',HOME:'/home',ANTHROPIC_API_KEY:secret,CLAUDE_CODE_OAUTH_TOKEN:secret,NODE_OPTIONS:secret},spawn:(exe,args,options)=>{
  assert.equal(exe,'/fake/claude');assert.deepEqual(args,['auth','status']);assert.equal(options.shell,false);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
  cwd=String(options.cwd);assert.ok(existsSync(cwd));assert.notEqual(cwd,process.cwd());assert.equal(options.env!.ANTHROPIC_API_KEY,undefined);assert.equal(options.env!.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(options.env!.NODE_OPTIONS,undefined);
  return child(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:secret,organization:secret,token:secret}),0,secret);
 }});
 assert.equal(report.authentication,'subscription');assert.equal(report.source,'claude.auth.status');assert.equal(JSON.stringify(report).includes(secret),false);assert.equal(existsSync(cwd),false);
});
test('auth projection distinguishes unauthenticated, paid/API paths, OAuth ambiguity and malformed responses',async()=>{
 for(const [data,expected,code] of [
  [{loggedIn:false},'not_authenticated',1],[{loggedIn:true,authMethod:'none'},'not_authenticated',0],
  ...['api_key','api_key_helper','third_party','oauth_token'].map(authMethod=>[{loggedIn:true,authMethod},'unsupported',0]),
  [{loggedIn:true},'unknown',0],[{loggedIn:'true',authMethod:'claude.ai'},'unknown',0],
  [{loggedIn:true,authMethod:'claude.ai'},'unknown',1],
 ] as const)assert.equal((await probe(JSON.stringify(data),code as number)).authentication,expected);
 for(const text of ['',secret,'null','[]','{}','{"loggedIn":true} trailing'])assert.equal((await probe(text)).authentication,'unknown');
 assert.equal((await probe('{"loggedIn":true,"authMethod":"claude.ai"}',2)).issue,'AUTH_PROBE_FAILED');
});
test('missing executable, spawn failures and raw diagnostics only return safe fixed codes',async()=>{
 let calls=0;
 const missing=await probeClaudeAuthentication({findExecutable:()=>{throw Error('CLAUDE_NOT_INSTALLED');},spawn:()=>{calls++;throw Error(secret);}});
 assert.equal(missing.authentication,'not_installed');assert.equal(calls,0);
 for(const findExecutable of [()=>{throw Error(secret);},()=> 'relative/claude',()=>'/fake/claude']){
  const result=await probeClaudeAuthentication({findExecutable,spawn:()=>{throw Error(secret);}});assert.equal(result.authentication,'unknown');assert.equal(JSON.stringify(result).includes(secret),false);
 }
 const errored=await probeClaudeAuthentication({findExecutable:()=>'/fake/claude',spawn:()=>{const p=child('');queueMicrotask(()=>p.emit('error',Error(secret)));return p;}});
 assert.equal(errored.authentication,'unknown');assert.equal(JSON.stringify(errored).includes(secret),false);
});
test('aggregate output overflow stops only the spawned child and waits for termination',async()=>{
 let kills=0;const report=await probeClaudeAuthentication({findExecutable:()=>'/fake/claude',spawn:()=>{
  const p=child('x'.repeat(8193),0,'y'.repeat(8192));p.kill=()=>{kills++;return true;};return p;
 }});assert.equal(report.issue,'AUTH_OUTPUT_LIMIT');assert.equal(kills,1);
});
test('timeout escalates to hard kill and unconfirmed termination never becomes authentication evidence',async()=>{
 const signals:string[]=[],before=Date.now();
 const report=await probeClaudeAuthentication({findExecutable:()=>'/fake/claude',spawn:()=>{
  const p=new EventEmitter() as unknown as ChildProcess;Object.assign(p,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:(signal:string)=>{signals.push(signal);return true;}});return p;
 }});
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(report.issue,'AUTH_STOP_UNCONFIRMED');assert.equal(report.authentication,'unknown');assert.ok(Date.now()-before>=3000);
});
test('cache is inert, singleflight, expires after 60 seconds and strips injected unknown fields/errors',async()=>{
 let clock=0,calls=0,finish!:(r:ClaudeAuthenticationReport)=>void;
 const service=createClaudeAuthenticationService(()=>{calls++;return new Promise(resolve=>{finish=resolve;});},()=>clock);
 assert.equal(service.get(),null);assert.equal(calls,0);
 const first=service.refresh(),second=service.refresh();assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);
 finish({checkedAt:new Date(0).toISOString(),authentication:'subscription',source:'claude.auth.status',issue:secret,email:secret} as ClaudeAuthenticationReport);
 const report=await first;assert.equal(report.issue,'AUTH_PROBE_FAILED');assert.equal(JSON.stringify(report).includes(secret),false);assert.ok(Object.isFrozen(report));
 assert.equal(await service.refresh(),report);assert.equal(calls,1);clock=60000;assert.equal(service.get(),null);assert.equal(calls,1);
 const failed=createClaudeAuthenticationService(async()=>{throw Error(secret);},()=>clock);assert.equal((await failed.refresh()).issue,'AUTH_PROBE_FAILED');
 const malformed=createClaudeAuthenticationService(async()=>null as unknown as ClaudeAuthenticationReport,()=>clock);assert.equal((await malformed.refresh()).authentication,'unknown');
});

test('hard-kill exit is observed before returning the original overflow issue',async()=>{
 const signals:string[]=[];let exited=false;
 const report=await probeClaudeAuthentication({findExecutable:()=>'/fake/claude',spawn:()=>{
  const p=new EventEmitter() as unknown as ChildProcess;Object.assign(p,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:(signal:string)=>{signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>{exited=true;p.emit('close',null,'SIGKILL');});return true;}});
  queueMicrotask(()=>p.stdout!.emit('data','x'.repeat(16385)));return p;
 }});
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(exited,true);assert.equal(report.issue,'AUTH_OUTPUT_LIMIT');
});
