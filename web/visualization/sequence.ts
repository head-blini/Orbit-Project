import {SEQUENCE_LIMITS} from '../../shared/sequence.ts';
import type {SequenceDiagram,SequenceEvent} from '../../shared/sequence.ts';

type Issue={code:string;line?:number};
type StructuralIssue={code:string;event?:number};
const identifier=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const reserved=new Set(['sequencediagram','participant','actor','as','autonumber','off','activate','deactivate','note','left','right','of','over','alt','else','loop','opt','par','and','end','create','destroy','rect','critical','option','break','box','link','links','properties','details']);
const validId=(value:unknown):value is string=>typeof value==='string'&&identifier.test(value)&&!reserved.has(value.toLowerCase());
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,fields:readonly string[])=>{
  const keys=Reflect.ownKeys(value);
  return keys.length===fields.length&&keys.every(key=>typeof key==='string'&&fields.includes(key));
};
const denseArray=(value:unknown,maximum:number):value is unknown[]=>Array.isArray(value)&&value.length<=maximum
  &&Reflect.ownKeys(value).length===value.length+1&&Array.from({length:value.length},(_,index)=>Object.hasOwn(value,index)).every(Boolean);

function xmlCharacters(value:string,source=false):boolean {
  for(const character of value){
    const n=character.codePointAt(0)!;
    if(source&&(n===9||n===10))continue;
    if(!((n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff))||(n>=0x7f&&n<=0x9f))return false;
  }
  return true;
}

