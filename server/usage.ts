import type {CodexUsage,QuotaBucket,QuotaWindow,SubscriptionUsageObservation,SubscriptionUsageFreshness,SubscriptionProviderStatus,SubscriptionQuotaBucket,SubscriptionQuotaWindow} from '../shared/usage.ts';
import {containsCredential} from './privacy.ts';

/** Unqueried/unavailable metrics are null, never fabricated zeroes or API prices. */
export function unknownUsage():CodexUsage{
  return {status:'unknown',source:'not_queried',checkedAt:null,buckets:null,summary:null,daily:null,billing:'unknown',apiCostUsd:null};
}
type DataRecord=Record<string,PropertyDescriptor>;
function record(value:unknown):DataRecord|null{
  try{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return null;
    return Object.getOwnPropertyDescriptors(value);
  }catch{return null;}
}
function own(data:DataRecord|null,key:string):unknown{
  if(!data||!Object.hasOwn(data,key))return undefined;
  const descriptor=data[key];return 'value' in descriptor?descriptor.value:undefined;
}
const accessor=(data:DataRecord|null,key:string)=>!!data&&Object.hasOwn(data,key)&&!('value' in data[key]);
function array(value:unknown,maximum:number):unknown[]|null{
  try{
    if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
    const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
    if(!Number.isSafeInteger(length)||length<0||length>maximum)return null;
    const result:unknown[]=[];
    for(let index=0;index<length;index++){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor))return null;result.push(descriptor.value);
    }
    return result;
  }catch{return null;}
}
const count=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
function timestamp(value:unknown):string|null{
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))return null;
  try{return new Date(value).toISOString()===value?value:null;}catch{return null;}
}
function reset(value:unknown):string|null{
  const seconds=count(value);if(seconds===null||!Number.isSafeInteger(seconds*1000))return null;
  try{return new Date(seconds*1000).toISOString();}catch{return null;}
}
function safeId(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)&&!containsCredential(value);}
function window(value:unknown):{value:QuotaWindow|null;complete:boolean}{
  if(value===undefined||value===null)return {value:null,complete:true};
  const data=record(value),usedPercent=count(own(data,'usedPercent'));
  if(!data||usedPercent===null)return {value:null,complete:false};
  const windowDurationMins=count(own(data,'windowDurationMins')),resetsAt=reset(own(data,'resetsAt'));
  return {value:{usedPercent,remainingPercent:Math.min(100,Math.max(0,100-usedPercent)),windowDurationMins,resetsAt},complete:windowDurationMins!==null&&resetsAt!==null};
}
function quota(input:unknown):{buckets:QuotaBucket[]|null;complete:boolean}{
  const top=record(input);if(!top)return {buckets:null,complete:false};
  if(accessor(top,'rateLimitsByLimitId'))return {buckets:null,complete:false};
  const multi=own(top,'rateLimitsByLimitId');let entries:{id:string;value:unknown}[];
  if(multi!==undefined&&multi!==null){
    const data=record(multi);if(!data)return {buckets:null,complete:false};
    const keys=Object.keys(data);if(keys.length>32)return {buckets:null,complete:false};
    entries=keys.sort().map(id=>({id,value:own(data,id)}));
  }else{
    // This fixed ID identifies the historical aggregate view; it does not infer
    // any model or quota identity omitted by the server.
    const value=own(top,'rateLimits'),data=record(value),limitId=own(data,'limitId');
    if(accessor(data,'limitId'))return {buckets:null,complete:false};
    entries=[{id:limitId===undefined||limitId===null?'legacy':limitId as string,value}];
  }
  const buckets:QuotaBucket[]=[];let complete=entries.length>0;
  for(const entry of entries){
    const data=record(entry.value),limitId=own(data,'limitId');
    if(!safeId(entry.id)||!data||accessor(data,'limitId')||(limitId!==undefined&&limitId!==null&&limitId!==entry.id)){complete=false;continue;}
    const primary=window(own(data,'primary')),secondary=window(own(data,'secondary'));
    if(!primary.value&&!secondary.value){complete=false;continue;}
    buckets.push({id:entry.id,primary:primary.value,secondary:secondary.value});complete=complete&&primary.complete&&secondary.complete&&!accessor(data,'primary')&&!accessor(data,'secondary');
  }
  return {buckets:buckets.length?buckets:entries.length===0?[]:null,complete};
}
const summaryKeys=['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'] as const;
function activity(input:unknown):{summary:CodexUsage['summary'];daily:CodexUsage['daily'];complete:boolean}{
  const top=record(input),data=record(own(top,'summary'));
  const values=Object.fromEntries(summaryKeys.map(key=>[key,count(own(data,key))])) as NonNullable<CodexUsage['summary']>;
  const summary=summaryKeys.some(key=>values[key]!==null)?values:null;
  let complete=summaryKeys.every(key=>values[key]!==null);
  const rows=array(own(top,'dailyUsageBuckets'),366);
  if(rows===null)return {summary,daily:null,complete:false};
  const daily:NonNullable<CodexUsage['daily']>=[],seen=new Set<string>();
  for(const input of rows){
    const row=record(input),date=own(row,'startDate');
    if(typeof date!=='string'||!/^\d{4}-\d\d-\d\d$/.test(date)||timestamp(date+'T00:00:00.000Z')===null){complete=false;continue;}
    if(seen.has(date))return {summary,daily:null,complete:false};seen.add(date);
    const tokens=count(own(row,'tokens'));if(tokens===null)complete=false;
    daily.push({date,tokens});
  }
  daily.sort((a,b)=>a.date.localeCompare(b.date));
  return {summary,daily:daily.length||rows.length===0?daily:null,complete};
}

