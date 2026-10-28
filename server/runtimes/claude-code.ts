import {spawn as nodeSpawn,type ChildProcess} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {buildChildEnv} from '../child-env.ts';
import {resolveNativeExecutable} from '../native-executable.ts';
import {safeText} from '../privacy.ts';
import {AppError} from '../errors.ts';

/**
 * Claude Code runtime adapter over the official `claude -p --output-format stream-json`
 * interface. It reuses Orbit's isolation stance: no shell or web tools, no MCP servers,
 * no user/project settings, prompts answered by nobody, and subscription auth only.
 */
export type ClaudeMode='read'|'write';
export type ClaudeAuth='subscription'|'api_key'|'unknown';
export interface ClaudeQuotaWindow {id:string;utilization:number|null;resetsAt:string|null;status:string}
export type ClaudeEvent=
  |{kind:'session';sessionId:string;model:string|null;permissionMode:string|null;auth:ClaudeAuth;tools:string[]}
  |{kind:'message';text:string}
  |{kind:'tool';name:string}
  |{kind:'error';code:'authentication_failed'|'rate_limit'|'other'}
  |{kind:'quota';status:'allowed'|'allowed_warning'|'rejected'|'unknown';windows:ClaudeQuotaWindow[]}
  |{kind:'result';isError:boolean;terminalReason:string|null;turns:number|null;durationMs:number|null};
export interface ClaudeOutcome {
  status:'completed'|'error'|'auth_required'|'quota_exhausted'|'interrupted'|'unknown'|'spawn_failed';
  sessionId:string|null;exit:'observed'|'not_observed';exitCode:number|null;signal:string|null;forced:boolean;
  ignoredLines:number;response:string;
}

