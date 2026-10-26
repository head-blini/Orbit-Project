import type { Snapshot } from '../shared/types.ts';
type ReceiptStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

/** Immutable server records have no delete route. Late lists can add, never regress revisions. */
export function mergeStudioRecords<T extends {id:string;revision?:number}>(current:T[],loaded:T[]):T[]{
  const records=new Map(current.map(record=>[record.id,record]));
  for(const record of loaded){const prior=records.get(record.id);if(!prior||(record.revision??0)>(prior.revision??0))records.set(record.id,record);}
  return [...records.values()];
}
export function acceptSnapshot(current:Snapshot|null,next:Snapshot,sameGeneration:boolean):Snapshot|null {
  return sameGeneration&&(!current||next.lastSeq>=current.lastSeq)?next:current;
}
/** Preserve only a request ID plus SHA-256 fingerprint across an uncertain save, never its text. */
export function createStudioMutator(post:(path:string,data:Record<string,unknown>)=>Promise<any>,storage?:ReceiptStorage){
  const pending=new Map<string,string>();
  return async function mutate(path:string,data:Record<string,unknown>){
    const bytes=new TextEncoder().encode(JSON.stringify({path,data}));
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
    const key='orbit.studio.request.'+digest;
    let requestId=pending.get(key);
    try{requestId??=storage?.getItem(key)??undefined;}catch{/* Storage unavailable: retain in memory. */}
    requestId??=crypto.randomUUID();pending.set(key,requestId);
    try{storage?.setItem(key,requestId);}catch{/* No document content is persisted here. */}
    const result=await post(path,{...data,requestId});
    pending.delete(key);try{storage?.removeItem(key);}catch{/* An acknowledged replay is safe. */}
    return result;
  };
}
