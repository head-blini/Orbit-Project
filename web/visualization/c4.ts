import {C4_LIMITS} from '../../shared/c4.ts';
import type {C4Diagram,C4Element,C4Relationship} from '../../shared/c4.ts';

type Issue={code:string;field?:string};
type Result={ok:boolean;issues:Issue[]};
const identifier=/^[A-Za-z][A-Za-z0-9_-]*$/;
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length<=C4_LIMITS.id&&identifier.test(value);
const elementKinds=new Set(['person','system','container','component']);
const views=new Set(['context','container','component']);

/** Direct AST callers must supply inert JSON data, including no accessor hooks. */
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
  if(prototype!==Array.prototype&&prototype!==null)return false;
  for(let index=0;index<value.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)return false;
  }
  return true;
}

// These are displayed as plain text, never interpreted as markup, URIs or DSL.
// ZWJ/ZWNJ and combining marks remain available for genuine Unicode graphemes.
// All other Unicode format controls are rejected, including emoji tag sequences;
// ordinary emoji, variation selectors and regional-indicator flags remain valid.
const hidden=/[\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const formatControl=/\p{Cf}/u;
const unsafe=/[<>`\\]|[a-z][a-z0-9+.-]*:|\/\/|www\.|&(?:#\w+|\w+);|#(?:x[0-9a-f]+|\d+);|%[0-9a-f]{2}|%%/i;
function text(value:unknown,maximum:number):value is string {
  if(typeof value!=='string'||value.length>maximum*2||value.trim().length===0||Array.from(value).length>maximum||hidden.test(value)||unsafe.test(value)||!/[\p{L}\p{N}\p{P}\p{S}]/u.test(value))return false;
  for(const character of value){
    const n=character.codePointAt(0)!;
    if(n!==0x200c&&n!==0x200d&&formatControl.test(character))return false;
    if(!((n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff))||(n>=0x7f&&n<=0x9f))return false;
  }
  return true;
}

function inspect(value:unknown):Result {
  const issues:Issue[]=[];
  const add=(code:string,field?:string)=>{if(issues.length<C4_LIMITS.issues)issues.push({code,...(field===undefined?{}:{field})});};
  const result=():Result=>({ok:issues.length===0,issues});
  if(!record(value,['format','title','view','scope','elements','relationships']))return {ok:false,issues:[{code:'INVALID_C4'}]};
  if(value.format!=='c4-v1')add('INVALID_FORMAT','format');
  if(!text(value.title,C4_LIMITS.name))add('INVALID_TEXT','title');
  if(typeof value.view!=='string'||!views.has(value.view))add('INVALID_VIEW','view');
  if(!validId(value.scope))add('INVALID_SCOPE','scope');
  if(!denseArray(value.elements,C4_LIMITS.elements)||value.elements.length===0)add('INVALID_ELEMENTS','elements');
  if(!denseArray(value.relationships,C4_LIMITS.relationships))add('INVALID_RELATIONSHIPS','relationships');
  if(issues.length)return result();

  const diagram=value as unknown as C4Diagram;
  const elements=new Map<string,C4Element>(),ids=new Set<string>();
  for(let index=0;index<diagram.elements.length;index++){
    const element:unknown=diagram.elements[index],field=`elements.${index}`;
    if(!record(element,['id','kind','name','description','parentId','technology'])){add('INVALID_ELEMENT',field);continue;}
    const before=issues.length;
    if(!validId(element.id))add('INVALID_ID',field+'.id');
    else if(ids.has(element.id))add('DUPLICATE_ID',field+'.id');
    else ids.add(element.id);
    if(typeof element.kind!=='string'||!elementKinds.has(element.kind))add('INVALID_KIND',field+'.kind');
    if(!text(element.name,C4_LIMITS.name))add('INVALID_TEXT',field+'.name');
    if(!text(element.description,C4_LIMITS.description))add('INVALID_TEXT',field+'.description');
    if(element.kind==='person'||element.kind==='system'){
      if(element.parentId!==null)add('INVALID_PARENT',field+'.parentId');
      if(element.technology!==null)add('INVALID_TECHNOLOGY',field+'.technology');
    }else{
      if(!validId(element.parentId))add('INVALID_PARENT',field+'.parentId');
      if(!text(element.technology,C4_LIMITS.technology))add('INVALID_TECHNOLOGY',field+'.technology');
    }
    if(issues.length===before)elements.set(element.id as string,element as unknown as C4Element);
  }
  for(let index=0;index<diagram.relationships.length;index++){
    const relationship:unknown=diagram.relationships[index],field=`relationships.${index}`;
    if(!record(relationship,['id','from','to','description','technology'])){add('INVALID_RELATIONSHIP',field);continue;}
    if(!validId(relationship.id))add('INVALID_ID',field+'.id');
    else if(ids.has(relationship.id))add('DUPLICATE_ID',field+'.id');
    else ids.add(relationship.id);
    if(!validId(relationship.from))add('INVALID_ID',field+'.from');
    if(!validId(relationship.to))add('INVALID_ID',field+'.to');
    if(!text(relationship.description,C4_LIMITS.description))add('INVALID_TEXT',field+'.description');
    if(relationship.technology!==null&&!text(relationship.technology,C4_LIMITS.technology))add('INVALID_TECHNOLOGY',field+'.technology');
  }
  if(issues.length)return result();

  for(let index=0;index<diagram.elements.length;index++){
    const element=diagram.elements[index];
    if(element.parentId===null)continue;
    const parent=elements.get(element.parentId);
    if(!parent||parent.kind!==(element.kind==='container'?'system':'container'))add('INVALID_PARENT',`elements.${index}.parentId`);
  }
  const scope=elements.get(diagram.scope);
  if(!scope||scope.kind!==(diagram.view==='component'?'container':'system'))add('INVALID_SCOPE','scope');
  if(issues.length||!scope)return result();

  const boundaries=new Set<string>();
  if(diagram.view==='container')boundaries.add(scope.id);
  if(diagram.view==='component'){boundaries.add(scope.id);boundaries.add(scope.parentId!);}
  let primary=0;
  for(let index=0;index<diagram.elements.length;index++){
    const element=diagram.elements[index];
    if(element.kind==='person'||element.kind==='system')continue;
    if(diagram.view==='context')add('OUT_OF_SCOPE',`elements.${index}`);
    else if(diagram.view==='container'){
      if(element.kind!=='container'||element.parentId!==scope.id)add('OUT_OF_SCOPE',`elements.${index}`);
      else primary++;
    }else if(element.kind==='container'){
      // Sibling containers remain in the outer system, outside the expanded
      // scope container. They are visible leaves and may have relationships.
      if(element.parentId!==scope.parentId)add('OUT_OF_SCOPE',`elements.${index}`);
    }else if(element.parentId!==scope.id)add('OUT_OF_SCOPE',`elements.${index}`);
    else primary++;
  }
  if(diagram.view!=='context'&&primary===0)add('EMPTY_SCOPE','scope');

  const relationships=new Set<string>();
  for(let index=0;index<diagram.relationships.length;index++){
    const relationship:C4Relationship=diagram.relationships[index],field=`relationships.${index}`;
    const from=elements.get(relationship.from),to=elements.get(relationship.to);
    if(!from)add('UNKNOWN_REFERENCE',field+'.from');
    if(!to)add('UNKNOWN_REFERENCE',field+'.to');
    if(relationship.from===relationship.to)add('SELF_RELATIONSHIP',field);
    if(boundaries.has(relationship.from)||boundaries.has(relationship.to))add('BOUNDARY_ENDPOINT',field);
    if(from?.kind==='container'&&to?.kind==='container'&&relationship.technology===null)add('INVALID_TECHNOLOGY',field+'.technology');
    const identity=JSON.stringify([relationship.from,relationship.to,relationship.description,relationship.technology]);
    if(relationships.has(identity))add('DUPLICATE_RELATIONSHIP',field);
    else relationships.add(identity);
  }
  // Field/count checks bound direct-object work before serialization. This is
  // independent of parseC4's byte guard on the original, possibly padded JSON.
  if(!issues.length&&new TextEncoder().encode(JSON.stringify(diagram)).length>C4_LIMITS.sourceBytes)add('SOURCE_TOO_LARGE');
  return result();
}

export function validateC4(value:unknown):Result {
  try{return inspect(value);}catch{return {ok:false,issues:[{code:'INVALID_C4'}]};}
}

export function parseC4(source:string):C4Diagram {
  try{
    if(typeof source!=='string'||source.length>C4_LIMITS.sourceBytes||new TextEncoder().encode(source).length>C4_LIMITS.sourceBytes)throw new Error();
    const value:unknown=JSON.parse(source);
    if(!validateC4(value).ok)throw new Error();
    return value as C4Diagram;
  }catch{throw new Error('INVALID_C4');}
}