const tools:Record<ClaudeMode,string>={read:'Read,Grep,Glob',write:'Read,Grep,Glob,Edit,Write'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE=4*1024*1024;

export function claudeArgs(options:{mode:ClaudeMode;resume?:string;model?:string}):string[]{
  const args=['-p','--output-format','stream-json','--verbose','--input-format','text',
    '--restricted','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-prompts','none',
    '--disable-slash-commands','--no-chrome','--tools',tools[options.mode],'--permission-mode',options.mode==='write'?'acceptEdits':'plan'];
  if(options.resume!==undefined){if(!uuid.test(options.resume))throw new AppError('INVALID_SESSION',400);args.push('--resume',options.resume);}
  if(options.model!==undefined){if(!/^[A-Za-z0-9][\w.:\[\]-]{0,99}$/.test(options.model))throw new AppError('INVALID_MODEL',400);args.push('--model',options.model);}
  return args;
}

/** Reuse the Codex child allowlist; macOS keychain lookup additionally needs the login name. */
export function claudeEnv(source:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):NodeJS.ProcessEnv{
  const env=buildChildEnv(source,platform);
  if(platform!=='win32')for(const key of ['USER','LOGNAME'])if(typeof source[key]==='string')env[key]=source[key];
  return env;
}

export function findClaude(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):string{
  for(const directory of (env.PATH??'').split(platform==='win32'?';':':').filter(isAbsolute)){
    const found=resolveNativeExecutable(join(directory,platform==='win32'?'claude.exe':'claude'),platform);if(found)return found;
  }
  throw new AppError('CLAUDE_NOT_INSTALLED',503);
}

const text=(value:unknown)=>typeof value==='string'?value:null;
const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const epoch=(value:unknown)=>{const n=finite(value);return n===null?null:new Date(n*1000).toISOString();};

/** Returns projected events, [] for known lines with nothing to show, or null for unrecognised input. */
export function parseClaudeLine(line:string):ClaudeEvent[]|null{
  let value:Record<string,unknown>|null;try{value=record(JSON.parse(line));}catch{return null;}
  if(!value)return null;
  switch(value.type){
    case 'system':{
      if(value.subtype!=='init')return [];
      const session=text(value.session_id);if(!session||!uuid.test(session))return null;
      const source=text(value.apiKeySource);
      return [{kind:'session',sessionId:session,model:text(value.model),permissionMode:text(value.permissionMode),
        auth:source==='none'?'subscription':source?'api_key':'unknown',tools:Array.isArray(value.tools)?value.tools.filter((t):t is string=>typeof t==='string'):[]}];
    }
    case 'assistant':{
      const content=record(value.message)?.content;if(!Array.isArray(content))return null;
      const events:ClaudeEvent[]=[];
      for(const item of content){
        const part=record(item);if(!part)continue;
        // Tool inputs and results can carry file contents or secrets; only the tool name is kept.
        if(part.type==='tool_use'&&text(part.name))events.push({kind:'tool',name:String(part.name).slice(0,80)});
        if(part.type==='text'&&text(part.text))events.push({kind:'message',text:safeText(String(part.text))});
      }
      if(value.error!==undefined&&value.error!==null)events.push({kind:'error',code:value.error==='authentication_failed'?'authentication_failed':value.error==='rate_limit'?'rate_limit':'other'});
      return events;
    }
    case 'user':return [];
    case 'rate_limit_event':{
      const info=record(value.rate_limit_info);if(!info)return null;
      const status=['allowed','allowed_warning','rejected'].includes(String(info.status))?info.status as 'allowed':'unknown';
      const windows=Object.entries(record(info.unifiedWindows)??{}).flatMap(([id,raw])=>{const w=record(raw);return w?[{id:id.slice(0,40),utilization:finite(w.utilization),resetsAt:epoch(w.resetsAt),status:text(w.status)??'unknown'}]:[];});
      return [{kind:'quota',status,windows}];
    }
    case 'result':return [{kind:'result',isError:value.is_error===true,terminalReason:text(value.terminal_reason),turns:finite(value.num_turns),durationMs:finite(value.duration_ms)}];
  }
  return null;
}

type SpawnLike=(command:string,args:readonly string[],options:object)=>ChildProcess;

/** One Claude Code turn. The owner of a task must not start a second run for it. */
export class ClaudeCodeRun {
  private options:{executable:string;cwd:string;mode:ClaudeMode;resume?:string;model?:string;env?:NodeJS.ProcessEnv;spawn?:SpawnLike;killAfterMs?:number};
  private child:ChildProcess|null=null;private started=false;private interruptRequested=false;private forced=false;private killTimer:ReturnType<typeof setTimeout>|undefined;
  constructor(options:ClaudeCodeRun['options']){this.options=options;}
  start(prompt:string,onEvent:(event:ClaudeEvent)=>void):Promise<ClaudeOutcome>{
    if(this.started)return Promise.reject(new AppError('RUN_ALREADY_STARTED'));
    this.started=true;
    const args=claudeArgs(this.options),spawn=this.options.spawn??(nodeSpawn as SpawnLike);
    return new Promise(resolve=>{
      let sessionId:string|null=null,result:Extract<ClaudeEvent,{kind:'result'}>|null=null,error:Extract<ClaudeEvent,{kind:'error'}>['code']|null=null;
      let quotaRejected=false,ignoredLines=0,buffer='',response='',settled=false;
      const finish=(outcome:Omit<ClaudeOutcome,'sessionId'|'ignoredLines'|'response'|'forced'>)=>{
        if(settled)return;settled=true;if(this.killTimer)clearTimeout(this.killTimer);this.child=null;
        resolve({...outcome,sessionId,ignoredLines,response,forced:this.forced});
      };
      const handle=(line:string)=>{
        if(!line.trim())return;
        const events=line.length>MAX_LINE?null:parseClaudeLine(line);
        if(!events){ignoredLines++;return;}
        for(const event of events){
          if(event.kind==='session')sessionId=event.sessionId;
          if(event.kind==='message')response=event.text;
          if(event.kind==='error')error=event.code;
          if(event.kind==='quota'&&event.status==='rejected')quotaRejected=true;
          if(event.kind==='result')result=event;
          try{onEvent(event);}catch{/* Observers cannot change the recorded outcome. */}
        }
      };
      let child:ChildProcess;
      try{child=spawn(this.options.executable,args,{cwd:this.options.cwd,env:this.options.env??claudeEnv(),stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}
      catch{finish({status:'spawn_failed',exit:'not_observed',exitCode:null,signal:null});return;}
      this.child=child;
      child.on('error',()=>finish({status:'spawn_failed',exit:'not_observed',exitCode:null,signal:null}));
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data',(chunk:string)=>{
        buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop()??'';
        if(buffer.length>MAX_LINE){ignoredLines++;buffer='';}
        for(const line of lines)handle(line);
      });
      // stderr may contain diagnostics with paths or account details; it is drained, never stored.
      child.stderr?.resume();
      child.stdin?.on('error',()=>{});
      child.stdin?.end(prompt);
      child.on('close',(code,signal)=>{
        if(buffer)handle(buffer);buffer='';
        const base={exit:'observed' as const,exitCode:code,signal:signal??null};
        if(this.interruptRequested)return finish({status:'interrupted',...base});
        if(!result)return finish({status:'unknown',...base});
        if(!result.isError)return finish({status:'completed',...base});
        if(error==='authentication_failed')return finish({status:'auth_required',...base});
        if(error==='rate_limit'||quotaRejected)return finish({status:'quota_exhausted',...base});
        finish({status:'error',...base});
      });
    });
  }
  /** Sends an interrupt. Confirmation comes only from the observed process exit. */
  interrupt():'requested'|'not_running'{
    const child=this.child;if(!child)return 'not_running';
    if(this.interruptRequested)return 'requested';
    this.interruptRequested=true;child.kill('SIGINT');
    this.killTimer=setTimeout(()=>{if(this.child===child){this.forced=true;child.kill('SIGKILL');}},this.options.killAfterMs??5000);
    return 'requested';
  }
}
