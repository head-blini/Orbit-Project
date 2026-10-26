import {createHash} from 'node:crypto';
import {posix,win32} from 'node:path';
import {createHttpProviderTransport,type HttpChatMessage} from './http-transport.ts';
import {readDataRecord,inspectOutbound,MAX_OUTBOUND_BYTES} from '../guardrails/outbound.ts';
import {containsCredential} from '../privacy.ts';
export type HttpModelHubProviderId='openai-compatible'|'litellm'|'vllm'|'freellmapi'|'local';
export type ModelHubProviderId=HttpModelHubProviderId|'bedrock';
interface ModelHubConfigurationBase {
  readonly id:string;readonly label:string;readonly providerId:ModelHubProviderId;readonly endpoint:string;
  readonly locality:'loopback'|'external';readonly enabled:boolean;readonly projectPaths:readonly string[];readonly models:readonly string[];
  readonly requireCredential:boolean;readonly credentialEnv:string|null;readonly timeoutMs:number;readonly maxOutputTokens:number;readonly configDigest:string;
}
export interface HttpModelHubConfiguration extends ModelHubConfigurationBase {readonly providerId:HttpModelHubProviderId}
export interface BedrockModelHubConfiguration extends ModelHubConfigurationBase {
  readonly providerId:'bedrock';readonly cliPath:string;readonly region:string;
  readonly credentialEnvs:Readonly<{accessKeyId:string;secretAccessKey:string;sessionToken:string|null}>;
}
export type ModelHubConfiguration=HttpModelHubConfiguration|BedrockModelHubConfiguration;
export interface ConfiguredModelHubRequest {projectPath:string;expectedConfigDigest:string;operation:'models'|'chat';confirmed:boolean;model?:string;messages?:readonly HttpChatMessage[]}
export type ConfiguredModelHubDecision={allowed:false;code:'MODEL_HUB_REQUEST_DENIED'}|{allowed:true;messages?:readonly HttpChatMessage[]};

const fields=['id','label','providerId','endpoint','locality','enabled','projectPaths','models','requireCredential','credentialEnv','timeoutMs','maxOutputTokens'] as const;
const bedrockFields=['id','label','providerId','enabled','projectPaths','models','cliPath','region','credentialEnvs','timeoutMs','maxOutputTokens'] as const;
const providers=['openai-compatible','litellm','vllm','freellmapi','local'];
const trusted=new WeakSet<object>();
const denied=():ConfiguredModelHubDecision=>({allowed:false,code:'MODEL_HUB_REQUEST_DENIED'});
function invalid():never{throw new Error('MODEL_HUB_CONFIGURATION_INVALID');}
function list(value:unknown,minimum:number,maximum:number):unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<minimum||value.length>maximum||Reflect.ownKeys(value).length!==value.length+1)invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value),result:unknown[]=[];
  for(let index=0;index<value.length;index++){const descriptor=descriptors[String(index)];if(!descriptor||!('value' in descriptor))invalid();result.push(descriptor.value);}
  return result;
}
function publicString(value:unknown,maximum:number):value is string {
  return typeof value==='string'&&!!value&&value.length<=maximum&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value)&&!containsCredential(value);
}
function projectPath(value:unknown):value is string {
  if(!publicString(value,2000))return false;
  if(/^[A-Za-z]:\\/.test(value))return win32.isAbsolute(value)&&win32.normalize(value)===value&&value.length>3&&!value.slice(2).includes(':')
    &&!value.includes('/')&&!value.endsWith('\\')&&!value.slice(3).split('\\').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  return value.startsWith('/')&&!value.startsWith('//')&&value.length>1&&!value.includes('\\')&&!value.endsWith('/')&&posix.normalize(value)===value
    &&!value.split('/').some(part=>part==='.'||part==='..');
}
const pathKey=(value:string)=>process.platform==='win32'?value.toLowerCase():value;

