import { DatabaseSync } from 'node:sqlite';
// A separate SQLite connection holds an OS-backed exclusive lock for our lifetime.
// Crash releases the lock; no stale PID file cleanup or user database mutation needed.
export function acquireInstance(path:string):()=>void {
  const db=new DatabaseSync(path);
  try{db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS instance(id INTEGER); BEGIN EXCLUSIVE;');}
  catch{db.close();throw new Error('INSTANCE_RUNNING: another server owns this data directory');}
  return ()=>{db.exec('ROLLBACK');db.close();};
}
