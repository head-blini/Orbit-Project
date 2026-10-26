import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Run, AppEvent, Project, Workspace } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import type {RunMetrics} from '../shared/analytics.ts';
import type {SoloOperationIdentity} from '../shared/solo-operation.ts';
import {migrateSoloOperations,readSoloOperation,insertSoloOperation,updateSoloOperation} from './solo-operation-journal.ts';
export class Store extends EventEmitter {
  db:DatabaseSync;
  private pendingEvents:AppEvent[]|null=null;
  private volatileMetrics=new Map<string,RunMetrics>();
  constructor(path:string) {
    super();this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_metrics(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,at TEXT NOT NULL,run_id TEXT,data TEXT NOT NULL);`);
    try{migrateSoloOperations(this.db);}catch(error){this.db.close();throw error;}
    for(const r of this.runs()) if(!terminal(r.execution)||r.execution==='lost') {
      if(!terminal(r.execution))this.updateRun(r.id,{execution:'lost'},'run.lost');
      const metrics=this.getRunMetrics(r.id);
      if(metrics&&(metrics.tokens!==null||metrics.tokenStatus!=='incomplete'||metrics.tokenIssue!=='CONNECTION_LOST'||metrics.durationMs!==null||metrics.finishedAt!==null)){
        try{this.saveRunMetrics({...metrics,tokens:null,tokenStatus:'incomplete',tokenIssue:'CONNECTION_LOST',durationMs:null,finishedAt:null});}catch{/* The volatile metrics quarantine remains readable; execution recovery already succeeded. */}
      }
    }
  }
  getMeta(key:string):string|null { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined)?.value??null; }
  setMeta(key:string,value:string) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  getThread(workspaceId?:string) {return this.getMeta(workspaceId?'thread:'+workspaceId:'thread');}
  setThread(id:string,workspaceId?:string) {this.setMeta(workspaceId?'thread:'+workspaceId:'thread',id);}
  projects():Project[] {return this.db.prepare('SELECT body FROM projects ORDER BY rowid').all().map(r=>JSON.parse(r.body as string));}
  workspaces():Workspace[] {return this.db.prepare('SELECT body FROM workspaces ORDER BY rowid').all().map(r=>JSON.parse(r.body as string));}
  saveProject(p:Project) {this.db.prepare('INSERT INTO projects VALUES(?,?)').run(p.id,JSON.stringify(p));this.append('project.registered',null,{projectId:p.id});}
  saveWorkspace(w:Workspace) {this.db.prepare('INSERT INTO workspaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(w.id,JSON.stringify(w));this.append('workspace.'+w.status,null,{workspaceId:w.id,projectId:w.projectId});}
  runs():Run[] {return this.db.prepare('SELECT body FROM runs ORDER BY rowid').all().map(row=>JSON.parse(row.body as string));}
  getRun(id:string):Run|null {const row=this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);return row?JSON.parse(row.body as string):null;}
  soloOperation(id:string){
    const run=this.getRun(id);if(!run)throw new Error('RUN_NOT_FOUND');const view=readSoloOperation(this.db,id),record=view.record;
    if(record&&(record.requestId!==run.requestId||record.workspaceId!==(run.workspaceId??null)||record.createdAt!==run.createdAt||record.execution!==run.execution||record.nativeTurnId!==run.turnId))throw new Error('OPERATION_INTEGRITY');
    return view;
  }
  runMetricsOverlay(id:string):RunMetrics|null {const value=this.volatileMetrics.get(id);return value?structuredClone(value):null;}
  getRunMetrics(id:string):RunMetrics|null {const pending=this.runMetricsOverlay(id);if(pending)return pending;const row=this.db.prepare('SELECT body FROM run_metrics WHERE run_id=?').get(id);return row?JSON.parse(String(row.body)):null;}
  /** Telemetry has its own timestamps and may arrive after execution completes. */
  saveRunMetrics(metrics:RunMetrics){
    if(!this.getRun(metrics.runId))throw new Error('RUN_NOT_FOUND');
    try{this.db.prepare('INSERT INTO run_metrics VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(metrics.runId,JSON.stringify(metrics));this.volatileMetrics.delete(metrics.runId);}
    catch(error){this.volatileMetrics.set(metrics.runId,{...structuredClone(metrics),tokens:null,tokenStatus:'incomplete',tokenIssue:'STORAGE_UNAVAILABLE'});throw error;}
  }
  findRequest(id:string):{run:Run;digest:string}|null {
    const row=this.db.prepare('SELECT body,digest FROM runs WHERE request_id=?').get(id);
    return row?{run:JSON.parse(row.body as string),digest:row.digest as string}:null;
  }
  createRun(requestId:string,digest:string,prompt:string,workspaceId?:string,task?:Pick<Run,'taskId'|'planningVersionId'|'requirementLabels'>,identity?:SoloOperationIdentity):Run {
    const now=new Date().toISOString();
    const r:Run={id:randomUUID(),requestId,turnId:null,prompt,response:'',execution:'starting',verification:'not_run',createdAt:now,updatedAt:now,...(workspaceId?{workspaceId}:{}),...task};
    this.db.exec('BEGIN IMMEDIATE');
    let event:AppEvent;
    try {this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(r.id,requestId,digest,JSON.stringify(r));if(identity!==undefined)insertSoloOperation(this.db,r,identity);event=this.insert('run.created',r.id,{run:r});this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
    this.emit('event',event);return r;
  }
  updateRun(id:string,patch:Partial<Pick<Run,'turnId'|'execution'|'response'>>,kind:string):Run {
    const old=this.getRun(id);if(!old)throw new Error('RUN_NOT_FOUND');
    if(terminal(old.execution)) return old;
    const next={...old,...patch,updatedAt:new Date().toISOString()};
    this.db.exec('BEGIN IMMEDIATE');let event:AppEvent;
    try {this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(next),id);updateSoloOperation(this.db,old,next,kind);event=this.insert(kind,id,{run:next});this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
    this.emit('event',event);return next;
  }
  private insert(kind:string,runId:string|null,data:Record<string,unknown>):AppEvent {
    const at=new Date().toISOString();
    const row=this.db.prepare('INSERT INTO events(kind,at,run_id,data) VALUES(?,?,?,?)').run(kind,at,runId,JSON.stringify(data));
    return {seq:Number(row.lastInsertRowid),kind,at,runId,data};
  }
  /** Called inside the check transaction. Actual verdicts stay in bound Check records. */
  markVerificationRecorded(runId:string){
    if(!this.pendingEvents)throw new Error('VERIFICATION_TRANSACTION_REQUIRED');
    const run=this.getRun(runId);if(!run)throw new Error('RUN_NOT_FOUND');
    if(run.verification==='recorded')return;
    const next={...run,verification:'recorded' as const};
    this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(next),runId);
    this.append('run.verification_recorded',runId,{run:next});
  }
  /** Synchronous atomic Studio mutation; observers only see committed events. */
  transaction<T>(work:()=>T):T {
    if(this.pendingEvents)throw new Error('NESTED_TRANSACTION');
    this.db.exec('BEGIN IMMEDIATE');this.pendingEvents=[];
    let result:T;let events:AppEvent[];
    try{result=work();this.db.exec('COMMIT');events=this.pendingEvents;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    finally{this.pendingEvents=null;}
    for(const event of events)this.emit('event',event);
    return result;
  }
  append(kind:string,runId:string|null,data:Record<string,unknown>={}) {const e=this.insert(kind,runId,data);if(this.pendingEvents)this.pendingEvents.push(e);else this.emit('event',e);return e;}
  lastSeq():number {return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()!.seq);}
  eventsAfter(seq:number,limit=100000):AppEvent[] {return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(seq,limit).map(r=>({seq:Number(r.seq),kind:String(r.kind),at:String(r.at),runId:r.run_id as string|null,data:JSON.parse(r.data as string)}));}
  close(){this.db.close();}
}
