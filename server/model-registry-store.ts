import {createHash} from 'node:crypto';
import type {RegistryEntry,RegistryEntryBody,RegistryConnection,RegistryCost} from '../shared/model-registry.ts';
import {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {readDataRecord} from './guardrails/outbound.ts';
import {readModelHubConfiguration} from './providers/model-hub-configuration.ts';

function invalid():never {throw new AppError('INVALID_FIELDS',400);}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const exact=(value:unknown,keys:string[])=>readDataRecord(value,keys)??invalid();
const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const unknownCost=():RegistryCost=>({kind:'unknown',source:'unknown',checkedAt:null,sourceUrl:null,currency:null,unit:null,unitPrice:null});

/** Inspect data properties only: no getters, toJSON hooks, environment reads or raw error reflection. */
function inputData(input:unknown):unknown {
  let size=0;const seen=new Set<object>();
  function visit(value:unknown,depth:number):void {
    if(depth>12||(size+=1)>60000)invalid();
    if(typeof value==='string'){
      size+=Buffer.byteLength(value,'utf8');if(size>60000)invalid();
      if(containsCredential(value))throw new AppError('REGISTRY_CREDENTIAL_INPUT',400);
      return;
    }
    if(value===null||typeof value==='boolean')return;
    if(typeof value==='number'){if(!Number.isFinite(value))invalid();return;}
    if(typeof value!=='object'||seen.has(value))invalid();
    seen.add(value);
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)invalid();
    const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
    if(array&&keys.length!==(value as unknown[]).length+1)invalid();
    for(const key of keys){
      if(typeof key!=='string')invalid();
      const descriptor=descriptors[key];if(!('value' in descriptor)||(!descriptor.enumerable&&!(array&&key==='length')))invalid();
      if(array&&key==='length')continue;
      visit(key,depth+1);visit(descriptor.value,depth+1);
    }
    seen.delete(value);
  }
  visit(input,0);
  return JSON.parse(JSON.stringify(input));
}
function cost(value:unknown):RegistryCost {
  const data=exact(value,['kind','source','checkedAt','sourceUrl','currency','unit','unitPrice']);
  if(data.source==='provider_reported')throw new AppError('REGISTRY_COST_SOURCE_INVALID',400);
  if(!['subscription','metered_api','local_resource','unknown'].includes(data.kind as string)
    ||!['user_declared','provider_reported','unknown'].includes(data.source as string)
    ||(data.checkedAt!==null&&!timestamp(data.checkedAt))
    ||(data.currency!==null&&(typeof data.currency!=='string'||!/^[A-Z]{3}$/.test(data.currency)))
    ||(data.unit!==null&&!text(data.unit,80))
    ||(data.unitPrice!==null&&(typeof data.unitPrice!=='number'||!Number.isFinite(data.unitPrice)||data.unitPrice<0)))invalid();
  if(data.sourceUrl!==null){
    if(!text(data.sourceUrl,2048))invalid();
    let url:URL;try{url=new URL(data.sourceUrl);}catch{invalid();}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)invalid();
  }
  if(data.source==='unknown'&&(data.checkedAt!==null||data.sourceUrl!==null||data.currency!==null||data.unit!==null||data.unitPrice!==null))invalid();
  if(data.source!=='unknown'&&!timestamp(data.checkedAt))invalid();
  if(data.unitPrice!==null&&(data.currency===null||data.unit===null))invalid();
  if(data.kind==='unknown'&&data.unitPrice!==null)invalid();
  return data as unknown as RegistryCost;
}
function connection(value:unknown,entryId:string,label:string):RegistryConnection {
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const adapter=(value as Record<string,unknown>).adapterId;
  if(['codex','claude-code','other-cli','web'].includes(adapter as string)){
    const data=exact(value,['adapterId','auth']);
    if(adapter==='codex'||adapter==='claude-code'){
      if(exact(data.auth,['kind']).kind!=='native_session')invalid();
    }else{
      const auth=exact(data.auth,['kind','method']);
      if(auth.kind!=='declared'||!['native_session','browser_session','external','none','unknown'].includes(auth.method as string))invalid();
    }
    return data as unknown as RegistryConnection;
  }
  const bedrock=adapter==='bedrock';
  const data=exact(value,bedrock?['adapterId','cliPath','region','auth','projectPaths','timeoutMs','maxOutputTokens']:
    ['adapterId','endpoint','locality','auth','projectPaths','timeoutMs','maxOutputTokens']);
  const base={id:entryId,label,providerId:adapter,enabled:false,projectPaths:data.projectPaths,models:[bedrock?'example.model':'registry-placeholder'],timeoutMs:data.timeoutMs,maxOutputTokens:data.maxOutputTokens};
  let config:unknown;
  if(bedrock){
    const auth=exact(data.auth,['kind','accessKeyId','secretAccessKey','sessionToken']);if(auth.kind!=='aws_env_refs')invalid();
    config={...base,cliPath:data.cliPath,region:data.region,credentialEnvs:{accessKeyId:auth.accessKeyId,secretAccessKey:auth.secretAccessKey,sessionToken:auth.sessionToken}};
  }else{
    const kind=(data.auth as {kind?:unknown}|null)?.kind;
    const auth=exact(data.auth,kind==='env_ref'?['kind','env']:['kind']);if(kind!=='env_ref'&&kind!=='none')invalid();
    config={...base,endpoint:data.endpoint,locality:data.locality,requireCredential:kind==='env_ref',credentialEnv:kind==='env_ref'?auth.env:null};
  }
  // This parser checks syntax only; it never resolves credentials or contacts a provider.
  try{readModelHubConfiguration(JSON.stringify([config]));}catch{throw new AppError('REGISTRY_CONNECTION_INVALID',400);}
  return data as unknown as RegistryConnection;
}
function entryInput(input:unknown):RegistryEntryBody&{enabled:boolean;origin:'user'} {
  const value=inputData(input);
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const data=value as Record<string,unknown>;
  if(data.origin==='env'||data.origin==='builtin')throw new AppError('REGISTRY_READ_ONLY',403);
  const kind=data.kind;
  if(!['provider','runtime','model'].includes(kind as string))invalid();
  const optional=['origin','enabled','declaredCapabilities','cost'].filter(key=>Object.hasOwn(data,key));
  exact(data,['id','kind','label',...(kind==='provider'?['connection']:kind==='runtime'?['providerId','adapterId']:['providerId','modelId']),...optional]);
  if(!id(data.id)||!text(data.label,120)||(Object.hasOwn(data,'origin')&&data.origin!=='user')
    ||(Object.hasOwn(data,'enabled')&&typeof data.enabled!=='boolean'))invalid();
  const capabilities=data.declaredCapabilities??[];
  if(!Array.isArray(capabilities)||capabilities.length>100||capabilities.some(c=>!text(c,100)||!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(c))||new Set(capabilities).size!==capabilities.length)invalid();
  if(Object.hasOwn(data,'declaredCapabilities')&&data.declaredCapabilities===null)invalid();
  const common={id:data.id,label:data.label,origin:'user' as const,enabled:data.enabled===true,declaredCapabilities:capabilities as string[],cost:Object.hasOwn(data,'cost')?cost(data.cost):unknownCost()};
  if(kind==='provider')return {...common,kind,connection:connection(data.connection,data.id,data.label)};
  if(!id(data.providerId))invalid();
  if(kind==='runtime'){
    if(!['codex','claude-code','other-cli','web'].includes(data.adapterId as string))invalid();
    return {...common,kind,providerId:data.providerId,adapterId:data.adapterId as 'codex'|'claude-code'|'other-cli'|'web'};
  }
  if(!text(data.modelId,200)||!/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/.test(data.modelId))invalid();
  return {...common,kind:'model',providerId:data.providerId,modelId:data.modelId};
}

