import {spawn} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {AppError} from '../errors.ts';

export interface BedrockProcessRequest {executable:string;args:readonly string[];cwd:string;env:Readonly<NodeJS.ProcessEnv>;timeoutMs:number;maxStdoutBytes:number;maxStderrBytes:number;signal?:AbortSignal}
export interface BedrockProcessResult {stdout:Buffer;stderr:Buffer;exitCode:number|null;timedOut:boolean;aborted:boolean;overflow:boolean}
/** Private native boundary: no recorder, shell, stdin, shared stream or raw error.
 * Termination follows the existing Runner's owned-process-tree principle. Resolve
 * only on close, so a caller cannot remove the input while its process is alive.
 */
export async function invokeBedrockProcess(request:BedrockProcessRequest):Promise<BedrockProcessResult>{
  const {executable,cwd,signal}=request,args=[...request.args],env={...request.env};
  if(!isAbsolute(executable)||!isAbsolute(cwd)||args.length>64||args.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>4096)
    ||!Number.isSafeInteger(request.timeoutMs)||request.timeoutMs<1||request.timeoutMs>120000
    ||[request.maxStdoutBytes,request.maxStderrBytes].some(limit=>!Number.isSafeInteger(limit)||limit<1||limit>256*1024))throw new AppError('PROVIDER_REQUEST_FAILED');
  const result:BedrockProcessResult={stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:null,timedOut:false,aborted:signal?.aborted??false,overflow:false};
  if(signal?.aborted)return result;
  return new Promise(resolve=>{
    const out:Buffer[]=[],err:Buffer[]=[];let stdoutBytes=0,stderrBytes=0,stopping=false,failed=false;
    let child:ReturnType<typeof spawn>;
    try{child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});}catch{resolve(result);return;}
    const stop=()=>{
      if(stopping)return;stopping=true;
      if(process.platform==='win32'&&child.pid){
        const killer=spawn(join(env.SYSTEMROOT??env.SystemRoot??'C:/Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.once('error',()=>child.kill());killer.once('close',code=>{if(code!==0)child.kill();});
      }else if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    };
    const abort=()=>{result.aborted=true;stop();};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{result.timedOut=true;stop();},request.timeoutMs);
    const collect=(chunk:Buffer,stdout:boolean)=>{
      if(stopping)return;const bytes=Buffer.from(chunk);if(stdout)stdoutBytes+=bytes.length;else stderrBytes+=bytes.length;
      if(stdoutBytes>request.maxStdoutBytes||stderrBytes>request.maxStderrBytes){result.overflow=true;stop();return;}
      (stdout?out:err).push(bytes);
    };
    child.stdout?.on('data',chunk=>collect(chunk,true));child.stderr?.on('data',chunk=>collect(chunk,false));
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);result.exitCode=failed?null:code;result.stdout=Buffer.concat(out);result.stderr=Buffer.concat(err);resolve(result);});
    if(signal?.aborted)abort();
  });
}
