import {SEQUENCE_CANVAS_LIMITS,type SequenceDiagram,type SequenceEvent,type SequencePrimitive,type SequencePresentationDocument,type SequenceSlide} from '../../shared/sequence.ts';
import {validateSequenceDiagram} from './sequence.ts';

const FONT=18,LEADING=22,PAGE_HEIGHT=1200,BOTTOM=1144;
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const graphemes=(text:string)=>[...segmenter.segment(text)].map(part=>part.segment);
const limit=():never=>{throw new Error('SEQUENCE_LAYOUT_LIMIT');};
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
function wrap(text:string,width:number){
  const count=Math.floor(width/FONT);if(count<1)return limit();
  const chars=graphemes(text),lines:string[]=[];
  for(let i=0;i<chars.length;i+=count)lines.push(chars.slice(i,i+count).join(''));
  const value=lines.join('\n');if(value.length>512)return limit();
  return {text:value,height:Math.max(1,lines.length)*LEADING};
}
type Frame={id:string;kind:string;text:string;depth:number;startY:number;branch?:{kind:string;text:string}};
type Activation={level:number;startY:number};
type Box=Extract<SequencePrimitive,{type:'box'}>;

/** Deterministic point geometry shared by the inert SVG and editable slide export. */
export function layoutSequence(diagram:SequenceDiagram):SequencePresentationDocument{
  if(!validateSequenceDiagram(diagram))throw new Error('INVALID_SEQUENCE');
  const count=diagram.participants.length;
  const sideText=Math.max(0,...diagram.events.filter(e=>e.type==='note'&&e.placement!=='over').map(e=>e.type==='note'?graphemes(e.text).length:0));
  const wide=sideText>80||diagram.participants.some(p=>graphemes(p.label).length>80)||diagram.events.some(e=>(e.type==='fragment-start'||e.type==='fragment-branch')&&graphemes(e.text).length>80);
  const margin=wide?560:Math.min(560,Math.max(160,sideText*FONT+72));
  const width=Math.min(3600,Math.max(wide?2400:900,count*260+margin*2));
  const pitch=count===1?640:(width-margin*2)/(count-1),participantWidth=Math.min(640,count===1?640:margin*2-40,Math.floor(pitch-24));
  const positions=new Map(diagram.participants.map((p,i)=>[p.id,count===1?width/2:margin+i*pitch]));
  const participantLabels=diagram.participants.map(p=>wrap(p.label,participantWidth-20));
  const labelHeight=Math.max(...participantLabels.map(p=>p.height));
  const labelY=32+(diagram.participants.some(p=>p.kind==='actor')?78:0),headerBottom=labelY+labelHeight+18;
  const slides:SequenceSlide[]=[],frames:Frame[]=[],activations=new Map<string,Activation[]>();
  const pageNotes:{continuedActivation:boolean;continuedFragment:boolean}[]=[];
  let elements:SequencePrimitive[]=[],frameBoxes:Box[]=[],activationBoxes:Box[]=[],y=0,serial=0,pageNumber=0,messageNumber=0,eventCount=0,continuedActivation=false;
  let previousMessage:{from:string;to:string;startY:number;endY:number}|null=null;
  const id=()=>`page${pageNumber}-element${++serial}`;
  function box(x:number,top:number,w:number,h:number,fill:Box['fill']='none',stroke:Box['stroke']='solid',geometry:Box['geometry']='rect'):Box{return {type:'box',id:id(),x,y:top,width:w,height:h,fill,stroke,geometry};}
  function line(x1:number,y1:number,x2:number,y2:number,dash:'solid'|'dash'='solid',arrow:'none'|'triangle'='none'){
    elements.push({type:'line',id:id(),x1,y1,x2,y2,dash,arrow});
  }
  function label(text:string,x:number,top:number,w:number,align:'left'|'center'='left'){
    const wrapped=wrap(text,w);elements.push({type:'label',id:id(),x,y:top,width:w,height:wrapped.height,text:wrapped.text,fontSize:FONT,align});return wrapped.height;
  }
  const frameBounds=(depth:number)=>({x:24+depth*14,width:width-48-depth*28});
  function frameHeaderHeight(frame:Frame,text:string){return Math.max(LEADING,wrap(text,frameBounds(frame.depth).width-168).height)+12;}
  function frameHeader(frame:Frame,kind:string,text:string,top:number){
    const bounds=frameBounds(frame.depth),height=frameHeaderHeight(frame,text);
    elements.push(box(bounds.x+1,top+1,bounds.width-2,height-2,'paper','none'));
    label(kind,bounds.x+12,top+6,144);label(text,bounds.x+156,top+6,bounds.width-168);
    return height;
  }
  function activationBox(participant:string,activation:Activation,end:number){
    activationBoxes.push(box(positions.get(participant)!-6+activation.level*7,activation.startY,12,Math.max(1,end-activation.startY),'blue'));
  }
  function startPage(){
    if(++pageNumber>SEQUENCE_CANVAS_LIMITS.pages)return limit();
    serial=0;elements=[];frameBoxes=[];activationBoxes=[];eventCount=0;
    continuedActivation=[...activations.values()].some(stack=>stack.length>0);
    diagram.participants.forEach((participant,i)=>{
      const x=positions.get(participant.id)!;
      if(participant.kind==='actor'){
        elements.push(box(x-14,20,28,28,'paper','solid','ellipse'));
        line(x,48,x,70);line(x-25,55,x+25,55);line(x,70,x-22,88);line(x,70,x+22,88);
      }else elements.push(box(x-participantWidth/2,labelY-12,participantWidth,labelHeight+24,'paper'));
      label(participant.label,x-participantWidth/2+10,labelY,participantWidth-20,'center');
    });
    y=headerBottom+14;
    for(const frame of frames){
      frame.startY=y;y+=frameHeader(frame,`${frame.kind} 계속`,frame.text,y);
      if(frame.branch)y+=frameHeader(frame,`${frame.branch.kind} 계속`,frame.branch.text,y);
    }
    for(const stack of activations.values())for(const activation of stack)activation.startY=y;
    if(y>=BOTTOM)return limit();
  }
  function finishPage(continuing:boolean){
    const bottom=Math.max(y+2,headerBottom+60);
    for(const frame of frames){const bounds=frameBounds(frame.depth);frameBoxes.push(box(bounds.x,frame.startY,bounds.width,Math.max(1,bottom-frame.startY)));}
    for(const [participant,stack] of activations)for(const activation of stack)activationBox(participant,activation,bottom);
    const lifelines:SequencePrimitive[]=diagram.participants.map(p=>({type:'line',id:id(),x1:positions.get(p.id)!,y1:headerBottom,x2:positions.get(p.id)!,y2:bottom,dash:'dash',arrow:'none'}));
    const all=[...frameBoxes,...lifelines,...activationBoxes,...elements];
    slides.push({id:`sequence-page-${pageNumber}`,width,height:PAGE_HEIGHT,elements:all});
    pageNotes.push({continuedActivation,continuedFragment:continuing&&frames.length>0});
  }
  function messageRow(event:Extract<SequenceEvent,{type:'message'}>){
    const a=positions.get(event.from)!,b=positions.get(event.to)!,self=event.from===event.to;
    const text=(diagram.autonumber?`${messageNumber+1}. `:'')+event.text;
    const labelWidth=Math.min(width-128,Math.max(800,Math.abs(b-a)-32),Math.max(FONT,graphemes(text).length*FONT));
    const selfLeft=a+28+labelWidth<=width-64?a+28:a-labelWidth-28;
    const left=clamp(self?selfLeft:(a+b-labelWidth)/2,64,width-64-labelWidth);
    return {text,labelWidth,left,self,height:wrap(text,labelWidth).height+(self?36:18)};
  }
  function noteRow(event:Extract<SequenceEvent,{type:'note'}>){
    const a=positions.get(event.participants[0])!,b=positions.get(event.participants.at(-1)!)!;
    let w:number,left:number;
    if(event.placement==='left'){w=Math.min(520,a-56);left=a-24-w;}
    else if(event.placement==='right'){w=Math.min(520,width-a-56);left=a+24;}
    else {w=Math.min(width-128,Math.max(520,Math.abs(b-a)+80));left=clamp((a+b-w)/2,64,width-64-w);}
    return {left,width:w,height:wrap(event.text,w-16).height+24};
  }
  function rowHeight(event:SequenceEvent):number{
    if(event.type==='message')return messageRow(event).height;
    if(event.type==='note')return noteRow(event).height;
    if(event.type==='fragment-start')return frameHeaderHeight({...event,depth:frames.length,startY:y},event.text);
    if(event.type==='fragment-branch')return frameHeaderHeight(frames.at(-1)!,event.text)+4;
    return 14;
  }
  function endpoint(participant:string,direction:number){
    const depth=activations.get(participant)?.length??0;
    return positions.get(participant)!+(depth?((depth-1)*7+direction*6):0);
  }
  startPage();
  for(const event of diagram.events){
    const attached=event.type==='activation'&&previousMessage&&(event.action==='activate'?previousMessage.to===event.participant:previousMessage.from===event.participant);
    const height=attached?0:rowHeight(event);
    if(y+height>BOTTOM){
      if(!eventCount)return limit();
      finishPage(true);startPage();
      if(y+height>BOTTOM)return limit();
    }
    if(event.type==='message'){
      const row=messageRow(event),textHeight=row.height-(row.self?36:18);
      const textWidth=Math.max(...wrap(row.text,row.labelWidth).text.split('\n').map(text=>graphemes(text).length*FONT));
      const textLeft=row.self?row.left:row.left+(row.labelWidth-textWidth)/2;
      elements.push(box(textLeft-4,y,textWidth+8,textHeight,'paper','none'));label(row.text,row.left,y,row.labelWidth,row.self?'left':'center');
      const direction=positions.get(event.to)!>=positions.get(event.from)!?1:-1;
      const from=endpoint(event.from,direction),to=endpoint(event.to,-direction),arrowY=y+textHeight+6;
      if(row.self){const x=endpoint(event.from,1);line(x,arrowY,x+72,arrowY,event.arrow==='dashed'?'dash':'solid');line(x+72,arrowY,x+72,arrowY+22,event.arrow==='dashed'?'dash':'solid');line(x+72,arrowY+22,x,arrowY+22,event.arrow==='dashed'?'dash':'solid','triangle');}
      else line(from,arrowY,to,arrowY,event.arrow==='dashed'?'dash':'solid','triangle');
      previousMessage={from:event.from,to:event.to,startY:arrowY,endY:arrowY+(row.self?22:0)};
      messageNumber++;
    }else if(event.type==='note'){
      const row=noteRow(event);elements.push(box(row.left,y,row.width,row.height-8,'note'));label(event.text,row.left+8,y+8,row.width-16);
    }else if(event.type==='activation'){
      const stack=activations.get(event.participant)??[];
      if(event.action==='activate'){stack.push({level:stack.length,startY:attached?previousMessage!.endY:y+2});activations.set(event.participant,stack);}
      else activationBox(event.participant,stack.pop()!,attached?previousMessage!.endY:y+height-2);
    }else if(event.type==='fragment-start'){
      const frame:Frame={...event,depth:frames.length,startY:y};frames.push(frame);frameHeader(frame,event.kind,event.text,y);
    }else if(event.type==='fragment-branch'){
      const frame=frames.at(-1)!,bounds=frameBounds(frame.depth);line(bounds.x+1,y+1,bounds.x+bounds.width-1,y+1,'dash');
      frameHeader(frame,event.kind,event.text,y+4);frame.branch={kind:event.kind,text:event.text};
    }else{
      const frame=frames.pop()!,bounds=frameBounds(frame.depth);frameBoxes.push(box(bounds.x,frame.startY,bounds.width,y+height-frame.startY));
    }
    if(event.type!=='message')previousMessage=null;
    y+=height;eventCount++;
  }
  finishPage(false);
  for(const [i,slide] of slides.entries()){
    const note=pageNotes[i],text=`${i+1} / ${slides.length}페이지${note.continuedActivation?' · 활성화 계속':''}${note.continuedFragment?' · 다음 페이지에 분기 계속':''}`;
    slide.elements.push({type:'label',id:`page${i+1}-footer`,x:32,y:1166,width:width-64,height:LEADING,text,fontSize:FONT,align:'left'});
    if(slide.elements.length>SEQUENCE_CANVAS_LIMITS.elementsPerPage)return limit();
    for(const element of slide.elements){
      if(element.type==='line'){
        if(![element.x1,element.y1,element.x2,element.y2].every(Number.isFinite)||Math.min(element.x1,element.x2,element.y1,element.y2)<0||Math.max(element.x1,element.x2)>width||Math.max(element.y1,element.y2)>PAGE_HEIGHT||Math.hypot(element.x2-element.x1,element.y2-element.y1)<1)return limit();
      }else if(![element.x,element.y,element.width,element.height].every(Number.isFinite)||element.x<0||element.y<0||element.width<1||element.height<1||element.x+element.width>width||element.y+element.height>PAGE_HEIGHT)return limit();
    }
  }
  const document:SequencePresentationDocument={format:'sequence-v1',slides};
  if(slides.reduce((sum,slide)=>sum+slide.elements.length,0)>SEQUENCE_CANVAS_LIMITS.elements||new TextEncoder().encode(JSON.stringify(document)).length>SEQUENCE_CANVAS_LIMITS.bytes)return limit();
  return document;
}
