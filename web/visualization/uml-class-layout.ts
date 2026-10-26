import type {ClassDiagram,ClassNode,ClassRelationship} from '../../shared/uml-class.ts';
import type {CanvasPrimitive,CanvasPresentationDocument} from '../../shared/canvas.ts';
import {CANVAS_LIMITS} from '../../shared/canvas.ts';
import {validateClassModel} from './uml-class.ts';
import {validatePresentationDocument} from './presentation.ts';

const FONT=18,LEADING=22,PADDING=18,MARKER_HEIGHT=28;
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const limit=():never=>{throw new Error('CLASS_LAYOUT_LIMIT');};
const snap=(value:number)=>Math.ceil(value/12)*12;
type TextBlock={text:string;height:number};
type Port={relationship:ClassRelationship;side:'from'|'to';slotWidth:number;x:number};
type Card={node:ClassNode;x:number;width:number;headerHeight:number;attributeHeight:number;naturalHeight:number;ports:Port[]};
type Lane={relationship:ClassRelationship;y:number;label:{x:number;y:number;width:number;block:TextBlock}|null};
const legend='범례 · 빈 삼각형은 상속·실체화 · 빈 마름모는 집합 · 채운 마름모는 합성 · 열린 화살표는 연관·의존 · 점선은 의존·실체화·점선 연결 · 선 교차는 연결이 아님';
const provenance='사용자 작성 UML 모델 · 소스 코드나 실행 구조를 검증한 결과가 아닙니다.';

