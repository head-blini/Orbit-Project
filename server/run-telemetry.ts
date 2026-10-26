import type {RunMetrics,TokenCounters,TokenIssue} from '../shared/analytics.ts';
import {isIP} from 'node:net';
import {containsCredential} from './privacy.ts';
import {inspectOutbound} from './guardrails/outbound.ts';

const keys=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'] as const;
function own(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor&&!('value' in descriptor))throw new Error('INVALID_TELEMETRY');
  return descriptor?.value;
}
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)&&!containsCredential(value);
function model(value:unknown):string|null {
  return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&!isIP(value)&&!containsCredential(value)&&inspectOutbound(value).length===0?value:null;
}
function counters(value:unknown):TokenCounters|null {
  const result={} as TokenCounters;
  for(const key of keys){const field=own(value,key),number=key==='cacheWriteInputTokens'&&field===undefined?0:field;if(!integer(number))return null;result[key]=number;}
  if(!Number.isSafeInteger(result.inputTokens+result.outputTokens)||result.inputTokens+result.outputTokens!==result.totalTokens
    ||result.cachedInputTokens>result.inputTokens||result.cacheWriteInputTokens>result.inputTokens||result.reasoningOutputTokens>result.outputTokens)return null;
  return result;
}
const equal=(a:TokenCounters,b:TokenCounters)=>keys.every(key=>a[key]===b[key]);
const atLeast=(a:TokenCounters,b:TokenCounters)=>keys.every(key=>a[key]>=b[key]);
type Fact={turnId:string;kind:'usage';total:TokenCounters}|{turnId:string;kind:'retry'}|{turnId:string;kind:'notice'}|{turnId:string;kind:'reroute';toModel:string|null}|{turnId:string;kind:'invalid'};
interface Entry {
  metrics:RunMetrics;began:number;order:number;baseline:TokenCounters|null;baselineOwner:string|null;
  last:TokenCounters|null;invalid:boolean;ended:boolean;buffer:Fact[];
}

/** Passive, best-effort telemetry only. The caller filters RPC connection generations.
 * No protocol event proves a final billed total. Even valid deltas are observations.
 */
