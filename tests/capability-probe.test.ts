import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ChildProcess,SpawnOptions} from 'node:child_process';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeVersionProbe,createNativeProbeService,type NativeProbeReport} from '../server/capability-probe.ts';

const root=join(tmpdir(),'orbit-native-fixture'),codex=join(root,'codex.exe'),claude=join(root,'claude.exe');
function child(output:string,code=0,stderr=''){
  const process=new EventEmitter() as EventEmitter&{stdout:EventEmitter;stderr:EventEmitter;kill:()=>boolean};
  process.stdout=new EventEmitter();process.stderr=new EventEmitter();process.kill=()=>{queueMicrotask(()=>process.emit('close',null));return true;};
  queueMicrotask(()=>{process.stdout.emit('data',Buffer.from(output));if(stderr)process.stderr.emit('data',Buffer.from(stderr));process.emit('close',code);});
  return process as unknown as ChildProcess;
}
function fixture(){
  const calls:{executable:string;args:string[];options:SpawnOptions}[]=[];
  const probe=createNativeVersionProbe({findCodex:()=>codex,path:['', '.',root].join(delimiter),isFile:path=>path===codex||path===claude,
    env:{PATH:root,OPENAI_API_KEY:'SYNTHETIC_PRIVATE',NODE_OPTIONS:'--unsafe-fixture'},
    spawn:(executable,args,options)=>{calls.push({executable,args,options});return child(executable===codex?'codex-cli 0.164.0\n':'2.1.31 (Claude Code)\n');}});
  return {probe,calls};
}
test('probe creation and cache reads never run a process; explicit probe runs native --version with safe fixed options',async()=>{
  const {probe,calls}=fixture();const service=createNativeProbeService(probe);assert.equal(service.get(),null);assert.equal(calls.length,0);
  const report=await service.refresh();assert.equal(calls.length,2);assert.deepEqual(report.codex,{status:'found',version:'0.164.0'});assert.deepEqual(report.claude,{status:'found',version:'2.1.31'});
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
  for(const call of calls){assert.deepEqual(call.args,['--version']);assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.deepEqual(call.options.stdio,['ignore','pipe','pipe']);assert.equal(call.options.env?.OPENAI_API_KEY,undefined);assert.equal(call.options.env?.NODE_OPTIONS,undefined);}
  assert.equal(JSON.stringify(report).includes(root),false);assert.equal(JSON.stringify(report).includes('SYNTHETIC'),false);
});
test('Claude discovery ignores empty or relative PATH entries, wrappers and directories',async()=>{
  const checked:string[]=[];let spawned=0;
  const probe=createNativeVersionProbe({findCodex:()=>{throw new Error('CODEX_NOT_INSTALLED');},path:['','.','relative',root].join(delimiter),isFile:path=>{checked.push(path);return false;},spawn:()=>{spawned++;return child('unexpected');}});
  assert.deepEqual((await probe()).claude,{status:'not_found_on_path',version:null});assert.equal(spawned,0);assert.deepEqual(checked,[claude]);
});
test('finder and spawn errors, non-native paths and nonzero exit expose only fixed statuses',async()=>{
  for(const native of ['codex.cmd','codex.exe',join(root,'codex.cmd')]){
    let spawned=0;const report=await createNativeVersionProbe({findCodex:()=>native,path:'',isFile:()=>true,spawn:()=>{spawned++;return child('codex-cli 0.164.0');}})();
    assert.equal(spawned,0);assert.notEqual(report.codex.status,'found');assert.equal(report.codex.version,null);
  }
  for(const spawn of [()=>{throw new Error('SYNTHETIC_PRIVATE_DETAILS');},()=>child('codex-cli 0.164.0',1,'SYNTHETIC_PRIVATE_DETAILS')]){
    const report=await createNativeVersionProbe({findCodex:()=>codex,path:'',isFile:()=>true,spawn})();assert.deepEqual(report.codex,{status:'failed',version:null});assert.equal(JSON.stringify(report).includes('SYNTHETIC'),false);
  }
});
test('only exact product-version ASCII output is accepted and stderr never becomes version data',async()=>{
  for(const output of ['0.164.0','codex-cli 0.164.0\napi_key=synthetic-private','codex-cli 0.164.0\u001b[0m','codex-cli 0.164.0 SECRET','claude 2.1.31','codex-cli 0.164.0-..','codex-cli 0.164.0-01','codex-cli 0.164.0+..']){
    const report=await createNativeVersionProbe({findCodex:()=>codex,path:'',isFile:()=>true,spawn:()=>child(output)})();assert.deepEqual(report.codex,{status:'unknown',version:null});
  }
  const report=await createNativeVersionProbe({findCodex:()=>codex,path:'',isFile:()=>true,spawn:()=>child('codex-cli 0.164.0\n',0,'SYNTHETIC_PRIVATE_DETAILS')})();assert.equal(report.codex.version,'0.164.0');assert.equal(JSON.stringify(report).includes('SYNTHETIC'),false);
  const prerelease=await createNativeVersionProbe({findCodex:()=>codex,path:'',isFile:()=>true,spawn:()=>child('codex-cli 1.2.3-beta.1+build.9\n')})();assert.equal(prerelease.codex.version,'1.2.3-beta.1+build.9');
});
test('aggregate stdout/stderr overflow terminates the child without disclosing raw bytes',async()=>{
  let killed=0;
  const report=await createNativeVersionProbe({findCodex:()=>codex,path:'',isFile:()=>true,spawn:()=>{const process=child('codex-cli 0.164.0',0,'SYNTHETIC_PRIVATE'.repeat(300));process.kill=()=>{killed++;return true;};return process;}})();
  assert.equal(report.codex.status,'failed');assert.equal(killed,1);assert.equal(JSON.stringify(report).includes('SYNTHETIC'),false);
});
test('native version timeout is bounded at three seconds and terminates only the spawned child',async()=>{
  let killed=0;const before=Date.now();
  const report=await createNativeVersionProbe({findCodex:()=>codex,path:'',isFile:()=>true,spawn:()=>{const process=new EventEmitter() as unknown as ChildProcess;Object.assign(process,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>{killed++;return true;}});return process;}})();
  assert.equal(report.codex.status,'failed');assert.equal(killed,1);assert.ok(Date.now()-before>=2900);assert.ok(Date.now()-before<5000);
});
test('service shares pending refresh, caches for sixty seconds and never exposes mutable cached reports',async()=>{
  let now=1000,calls=0,release!:(value:NativeProbeReport)=>void;
  const report:NativeProbeReport={checkedAt:new Date(now).toISOString(),codex:{status:'found',version:'0.164.0'},claude:{status:'not_found_on_path',version:null}};
  const service=createNativeProbeService(()=>{calls++;return new Promise(resolve=>{release=resolve;});},()=>now);
  assert.equal(service.get(),null);const first=service.refresh(),second=service.refresh();assert.equal(first,second);assert.equal(calls,1);release(report);const result=await first;
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.codex));report.codex.version='SYNTHETIC_PRIVATE';assert.equal(service.get()?.codex.version,'0.164.0');
  now+=59999;await service.refresh();assert.equal(calls,1);now++;assert.equal(service.get(),null);const third=service.refresh();assert.equal(calls,2);release({...result,checkedAt:new Date(now).toISOString()});await third;
});

test('cache normalizes probe exceptions and unexpected report strings without exposing raw details',async()=>{
  for(const probe of [async()=>{throw new Error('SYNTHETIC_PRIVATE_DETAILS');},async()=>({checkedAt:'SYNTHETIC_PRIVATE_DETAILS',codex:{status:'found',version:'SYNTHETIC_PRIVATE_DETAILS'},claude:{status:'failed',version:null}} as NativeProbeReport)]){
    const service=createNativeProbeService(probe);const report=await service.refresh();assert.equal(JSON.stringify(report).includes('SYNTHETIC'),false);assert.deepEqual(report.codex,{status:'unknown',version:null});
  }
});
