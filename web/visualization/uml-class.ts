import {CLASS_LIMITS} from '../../shared/uml-class.ts';
import type {ClassAnnotation,ClassDiagram,ClassNode,ClassRelationship,ClassRelationshipKind} from '../../shared/uml-class.ts';

type Issue={code:string;line?:number};
type Result={ok:boolean;issues:Issue[]};
const identifier=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const reserved=new Set(['classdiagram','class','classdef','style','cssclass','click','link','callback','namespace','note','direction','acctitle','accdescr']);
const validId=(value:unknown):value is string=>typeof value==='string'&&identifier.test(value)&&!reserved.has(value.toLowerCase());
const annotations=new Set(['interface','abstract','enumeration']);
const relationshipKinds=new Set(['inheritance','composition','aggregation','association','dependency','realization','solid-link','dashed-link']);
const trim=(value:string)=>value.replace(/^[ \t]+|[ \t]+$/g,'');

/** Direct model callers may supply only inert JSON data, never accessor hooks. */
function record(value:unknown,fields:readonly string[]):value is Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)return false;
  const keys=Reflect.ownKeys(value);
  return keys.length===fields.length&&keys.every(key=>{
    if(typeof key!=='string'||!fields.includes(key))return false;
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    return Object.hasOwn(descriptor,'value')&&descriptor.enumerable===true;
  });
}
function denseArray(value:unknown,maximum:number):value is unknown[] {
  if(!Array.isArray(value)||value.length>maximum||Reflect.ownKeys(value).length!==value.length+1)return false;
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Array.prototype)return false;
  for(let index=0;index<value.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)return false;
  }
  return true;
}

