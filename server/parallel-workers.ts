import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {normalizeWorkerClaim,workerClaimsConflict} from './worker-resources.ts';
import {WORKER_LIMITS} from '../shared/parallel-workers.ts';
import type {WorkerReserveInput,WorkerReservation,WorkerFence,WorkerReleaseEvidence,WorkerState} from '../shared/parallel-workers.ts';

function fail(code:string):never {throw new AppError('WORKER_'+code,409);}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const positive=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0;
const unique=(v:string[])=>new Set(v).size===v.length;
const fields=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function validate(input:WorkerReserveInput):WorkerReserveInput {
  if(!fields(input,['requestId','ownerIncarnation','batch','attempt','claims'])||!id(input.requestId)||!id(input.ownerIncarnation))fail('INPUT_INVALID');
  const b=input.batch,a=input.attempt;
  if(!fields(b,['id','projectId','planningVersionId','graphRevision','planningHash','taskIds','contractDigests','inputArtifactHashes','runtimeChoices','parallelLimit'])
    ||![b.id,b.projectId,b.planningVersionId].every(id)||!positive(b.graphRevision)||!sha(b.planningHash)
    ||!positive(b.parallelLimit)||b.parallelLimit>WORKER_LIMITS.total
    ||!Array.isArray(b.taskIds)||!b.taskIds.length||b.taskIds.length>1000||!b.taskIds.every(id)||!unique(b.taskIds)
    ||!Array.isArray(b.contractDigests)||b.contractDigests.length>1000||!b.contractDigests.every(c=>fields(c,['id','digest'])&&id(c.id)&&digest(c.digest))||!unique(b.contractDigests.map(c=>c.id))
    ||!Array.isArray(b.inputArtifactHashes)||b.inputArtifactHashes.length>1000||!b.inputArtifactHashes.every(c=>fields(c,['id','hash'])&&id(c.id)&&sha(c.hash))||!unique(b.inputArtifactHashes.map(c=>c.id))
    ||!Array.isArray(b.runtimeChoices)||b.runtimeChoices.length!==b.taskIds.length||!b.runtimeChoices.every(c=>fields(c,['taskId','runtimeId'])&&b.taskIds.includes(c.taskId)&&id(c.runtimeId))||!unique(b.runtimeChoices.map(c=>c.taskId))
    ||!fields(a,['id','taskId','runtimeId','dispatchRequestId'])||![a.id,a.taskId,a.runtimeId,a.dispatchRequestId].every(id)
    ||!b.runtimeChoices.some(c=>c.taskId===a.taskId&&c.runtimeId===a.runtimeId)
    ||!Array.isArray(input.claims)||!input.claims.length||input.claims.length>1000)fail('INPUT_INVALID');
  if(b.runtimeChoices.some(c=>!Object.hasOwn(WORKER_LIMITS.perRuntime,c.runtimeId)))fail('RUNTIME_UNSUPPORTED');
  if(Buffer.byteLength(JSON.stringify(input))>1024*1024)fail('INPUT_TOO_LARGE');
  return {...structuredClone(input),claims:input.claims.map(normalizeWorkerClaim)};
}

/** Cooperative durable reservations only. Existing runtime/RepositoryAuthority
 * gates remain mandatory. All callers must use the same authoritative Store DB.
 * No expiry, automatic takeover, redispatch, quota inference or execution wiring. */
