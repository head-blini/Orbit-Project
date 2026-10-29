import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';

/** A reproduction case is a digest-only manifest. It never holds input bodies, output, paths or free text. */
export interface FailureCaseInputDigests {artifact?:string;baseline?:string;config?:string;}
export interface FailureCaseConditions {commandId?:string;runtime?:string;}
export interface FailureCaseProvenance {sourceTable:FailureCaseSourceTable;recordId:string;recordBodySha256:string;indexerVersion:string;createdAt:string;}
export interface FailureCase {
  id:string;requestId:string;familyId:string;failureId:string;expected:'same_failure';
  inputDigests:FailureCaseInputDigests;conditions:FailureCaseConditions;provenance:FailureCaseProvenance;
}
export interface FailureCaseCreate {
  requestId:string;familyId:string;failureId:string;sourceTable:FailureCaseSourceTable;recordId:string;recordBodySha256:string;
  expected:'same_failure';inputDigests:FailureCaseInputDigests;conditions:FailureCaseConditions;indexerVersion:string;confirmed:true;
}
/** Read port for HE. It deliberately has no create/delete. */
export interface FailureCaseReader {listCases(familyId?:string):FailureCase[];getCase(caseId:string):FailureCase;}

/** Source tables and the stored body column hashed for provenance. Identifiers come only from this constant map.
 * recordBodySha256 = lowercase SHA-256 hex of the UTF-8 body column text exactly as stored. The body is never copied. */
const SOURCES={
  runs:{id:'id',body:'body'},
  events:{id:'seq',body:'data'},
  verification_checks:{id:'id',body:'body'},
  quality_loops:{id:'id',body:'body'},
  integration_queue:{id:'id',body:'body'},
  worker_integration_refusals:{id:'reservation_id',body:'reason'},
  capability_executions:{id:'id',body:'body'},
} as const;
export type FailureCaseSourceTable=keyof typeof SOURCES;

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$(?![\s\S])/.test(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(value);
const requestId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9-]{8,80}$(?![\s\S])/.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value:unknown,keys:string[])=>plain(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const subset=(value:unknown,keys:string[])=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const strings=(value:unknown,depth=0):string[]=>typeof value==='string'?[value]:plain(value)&&depth<2?Object.values(value).flatMap(item=>strings(item,depth+1)):[];
const CREATE_KEYS=['requestId','familyId','failureId','sourceTable','recordId','recordBodySha256','expected','inputDigests','conditions','indexerVersion','confirmed'];

export class FailureCaseStore implements FailureCaseReader {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec('CREATE TABLE IF NOT EXISTS failure_cases(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,family_id TEXT NOT NULL,body TEXT NOT NULL)');
  }
  /** Manual, confirmed creation only. Any credential-like string refuses the whole request; nothing is redacted and stored. */
  create(input:FailureCaseCreate):FailureCase{
    const all=strings(input);
    if(all.some(containsCredential)||containsCredential(all.join('\n')))throw new AppError('FAILURE_CASE_SENSITIVE_INPUT',400);
    if(!exact(input,CREATE_KEYS)||input.confirmed!==true)throw new AppError('FAILURE_CASE_CONFIRMATION_REQUIRED',400);
    if(!requestId(input.requestId)||!digest(input.familyId)||!id(input.failureId)||!Object.hasOwn(SOURCES,input.sourceTable)
      ||!id(input.recordId)||!digest(input.recordBodySha256)||input.expected!=='same_failure'||!id(input.indexerVersion)
      ||!subset(input.inputDigests,['artifact','baseline','config'])||!Object.values(input.inputDigests).every(digest)
      ||!subset(input.conditions,['commandId','runtime'])||!Object.values(input.conditions).every(id))throw new AppError('INVALID_FIELDS',400);
    const requestDigest=sha(JSON.stringify(CREATE_KEYS.map(key=>key==='inputDigests'||key==='conditions'
      ?Object.entries(input[key]).sort(([a],[b])=>a<b?-1:1):input[key as keyof FailureCaseCreate])));
    const prior=this.store.db.prepare('SELECT body,request_digest FROM failure_cases WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.request_digest!==requestDigest)throw new AppError('IDEMPOTENCY_CONFLICT');return JSON.parse(String(prior.body));}
    if(this.sourceBodySha256(input.sourceTable,input.recordId)!==input.recordBodySha256)throw new AppError('FAILURE_CASE_PROVENANCE_MISMATCH');
    const {artifact,baseline,config}=input.inputDigests,{commandId,runtime}=input.conditions;
    // Copy named fields only; JSON.stringify drops undefined optionals.
    const record:FailureCase={id:randomUUID(),requestId:input.requestId,familyId:input.familyId,failureId:input.failureId,expected:'same_failure',
      inputDigests:{artifact,baseline,config},conditions:{commandId,runtime},
      provenance:{sourceTable:input.sourceTable,recordId:input.recordId,recordBodySha256:input.recordBodySha256,indexerVersion:input.indexerVersion,createdAt:new Date().toISOString()}};
    const body=JSON.stringify(record);
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO failure_cases VALUES(?,?,?,?,?)').run(record.id,record.requestId,requestDigest,record.familyId,body);});
    return JSON.parse(body);
  }
  listCases(familyId?:string):FailureCase[]{
    if(familyId!==undefined&&!digest(familyId))throw new AppError('INVALID_FIELDS',400);
    const rows=familyId===undefined
      ?this.store.db.prepare('SELECT body FROM failure_cases ORDER BY rowid').all()
      :this.store.db.prepare('SELECT body FROM failure_cases WHERE family_id=? ORDER BY rowid').all(familyId);
    return rows.map(row=>JSON.parse(String(row.body)) as FailureCase);
  }
  getCase(caseId:string):FailureCase{
    const row=id(caseId)?this.store.db.prepare('SELECT body FROM failure_cases WHERE id=?').get(caseId):undefined;
    if(!row)throw new AppError('FAILURE_CASE_NOT_FOUND',404);
    return JSON.parse(String(row.body));
  }
  /** Retention is indefinite; only an explicit, confirmed user request deletes a case. */
  delete(caseId:string,options:{confirmed:true}):{id:string;deleted:true}{
    if(!exact(options,['confirmed'])||options.confirmed!==true)throw new AppError('FAILURE_CASE_CONFIRMATION_REQUIRED',400);
    this.getCase(caseId);
    this.store.transaction(()=>{this.store.db.prepare('DELETE FROM failure_cases WHERE id=?').run(caseId);});
    return {id:caseId,deleted:true};
  }
  /** Read-only: hashes the current source body, never returns or stores it. */
  private sourceBodySha256(table:FailureCaseSourceTable,recordId:string):string{
    const source=SOURCES[table];let row:Record<string,unknown>|undefined;
    try{row=this.store.db.prepare(`SELECT ${source.body} AS body FROM ${table} WHERE ${source.id}=?`).get(recordId);}
    catch{row=undefined;}// A missing source table is the same as a missing record.
    if(!row||typeof row.body!=='string')throw new AppError('FAILURE_CASE_SOURCE_NOT_FOUND',404);
    return sha(row.body);
  }
}

/** HE gets this object, not the store: only the two read methods exist at runtime. */
export function failureCaseReader(store:FailureCaseStore):FailureCaseReader{
  return Object.freeze({listCases:(familyId?:string)=>store.listCases(familyId),getCase:(caseId:string)=>store.getCase(caseId)});
}
