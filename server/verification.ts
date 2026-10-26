import { lstatSync } from 'node:fs';
import { basename,isAbsolute } from 'node:path';
import { command as runCommand } from '../scripts/orbit/process.ts';
import { readDataRecord } from './guardrails/outbound.ts';
import { containsCredential,safeText } from './privacy.ts';

/** Trusted server approval configuration only. Never build this from browser input.
 * Commands are not a sandbox: the host owns authorization and authoritative cwd validation.
 */
export interface VerificationCommand {id:string;label:string;executable:string;args:string[];timeoutMs:number}
export interface VerificationContext {workspaceId:string;cwd:string;baseSha:string;fingerprint:()=>string;signal?:AbortSignal}
export type VerificationStatus='passed'|'failed'|'interrupted'|'timed_out'|'stale';
export interface VerificationResult {
  commandId:string;workspaceId:string;baseSha:string;sourceDigest:string|null;finishedDigest:string|null;
  startedAt:string;durationMs:number;exitCode:number|null;status:VerificationStatus;output:string;
}
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const digestPattern=/^[a-f0-9]{64}$/;

export function validateVerificationCommand(input:VerificationCommand):VerificationCommand {
  try{
    const data=readDataRecord(input,['id','label','executable','args','timeoutMs']);
    if(!data||typeof data.id!=='string'||!idPattern.test(data.id)||data.id.length>64||containsCredential(data.id)
      ||typeof data.label!=='string'||!data.label.trim()||data.label.length>120||/[\x00-\x1f\x7f]/.test(data.label)||containsCredential(data.label)
      ||typeof data.executable!=='string'||!isAbsolute(data.executable)||data.executable.includes('\0')||!lstatSync(data.executable).isFile()
      ||/\.(?:bat|cmd|ps1|sh)$/i.test(data.executable)||/^(?:cmd|command|powershell|pwsh|bash|sh|zsh|fish|csh|ksh|dash)(?:\.exe|\.com)?$/i.test(basename(data.executable))
      ||!Number.isSafeInteger(data.timeoutMs)||Number(data.timeoutMs)<1||Number(data.timeoutMs)>300000
      ||!Array.isArray(data.args)||data.args.length>64||Object.getPrototypeOf(data.args)!==Array.prototype)throw new Error();
    const descriptors=Object.getOwnPropertyDescriptors(data.args),args:string[]=[];
    if(Reflect.ownKeys(data.args).length!==data.args.length+1)throw new Error();
    let length=0;
    for(let index=0;index<data.args.length;index++){
      const descriptor=descriptors[String(index)];
      if(!descriptor||!('value' in descriptor)||typeof descriptor.value!=='string'||descriptor.value.length>4096||descriptor.value.includes('\0'))throw new Error();
      args.push(descriptor.value);length+=descriptor.value.length;
    }
    if(length>64000)throw new Error();
    Object.freeze(args);
    return Object.freeze({id:data.id,label:data.label,executable:data.executable,args,timeoutMs:data.timeoutMs as number});
  }catch{throw new Error('INVALID_VERIFICATION_COMMAND');}
}
function validatedContext(input:VerificationContext):VerificationContext {
  try{
    const keys=['workspaceId','cwd','baseSha','fingerprint'];
    if(input&&Object.hasOwn(input,'signal'))keys.push('signal');
    const data=readDataRecord(input,keys);
    if(!data||typeof data.workspaceId!=='string'||!idPattern.test(data.workspaceId)||containsCredential(data.workspaceId)
      ||typeof data.cwd!=='string'||!isAbsolute(data.cwd)||data.cwd.includes('\0')||!lstatSync(data.cwd).isDirectory()
      ||typeof data.baseSha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(data.baseSha)
      ||typeof data.fingerprint!=='function'||(data.signal!==undefined&&!(data.signal instanceof AbortSignal)))throw new Error();
    return Object.freeze({workspaceId:data.workspaceId,cwd:data.cwd,baseSha:data.baseSha,fingerprint:data.fingerprint as ()=>string,...(data.signal?{signal:data.signal as AbortSignal}:{})});
  }catch{throw new Error('INVALID_VERIFICATION_CONTEXT');}
}
function fingerprint(context:VerificationContext):string|null {
  try{const digest=context.fingerprint();return typeof digest==='string'&&digestPattern.test(digest)?digest:null;}catch{return null;}
}

/** Explicit user-started execution only. No recorder sees transient process output.
 * Evidence becomes stale if either SHA-256 snapshot cannot be read or has changed.
 * Persisted approval, source hashing and execution concurrency are the caller's responsibility.
 */
export async function runVerification(input:VerificationCommand,inputContext:VerificationContext):Promise<VerificationResult>{
  const command=validateVerificationCommand(input),context=validatedContext(inputContext),start=Date.now();
  const result:VerificationResult={commandId:command.id,workspaceId:context.workspaceId,baseSha:context.baseSha,
    sourceDigest:fingerprint(context),finishedDigest:null,startedAt:new Date(start).toISOString(),durationMs:0,exitCode:null,status:'stale',output:''};
  if(result.sourceDigest===null){result.output='VERIFICATION_FINGERPRINT_UNAVAILABLE';result.durationMs=Date.now()-start;return result;}
  try{
    const processResult=await runCommand(command.executable,command.args,context.cwd,undefined,command.timeoutMs,context.signal);
    result.exitCode=processResult.exitCode;
    result.output=safeText(processResult.output);
    result.status=context.signal?.aborted&&processResult.exitCode===130?'interrupted':processResult.timedOut?'timed_out':processResult.exitCode===0?'passed':'failed';
  }catch{result.status='failed';result.output='VERIFICATION_PROCESS_FAILED';}
  result.finishedDigest=fingerprint(context);
  if(result.finishedDigest===null||result.sourceDigest!==result.finishedDigest)result.status='stale';
  result.durationMs=Date.now()-start;
  return result;
}
