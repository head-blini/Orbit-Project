import {lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError} from '../errors.ts';
import {safeText} from '../privacy.ts';
import {readDataRecord as readRecord,MAX_OUTBOUND_BYTES} from '../guardrails/outbound.ts';
import type {HttpChatEvent,HttpChatMessage,HttpProviderUsage} from './http-transport.ts';
import {invokeBedrockProcess,type BedrockProcessRequest,type BedrockProcessResult} from './bedrock-process.ts';
import {createBedrockTemporary,writeBedrockRequest,removeBedrockTemporary,bedrockRequestId,type BedrockTemporary} from './bedrock-temporary.ts';
export type BedrockTemporaryState='present'|'removed'|'cleanup_required';
export interface BedrockCredential {accessKeyId:string|undefined;secretAccessKey:string|undefined;sessionToken?:string}
export interface BedrockAuthorization {providerId:'bedrock';region:string;operation:'models'|'chat';model?:string;messages?:readonly HttpChatMessage[]}
type Decision={allowed:false}|{allowed:true;messages?:readonly HttpChatMessage[]};
export interface BedrockTransportConfig {providerId:'bedrock';cliPath:string;region:string;approved:boolean;models:readonly string[];timeoutMs:number;maxOutputTokens:number;credential:()=>BedrockCredential;authorize:(request:Readonly<BedrockAuthorization>)=>Decision|Promise<Decision>}
/** Trusted server/test injection only. Never deserialize dependencies from a browser. */
export interface BedrockTransportDependencies {validateCli?:(path:string)=>void;invoke?:(request:BedrockProcessRequest)=>Promise<BedrockProcessResult>;tempRoot?:string;env?:NodeJS.ProcessEnv}
function code(name:string,status=502):never{throw new AppError(name,status);}
function readDataRecord(value:unknown,keys:readonly string[]){try{return readRecord(value,keys);}catch{return null;}}
function modelList(value:unknown):readonly string[]{
  try{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>100||Reflect.ownKeys(value).length!==value.length+1)throw new Error();
    const fields=Object.getOwnPropertyDescriptors(value),result:string[]=[];for(let i=0;i<value.length;i++){const field=fields[String(i)];if(!field||!('value' in field)||!modelId(field.value))throw new Error();result.push(field.value);}if(new Set(result).size!==result.length)throw new Error();return Object.freeze(result);
  }catch{return code('INVALID_PROVIDER_CONFIGURATION',400);}
}
function dependencySnapshot(value:BedrockTransportDependencies):BedrockTransportDependencies {
  try{const keys=Object.keys(value);if(keys.some(key=>!['validateCli','invoke','tempRoot','env'].includes(key)))throw new Error();const row=readDataRecord(value,keys);if(!row||(row.validateCli!==undefined&&typeof row.validateCli!=='function')||(row.invoke!==undefined&&typeof row.invoke!=='function')||(row.tempRoot!==undefined&&typeof row.tempRoot!=='string')||(row.env!==undefined&&(!row.env||typeof row.env!=='object'||Array.isArray(row.env))))throw new Error();return Object.freeze({...row}) as BedrockTransportDependencies;}catch{return code('INVALID_PROVIDER_CONFIGURATION',400);}
}
const modelId=(value:unknown):value is string=>typeof value==='string'&&value.length<=140&&/^[a-z0-9-]+\.[a-z0-9][a-z0-9.:-]*$/.test(value)&&! /^(?:us|eu|apac|global)\./.test(value);
function messages(value:unknown):readonly HttpChatMessage[]{
  if(!Array.isArray(value)||value.length<1||value.length>100||Object.getPrototypeOf(value)!==Array.prototype)code('INVALID_PROVIDER_REQUEST',400);
  const fields=Object.getOwnPropertyDescriptors(value),result:HttpChatMessage[]=[];let length=0;
  for(let index=0;index<value.length;index++){const item=fields[String(index)];if(!item||!('value' in item))code('INVALID_PROVIDER_REQUEST',400);const row=readDataRecord(item.value,['role','content']);
    if(!row||!['system','user','assistant'].includes(row.role as string)||typeof row.content!=='string')code('INVALID_PROVIDER_REQUEST',400);
    length+=(row.content as string).length;if(length>64000)code('INVALID_PROVIDER_REQUEST',400);result.push(Object.freeze({role:row.role as HttpChatMessage['role'],content:row.content as string}));}
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_OUTBOUND_BYTES-1024)code('INVALID_PROVIDER_REQUEST',400);return Object.freeze(result);
}
function nativeCli(path:string){
  try{const full=resolve(path);let p=full;for(;;){const value=lstatSync(p);if(value.isSymbolicLink()||(p===full?(!value.isFile()||value.nlink!==1):!value.isDirectory())||realpathSync(p).toLowerCase()!==p.toLowerCase())code('BEDROCK_CLI_UNTRUSTED',503);if(dirname(p)===p)break;p=dirname(p);}}
  catch(error){if(error instanceof AppError)throw error;code((error as NodeJS.ErrnoException).code==='ENOENT'?'BEDROCK_CLI_NOT_FOUND':'BEDROCK_CLI_UNTRUSTED',503);}
}
class Operation {
  controller=new AbortController();private timer:NodeJS.Timeout;private timedOut=false;private external?:AbortSignal;private abort:()=>void;private deadline:number;
  constructor(timeout:number,signal?:AbortSignal){this.external=signal;this.abort=()=>this.controller.abort();this.deadline=Date.now()+timeout;this.timer=setTimeout(()=>{this.timedOut=true;this.controller.abort();},timeout);if(signal?.aborted)this.controller.abort();else signal?.addEventListener('abort',this.abort,{once:true});}
  check(){if(Date.now()>=this.deadline){this.timedOut=true;this.controller.abort();}if(this.controller.signal.aborted)code(this.timedOut?'PROVIDER_TIMEOUT':'PROVIDER_ABORTED',this.timedOut?504:409);}
  remaining(){this.check();return Math.max(1,this.deadline-Date.now());}
  async wait<T>(promise:Promise<T>):Promise<T>{return await new Promise((resolve,reject)=>{const abort=()=>{try{this.check();}catch(error){reject(error);}};this.controller.signal.addEventListener('abort',abort,{once:true});promise.then(value=>{this.controller.signal.removeEventListener('abort',abort);resolve(value);},error=>{this.controller.signal.removeEventListener('abort',abort);reject(error);});if(this.controller.signal.aborted)abort();});}
  close(){clearTimeout(this.timer);this.external?.removeEventListener('abort',this.abort);}
}
function environment(source:NodeJS.ProcessEnv,temporary:BedrockTemporary,region:string,credential?:BedrockCredential):NodeJS.ProcessEnv {
  const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','LC_CTYPE','TZ']),env:NodeJS.ProcessEnv={};
  for(const name of Object.keys(source)){const key=process.platform==='win32'?name.toUpperCase():name;if(allowed.has(key)&&typeof source[name]==='string')env[key]=source[name];}
  Object.assign(env,{HOME:temporary.path,USERPROFILE:temporary.path,APPDATA:temporary.path,LOCALAPPDATA:temporary.path,AWS_CONFIG_FILE:temporary.config,AWS_SHARED_CREDENTIALS_FILE:temporary.credentials,BOTO_CONFIG:temporary.boto,
    AWS_REGION:region,AWS_DEFAULT_REGION:region,AWS_DEFAULT_OUTPUT:'json',AWS_EC2_METADATA_DISABLED:'true',AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off',AWS_CLI_FILE_ENCODING:'UTF-8',AWS_CLI_OUTPUT_ENCODING:'UTF-8',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true',AWS_ACCOUNT_ID_ENDPOINT_MODE:'disabled'});
  if(credential)Object.assign(env,{AWS_ACCESS_KEY_ID:credential.accessKeyId,AWS_SECRET_ACCESS_KEY:credential.secretAccessKey,...(credential.sessionToken?{AWS_SESSION_TOKEN:credential.sessionToken}:{})});return env;
}
function decode(value:Uint8Array,maximum:number){if(!(value instanceof Uint8Array)||value.byteLength>maximum)code('PROVIDER_RESPONSE_TOO_LARGE');try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{return code('PROVIDER_INVALID_RESPONSE');}}
function usage(value:unknown):HttpProviderUsage {
  if(value===undefined||value===null)return {promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'};
  if(typeof value!=='object'||Array.isArray(value))code('PROVIDER_INVALID_RESPONSE');
  const row=value as Record<string,unknown>,read=(name:string)=>{const v=row[name];if(v===undefined||v===null)return null;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)code('PROVIDER_INVALID_RESPONSE');return v as number;};
  const result={promptTokens:read('inputTokens'),completionTokens:read('outputTokens'),totalTokens:read('totalTokens')};return {...result,source:Object.values(result).some(value=>value!==null)?'provider':'unknown'};
}
export function cleanupBedrockInput(requestId:string,dependencies:BedrockTransportDependencies={}):void {removeBedrockTemporary(requestId,dependencies.tempRoot);}

