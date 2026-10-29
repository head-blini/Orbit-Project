import {spawn as nodeSpawn,type ChildProcess} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {buildChildEnv} from '../child-env.ts';
import {resolveNativeExecutable} from '../native-executable.ts';
import {safeText,containsCredential} from '../privacy.ts';
import {AppError} from '../errors.ts';
import {nativeModelId,type NativeIdentity} from './model-identity.ts';
import type {ClaudeAuthenticationReport} from '../../shared/native-readiness.ts';

/**
 * Claude Code runtime adapter over the official `claude -p --output-format stream-json`
 * interface. It reuses Orbit's isolation stance: no shell or web tools, no MCP servers,
 * no user/project settings, prompts answered by nobody, and subscription auth only.
 */
export type ClaudeMode='read'|'write';
export type ClaudeAuth='subscription'|'api_key'|'unknown';
export interface ClaudeQuotaWindow {id:string;utilization:number|null;resetsAt:string|null;status:string}
export type ClaudeEvent=
  |{kind:'model';sessionId:string;modelId:string|null}
  |{kind:'session';sessionId:string;model:string|null;permissionMode:string|null;auth:ClaudeAuth;tools:string[]}
  |{kind:'message';text:string}
  |{kind:'tool';name:string}
  |{kind:'error';code:'authentication_failed'|'rate_limit'|'other'}
  |{kind:'quota';status:'allowed'|'allowed_warning'|'rejected'|'unknown';windows:ClaudeQuotaWindow[]}
  |{kind:'result';isError:boolean;terminalReason:string|null;turns:number|null;durationMs:number|null};
export interface ClaudeOutcome {
  dispatch?:'not_started'|'started';evidenceSource?:'native'|'mock';issue?:'AUTHENTICATION_REQUIRED'|'AUTH_MODE_BLOCKED'|'AUTH_PREFLIGHT_UNAVAILABLE'|'LAUNCH_CONTEXT_CHANGED';
  status:'completed'|'error'|'auth_required'|'quota_exhausted'|'interrupted'|'unknown'|'spawn_failed';
  sessionId:string|null;exit:'observed'|'not_observed';exitCode:number|null;signal:string|null;forced:boolean;
  ignoredLines:number;response:string;
  identity?:NativeIdentity;
}

const tools:Record<ClaudeMode,string>={read:'Read,Grep,Glob',write:'Read,Grep,Glob,Edit,Write'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE=4*1024*1024;

export function claudeArgs(options:{mode:ClaudeMode;textOnly?:boolean;resume?:string;model?:string}):string[]{
  const args=['-p','--output-format','stream-json','--verbose','--input-format','text',
    '--restricted','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-prompts','none',
    '--disable-slash-commands','--no-chrome','--tools',options.textOnly?'':tools[options.mode],'--permission-mode',options.mode==='write'?'acceptEdits':'plan'];
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
const epoch=(value:unknown)=>{const n=finite(value);if(n===null||n<0||!Number.isSafeInteger(n*1000))return null;try{return new Date(n*1000).toISOString();}catch{return null;}};
const quotaStatus=(value:unknown)=>value==='allowed'||value==='allowed_warning'||value==='rejected'?value:'unknown';

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
      const session=text(value.session_id),message=record(value.message);
      events.push({kind:'model',sessionId:session&&uuid.test(session)?session:'',modelId:nativeModelId(message?.model)});
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
      const status=quotaStatus(info.status);
      const windows=Object.entries(record(info.unifiedWindows)??{}).slice(0,32).flatMap(([id,raw])=>{
        if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(id)||containsCredential(id))return [];
        const w=record(raw),utilization=finite(w?.utilization);
        return w?[{id,utilization:utilization!==null&&utilization>=0&&utilization<=1?utilization:null,resetsAt:epoch(w.resetsAt),status:quotaStatus(w.status)}]:[];
      });
      return [{kind:'quota',status,windows}];
    }
    case 'result':return [{kind:'result',isError:value.is_error===true,terminalReason:text(value.terminal_reason),turns:finite(value.num_turns),durationMs:finite(value.duration_ms)}];
  }
  return null;
}

type SpawnLike=(command:string,args:readonly string[],options:object)=>ChildProcess;

