import {createHash} from 'node:crypto';
import type {HandoffHistoryEntry,HandoffPackage} from '../shared/handoff.ts';
import type {Run} from '../shared/types.ts';
import type {Store} from './store.ts';

const KIND='handoff.delivered';
// Executor-side evidence only: Claude session init and Codex turn started/accepted.
const STARTED=['run.started','run.accepted'];

/** Append-only; call only after the run exists and the launch was not refused. One record per run. */
export function recordHandoffDelivery(store:Store,run:Run,destination:'claude-code'|'codex',pkg:Pick<HandoffPackage,'markdown'|'baseline'>):void {
  if(!run.projectId||!run.taskId||store.db.prepare('SELECT 1 FROM events WHERE kind=? AND run_id=? LIMIT 1').get(KIND,run.id))return;
  store.append(KIND,run.id,{requestId:run.requestId??null,projectId:run.projectId,taskId:run.taskId,destination,
    packageDigest:createHash('sha256').update(pkg.markdown).digest('hex'),planningVersionId:pkg.baseline.planningVersionId,planningContentHash:pkg.baseline.contentHash});
}

/** Read-only view; receipt is derived from the run's own events at read time. */
export function handoffHistory(store:Store,projectId:string,taskId:string):HandoffHistoryEntry[] {
  const started=store.db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind IN (${STARTED.map(()=>'?').join(',')}) LIMIT 1`);
  return store.db.prepare("SELECT seq,at,run_id,data FROM events WHERE kind=? AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.taskId')=? ORDER BY seq").all(KIND,projectId,taskId).map(row=>{
    const data=JSON.parse(String(row.data)),runId=String(row.run_id);
    return {seq:Number(row.seq),at:String(row.at),runId,requestId:data.requestId,projectId,taskId,destination:data.destination,packageDigest:data.packageDigest,
      planningVersionId:data.planningVersionId,planningContentHash:data.planningContentHash,
      receipt:started.get(runId,...STARTED)?'acknowledged':'delivered',runExecution:store.getRun(runId)?.execution??null} as HandoffHistoryEntry;
  });
}