/** Per-call caches avoid repeating Unicode segmentation across the fixed candidate sizes. */
class TextLayout {
  readonly characters=new Map<string,string[]>();
  readonly blocks=new Map<string,TextBlock>();
  width(text:string){return this.parts(text).length*FONT;}
  parts(text:string){let parts=this.characters.get(text);if(!parts){parts=[...segmenter.segment(text)].map(part=>part.segment);this.characters.set(text,parts);}return parts;}
  advance(part:string){
    // Conservative Arial/sans-serif advances. Wide ASCII stays at least one em;
    // non-ASCII graphemes (including CJK and emoji) retain the full-em allowance.
    if(!/^[\x20-\x7e]\p{M}*$/u.test(part))return FONT;
    const character=part[0];
    if(/[MWmw@%]/.test(character))return FONT*1.05;
    if(character===' ')return FONT*0.4;
    if(/[ilIjtfr.,:;!'|]/.test(character))return FONT*0.45;
    if(/[()[\]"]/.test(character))return FONT*0.5;
    if(/[A-Z]/.test(character))return FONT*0.85;
    if(/[a-z]/.test(character))return FONT*0.7;
    return FONT*0.8;
  }
  wrap(text:string,width:number):TextBlock{
    const key=`${width}\0${text}`,cached=this.blocks.get(key);if(cached)return cached;
    const parts=this.parts(text),lines:string[]=[];
    for(let start=0;start<parts.length;){
      let end=start,used=0,boundary=-1;
      while(end<parts.length&&used+this.advance(parts[end])<=width){used+=this.advance(parts[end]);end++;if(/^[\s.,:;()[\]{}\/+-]$/u.test(parts[end-1]))boundary=end;}
      if(end===start)limit();
      // Keep every source space and punctuation character. Avoid a near-empty
      // line when the only possible word break is its visibility prefix.
      if(end<parts.length&&boundary>=start+Math.ceil((end-start)/2))end=boundary;
      lines.push(parts.slice(start,end).join(''));start=end;
    }
    const block={text:lines.join('\n'),height:lines.length*LEADING};if(block.text.length>512)limit();this.blocks.set(key,block);return block;
  }
}
function headerFields(node:ClassNode){return [...(node.annotation?[`«${node.annotation}»`]:[]),node.name,...(node.name!==node.id?[node.id]:[])];}
function compartmentHeight(members:string[],width:number,text:TextLayout){return Math.max(24,24+members.reduce((height,member)=>height+text.wrap(member,width-2*PADDING).height+6,-6));}
function createCards(diagram:ClassDiagram,preferredWidth:number,text:TextLayout):Card[]{
  return diagram.classes.map(node=>{
    const ports:Port[]=[];
    for(const relationship of diagram.relationships)for(const side of ['from','to'] as const)if(relationship[side]===node.id){
      const multiplicity=side==='from'?relationship.fromMultiplicity:relationship.toMultiplicity;
      ports.push({relationship,side,slotWidth:Math.max(44,(multiplicity?text.width(multiplicity):0)+24),x:0});
    }
    const width=snap(Math.max(preferredWidth,2*PADDING+ports.reduce((total,port)=>total+port.slotWidth,0)));
    const headerHeight=snap(24+headerFields(node).reduce((height,field)=>height+text.wrap(field,width-2*PADDING).height+6,-6)),attributeHeight=snap(compartmentHeight(node.attributes,width,text));
    const naturalHeight=headerHeight+attributeHeight+snap(compartmentHeight(node.operations,width,text));
    return {node,x:0,width,headerHeight,attributeHeight,naturalHeight,ports};
  });
}

function attempt(diagram:ClassDiagram,preferredWidth:number,gap:number,text:TextLayout):CanvasPresentationDocument|null{
  const cards=createCards(diagram,preferredWidth,text),rowWidth=cards.reduce((width,card)=>width+card.width,0)+gap*(cards.length-1),width=snap(Math.max(900,rowWidth+48));if(width>CANVAS_LIMITS.width)return null;
  const cardY=72,cardHeight=Math.max(...cards.map(card=>card.naturalHeight)),cardBottom=cardY+cardHeight;
  let x=(width-rowWidth)/2;
  for(const card of cards){card.x=x;let slot=x+(card.width-card.ports.reduce((total,port)=>total+port.slotWidth,0))/2;for(const port of card.ports){port.x=slot+port.slotWidth-12;slot+=port.slotWidth;}x+=card.width+gap;}
  const byId=new Map(cards.map(card=>[card.node.id,card])),lanes:Lane[]=[];
  const endpointBand=diagram.relationships.some(edge=>edge.fromMultiplicity||edge.toMultiplicity)?72:40;
  let nextY=cardBottom+(diagram.relationships.length?endpointBand+24:24);
  for(const relationship of diagram.relationships){
    const from=cards.findIndex(card=>card.node.id===relationship.from),to=cards.findIndex(card=>card.node.id===relationship.to),first=Math.min(from,to),last=Math.max(from,to);
    // Label wells are only between cards: no endpoint's vertical stem enters them.
    const gapIndex=Math.floor((first+last-1)/2),labelWidth=gap-24,block=relationship.label?text.wrap(relationship.label,labelWidth):null;
    const label=block?{x:cards[gapIndex].x+cards[gapIndex].width+12,y:nextY,width:labelWidth,block}:null;
    const y=nextY+(block?.height??0)+8;lanes.push({relationship,y,label});nextY=y+24;
  }
  const footer=text.wrap(legend,width-48),source=text.wrap(provenance,width-48),footerY=nextY+12,sourceY=footerY+footer.height+12,height=snap(sourceY+source.height+24);if(height>CANVAS_LIMITS.height)return null;
  const elements:CanvasPrimitive[]=[];
  const line=(id:string,x1:number,y1:number,x2:number,y2:number,dash:'solid'|'dash'='solid')=>elements.push({type:'line',id,x1,y1,x2,y2,dash,arrow:'none'});
  const label=(id:string,value:string,x:number,y:number,w:number,align:'left'|'center'='left')=>elements.push({type:'label',id,x,y,width:w,...text.wrap(value,w),fontSize:FONT,align});
  const memberLabels=(card:Card,members:string[],start:number,kind:'attribute'|'operation')=>{let y=start+12;members.forEach((member,index)=>{label(`class:${card.node.id}:${kind}:${index}`,member,card.x+PADDING,y,card.width-2*PADDING);y+=text.wrap(member,card.width-2*PADDING).height+6;});};
  for(const card of cards){
    const prefix=`class:${card.node.id}`;elements.push({type:'box',id:prefix,x:card.x,y:cardY,width:card.width,height:cardHeight,geometry:'rect',fill:'paper',stroke:'solid'});
    line(`${prefix}:divider:attributes`,card.x,cardY+card.headerHeight,card.x+card.width,cardY+card.headerHeight);
    line(`${prefix}:divider:operations`,card.x,cardY+card.headerHeight+card.attributeHeight,card.x+card.width,cardY+card.headerHeight+card.attributeHeight);
    let y=cardY+12;headerFields(card.node).forEach((field,index)=>{label(`${prefix}:heading:${index}`,field,card.x+PADDING,y,card.width-2*PADDING,'center');y+=text.wrap(field,card.width-2*PADDING).height+6;});
    memberLabels(card,card.node.attributes,cardY+card.headerHeight,'attribute');memberLabels(card,card.node.operations,cardY+card.headerHeight+card.attributeHeight,'operation');
  }
  const marker=(relationship:ClassRelationship,port:Port)=>{
    const prefix=`relationship:${relationship.id}:marker`,x=port.x,y=cardBottom;
    if(port.side==='from'&&(relationship.kind==='composition'||relationship.kind==='aggregation')){
      if(relationship.kind==='composition')elements.push({type:'box',id:`${prefix}:diamond`,x:x-10,y,width:20,height:MARKER_HEIGHT,geometry:'diamond',fill:'ink',stroke:'solid'});
      else{line(`${prefix}:diamond1`,x,y,x+10,y+14);line(`${prefix}:diamond2`,x+10,y+14,x,y+28);line(`${prefix}:diamond3`,x,y+28,x-10,y+14);line(`${prefix}:diamond4`,x-10,y+14,x,y);}
      return y+MARKER_HEIGHT;
    }
    if(port.side==='to'&&(relationship.kind==='inheritance'||relationship.kind==='realization')){
      line(`${prefix}:triangle1`,x,y,x-10,y+18);line(`${prefix}:triangle2`,x-10,y+18,x+10,y+18);line(`${prefix}:triangle3`,x+10,y+18,x,y);return y+18;
    }
    if(port.side==='to'&&(relationship.kind==='association'||relationship.kind==='dependency')){line(`${prefix}:open1`,x-9,y+16,x,y);line(`${prefix}:open2`,x,y,x+9,y+16);}
    return y;
  };
  for(const lane of lanes){
    const {relationship}=lane,prefix=`relationship:${relationship.id}`,from=byId.get(relationship.from)!.ports.find(port=>port.relationship===relationship&&port.side==='from')!,to=byId.get(relationship.to)!.ports.find(port=>port.relationship===relationship&&port.side==='to')!;
    const start=marker(relationship,from),end=marker(relationship,to),dash=['dependency','realization','dashed-link'].includes(relationship.kind)?'dash':'solid';
    line(`${prefix}:route:source`,from.x,start,from.x,lane.y,dash);line(`${prefix}:route:span`,from.x,lane.y,to.x,lane.y,dash);line(`${prefix}:route:target`,to.x,lane.y,to.x,end,dash);
    for(const port of [from,to]){const multiplicity=port.side==='from'?relationship.fromMultiplicity:relationship.toMultiplicity;if(multiplicity)label(`${prefix}:multiplicity:${port.side}`,multiplicity,port.x-8-text.width(multiplicity),cardBottom+MARKER_HEIGHT+8,text.width(multiplicity));}
    if(lane.label)label(`${prefix}:label`,relationship.label!,lane.label.x,lane.label.y,lane.label.width,'center');
  }
  label('diagram:title','UML 클래스 다이어그램',24,24,width-48);label('diagram:legend',legend,24,footerY,width-48);label('diagram:provenance',provenance,24,sourceY,width-48);
  const document:CanvasPresentationDocument={format:'canvas-v1',slides:[{id:'class-overview',width,height,elements}]};
  return validatePresentationDocument(document)?document:null;
}

/** A finite set of card/label widths; there is no graph search or content-dependent retry loop. */
export function layoutClassDiagram(diagram:ClassDiagram):CanvasPresentationDocument{
  if(!validateClassModel(diagram))throw new Error('INVALID_CLASS_DIAGRAM');
  const text=new TextLayout();
  for(const preferredWidth of [264,312,360,432,504,624,720,900,216])for(const gap of [144,192,240,288,360]){
    const document=attempt(diagram,preferredWidth,gap,text);if(document)return document;
  }
  return limit();
}