/** One Claude Code turn. The owner of a task must not start a second run for it. */
export class ClaudeCodeRun {
  private options:{executable:string;cwd:string;mode:ClaudeMode;textOnly?:boolean;resume?:string;model?:string;env?:NodeJS.ProcessEnv;spawn?:SpawnLike;killAfterMs?:number;authProbe?:()=>Promise<ClaudeAuthenticationReport>;beforeDispatch?:()=>void;onOutputLine?:(line:string|null)=>void};
  private child:ChildProcess|null=null;private started=false;private interruptRequested=false;private forced=false;private killTimer:ReturnType<typeof setTimeout>|undefined;
  private preflighting=false;
  constructor(options:ClaudeCodeRun['options']){this.options=options;}
  async start(prompt:string,onEvent:(event:ClaudeEvent)=>void):Promise<ClaudeOutcome>{
    if(this.started)return Promise.reject(new AppError('RUN_ALREADY_STARTED'));
    this.started=true;
    const evidenceSource=this.options.spawn||this.options.authProbe?'mock':'native';
    if(this.options.authProbe||!this.options.spawn){
      this.preflighting=true;
      let authentication:ClaudeAuthenticationReport['authentication']='unknown';
      try{
        const probe=this.options.authProbe??(async()=>{const {probeClaudeAuthentication}=await import('../native-readiness.ts');return probeClaudeAuthentication({findExecutable:()=>this.options.executable,env:this.options.env});});
        authentication=(await probe()).authentication;
      }catch{/* Authentication diagnostics never leave the probe. */}finally{this.preflighting=false;}
      if(this.interruptRequested)return {status:'interrupted',dispatch:'not_started',evidenceSource,sessionId:null,exit:'not_observed',exitCode:null,signal:null,forced:false,ignoredLines:0,response:''};
      if(authentication!=='subscription')return {status:'auth_required',dispatch:'not_started',evidenceSource,issue:authentication==='not_authenticated'?'AUTHENTICATION_REQUIRED':authentication==='unsupported'?'AUTH_MODE_BLOCKED':'AUTH_PREFLIGHT_UNAVAILABLE',
        sessionId:null,exit:'not_observed',exitCode:null,signal:null,forced:false,ignoredLines:0,response:''};
    }
    try{this.options.beforeDispatch?.();}catch{return {status:'error',dispatch:'not_started',evidenceSource,issue:'LAUNCH_CONTEXT_CHANGED',sessionId:null,exit:'not_observed',exitCode:null,signal:null,forced:false,ignoredLines:0,response:''};}
    const args=claudeArgs(this.options),spawn=this.options.spawn??(nodeSpawn as SpawnLike);
    return new Promise(resolve=>{
      let sessionId:string|null=null,result:Extract<ClaudeEvent,{kind:'result'}>|null=null,error:Extract<ClaudeEvent,{kind:'error'}>['code']|null=null;
      let quotaRejected=false,ignoredLines=0,buffer='',response='',settled=false;
      let observedModel:string|null=null,identityInvalid=false;
      const finish=(outcome:Omit<ClaudeOutcome,'sessionId'|'ignoredLines'|'response'|'forced'>,preserveHandle=false)=>{
        if(settled)return;settled=true;if(!preserveHandle){if(this.killTimer)clearTimeout(this.killTimer);this.child=null;}
        resolve({dispatch:outcome.status==='spawn_failed'?'not_started':'started',evidenceSource,...outcome,sessionId,ignoredLines,response,forced:this.forced,identity:{providerId:'anthropic',modelId:identityInvalid?'unknown':observedModel??'unknown',sessionId,executionId:null,modelEvidence:!identityInvalid&&observedModel?'assistant_message':'unknown'}});
      };
      const handle=(line:string)=>{
        if(!line.trim())return;
        // Null reports truncation without forwarding an unbounded raw line.
        this.options.onOutputLine?.(line.length<=MAX_LINE?line:null);
        const events=line.length>MAX_LINE?null:parseClaudeLine(line);
        if(!events){ignoredLines++;return;}
        for(const event of events){
          if(event.kind==='session'){if(sessionId&&sessionId!==event.sessionId)identityInvalid=true;sessionId=event.sessionId;}
          if(event.kind==='model'){
            if(!sessionId||event.sessionId!==sessionId||!event.modelId||observedModel&&observedModel!==event.modelId)identityInvalid=true;
            else observedModel=event.modelId;
          }
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
      child.on('error',()=>{
        finish({status:child.pid===undefined?'spawn_failed':'unknown',exit:'not_observed',exitCode:null,signal:null},child.pid!==undefined);
        if(child.pid!==undefined&&this.child===child)this.interrupt();
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data',(chunk:string)=>{
        buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop()??'';
        if(buffer.length>MAX_LINE){ignoredLines++;buffer='';this.options.onOutputLine?.(null);}
        for(const line of lines)handle(line);
      });
      // stderr may contain diagnostics with paths or account details; it is drained, never stored.
      child.stderr?.resume();
      child.stdin?.on('error',()=>{});
      child.stdin?.end(prompt);
      child.on('close',(code,signal)=>{
        if(this.killTimer)clearTimeout(this.killTimer);this.child=null;
        if(buffer)handle(buffer);buffer='';
        const base={exit:'observed' as const,exitCode:code,signal:signal??null};
        if(this.interruptRequested)return finish({status:'interrupted',...base});
        if(!result)return finish({status:'unknown',...base});
        if(error==='authentication_failed')return finish({status:'auth_required',...base});
        if(error==='rate_limit'||quotaRejected)return finish({status:'quota_exhausted',...base});
        if(!result.isError&&code===0)return finish({status:'completed',...base});
        finish({status:'error',...base});
      });
    });
  }
  /** True while a spawned child is held without an observed close, including after an unobserved-exit outcome. */
  owned():boolean{return this.child!==null;}
  /** Sends an interrupt. Confirmation comes only from the observed process exit. */
  interrupt():'requested'|'not_running'{
    if(this.preflighting){this.interruptRequested=true;return 'requested';}
    const child=this.child;if(!child)return 'not_running';
    if(this.interruptRequested)return 'requested';
    this.interruptRequested=true;
    try{child.kill('SIGINT');}catch{/* A signal error is not an exit observation. */}
    this.killTimer=setTimeout(()=>{if(this.child===child){this.forced=true;try{child.kill('SIGKILL');}catch{/* Keep the unconfirmed process handle quarantined. */}}},this.options.killAfterMs??5000);
    return 'requested';
  }
}
