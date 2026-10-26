import type {C4Diagram,C4Element,C4Relationship} from '../../shared/c4.ts';
import {CANVAS_LIMITS} from '../../shared/canvas.ts';
import type {CanvasPrimitive,CanvasPresentationDocument} from '../../shared/canvas.ts';
import {validateC4} from './c4.ts';
import {validatePresentationDocument} from './presentation.ts';

const FONT=18,LEADING=22,GRID=12;
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const graphemes=(text:string)=>[...segmenter.segment(text)].map(part=>part.segment);
const snap=(value:number)=>Math.ceil(value/GRID)*GRID;
const limit=():never=>{throw new Error('C4_LAYOUT_LIMIT');};
type Rect={x:number;y:number;width:number;height:number};
type Point={x:number;y:number};
type Label=Extract<CanvasPrimitive,{type:'label'}>;
type Line=Extract<CanvasPrimitive,{type:'line'}>;
type Card=Rect&{element:C4Element};
type Boundary=Rect&{element:C4Element;header:Rect};
type Group={width:number;height:number;cards:Card[];boundaries:Boundary[]};
type Port={point:Point;outside:Point;key:string};
/** One budget covers every candidate layout, label search and path search for a call. */
class WorkBudget {
  remaining=750_000;
  spend(amount=1){this.remaining-=amount;if(this.remaining<0)limit();}
}
const overlaps=(a:Rect,b:Rect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const inflate=(rect:Rect,by:number):Rect=>({x:rect.x-by,y:rect.y-by,width:rect.width+2*by,height:rect.height+2*by});
const kindNames={person:'사람',system:'소프트웨어 시스템',container:'컨테이너',component:'컴포넌트'};
const viewNames={context:'시스템 컨텍스트',container:'컨테이너',component:'컴포넌트'};
const legend='범례 · 파랑은 선택 범위 내부 · 외부 표기는 범위 밖 요소 · 점선은 경계 · 화살표는 관계 방향 · 선 교차는 연결이 아님';

function wrap(text:string,width:number){
  const count=Math.max(1,Math.floor(width/FONT)),parts=graphemes(text),lines:string[]=[];
  for(let index=0;index<parts.length;index+=count)lines.push(parts.slice(index,index+count).join(''));
  const wrapped=lines.join('\n');if(wrapped.length>512)return limit();
  return {text:wrapped,height:lines.length*LEADING};
}
function fieldLabels(element:C4Element,bounds:Rect,kind:string,prefix:string):Label[]{
  let y=bounds.y+18;const x=bounds.x+18,width=bounds.width-36;
  return [['kind',kind],['name',element.name],...(element.technology?[['technology',element.technology]]:[]),['description',element.description]].map(([field,text])=>{
    const wrapped=wrap(text,width),label:Label={type:'label',id:`${prefix}:${field}`,x,y,width,...wrapped,fontSize:FONT,align:'left'};y+=wrapped.height+6;return label;
  });
}
function fieldHeight(element:C4Element,width:number,kind:string){
  return snap(36+[kind,element.name,...(element.technology?[element.technology]:[]),element.description].reduce((height,text)=>height+wrap(text,width-36).height+6,-6));
}
function move(group:Group,x:number,y:number):Group{
  return {...group,cards:group.cards.map(card=>({...card,x:card.x+x,y:card.y+y})),boundaries:group.boundaries.map(boundary=>({...boundary,x:boundary.x+x,y:boundary.y+y,header:{...boundary.header,x:boundary.header.x+x,y:boundary.header.y+y}}))};
}
function grid(elements:C4Element[],columns:number,width:number,gapX:number,gapY:number,kind:(element:C4Element)=>string):Group{
  if(!elements.length)return {width:0,height:0,cards:[],boundaries:[]};
  const count=Math.min(elements.length,columns),cards:Card[]=[];let y=0;
  for(let start=0;start<elements.length;start+=count){
    const row=elements.slice(start,start+count),heights=row.map(element=>fieldHeight(element,width,kind(element))),height=Math.max(...heights);
    row.forEach((element,index)=>cards.push({element,x:index*(width+gapX),y,width,height:heights[index]}));y+=height+gapY;
  }
  return {width:count*width+(count-1)*gapX,height:y-gapY,cards,boundaries:[]};
}
function sideBySide(groups:Group[],gap:number):Group{
  const present=groups.filter(group=>group.cards.length||group.boundaries.length),height=Math.max(0,...present.map(group=>group.height));let x=0;
  const cards:Card[]=[],boundaries:Boundary[]=[];
  for(const group of present){const placed=move(group,x,snap((height-group.height)/2));cards.push(...placed.cards);boundaries.push(...placed.boundaries);x+=group.width+gap;}
  return {width:Math.max(0,x-gap),height:snap(height+GRID),cards,boundaries};
}
function enclose(element:C4Element,contents:Group):Group{
  const width=Math.max(336,contents.width+48),headerHeight=fieldHeight(element,width,`${kindNames[element.kind]} 경계`),placed=move(contents,24,headerHeight+24),height=headerHeight+contents.height+48;
  return {width,height,cards:placed.cards,boundaries:[{element,x:0,y:0,width,height,header:{x:0,y:0,width,height:headerHeight}},...placed.boundaries]};
}
function arrange(diagram:C4Diagram,width:number,gapX:number,gapY:number,columns:number){
  const scope=diagram.elements.find(element=>element.id===diagram.scope)!;
  const external=diagram.elements.filter(element=>element.id!==scope.id&&element.parentId===null&&(diagram.view!=='component'||element.id!==scope.parentId));
  const externalKind=(element:C4Element)=>`외부 ${kindNames[element.kind]}`;
  const outsideGrid=(elements:C4Element[])=>grid(elements,elements.length>6?3:elements.length>2?2:1,width,gapX,gapY,externalKind);
  let center:Group;
  if(diagram.view==='context')center=grid([scope],1,width,gapX,gapY,element=>`${kindNames[element.kind]} · 선택 범위`);
  else{
    const primary=grid(diagram.elements.filter(element=>element.parentId===scope.id),columns,width,gapX,gapY,element=>kindNames[element.kind]);
    center=enclose(scope,primary);
    if(diagram.view==='component'){
      const parent=diagram.elements.find(element=>element.id===scope.parentId)!,siblings=grid(diagram.elements.filter(element=>element.parentId===parent.id&&element.id!==scope.id),1,width,gapX,gapY,element=>`${kindNames[element.kind]} · 동일 시스템`);
      center=enclose(parent,sideBySide([center,siblings],gapX));
    }
  }
  return sideBySide([outsideGrid(external.filter(element=>element.kind==='person')),center,outsideGrid(external.filter(element=>element.kind!=='person'))],gapX);
}

/** A bounded grid keeps the routing work independent of text length and prevents lines crossing cards. */
class RoutingGrid {
  readonly cols:number;readonly rows:number;readonly blocked:Uint8Array;readonly budget:WorkBudget;
  constructor(width:number,height:number,obstacles:Rect[],budget:WorkBudget){
    this.budget=budget;
    this.cols=width/GRID+1;this.rows=height/GRID+1;this.blocked=new Uint8Array(this.cols*this.rows);
    for(const rect of obstacles)this.mark(rect);
    this.mark({x:0,y:0,width,height:18});this.mark({x:0,y:0,width:18,height});this.mark({x:width-18,y:0,width:18,height});this.mark({x:0,y:height-18,width,height:18});
  }
  index(point:Point){return point.y/GRID*this.cols+point.x/GRID;}
  point(index:number):Point{return {x:index%this.cols*GRID,y:Math.floor(index/this.cols)*GRID};}
  mark(rect:Rect){
    const top=Math.max(0,Math.ceil(rect.y/GRID)),bottom=Math.min(this.rows-1,Math.floor((rect.y+rect.height)/GRID)),left=Math.max(0,Math.ceil(rect.x/GRID)),right=Math.min(this.cols-1,Math.floor((rect.x+rect.width)/GRID));
    this.budget.spend(Math.max(0,bottom-top+1)*Math.max(0,right-left+1));
    for(let row=top;row<=bottom;row++)for(let col=left;col<=right;col++)this.blocked[row*this.cols+col]=1;
  }
  edge(a:number,b:number){return Math.min(a,b)*2+(Math.abs(a-b)===1?0:1);}
  route(start:Point,end:Point,used:Uint8Array,usedEdges:Uint8Array,excluded:Set<number>=new Set()):Point[]|null{
    const a=this.index(start),b=this.index(end);if(!Number.isInteger(a)||!Number.isInteger(b)||this.blocked[a]||this.blocked[b]||excluded.has(a)||excluded.has(b))return null;
    const size=this.blocked.length,cost=new Float64Array(size);cost.fill(Infinity);cost[a]=0;const parent=new Int32Array(size);parent.fill(-1);
    const heap:{index:number;score:number;cost:number}[]=[];
    const estimate=(index:number)=>Math.abs(index%this.cols-b%this.cols)+Math.abs(Math.floor(index/this.cols)-Math.floor(b/this.cols));
    const push=(entry:{index:number;score:number;cost:number})=>{heap.push(entry);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(heap[p].score<=entry.score)break;heap[i]=heap[p];i=p;}heap[i]=entry;};
    const pop=()=>{const first=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;if(heap[child].score>=last.score)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;};
    push({index:a,score:estimate(a),cost:0});let visited=0;
    while(heap.length&&visited++<size*5){
      this.budget.spend(5);
      const current=pop(),index=current.index;if(current.cost!==cost[index])continue;
      if(index===b){const path:Point[]=[];for(let at=b;at!==-1;at=parent[at])path.push(this.point(at));return path.reverse();}
      for(const next of [index-1,index+1,index-this.cols,index+this.cols]){
        if(next<0||next>=size||Math.abs(next%this.cols-index%this.cols)+Math.abs(Math.floor(next/this.cols)-Math.floor(index/this.cols))!==1||this.blocked[next]||excluded.has(next)||usedEdges[this.edge(index,next)])continue;
        const previous=parent[index],turn=previous!==-1&&(index-previous)!==(next-index)?0.35:0,newCost=current.cost+1+used[next]*4+turn;
        if(newCost>=cost[next])continue;cost[next]=newCost;parent[next]=index;push({index:next,cost:newCost,score:newCost+estimate(next)});
      }
    }
    return null;
  }
}
function ports(card:Card,towards:Point,occupied:Set<string>):Port[]{
  const points:Port[]=[];
  const add=(point:Point,outside:Point)=>{const key=`${point.x},${point.y}`;if(!occupied.has(key))points.push({point,outside,key});};
  for(let offset=24;offset<=card.width-24;offset+=GRID){add({x:card.x+offset,y:card.y},{x:card.x+offset,y:card.y-GRID});add({x:card.x+offset,y:card.y+card.height},{x:card.x+offset,y:card.y+card.height+GRID});}
  for(let offset=24;offset<=card.height-24;offset+=GRID){add({x:card.x,y:card.y+offset},{x:card.x-GRID,y:card.y+offset});add({x:card.x+card.width,y:card.y+offset},{x:card.x+card.width+GRID,y:card.y+offset});}
  return points.sort((a,b)=>Math.abs(a.outside.x-towards.x)+Math.abs(a.outside.y-towards.y)-Math.abs(b.outside.x-towards.x)-Math.abs(b.outside.y-towards.y));
}
function compact(path:Point[]):Point[]{
  const result:Point[]=[];
  for(const point of path){if(result.length&&result.at(-1)!.x===point.x&&result.at(-1)!.y===point.y)continue;while(result.length>=2){const a=result.at(-2)!,b=result.at(-1)!;if(a.x===b.x&&b.x===point.x||a.y===b.y&&b.y===point.y)result.pop();else break;}result.push(point);}
  return result;
}
function intersectsLine(rect:Rect,line:Line){
  return line.y1===line.y2?line.y1>=rect.y&&line.y1<=rect.y+rect.height&&Math.max(line.x1,line.x2)>=rect.x&&Math.min(line.x1,line.x2)<=rect.x+rect.width:line.x1>=rect.x&&line.x1<=rect.x+rect.width&&Math.max(line.y1,line.y2)>=rect.y&&Math.min(line.y1,line.y2)<=rect.y+rect.height;
}
function relationshipText(relationship:C4Relationship,bounds:Rect):Label[]{
  const prefix=`relationship:${relationship.id}`,description=wrap(relationship.description,bounds.width-12),labels:Label[]=[{type:'label',id:`${prefix}:description`,x:bounds.x+6,y:bounds.y+6,width:bounds.width-12,...description,fontSize:FONT,align:'center'}];
  if(relationship.technology)labels.push({type:'label',id:`${prefix}:technology`,x:bounds.x+6,y:bounds.y+description.height+12,width:bounds.width-12,...wrap(relationship.technology,bounds.width-12),fontSize:FONT,align:'center'});
  return labels;
}
function relationshipHeight(relationship:C4Relationship,width:number){return snap(12+wrap(relationship.description,width-12).height+(relationship.technology?6+wrap(relationship.technology,width-12).height:0));}