/** Parse allowlisted schema fields only. The publishing caller must already have
 * verified a ready ChatGPT session; this parser never establishes authentication.
 * The subscription label describes that caller context, not API cost or quota access.
 */
export function parseCodexUsage(rateLimits:unknown,usage:unknown,checkedAt:string):CodexUsage{
  const result:CodexUsage={...unknownUsage(),source:'codex_app_server',checkedAt:timestamp(checkedAt)};
  if(result.checkedAt===null)return result;
  const quotas=quota(rateLimits),tokens=activity(usage);
  result.buckets=quotas.buckets;result.summary=tokens.summary;result.daily=tokens.daily;
  const known=!!quotas.buckets?.length||tokens.summary!==null||tokens.daily!==null;
  result.status=known?quotas.complete&&tokens.complete?'available':'partial':'unknown';
  result.billing=known?'chatgpt_subscription':'unknown';
  return result;
}

/** Read-only account activity. No reset/consume/email, auth refresh or thread call.
 * Even synchronous request errors cannot suppress the independent second read.
 */
export async function collectCodexUsage(request:(method:string,params:unknown)=>Promise<unknown>):Promise<CodexUsage>{
  const [rateLimits,usage]=await Promise.allSettled([
    Promise.resolve().then(()=>request('account/rateLimits/read',{excludeResetCreditDetails:true})),
    Promise.resolve().then(()=>request('account/usage/read',{})),
  ]);
  return parseCodexUsage(rateLimits.status==='fulfilled'?rateLimits.value:undefined,usage.status==='fulfilled'?usage.value:undefined,new Date().toISOString());
}

/** Trusted local context, never raw provider metadata. References must be opaque,
 * sanitized IDs. Account/pool evidence is established by the publishing caller. */
export interface SubscriptionUsageContext {
  providerId:string;runtimeId:string;connectionRef:string;
  accountRef?:string|null;identityStatus?:'observed'|'unknown';
  evidence:SubscriptionUsageObservation['source']['evidence'];evidenceRefs?:string[];
  observedAt:string|null;lastAttemptAt:string|null;now:string;connected:boolean;
  pool?:{poolRef:string|null;sharing:SubscriptionUsageObservation['sharing'];evidenceRefs:string[]};
}

/** Orbit display policy, not a provider guarantee. On restart the caller passes
 * connected=false until a new observation is bound to the current connection.
 * Missing reset is permitted; malformed timestamps and future observations are not. */
