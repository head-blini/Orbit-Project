import { existsSync,lstatSync,realpathSync } from 'node:fs';
import { delimiter,dirname,isAbsolute,join,relative,resolve,sep } from 'node:path';
import { spawn } from 'node:child_process';

export function containedPath(root:string,...parts:string[]):string {
  const base=resolve(root),target=resolve(base,...parts),rel=relative(base,target);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('PATH_OUTSIDE_E2E_RUN');
  for(let cursor=target;;cursor=dirname(cursor)){
    if(existsSync(cursor)&&(lstatSync(cursor).isSymbolicLink()||relative(resolve(cursor),realpathSync(cursor))!==''))throw new Error('E2E_PATH_LINK_REJECTED');
    if(cursor===base)break;
  }
  return target;
}
export function isolatedEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const names=new Set(['path','pathext','systemroot','windir','systemdrive','comspec','temp','tmp','tmpdir','home','userprofile','homedrive','homepath','appdata','localappdata','lang','lc_all','display','wayland_display','xdg_runtime_dir','agent_browser_action_policy','agent_browser_confirm_actions','agent_browser_confirm_interactive']);
  return Object.fromEntries(Object.entries(source).filter(([key,value])=>value!==undefined&&names.has(key.toLowerCase())));
}
export function findAgentBrowser(env:NodeJS.ProcessEnv=process.env):string {
  const pathValue=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1]??'';
  for(const directory of pathValue.split(delimiter).filter(Boolean)){
    const candidates=process.platform==='win32'?
      [join(directory,'agent-browser.exe'),join(directory,'node_modules','agent-browser','bin',`agent-browser-win32-${process.arch}.exe`),join(directory,'node_modules','agent-browser','bin','agent-browser-win32-x64.exe')]:[join(directory,'agent-browser')];
    for(const candidate of candidates)if(existsSync(candidate)&&lstatSync(candidate).isFile())return resolve(candidate);
  }
  throw new Error('AGENT_BROWSER_NOT_FOUND: install/verify agent-browser in normal PowerShell; this script never installs it.');
}
export function cliData(output:string):Record<string,unknown> {
  let value;try{value=JSON.parse(output.trim());}catch{throw new Error('AGENT_BROWSER_INVALID_JSON');}
  if(!value||value.success!==true||!value.data||typeof value.data!=='object')throw new Error('AGENT_BROWSER_COMMAND_FAILED: '+String(value?.error??'missing success/data'));
  return value.data;
}
export function evalResult(output:string):unknown {
  const data=cliData(output);if(!Object.hasOwn(data,'result'))throw new Error('AGENT_BROWSER_EVAL_SCHEMA_CHANGED');return data.result;
}
export function phaseSignal(active:AbortSignal,cleanup:boolean):AbortSignal {
  return cleanup?new AbortController().signal:active;
}
export function buttonRef(output:string,label:string,prefix=false):string {
  const data=cliData(output);
  if(!data.refs||typeof data.refs!=='object')throw new Error('AGENT_BROWSER_SNAPSHOT_SCHEMA_CHANGED');
  const matches=Object.entries(data.refs).filter(([,value])=>{
    const item=value as {role?:string;name?:string};
    return item.role==='button'&&typeof item.name==='string'&&(prefix?item.name.startsWith(label):item.name===label);
  });
  if(matches.length!==1||!/^e\d+$/.test(matches[0][0]))throw new Error('UI_BUTTON_NOT_UNIQUE: '+label);
  return '@'+matches[0][0];
}
export function overallStatus(checkOnly:boolean,steps:{status:string}[],cleanupErrors:string[]):string {
  if(cleanupErrors.length||steps.some(step=>step.status==='failed'))return 'failed';
  if(checkOnly)return 'not_run';
  return steps.length&&steps.every(step=>step.status==='passed')?'passed':'failed';
}
export interface ProcessResult {code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;timedOut:boolean;aborted:boolean;pid?:number}
export async function stopOwnedProcess(pid:number):Promise<void> {
  if(!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)throw new Error('INVALID_OWNED_PID');
  if(process.platform==='win32'){
    const code=await new Promise<number|null>((resolveStop,reject)=>{
      const killer=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
      killer.once('error',reject);killer.once('exit',resolveStop);
    });
    // taskkill may be denied in a managed shell. Terminate our exact child via Node,
    // and still report that descendant cleanup could not be certified.
    if(code!==0){try{process.kill(pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}throw new Error('OWNED_PROCESS_TREE_CLEANUP_UNCONFIRMED');}
  }else{try{process.kill(pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
}
export function runProcess(executable:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;timeoutMs?:number;signal?:AbortSignal}={}):Promise<ProcessResult> {
  return new Promise((resolveRun,reject)=>{
    if(options.signal?.aborted){reject(new Error('E2E_INTERRUPTED'));return;}
    const child=spawn(executable,args,{cwd:options.cwd,env:options.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false,timedOut=false,aborted=false,exitDelay:ReturnType<typeof setTimeout>|undefined,terminationDelay:ReturnType<typeof setTimeout>|undefined;
    child.stdout.on('data',data=>{stdout+=data.toString();});child.stderr.on('data',data=>{stderr+=data.toString();});
    const finish=(code:number|null,signal:NodeJS.Signals|null)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(exitDelay);clearTimeout(terminationDelay);options.signal?.removeEventListener('abort',abort);
      child.stdout.destroy();child.stderr.destroy();
      resolveRun({code:timedOut||aborted?1:code,signal,stdout,stderr,timedOut,aborted,pid:child.pid});
    };
    const terminate=()=>{
      if(!child.pid){finish(1,null);return;}
      void stopOwnedProcess(child.pid).catch(error=>{stderr+='\n'+String(error);}).finally(()=>{
        if(settled)return;
        // kill() sends a signal; only exit/close confirms the owned child ended.
        // Keep failure bounded if the OS never delivers that confirmation.
        if(child.exitCode!==null||child.signalCode!==null){finish(1,child.signalCode);return;}
        terminationDelay=setTimeout(()=>{stderr+='\nOWNED_PROCESS_EXIT_UNCONFIRMED';finish(1,null);},1500);
      });
    };
    const abort=()=>{aborted=true;terminate();};
    const timer=setTimeout(()=>{timedOut=true;terminate();},options.timeoutMs??45000);
    options.signal?.addEventListener('abort',abort,{once:true});
    child.once('error',error=>{stderr+=String(error);finish(1,null);});
    // A daemon can inherit stdout handles. Do not wait forever for its pipes after CLI exit.
    child.once('exit',(code,signal)=>{exitDelay=setTimeout(()=>finish(code,signal),50);});
    child.once('close',(code,signal)=>finish(code,signal));
  });
}
