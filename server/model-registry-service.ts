import {createHash,randomUUID} from 'node:crypto';
import type {RegistryEntry,RegistryOrigin,RegistryValidation,RegistryCost} from '../shared/model-registry.ts';
import type {NativeReadinessReport} from '../shared/native-readiness.ts';
import {Store} from './store.ts';
import {ModelRegistryStore} from './model-registry-store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {readDataRecord} from './guardrails/outbound.ts';
import {readModelHubConfiguration,type ModelHubConfiguration} from './providers/model-hub-configuration.ts';

type Provider=Extract<RegistryEntry,{kind:'provider'}>;
type FinishedState=Exclude<RegistryValidation['state'],'intent'>;
export interface RegistryConnectionContext {
  entry:RegistryEntry;provider:Provider;validation:RegistryValidation;projectPath:string;confirmed:true;
}
export interface RegistryConnectionResult {state:FinishedState;evidenceRefs?:string[]}
export interface RegistryServiceOptions {
  configurations?:readonly ModelHubConfiguration[];
  /** Names only, supplied by the host's existing credential-status read model. Never values. */
  configuredCredentialRefs?:readonly string[];
  /** Cached read model only; no refresh/probe is called by this service. */
  nativeReadiness?:NativeReadinessReport;
  connection?:(context:RegistryConnectionContext)=>Promise<RegistryConnectionResult>;
}
export type RegistryView=RegistryEntry&{
  configDigest:string;authReferences:{name:string;configured:boolean}[];
  nativeStatus:{installation:string;authentication:string;connection:string}|null;
};
export interface RegistryList {entries:RegistryView[];collisions:{id:string;origins:RegistryOrigin[]}[]}
function invalid():never {throw new AppError('INVALID_FIELDS',400);}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const unknownCost=():RegistryCost=>({kind:'unknown',source:'unknown',checkedAt:null,sourceUrl:null,currency:null,unit:null,unitPrice:null});
const epoch='1970-01-01T00:00:00.000Z';

/** Reject accessors and secret-like strings before inspecting or serializing request data. */
function data(input:unknown):unknown {
  let size=0;const seen=new Set<object>();
  function visit(value:unknown,depth:number):void {
    if(depth>12||++size>60000)invalid();
    if(typeof value==='string'){
      size+=Buffer.byteLength(value);if(size>60000)invalid();
      if(containsCredential(value))throw new AppError('REGISTRY_CREDENTIAL_INPUT',400);return;
    }
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
    if(typeof value!=='object'||seen.has(value))invalid();
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)invalid();
    seen.add(value);const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
    if(array&&keys.length!==(value as unknown[]).length+1)invalid();
    for(const key of keys){
      if(typeof key!=='string')invalid();const descriptor=descriptors[key];
      if(!('value' in descriptor)||(!descriptor.enumerable&&!(array&&key==='length')))invalid();
      if(array&&key==='length')continue;visit(key,depth+1);visit(descriptor.value,depth+1);
    }
    seen.delete(value);
  }
  visit(input,0);return JSON.parse(JSON.stringify(input));
}
const exact=(input:unknown,keys:string[])=>readDataRecord(input,keys)??invalid();
function configInput(config:ModelHubConfiguration){
  const base={id:config.id,label:config.label,providerId:config.providerId,enabled:config.enabled,projectPaths:config.projectPaths,models:config.models,timeoutMs:config.timeoutMs,maxOutputTokens:config.maxOutputTokens};
  return config.providerId==='bedrock'?{...base,cliPath:config.cliPath,region:config.region,credentialEnvs:config.credentialEnvs}:
    {...base,endpoint:config.endpoint,locality:config.locality,requireCredential:config.requireCredential,credentialEnv:config.credentialEnv};
}
function normalized(provider:Provider,modelId?:string):readonly ModelHubConfiguration[]{
  const c=provider.connection;
  if(!('projectPaths' in c))return [];
  const base={id:provider.id,label:provider.label,providerId:c.adapterId,enabled:provider.enabled,projectPaths:c.projectPaths,models:[modelId??(c.adapterId==='bedrock'?'example.model':'registry-placeholder')],timeoutMs:c.timeoutMs,maxOutputTokens:c.maxOutputTokens};
  return readModelHubConfiguration(JSON.stringify(c.adapterId==='bedrock'?[{...base,cliPath:c.cliPath,region:c.region,credentialEnvs:{accessKeyId:c.auth.accessKeyId,secretAccessKey:c.auth.secretAccessKey,sessionToken:c.auth.sessionToken}}]:
    [{...base,endpoint:c.endpoint,locality:c.locality,requireCredential:c.auth.kind==='env_ref',credentialEnv:c.auth.kind==='env_ref'?c.auth.env:null}]));
}

