import type {DatabaseSync} from 'node:sqlite';
import type {Run} from '../shared/types.ts';
import type {SoloOperationIdentity,SoloOperationRecord,SoloOperationView} from '../shared/solo-operation.ts';

const text=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const fields=['runtimeId','ownerIncarnation','generation','nativeSessionId'] as const;
export function assertSoloIdentity(value:unknown):asserts value is SoloOperationIdentity {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==fields.length)throw new Error('INVALID_OPERATION_IDENTITY');
  const data=Object.getOwnPropertyDescriptors(value);
  if(fields.some(key=>!data[key]||!('value' in data[key])))throw new Error('INVALID_OPERATION_IDENTITY');
  if(data.runtimeId.value!=='codex'||!text(data.ownerIncarnation.value)||!text(data.nativeSessionId.value)
    ||!Number.isSafeInteger(data.generation.value)||data.generation.value<1)throw new Error('INVALID_OPERATION_IDENTITY');
}

/** Additive migration; failed DDL/version writes leave the previous database intact. */
export function migrateSoloOperations(db:DatabaseSync){
  db.exec('BEGIN IMMEDIATE');
  try{
    const version=db.prepare("SELECT value FROM metadata WHERE key='schema:solo-operations'").get()?.value;
    if(version!==undefined&&version!=='1')throw new Error('OPERATION_SCHEMA_UNSUPPORTED');
    db.exec(`CREATE TABLE IF NOT EXISTS solo_operations(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS solo_operation_history(run_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,revision));`);
    if(version===undefined)db.prepare("INSERT INTO metadata(key,value) VALUES('schema:solo-operations','1')").run();
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

const recordFields=['schemaVersion','runId','requestId','workspaceId',...fields,'nativeTurnId','execution','revision','createdAt','updatedAt','eventKind'];
const stable=['schemaVersion','runId','requestId','workspaceId',...fields,'createdAt'] as const;
function parse(body:unknown,runId:string):SoloOperationRecord {
  try{
    const value=JSON.parse(String(body)) as SoloOperationRecord;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...recordFields].sort().join(','))throw new Error();
    const {runtimeId,ownerIncarnation,generation,nativeSessionId}=value;assertSoloIdentity({runtimeId,ownerIncarnation,generation,nativeSessionId});
    if(value.schemaVersion!==1||value.runId!==runId||!text(value.runId)||!text(value.requestId)||(value.workspaceId!==null&&!text(value.workspaceId))
      ||(value.nativeTurnId!==null&&!text(value.nativeTurnId))||!['starting','running','interrupting','completed','failed','interrupted','lost'].includes(value.execution)
      ||!Number.isSafeInteger(value.revision)||value.revision<1||!text(value.eventKind)||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string'
      ||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.updatedAt)))throw new Error();
    return value;
  }catch{throw new Error('OPERATION_INTEGRITY');}
}
export function readSoloOperation(db:DatabaseSync,runId:string):SoloOperationView {
  const row=db.prepare('SELECT body FROM solo_operations WHERE run_id=?').get(runId);
  const rows=db.prepare('SELECT revision,body FROM solo_operation_history WHERE run_id=? ORDER BY revision').all(runId);
  if(!row){if(rows.length)throw new Error('OPERATION_INTEGRITY');return {runId,identity:'legacy_unknown',record:null,history:[]};}
  const record=parse(row.body,runId),history=rows.map((row,index)=>{
    const item=parse(row.body,runId);
    if(row.revision!==index+1||item.revision!==index+1||stable.some(key=>item[key]!==record[key]))throw new Error('OPERATION_INTEGRITY');
    return item;
  });
  if(!history.length||JSON.stringify(history.at(-1))!==JSON.stringify(record))throw new Error('OPERATION_INTEGRITY');
  return {runId,identity:'recorded',record,history};
}
/** Called only within the Store transaction that persists the matching Run/event. */
export function insertSoloOperation(db:DatabaseSync,run:Run,identity:SoloOperationIdentity){
  assertSoloIdentity(identity);
  const record:SoloOperationRecord={schemaVersion:1,runId:run.id,requestId:run.requestId,workspaceId:run.workspaceId??null,...identity,
    nativeTurnId:run.turnId,execution:run.execution,revision:1,createdAt:run.createdAt,updatedAt:run.updatedAt,eventKind:'run.created'};
  const body=JSON.stringify(record);parse(body,run.id);
  db.prepare('INSERT INTO solo_operations VALUES(?,?)').run(run.id,body);
  db.prepare('INSERT INTO solo_operation_history VALUES(?,?,?)').run(run.id,1,body);
}
export function updateSoloOperation(db:DatabaseSync,previous:Run,next:Run,eventKind:string){
  if(previous.execution===next.execution&&previous.turnId===next.turnId)return;
  const view=readSoloOperation(db,next.id),old=view.record;if(!old)return;
  if(old.execution!==previous.execution||old.nativeTurnId!==previous.turnId)throw new Error('OPERATION_INTEGRITY');
  if(old.nativeTurnId!==null&&next.turnId!==old.nativeTurnId)throw new Error('OPERATION_TURN_MISMATCH');
  const record:SoloOperationRecord={...old,nativeTurnId:next.turnId,execution:next.execution,revision:old.revision+1,updatedAt:next.updatedAt,eventKind};
  const body=JSON.stringify(record);parse(body,next.id);
  db.prepare('UPDATE solo_operations SET body=? WHERE run_id=?').run(body,next.id);
  db.prepare('INSERT INTO solo_operation_history VALUES(?,?,?)').run(next.id,record.revision,body);
}
