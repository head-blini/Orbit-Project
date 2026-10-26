import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildChildEnv } from '../../server/child-env.ts';
import { safeDiagnostic } from './policy.ts';

export interface CommandResult {command:string; args:string[]; cwd:string; exitCode:number; output:string; startedAt:string; durationMs:number; timedOut:boolean}
export type Recorder = (result:CommandResult)=>void;
export async function command(command:string,args:string[],cwd:string, record?:Recorder, timeoutMs=300_000,signal?:AbortSignal):Promise<CommandResult> {
  const start=Date.now();
  const result:CommandResult={command,args:[...args],cwd,exitCode:1,output:'',startedAt:new Date(start).toISOString(),durationMs:0,timedOut:false};
  if(signal?.aborted){result.exitCode=130;result.output='INTERRUPTED';record?.(result);return result;}
  return await new Promise(resolve => {
    const child=spawn(command,args,{cwd,env:{...buildChildEnv(),GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; let overflow=false, interrupted=false, stopping=false;
    const terminate=()=>{
      if(stopping)return;stopping=true;
      // Only the process tree started by this call, never an existing user process.
      if(process.platform==='win32'&&child.pid) {
        const killer=spawn(join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.on('error',()=>child.kill());killer.on('close',code=>{if(code!==0)child.kill();});
      } else child.kill();
    };
    const onAbort=()=>{interrupted=true;terminate();};signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>{result.timedOut=true;terminate();},timeoutMs);
    const collect=(chunk:Buffer)=>{if(overflow)return;output+=chunk.toString('utf8');if(output.length>2*1024*1024){overflow=true;terminate();}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',(e:NodeJS.ErrnoException)=>{output+=`\nPROCESS_${e.code??'ERROR'}`;});
    child.on('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);result.exitCode=interrupted?130:result.timedOut?124:overflow?125:code??1;
      result.output=safeDiagnostic(output);result.durationMs=Date.now()-start;
      record?.(result);resolve(result);
    });
  });
}