/** One instance per server lifecycle. Construction recovers intents; reads never dispatch diagnostics. */
export class ModelRegistryService {
  private store:Store;
  private registry:ModelRegistryStore;
  private projections:RegistryEntry[]=[];
  private projectionDigests=new Map<RegistryEntry,string>();
  private configured:Set<string>;
  private native:NativeReadinessReport|undefined;
  private connection:RegistryServiceOptions['connection'];
  constructor(store:Store,options:RegistryServiceOptions={}){
    this.store=store;this.registry=new ModelRegistryStore(store);
    this.configured=new Set(options.configuredCredentialRefs??[]);this.native=options.nativeReadiness;this.connection=options.connection;
    // Reuse the inert parser and its canonical ordering/digest; never read process.env.
    const configs=readModelHubConfiguration(JSON.stringify((options.configurations??[]).map(configInput)));
    const common=(id:string,label:string,origin:RegistryOrigin,enabled:boolean)=>({id,label,origin,enabled,revision:1,createdAt:epoch,updatedAt:epoch,declaredCapabilities:[],cost:unknownCost()});
    for(const config of configs){
      const limits={projectPaths:[...config.projectPaths],timeoutMs:config.timeoutMs,maxOutputTokens:config.maxOutputTokens};
      const connection:Provider['connection']=config.providerId==='bedrock'?
        {...limits,adapterId:'bedrock',cliPath:config.cliPath,region:config.region,auth:{kind:'aws_env_refs',...config.credentialEnvs}}:
        {...limits,adapterId:config.providerId,endpoint:config.endpoint,locality:config.locality,auth:config.credentialEnv?{kind:'env_ref',env:config.credentialEnv}:{kind:'none'}};
      const provider:RegistryEntry={...common(config.id,config.label,'env',config.enabled),kind:'provider',connection};
      this.projections.push(provider);this.projectionDigests.set(provider,config.configDigest);
      for(const modelId of config.models){
        const entry:RegistryEntry={...common('env-model-'+digest([config.id,modelId]).slice(0,48),modelId,'env',config.enabled),kind:'model',providerId:config.id,modelId};
        this.projections.push(entry);this.projectionDigests.set(entry,digest({configDigest:config.configDigest,modelId}));
      }
    }
    for(const adapterId of ['codex','claude-code'] as const){
      const provider:RegistryEntry={...common('builtin-'+adapterId,adapterId,'builtin',true),kind:'provider',connection:{adapterId,auth:{kind:'native_session'}}};
      const runtime:RegistryEntry={...common(adapterId,adapterId,'builtin',true),kind:'runtime',providerId:provider.id,adapterId};
      this.projections.push(provider,runtime);
      this.projectionDigests.set(provider,digest(provider));this.projectionDigests.set(runtime,digest({runtime,provider}));
    }
    store.transaction(()=>{
      for(const row of store.db.prepare("SELECT body FROM registry_validations WHERE state='intent'").all()){
        this.finish(this.decodeValidation(row.body),'unknown',[]);
      }
    });
  }
  private entries(){return [...this.projections,...this.registry.list()];}
  private lookup(entryId:string):RegistryEntry {
    data(entryId);if(!identifier(entryId))invalid();
    const entries=this.entries().filter(entry=>entry.id===entryId);
    if(entries.length>1)throw new AppError('REGISTRY_ID_CONFLICT',409);
    if(!entries.length)throw new AppError('REGISTRY_ENTRY_NOT_FOUND',404);
    return entries[0];
  }
  private provider(entry:RegistryEntry):Provider {
    const provider=entry.kind==='provider'?entry:this.lookup(entry.providerId);
    if(provider.kind!=='provider')throw new AppError('REGISTRY_PROVIDER_KIND',400);return provider;
  }
  private writable(entryId:string){
    const entry=this.lookup(entryId);if(entry.origin!=='user')throw new AppError('REGISTRY_READ_ONLY',403);return entry;
  }
  private view(entry:RegistryEntry):RegistryView {
    // Resolve by origin here so collisions remain visible rather than hiding the entire list.
    const provider=entry.kind==='provider'?entry:this.entries().find(p=>p.id===entry.providerId&&p.origin===entry.origin&&p.kind==='provider');
    const auth=provider?.kind==='provider'?provider.connection.auth:null;
    const refs=auth?.kind==='env_ref'?[auth.env]:auth?.kind==='aws_env_refs'?[auth.accessKeyId,auth.secretAccessKey,...(auth.sessionToken?[auth.sessionToken]:[])]:[];
    let nativeStatus:RegistryView['nativeStatus']=null;
    const adapter=provider?.kind==='provider'?provider.connection.adapterId:null;
    const choose=(value:unknown,allowed:string[])=>typeof value==='string'&&allowed.includes(value)?value:'unknown';
    if(adapter==='codex'||adapter==='claude-code'){
      const native=adapter==='codex'?this.native?.codex:this.native?.claude;
      nativeStatus={installation:choose(native?.installation.status,['found','not_found_on_path','failed','unknown']),
        authentication:adapter==='codex'?choose(this.native?.codex.authentication,['confirmed','unknown']):choose(this.native?.claude.authentication?.authentication,['subscription','not_authenticated','unsupported','unknown','not_installed']),
        connection:adapter==='codex'?choose(this.native?.codex.connection,['disconnected','connecting','ready','auth_required','not_installed','error']):'unknown'};
    }
    return {...structuredClone(entry),configDigest:entry.origin==='user'?this.registry.configDigest(entry.id):this.projectionDigests.get(entry)!,authReferences:refs.map(name=>({name,configured:this.configured.has(name)})),nativeStatus};
  }
  list():RegistryList {
    const entries=this.entries(),groups=new Map<string,RegistryOrigin[]>();
    for(const entry of entries)groups.set(entry.id,[...(groups.get(entry.id)??[]),entry.origin]);
    return {entries:entries.map(entry=>this.view(entry)),collisions:[...groups].filter(([,origins])=>origins.length>1).map(([id,origins])=>({id,origins}))};
  }
  get(entryId:string):RegistryView {return this.view(this.lookup(entryId));}
  create(input:unknown):RegistryEntry {
    const clean=data(input);
    const id=clean&&typeof clean==='object'&&!Array.isArray(clean)?(clean as Record<string,unknown>).id:null;
    if(this.projections.some(entry=>entry.id===id))throw new AppError('REGISTRY_ID_CONFLICT',409);
    return this.registry.create(clean);
  }
  update(entryId:string,input:unknown):RegistryEntry {this.writable(entryId);return this.registry.update(entryId,input);}
  disable(entryId:string,input:unknown):RegistryEntry {this.writable(entryId);return this.registry.disable(entryId,input);}
  private compatible(entry:RegistryEntry,provider:Provider):boolean {
    const adapter=provider.connection.adapterId;
    if(!['openai-compatible','litellm','vllm','freellmapi','local','bedrock','codex','claude-code'].includes(adapter))return false;
    if(entry.kind==='runtime'&&entry.adapterId!==adapter)return false;
    if(entry.kind==='model'&&(adapter==='codex'||adapter==='claude-code'))return false;
    normalized(provider,entry.kind==='model'?entry.modelId:undefined);return true;
  }
  private decodeValidation(body:unknown):RegistryValidation {
    try{
      const value=data(JSON.parse(String(body))) as RegistryValidation;
      exact(value,['id','requestId','entryId','revision','configDigest','requestDigest','kind','state','createdAt','finishedAt','evidenceRefs','code']);
      if(!identifier(value.id)||!identifier(value.requestId)||!identifier(value.entryId)||!hash(value.configDigest)||!hash(value.requestDigest)
        ||!Number.isSafeInteger(value.revision)||value.revision<1||!['local','connection'].includes(value.kind)
        ||!['intent','passed','failed','unsupported','unknown'].includes(value.state)||!Array.isArray(value.evidenceRefs))invalid();
      return value;
    }catch{throw new AppError('REGISTRY_STORED_DATA_INVALID',409);}
  }
  private byRequest(requestId:string):RegistryValidation|null {
    const row=this.store.db.prepare('SELECT body FROM registry_validations WHERE request_id=?').get(requestId);
    return row?this.decodeValidation(row.body):null;
  }
  validations(entryId:string):RegistryValidation[]{
    this.lookup(entryId);return this.store.db.prepare('SELECT body FROM registry_validations WHERE entry_id=? ORDER BY rowid').all(entryId).map(row=>this.decodeValidation(row.body));
  }
  private finish(record:RegistryValidation,state:FinishedState,evidenceRefs:string[]):RegistryValidation {
    const code:RegistryValidation['code']=state==='passed'?(record.kind==='local'?'REGISTRY_LOCAL_VALID':'REGISTRY_CONNECTION_VERIFIED'):
      state==='failed'?'REGISTRY_VALIDATION_FAILED':state==='unsupported'?'REGISTRY_ADAPTER_UNSUPPORTED':'REGISTRY_VALIDATION_UNKNOWN';
    const result={...record,state,code,evidenceRefs,finishedAt:new Date().toISOString()};
    // A recovered unknown is terminal: late callbacks from an old owner cannot overwrite it.
    this.store.db.prepare("UPDATE registry_validations SET state=?,body=?,finished_at=? WHERE id=? AND state='intent'").run(state,JSON.stringify(result),result.finishedAt,record.id);
    return this.byRequest(record.requestId)!;
  }
  async validate(entryId:string,input:unknown):Promise<RegistryValidation>{
    const clean=data(input);
    if(!clean||typeof clean!=='object'||Array.isArray(clean))invalid();
    const base=exact(clean,['requestId','kind','expectedRevision','expectedConfigDigest',...['confirmed','projectPath'].filter(key=>Object.hasOwn(clean as object,key))]);
    data(entryId);
    if(!identifier(entryId)||!identifier(base.requestId)||!['local','connection'].includes(base.kind as string)||!Number.isSafeInteger(base.expectedRevision)||(base.expectedRevision as number)<1||!hash(base.expectedConfigDigest))invalid();
    if(base.kind==='connection'&&base.confirmed!==true)throw new AppError('REGISTRY_CONFIRMATION_REQUIRED',403);
    if(base.kind==='local'&&(Object.hasOwn(base,'confirmed')||Object.hasOwn(base,'projectPath')))invalid();
    if(base.kind==='connection'&&(typeof base.projectPath!=='string'||!base.projectPath||base.projectPath.length>2000||/[\x00-\x1f\x7f]/.test(base.projectPath)))invalid();
    const requestDigest=digest({entryId,requestId:base.requestId,kind:base.kind,revision:base.expectedRevision,configDigest:base.expectedConfigDigest,confirmed:base.confirmed??false,projectPath:base.projectPath??null});
    const start=this.store.transaction(()=>{
      const prior=this.byRequest(base.requestId as string);
      if(prior){if(prior.requestDigest!==requestDigest)throw new AppError('REGISTRY_REQUEST_CONFLICT',409);return {record:prior,context:null};}
      const entry=this.writable(entryId),provider=this.provider(entry);
      if(entry.revision!==base.expectedRevision)throw new AppError('REGISTRY_REVISION_STALE',409);
      if(this.registry.configDigest(entryId)!==base.expectedConfigDigest)throw new AppError('REGISTRY_CONFIG_STALE',409);
      if(base.kind==='connection'&&'projectPaths' in provider.connection&&!provider.connection.projectPaths.includes(base.projectPath as string))throw new AppError('REGISTRY_PROJECT_DENIED',403);
      const record:RegistryValidation={id:randomUUID(),requestId:base.requestId as string,entryId,revision:entry.revision,configDigest:base.expectedConfigDigest as string,requestDigest,kind:base.kind as RegistryValidation['kind'],state:'intent',createdAt:new Date().toISOString(),finishedAt:null,evidenceRefs:[],code:null};
      this.store.db.prepare('INSERT INTO registry_validations VALUES(?,?,?,?,?,?,?,?,?,?)').run(record.id,record.requestId,record.entryId,record.revision,record.configDigest,record.requestDigest,record.state,JSON.stringify(record),record.createdAt,null);
      return {record,context:{entry,provider}};
    });
    if(!start.context)return start.record;
    const {entry,provider}=start.context;
    let compatible:boolean;
    try{compatible=this.compatible(entry,provider);}catch{return this.finish(start.record,'failed',[]);}
    if(!compatible)return this.finish(start.record,'unsupported',[]);
    if(base.kind==='local')return this.finish(start.record,'passed',[]);
    if(!this.connection)return this.finish(start.record,'unsupported',[]);
    try{
      const current=this.writable(entryId);this.provider(current);
      if(current.revision!==start.record.revision||this.registry.configDigest(entryId)!==start.record.configDigest)
        return this.finish(start.record,'unknown',[]);
      const persisted=this.byRequest(start.record.requestId)!;
      if(persisted.state!=='intent')return persisted;
    }catch{return this.finish(start.record,'unknown',[]);}
    let state:FinishedState='unknown',evidenceRefs:string[]=[];
    try{
      // No await occurs between the revision/digest checks, durable intent and port entry.
      const result=data(await this.connection({entry:structuredClone(entry),provider:structuredClone(provider),validation:structuredClone(start.record),projectPath:base.projectPath as string,confirmed:true}));
      const fields=exact(result,['state',...(Object.hasOwn(result as object,'evidenceRefs')?['evidenceRefs']:[])]);
      if(!['passed','failed','unsupported','unknown'].includes(fields.state as string))invalid();
      const refs=fields.evidenceRefs??[];
      if(!Array.isArray(refs)||refs.length>32||refs.some(ref=>typeof ref!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(ref)))invalid();
      state=fields.state as FinishedState;evidenceRefs=refs;
    }catch{/* Raw diagnostic output/errors never leave the port boundary. */}
    return this.finish(start.record,state,evidenceRefs);
  }
  /** Availability, not dispatch approval. Local syntax checks do not prove a connection. */
  usable(entryId:string):boolean {
    try{
      const entry=this.lookup(entryId),provider=this.provider(entry);
      if(entry.origin!=='user'||!entry.enabled||!provider.enabled||!this.compatible(entry,provider))return false;
      const configDigest=this.registry.configDigest(entryId);
      const latest=this.validations(entryId).filter(v=>v.kind==='connection'&&v.revision===entry.revision&&v.configDigest===configDigest).at(-1);
      return latest?.state==='passed';
    }catch{return false;}
  }
}
