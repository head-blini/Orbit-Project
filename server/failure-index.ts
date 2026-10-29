import type {Store} from './store.ts';
import {containsCredential} from './privacy.ts';
import {familyId} from './failure-fingerprint.ts';
import {classify,groupFamilies,normalizeCode,ruleHypotheses,
  type FailureFamily,type FailureObservation,type FailureRecord,type FailureSource,type Hypothesis} from '../shared/failure-intelligence.ts';

/** FE-2 read model. SELECT only: no execution, retry, event append, migration or table creation.
 * Each query projects named JSON fields with json_extract so prompt/response/output/evidence/review
 * bodies and paths never enter JS memory. Codex run events embed the full Run; only $.reason is read. */
type Row=Record<string,unknown>;
type Evidence=FailureRecord['evidenceSource'];
export interface IndexedFailureFamily extends FailureFamily {familyId:string}

// Opaque identifiers/digests only: no slash (paths), whitespace, or credential-shaped values.
const token=(v:unknown):string|null=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)&&!containsCredential(v)?v:null;
const time=(v:unknown):string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:'';
const evidence=(v:unknown,fallback:Evidence='unknown'):Evidence=>v==='native'||v==='mock'||v==='local'||v==='unknown'?v:fallback;
const opt=<K extends string>(key:K,v:unknown):Partial<Record<K,string>>=>{const t=token(v);return t?{[key]:t} as Record<K,string>:{};};

const sql:Record<FailureSource,{tables:string[];query:string}>={
  run:{tables:['events','runs'],query:`SELECT e.seq AS record_id,e.at AS at,r.id AS run_id,r.request_id AS request_id,
      json_extract(e.data,'$.reason') AS code,
      COALESCE(json_extract(r.body,'$.projectId'),(SELECT json_extract(w.body,'$.projectId') FROM workspaces w WHERE w.id=json_extract(r.body,'$.workspaceId'))) AS project_id,
      json_extract(r.body,'$.taskId') AS task_id,COALESCE(json_extract(r.body,'$.runtime'),'codex') AS runtime,
      json_extract(r.body,'$.planningContentHash') AS binding,
      (SELECT json_extract(o.data,'$.source') FROM events o WHERE o.run_id=r.id AND o.kind='run.runtime_source' ORDER BY o.seq DESC LIMIT 1) AS origin,
      (SELECT json_extract(o.data,'$.interface') FROM events o WHERE o.run_id=r.id AND o.kind='run.runtime_source' ORDER BY o.seq DESC LIMIT 1) AS iface,
      (SELECT json_extract(o.data,'$.source') FROM events o WHERE o.run_id=r.id AND o.kind='run.runtime_outcome' ORDER BY o.seq DESC LIMIT 1) AS outcome
    FROM events e JOIN runs r ON r.id=e.run_id WHERE e.kind IN ('run.failed','run.lost') ORDER BY e.seq`},
  check:{tables:['verification_checks'],query:`SELECT id AS record_id,json_extract(body,'$.projectId') AS project_id,json_extract(body,'$.taskId') AS task_id,
      json_extract(body,'$.runId') AS run_id,json_extract(body,'$.requestId') AS request_id,json_extract(body,'$.commandId') AS gate,
      json_extract(body,'$.execution') AS execution,json_extract(body,'$.verdict') AS verdict,
      json_extract(body,'$.evidenceSource') AS evidence,COALESCE(json_extract(body,'$.completedAt'),json_extract(body,'$.createdAt')) AS at,
      json_extract(body,'$.planningContentHash') AS binding
    FROM verification_checks WHERE json_extract(body,'$.execution')='lost'
      OR (json_extract(body,'$.execution')='completed' AND json_extract(body,'$.verdict') IN ('failed','interrupted','timed_out','stale')) ORDER BY rowid`},
  quality:{tables:['quality_loops','runs'],query:`SELECT q.id AS record_id,q.project_id AS project_id,json_extract(q.body,'$.taskId') AS task_id,json_extract(q.body,'$.sourceRunId') AS run_id,
      r.request_id AS request_id,COALESCE(json_extract(r.body,'$.runtime'),CASE WHEN r.id IS NULL THEN NULL ELSE 'codex' END) AS runtime,
      json_extract(q.body,'$.result.issue') AS code,json_extract(q.body,'$.producer.evidenceSource') AS evidence,json_extract(q.body,'$.updatedAt') AS at,
      json_extract(q.body,'$.version.contentHash') AS binding
    FROM quality_loops q LEFT JOIN runs r ON r.id=json_extract(q.body,'$.sourceRunId')
    WHERE json_extract(q.body,'$.result.status') IN ('blocked','failed','limit_reached') ORDER BY q.rowid`},
  integration:{tables:['integration_queue','worker_reservations'],query:`SELECT q.id AS record_id,json_extract(q.body,'$.projectId') AS project_id,
      json_extract(q.body,'$.reason') AS code,json_extract(q.body,'$.approvedBaseline') AS binding,
      json_extract(w.body,'$.attempt.taskId') AS task_id,json_extract(w.body,'$.attempt.runtimeId') AS runtime,json_extract(w.body,'$.updatedAt') AS at
    FROM integration_queue q LEFT JOIN worker_reservations w ON w.id=json_extract(q.body,'$.fence.reservationId')
    WHERE json_extract(q.body,'$.status') IN ('refused','blocked') ORDER BY q.rowid`},
  worker:{tables:['worker_reservations'],query:`SELECT id AS record_id,json_extract(body,'$.batch.projectId') AS project_id,
      json_extract(body,'$.attempt.taskId') AS task_id,json_extract(body,'$.attempt.runtimeId') AS runtime,
      json_extract(body,'$.updatedAt') AS at,json_extract(body,'$.batch.planningHash') AS binding,'LOST_UNKNOWN' AS code
    FROM worker_reservations WHERE json_extract(body,'$.state')='lost_unknown' ORDER BY rowid`},
  capability:{tables:['capability_executions'],query:`SELECT id AS record_id,project_id,json_extract(body,'$.taskId') AS task_id,json_extract(body,'$.runId') AS run_id,
      json_extract(body,'$.dispatchRequestId') AS request_id,json_extract(body,'$.qualityLoopId') AS loop_id,json_extract(body,'$.runtimeId') AS runtime,
      json_extract(body,'$.issue') AS code,json_extract(body,'$.providerEvidence.source') AS evidence,json_extract(body,'$.updatedAt') AS at,
      json_extract(body,'$.baseline.planningContentHash') AS binding
    FROM capability_executions WHERE json_extract(body,'$.issue') IS NOT NULL ORDER BY rowid`},
};
const refusalSql=`SELECT f.reservation_id AS record_id,f.project_id AS project_id,f.reason AS code,
    json_extract(w.body,'$.attempt.taskId') AS task_id,json_extract(w.body,'$.attempt.runtimeId') AS runtime,
    json_extract(w.body,'$.updatedAt') AS at,json_extract(w.body,'$.batch.planningHash') AS binding
  FROM worker_integration_refusals f LEFT JOIN worker_reservations w ON w.id=f.reservation_id ORDER BY f.rowid`;