/** Official AWS CLI v2 JSON only. Construction/GET are inert; no CLI discovery,
 * environment values or credential callback occur until exact authorization.
 */
export function createBedrockProviderTransport(input:BedrockTransportConfig,dependencies:BedrockTransportDependencies={},beforeDispatch:()=>void=()=>{}){
  const fields=['providerId','cliPath','region','approved','models','timeoutMs','maxOutputTokens','credential','authorize'],data=readDataRecord(input,fields);
  if(!data||data.providerId!=='bedrock'||typeof data.cliPath!=='string'||!isAbsolute(data.cliPath)||/[\x00-\x1f\x7f]/.test(data.cliPath)||data.cliPath.split(/[\\/]/).some(part=>part==='.'||part==='..')
    ||(process.platform==='win32'?(!/^[A-Za-z]:[\\/]/.test(data.cliPath)||!data.cliPath.toLowerCase().endsWith('.exe')):basename(data.cliPath)!=='aws')||typeof data.region!=='string'||! /^(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:[a-z]+-)+[1-9]$/.test(data.region)
    ||typeof data.approved!=='boolean'
    ||typeof data.timeoutMs!=='number'||!Number.isSafeInteger(data.timeoutMs)||data.timeoutMs<1||data.timeoutMs>60000||typeof data.maxOutputTokens!=='number'||!Number.isSafeInteger(data.maxOutputTokens)||data.maxOutputTokens<1||data.maxOutputTokens>8192||typeof data.credential!=='function'||typeof data.authorize!=='function')code('INVALID_PROVIDER_CONFIGURATION',400);
  const config=Object.freeze({...data,models:modelList(data.models)}) as unknown as Readonly<BedrockTransportConfig>;
  dependencies=dependencySnapshot(dependencies);
  const invoke=dependencies.invoke??invokeBedrockProcess,validateCli=dependencies.validateCli??nativeCli;
  async function authorize(operation:'models'|'chat',op:Operation,chat?:{model:string;messages:readonly HttpChatMessage[]}){
    op.check();if(!config.approved)code('PROVIDER_NOT_APPROVED',403);
    const request=Object.freeze({providerId:'bedrock' as const,region:config.region,operation,...(chat?{model:chat.model,messages:messages(chat.messages)}:{})});
    if(chat&&!config.models.includes(chat.model))code('INVALID_PROVIDER_REQUEST',400);
    try{const result=config.authorize(request),copy=(result:Decision)=>{if(!result||typeof result!=='object')code('PROVIDER_OUTBOUND_DENIED',403);const fields=Object.keys(result),row=readDataRecord(result,fields);if(!row||row.allowed!==true||fields.some(key=>key!=='allowed'&&key!=='messages'))code('PROVIDER_OUTBOUND_DENIED',403);return chat?messages(row.messages):undefined;};
      const allowed=result instanceof Promise?await op.wait(result.then(copy)):copy(result);op.check();return allowed;
    }catch{op.check();return code('PROVIDER_OUTBOUND_DENIED',403);}
  }
  async function checkedProcess(args:string[],temporary:BedrockTemporary,op:Operation,credential?:BedrockCredential,version=false){
    op.check();beforeDispatch();const result=await invoke({executable:config.cliPath,args:Object.freeze([...args]),cwd:temporary.path,env:Object.freeze(environment(dependencies.env??process.env,temporary,config.region,credential)),timeoutMs:version?Math.min(3000,op.remaining()):op.remaining(),maxStdoutBytes:version?4096:256*1024,maxStderrBytes:version?4096:16384,signal:op.controller.signal});
    op.check();if(result.timedOut)code('PROVIDER_TIMEOUT',504);if(result.aborted)code('PROVIDER_ABORTED',409);if(result.overflow)code('PROVIDER_RESPONSE_TOO_LARGE');if(result.exitCode!==0)code('PROVIDER_REQUEST_FAILED');
    if(version){const stdout=decode(result.stdout,4096),stderr=decode(result.stderr,4096);if(!/^aws-cli\/2\.[0-9]+\.[0-9]+[\x20-\x7e]*\r?\n?$/.test(stdout||stderr)||stdout&&stderr)code('BEDROCK_CLI_UNSUPPORTED',503);return null;}
    const text=decode(result.stdout,256*1024);try{return JSON.parse(text) as unknown;}catch{return code('PROVIDER_INVALID_RESPONSE');}
  }
  function credential():BedrockCredential {
    try{const value=config.credential(),keys=['accessKeyId','secretAccessKey',...(Object.hasOwn(value,'sessionToken')?['sessionToken']:[])],row=readDataRecord(value,keys);if(!row)throw new Error();
      for(const key of keys)if(typeof row[key]!=='string'||!row[key]||String(row[key]).length>8192||! /^[\x21-\x7e]+$/.test(row[key] as string))throw new Error();return Object.freeze({...row}) as unknown as BedrockCredential;
    }catch{return code('PROVIDER_CREDENTIAL_REQUIRED',503);}
  }
  const flags=()=>['--region',config.region,'--output','json','--no-cli-pager','--no-cli-auto-prompt','--cli-connect-timeout',String(Math.max(1,Math.ceil(config.timeoutMs/1000))),'--cli-read-timeout',String(Math.max(1,Math.ceil(config.timeoutMs/1000)))];
  function runtime(){try{validateCli(config.cliPath);}catch(error){if(error instanceof Error&&['BEDROCK_CLI_NOT_FOUND','BEDROCK_CLI_UNTRUSTED'].includes(error.message))code(error.message,503);code('BEDROCK_CLI_UNTRUSTED',503);}}
  return Object.freeze({
    async listModels(options:{signal?:AbortSignal}={}):Promise<string[]>{
      const op=new Operation(config.timeoutMs,options.signal),requestId=randomUUID();let temporary:BedrockTemporary|undefined;
      try{await authorize('models',op);runtime();op.check();temporary=createBedrockTemporary(requestId,dependencies.tempRoot);await checkedProcess(['--version'],temporary,op,undefined,true);const key=credential();op.check();
        const value=await checkedProcess(['bedrock','list-foundation-models','--by-output-modality','TEXT','--by-inference-type','ON_DEMAND',...flags()],temporary,op,key) as {modelSummaries?:unknown};
        if(!value||!Array.isArray(value.modelSummaries)||value.modelSummaries.length>10000)code('PROVIDER_INVALID_RESPONSE');const found=new Set<string>();
        for(const item of value.modelSummaries){if(!item||typeof item!=='object'||typeof item.modelId!=='string')code('PROVIDER_INVALID_RESPONSE');if(modelId(item.modelId)&&Array.isArray(item.outputModalities)&&item.outputModalities.includes('TEXT')&&Array.isArray(item.inferenceTypesSupported)&&item.inferenceTypesSupported.includes('ON_DEMAND'))found.add(item.modelId);}
        op.check();return config.models.filter(id=>found.has(id));
      }catch(error){op.check();if(error instanceof AppError)throw error;code('PROVIDER_REQUEST_FAILED');}finally{try{if(temporary)removeBedrockTemporary(requestId,dependencies.tempRoot);}finally{op.close();}}
    },
    async *chat(input:{model:string;messages:readonly HttpChatMessage[]},options:{signal?:AbortSignal;requestId?:string;onTemporaryInput?:(state:BedrockTemporaryState)=>void}={}):AsyncGenerator<HttpChatEvent>{
      const op=new Operation(config.timeoutMs,options.signal);let temporary:BedrockTemporary|undefined;
      const cleanup=()=>{if(!temporary)return;try{removeBedrockTemporary(temporary.requestId,dependencies.tempRoot);temporary=undefined;options.onTemporaryInput?.('removed');}catch{temporary=undefined;try{options.onTemporaryInput?.('cleanup_required');}catch{}code('BEDROCK_CLEANUP_REQUIRED',503);}};
      try{
        if(!bedrockRequestId(options.requestId))code('INVALID_PROVIDER_REQUEST',400);const row=readDataRecord(input,['model','messages']);if(!row||typeof row.model!=='string')code('INVALID_PROVIDER_REQUEST',400);
        const allowed=await authorize('chat',op,row as unknown as {model:string;messages:readonly HttpChatMessage[]});runtime();op.check();temporary=createBedrockTemporary(options.requestId,dependencies.tempRoot);
        await checkedProcess(['--version'],temporary,op,undefined,true);const key=credential();op.check();
        const system=allowed!.filter(message=>message.role==='system').map(message=>({text:message.content})),messages=allowed!.filter(message=>message.role!=='system').map(message=>({role:message.role,content:[{text:message.content}]}));
        if(!messages.length)code('INVALID_PROVIDER_REQUEST',400);const body=Buffer.from(JSON.stringify({modelId:row.model,messages,...(system.length?{system}:{}),inferenceConfig:{maxTokens:config.maxOutputTokens}}),'utf8');if(body.length>MAX_OUTBOUND_BYTES)code('INVALID_PROVIDER_REQUEST',400);
        writeBedrockRequest(temporary,body);options.onTemporaryInput?.('present');op.check();
        const value=await checkedProcess(['bedrock-runtime','converse','--cli-input-json','file://'+join(temporary.path,'request.json'),...flags()],temporary,op,key) as any;
        const message=value?.output?.message;if(!message||message.role!=='assistant'||!Array.isArray(message.content)||message.content.length<1||message.content.length>100||!['end_turn','max_tokens','stop_sequence'].includes(value.stopReason))code('PROVIDER_INVALID_RESPONSE');
        let raw='';for(const content of message.content){const part=readDataRecord(content,['text']);if(!part||typeof part.text!=='string')code('PROVIDER_INVALID_RESPONSE');raw+=part.text;if(raw.length>64000)code('PROVIDER_RESPONSE_TOO_LARGE');}
        const metrics=usage(value.usage);if(metrics.completionTokens!==null&&metrics.completionTokens>config.maxOutputTokens)code('PROVIDER_OUTPUT_LIMIT');
        const secrets=[...new Set([key.accessKeyId,key.secretAccessKey,key.sessionToken].filter((value):value is string=>typeof value==='string'))].sort((a,b)=>b.length-a.length);
        for(const secret of secrets)raw=raw.replaceAll(secret,'[REDACTED]');const text=safeText(raw);cleanup();op.check();yield {type:'text',text};op.check();yield {type:'done',usage:metrics};
      }catch(error){op.check();if(error instanceof AppError)throw error;code('PROVIDER_REQUEST_FAILED');}finally{try{cleanup();}finally{op.close();}}
    }
  });
}