function attempt(diagram:C4Diagram,cardWidth:number,gapX:number,gapY:number,columns:number,budget:WorkBudget):CanvasPresentationDocument|null{
  const group=arrange(diagram,cardWidth,gapX,gapY,columns),width=snap(Math.max(900,group.width+192));if(width>CANVAS_LIMITS.width)return null;
  const scope=diagram.elements.find(element=>element.id===diagram.scope)!;
  const title=wrap(diagram.title,width-48),subtitle=wrap(`${viewNames[diagram.view]} · 선택 범위 · ${scope.name}`,width-48),footer=wrap(legend,width-48);
  const headerHeight=snap(title.height+subtitle.height+60),height=snap(headerHeight+group.height+144+footer.height+36);if(height>CANVAS_LIMITS.height)return null;
  const placed=move(group,snap((width-group.width)/2),headerHeight+72),cards=new Map(placed.cards.map(card=>[card.element.id,card]));
  const top:Label[]=[{type:'label',id:'diagram:title',x:24,y:24,width:width-48,...title,fontSize:FONT,align:'left'},{type:'label',id:'diagram:scope',x:24,y:30+title.height,width:width-48,...subtitle,fontSize:FONT,align:'left'},{type:'label',id:'diagram:legend',x:24,y:height-footer.height-24,width:width-48,...footer,fontSize:FONT,align:'left'}];
  const header:Rect={x:0,y:0,width,height:headerHeight-12},bottom:Rect={x:0,y:height-footer.height-36,width,height:footer.height+36};
  const obstacles:Rect[]=[header,bottom,...placed.cards.map(card=>inflate(card,6)),...placed.boundaries.map(boundary=>inflate(boundary.header,6))];
  const labelObstacles:Rect[]=[header,bottom,...placed.cards.map(card=>inflate(card,18)),...placed.boundaries.map(boundary=>inflate(boundary.header,12))];
  for(const boundary of placed.boundaries){labelObstacles.push({x:boundary.x-6,y:boundary.y-6,width:boundary.width+12,height:12},{x:boundary.x-6,y:boundary.y+boundary.height-6,width:boundary.width+12,height:12},{x:boundary.x-6,y:boundary.y-6,width:12,height:boundary.height+12},{x:boundary.x+boundary.width-6,y:boundary.y-6,width:12,height:boundary.height+12});}
  const edgeLines:Line[]=[],edgeLabels:CanvasPrimitive[]=[],occupiedPorts=new Set<string>();
  const routing=new RoutingGrid(width,height,obstacles,budget),used=new Uint8Array(routing.blocked.length),usedEdges=new Uint8Array(routing.blocked.length*2);
  const ordered=diagram.relationships.map((relationship,index)=>({relationship,index})).sort((a,b)=>b.relationship.description.length+(b.relationship.technology?.length??0)-a.relationship.description.length-(a.relationship.technology?.length??0)||a.index-b.index);
  for(const {relationship} of ordered){
    const from=cards.get(relationship.from)!,to=cards.get(relationship.to)!,midpoint={x:(from.x+from.width/2+to.x+to.width/2)/2,y:(from.y+from.height/2+to.y+to.height/2)/2};
    let fitted=false;
    for(const textWidth of [216,288,360]){
      const textHeight=relationshipHeight(relationship,textWidth),candidates:{rect:Rect;score:number}[]=[];
      for(let y=headerHeight;y+textHeight+24<bottom.y;y+=24)for(let x=24;x+textWidth<width-24;x+=24){
        budget.spend(labelObstacles.length+edgeLines.length+1);
        const rect={x,y,width:textWidth,height:textHeight},reserved={x:x-6,y:y-6,width:textWidth+12,height:textHeight+24};
        if(labelObstacles.some(obstacle=>overlaps(reserved,obstacle))||edgeLines.some(line=>intersectsLine(reserved,line)))continue;
        const score=Math.abs(x+textWidth/2-midpoint.x)+Math.abs(y+textHeight/2-midpoint.y)*1.3;candidates.push({rect,score});
      }
      budget.spend(candidates.length*Math.ceil(Math.log2(candidates.length+1)));candidates.sort((a,b)=>a.score-b.score||a.rect.y-b.rect.y||a.rect.x-b.rect.x);
      for(const {rect} of candidates.slice(0,24)){
        const left={x:rect.x,y:rect.y+rect.height+12},right={x:rect.x+rect.width,y:left.y};
        const reverse=from.x+from.width/2>to.x+to.width/2,start=reverse?right:left,end=reverse?left:right;
        const candidateGrid=new RoutingGrid(width,height,[...obstacles,inflate(rect,6)],budget),anchor=new Set<number>();
        for(let x=left.x;x<=right.x;x+=GRID)anchor.add(candidateGrid.index({x,y:left.y}));
        const unusedStub=(port:Port)=>!usedEdges[routing.edge(routing.index(port.point),routing.index(port.outside))];
        const fromPorts=ports(from,start,occupiedPorts).filter(unusedStub).slice(0,8),toPorts=ports(to,end,occupiedPorts).filter(unusedStub).slice(0,8);
        for(const fromPort of fromPorts){
          const firstExcluded=new Set(anchor);firstExcluded.delete(candidateGrid.index(start));const first=candidateGrid.route(fromPort.outside,start,used,usedEdges,firstExcluded);if(!first)continue;
          const secondExcluded=new Set([...anchor,...first.map(point=>candidateGrid.index(point))]);secondExcluded.delete(candidateGrid.index(end));
          for(const toPort of toPorts){
            const second=candidateGrid.route(end,toPort.outside,used,usedEdges,secondExcluded);if(!second)continue;
            const full=[fromPort.point,...first,start,end,...second,toPort.point],path=compact(full),newLines:Line[]=[];
            for(let index=1;index<path.length;index++)newLines.push({type:'line',id:`relationship:${relationship.id}:line${index}`,x1:path[index-1].x,y1:path[index-1].y,x2:path[index].x,y2:path[index].y,dash:'solid',arrow:index===path.length-1?'triangle':'none'});
            edgeLines.push(...newLines);edgeLabels.push({type:'box',id:`relationship:${relationship.id}:background`,...rect,fill:'paper',stroke:'none',geometry:'rect'},...relationshipText(relationship,rect));
            obstacles.push(inflate(rect,6));labelObstacles.push(inflate(rect,12));occupiedPorts.add(fromPort.key);occupiedPorts.add(toPort.key);
            for(const point of [...first,...second])used[routing.index(point)]++;
            for(let x=left.x;x<=right.x;x+=GRID)used[routing.index({x,y:left.y})]++;
            for(const line of newLines){const dx=Math.sign(line.x2-line.x1)*GRID,dy=Math.sign(line.y2-line.y1)*GRID;let point={x:line.x1,y:line.y1};while(point.x!==line.x2||point.y!==line.y2){const next={x:point.x+dx,y:point.y+dy};usedEdges[routing.edge(routing.index(point),routing.index(next))]=1;point=next;}}
            fitted=true;break;
          }
          if(fitted)break;
        }
        if(fitted)break;
      }
      if(fitted)break;
    }
    if(!fitted)return null;
  }
  const elements:CanvasPrimitive[]=[];
  for(const boundary of placed.boundaries){
    const {x,y,width:w,height:h}=boundary,prefix=`boundary:${boundary.element.id}`;
    elements.push({type:'box',id:prefix,x,y,width:w,height:h,geometry:'rect',fill:'none',stroke:'none'});
    for(const [index,[x1,y1,x2,y2]] of [[x,y,x+w,y],[x+w,y,x+w,y+h],[x+w,y+h,x,y+h],[x,y+h,x,y]].entries())elements.push({type:'line',id:`${prefix}:edge${index}`,x1,y1,x2,y2,dash:'dash',arrow:'none'});
  }
  for(const card of placed.cards){
    const inside=card.element.id===diagram.scope||card.element.parentId===diagram.scope;
    elements.push({type:'box',id:`node:${card.element.id}`,x:card.x,y:card.y,width:card.width,height:card.height,geometry:'rect',fill:inside?'blue':'paper',stroke:'solid'});
  }
  elements.push(...edgeLines,...edgeLabels);
  for(const boundary of placed.boundaries)elements.push(...fieldLabels(boundary.element,boundary.header,`${kindNames[boundary.element.kind]} 경계`,`boundary:${boundary.element.id}`));
  for(const card of placed.cards){
    const element=card.element,external=element.parentId===null&&element.id!==diagram.scope;
    const kind=external?`외부 ${kindNames[element.kind]}`:element.id===diagram.scope?`${kindNames[element.kind]} · 선택 범위`:diagram.view==='component'&&element.parentId===scope.parentId?`${kindNames[element.kind]} · 동일 시스템`:kindNames[element.kind];
    elements.push(...fieldLabels(element,card,kind,`node:${element.id}`));
  }
  elements.push(...top);
  const document:CanvasPresentationDocument={format:'canvas-v1',slides:[{id:'c4-overview',width,height,elements}]};
  return validatePresentationDocument(document)?document:null;
}

/** One complete authored view; never drops text, relationships or disconnected leaves to fit. */
export function layoutC4(diagram:C4Diagram):CanvasPresentationDocument{
  if(!validateC4(diagram).ok)throw new Error('INVALID_C4');
  const budget=new WorkBudget();
  for(const cardWidth of [288,360,432])for(const gapY of [144,96])for(const columns of [1,2,3])for(const gapX of [240,312]){
    const document=attempt(diagram,cardWidth,gapX,gapY,columns,budget);if(document)return document;
  }
  return limit();
}
