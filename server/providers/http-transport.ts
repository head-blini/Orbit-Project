import { AppError } from '../errors.ts';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList,isIP } from 'node:net';
import { safeText } from '../privacy.ts';
import { readDataRecord,MAX_OUTBOUND_BYTES } from '../guardrails/outbound.ts';

export interface HttpChatMessage {role:'system'|'user'|'assistant';content:string}
export interface HttpTransportAuthorization {
  providerId:'openai-compatible'|'litellm'|'vllm'|'freellmapi'|'local';
  endpoint:string;operation:'models'|'chat';model?:string;messages?:readonly HttpChatMessage[];
}
export interface HttpTransportConfig {
  providerId:HttpTransportAuthorization['providerId'];endpoint:string;approved:boolean;locality:'loopback'|'external';
  credential:()=>string|undefined;requireCredential:boolean;models:readonly string[];
  authorize:(request:Readonly<HttpTransportAuthorization>)=>{allowed:false}|{allowed:true;messages?:readonly HttpChatMessage[]}|Promise<{allowed:false}|{allowed:true;messages?:readonly HttpChatMessage[]}>;
  timeoutMs?:number;maxResponseBytes?:number;maxOutputTokens?:number;
}
export interface HttpProviderUsage {promptTokens:number|null;completionTokens:number|null;totalTokens:number|null;source:'provider'|'unknown'}
/** Text events replace the previous displayed text; they are never raw append-only deltas. */
export type HttpChatEvent={type:'text';text:string}|{type:'done';usage:HttpProviderUsage};

const providers=['openai-compatible','litellm','vllm','freellmapi','local'];
const modelId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
function fail(code:string,status=502):never{throw new AppError(code,status);}
function record(value:unknown):Record<string,unknown>|null {
  if(!object(value))return null;
  try{return readDataRecord(value,Object.keys(value));}catch{return null;}
}
function endpointUrl(endpoint:unknown,locality:unknown):URL {
  if(typeof endpoint!=='string'||endpoint.length>2048)fail('INVALID_PROVIDER_CONFIGURATION',400);
  const match=/^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?(\/[a-zA-Z0-9/._~-]*)?$/.exec(endpoint);
  if(!match)fail('INVALID_PROVIDER_CONFIGURATION',400);
  let url:URL;try{url=new URL(endpoint);}catch{fail('INVALID_PROVIDER_CONFIGURATION',400);}
  if(url.hostname!==match[2].toLowerCase()||(match[3]&&Number(match[3])===0)||(match[4]??'').split('/').some(part=>part==='.'||part==='..'))fail('INVALID_PROVIDER_CONFIGURATION',400);
  if(locality==='loopback'){
    if(url.hostname!=='127.0.0.1'&&url.hostname!=='[::1]')fail('INVALID_PROVIDER_CONFIGURATION',400);
  }else if(locality==='external'){
    if(url.protocol!=='https:'||isIP(url.hostname)||url.hostname.startsWith('[')||/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
      ||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname))fail('INVALID_PROVIDER_CONFIGURATION',400);
  }else fail('INVALID_PROVIDER_CONFIGURATION',400);
  return url;
}

const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(address,prefix,'ipv4');

class Operation {
  controller=new AbortController();private timedOut=false;private timer:NodeJS.Timeout;private external?:AbortSignal;private onAbort:()=>void;
  constructor(timeout:number,signal?:AbortSignal){
    this.external=signal;this.onAbort=()=>this.controller.abort();
    this.timer=setTimeout(()=>{this.timedOut=true;this.controller.abort();},timeout);
    if(signal?.aborted)this.controller.abort();else signal?.addEventListener('abort',this.onAbort,{once:true});
  }
  check(){if(this.controller.signal.aborted)fail(this.timedOut?'PROVIDER_TIMEOUT':'PROVIDER_ABORTED',this.timedOut?504:409);}
  wait<T>(promise:Promise<T>):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      const abort=()=>{try{this.check();}catch(error){reject(error);}};
      const cleanup=()=>this.controller.signal.removeEventListener('abort',abort);
      promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
      if(this.controller.signal.aborted)abort();else this.controller.signal.addEventListener('abort',abort,{once:true});
    });
  }
  error(error:unknown):never{this.check();if(error instanceof AppError)throw error;fail('PROVIDER_REQUEST_FAILED');}
  close(){clearTimeout(this.timer);this.external?.removeEventListener('abort',this.onAbort);this.controller.abort();}
}

