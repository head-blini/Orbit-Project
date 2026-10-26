import {parseSequence,validateSequence} from './sequence.ts';
import type {SequenceDiagram} from '../../shared/sequence.ts';

// Intentionally a small, inert flowchart grammar; not the full Mermaid language.
const identifier = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const forbidden = /[<>"\\\r\n\x00-\x1f\x7f]|[a-z][a-z0-9+.-]*:|\/\/|www\.|&(?:#\w+|\w+);|#(?:x[0-9a-f]+|\d+);|%[0-9a-f]{2}/i;
const labelOK = (value:unknown):value is string => typeof value==='string' && value.trim().length>0 && value.length<=160 && !forbidden.test(value) && !/[\[\]{}|`]/.test(value);
const object = (value:unknown):value is Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value);
const keys = (value:Record<string,unknown>, allowed:string[]) => Object.keys(value).every(k=>allowed.includes(k));

export function validateArchitecture(value:unknown): {ok:boolean; issues:{code:string;line?:number}[]} {
  const invalid=()=>({ok:false,issues:[{code:'INVALID_ARCHITECTURE'}]});
  if(!object(value) || !keys(value,['nodes','edges']) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length<1 || value.nodes.length>100 || value.edges.length>300) return invalid();
  const ids=new Set<string>();
  for(const node of value.nodes) {
    if(!object(node) || !keys(node,['id','label','kind']) || typeof node.id!=='string' || !identifier.test(node.id) || ids.has(node.id) || !labelOK(node.label) || !labelOK(node.kind)) return invalid();
    ids.add(node.id);
  }
  for(const edge of value.edges) {
    if(!object(edge) || !keys(edge,['from','to','label']) || typeof edge.from!=='string' || typeof edge.to!=='string' || !ids.has(edge.from) || !ids.has(edge.to) || (edge.label!==undefined && !labelOK(edge.label))) return invalid();
  }
  return {ok:true,issues:[]};
}

export function generateArchitectureMermaid(graph:{nodes:{id:string;label:string;kind:string}[];edges:{from:string;to:string;label?:string}[]}):string {
  if(!validateArchitecture(graph).ok) throw new Error('INVALID_ARCHITECTURE');
  // Generated identifiers avoid Mermaid reserved words (e.g. end, subgraph).
  const ids=new Map(graph.nodes.map((node,index)=>[node.id,`n${index}`]));
  return ['flowchart TD',...graph.nodes.map(node=>`  ${ids.get(node.id)}["${node.label}"]`),...graph.edges.map(edge=>`  ${ids.get(edge.from)} -->${edge.label?`|${edge.label}|`:''} ${ids.get(edge.to)}`)].join('\n');
}

function parse(source:string) {
  const nodes:{id:string;label:string;kind:string}[]=[];
  const edges:{from:string;to:string;label?:string}[]=[];
  const issues:{code:string;line?:number}[]=[];
  if(typeof source!=='string' || new TextEncoder().encode(source).length>256*1024) return {nodes,edges,issues:[{code:'SOURCE_TOO_LARGE_OR_INVALID'}],direction:'TD'};
  const lines=source.replace(/\r\n/g,'\n').split('\n');
  let header=false, direction='TD';
  const edgeLines:number[]=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i].trim();if(!line) continue;
    if(!header) {
      const match=/^flowchart (TD|LR)$/.exec(line);
      if(!match) return {nodes,edges,issues:[{code:'UNSUPPORTED_HEADER',line:i+1}],direction};
      direction=match[1];header=true;continue;
    }
    const node=/^([A-Za-z][A-Za-z0-9_]{0,63})\["([^"\r\n]*)"\]$/.exec(line);
    const edge=/^([A-Za-z][A-Za-z0-9_]{0,63}) -->\s*(?:\|([^|]*)\| )?([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(line);
    if(node && labelOK(node[2]) && !['end','subgraph'].includes(node[1])) nodes.push({id:node[1],label:node[2],kind:'component'});
    else if(edge && (edge[2]===undefined || labelOK(edge[2]))) {edges.push({from:edge[1],to:edge[3],...(edge[2]!==undefined?{label:edge[2]}:{})});edgeLines.push(i+1);}
    else issues.push({code:'UNSUPPORTED_OR_UNSAFE_SYNTAX',line:i+1});
  }
  if(!header || !validateArchitecture({nodes,edges}).ok) issues.push({code:'INVALID_GRAPH'});
  const ids=new Set(nodes.map(n=>n.id));
  edges.forEach((e,i)=>{if(!ids.has(e.from)||!ids.has(e.to))issues.push({code:'UNKNOWN_ENDPOINT',line:edgeLines[i]});});
  return {nodes,edges,issues,direction};
}

export function validateMermaid(source:string):{ok:boolean;issues:{code:string;line?:number}[]} {
  if(sequenceHeader(source))return validateSequence(source);
  const {issues}=parse(source);return {ok:issues.length===0,issues};
}

export function parseMermaid(source:string) {
  const {nodes,edges,issues,direction}=parse(source);
  if(issues.length) throw new Error('INVALID_MERMAID');
  return {nodes,edges,direction};
}

function sequenceHeader(source:string):boolean {
  return typeof source==='string'&&source.length<=256*1024&&source.replace(/\r\n/g,'\n').split('\n').find(line=>line.trim())?.trim()==='sequenceDiagram';
}

/** Additive dispatch preserves parseMermaid's exact legacy flowchart shape. */
export function parseMermaidDocument(source:string):{kind:'flowchart';graph:ReturnType<typeof parseMermaid>}|SequenceDiagram {
  return sequenceHeader(source)?parseSequence(source):{kind:'flowchart',graph:parseMermaid(source)};
}