/** Server JSON only. No environment values, filesystem, credentials, DNS or network are read. */
export function readModelHubConfiguration(raw:string|undefined):readonly ModelHubConfiguration[]{
  try{
    if(raw===undefined||(typeof raw==='string'&&!raw.trim()))return Object.freeze([]);
    if(typeof raw!=='string'||raw.length>256*1024||Buffer.byteLength(raw,'utf8')>256*1024)invalid();
    const entries=list(JSON.parse(raw),0,16),ids=new Set<string>(),configs:ModelHubConfiguration[]=[];
    for(const input of entries){
      const kind=Object.getOwnPropertyDescriptor(input,'providerId')?.value;
      if(typeof kind==='string'&&kind!=='bedrock'&&!providers.includes(kind))throw new Error('MODEL_HUB_PROVIDER_UNSUPPORTED');
      const data=readDataRecord(input,kind==='bedrock'?bedrockFields:fields);if(!data)invalid();
      if(data.providerId!=='bedrock'&&!providers.includes(data.providerId as string))throw new Error('MODEL_HUB_PROVIDER_UNSUPPORTED');
      if(!publicString(data.id,64)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.id)||ids.has(data.id)||!publicString(data.label,120)
        ||typeof data.enabled!=='boolean'
        ||typeof data.timeoutMs!=='number'||!Number.isSafeInteger(data.timeoutMs)||data.timeoutMs<1000||data.timeoutMs>60000
        ||typeof data.maxOutputTokens!=='number'||!Number.isSafeInteger(data.maxOutputTokens)||data.maxOutputTokens<1||data.maxOutputTokens>8192)invalid();
      const paths=list(data.projectPaths,0,32),models=list(data.models,1,100);
      if(paths.some(path=>!projectPath(path))||models.some(model=>!publicString(model,200)||!/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/.test(model)))invalid();
      const projectPaths=Object.freeze(paths as string[]),allowedModels=Object.freeze(models as string[]);
      if(new Set(projectPaths.map(pathKey)).size!==projectPaths.length||new Set(allowedModels).size!==allowedModels.length)invalid();
      const base={id:data.id,label:data.label,enabled:data.enabled,projectPaths,models:allowedModels,timeoutMs:data.timeoutMs,maxOutputTokens:data.maxOutputTokens};
      let normalized:Omit<HttpModelHubConfiguration,'configDigest'>|Omit<BedrockModelHubConfiguration,'configDigest'>;
      if(data.providerId==='bedrock'){
        if(!projectPath(data.cliPath)||!/(?:\\aws\.exe|\/aws)$/.test(data.cliPath)
          ||projectPaths.some(path=>pathKey(data.cliPath as string)===pathKey(path)||pathKey(data.cliPath as string).startsWith(pathKey(path)+(path.includes('\\')?'\\':'/')))
          ||typeof data.region!=='string'||!/^(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:east|west|central|north|south|northeast|southeast)-[1-9]$/.test(data.region)
          ||allowedModels.some(model=>model.length>140||!/^[a-z0-9-]+\.[a-z0-9][a-z0-9.:-]*$/.test(model)||/^(?:us|eu|apac|global)\./.test(model)))invalid();
        const refs=readDataRecord(data.credentialEnvs,['accessKeyId','secretAccessKey','sessionToken']);
        const ref=(value:unknown):value is string=>typeof value==='string'&&/^ORBIT_BEDROCK_[A-Z0-9_]{1,50}$/.test(value);
        if(!refs||!ref(refs.accessKeyId)||!ref(refs.secretAccessKey)||(refs.sessionToken!==null&&!ref(refs.sessionToken))
          ||new Set([refs.accessKeyId,refs.secretAccessKey,...(refs.sessionToken?[refs.sessionToken]:[])]).size!==(refs.sessionToken?3:2))invalid();
        normalized={...base,providerId:'bedrock',endpoint:'https://bedrock-runtime.'+data.region+'.amazonaws.com',locality:'external',
          requireCredential:true,credentialEnv:null,cliPath:data.cliPath,region:data.region,
          credentialEnvs:Object.freeze({accessKeyId:refs.accessKeyId,secretAccessKey:refs.secretAccessKey,sessionToken:refs.sessionToken as string|null})};
      }else{
        if(!publicString(data.endpoint,2048)||!['loopback','external'].includes(data.locality as string)||typeof data.requireCredential!=='boolean'
          ||(data.credentialEnv!==null&&(typeof data.credentialEnv!=='string'||!/^ORBIT_MODEL_KEY_[A-Z0-9_]{1,50}$/.test(data.credentialEnv)))
          ||(data.requireCredential&&data.credentialEnv===null))invalid();
        // Preserve the original HTTP canonical ordering so existing approvals
        // and cached catalogs are not invalidated by adding a provider kind.
        normalized={id:data.id,label:data.label,providerId:data.providerId as HttpModelHubProviderId,endpoint:data.endpoint,locality:data.locality as 'loopback'|'external',
          enabled:data.enabled,projectPaths,models:allowedModels,requireCredential:data.requireCredential,credentialEnv:data.credentialEnv as string|null,
          timeoutMs:data.timeoutMs,maxOutputTokens:data.maxOutputTokens};
      // Reuse exactly the native transport's inert syntax/locality policy. These
      // callbacks can never grant authority and construction does not invoke them.
      createHttpProviderTransport({providerId:normalized.providerId,endpoint:normalized.endpoint,locality:normalized.locality,approved:false,
        models:normalized.models,requireCredential:normalized.requireCredential,credential:()=>undefined,authorize:()=>({allowed:false}),
        timeoutMs:normalized.timeoutMs,maxOutputTokens:normalized.maxOutputTokens});
      }
      const config=Object.freeze({...normalized,configDigest:createHash('sha256').update(JSON.stringify(normalized)).digest('hex')});
      ids.add(config.id);trusted.add(config);configs.push(config);
    }
    return Object.freeze(configs);
  }catch(error){throw new Error(error instanceof Error&&error.message==='MODEL_HUB_PROVIDER_UNSUPPORTED'?'MODEL_HUB_PROVIDER_UNSUPPORTED':'MODEL_HUB_CONFIGURATION_INVALID');}
}

