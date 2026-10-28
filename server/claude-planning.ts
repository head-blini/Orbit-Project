import {isAbsolute} from 'node:path';
import {spawn as nodeSpawn} from 'node:child_process';
import type {NativePlanningInput,NativePlanningResult} from './codex-planning.ts';
import {ClaudeCodeRun,claudeEnv,findClaude,type ClaudeOutcome} from './runtimes/claude-code.ts';
import {parseClaudePlanningProposal} from './planning/agent-input.ts';
import {safeText} from './privacy.ts';

type Spawn=NonNullable<ConstructorParameters<typeof ClaudeCodeRun>[0]['spawn']>;
type RunnerOptions={executable:string;cwd:string;mode:'read';env:NodeJS.ProcessEnv;spawn?:Spawn};

export interface ClaudePlanningOptions {
  findExecutable?:()=>string;
  runnerFactory?:(options:RunnerOptions)=>Pick<ClaudeCodeRun,'start'|'interrupt'>;
  spawn?:Spawn;
}

/** The shared runtime intentionally sanitizes responses for display. Observe only
 * transformation evidence before that boundary so a partial/masked plan cannot
 * become an authoritative saved draft. No raw lines leave this bounded observer. */
function outputIntegrity(spawn:Spawn){
  let issue:string|null=null;
  const guarded:Spawn=(...args)=>{
    const child=spawn(...args);let buffer='';const limit=4*1024*1024;
    const inspect=(line:string)=>{
      if(issue)return;
      try{
        const value=JSON.parse(line);
        if(value?.type!=='assistant'||!Array.isArray(value.message?.content))return;
        for(const part of value.message.content){
          if(part?.type!=='text'||typeof part.text!=='string')continue;
          if(part.text.length>64000){issue='PLANNING_PROPOSAL_INVALID';return;}
          if(safeText(part.text)!==part.text){issue='PLANNING_PROPOSAL_BLOCKED';return;}
        }
      }catch{/* Protocol recognition and lifecycle remain owned by ClaudeCodeRun. */}
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data',(chunk:string)=>{
      if(issue)return;
      if(buffer.length+chunk.length>limit){issue='PLANNING_PROPOSAL_INVALID';buffer='';return;}
      buffer+=chunk;let newline:number;
      while((newline=buffer.indexOf('\n'))>=0){inspect(buffer.slice(0,newline));buffer=buffer.slice(newline+1);}
      if(issue)buffer='';
    });
    child.on('close',()=>{if(buffer)inspect(buffer);buffer='';});
    return child;
  };
  return {spawn:guarded,issue:()=>issue};
}

/** One invocation; interrupt is only a request until the runtime observes exit. */
export async function runClaudePlanning(input:NativePlanningInput,options:ClaudePlanningOptions={}):Promise<NativePlanningResult>{
  const result:NativePlanningResult={execution:'failed',threadId:null,turnId:null,proposal:null,issue:null,processStopped:true};
  if(!input||typeof input.workspacePath!=='string'||!isAbsolute(input.workspacePath)||input.workspacePath.length>2000
    ||/[\x00-\x1f\x7f]/.test(input.workspacePath)||input.workspacePath.split(/[\\/]/).some(part=>part==='.'||part==='..')
    ||typeof input.instructions!=='string'||!input.instructions.trim()||input.instructions.length>64000||Buffer.byteLength(input.instructions)>256*1024||input.instructions.includes('\0')
    ||!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1000||input.timeoutMs>60000||(input.signal!==undefined&&!(input.signal instanceof AbortSignal)))return {...result,issue:'INVALID_PLANNING_INPUT'};
  if(input.signal?.aborted)return {...result,execution:'interrupted',issue:'PLANNING_INTERRUPTED'};
  let runner:Pick<ClaudeCodeRun,'start'|'interrupt'>;
  const integrity=outputIntegrity(options.spawn??nodeSpawn);
  try{runner=(options.runnerFactory??(config=>new ClaudeCodeRun(config)))({executable:(options.findExecutable??findClaude)(),cwd:input.workspacePath,mode:'read',env:claudeEnv(),spawn:integrity.spawn});}
  catch(error){return {...result,issue:error instanceof Error&&error.message==='CLAUDE_NOT_INSTALLED'?'CLAUDE_NOT_INSTALLED':'PLANNING_RUNTIME_NOT_STARTED'};}
  let reason:'interrupted'|'timed_out'|null=null,grace:NodeJS.Timeout|undefined;
  let unconfirmed!:()=>void;
  const abandoned=new Promise<null>(resolve=>{unconfirmed=()=>resolve(null);});
  const stop=(next:NonNullable<typeof reason>)=>{
    if(reason)return;reason=next;
    try{runner.interrupt();}catch{/* Exit remains the only stop evidence. */}
    grace=setTimeout(unconfirmed,6000);
  };
  const abort=()=>stop('interrupted'),timer=setTimeout(()=>stop('timed_out'),input.timeoutMs);
  input.signal?.addEventListener('abort',abort,{once:true});
  try{
    // No raw message, prompt, tool input or diagnostics enter the event store.
    const running=runner.start(input.instructions,()=>{});
    if(input.signal?.aborted)abort();
    const outcome:ClaudeOutcome|null=await Promise.race([running,abandoned]);
    if(!outcome||outcome.exit!=='observed')return {...result,execution:'lost',issue:'PLANNING_PROCESS_STOP_UNCONFIRMED',processStopped:false};
    result.threadId=outcome.sessionId;
    if(reason)return {...result,execution:reason,issue:reason==='timed_out'?'PLANNING_TIMEOUT':'PLANNING_INTERRUPTED'};
    if(outcome.status==='interrupted')return {...result,execution:'interrupted',issue:'PLANNING_INTERRUPTED'};
    if(outcome.status!=='completed')return {...result,issue:outcome.status==='auth_required'?'LOGIN_REQUIRED':outcome.status==='quota_exhausted'?'QUOTA_EXHAUSTED':'PLANNING_FAILED'};
    if(integrity.issue())return {...result,issue:integrity.issue()};
    try{return {...result,execution:'completed',proposal:parseClaudePlanningProposal(outcome.response)};}
    catch(error){return {...result,issue:error instanceof Error&&error.message==='PLANNING_PROPOSAL_BLOCKED'?'PLANNING_PROPOSAL_BLOCKED':'PLANNING_PROPOSAL_INVALID'};}
  }catch{
    try{runner.interrupt();}catch{/* Quarantine; never invent an exit. */}
    return {...result,execution:'lost',issue:'PLANNING_PROCESS_STOP_UNCONFIRMED',processStopped:false};
  }finally{clearTimeout(timer);if(grace)clearTimeout(grace);input.signal?.removeEventListener('abort',abort);}
}