function messages(value:unknown):readonly HttpChatMessage[] {
  if(!Array.isArray(value)||value.length<1||value.length>100)fail('INVALID_PROVIDER_REQUEST',400);
  const result=value.map(item=>{
    const data=readDataRecord(item,['role','content']);
    if(!data||!['system','user','assistant'].includes(data.role as string)||typeof data.content!=='string')fail('INVALID_PROVIDER_REQUEST',400);
    return Object.freeze({role:data.role as HttpChatMessage['role'],content:data.content});
  });
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_OUTBOUND_BYTES-512)fail('INVALID_PROVIDER_REQUEST',400);
  return Object.freeze(result);
}
function authorization(value:unknown,chat:boolean):readonly HttpChatMessage[]|undefined {
  const data=record(value);
  if(!data||data.allowed!==true||Object.keys(data).some(key=>key!=='allowed'&&key!=='messages'))fail('PROVIDER_OUTBOUND_DENIED',403);
  if(chat){try{return messages(data.messages);}catch{fail('PROVIDER_OUTBOUND_DENIED',403);}}
  return undefined;
}
const unknownUsage=():HttpProviderUsage=>({promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'});
function usage(value:unknown):HttpProviderUsage {
  if(value===null||value===undefined)return unknownUsage();
  if(!object(value))fail('PROVIDER_INVALID_RESPONSE');
  const read=(key:string)=>{const number=value[key];if(number===undefined||number===null)return null;if(typeof number!=='number'||!Number.isSafeInteger(number)||number<0)fail('PROVIDER_INVALID_RESPONSE');return number;};
  const result={promptTokens:read('prompt_tokens'),completionTokens:read('completion_tokens'),totalTokens:read('total_tokens')};
  return {...result,source:Object.values(result).some(value=>value!==null)?'provider':'unknown'};
}

/** Trusted server configuration only. Construction is inert; every operation reauthorizes. */
export function createHttpProviderTransport(input:HttpTransportConfig,beforeDispatch:()=>void=()=>{}){
  const data=record(input),keys=['providerId','endpoint','approved','locality','credential','requireCredential','models','authorize','timeoutMs','maxResponseBytes','maxOutputTokens'];
  if(!data||Object.keys(data).some(key=>!keys.includes(key))||!providers.includes(data.providerId as string)||typeof data.approved!=='boolean'
    ||typeof data.requireCredential!=='boolean'||typeof data.credential!=='function'||typeof data.authorize!=='function'
    ||!Array.isArray(data.models)||data.models.length<1||data.models.length>100||data.models.some(id=>!modelId(id))||new Set(data.models).size!==data.models.length)fail('INVALID_PROVIDER_CONFIGURATION',400);
  const url=endpointUrl(data.endpoint,data.locality),models=Object.freeze([...(data.models as string[])]);
  const maxOutputTokens=data.maxOutputTokens===undefined?1024:data.maxOutputTokens;
  if(typeof maxOutputTokens!=='number'||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>8192)fail('INVALID_PROVIDER_CONFIGURATION',400);
  const config=Object.freeze({...data,models,maxOutputTokens}) as unknown as Readonly<HttpTransportConfig&{maxOutputTokens:number}>;
  const timeout=config.timeoutMs===undefined?30000:config.timeoutMs,maxBytes=config.maxResponseBytes===undefined?256*1024:config.maxResponseBytes;
  if(!Number.isSafeInteger(timeout)||timeout<10||timeout>120000||!Number.isSafeInteger(maxBytes)||maxBytes<64||maxBytes>1024*1024)fail('INVALID_PROVIDER_CONFIGURATION',400);

  async function prepare(operation:'models'|'chat',op:Operation,chat?:{model:string;messages:readonly HttpChatMessage[]}){
    op.check();if(!config.approved)fail('PROVIDER_NOT_APPROVED',403);
    let model:string|undefined,original:readonly HttpChatMessage[]|undefined;
    if(chat){const row=readDataRecord(chat,['model','messages']);if(!row||typeof row.model!=='string'||!models.includes(row.model))fail('INVALID_PROVIDER_REQUEST',400);model=row.model;original=messages(row.messages);}
    const request=Object.freeze({providerId:config.providerId,endpoint:config.endpoint,operation,...(chat?{model,messages:original}:{})});
    let sanitized:readonly HttpChatMessage[]|undefined;
    try{
      // Copy synchronous results before yielding; asynchronous results are copied
      // in their resolution continuation, before DNS, credentials or socket work.
      const decision=config.authorize(request);
      sanitized=decision instanceof Promise?await op.wait(decision.then(result=>authorization(result,!!chat))):authorization(decision,!!chat);
    }catch(error){op.check();if(error instanceof AppError&&error.message==='PROVIDER_OUTBOUND_DENIED')throw error;fail('PROVIDER_OUTBOUND_DENIED',403);}
    op.check();
    let address=url.hostname==='[::1]'?'::1':url.hostname,family:4|6=address==='::1'?6:4;
    if(config.locality==='external'){
      let resolved:LookupAddress[];
      try{resolved=await op.wait(dns.lookup(url.hostname,{all:true,family:4,verbatim:true}));}catch{op.check();fail('PROVIDER_DESTINATION_REJECTED',403);}
      if(!Array.isArray(resolved)||!resolved.length||resolved.some(item=>item.family!==4||isIP(item.address)!==4||blocked.check(item.address,'ipv4')))fail('PROVIDER_DESTINATION_REJECTED',403);
      address=resolved[0].address;family=4;
    }
    op.check();let credential:string|undefined;
    try{credential=config.credential();if(credential!==undefined&&(typeof credential!=='string'||credential.length<1||credential.length>8192||!/^[\x21-\x7e]+$/.test(credential)))throw new Error();}catch{fail('PROVIDER_CREDENTIAL_REQUIRED',503);}
    if(config.requireCredential&&!credential)fail('PROVIDER_CREDENTIAL_REQUIRED',503);
    op.check();
    const payload=chat?JSON.stringify({model,messages:sanitized,stream:true,stream_options:{include_usage:true},max_tokens:config.maxOutputTokens}):undefined;
    if(payload&&Buffer.byteLength(payload,'utf8')>MAX_OUTBOUND_BYTES)fail('INVALID_PROVIDER_REQUEST',400);
    const path=url.pathname.replace(/\/$/,'')+(operation==='models'?'/models':'/chat/completions');
    const options:https.RequestOptions&{autoSelectFamily:boolean}={protocol:url.protocol,hostname:url.hostname.replace(/^\[|\]$/g,''),port:url.port||undefined,path,method:chat?'POST':'GET',
      agent:false,autoSelectFamily:false,family,signal:op.controller.signal,maxHeaderSize:16384,
      lookup:(_host,_options,callback)=>callback(null,address,family),
      headers:{Accept:chat?'text/event-stream':'application/json','Accept-Encoding':'identity',...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...(credential?{Authorization:'Bearer '+credential}:{})},
      ...(url.protocol==='https:'?{servername:config.locality==='external'?url.hostname:undefined,rejectUnauthorized:true}:{})};
    const response=await op.wait(new Promise<http.IncomingMessage>((resolve,reject)=>{
      beforeDispatch();
      const req=(url.protocol==='https:'?https:http).request(options,resolve);req.on('error',()=>reject(new AppError('PROVIDER_REQUEST_FAILED')));req.end(payload);
    }));
    try{
      const status=response.statusCode??0;
      if(status>=300&&status<400)fail('PROVIDER_REDIRECT_REJECTED');
      if(status===401||status===403)fail('PROVIDER_AUTH_REQUIRED');
      if(status===429)fail('PROVIDER_RATE_LIMITED',503);
      if(status<200||status>=300)fail('PROVIDER_HTTP_ERROR');
      const type=response.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if(type!==(chat?'text/event-stream':'application/json')||(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'))fail('PROVIDER_INVALID_RESPONSE');
      const declared=response.headers['content-length'];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))fail('PROVIDER_RESPONSE_TOO_LARGE');
      return {response,credential};
    }catch(error){response.destroy();throw error;}
  }
  async function* chunks(response:http.IncomingMessage,op:Operation){
    let size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
    try{for await(const chunk of response){op.check();const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)fail('PROVIDER_RESPONSE_TOO_LARGE');
      let decoded:string;try{decoded=decoder.decode(bytes,{stream:true});}catch{fail('PROVIDER_INVALID_RESPONSE');}yield decoded;}
      op.check();try{const tail=decoder.decode();if(tail)yield tail;}catch{fail('PROVIDER_INVALID_RESPONSE');}
    }finally{response.destroy();}
  }
  return Object.freeze({
    async listModels(options:{signal?:AbortSignal}={}):Promise<string[]>{
      const op=new Operation(timeout,options.signal);
      try{const {response}=await prepare('models',op);let text='';for await(const chunk of chunks(response,op))text+=chunk;
        let value:unknown;try{value=JSON.parse(text);}catch{fail('PROVIDER_INVALID_RESPONSE');}
        if(!object(value)||!Array.isArray(value.data)||value.data.length>10000||value.data.some(item=>!object(item)||!modelId(item.id)))fail('PROVIDER_INVALID_RESPONSE');
        const found=new Set(value.data.map(item=>item.id as string));return models.filter(id=>found.has(id));
      }catch(error){return op.error(error);}finally{op.close();}
    },
    async *chat(input:{model:string;messages:readonly HttpChatMessage[]},options:{signal?:AbortSignal}={}):AsyncGenerator<HttpChatEvent>{
      const op=new Operation(timeout,options.signal);let response:http.IncomingMessage|undefined;
      try{
        const prepared=await prepare('chat',op,input);response=prepared.response;
        let pending='',lines:string[]=[],raw='',last:string|undefined,done=false,seen=false;let metrics=unknownUsage();
        const snapshot=(final:boolean)=>safeText(prepared.credential?raw.replaceAll(prepared.credential,'[REDACTED]'):raw,final);
        for await(const chunk of chunks(response,op)){
          pending+=chunk;let newline:number;
          while((newline=pending.indexOf('\n'))!==-1){
            const line=pending.slice(0,newline).replace(/\r$/,'');pending=pending.slice(newline+1);
            if(line.startsWith(':'))continue;
            if(line){if(line.startsWith('data:'))lines.push(line.slice(5).replace(/^ /,''));else if(!/^(?:event|id|retry):/.test(line))fail('PROVIDER_INVALID_RESPONSE');continue;}
            if(!lines.length)continue;const data=lines.join('\n');lines=[];
            if(data==='[DONE]'){if(!seen)fail('PROVIDER_INVALID_RESPONSE');done=true;break;}
            let value:unknown;try{value=JSON.parse(data);}catch{fail('PROVIDER_INVALID_RESPONSE');}
            if(!object(value))fail('PROVIDER_INVALID_RESPONSE');if(Object.hasOwn(value,'error'))fail('PROVIDER_HTTP_ERROR');
            if(!Array.isArray(value.choices)||value.choices.length>1)fail('PROVIDER_INVALID_RESPONSE');
            if(value.usage!==undefined&&value.usage!==null){
              metrics=usage(value.usage);
              // Provider-reported overage invalidates completion evidence. This
              // check cannot undo text already received or provider-side billing.
              if(metrics.completionTokens!==null&&metrics.completionTokens>config.maxOutputTokens)fail('PROVIDER_OUTPUT_LIMIT');
            }
            for(const choice of value.choices){
              if(!object(choice)||(choice.index!==undefined&&choice.index!==0)||!object(choice.delta))fail('PROVIDER_INVALID_RESPONSE');seen=true;
              const delta=choice.delta;if((delta.tool_calls!==undefined&&(!Array.isArray(delta.tool_calls)||delta.tool_calls.length))||delta.function_call!==undefined
                ||(delta.content!==undefined&&delta.content!==null&&typeof delta.content!=='string'))fail('PROVIDER_INVALID_RESPONSE');
              if(typeof delta.content==='string'){raw+=delta.content;if(raw.length>64000)fail('PROVIDER_RESPONSE_TOO_LARGE');const text=snapshot(false);if(text!==last){last=text;yield {type:'text',text};}}
            }
          }
          if(done)break;
        }
        op.check();if(!done)fail('PROVIDER_STREAM_INCOMPLETE');const text=snapshot(true);if(text!==last)yield {type:'text',text};
        op.check();yield {type:'done',usage:metrics};
      }catch(error){op.error(error);}finally{response?.destroy();op.close();}
    },
  });
}