/** Pure, fail-closed outbound authorization. HTTP/session/project access remains the host's job. */
export function authorizeConfiguredRequest(config:ModelHubConfiguration,request:ConfiguredModelHubRequest):ConfiguredModelHubDecision {
  try{
    if(!config||!trusted.has(config)||!config.enabled)return denied();
    const operation=Object.getOwnPropertyDescriptor(request,'operation');
    if(!operation||!('value' in operation)||!['models','chat'].includes(operation.value))return denied();
    const chat=operation.value==='chat',keys=['projectPath','expectedConfigDigest','operation','confirmed',...(chat?['model','messages']:[])];
    const data=readDataRecord(request,keys);
    if(!data||data.confirmed!==true||data.expectedConfigDigest!==config.configDigest||typeof data.projectPath!=='string'
      ||!config.projectPaths.some(path=>pathKey(path)===pathKey(data.projectPath as string))||(chat&&(typeof data.model!=='string'||!config.models.includes(data.model))))return denied();
    if(!chat)return Object.freeze({allowed:true});
    // Only after destination/project/digest/model/consent gates inspect content.
    const rows=list(data.messages,1,100),messages:HttpChatMessage[]=[];let characters=0;
    for(const row of rows){
      const message=readDataRecord(row,['role','content']);
      if(!message||!['system','user','assistant'].includes(message.role as string)||typeof message.content!=='string')return denied();
      characters+=message.content.length+(messages.length?2:0);if(characters>64000)return denied();
      messages.push(Object.freeze({role:message.role as HttpChatMessage['role'],content:message.content}));
    }
    if(Buffer.byteLength(JSON.stringify(messages),'utf8')>MAX_OUTBOUND_BYTES-512)return denied();
    const combined=messages.map(message=>message.content).join('\n\n');
    if(messages.some(message=>inspectOutbound(message.content).length>0||containsCredential(message.content))||inspectOutbound(combined).length>0||containsCredential(combined))return denied();
    return Object.freeze({allowed:true,messages:Object.freeze(messages)});
  }catch{return denied();}
}