export class RunTelemetry {
  private save:(metrics:RunMetrics)=>void;
  private threadId:string|null=null;private currentModel:string|null=null;private provider:string|null=null;
  private entries=new Map<string,Entry>();private activeId:string|null=null;private latestId:string|null=null;private order=0;
  private baseline:TokenCounters|null=null;private baselineOwner:string|null=null;
  constructor(save:(metrics:RunMetrics)=>void){this.save=save;}
  private emit(entry:Entry){
    // A failed analytics write must never change execution control flow. Detach
    // the callback value so observers cannot mutate future accounting snapshots.
    try{const value:unknown=this.save(structuredClone(entry.metrics));void Promise.resolve(value).catch(()=>{});}catch{/* Best effort only. */}
  }
  private clearBaseline(){this.baseline=null;this.baselineOwner=null;}
  private invalidate(entry:Entry,issue:TokenIssue){
    const changed=!entry.invalid||entry.metrics.tokenIssue!==issue||entry.metrics.tokens!==null;
    entry.invalid=true;entry.last=null;entry.metrics.tokens=null;entry.metrics.tokenStatus='incomplete';
    // Preserve the first reason, except that a lost connection is definitive.
    if(changed&&(!entry.metrics.tokenIssue||!['BUFFER_LIMIT','CONNECTION_LOST','INVALID_OBSERVATION','DISCONTINUITY'].includes(entry.metrics.tokenIssue)||issue==='CONNECTION_LOST'))entry.metrics.tokenIssue=issue;
    this.clearBaseline();if(changed)this.emit(entry);
  }
  private active(){return this.activeId?this.entries.get(this.activeId):undefined;}
  private invalidateSuccessors(entry:Entry){
    if(!entry.ended)return;
    for(const other of this.entries.values())if(other!==entry&&(other.baselineOwner===entry.metrics.runId||this.activeId===other.metrics.runId))this.invalidate(other,'DISCONTINUITY');
    this.clearBaseline();
  }
  connect(threadId:string,initialModel:unknown,provider:unknown){
    this.disconnect();
    if(!id(threadId))return;
    this.threadId=threadId;this.currentModel=model(initialModel);this.provider=model(provider);
  }
  begin(runId:string){
    if(!this.threadId||!id(runId)||this.entries.has(runId))return;
    const active=this.active();if(active){this.invalidate(active,'DISCONTINUITY');return;}
    const entry:Entry={metrics:{runId,threadId:this.threadId,turnId:null,modelAtStart:this.currentModel,modelProvider:this.provider,modelChanged:false,
      tokens:null,tokenStatus:'unknown',tokenIssue:this.baseline?'NO_OBSERVATION':'NO_BASELINE',observedAt:null,finishedAt:null,durationMs:null,retryNotices:0},
      began:performance.now(),order:++this.order,baseline:this.baseline?{...this.baseline}:null,baselineOwner:this.baselineOwner,last:null,invalid:false,ended:false,buffer:[]};
    this.entries.set(runId,entry);this.activeId=runId;this.latestId=runId;this.emit(entry);
  }
  acknowledge(runId:string,turnId:string){
    const entry=this.entries.get(runId);if(!entry||entry.metrics.threadId!==this.threadId)return;
    if(!id(turnId)){this.invalidate(entry,'INVALID_OBSERVATION');return;}
    if(entry.metrics.turnId){if(entry.metrics.turnId!==turnId)this.invalidate(entry,'DISCONTINUITY');return;}
    if([...this.entries.values()].some(other=>other!==entry&&other.metrics.turnId===turnId)){this.invalidate(entry,'DISCONTINUITY');return;}
    entry.metrics.turnId=turnId;this.emit(entry);const pending=entry.buffer;entry.buffer=[];
    for(const fact of pending){if(fact.turnId!==turnId)this.invalidate(entry,'DISCONTINUITY');else this.apply(entry,fact);}
  }
  event(event:unknown){
    if(!this.threadId)return;
    try{
      const method=own(event,'method');
      if(typeof method!=='string'||method.length>128)return;
      const params=own(event,'params');if(own(params,'threadId')!==this.threadId)return;
      if(method==='thread/settings/updated'){
        const settings=own(params,'threadSettings'),nextModel=model(own(settings,'model')),nextProvider=model(own(settings,'modelProvider'));
        if(nextModel===this.currentModel&&nextProvider===this.provider)return;
        this.currentModel=nextModel;this.provider=nextProvider;this.clearBaseline();const active=this.active();
        if(active){active.metrics.modelChanged=true;this.invalidate(active,'DISCONTINUITY');}return;
      }
      const turnId=own(params,'turnId')??own(own(params,'turn'),'id');
      if(!id(turnId)){
        if(['thread/tokenUsage/updated','model/rerouted','error'].includes(method)){const active=this.active();this.clearBaseline();if(active)this.invalidate(active,'INVALID_OBSERVATION');}
        return;
      }
      let fact:Fact;
      if(method==='thread/tokenUsage/updated'){
        try{
          const usage=own(params,'tokenUsage'),total=counters(own(usage,'total')),last=counters(own(usage,'last')),window=own(usage,'modelContextWindow');
          fact=total&&last&&atLeast(total,last)&&(window===undefined||window===null||integer(window))?{turnId,kind:'usage',total}:{turnId,kind:'invalid'};
        }catch{fact={turnId,kind:'invalid'};}
      }else if(method==='model/rerouted')fact={turnId,kind:'reroute',toModel:model(own(params,'toModel'))};
      else if(method==='error'&&own(params,'willRetry')===true)fact={turnId,kind:'retry'};
      else fact={turnId,kind:'notice'};
      const owner=[...this.entries.values()].find(entry=>entry.metrics.turnId===turnId);
      if(owner){this.apply(owner,fact);return;}
      const active=this.active();
      const waiting=active??(this.latestId?this.entries.get(this.latestId):undefined);
      if(waiting&&!waiting.metrics.turnId){
        if(waiting.buffer.length>=128){waiting.buffer=[];this.invalidate(waiting,'BUFFER_LIMIT');return;}
        if(waiting.metrics.tokenIssue!=='BUFFER_LIMIT')waiting.buffer.push(fact);return;
      }
      this.clearBaseline();if(active)this.invalidate(active,'DISCONTINUITY');
    }catch{const active=this.active();this.clearBaseline();if(active)this.invalidate(active,'INVALID_OBSERVATION');}
  }
  private apply(entry:Entry,fact:Fact){
    if(fact.kind==='notice')return;
    if(fact.kind==='invalid'){this.invalidateSuccessors(entry);this.invalidate(entry,'INVALID_OBSERVATION');return;}
    if(fact.kind==='retry'){
      if(entry.ended)return;
      const count=entry.metrics.retryNotices;entry.metrics.retryNotices=count!==null&&count<Number.MAX_SAFE_INTEGER?count+1:null;this.emit(entry);return;
    }
    if(fact.kind==='reroute'){
      this.invalidateSuccessors(entry);
      entry.metrics.modelChanged=true;this.invalidate(entry,'DISCONTINUITY');
      if(this.activeId===entry.metrics.runId)this.currentModel=fact.toModel;
      const active=this.active();if(active&&active!==entry)this.invalidate(active,'DISCONTINUITY');return;
    }
    if(entry.last&&equal(entry.last,fact.total))return;
    // A changed predecessor snapshot means a successor's frozen baseline may
    // have missed usage. Never transfer that late increase to the active run.
    this.invalidateSuccessors(entry);
    if(entry.last&&!atLeast(fact.total,entry.last)||entry.baseline&&!atLeast(fact.total,entry.baseline)){this.invalidate(entry,'DISCONTINUITY');return;}
    entry.last={...fact.total};entry.metrics.observedAt=new Date().toISOString();
    if(!entry.invalid){
      if(entry.baseline){
        const delta=counters(Object.fromEntries(keys.map(key=>[key,fact.total[key]-entry.baseline![key]])));
        if(!delta){this.invalidate(entry,'DISCONTINUITY');return;}
        entry.metrics.tokens=delta;entry.metrics.tokenStatus='observed';entry.metrics.tokenIssue=null;
      }else{entry.metrics.tokens=null;entry.metrics.tokenStatus='unknown';entry.metrics.tokenIssue='NO_BASELINE';}
    }
    if(entry.ended&&!this.activeId&&this.latestId===entry.metrics.runId&&!entry.invalid){this.baseline={...fact.total};this.baselineOwner=entry.metrics.runId;}
    this.emit(entry);
  }
  finish(runId:string,lost=false){
    const entry=this.entries.get(runId);if(!entry)return;
    if(entry.ended){
      if(lost){
        if(entry.metrics.tokenIssue==='CONNECTION_LOST'&&entry.metrics.finishedAt===null&&entry.metrics.durationMs===null)return;
        entry.metrics.finishedAt=null;entry.metrics.durationMs=null;this.invalidateSuccessors(entry);this.invalidate(entry,'CONNECTION_LOST');this.emit(entry);
      }
      return;
    }
    entry.ended=true;if(!entry.metrics.turnId)entry.metrics.retryNotices=null;
    entry.metrics.finishedAt=new Date().toISOString();entry.metrics.durationMs=lost?null:Math.max(0,Math.round(performance.now()-entry.began));
    if(this.activeId===runId)this.activeId=null;
    if(lost)this.invalidate(entry,'CONNECTION_LOST');
    else if(!entry.invalid&&!entry.last){entry.metrics.tokenStatus='unknown';entry.metrics.tokenIssue='NO_OBSERVATION';}
    if(this.latestId===runId){
      if(!entry.invalid&&entry.last){this.baseline={...entry.last};this.baselineOwner=runId;}else this.clearBaseline();
    }
    this.emit(entry);
    const ended=[...this.entries.values()].filter(value=>value.ended).sort((a,b)=>a.order-b.order);
    for(const old of ended.slice(0,Math.max(0,ended.length-128)))this.entries.delete(old.metrics.runId);
  }
  disconnect(){
    if(this.activeId)this.finish(this.activeId,true);
    this.entries.clear();this.activeId=null;this.latestId=null;this.threadId=null;this.currentModel=null;this.provider=null;this.clearBaseline();
  }
}