// Sequence labels are unquoted Mermaid text: semicolons and comment markers are
// syntax even when a local SVG renderer would display them as harmless text.
const unsafeText=/[<>"\\[\]{}|`;#]|%%|[a-z][a-z0-9+.-]*:|\/\/|www\.|%[0-9a-f]{2}/i;
function validText(value:unknown,empty=false):value is string {
  return typeof value==='string'&&(empty?value===''||value.trim().length>0:value.trim().length>0)
    &&Array.from(value).length<=SEQUENCE_LIMITS.text&&xmlCharacters(value)&&!unsafeText.test(value);
}

/** The same semantic checks protect source parsing and callers supplying an AST. */
function inspectDiagram(value:unknown):StructuralIssue|null {
  const bad=(code='INVALID_SEQUENCE',event?:number):StructuralIssue=>({code,...(event===undefined?{}:{event})});
  if(!object(value)||!exact(value,['kind','participants','autonumber','events'])||value.kind!=='sequence'||typeof value.autonumber!=='boolean'||!denseArray(value.participants,SEQUENCE_LIMITS.participants)||!denseArray(value.events,SEQUENCE_LIMITS.events))return bad();
  if(value.participants.length<1||value.participants.length>SEQUENCE_LIMITS.participants)return bad('INVALID_PARTICIPANTS');
  if(value.events.length>SEQUENCE_LIMITS.events)return bad('TOO_MANY_EVENTS');
  const participants=new Set<string>();
  for(const participant of value.participants){
    if(!object(participant)||!exact(participant,['id','label','kind'])||!validId(participant.id)||participants.has(participant.id)||!validText(participant.label)||(participant.kind!=='participant'&&participant.kind!=='actor'))return bad('INVALID_PARTICIPANTS');
    participants.add(participant.id);
  }
  const reference=(id:unknown):id is string=>typeof id==='string'&&participants.has(id);
  const activation=new Map<string,number>();
  const stack:{id:string;kind:string}[]=[];
  const fragments=new Set<string>();
  let notes=0,useful=0;
  for(let index=0;index<value.events.length;index++){
    const event:unknown=value.events[index];
    if(!object(event))return bad('INVALID_EVENT',index);
    switch(event.type){
      case 'message':
        if(!exact(event,['type','from','to','arrow','text'])||!validText(event.text)||(event.arrow!=='solid'&&event.arrow!=='dashed'))return bad('INVALID_EVENT',index);
        if(!reference(event.from)||!reference(event.to))return bad('UNKNOWN_PARTICIPANT',index);
        useful++;
        break;
      case 'note':
        if(!exact(event,['type','placement','participants','text'])||!validText(event.text)||(event.placement!=='left'&&event.placement!=='right'&&event.placement!=='over')||!denseArray(event.participants,2)||event.participants.length<1||(event.placement!=='over'&&event.participants.length!==1)||new Set(event.participants).size!==event.participants.length)return bad('INVALID_EVENT',index);
        if(!event.participants.every(reference))return bad('UNKNOWN_PARTICIPANT',index);
        if(++notes>SEQUENCE_LIMITS.notes)return bad('TOO_MANY_NOTES',index);
        useful++;
        break;
      case 'activation':{
        if(!exact(event,['type','participant','action'])||(event.action!=='activate'&&event.action!=='deactivate'))return bad('INVALID_EVENT',index);
        if(!reference(event.participant))return bad('UNKNOWN_PARTICIPANT',index);
        const depth=(activation.get(event.participant)??0)+(event.action==='activate'?1:-1);
        if(depth<0||depth>SEQUENCE_LIMITS.activationDepth)return bad('INVALID_ACTIVATION',index);
        activation.set(event.participant,depth);
        break;
      }
      case 'fragment-start':
        if(!exact(event,['type','id','kind','text'])||!validId(event.id)||(event.kind!=='alt'&&event.kind!=='opt'&&event.kind!=='loop'&&event.kind!=='par')||!validText(event.text)||fragments.has(event.id))return bad('INVALID_FRAGMENT',index);
        if(fragments.size>=SEQUENCE_LIMITS.fragments||stack.length>=SEQUENCE_LIMITS.depth)return bad('FRAGMENT_LIMIT_EXCEEDED',index);
        fragments.add(event.id);stack.push({id:event.id,kind:event.kind});
        break;
      case 'fragment-branch':{
        const parent=stack.at(-1);
        if(!exact(event,['type','id','kind','text'])||!parent||event.id!==parent.id||!validText(event.text,true)||!((event.kind==='else'&&parent.kind==='alt')||(event.kind==='and'&&parent.kind==='par')))return bad('INVALID_FRAGMENT',index);
        break;
      }
      case 'fragment-end':
        if(!exact(event,['type','id'])||!stack.length||event.id!==stack.at(-1)!.id)return bad('INVALID_FRAGMENT',index);
        stack.pop();
        break;
      default:return bad('INVALID_EVENT',index);
    }
  }
  if(stack.length)return bad('UNCLOSED_FRAGMENT');
  if([...activation.values()].some(depth=>depth!==0))return bad('UNCLOSED_ACTIVATION');
  return useful>0?null:bad('EMPTY_SEQUENCE');
}

export function validateSequenceDiagram(value:unknown):boolean {
  try{return inspectDiagram(value)===null;}catch{return false;}
}

function parse(source:string):{diagram:SequenceDiagram;issues:Issue[]} {
  const diagram:SequenceDiagram={kind:'sequence',participants:[],autonumber:false,events:[]};
  const issues:Issue[]=[];
  const issue=(code:string,line?:number)=>{if(issues.length<SEQUENCE_LIMITS.issues)issues.push({code,...(line===undefined?{}:{line})});};
  if(typeof source!=='string'||source.length>SEQUENCE_LIMITS.sourceBytes||new TextEncoder().encode(source).length>SEQUENCE_LIMITS.sourceBytes){issue('SOURCE_TOO_LARGE_OR_INVALID');return {diagram,issues};}
  const normalized=source.replace(/\r\n/g,'\n');
  if(!xmlCharacters(normalized,true)){issue('UNSUPPORTED_OR_UNSAFE_SYNTAX');return {diagram,issues};}
  const lines=normalized.split('\n');
  if(lines.length>SEQUENCE_LIMITS.lines){issue('TOO_MANY_LINES');return {diagram,issues};}
  let header=false,body=false,numbered=false,fragmentCount=0;
  const stack:{id:string;kind:string}[]=[];
  const eventLines:number[]=[];
  const append=(line:number,...events:SequenceEvent[])=>{
    if(diagram.events.length+events.length>SEQUENCE_LIMITS.events){issue('TOO_MANY_EVENTS',line);return false;}
    diagram.events.push(...events);eventLines.push(...events.map(()=>line));return true;
  };
  for(let index=0;index<lines.length;index++){
    const text=lines[index].trim(),line=index+1;
    if(!text)continue;
    if(!header){
      if(text!=='sequenceDiagram'){issue('UNSUPPORTED_HEADER',line);return {diagram,issues};}
      header=true;continue;
    }
    const participant=/^(participant|actor)[ \t]+([A-Za-z][A-Za-z0-9_]{0,63})(?:[ \t]+as[ \t]+(.+))?$/.exec(text);
    if(participant){
      if(body){issue('LATE_PARTICIPANT',line);continue;}
      if(diagram.participants.length>=SEQUENCE_LIMITS.participants){issue('INVALID_PARTICIPANTS',line);break;}
      const id=participant[2],label=participant[3]?.trim()??id;
      if(!validId(id)||!validText(label)||diagram.participants.some(value=>value.id===id)){issue('INVALID_PARTICIPANTS',line);continue;}
      diagram.participants.push({id,label,kind:participant[1] as 'participant'|'actor'});continue;
    }
    if(text==='autonumber'){
      if(body||numbered)issue('INVALID_AUTONUMBER',line);
      else{numbered=true;diagram.autonumber=true;}
      continue;
    }
    body=true;
    const message=/^([A-Za-z][A-Za-z0-9_]{0,63})[ \t]*(-->>|->>)[ \t]*([+-]?)[ \t]*([A-Za-z][A-Za-z0-9_]{0,63})[ \t]*:[ \t]*(.*)$/.exec(text);
    if(message){
      const from=message[1],to=message[4];
      const events:SequenceEvent[]=[{type:'message',from,to,arrow:message[2]==='->>'?'solid':'dashed',text:message[5].trim()}];
      // Mermaid '+' activates the recipient; '-' deactivates the sender, after
      // the message. Normalized adjacent activation events share that boundary.
      if(message[3])events.push({type:'activation',participant:message[3]==='+'?to:from,action:message[3]==='+'?'activate':'deactivate'});
      if(!append(line,...events))break;
      continue;
    }
    const note=/^(?:Note|note)[ \t]+(left[ \t]+of|right[ \t]+of|over)[ \t]+([A-Za-z][A-Za-z0-9_]{0,63})(?:[ \t]*,[ \t]*([A-Za-z][A-Za-z0-9_]{0,63}))?[ \t]*:[ \t]*(.*)$/.exec(text);
    if(note){
      if(!append(line,{type:'note',placement:note[1]==='over'?'over':note[1].startsWith('left')?'left':'right',participants:note[3]?[note[2],note[3]]:[note[2]],text:note[4].trim()}))break;
      continue;
    }
    const activation=/^(activate|deactivate)[ \t]+([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(text);
    if(activation){if(!append(line,{type:'activation',participant:activation[2],action:activation[1] as 'activate'|'deactivate'}))break;continue;}
    const fragment=/^(alt|opt|loop|par)[ \t]+(.+)$/.exec(text);
    if(fragment){
      if(fragmentCount>=SEQUENCE_LIMITS.fragments||stack.length>=SEQUENCE_LIMITS.depth){issue('FRAGMENT_LIMIT_EXCEEDED',line);break;}
      const id=`fragment${++fragmentCount}`,kind=fragment[1] as 'alt'|'opt'|'loop'|'par';
      stack.push({id,kind});
      if(!append(line,{type:'fragment-start',id,kind,text:fragment[2].trim()}))break;
      continue;
    }
    const branch=/^(else|and)(?:[ \t]+(.*))?$/.exec(text);
    if(branch){
      const parent=stack.at(-1);
      if(!parent){issue('INVALID_FRAGMENT',line);continue;}
      if(!append(line,{type:'fragment-branch',id:parent.id,kind:branch[1] as 'else'|'and',text:branch[2]?.trim()??''}))break;
      continue;
    }
    if(text==='end'){
      const parent=stack.pop();
      if(!parent){issue('INVALID_FRAGMENT',line);continue;}
      if(!append(line,{type:'fragment-end',id:parent.id}))break;
      continue;
    }
    issue('UNSUPPORTED_OR_UNSAFE_SYNTAX',line);
  }
  if(!header)issue('UNSUPPORTED_HEADER');
  const structural=inspectDiagram(diagram);
  if(structural)issue(structural.code,structural.event===undefined?undefined:eventLines[structural.event]);
  return {diagram,issues};
}

export function validateSequence(source:string):{ok:boolean;issues:Issue[]} {
  const {issues}=parse(source);return {ok:issues.length===0,issues};
}

export function parseSequence(source:string):SequenceDiagram {
  const {diagram,issues}=parse(source);
  if(issues.length)throw new Error('INVALID_MERMAID');
  return diagram;
}