export function subscriptionUsageFreshness(observedAt:string|null,now:string,resetsAt:string|null,connected:boolean):SubscriptionUsageFreshness {
  const observed=timestamp(observedAt),current=timestamp(now);
  if(!observed||!current||Date.parse(observed)>Date.parse(current))return 'unknown';
  if(!connected)return 'stale';
  if(resetsAt!==null&&timestamp(resetsAt)===null)return 'unknown';
  return Date.parse(current)-Date.parse(observed)>=60_000||resetsAt!==null&&Date.parse(resetsAt)<=Date.parse(current)?'stale':'fresh';
}
function providerStatus(value:unknown):SubscriptionProviderStatus {
  return value==='allowed'||value==='allowed_warning'||value==='rejected'?value:'unknown';
}
function subscriptionObservation(context:SubscriptionUsageContext,interfaceId:string,observedAt:string|null,buckets:SubscriptionQuotaBucket[]|null,status:SubscriptionProviderStatus,complete:boolean):SubscriptionUsageObservation {
  const windows=buckets?.flatMap(bucket=>[bucket.primary,bucket.secondary].filter((w):w is SubscriptionQuotaWindow=>w!==null))??[];
  const known=status!=='unknown'||windows.some(w=>w.remainingPercent!==null||w.providerStatus!=='unknown');
  const accountRef=context.identityStatus==='observed'&&context.accountRef?context.accountRef:null;
  const pool=context.pool,hasPool=!!pool?.poolRef&&pool.sharing!=='unknown'&&pool.evidenceRefs.length>0;
  const reasons:SubscriptionUsageObservation['unknownReasons']=[];
  if(!windows.some(w=>w.remainingPercent!==null))reasons.push('QUOTA_UNAVAILABLE');
  if(!complete&&windows.length)reasons.push('WINDOW_INCOMPLETE');
  if(status==='unknown')reasons.push('PROVIDER_STATUS_UNKNOWN');
  if(!accountRef)reasons.push('IDENTITY_UNKNOWN');
  if(!hasPool)reasons.push('POOL_UNKNOWN');
  if(context.evidence==='unknown')reasons.push('EVIDENCE_UNKNOWN');
  const observed=timestamp(observedAt);
  if(!observed)reasons.push('OBSERVED_AT_INVALID');
  const resets=windows.map(w=>w.resetsAt).filter((value):value is string=>value!==null).sort();
  return {
    providerId:context.providerId,runtimeId:context.runtimeId,connectionRef:context.connectionRef,
    accountRef,identityStatus:accountRef?'observed':'unknown',
    source:{interfaceId,evidence:context.evidence,evidenceRefs:[...context.evidenceRefs??[]]},
    observedAt:observed,providerObservedAt:null,lastAttemptAt:timestamp(context.lastAttemptAt),
    dataStatus:known?complete&&observed?'available':'partial':'unknown',
    freshness:subscriptionUsageFreshness(observed,context.now,resets[0]??null,context.connected),
    providerStatus:status,unknownReasons:reasons,buckets,
    poolRef:hasPool?pool!.poolRef:null,sharing:hasPool?pool!.sharing:'unknown',poolEvidenceRefs:hasPool?[...pool!.evidenceRefs]:[],
  };
}

/** Consumes the existing parser result. Activity alone is never quota evidence.
 * Its partial flag is retained because the parser may have discarded bad buckets. */
export function normalizeCodexSubscriptionUsage(usage:CodexUsage,context:SubscriptionUsageContext):SubscriptionUsageObservation {
  const convert=(value:QuotaWindow|null):SubscriptionQuotaWindow|null=>value?{
    usedPercent:value.usedPercent,remainingPercent:value.remainingPercent,
    windowDurationMins:value.windowDurationMins,resetsAt:timestamp(value.resetsAt),remainingSource:'computed',providerStatus:'unknown',
  }:null;
  const buckets=usage.buckets?.length?usage.buckets.map(bucket=>({id:bucket.id,primary:convert(bucket.primary),secondary:convert(bucket.secondary)})):null;
  return subscriptionObservation(context,'codex-app-server.account/rateLimits/read',buckets?usage.checkedAt:null,buckets,'unknown',usage.status==='available'&&buckets!==null);
}

/** Consumes the sanitized rate_limit_info projection ({status, windows}) emitted
 * by parseClaudeLine. Each named window remains separate; no percentage totals. */
export function normalizeClaudeSubscriptionUsage(input:unknown,context:SubscriptionUsageContext):SubscriptionUsageObservation {
  const data=record(input),status=providerStatus(own(data,'status')),rows=array(own(data,'windows'),32);
  const buckets:SubscriptionQuotaBucket[]=[],seen=new Set<string>();let complete=!!rows?.length;
  for(const row of rows??[]){
    const item=record(row),id=own(item,'id');
    if(!safeId(id)||seen.has(id)){complete=false;continue;}seen.add(id);
    const raw=own(item,'utilization'),utilization=typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&raw<=1?raw:null;
    const resetsAt=timestamp(own(item,'resetsAt')),windowStatus=providerStatus(own(item,'status'));
    if(utilization===null||resetsAt===null||windowStatus==='unknown')complete=false;
    buckets.push({id,primary:{usedPercent:utilization===null?null:utilization*100,
      remainingPercent:utilization===null?null:(1-utilization)*100,remainingSource:utilization===null?'unknown':'computed',
      windowDurationMins:null,resetsAt,providerStatus:windowStatus},secondary:null});
  }
  return subscriptionObservation(context,'claude-code.stream-json.rate_limit_event.rate_limit_info',
    data?context.observedAt:null,buckets.length?buckets:null,status,complete);
}