export class FailureIndex {
  private store:Store;
  constructor(store:Store){this.store=store;}
  private has(table:string){return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
  private rows(tables:string[],query:string):Row[]{return tables.every(t=>this.has(t))?this.store.db.prepare(query).all() as Row[]:[];}
  private record(source:FailureSource,kind:string,row:Row,code:unknown,evidenceSource:Evidence,gate:unknown=null):FailureObservation|null{
    const recordId=token(typeof row.record_id==='number'||typeof row.record_id==='bigint'?String(row.record_id):row.record_id),projectId=token(row.project_id);
    if(!recordId||!projectId)return null;
    const normalized=normalizeCode(code);
    return {id:`${source}:${kind}:${recordId}`,source,recordId,projectId,...opt('taskId',row.task_id),...opt('runId',row.run_id),
      code:normalized,category:classify(source,normalized),evidenceSource,at:time(row.at),bindingDigest:token(row.binding)??'',
      commandIdOrGate:token(gate),runtime:token(row.runtime),...opt('requestId',row.request_id),...opt('qualityLoopId',row.loop_id)};
  }
  /** Internal superset used for families/hypotheses; never returned by list(). */
  observations(projectId:string):FailureObservation[]{
    const out:(FailureObservation|null)[]=[];
    for(const row of this.rows(sql.run.tables,sql.run.query)){
      const mock=row.origin==='mock'||row.outcome==='mock',native=row.origin==='native'&&(row.iface!=='claude.print'||row.outcome==='native');
      out.push(this.record('run','event',row,row.code,mock?'mock':native?'native':'unknown'));
    }
    for(const row of this.rows(sql.check.tables,sql.check.query)){
      // CheckRecord has no reason code; the closed verdict enum is the only allowed code and output is never read.
      const code=row.execution==='lost'?'LOST':typeof row.verdict==='string'?row.verdict.toUpperCase():null;
      out.push(this.record('check','check',row,code,evidence(row.evidence),row.gate));
    }
    for(const row of this.rows(sql.quality.tables,sql.quality.query))
      out.push(this.record('quality','loop',{...row,loop_id:row.record_id},row.code,evidence(row.evidence)));
    for(const row of this.rows(sql.integration.tables,sql.integration.query))out.push(this.record('integration','queue',row,row.code,'local'));
    for(const row of this.rows(sql.worker.tables,sql.worker.query))out.push(this.record('worker','lost',row,row.code,'local'));
    for(const row of this.rows(['worker_integration_refusals','worker_reservations'],refusalSql))out.push(this.record('worker','refusal',row,row.code,'local'));
    for(const row of this.rows(sql.capability.tables,sql.capability.query))out.push(this.record('capability','execution',row,row.code,evidence(row.evidence)));
    return out.filter((r):r is FailureObservation=>!!r&&r.projectId===projectId);
  }
  list(projectId:string):FailureRecord[]{
    return this.observations(projectId).map(r=>({id:r.id,source:r.source,recordId:r.recordId,projectId:r.projectId,
      ...(r.taskId?{taskId:r.taskId}:{}),...(r.runId?{runId:r.runId}:{}),code:r.code,category:r.category,
      evidenceSource:r.evidenceSource,at:r.at,bindingDigest:r.bindingDigest}));
  }
  families(projectId:string):IndexedFailureFamily[]{
    return groupFamilies(this.observations(projectId)).map(f=>({familyId:familyId(...f.tuple),...f}));
  }
  /** groupFamilies counts mock separately and ruleHypotheses ignores mock/unknown occurrences. */
  hypotheses(projectId:string):Hypothesis[]{return ruleHypotheses(groupFamilies(this.observations(projectId)));}
}
