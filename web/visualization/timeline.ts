import type { Snapshot,AppEvent } from '../../shared/types.ts';
import type { TimelineView } from '../../shared/parallel.ts';

const labels:Record<string,string>={
  'run.created':'Run starting','run.accepted':'Run accepted','run.started':'Run running',
  'run.completed':'Agent completed — not verified','run.interrupted':'Run interrupted',
  'run.interrupting':'Interrupt requested','interrupt.requested':'Interrupt requested','interrupt.accepted':'Interrupt accepted',
  'run.failed':'Run failed','run.lost':'Connection lost','provider.status':'Provider status changed',
};

export function buildTimeline(snapshot:Readonly<Snapshot>,events:readonly AppEvent[]):TimelineView {
  const workspaceKey=JSON.stringify([snapshot.selectedWorkspaceId??null,snapshot.workspace]);
  const items:{seq:number;at:string;runId:string|null;kind:string;label:string}[]=[];
  let lastSeq=snapshot.lastSeq;
  let reload:{reason:'gap'|'workspace_changed'|'conflicting_sequence';after:number}|null=null;
  const bySeq=new Map<number,AppEvent>(),conflicts=new Set<number>();
  for(const e of events) {
    if(!Number.isSafeInteger(e.seq)||e.seq<=0) continue;
    const prior=bySeq.get(e.seq);
    if(prior && JSON.stringify(prior)!==JSON.stringify(e)) conflicts.add(e.seq);
    else bySeq.set(e.seq,e);
  }
  const known=new Set(snapshot.runs.filter(r=>(r.workspaceId??null)===(snapshot.selectedWorkspaceId??null)).map(r=>r.id));
  for(const e of [...bySeq.values()].sort((a,b)=>a.seq-b.seq)) {
    // The snapshot is authoritative through its cursor; replay is strictly newer.
    if(e.seq<=snapshot.lastSeq) continue;
    if(conflicts.has(e.seq)) {reload={reason:'conflicting_sequence',after:lastSeq};break;}
    if(e.seq!==lastSeq+1) {reload={reason:'gap',after:lastSeq};break;}
    if(e.kind==='workspace.selected') {items.length=0;reload={reason:'workspace_changed',after:lastSeq};break;}
    lastSeq=e.seq;
    const run=e.data.run;
    if(e.runId && run && typeof run==='object' && !Array.isArray(run)) {
      const data=run as Record<string,unknown>;
      if((data.workspaceId??null)===(snapshot.selectedWorkspaceId??null) && data.id===e.runId) known.add(e.runId);
      else continue;
    }
    if(e.runId && !known.has(e.runId)) continue;
    // Do not render payloads or unknown event strings as labels.
    items.push({seq:e.seq,at:e.at,runId:e.runId,kind:e.kind,label:Object.hasOwn(labels,e.kind)?labels[e.kind]:'Other event'});
  }
  return {lastSeq,items,workspaceKey,reload};
}

/** Effect lifecycle boundary: cleanup cancels queued dispatch and ignores stale failures.
 * An already dispatched host request cannot be canceled here; the host must scope its
 * response to workspaceKey and discard responses from superseded workspace sessions.
 */
export function startTimelineReload(
  request:{workspaceKey:string;after:number;reason:string},
  onReload:(request:{workspaceKey:string;after:number;reason:string})=>Promise<void>,
  onFailure:()=>void,
):()=>void {
  let active=true;
  void Promise.resolve().then(()=>{if(active)return onReload(request);}).catch(()=>{if(active)onFailure();});
  return ()=>{active=false;};
}
