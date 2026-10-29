import { createHash,randomUUID } from 'node:crypto';
import {bedrockTemporaryRoot} from './providers/bedrock-temporary.ts';
import type { Store } from './store.ts';
import { AppError } from './errors.ts';
import { safeText } from './privacy.ts';
import { createHttpProviderTransport } from './providers/http-transport.ts';
import {createBedrockProviderTransport,cleanupBedrockInput,type BedrockTransportDependencies,type BedrockTemporaryState} from './providers/bedrock-transport.ts';
import type {ModelRegistryService} from './model-registry-service.ts';
import { authorizeConfiguredRequest,readModelHubConfiguration,type ModelHubConfiguration } from './providers/model-hub-configuration.ts';
import type { ModelHubCatalog,ModelHubRequest,ModelHubView,ModelHubUsage } from '../shared/model-hub.ts';

export interface RegistryHubConfiguration {
  configuration:ModelHubConfiguration;revision:number;registryDigest:string;usable:boolean;models:readonly string[];
}
export interface ModelHubTransports {
  http?:typeof createHttpProviderTransport;bedrock?:typeof createBedrockProviderTransport;
}
/** Normalize user records through the same inert parser as environment configuration. */
export function registryHubConfigurations(registry:ModelRegistryService):RegistryHubConfiguration[]{
  const entries=registry.list().entries;
  return entries.flatMap(provider=>{
    if(provider.origin!=='user'||provider.kind!=='provider'||!('projectPaths' in provider.connection))return [];
    const c=provider.connection;
    const models=entries.filter(entry=>entry.origin==='user'&&entry.kind==='model'&&entry.providerId===provider.id);
    const enabled=models.filter(entry=>entry.enabled);
    const modelIds=enabled.flatMap(entry=>entry.kind==='model'?[entry.modelId]:[]);
    const supported=modelIds.length>0&&modelIds.length<=100;
    const base={id:provider.id,label:provider.label,providerId:c.adapterId,enabled:provider.enabled,projectPaths:c.projectPaths,
      // Parser requires 1–100 models; diagnostic-only placeholders never grant chat or enter public views.
      models:supported?modelIds:[c.adapterId==='bedrock'?'example.model':'registry-placeholder'],
      timeoutMs:c.timeoutMs,maxOutputTokens:c.maxOutputTokens};
    const configuration=readModelHubConfiguration(JSON.stringify([c.adapterId==='bedrock'?
      {...base,cliPath:c.cliPath,region:c.region,credentialEnvs:{accessKeyId:c.auth.accessKeyId,secretAccessKey:c.auth.secretAccessKey,sessionToken:c.auth.sessionToken}}:
      {...base,endpoint:c.endpoint,locality:c.locality,requireCredential:c.auth.kind==='env_ref',credentialEnv:c.auth.kind==='env_ref'?c.auth.env:null}]))[0];
    return [{configuration,revision:provider.revision,
      registryDigest:createHash('sha256').update(JSON.stringify([provider.configDigest,...models.map(model=>model.configDigest)])).digest('hex'),
      models:modelIds,usable:supported&&registry.usable(provider.id)}];
  });
}