/** User records only. R2 projects env/builtin records from their original sources, never copies them here. */
export class ModelRegistryStore {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS registry_entries (
        id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('provider','runtime','model')),
        provider_id TEXT REFERENCES registry_entries(id),revision INTEGER NOT NULL CHECK(revision>=1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),body TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        CHECK((kind='provider' AND provider_id IS NULL) OR (kind IN ('runtime','model') AND provider_id IS NOT NULL AND provider_id<>id))
      );
      CREATE TABLE IF NOT EXISTS registry_validations (
        id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,entry_id TEXT NOT NULL REFERENCES registry_entries(id),
        revision INTEGER NOT NULL CHECK(revision>=1),config_digest TEXT NOT NULL,request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('intent','passed','failed','unsupported','unknown')),body TEXT NOT NULL,
        created_at TEXT NOT NULL,finished_at TEXT
      );
    `);
  }
  list():RegistryEntry[]{return this.store.db.prepare('SELECT body FROM registry_entries ORDER BY rowid').all().map(row=>this.decode(row.body));}
  get(entryId:string):RegistryEntry {
    this.checkId(entryId);
    const row=this.store.db.prepare('SELECT body FROM registry_entries WHERE id=?').get(entryId);
    if(!row)throw new AppError('REGISTRY_ENTRY_NOT_FOUND',404);
    return this.decode(row.body);
  }
  private decode(body:unknown):RegistryEntry {
    // Recheck stored strings before returning them, including databases populated by older callers.
    try{return inputData(JSON.parse(String(body))) as RegistryEntry;}catch{throw new AppError('REGISTRY_STORED_DATA_INVALID',409);}
  }
  private checkId(entryId:unknown){inputData(entryId);if(!id(entryId))invalid();}
  private writable(entry:RegistryEntry){if(entry.origin!=='user')throw new AppError('REGISTRY_READ_ONLY',403);}
  private revision(value:unknown){if(!Number.isSafeInteger(value)||(value as number)<0)invalid();}
  private references(entry:RegistryEntryBody){
    if(entry.kind==='provider')return;
    if(entry.providerId===entry.id)throw new AppError('REGISTRY_PROVIDER_KIND',400);
    const row=this.store.db.prepare('SELECT body FROM registry_entries WHERE id=?').get(entry.providerId);
    if(!row)throw new AppError('REGISTRY_PROVIDER_NOT_FOUND',400);
    const provider=this.decode(row.body);if(provider.kind!=='provider')throw new AppError('REGISTRY_PROVIDER_KIND',400);
    if(entry.kind==='runtime'&&entry.adapterId!==provider.connection.adapterId)throw new AppError('REGISTRY_ADAPTER_MISMATCH',400);
    if(entry.kind==='model'){
      if(provider.connection.adapterId==='bedrock'&&(entry.modelId.length>140||!/^[a-z0-9-]+\.[a-z0-9][a-z0-9.:-]*$/.test(entry.modelId)||/^(?:us|eu|apac|global)\./.test(entry.modelId)))invalid();
      const duplicate=this.store.db.prepare("SELECT id FROM registry_entries WHERE kind='model' AND provider_id=? AND json_extract(body,'$.modelId')=? AND id<>?").get(entry.providerId,entry.modelId,entry.id);
      if(duplicate)throw new AppError('REGISTRY_MODEL_CONFLICT',409);
    }
  }
  private audit(entry:RegistryEntry,action:'created'|'updated'|'disabled'){
    this.store.append('registry.'+action,null,{entryId:entry.id,revision:entry.revision,code:'REGISTRY_'+action.toUpperCase()});
  }
  create(input:unknown):RegistryEntry {
    const body=entryInput(input);
    return this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM registry_entries WHERE id=?').get(body.id))throw new AppError('REGISTRY_ID_CONFLICT',409);
      this.references(body);
      const now=new Date().toISOString(),entry:RegistryEntry={...body,revision:1,createdAt:now,updatedAt:now};
      inputData(entry);
      this.store.db.prepare('INSERT INTO registry_entries(id,kind,provider_id,revision,enabled,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(entry.id,entry.kind,entry.kind==='provider'?null:entry.providerId,entry.revision,Number(entry.enabled),JSON.stringify(entry),now,now);
      this.audit(entry,'created');return entry;
    });
  }
  update(entryId:string,input:unknown):RegistryEntry {
    this.checkId(entryId);const data=exact(inputData(input),['expectedRevision','entry']);this.revision(data.expectedRevision);
    const body=entryInput(data.entry);if(body.id!==entryId)invalid();
    return this.store.transaction(()=>{
      const current=this.get(entryId);this.writable(current);
      if(current.revision!==data.expectedRevision)throw new AppError('REGISTRY_REVISION_STALE',409);
      if(current.kind!==body.kind)throw new AppError('REGISTRY_KIND_IMMUTABLE',400);
      this.references(body);
      // A provider edit must not invalidate the kind/adapter contracts of its existing children.
      if(body.kind==='provider'){
        for(const child of this.list().filter(e=>e.kind!=='provider'&&e.providerId===entryId)){
          if(child.kind==='runtime'&&child.adapterId!==body.connection.adapterId)throw new AppError('REGISTRY_ADAPTER_MISMATCH',400);
          if(child.kind==='model'&&body.connection.adapterId==='bedrock'&&(child.modelId.length>140||!/^[a-z0-9-]+\.[a-z0-9][a-z0-9.:-]*$/.test(child.modelId)||/^(?:us|eu|apac|global)\./.test(child.modelId)))invalid();
        }
      }
      const next:RegistryEntry={...body,revision:current.revision+1,createdAt:current.createdAt,updatedAt:new Date().toISOString()};
      if(!Number.isSafeInteger(next.revision))throw new AppError('REGISTRY_REVISION_EXHAUSTED',409);
      this.write(next);this.audit(next,'updated');return next;
    });
  }
  disable(entryId:string,input:unknown):RegistryEntry {
    this.checkId(entryId);const data=exact(inputData(input),['expectedRevision']);this.revision(data.expectedRevision);
    return this.store.transaction(()=>{
      const current=this.get(entryId);this.writable(current);
      if(current.revision!==data.expectedRevision)throw new AppError('REGISTRY_REVISION_STALE',409);
      if(!current.enabled)return current;
      const next={...current,enabled:false,revision:current.revision+1,updatedAt:new Date().toISOString()};
      if(!Number.isSafeInteger(next.revision))throw new AppError('REGISTRY_REVISION_EXHAUSTED',409);
      this.write(next);this.audit(next,'disabled');return next;
    });
  }
  private write(entry:RegistryEntry){
    inputData(entry);
    this.store.db.prepare('UPDATE registry_entries SET provider_id=?,revision=?,enabled=?,body=?,updated_at=? WHERE id=?')
      .run(entry.kind==='provider'?null:entry.providerId,entry.revision,Number(entry.enabled),JSON.stringify(entry),entry.updatedAt,entry.id);
  }
  /** Includes parent revision: disable/re-enable never revives a previous child validation or approval. */
  configDigest(entryId:string):string {
    const entry=this.get(entryId),provider=entry.kind==='provider'?null:this.get(entry.providerId);
    return createHash('sha256').update(JSON.stringify({entry,provider})).digest('hex');
  }
  /** Availability only, not execution authorization or verified capability. */
  isEnabled(entryId:string):boolean {
    const entry=this.get(entryId);return entry.enabled&&(entry.kind==='provider'||this.get(entry.providerId).enabled);
  }
}
