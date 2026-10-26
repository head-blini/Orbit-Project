import type {AnalyticsKind,AnalyticsRecord,AnalyticsTotals,CheckCounts,ProjectAnalytics} from '../shared/analytics.ts';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {isIP} from 'node:net';

type Row=Record<string,unknown>;
type Overlay=(id:string)=>{execution:string;finishedAt:string|null;durationMs:number|null}|null;
const kinds:AnalyticsKind[]=['coding','model_hub','planning','review','workflow'];
const states=['starting','running','interrupting','completed','passed','failed','interrupted','lost','timed_out','stale'];
const number=(v:unknown):number|null=>typeof v==='bigint'?(v>=0n&&v<=BigInt(Number.MAX_SAFE_INTEGER)?Number(v):null):typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const identifier=(v:unknown):string|null=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v)&&!/:\//.test(v)&&!isIP(v)&&!/^\d+(?:\.\d+){3}:\d+$/.test(v)&&!v.split('/').some(part=>part==='.'||part==='..')&&!containsCredential(v)&&!outboundDenial(v)?v:null;
const id=(v:unknown):string|null=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v)?v:null;
const time=(v:unknown):string|null=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v?v:null;
export const emptyChecks=():CheckCounts=>({total:0,passed:0,failed:0,interrupted:0,timedOut:0,stale:0,running:0,lost:0,notRun:0});
function totals():AnalyticsTotals{return {records:0,completed:0,failed:0,active:0,interrupted:0,lost:0,timedOut:0,stale:0,unknown:0,tokenSubtotal:null,tokenKnownRecords:0,tokenUnknownRecords:0,tokenIncompleteRecords:0,durationSubtotalMs:null,durationKnownRecords:0,durationUnknownRecords:0,workflowRetries:0,checks:emptyChecks()};}
function add(sum:number|null,value:number,priorCount:number){if(priorCount===0)return value;if(sum===null)return null;return Number.isSafeInteger(sum+value)?sum+value:null;}
function accumulate(t:AnalyticsTotals,r:AnalyticsRecord){
  t.records++;
  const state=r.execution==='passed'?'completed':['starting','running','interrupting'].includes(r.execution)?'active':r.execution==='timed_out'?'timedOut':r.execution;
  if(['completed','active','failed','interrupted','lost','timedOut','stale'].includes(state))t[state as 'completed']++;else t.unknown++;
  if(r.tokens.totalTokens!==null){t.tokenSubtotal=add(t.tokenSubtotal,r.tokens.totalTokens,t.tokenKnownRecords);t.tokenKnownRecords++;}else t.tokenUnknownRecords++;
  if(r.tokenStatus==='incomplete')t.tokenIncompleteRecords++;
  if(r.durationMs!==null){t.durationSubtotalMs=add(t.durationSubtotalMs,r.durationMs,t.durationKnownRecords);t.durationKnownRecords++;}else t.durationUnknownRecords++;
  if(r.retrySource==='workflow_lineage'&&r.retryCount===1)t.workflowRetries++;
  for(const key of Object.keys(t.checks) as (keyof CheckCounts)[])t.checks[key]+=r.checks[key];
}
const fields=(alias:string,names:string[])=>names.map(name=>`json_extract(${alias}.body,'$.${name}') AS ${name.replaceAll('.','_')}`).join(',');
const base=['workspaceId','taskId','execution','createdAt','finishedAt','durationMs'];
const metricFields=['modelAtStart','modelProvider','modelChanged','tokenStatus','observedAt','retryNotices','tokens.inputTokens','tokens.outputTokens','tokens.totalTokens'];
const checkCases:Record<Exclude<keyof CheckCounts,'total'>,string>={
  running:"execution='running'",lost:"execution='lost'",passed:"execution='completed' AND verdict='passed'",failed:"execution='completed' AND verdict='failed'",
  interrupted:"execution='completed' AND verdict='interrupted'",timedOut:"execution='completed' AND verdict='timed_out'",stale:"execution='completed' AND verdict='stale'",
  notRun:"execution='completed' AND verdict='not_run'",
};
function codingQuery(){return `WITH owned_checks AS (
  SELECT json_extract(c.body,'$.runId') AS run_id,json_extract(c.body,'$.execution') AS execution,json_extract(c.body,'$.verdict') AS verdict
  FROM verification_checks c JOIN runs r ON r.id=json_extract(c.body,'$.runId')
  JOIN workspaces w ON w.id=json_extract(r.body,'$.workspaceId')
  WHERE json_extract(w.body,'$.projectId')=$project AND json_extract(c.body,'$.projectId')=$project AND json_extract(c.body,'$.workspaceId')=w.id
), checks AS (SELECT run_id,count(*) AS total,${Object.entries(checkCases).map(([key,condition])=>`sum(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS ${key}`).join(',')} FROM owned_checks GROUP BY run_id)
SELECT r.id,${fields('r',['workspaceId','taskId','execution','createdAt'])},${fields('m',['finishedAt','durationMs',...metricFields])},${Object.keys(emptyChecks()).map(key=>`coalesce(c.${key},0) AS check_${key}`).join(',')}
FROM runs r JOIN workspaces w ON w.id=json_extract(r.body,'$.workspaceId') LEFT JOIN run_metrics m ON m.run_id=r.id LEFT JOIN checks c ON c.run_id=r.id
WHERE json_extract(w.body,'$.projectId')=$project`;}
function query(kind:AnalyticsKind){
  if(kind==='coding')return codingQuery();
  const table={model_hub:'model_hub_requests',planning:'planning_suggestions',review:'native_reviews',workflow:'workflow_runs'}[kind];
  let extra='',join='';
  if(kind==='model_hub')extra=','+fields('r',['providerId','model','usage.source','usage.promptTokens','usage.completionTokens','usage.totalTokens']);
  if(kind==='workflow'){
    extra=`,json_extract(r.body,'$.status') AS status,CASE
      WHEN json_extract(r.body,'$.retryOfId') IS NULL AND json_extract(r.body,'$.attempt')=1 THEN 0
      WHEN p.id IS NOT NULL AND p.project_id=r.project_id AND json_extract(p.body,'$.projectId')=r.project_id
        AND json_extract(p.body,'$.attempt')+1=json_extract(r.body,'$.attempt') AND json_extract(r.body,'$.attempt') BETWEEN 2 AND 3
        AND json_extract(p.body,'$.status') IN ('failed','interrupted','timed_out','stale')
        ${['workspaceId','workflowId','versionId','sourceDigest','configDigest'].map(key=>`AND json_extract(p.body,'$.${key}')=json_extract(r.body,'$.${key}')`).join(' ')} THEN 1 ELSE NULL END AS retryCount`;
    join=" LEFT JOIN workflow_runs p ON p.id=json_extract(r.body,'$.retryOfId')";
  }
  const ownership=kind==='model_hub'?'':" AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=json_extract(r.body,'$.workspaceId') AND json_extract(w.body,'$.projectId')=$project)";
  return `SELECT r.id,${fields('r',base)}${extra} FROM ${table} r${join} WHERE r.project_id=$project AND json_extract(r.body,'$.projectId')=$project${ownership}`;
}
function record(kind:AnalyticsKind,row:Row,overlay?:Overlay):AnalyticsRecord {
  const codingLost=kind==='coding'&&row.execution==='lost';
  const changed=number(row.modelChanged)===1,knownCoding=kind==='coding'&&!codingLost&&row.tokenStatus==='observed',knownHub=kind==='model_hub'&&row.usage_source==='provider';
  const tokens=knownCoding?{inputTokens:number(row.tokens_inputTokens),outputTokens:number(row.tokens_outputTokens),totalTokens:number(row.tokens_totalTokens)}:
    knownHub?{inputTokens:number(row.usage_promptTokens),outputTokens:number(row.usage_completionTokens),totalTokens:number(row.usage_totalTokens)}:{inputTokens:null,outputTokens:null,totalTokens:null};
  const observed=Object.values(tokens).some(n=>n!==null),checks=emptyChecks();
  if(kind==='coding')for(const key of Object.keys(checks) as (keyof CheckCounts)[])checks[key]=number(row['check_'+key])??0;
  const override=kind==='planning'?overlay?.(String(row.id)):null,execution=override?.execution??(kind==='workflow'?row.status:row.execution);
  return {id:String(row.id),kind,workspaceId:kind==='model_hub'?null:id(row.workspaceId),taskId:kind==='coding'?id(row.taskId):null,
    providerId:kind==='workflow'?null:kind==='model_hub'?identifier(row.providerId):'codex',model:kind==='coding'?(changed?null:identifier(row.modelAtStart)):kind==='model_hub'?identifier(row.model):null,modelChanged:changed,
    execution:typeof execution==='string'&&states.includes(execution)?execution:'unknown',createdAt:time(row.createdAt)??'',finishedAt:codingLost?null:time(override?override.finishedAt:row.finishedAt),
    durationMs:kind==='workflow'||codingLost?null:number(override?override.durationMs:row.durationMs),tokens,tokenSource:observed?(knownCoding?'codex_observed_delta':'provider'):'unknown',
    tokenStatus:kind==='coding'&&(codingLost||row.tokenStatus==='incomplete')?'incomplete':observed?'observed':'unknown',observedAt:time(knownCoding?row.observedAt:knownHub?row.finishedAt:null),
    retryCount:kind==='workflow'?number(row.retryCount):null,retrySource:kind==='workflow'&&number(row.retryCount)!==null?'workflow_lineage':'unknown',retryNotices:kind==='coding'?number(row.retryNotices):null,checks};
}
type Cursor={projectId:string;createdAt:string;kind:AnalyticsKind;id:string};
function cursorValue(value:string|undefined,projectId:string):Cursor|null {
  if(value===undefined)return null;
  try{
    if(value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw 0;
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!parsed||Object.keys(parsed).sort().join(',')!=='createdAt,id,kind,projectId'||parsed.projectId!==projectId||!id(parsed.id)||!kinds.includes(parsed.kind)||(parsed.createdAt!==''&&!time(parsed.createdAt)))throw 0;
    return parsed;
  }catch{throw new AppError('INVALID_CURSOR',400);}
}
const compare=(a:Pick<AnalyticsRecord,'createdAt'|'kind'|'id'>,b:Pick<AnalyticsRecord,'createdAt'|'kind'|'id'>)=>a.createdAt===b.createdAt?(a.kind===b.kind?(a.id===b.id?0:a.id>b.id?-1:1):a.kind>b.kind?-1:1):a.createdAt>b.createdAt?-1:1;

/** No service view(), provider call or filesystem access. Only allowlisted scalar projections leave SQLite. */
export function projectAnalytics(store:Store,projectId:string,options:{limit?:number;cursor?:string}={},overlay?:Overlay):ProjectAnalytics {
  if(!id(projectId))throw new AppError('INVALID_FIELDS',400);
  if(!store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))throw new AppError('PROJECT_NOT_FOUND',404);
  const limit=options.limit??25;if(!Number.isInteger(limit)||limit<1||limit>50)throw new AppError('INVALID_FIELDS',400);
  const cursor=cursorValue(options.cursor,projectId),all=totals(),groups=new Map<string,ProjectAnalytics['groups'][number]>(),page:AnalyticsRecord[]=[];
  for(const kind of kinds){
    const statement=store.db.prepare(query(kind));statement.setReadBigInts(true);
    for(const row of statement.iterate({$project:projectId})){
      const pending=kind==='coding'?store.runMetricsOverlay(String(row.id)):null;
      if(pending){
        for(const key of ['modelAtStart','modelProvider','modelChanged','tokenStatus','observedAt','retryNotices','finishedAt','durationMs'] as const)row[key]=key==='modelChanged'?Number(pending[key]):pending[key];
        row.tokens_inputTokens=null;row.tokens_outputTokens=null;row.tokens_totalTokens=null;
      }
      const r=record(kind,row,overlay);accumulate(all,r);
      const key=JSON.stringify([kind,r.providerId,r.model]);let group=groups.get(key);
      if(!group){group={kind,providerId:r.providerId,model:r.model,totals:totals()};groups.set(key,group);}accumulate(group.totals,r);
      if(!cursor||compare(r,cursor)>0){page.push(r);page.sort(compare);if(page.length>limit+1)page.pop();}
    }
  }
  const more=page.length>limit;page.length=Math.min(page.length,limit);const last=page.at(-1);
  return {projectId,generatedAt:new Date().toISOString(),source:'local_records',costUsd:null,totals:all,groups:[...groups.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v),records:page,
    nextCursor:more&&last?Buffer.from(JSON.stringify({projectId,createdAt:last.createdAt,kind:last.kind,id:last.id})).toString('base64url'):null};
}