const unknownUsage=():ModelHubUsage=>({promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'});
const emptyCatalog=():ModelHubCatalog=>({status:'not_queried',models:[],checkedAt:null,issue:null});
const needsCleanup=(record:ModelHubRequest)=>record.providerId==='bedrock'&&['possible','present','cleanup_required'].includes(record.temporaryInput??'possible')&&record.execution!=='running';
const issues=new Set(['PROVIDER_ABORTED','PROVIDER_TIMEOUT','PROVIDER_DESTINATION_REJECTED','PROVIDER_CREDENTIAL_REQUIRED','PROVIDER_REQUEST_FAILED','PROVIDER_REDIRECT_REJECTED','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_HTTP_ERROR','PROVIDER_INVALID_RESPONSE','PROVIDER_RESPONSE_TOO_LARGE','PROVIDER_STREAM_INCOMPLETE','PROVIDER_OUTBOUND_DENIED','PROVIDER_OUTPUT_LIMIT',
  'REGISTRY_DISPATCH_DENIED','REGISTRY_ID_CONFLICT','BEDROCK_CLI_NOT_FOUND','BEDROCK_CLI_UNTRUSTED','BEDROCK_CLI_UNSUPPORTED','BEDROCK_TEMPORARY_INPUT_FAILED','BEDROCK_CLEANUP_REQUIRED','SOLO_RECOVERY_REQUIRED']);
const issue=(error:unknown)=>error instanceof AppError&&issues.has(error.message)?error.message:'PROVIDER_REQUEST_FAILED';
type Consent={projectId:string;expectedConfigDigest:string;confirmed:boolean};
type Input=Consent&{requestId:string;destinationId:string;model:string;text:string};

/** Text-only gateway. Native agent subscription sessions and code execution remain separate. */
export class ModelHubService {
  private store:Store;private configurations:readonly ModelHubConfiguration[];private readCredential:(name:string)=>string|undefined;
  private pending=new Map<string,{controller:AbortController;task:Promise<void>}>();
  private diagnostics=new Map<string,{controller:AbortController;task:Promise<ModelHubCatalog>}>();
  private cleanupTasks=new Map<string,Promise<ModelHubRequest>>();
  private bedrockDependencies:BedrockTransportDependencies;
  private admission:()=>void;
  private userConfigurations:()=>readonly RegistryHubConfiguration[];
  private registrySnapshots=new WeakMap<ModelHubConfiguration,RegistryHubConfiguration>();
  private transports:ModelHubTransports;
  constructor(store:Store,configurations:readonly ModelHubConfiguration[]=[],readCredential:(name:string)=>string|undefined=name=>process.env[name],bedrockDependencies:BedrockTransportDependencies={},admission:()=>void=()=>{},userConfigurations:()=>readonly RegistryHubConfiguration[]=()=>[],transports:ModelHubTransports={}){
    this.admission=admission;this.userConfigurations=userConfigurations;this.transports=transports;
    this.store=store;this.configurations=[...configurations];this.readCredential=readCredential;
    this.bedrockDependencies=Object.freeze({...bedrockDependencies});
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_hub_requests(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_hub_catalogs(destination_id TEXT PRIMARY KEY,config_digest TEXT NOT NULL,body TEXT NOT NULL);`);
    for(const row of store.db.prepare('SELECT body FROM model_hub_requests').all()){
      const record=JSON.parse(row.body as string) as ModelHubRequest;
      if(record.execution==='running')this.update(record.id,{execution:'lost',finishedAt:new Date().toISOString(),durationMs:null,issue:'RESULT_UNCERTAIN',
        ...(record.providerId==='bedrock'&&record.temporaryInput!=='removed'?{temporaryInput:'possible' as const}:{})});
    }
  }
  get active(){return this.pending.size>0;}
  get configured(){return this.allConfigurations().length>0;}
  get externalEnabled(){return this.allConfigurations().some(config=>config.enabled&&config.locality==='external');}
  private project(id:string){const project=this.store.projects().find(project=>project.id===id);if(!project)throw new AppError('PROJECT_NOT_FOUND',404);return project;}
  private allConfigurations(){
    const users=this.userConfigurations();
    for(const entry of users)this.registrySnapshots.set(entry.configuration,entry);
    return [...this.configurations,...users.filter(entry=>!this.configurations.some(config=>config.id===entry.configuration.id)).map(entry=>entry.configuration)];
  }
  private configuration(id:string){
    const configs=this.allConfigurations();
    if(this.configurations.some(config=>config.id===id)&&this.userConfigurations().some(entry=>entry.configuration.id===id))throw new AppError('REGISTRY_ID_CONFLICT',409);
    const config=configs.find(config=>config.id===id);if(!config)throw new AppError('MODEL_DESTINATION_NOT_FOUND',404);return config;
  }
  private checkRegistry(config:ModelHubConfiguration,validationGuard?:()=>void){
    const snapshot=this.registrySnapshots.get(config),users=this.userConfigurations();
    if(this.configurations.some(env=>env.id===config.id)&&users.some(entry=>entry.configuration.id===config.id))throw new AppError('REGISTRY_ID_CONFLICT',409);
    if(!snapshot)return;
    const matches=users.filter(entry=>entry.configuration.id===config.id),current=matches[0];
    if(matches.length!==1||!current.configuration.enabled||current.revision!==snapshot.revision||current.registryDigest!==snapshot.registryDigest
      ||current.configuration.configDigest!==config.configDigest||(!validationGuard&&!current.usable))throw new AppError('REGISTRY_DISPATCH_DENIED',409);
    validationGuard?.();
  }
  private configDigest(config:ModelHubConfiguration){
    const snapshot=this.registrySnapshots.get(config);
    return snapshot?createHash('sha256').update(JSON.stringify([config.configDigest,snapshot.revision,snapshot.registryDigest])).digest('hex'):config.configDigest;
  }
  private approvedDigest(config:ModelHubConfiguration,expected:string){
    return expected===this.configDigest(config)?config.configDigest:'';
  }
  private catalog(config:ModelHubConfiguration):ModelHubCatalog {
    const row=this.store.db.prepare('SELECT body FROM model_hub_catalogs WHERE destination_id=? AND config_digest=?').get(config.id,this.configDigest(config));
    return row?JSON.parse(row.body as string):emptyCatalog();
  }
  private decision(config:ModelHubConfiguration,consent:Consent,operation:'models'|'chat',chat?:{model:string;text:string}){
    const project=this.project(consent.projectId);
    return authorizeConfiguredRequest(config,{projectPath:project.path,expectedConfigDigest:this.approvedDigest(config,consent.expectedConfigDigest),operation,confirmed:consent.confirmed,...(chat?{model:chat.model,messages:[{role:'user' as const,content:chat.text}]}:{})});
  }
  private transport(config:ModelHubConfiguration,consent:Consent,operation:'models'|'chat',validationGuard?:()=>void){
    this.checkRegistry(config,validationGuard);
    const beforeDispatch=()=>{this.admission();this.checkRegistry(config,validationGuard);};
    if(config.providerId==='bedrock'){
      const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
      if([...this.store.projects(),...this.store.workspaces()].some(item=>key(config.cliPath)===key(item.path)||key(config.cliPath).startsWith(key(item.path)+(item.path.includes('\\')?'\\':'/'))))throw new AppError('BEDROCK_CLI_UNTRUSTED',403);
      return (this.transports.bedrock??createBedrockProviderTransport)({providerId:'bedrock',cliPath:config.cliPath,region:config.region,approved:config.enabled,
      models:config.models,timeoutMs:config.timeoutMs,maxOutputTokens:config.maxOutputTokens,
      credential:()=>({accessKeyId:this.readCredential(config.credentialEnvs.accessKeyId),secretAccessKey:this.readCredential(config.credentialEnvs.secretAccessKey),
        ...(config.credentialEnvs.sessionToken?{sessionToken:this.readCredential(config.credentialEnvs.sessionToken)}:{})}),
      authorize:request=>{
        if(request.providerId!=='bedrock'||request.region!==config.region||request.operation!==operation)return {allowed:false};
        return authorizeConfiguredRequest(config,{projectPath:this.project(consent.projectId).path,expectedConfigDigest:this.approvedDigest(config,consent.expectedConfigDigest),operation,confirmed:consent.confirmed,
          ...(operation==='chat'?{model:request.model,messages:request.messages}:{})});
      }},operation==='chat'?this.bedrockInputDependencies():this.bedrockDependencies,beforeDispatch);
    }
    return (this.transports.http??createHttpProviderTransport)({providerId:config.providerId,endpoint:config.endpoint,approved:config.enabled,locality:config.locality,models:config.models,
      requireCredential:config.requireCredential,credential:()=>config.credentialEnv?this.readCredential(config.credentialEnv):undefined,timeoutMs:config.timeoutMs,maxOutputTokens:config.maxOutputTokens,
      authorize:request=>{
        if(request.endpoint!==config.endpoint||request.providerId!==config.providerId||request.operation!==operation)return {allowed:false};
        return authorizeConfiguredRequest(config,{projectPath:this.project(consent.projectId).path,expectedConfigDigest:this.approvedDigest(config,consent.expectedConfigDigest),operation,confirmed:consent.confirmed,
          ...(operation==='chat'?{model:request.model,messages:request.messages}:{})});
      }},beforeDispatch);
  }
  private bedrockInputDependencies():BedrockTransportDependencies {
    const root=this.store.getMeta('bedrockTemporaryRoot');
    if(!root)throw new AppError('BEDROCK_CLEANUP_REQUIRED',409);
    return {...this.bedrockDependencies,tempRoot:root};
  }
  view(projectId:string|null):ModelHubView {
    const project=projectId?this.project(projectId):null;
    const history=project?this.store.db.prepare('SELECT body FROM model_hub_requests WHERE project_id=? ORDER BY rowid DESC').all(project.id).map(row=>JSON.parse(row.body as string) as ModelHubRequest):[];
    const requests=[...history.filter(needsCleanup),...history.filter(record=>!needsCleanup(record))].slice(0,20);
    const bedrockRecovery=this.store.db.prepare('SELECT body FROM model_hub_requests').all().map(row=>JSON.parse(row.body as string) as ModelHubRequest).filter(needsCleanup).map(record=>({projectId:record.projectId,requestId:record.id}));
    return {providers:[...(['openai-compatible','litellm','vllm','freellmapi','local'] as const).map(id=>({id,implementation:'http_json_sse' as const})),{id:'bedrock',implementation:'aws_cli_converse'},{id:'future',implementation:'extension_point'}],
      destinations:this.allConfigurations().map(config=>({id:config.id,label:config.label,providerId:config.providerId,endpoint:config.endpoint,locality:config.locality,
        status:!config.enabled?'disabled':project&&this.decision(config,{projectId:project.id,expectedConfigDigest:this.configDigest(config),confirmed:true},'models').allowed?'configured':'project_blocked',
        configDigest:this.configDigest(config),configuredModels:[...(this.registrySnapshots.get(config)?.models??config.models)],credential:config.providerId==='bedrock'||config.credentialEnv?'reference_configured':'not_required',
        transport:config.providerId==='bedrock'?'aws_cli_converse':'http_json_sse',timeoutMs:config.timeoutMs,maxOutputTokens:config.maxOutputTokens,catalog:this.catalog(config)})),
      requests,bedrockRecovery,activeRequestId:this.pending.keys().next().value??null,billing:'separate_from_native_subscription',costSource:'unknown'};
  }
  async diagnose(destinationId:string,consent:Consent,validationGuard?:()=>void):Promise<ModelHubCatalog> {
    this.admission();
    const config=this.configuration(destinationId);
    this.checkRegistry(config,validationGuard);
    if(!this.decision(config,consent,'models').allowed)throw new AppError('MODEL_HUB_REQUEST_DENIED',403);
    const diagnosticKey=this.registrySnapshots.has(config)?config.id+':'+this.configDigest(config):config.id;
    const existing=this.diagnostics.get(diagnosticKey);if(existing)return existing.task;
    const previous=this.catalog(config);if(!validationGuard&&previous.checkedAt&&Date.now()-Date.parse(previous.checkedAt)>=0&&Date.now()-Date.parse(previous.checkedAt)<60000)return previous;
    const controller=new AbortController();
    const task=Promise.resolve().then(async()=>{
      let catalog:ModelHubCatalog;
      try{this.admission();const found=await this.transport(config,consent,'models',validationGuard).listModels({signal:controller.signal});const registered=this.registrySnapshots.get(config)?.models;const models=registered?found.filter(model=>registered.includes(model)):found;catalog={status:models.length?'available':'empty',models,checkedAt:new Date().toISOString(),issue:null};}
      catch(error){catalog={status:'failed',models:[],checkedAt:new Date().toISOString(),issue:issue(error)};}
      this.store.transaction(()=>{
        this.store.db.prepare('INSERT INTO model_hub_catalogs VALUES(?,?,?) ON CONFLICT(destination_id) DO UPDATE SET config_digest=excluded.config_digest,body=excluded.body').run(config.id,this.configDigest(config),JSON.stringify(catalog));
        this.store.append('model.catalog_updated',null,{destinationId:config.id,status:catalog.status});
      });return catalog;
    }).finally(()=>this.diagnostics.delete(diagnosticKey));
    this.diagnostics.set(diagnosticKey,{controller,task});return task;
  }
  start(input:Input):ModelHubRequest {
    if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.requestId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000)throw new AppError('INVALID_MODEL_REQUEST',400);
    this.project(input.projectId);
    const digest=createHash('sha256').update(JSON.stringify({projectId:input.projectId,destinationId:input.destinationId,model:input.model,text:input.text,expectedConfigDigest:input.expectedConfigDigest,confirmed:input.confirmed})).digest('hex');
    const prior=this.store.db.prepare('SELECT digest,body FROM model_hub_requests WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(prior.body as string);}
    this.admission();
    const config=this.configuration(input.destinationId);
    this.checkRegistry(config);
    if(!this.decision(config,input,'chat',{model:input.model,text:input.text}).allowed)throw new AppError('MODEL_HUB_REQUEST_DENIED',403);
    const catalog=this.catalog(config);if(catalog.status!=='available'||!catalog.models.includes(input.model))throw new AppError('MODEL_CATALOG_REQUIRED',409);
    if(this.active)throw new AppError('MODEL_REQUEST_ACTIVE',409);
    if(config.providerId==='bedrock'&&this.store.db.prepare('SELECT body FROM model_hub_requests').all().some(row=>{
      const previous=JSON.parse(row.body as string) as ModelHubRequest;
      return previous.providerId==='bedrock'&&['possible','present','cleanup_required'].includes(previous.temporaryInput??'possible');
    }))throw new AppError('BEDROCK_RECOVERY_REQUIRED',409);
    const record:ModelHubRequest={id:randomUUID(),requestId:input.requestId,projectId:input.projectId,destinationId:config.id,providerId:config.providerId,model:input.model,configDigest:this.configDigest(config),
      execution:'running',response:'',issue:null,usage:unknownUsage(),costUsd:null,createdAt:new Date().toISOString(),finishedAt:null,durationMs:null,timeoutMs:config.timeoutMs,maxOutputTokens:config.maxOutputTokens,
      temporaryInput:config.providerId==='bedrock'?'possible':'none'};
    this.store.transaction(()=>{
      const usage=this.store.db.prepare('SELECT count(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM model_hub_requests WHERE project_id=?').get(input.projectId)!;
      // One UTF-16 response unit can occupy six JSON bytes after escaping.
      // Reserve the complete bounded response plus final status metadata before sending.
      const reserved=Buffer.byteLength(JSON.stringify(record),'utf8')+64000*6+4096;
      if(Number(usage.count)>=200||Number(usage.bytes)+reserved>16*1024*1024)throw new AppError('MODEL_HISTORY_QUOTA',413);
      // Persist the owned base before any process/input file. A restarted server
      // with a different TEMP must clean the original location, not a new one.
      if(config.providerId==='bedrock'&&!this.store.getMeta('bedrockTemporaryRoot'))this.store.setMeta('bedrockTemporaryRoot',bedrockTemporaryRoot(this.bedrockDependencies.tempRoot));
      this.store.db.prepare('INSERT INTO model_hub_requests VALUES(?,?,?,?,?)').run(record.id,record.requestId,digest,record.projectId,JSON.stringify(record));
      this.store.append('model.request_updated',null,{requestId:record.id,projectId:record.projectId,destinationId:record.destinationId,execution:record.execution});
    });
    const controller=new AbortController(),snapshot={...input};
    const task=Promise.resolve().then(()=>this.execute(record,config,snapshot,controller.signal)).finally(()=>this.pending.delete(record.id));
    this.pending.set(record.id,{controller,task});return record;
  }
  private update(id:string,patch:Partial<ModelHubRequest>,allowTerminal=false){
    const row=this.store.db.prepare('SELECT body FROM model_hub_requests WHERE id=?').get(id);if(!row)throw new AppError('MODEL_REQUEST_NOT_FOUND',404);
    const previous=JSON.parse(row.body as string) as ModelHubRequest;if(previous.execution!=='running'&&!allowTerminal)return previous;
    const record={...previous,...patch};
    this.store.transaction(()=>{this.store.db.prepare('UPDATE model_hub_requests SET body=? WHERE id=?').run(JSON.stringify(record),id);if(patch.execution||patch.temporaryInput)this.store.append('model.request_updated',null,{requestId:record.id,projectId:record.projectId,destinationId:record.destinationId,execution:record.execution});});return record;
  }
  private async execute(record:ModelHubRequest,config:ModelHubConfiguration,input:Input,signal:AbortSignal){
    const start=performance.now();let done=false,usage=unknownUsage(),response='',lastWrite=-Infinity;
    try{
      this.admission();
      const options={signal,requestId:record.id,onTemporaryInput:(state:BedrockTemporaryState)=>{this.update(record.id,{temporaryInput:state});}};
      for await(const event of this.transport(config,input,'chat').chat({model:input.model,messages:[{role:'user',content:input.text}]},
        options)){
        if(event.type==='text'){response=safeText(event.text);if(performance.now()-lastWrite>=200){this.update(record.id,{response});lastWrite=performance.now();}}else {done=true;usage={...event.usage};}
      }
      if(signal.aborted)throw new AppError('PROVIDER_ABORTED');if(!done)throw new AppError('PROVIDER_STREAM_INCOMPLETE');
      this.update(record.id,{execution:'completed',response,usage,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start)});
    }catch(error){this.update(record.id,{execution:signal.aborted?'interrupted':'failed',response,issue:signal.aborted?'PROVIDER_ABORTED':issue(error),finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start)});}
  }
  interrupt(projectId:string,id:string){
    this.project(projectId);const row=this.store.db.prepare('SELECT body FROM model_hub_requests WHERE id=? AND project_id=?').get(id,projectId);
    if(!row)throw new AppError('MODEL_REQUEST_NOT_FOUND',404);this.pending.get(id)?.controller.abort();
  }
  async cleanup(projectId:string,id:string,confirmedStopped:boolean):Promise<ModelHubRequest>{
    this.project(projectId);
    const row=this.store.db.prepare('SELECT body FROM model_hub_requests WHERE id=? AND project_id=?').get(id,projectId);
    if(!row)throw new AppError('MODEL_REQUEST_NOT_FOUND',404);
    const record=JSON.parse(row.body as string) as ModelHubRequest;
    if(confirmedStopped!==true)throw new AppError('BEDROCK_STOP_CONFIRMATION_REQUIRED',409);
    if(record.providerId!=='bedrock'||record.execution==='running'||this.pending.has(id))throw new AppError('BEDROCK_CLEANUP_UNAVAILABLE',409);
    if(record.temporaryInput==='removed'||record.temporaryInput==='none')return record;
    const existing=this.cleanupTasks.get(id);if(existing)return existing;
    const task=Promise.resolve().then(async()=>{
      try{await cleanupBedrockInput(id,this.bedrockInputDependencies());return this.update(id,{temporaryInput:'removed'},true);}
      catch{this.update(id,{temporaryInput:'cleanup_required'},true);throw new AppError('BEDROCK_CLEANUP_REQUIRED',409);}
    }).finally(()=>this.cleanupTasks.delete(id));
    this.cleanupTasks.set(id,task);return task;
  }
  async settle(){await Promise.all([...this.pending.values()].map(value=>value.task));}
  async close(){for(const value of [...this.pending.values(),...this.diagnostics.values()])value.controller.abort();await Promise.allSettled([...this.pending.values(),...this.diagnostics.values()].map(value=>value.task));await Promise.allSettled([...this.cleanupTasks.values()]);}
}
