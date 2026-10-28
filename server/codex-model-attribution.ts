import {isIP} from 'node:net';
import type {CodexModelAttribution,CodexModelObservation,CodexModelSource,CodexModelStatus} from '../shared/codex-model-attribution.ts';
import {nativeModelId} from './runtimes/model-identity.ts';
import {containsCredential} from './privacy.ts';
import {inspectOutbound} from './guardrails/outbound.ts';

function own(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor&&!('value' in descriptor))throw new Error('INVALID_MODEL_OBSERVATION');
  return descriptor?.value;
}
function model(value:unknown):string|null {
  const candidate=nativeModelId(value);
  return candidate&&!candidate.includes('://')&&!isIP(candidate)&&inspectOutbound(candidate).length===0?candidate:null;
}
function id(value:unknown):string|null {
  return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)&&!containsCredential(value)&&inspectOutbound(value).length===0?value:null;
}
interface Entry {value:CodexModelAttribution;generation:number;buffer:CodexModelObservation[];ended:boolean;started:boolean;completed:boolean;}
/** Passive official-protocol collector. No field in CLI 0.162.1 attests the model executing a turn.
 * The caller must discard notifications from obsolete RPC connection generations.
 */
export class CodexModelTracker {
  private entries=new Map<string,Entry>();private activeId:string|null=null;private latestId:string|null=null;
  private generation=0;private connection:CodexModelAttribution|null=null;
  private save:(runId:string,value:CodexModelAttribution)=>void;
  constructor(save:(runId:string,value:CodexModelAttribution)=>void){this.save=save;}
  private current(){return this.activeId?this.entries.get(this.activeId):undefined;}
  private emit(runId:string,entry:Entry){
    try{const result:unknown=this.save(runId,structuredClone(entry.value));void Promise.resolve(result).catch(()=>{entry.value.observationIncomplete=true;});}
    catch{entry.value.observationIncomplete=true;}
  }
  private add(entry:Entry,observation:CodexModelObservation){
    if(entry.value.observations.length>=128){entry.value.observationIncomplete=true;return;}
    entry.value.observations.push(observation);
  }
  connect(method:'thread/start'|'thread/resume',response:unknown,requestedModelId?:string|null,selectedModelId?:string|null):void {
    this.disconnect();
    try{
      const thread=own(response,'thread'),threadId=id(own(thread,'id'));
      if(!threadId)return;
      const serverModelId=model(own(response,'model')),serverProviderId=model(own(response,'modelProvider'));
      this.connection={selectedModelId:model(selectedModelId),requestedModelId:model(requestedModelId),serverModelId,serverProviderId,serverSource:method,
        actualModelId:'unknown',actualModelEvidence:'unavailable',threadId,nativeSessionId:id(own(thread,'sessionId')),turnId:null,status:'starting',
        modelChanged:false,observationIncomplete:!serverModelId||!serverProviderId,resumed:method==='thread/resume',
        observations:[{source:method,semantics:'configuration',modelId:serverModelId,providerId:serverProviderId,turnId:null,observedAt:Date.now()}]};
    }catch{this.connection=null;}
  }
  begin(runId:string,options:{method?:'turn/start'|'review/start';selectedModelId?:string|null;requestedModelId?:string|null}={}):void {
    if(!this.connection||!id(runId)||this.entries.has(runId))return;
    if(this.activeId)this.finish(this.activeId,'lost');
    const value=structuredClone(this.connection);
    if(options.selectedModelId!==undefined)value.selectedModelId=model(options.selectedModelId);
    // A turn request may omit the model, regardless of a previous thread request.
    value.requestedModelId=model(options.requestedModelId);
    const entry:Entry={value,generation:this.generation,buffer:[],ended:false,started:false,completed:false};
    this.entries.set(runId,entry);this.activeId=runId;this.latestId=runId;
    this.add(entry,{source:options.method??'turn/start',semantics:'request',modelId:value.requestedModelId,providerId:null,turnId:null,observedAt:Date.now()});
    this.emit(runId,entry);
  }
  acknowledge(runId:string,response:unknown):void {
    const entry=this.entries.get(runId);if(!entry||entry.generation!==this.generation||!this.connection)return;
    try{
      const turnId=id(own(own(response,'turn'),'id'));
      if(!turnId||(entry.value.turnId&&entry.value.turnId!==turnId)||[...this.entries.values()].some(other=>other!==entry&&other.generation===this.generation&&other.value.turnId===turnId)){
        entry.value.observationIncomplete=true;this.emit(runId,entry);return;
      }
      entry.value.turnId=turnId;
      for(const fact of entry.buffer){if(fact.turnId===turnId)this.apply(entry,fact);else entry.value.observationIncomplete=true;}
      entry.buffer=[];if(!entry.ended)entry.value.status='running';this.emit(runId,entry);
    }catch{entry.value.observationIncomplete=true;this.emit(runId,entry);}
  }
  private apply(entry:Entry,fact:CodexModelObservation){
    if(fact.source==='model/rerouted')entry.value.modelChanged=true;
    if(fact.source==='turn/started')entry.started=true;
    if(fact.source==='turn/completed')entry.completed=true;
    this.add(entry,fact);
  }
  private configuration(source:CodexModelSource,modelId:string|null,providerId:string|null){
    if(!this.connection)return;
    const changed=this.connection.serverModelId!==modelId||this.connection.serverProviderId!==providerId;
    Object.assign(this.connection,{serverModelId:modelId,serverProviderId:providerId,serverSource:source});
    // Keep the next run's connection evidence current without inheriting prior turn events.
    const fact:CodexModelObservation={source,semantics:'configuration',modelId,providerId,turnId:null,observedAt:Date.now()};
    this.connection.observations=[fact];this.connection.observationIncomplete=!modelId||!providerId;
    const entry=this.current();if(!entry||!this.activeId)return;
    Object.assign(entry.value,{serverModelId:modelId,serverProviderId:providerId,serverSource:source});
    entry.value.modelChanged ||= changed;entry.value.observationIncomplete ||= !modelId||!providerId;
    this.add(entry,fact);this.emit(this.activeId,entry);
  }
  threadRead(response:unknown):void {
    try{const thread=own(response,'thread');if(!this.connection||own(thread,'id')!==this.connection.threadId)return;
      // Thread.model is explicitly configured/persisted metadata, not turn execution telemetry.
      this.configuration('thread/read',model(own(thread,'model')),model(own(thread,'modelProvider')));
    }catch{const entry=this.current();if(entry&&this.activeId){entry.value.observationIncomplete=true;this.emit(this.activeId,entry);}}
  }
  event(event:unknown):void {
    if(!this.connection)return;
    try{
      const method=own(event,'method'),params=own(event,'params');if(own(params,'threadId')!==this.connection.threadId)return;
      if(method==='thread/settings/updated'){const settings=own(params,'threadSettings');this.configuration(method,model(own(settings,'model')),model(own(settings,'modelProvider')));return;}
      if(method!=='model/rerouted'&&method!=='turn/started'&&method!=='turn/completed')return;
      const turnId=id(own(params,'turnId')??own(own(params,'turn'),'id'));
      const runId=this.activeId??this.latestId,entry=runId?this.entries.get(runId):undefined;
      if(!entry||!runId||entry.generation!==this.generation)return;
      if(!turnId){entry.value.observationIncomplete=true;this.emit(runId,entry);return;}
      const fact:CodexModelObservation={source:method,semantics:method==='model/rerouted'?'routing':'lifecycle',modelId:method==='model/rerouted'?model(own(params,'toModel')):null,providerId:null,turnId,observedAt:Date.now()};
      if(entry.value.turnId&&entry.value.turnId!==turnId)return;
      if(method==='model/rerouted'&&!fact.modelId)entry.value.observationIncomplete=true;
      if(!entry.value.turnId){if(entry.buffer.length<128)entry.buffer.push(fact);else entry.value.observationIncomplete=true;}
      else if(entry.value.turnId===turnId)this.apply(entry,fact);
      else return; // A foreign turn cannot mutate this run.
      this.emit(runId,entry);
    }catch{const entry=this.current();if(entry&&this.activeId){entry.value.observationIncomplete=true;this.emit(this.activeId,entry);}}
  }
  finish(runId:string,status:Extract<CodexModelStatus,'completed'|'interrupted'|'failed'|'lost'>):void {
    const entry=this.entries.get(runId);if(!entry||entry.ended)return;
    entry.ended=true;entry.value.status=status;
    entry.value.observationIncomplete ||= status!=='completed'||!entry.started||!entry.completed||!entry.value.turnId;
    if(this.activeId===runId)this.activeId=null;this.emit(runId,entry);
  }
  disconnect():void {
    if(this.activeId)this.finish(this.activeId,'lost');
    this.connection=null;this.activeId=null;this.latestId=null;this.generation++;
  }
  snapshot(runId:string):CodexModelAttribution|null {const entry=this.entries.get(runId);return entry?structuredClone(entry.value):null;}
}

/** Catalog entries never participate in run attribution. */
export function decodeCodexModelCatalog(response:unknown):Array<{id:string;model:string}> {
  try{const data=own(response,'data');if(!Array.isArray(data))return [];
    return data.slice(0,512).flatMap(item=>{const modelId=model(own(item,'model')),catalogId=model(own(item,'id'));return modelId&&catalogId?[{id:catalogId,model:modelId}]:[];});
  }catch{return [];}
}
