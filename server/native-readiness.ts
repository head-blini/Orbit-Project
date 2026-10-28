import {spawn as nativeSpawn,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {claudeEnv,findClaude} from './runtimes/claude-code.ts';
import type {ClaudeAuthentication,ClaudeAuthenticationReport} from '../shared/native-readiness.ts';
export interface ClaudeAuthenticationDependencies {
 findExecutable?:()=>string;spawn?:(executable:string,args:string[],options:SpawnOptions)=>ChildProcess;
 env?:NodeJS.ProcessEnv;now?:()=>number;
}
const statuses:ClaudeAuthentication[]=['subscription','not_authenticated','unsupported','unknown','not_installed'];
const issues=['CLAUDE_NOT_INSTALLED','AUTH_PROBE_FAILED','AUTH_OUTPUT_INVALID','AUTH_OUTPUT_LIMIT','AUTH_TIMEOUT','AUTH_STOP_UNCONFIRMED','AUTH_METHOD_UNSUPPORTED'];
/** Explicit read-only CLI probe. Never reads auth files or returns raw CLI output/errors. */
export async function probeClaudeAuthentication(dependencies:ClaudeAuthenticationDependencies={}):Promise<ClaudeAuthenticationReport>{
 const checkedAt=new Date((dependencies.now??Date.now)()).toISOString();
 const report=(authentication:ClaudeAuthentication,issue:string|null=null):ClaudeAuthenticationReport=>({checkedAt,authentication,source:'claude.auth.status',issue});
 let executable:string,env:NodeJS.ProcessEnv,cwd:string;
 try{env=claudeEnv(dependencies.env??process.env);executable=(dependencies.findExecutable??(()=>findClaude(env)))();if(!isAbsolute(executable))return report('unknown','AUTH_PROBE_FAILED');}
 catch(error){return error instanceof Error&&error.message==='CLAUDE_NOT_INSTALLED'?report('not_installed','CLAUDE_NOT_INSTALLED'):report('unknown','AUTH_PROBE_FAILED');}
 try{cwd=mkdtempSync(join(tmpdir(),'orbit-auth-status-'));}catch{return report('unknown','AUTH_PROBE_FAILED');}
 try{return await new Promise<ClaudeAuthenticationReport>(resolve=>{
  let child:ChildProcess,done=false,stopping:string|null=null,total=0;
  const chunks:Buffer[]=[],timers:NodeJS.Timeout[]=[];
  const finish=(value:ClaudeAuthenticationReport)=>{if(done)return;done=true;for(const timer of timers)clearTimeout(timer);resolve(value);};
  const stop=(issue:string)=>{
   if(done||stopping)return;stopping=issue;
   try{child.kill('SIGTERM');}catch{/* Only fixed issue codes leave this process. */}
   if(done)return;
   timers.push(setTimeout(()=>{
    try{child.kill('SIGKILL');}catch{/* Exit must still be observed. */}
    if(!done)timers.push(setTimeout(()=>finish(report('unknown','AUTH_STOP_UNCONFIRMED')),250));
   },250));
  };
  try{
   child=(dependencies.spawn??nativeSpawn)(executable,['auth','status'],{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
   const collect=(chunk:Buffer|string,stdout:boolean)=>{
    if(done||stopping)return;
    try{const bytes=Buffer.from(chunk);total+=bytes.length;if(total>16384){stop('AUTH_OUTPUT_LIMIT');return;}if(stdout)chunks.push(bytes);}catch{stop('AUTH_OUTPUT_INVALID');}
   };
   child.stdout?.on('data',chunk=>collect(chunk,true));child.stderr?.on('data',chunk=>collect(chunk,false));
   child.once('error',()=>{if(!child.pid)finish(report('unknown','AUTH_PROBE_FAILED'));else stop('AUTH_PROBE_FAILED');});
   child.once('close',(code,signal)=>{
    if(done)return;if(stopping){finish(report('unknown',stopping));return;}
    if(signal||code!==0&&code!==1){finish(report('unknown','AUTH_PROBE_FAILED'));return;}
    try{
     const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();
     const {loggedIn,authMethod}=data as Record<string,unknown>;
     if(loggedIn===false||authMethod==='none'){finish(report('not_authenticated'));return;}
     if(code===0&&loggedIn===true&&authMethod==='claude.ai'){finish(report('subscription'));return;}
     // OAuth token authentication alone does not establish a Claude subscription.
     if(loggedIn===true&&['api_key','api_key_helper','third_party','oauth_token'].includes(String(authMethod))){finish(report('unsupported','AUTH_METHOD_UNSUPPORTED'));return;}
     finish(report('unknown','AUTH_OUTPUT_INVALID'));
    }catch{finish(report('unknown','AUTH_OUTPUT_INVALID'));}
   });
   timers.push(setTimeout(()=>stop('AUTH_TIMEOUT'),3000));
  }catch{finish(report('unknown','AUTH_PROBE_FAILED'));}
 });}finally{try{rmSync(cwd,{recursive:true,force:true});}catch{/* Temporary path is never reported. */}}
}

/** Construction and GET never launch a probe. Explicit refresh is cached and singleflight. */
export function createClaudeAuthenticationService(probe:()=>Promise<ClaudeAuthenticationReport>=probeClaudeAuthentication,now:()=>number=Date.now){
 let cached:ClaudeAuthenticationReport|null=null,storedAt=0,pending:Promise<ClaudeAuthenticationReport>|null=null;
 const unknown=():ClaudeAuthenticationReport=>({checkedAt:new Date(now()).toISOString(),authentication:'unknown',source:'claude.auth.status',issue:'AUTH_PROBE_FAILED'});
 function clean(value:ClaudeAuthenticationReport):ClaudeAuthenticationReport{
  if(!value||!statuses.includes(value.authentication)||typeof value.checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checkedAt)||!Number.isFinite(Date.parse(value.checkedAt)))return Object.freeze(unknown());
  return Object.freeze({checkedAt:value.checkedAt,authentication:value.authentication,source:'claude.auth.status',issue:value.issue===null?null:issues.includes(value.issue)?value.issue:'AUTH_PROBE_FAILED'});
 }
 const get=()=>cached&&now()-storedAt>=0&&now()-storedAt<60000?cached:null;
 function refresh():Promise<ClaudeAuthenticationReport>{
  if(pending)return pending;const prior=get();if(prior)return Promise.resolve(prior);
  pending=Promise.resolve().then(probe).catch(unknown).then(value=>{cached=clean(value);storedAt=now();return cached;}).finally(()=>{pending=null;});return pending;
 }
 return Object.freeze({get,refresh});
}
