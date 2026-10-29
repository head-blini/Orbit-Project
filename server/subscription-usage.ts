import type {SubscriptionUsageObservation,SubscriptionQuotaWindow} from '../shared/usage.ts';
import type {Store} from './store.ts';
import {containsCredential} from './privacy.ts';
import {subscriptionUsageFreshness,normalizeCodexSubscriptionUsage,unknownUsage} from './usage.ts';

const kind='subscription.usage';
const id=(value:unknown):string|null=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)&&!containsCredential(value)?value:null;
function time(value:unknown):string|null {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))return null;
  try{return new Date(value).toISOString()===value?value:null;}catch{return null;}
}
const status=(value:unknown)=>value==='allowed'||value==='allowed_warning'||value==='rejected'?value:'unknown';
const refs=(values:unknown)=>Array.isArray(values)?values.slice(0,32).map(id).filter((v):v is string=>v!==null):[];
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function window(value:SubscriptionQuotaWindow|null):SubscriptionQuotaWindow|null {
  if(!value)return null;
  const used=number(value.usedPercent),remaining=number(value.remainingPercent);
  return {usedPercent:used,remainingPercent:remaining!==null&&remaining<=100?remaining:null,
    windowDurationMins:number(value.windowDurationMins),resetsAt:time(value.resetsAt),
    remainingSource:remaining!==null&&remaining<=100&&value.remainingSource==='computed'?'computed':'unknown',providerStatus:status(value.providerStatus)};
}
/** Re-project even normalized input: no extra provider fields enter the event log. */
function sanitize(value:SubscriptionUsageObservation):SubscriptionUsageObservation {
  const providerId=id(value.providerId),runtimeId=id(value.runtimeId),connectionRef=id(value.connectionRef),interfaceId=['codex-app-server.account/rateLimits/read','claude-code.stream-json.rate_limit_event.rate_limit_info'].includes(value.source.interfaceId)?value.source.interfaceId:null;
  if(!providerId||!runtimeId||!connectionRef||!interfaceId)throw new Error('INVALID_SUBSCRIPTION_OBSERVATION');
  const accountRef=value.identityStatus==='observed'?id(value.accountRef):null;
  const poolEvidenceRefs=refs(value.poolEvidenceRefs),poolRef=poolEvidenceRefs.length?id(value.poolRef):null;
  const reasons:SubscriptionUsageObservation['unknownReasons']=['QUOTA_UNAVAILABLE','WINDOW_INCOMPLETE','PROVIDER_STATUS_UNKNOWN','IDENTITY_UNKNOWN','POOL_UNKNOWN','EVIDENCE_UNKNOWN','OBSERVED_AT_INVALID'];
  return {providerId,runtimeId,connectionRef,accountRef,identityStatus:accountRef?'observed':'unknown',
    source:{interfaceId,evidence:value.source.evidence==='native'||value.source.evidence==='mock'?value.source.evidence:'unknown',evidenceRefs:refs(value.source.evidenceRefs)},
    observedAt:time(value.observedAt),providerObservedAt:null,lastAttemptAt:time(value.lastAttemptAt),
    dataStatus:value.dataStatus==='available'||value.dataStatus==='partial'?value.dataStatus:'unknown',freshness:'unknown',providerStatus:status(value.providerStatus),
    unknownReasons:reasons.filter(reason=>value.unknownReasons.includes(reason)||reason==='IDENTITY_UNKNOWN'&&!accountRef||reason==='POOL_UNKNOWN'&&!poolRef),
    buckets:value.buckets?.slice(0,128).filter(bucket=>id(bucket.id)!==null).map(bucket=>({id:bucket.id,primary:window(bucket.primary),secondary:window(bucket.secondary)}))??null,
    poolRef,sharing:poolRef&&(value.sharing==='shared'||value.sharing==='not_shared')?value.sharing:'unknown',poolEvidenceRefs:poolRef?poolEvidenceRefs:[]};
}
export interface SubscriptionUsageEntry {observation:SubscriptionUsageObservation;connected:boolean}

/** Connection references are local incarnations, never account aliases. Replay never reconnects them. */
export class SubscriptionUsageStore {
  private store:Store;
  private latest=new Map<string,SubscriptionUsageEntry>();
  constructor(store:Store){
    this.store=store;
    let seq=0;
    for(;;){
      const events=store.eventsAfter(seq,1000);if(!events.length)break;
      for(const event of events){
        seq=event.seq;if(event.kind!==kind||event.data.version!==1)continue;
        try{const observation=sanitize(event.data.observation as SubscriptionUsageObservation);
          this.latest.set(this.key(observation.runtimeId,observation.connectionRef),{observation,connected:false});
        }catch{/* Ignore malformed envelopes; never recover raw provider events. */}
      }
    }
  }
  private key(runtimeId:string,connectionRef:string){return JSON.stringify([runtimeId,connectionRef]);}
  record(value:SubscriptionUsageObservation):void {
    const observation=sanitize(value);
    this.store.append(kind,null,{version:1,observation});
    this.latest.set(this.key(observation.runtimeId,observation.connectionRef),{observation,connected:true});
  }
  attempt(runtimeId:string,connectionRef:string,at:string):void {
    const entry=this.latest.get(this.key(runtimeId,connectionRef)),lastAttemptAt=time(at);
    if(!lastAttemptAt)return;
    if(!entry){this.record(normalizeCodexSubscriptionUsage(unknownUsage(),{providerId:runtimeId,runtimeId,connectionRef,evidence:'unknown',observedAt:null,lastAttemptAt,now:at,connected:true}));return;}
    const observation={...entry.observation,lastAttemptAt};
    this.store.append(kind,null,{version:1,observation});
    this.latest.set(this.key(runtimeId,connectionRef),{...entry,observation});
  }
  disconnect(runtimeId:string,connectionRef?:string):void {for(const entry of this.latest.values())if(entry.observation.runtimeId===runtimeId&&(connectionRef===undefined||entry.observation.connectionRef===connectionRef))entry.connected=false;}
  snapshot(now=new Date().toISOString()):SubscriptionUsageEntry[]{
    return [...this.latest.values()].map(entry=>{
      const observation=structuredClone(entry.observation);
      const resets=observation.buckets?.flatMap(bucket=>[bucket.primary?.resetsAt,bucket.secondary?.resetsAt]).filter((at):at is string=>!!at)??[];
      observation.freshness=subscriptionUsageFreshness(observation.observedAt,now,null,entry.connected);
      if(observation.freshness==='fresh'&&resets.some(at=>Date.parse(at)<=Date.parse(now)))observation.freshness='stale';
      return {observation,connected:entry.connected};
    });
  }
}