export class ParallelWorkerService {
  private readonly store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_generations(generation INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS worker_reservations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,dispatch_request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_claims(reservation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(reservation_id,ordinal));
    `);
  }
  read(reservationId:string):WorkerReservation {
    const row=this.store.db.prepare('SELECT body FROM worker_reservations WHERE id=?').get(reservationId);
    if(!row)fail('RESERVATION_NOT_FOUND');return JSON.parse(String(row.body));
  }
  list():WorkerReservation[]{return this.store.db.prepare('SELECT body FROM worker_reservations ORDER BY rowid').all().map(row=>JSON.parse(String(row.body)));}
  private generation():number {
    const n=Number(this.store.db.prepare('INSERT INTO worker_generations DEFAULT VALUES').run().lastInsertRowid);
    if(!positive(n))fail('GENERATION_EXHAUSTED');return n;
  }
  reserve(raw:WorkerReserveInput):WorkerReservation {
    const input=validate(raw),inputDigest=hash(raw);
    return this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT id,input_digest FROM worker_reservations WHERE request_id=?').get(input.requestId);
      if(prior){if(prior.input_digest!==inputDigest)fail('IDEMPOTENCY_CONFLICT');return this.read(String(prior.id));}
      const batchDigest=hash(input.batch),batch=this.store.db.prepare('SELECT digest FROM worker_batches WHERE id=?').get(input.batch.id);
      if(batch&&batch.digest!==batchDigest)fail('BATCH_CONFLICT');
      if(this.store.db.prepare('SELECT id FROM worker_reservations WHERE attempt_id=? OR dispatch_request_id=?').get(input.attempt.id,input.attempt.dispatchRequestId))fail('ATTEMPT_CONFLICT');
      const held=this.list().filter(r=>r.state!=='released');
      if(held.some(r=>r.batch.projectId===input.batch.projectId&&r.attempt.taskId===input.attempt.taskId))fail('TASK_RESERVED');
      if(held.some(r=>r.claims.some(a=>input.claims.some(b=>workerClaimsConflict(a,b)))))fail('RESOURCE_CONFLICT');
      // Terminal reservations retain both claims and admission slots until explicit release.
      if(held.length>=WORKER_LIMITS.total)fail('TOTAL_LIMIT');
      if(held.filter(r=>r.attempt.runtimeId===input.attempt.runtimeId).length>=WORKER_LIMITS.perRuntime[input.attempt.runtimeId])fail('RUNTIME_LIMIT');
      if(held.filter(r=>r.batch.id===input.batch.id).length>=input.batch.parallelLimit)fail('BATCH_LIMIT');
      const now=new Date().toISOString();
      const record:WorkerReservation={reservationId:randomUUID(),requestId:input.requestId,ownerIncarnation:input.ownerIncarnation,fencingGeneration:this.generation(),batch:input.batch,attempt:input.attempt,claims:input.claims,state:'reserved',evidence:null,createdAt:now,updatedAt:now};
      if(!batch)this.store.db.prepare('INSERT INTO worker_batches VALUES(?,?,?)').run(input.batch.id,batchDigest,JSON.stringify(input.batch));
      this.store.db.prepare('INSERT INTO worker_reservations VALUES(?,?,?,?,?,?)').run(record.reservationId,input.requestId,inputDigest,input.attempt.id,input.attempt.dispatchRequestId,JSON.stringify(record));
      const insert=this.store.db.prepare('INSERT INTO worker_claims VALUES(?,?,?)');record.claims.forEach((claim,i)=>insert.run(record.reservationId,i,JSON.stringify(claim)));
      this.store.append('worker.reserved',null,{reservationId:record.reservationId,attemptId:record.attempt.id,dispatchRequestId:record.attempt.dispatchRequestId,fencingGeneration:record.fencingGeneration});
      return record;
    });
  }
  private owned(token:WorkerFence):WorkerReservation {
    if(!token||!id(token.reservationId)||!id(token.ownerIncarnation)||!positive(token.fencingGeneration))fail('FENCE_STALE');
    const r=this.read(token.reservationId);
    if(r.ownerIncarnation!==token.ownerIncarnation||r.fencingGeneration!==token.fencingGeneration)fail('FENCE_STALE');return r;
  }
  private save(r:WorkerReservation):WorkerReservation {
    r.updatedAt=new Date().toISOString();
    this.store.db.prepare('UPDATE worker_reservations SET body=? WHERE id=?').run(JSON.stringify(r),r.reservationId);
    this.store.append('worker.'+r.state,null,{reservationId:r.reservationId,fencingGeneration:r.fencingGeneration});return r;
  }
  /** Explicit server-owner handoff; preserves state and all held resources. */
  transfer(token:WorkerFence,newOwner:string):WorkerReservation {
    return this.store.transaction(()=>{const r=this.owned(token);if(!id(newOwner)||newOwner===r.ownerIncarnation||r.state==='released')fail('INVALID_TRANSFER');
      r.ownerIncarnation=newOwner;r.fencingGeneration=this.generation();return this.save(r);});
  }
  transition(token:WorkerFence,state:'dispatched'|'running'|'lost_unknown'):WorkerReservation {
    return this.store.transaction(()=>{const r=this.owned(token);
      const allowed:Partial<Record<WorkerState,string[]>>={reserved:['dispatched','lost_unknown'],dispatched:['running','lost_unknown'],running:['lost_unknown']};
      if(!allowed[r.state]?.includes(state))fail('INVALID_TRANSITION');r.state=state;return this.save(r);});
  }
  private checkEvidence(r:WorkerReservation,e:WorkerReleaseEvidence|undefined,kind:WorkerReleaseEvidence['kind']):void {
    if(!fields(e,['kind','dispatchRequestId','evidenceId'])||e!.kind!==kind||e!.dispatchRequestId!==r.attempt.dispatchRequestId||!id(e!.evidenceId))fail('RELEASE_EVIDENCE_REQUIRED');
  }
  confirmTerminal(token:WorkerFence,evidence:WorkerReleaseEvidence):WorkerReservation {
    return this.store.transaction(()=>{const r=this.owned(token);this.checkEvidence(r,evidence,'terminal_confirmed');
      if(!['dispatched','running','lost_unknown'].includes(r.state))fail('INVALID_TRANSITION');
      r.state='terminal_confirmed';r.evidence={...evidence};return this.save(r);});
  }
  release(token:WorkerFence,evidence?:WorkerReleaseEvidence):WorkerReservation {
    return this.store.transaction(()=>{const r=this.owned(token);
      if(r.state==='released')return r;
      if(r.state==='reserved'){this.checkEvidence(r,evidence,'not_dispatched');r.evidence={...evidence!};}
      else if(r.state!=='terminal_confirmed')fail('RELEASE_EVIDENCE_REQUIRED');
      else this.checkEvidence(r,r.evidence??undefined,'terminal_confirmed');
      r.state='released';return this.save(r);
    });
  }
}
