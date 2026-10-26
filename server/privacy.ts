import { inspectOutbound } from './guardrails/outbound.ts';

const MAX_OUTPUT_CHARS = 64000;

// Never log raw RPC, stderr, account/config responses, or tool output.
// Patterns are defense in depth, not a guarantee against arbitrary encoded secrets.
// Streaming callers MUST supply cumulative raw text, not independently sanitized deltas.
// An unfinished token is withheld until its following delimiter or final completion.
export function safeText(input:string, final=true):string {
  return safeTextItems([input],final);
}
export function containsCredential(input:string):boolean { return safeText(input)!==input; }

/** Supply raw cumulative item snapshots. Detect cross-item credentials before
 * withholding each unfinished item's tail; transformed text loses that context.
 * Persist/emit only the returned snapshot, never the raw items or individual deltas.
 */
export function safeTextItems(items:readonly string[],final:boolean):string {
  let inputs:string[];
  try{
    if(!Array.isArray(items))throw new Error();
    const descriptors=Object.getOwnPropertyDescriptors(items);inputs=[];
    for(let index=0;index<items.length;index++){
      const descriptor=descriptors[String(index)];
      if(!descriptor||!('value' in descriptor)||typeof descriptor.value!=='string')throw new Error();
      inputs.push(descriptor.value);
    }
  }catch{throw new Error('INVALID_OUTPUT_TEXT');}
  let value='';
  const tails:{start:number;end:number;credential:boolean}[]=[];
  for(let index=0;index<inputs.length&&value.length<MAX_OUTPUT_CHARS;index++){
    if(index)value+='\n\n'.slice(0,MAX_OUTPUT_CHARS-value.length);
    const start=value.length,part=inputs[index].slice(0,MAX_OUTPUT_CHARS-start);
    value+=part;
    if(!final||part.length<inputs[index].length){
      const tail=/\S+$/u.exec(part);
      if(tail)tails.push({start:start+tail.index,end:value.length,credential:false});
    }
  }
  const spans=inspectOutbound(value).filter(finding=>finding.kind==='credential').map(finding=>({...finding,credential:true}));
  // The outbound inspector identifies the PEM header. Output must also hide the
  // body, including when a stream has not supplied an END marker yet.
  for(const pattern of [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
    /\bglpat-[\w-]+/g,
    /\bsk-[\w-]*/g,
  ])for(const match of value.matchAll(pattern))spans.push({kind:'credential',start:match.index,end:match.index+match[0].length,credential:true});
  const combined:{start:number;end:number;credential:boolean}[]=[...spans,...tails];
  combined.sort((a,b)=>a.start-b.start||b.end-a.end);
  let output='',cursor=0;
  for(let index=0;index<combined.length;index++){
    const span=combined[index];let end=span.end,credential=span.credential;
    while(index+1<combined.length&&combined[index+1].start<=end){
      const next=combined[++index];end=Math.max(end,next.end);credential=credential||next.credential;
    }
    output+=value.slice(cursor,span.start)+(credential?'[REDACTED]':'');cursor=end;
  }
  return (output+value.slice(cursor)).slice(0,MAX_OUTPUT_CHARS);
}
