import type {DatabaseSync} from 'node:sqlite';
import type {NativeConnectionEvidence,NativeNotCreatedReason} from '../shared/solo-operation.ts';
import type {NativeProcessObservation} from '../shared/native-process.ts';

const text=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const positive=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0;
const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const processKeys=['handleId','pid','createdAt','state','closedAt','exitCode','signal'] as const;
function fields(value:unknown,keys:string[]):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)return false;
  const descriptors=Object.getOwnPropertyDescriptors(value);return keys.every(key=>descriptors[key]&&'value' in descriptors[key]);
}
function assertProcess(value:unknown):asserts value is NativeProcessObservation{
  if(!fields(value,[...processKeys]))throw new Error('INVALID_PROCESS_OBSERVATION');
  const ended=value.state==='closed'||value.state==='spawn_failed';
  if(!text(value.handleId)||!date(value.createdAt)||typeof value.state!=='string'||!['spawn_pending','running','closed','spawn_failed'].includes(value.state)
    ||(ended?!date(value.closedAt):value.closedAt!==null)
    ||(value.pid!==null&&!positive(value.pid))||(['running','closed'].includes(String(value.state))&&value.pid===null)
    ||(value.state==='spawn_failed'&&value.pid!==null)
    ||(value.exitCode!==null&&(!Number.isSafeInteger(value.exitCode)||Number(value.exitCode)<0||Number(value.exitCode)>0xffffffff))
    ||(value.signal!==null&&(typeof value.signal!=='string'||!/^SIG[A-Z0-9]{1,16}$/.test(value.signal)))
    ||(value.state!=='closed'&&(value.exitCode!==null||value.signal!==null)))throw new Error('INVALID_PROCESS_OBSERVATION');
}
const keys=['schemaVersion','runtimeId','ownerIncarnation','generation','createdAt','updatedAt','nativeSessionId','transportClosedAt','process','journalState','notCreatedReason'];
function assertIdentity(owner:string,generation:number){if(!text(owner)||!positive(generation))throw new Error('INVALID_CONNECTION_IDENTITY');}
export function migrateNativeConnections(db:DatabaseSync){
  db.exec('BEGIN IMMEDIATE');try{
    const version=db.prepare("SELECT value FROM metadata WHERE key='schema:native-connections'").get()?.value;
    if(version!==undefined&&version!=='1')throw new Error('CONNECTION_SCHEMA_UNSUPPORTED');
    db.exec('CREATE TABLE IF NOT EXISTS native_connections(owner_incarnation TEXT NOT NULL,generation INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner_incarnation,generation));');
    if(version===undefined)db.prepare("INSERT INTO metadata(key,value) VALUES('schema:native-connections','1')").run();
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function readNativeConnection(db:DatabaseSync,owner:string,generation:number):NativeConnectionEvidence|null{
  assertIdentity(owner,generation);const row=db.prepare('SELECT body FROM native_connections WHERE owner_incarnation=? AND generation=?').get(owner,generation);if(!row)return null;
  try{
    const value:unknown=JSON.parse(String(row.body));
    if(!fields(value,keys)||value.schemaVersion!==1||value.runtimeId!=='codex'||value.ownerIncarnation!==owner||value.generation!==generation
      ||!date(value.createdAt)||!date(value.updatedAt)||(value.nativeSessionId!==null&&!text(value.nativeSessionId))
      ||(value.transportClosedAt!==null&&!date(value.transportClosedAt))||!['open','closed'].includes(String(value.journalState))
      ||(value.notCreatedReason!==null&&value.notCreatedReason!=='CODEX_NOT_INSTALLED'&&value.notCreatedReason!=='LAUNCH_REJECTED_BEFORE_SPAWN'))throw new Error();
    if(value.process!==null)assertProcess(value.process);
    if(value.notCreatedReason!==null&&(value.process!==null||value.nativeSessionId!==null||value.journalState!=='closed'))throw new Error();
    return value as unknown as NativeConnectionEvidence;
  }catch{throw new Error('CONNECTION_INTEGRITY');}
}
export function beginNativeConnection(db:DatabaseSync,owner:string,generation:number){
  assertIdentity(owner,generation);const now=new Date().toISOString();
  const record:NativeConnectionEvidence={schemaVersion:1,runtimeId:'codex',ownerIncarnation:owner,generation,createdAt:now,updatedAt:now,nativeSessionId:null,transportClosedAt:null,process:null,journalState:'open',notCreatedReason:null};
  db.prepare('INSERT INTO native_connections VALUES(?,?,?)').run(owner,generation,JSON.stringify(record));
}
function current(db:DatabaseSync,owner:string,generation:number){const record=readNativeConnection(db,owner,generation);if(!record)throw new Error('CONNECTION_NOT_FOUND');return record;}
function save(db:DatabaseSync,record:NativeConnectionEvidence){record.updatedAt=new Date().toISOString();db.prepare('UPDATE native_connections SET body=? WHERE owner_incarnation=? AND generation=?').run(JSON.stringify(record),record.ownerIncarnation,record.generation);}
export function bindNativeSession(db:DatabaseSync,owner:string,generation:number,session:string){
  if(!text(session))throw new Error('INVALID_CONNECTION_IDENTITY');const record=current(db,owner,generation);
  if(record.nativeSessionId===session)return false;
  if(record.nativeSessionId!==null)throw new Error('CONNECTION_IDENTITY_MISMATCH');
  record.nativeSessionId=session;save(db,record);return true;
}
export function observeNativeProcess(db:DatabaseSync,owner:string,generation:number,observation:NativeProcessObservation){
  assertProcess(observation);const record=current(db,owner,generation),old=record.process;
  if(old){
    if(processKeys.every(key=>old[key]===observation[key]))return false;
    if(old.handleId!==observation.handleId||old.createdAt!==observation.createdAt||(old.pid!==null&&old.pid!==observation.pid)
      ||old.state==='closed'||old.state==='spawn_failed'||(old.state==='running'&&!['running','closed'].includes(observation.state)))throw new Error('PROCESS_OBSERVATION_MISMATCH');
  }
  record.process={...observation};save(db,record);return true;
}
export function closeNativeTransport(db:DatabaseSync,owner:string,generation:number){
  const record=current(db,owner,generation);if(record.transportClosedAt!==null)return false;
  record.transportClosedAt=new Date().toISOString();save(db,record);return true;
}
/** Collection bookkeeping only. This does not release an execution or resource claim. */
export function finishNativeConnectionJournal(db:DatabaseSync,owner:string,generation:number,notCreatedReason:NativeNotCreatedReason|null=null){
  if(notCreatedReason!==null&&notCreatedReason!=='CODEX_NOT_INSTALLED'&&notCreatedReason!=='LAUNCH_REJECTED_BEFORE_SPAWN')throw new Error('INVALID_CONNECTION_OBSERVATION');
  const record=current(db,owner,generation);if(record.journalState==='closed')return false;
  if(notCreatedReason!==null){if(record.process!==null||record.nativeSessionId!==null)throw new Error('CONNECTION_IDENTITY_MISMATCH');record.notCreatedReason=notCreatedReason;}
  else if(record.transportClosedAt===null||(record.process!==null&&!['closed','spawn_failed'].includes(record.process.state)))throw new Error('CONNECTION_OBSERVATION_INCOMPLETE');
  record.journalState='closed';save(db,record);return true;
}
export function unresolvedNativeConnections(db:DatabaseSync){
  return db.prepare('SELECT owner_incarnation,generation FROM native_connections').all().filter(row=>readNativeConnection(db,String(row.owner_incarnation),Number(row.generation))?.journalState==='open').length>0;
}
