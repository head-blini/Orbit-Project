import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Run, AppEvent } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
export class Store extends EventEmitter {
  db:DatabaseSync;
  constructor(path:string) {
    super();this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,at TEXT NOT NULL,run_id TEXT,data TEXT NOT NULL);`);
    for(const r of this.runs()) if(!terminal(r.execution)) this.updateRun(r.id,{execution:'lost'},'run.lost');
  }
  getMeta(key:string):string|null { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined)?.value??null; }
  setMeta(key:string,value:string) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  getThread() {return this.getMeta('thread');}
  setThread(id:string) {this.setMeta('thread',id);}
  runs():Run[] {return this.db.prepare('SELECT body FROM runs ORDER BY rowid').all().map(row=>JSON.parse(row.body as string));}
  getRun(id:string):Run|null {const row=this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);return row?JSON.parse(row.body as string):null;}
  findRequest(id:string):{run:Run;digest:string}|null {
    const row=this.db.prepare('SELECT body,digest FROM runs WHERE request_id=?').get(id);
    return row?{run:JSON.parse(row.body as string),digest:row.digest as string}:null;
  }
  createRun(requestId:string,digest:string,prompt:string):Run {
    const now=new Date().toISOString();
    const r:Run={id:randomUUID(),requestId,turnId:null,prompt,response:'',execution:'starting',verification:'not_run',createdAt:now,updatedAt:now};
    this.db.exec('BEGIN IMMEDIATE');
    let event:AppEvent;
    try {this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(r.id,requestId,digest,JSON.stringify(r));event=this.insert('run.created',r.id,{run:r});this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
    this.emit('event',event);return r;
  }
  updateRun(id:string,patch:Partial<Pick<Run,'turnId'|'execution'|'response'>>,kind:string):Run {
    const old=this.getRun(id);if(!old)throw new Error('RUN_NOT_FOUND');
    if(terminal(old.execution)) return old;
    const next={...old,...patch,updatedAt:new Date().toISOString()};
    this.db.exec('BEGIN IMMEDIATE');let event:AppEvent;
    try {this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(next),id);event=this.insert(kind,id,{run:next});this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
    this.emit('event',event);return next;
  }
  private insert(kind:string,runId:string|null,data:Record<string,unknown>):AppEvent {
    const at=new Date().toISOString();
    const row=this.db.prepare('INSERT INTO events(kind,at,run_id,data) VALUES(?,?,?,?)').run(kind,at,runId,JSON.stringify(data));
    return {seq:Number(row.lastInsertRowid),kind,at,runId,data};
  }
  append(kind:string,runId:string|null,data:Record<string,unknown>={}) {const e=this.insert(kind,runId,data);this.emit('event',e);return e;}
  lastSeq():number {return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()!.seq);}
  eventsAfter(seq:number,limit=100000):AppEvent[] {return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(seq,limit).map(r=>({seq:Number(r.seq),kind:String(r.kind),at:String(r.at),runId:r.run_id as string|null,data:JSON.parse(r.data as string)}));}
  close(){this.db.close();}
}