// Match the C4 Unicode boundary: retain real graphemes, including joiners, but
// reject hidden format controls (including emoji tag sequences) before trimming.
const formatControl=/\p{Cf}/u;
function characters(value:string,source=false):boolean {
  for(const character of value){
    const code=character.codePointAt(0)!;
    if(code!==0x200c&&code!==0x200d&&formatControl.test(character))return false;
    if(source&&(code===9||code===10))continue;
    if(code===0x2028||code===0x2029||!((code>=32&&code<=0xd7ff)||(code>=0xe000&&code<=0xfffd)||(code>=0x10000&&code<=0x10ffff))||(code>=0x7f&&code<=0x9f))return false;
  }
  return true;
}
const unsafeText=/[<>`\\{};]|&(?:#\w+|\w+);|#(?:x[0-9a-f]+|\d+);|%[0-9a-f]{2}|%%/i;
// A generic `word:` URI test would incorrectly reject ordinary typed members.
// These known URI forms are unsupported; all other colons remain inert text.
const uri=/[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.|\b(?:javascript|vbscript|data|file|mailto|tel):/i;
function inertText(value:unknown,maximum:number):value is string {
  return typeof value==='string'&&value.length<=maximum*2&&value.length>0&&trim(value)===value&&value.trim().length>0
    &&Array.from(value).length<=maximum&&characters(value)&&!unsafeText.test(value)&&/[\p{L}\p{N}\p{P}\p{S}]/u.test(value);
}
function text(value:unknown,maximum:number):value is string {return inertText(value,maximum)&&!uri.test(value);}
function name(value:unknown):value is string {return text(value,CLASS_LIMITS.name)&&!value.includes('"');}

// Only complete, simple typed fields/parameter lists disambiguate data/file from
// URI schemes. Other text surfaces retain the strict URI rule. A type consists
// of one identifier and optional [] pairs; defaults/unions/generics are outside
// this exception. The original displayed member is never rewritten.
const typedMember=/^([\p{L}_][\p{L}\p{M}\p{N}_\u200c\u200d]*)[ \t]*:[ \t]*[\p{L}_][\p{L}\p{M}\p{N}_\u200c\u200d]*(?:\[\])*$/u;
function dataFileMember(value:string):boolean {
  const match=typedMember.exec(trim(value));return !!match&&/^(?:data|file)$/i.test(match[1]);
}
function memberUri(body:string,opening:number,closing:number):boolean {
  if(opening===-1)return !dataFileMember(body)&&uri.test(body);
  const parameters=body.slice(opening+1,closing).split(',');
  if(!parameters.every(parameter=>typedMember.test(trim(parameter))))return uri.test(body);
  const checked=parameters.map(parameter=>dataFileMember(parameter)?'typedParameter':parameter).join(',');
  return uri.test(body.slice(0,opening+1)+checked+body.slice(closing));
}

/** Display-only members: no language evaluation, generic expansion or modifiers. */
function memberKind(value:unknown):'attribute'|'operation'|null {
  if(!inertText(value,CLASS_LIMITS.text)||/[\*$]$/.test(value))return null;
  const body=trim(/^[+\-#~]/.test(value)?value.slice(1):value);
  // Keywords followed by a command argument are unsupported. A type colon or
  // method parenthesis instead names an inert member (including `style ()`).
  const command=/^(?:class|classDef|namespace|direction|note|click|link|callback|style|cssClass|accTitle|accDescr)[ \t]+[^ \t:(]/;
  if(!body||/^[+\-#~]/.test(body)||body.includes('~')||/\$/.test(body)||command.test(body))return null;
  const opening=body.indexOf('('),closing=body.indexOf(')');
  if(opening===-1&&closing===-1)return memberUri(body,opening,closing)?null:'attribute';
  if(opening<=0||closing<opening||body.indexOf('(',opening+1)!==-1||body.indexOf(')',closing+1)!==-1||!trim(body.slice(0,opening)))return null;
  return memberUri(body,opening,closing)?null:'operation';
}
function multiplicity(value:unknown):value is string|null {
  if(value===null||value==='*')return true;
  if(typeof value!=='string'||value.length>8)return false;
  const match=/^(0|[1-9]\d{0,2})(?:\.\.(\*|0|[1-9]\d{0,2}))?$/.exec(value);
  return !!match&&Number(match[1])<=CLASS_LIMITS.multiplicity&&(match[2]===undefined||match[2]==='*'||Number(match[2])>=Number(match[1])&&Number(match[2])<=CLASS_LIMITS.multiplicity);
}
function relationIdentity(value:ClassRelationship):string {
  const from=[value.from,value.fromMultiplicity],to=[value.to,value.toMultiplicity];
  if((value.kind==='solid-link'||value.kind==='dashed-link')&&value.from>value.to)return JSON.stringify([value.kind,to,from,value.label]);
  return JSON.stringify([value.kind,from,to,value.label]);
}

function inspectModel(value:unknown):boolean {
  if(!record(value,['kind','classes','relationships'])||value.kind!=='class'||!denseArray(value.classes,CLASS_LIMITS.classes)||value.classes.length<1||!denseArray(value.relationships,CLASS_LIMITS.relationships))return false;
  const ids=new Set<string>();let total=0;
  for(let index=0;index<value.classes.length;index++){
    const node=value.classes[index];
    if(!record(node,['id','name','annotation','attributes','operations'])||!validId(node.id)||ids.has(node.id)||!name(node.name)
      ||node.annotation!==null&&(typeof node.annotation!=='string'||!annotations.has(node.annotation))
      ||!denseArray(node.attributes,CLASS_LIMITS.membersPerClass)||!denseArray(node.operations,CLASS_LIMITS.membersPerClass))return false;
    const count=node.attributes.length+node.operations.length;total+=count;
    if(count>CLASS_LIMITS.membersPerClass||total>CLASS_LIMITS.members)return false;
    for(let member=0;member<node.attributes.length;member++)if(memberKind(node.attributes[member])!=='attribute')return false;
    for(let member=0;member<node.operations.length;member++)if(memberKind(node.operations[member])!=='operation')return false;
    ids.add(node.id);
  }
  const relationshipIds=new Set<string>(),relations=new Set<string>();
  for(let index=0;index<value.relationships.length;index++){
    const relation=value.relationships[index];
    if(!record(relation,['id','kind','from','to','fromMultiplicity','toMultiplicity','label'])||!validId(relation.id)||relationshipIds.has(relation.id)
      ||typeof relation.kind!=='string'||!relationshipKinds.has(relation.kind)||!validId(relation.from)||!validId(relation.to)
      ||!ids.has(relation.from)||!ids.has(relation.to)||relation.from===relation.to||!multiplicity(relation.fromMultiplicity)||!multiplicity(relation.toMultiplicity)
      ||relation.label!==null&&!text(relation.label,CLASS_LIMITS.text))return false;
    const identity=relationIdentity(relation as unknown as ClassRelationship);
    if(relations.has(identity))return false;
    relationshipIds.add(relation.id);relations.add(identity);
  }
  return true;
}

export function validateClassModel(value:unknown):boolean {
  try{return inspectModel(value);}catch{return false;}
}

const arrows:Record<string,{kind:ClassRelationshipKind;reverse:boolean}>={
  '<|--':{kind:'inheritance',reverse:true},'--|>':{kind:'inheritance',reverse:false},
  '*--':{kind:'composition',reverse:false},'--*':{kind:'composition',reverse:true},
  'o--':{kind:'aggregation',reverse:false},'--o':{kind:'aggregation',reverse:true},
  '-->':{kind:'association',reverse:false},'<--':{kind:'association',reverse:true},
  '..>':{kind:'dependency',reverse:false},'<..':{kind:'dependency',reverse:true},
  '..|>':{kind:'realization',reverse:false},'<|..':{kind:'realization',reverse:true},
  '--':{kind:'solid-link',reverse:false},'..':{kind:'dashed-link',reverse:false}
};
function parse(source:string):{diagram:ClassDiagram;issues:Issue[]} {
  const diagram:ClassDiagram={kind:'class',classes:[],relationships:[]},issues:Issue[]=[];
  const add=(code:string,line?:number)=>{if(issues.length<CLASS_LIMITS.issues)issues.push({code,...(line===undefined?{}:{line})});};
  if(typeof source!=='string'||source.length>CLASS_LIMITS.sourceBytes||new TextEncoder().encode(source).length>CLASS_LIMITS.sourceBytes){add('SOURCE_TOO_LARGE_OR_INVALID');return {diagram,issues};}
  const normalized=source.replace(/\r\n/g,'\n');
  if(!characters(normalized,true)){add('UNSUPPORTED_OR_UNSAFE_SYNTAX');return {diagram,issues};}
  const lines=normalized.split('\n');
  if(lines.length>CLASS_LIMITS.lines){add('TOO_MANY_LINES');return {diagram,issues};}
  const ids=new Set<string>(),relations=new Set<string>();
  let header=false,relationships=false,current:ClassNode|null=null,total=0;
  for(let index=0;index<lines.length;index++){
    const line=index+1,value=trim(lines[index]);if(!value)continue;
    if(!header){if(value!=='classDiagram'){add('UNSUPPORTED_HEADER',line);return {diagram,issues};}header=true;continue;}
    if(current){
      if(value==='}'){current=null;continue;}
      const annotation=/^<<(interface|abstract|enumeration)>>$/.exec(value);
      if(annotation){if(current.annotation!==null)add('DUPLICATE_ANNOTATION',line);else current.annotation=annotation[1] as ClassAnnotation;continue;}
      const kind=memberKind(value);
      if(kind===null){add('UNSUPPORTED_OR_UNSAFE_SYNTAX',line);continue;}
      if(current.attributes.length+current.operations.length>=CLASS_LIMITS.membersPerClass||total>=CLASS_LIMITS.members){add('TOO_MANY_MEMBERS',line);break;}
      current[kind==='attribute'?'attributes':'operations'].push(value);total++;continue;
    }
    const declaration=/^class[ \t]+([A-Za-z][A-Za-z0-9_]{0,63})(?:\["([^"\r\n]*)"\])?[ \t]*(\{)?$/.exec(value);
    if(declaration){
      if(relationships){add('LATE_DECLARATION',line);continue;}
      if(diagram.classes.length>=CLASS_LIMITS.classes){add('TOO_MANY_CLASSES',line);break;}
      const id=declaration[1],label=declaration[2]===undefined?id:trim(declaration[2]);
      if(!validId(id)||ids.has(id)||!name(label)){add('INVALID_CLASS',line);continue;}
      const node:ClassNode={id,name:label,annotation:null,attributes:[],operations:[]};
      diagram.classes.push(node);ids.add(id);if(declaration[3])current=node;continue;
    }
    const relation=/^([A-Za-z][A-Za-z0-9_]{0,63})[ \t]*(?:"([^"\r\n]*)"[ \t]*)?(<\|--|--\|>|\*--|--\*|o--|--o|-->|<--|\.\.\|>|<\|\.\.|\.\.>|<\.\.|--|\.\.)[ \t]*(?:"([^"\r\n]*)"[ \t]*)?([A-Za-z][A-Za-z0-9_]{0,63})(?:[ \t]*:[ \t]*(.*))?$/.exec(value);
    if(!relation){add('UNSUPPORTED_OR_UNSAFE_SYNTAX',line);continue;}
    relationships=true;
    if(diagram.relationships.length>=CLASS_LIMITS.relationships){add('TOO_MANY_RELATIONSHIPS',line);break;}
    const left=relation[1],right=relation[5],leftMultiplicity=relation[2]??null,rightMultiplicity=relation[4]??null,label=relation[6]===undefined?null:trim(relation[6]);
    if(!ids.has(left)||!ids.has(right)||left===right||!multiplicity(leftMultiplicity)||!multiplicity(rightMultiplicity)||label!==null&&!text(label,CLASS_LIMITS.text)){add('INVALID_RELATIONSHIP',line);continue;}
    const {kind,reverse}=arrows[relation[3]];
    const relationship:ClassRelationship={id:`r${diagram.relationships.length+1}`,kind,from:reverse?right:left,to:reverse?left:right,
      fromMultiplicity:reverse?rightMultiplicity:leftMultiplicity,toMultiplicity:reverse?leftMultiplicity:rightMultiplicity,label};
    const identity=relationIdentity(relationship);
    if(relations.has(identity)){add('DUPLICATE_RELATIONSHIP',line);continue;}
    relations.add(identity);diagram.relationships.push(relationship);
  }
  if(!header)add('UNSUPPORTED_HEADER');
  if(current)add('UNCLOSED_CLASS');
  if(!validateClassModel(diagram))add('INVALID_CLASS_MODEL');
  return {diagram,issues};
}

export function validateClassDiagram(source:string):Result {
  try{const {issues}=parse(source);return {ok:issues.length===0,issues};}catch{return {ok:false,issues:[{code:'INVALID_CLASS_DIAGRAM'}]};}
}
export function parseClassDiagram(source:string):ClassDiagram {
  try{const {diagram,issues}=parse(source);if(issues.length)throw new Error();return diagram;}catch{throw new Error('INVALID_CLASS_DIAGRAM');}
}
