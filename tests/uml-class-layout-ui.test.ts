import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {ClassDiagram,ClassNode,ClassRelationship,ClassRelationshipKind} from '../shared/uml-class.ts';
import type {CanvasPrimitive,CanvasPresentationDocument} from '../shared/canvas.ts';
import {validatePresentationDocument} from '../web/visualization/presentation.ts';
import {parseClassDiagram} from '../web/visualization/uml-class.ts';
import {classSample} from '../web/visualization/uml-class-sample.ts';

async function components(){
  assert.ok(existsSync(new URL('../web/visualization/uml-class-layout.ts',import.meta.url)),'Class layout is not implemented');
  const root=new URL('../web/visualization/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);
  }});
  try{return {layout:await import('../web/visualization/uml-class-layout.ts'),preview:await import('../web/visualization/ClassDiagramPreview.tsx')};}finally{hooks.deregister();}
}
const node=(id:string,attributes:string[]=['+name: string'],operations:string[]=['+save(): void']):ClassNode=>({id,name:id,annotation:null,attributes,operations});
const relation=(id:string,kind:ClassRelationshipKind,from='Order',to='Item',label:string|null='contains'):ClassRelationship=>({id,kind,from,to,fromMultiplicity:null,toMultiplicity:null,label});
const basic=():ClassDiagram=>({kind:'class',classes:[node('Order'),node('Item')],relationships:[relation('r1','composition')]});
type Box=Extract<CanvasPrimitive,{type:'box'}>;type Label=Extract<CanvasPrimitive,{type:'label'}>;type Line=Extract<CanvasPrimitive,{type:'line'}>;type Rect={x:number;y:number;width:number;height:number};
const boxes=(doc:CanvasPresentationDocument)=>doc.slides[0].elements.filter((e):e is Box=>e.type==='box');
const labels=(doc:CanvasPresentationDocument)=>doc.slides[0].elements.filter((e):e is Label=>e.type==='label');
const lines=(doc:CanvasPresentationDocument)=>doc.slides[0].elements.filter((e):e is Line=>e.type==='line');
const flat=(text:string)=>text.replaceAll('\n','');
const graphemes=(text:string)=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].map(part=>part.segment);
const overlap=(a:Rect,b:Rect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
function crossesInterior(line:Line,rect:Rect){
  // Clip against a slightly inset rectangle so border contact remains valid.
  const bounds={x:rect.x+0.001,y:rect.y+0.001,width:rect.width-0.002,height:rect.height-0.002};let low=0,high=1;
  const dx=line.x2-line.x1,dy=line.y2-line.y1;
  for(const [p,q] of [[-dx,line.x1-bounds.x],[dx,bounds.x+bounds.width-line.x1],[-dy,line.y1-bounds.y],[dy,bounds.y+bounds.height-line.y1]]){if(p===0){if(q<0)return false;}else{const value=q/p;if(p<0)low=Math.max(low,value);else high=Math.min(high,value);if(low>high)return false;}}return true;
}
function sharedSegment(a:Line,b:Line){
  if(a.x1===a.x2&&b.x1===b.x2&&a.x1===b.x1)return Math.min(Math.max(a.y1,a.y2),Math.max(b.y1,b.y2))>Math.max(Math.min(a.y1,a.y2),Math.min(b.y1,b.y2));
  if(a.y1===a.y2&&b.y1===b.y2&&a.y1===b.y1)return Math.min(Math.max(a.x1,a.x2),Math.max(b.x1,b.x2))>Math.max(Math.min(a.x1,a.x2),Math.min(b.x1,b.x2));return false;
}
function assertGeometry(document:CanvasPresentationDocument){
  assert.equal(document.format,'canvas-v1');assert.equal(document.slides.length,1);assert.ok(validatePresentationDocument(document));const page=document.slides[0];assert.ok(page.width<=3600&&page.height<=1200);
  const text=labels(document);for(const label of text){assert.ok(label.fontSize>=18);assert.ok(label.height>=22*label.text.split('\n').length);for(const row of label.text.split('\n'))if(/^[^\x20-\x7e]+$/u.test(row))assert.ok(graphemes(row).length*18<=label.width);}
  for(let i=0;i<text.length;i++)for(let j=i+1;j<text.length;j++)assert.ok(!overlap(text[i],text[j]),`Text overlap ${text[i].id}, ${text[j].id}`);
  const edges=lines(document).filter(line=>line.id.startsWith('relationship:'));
  for(const line of edges){for(const label of text)assert.ok(!crossesInterior(line,label),`Edge obscures ${label.id}`);for(const card of boxes(document).filter(box=>box.id.startsWith('class:')))assert.ok(!crossesInterior(line,card),`Edge obscures ${card.id}`);}
  const routes=edges.filter(line=>line.id.includes(':route:'));for(let i=0;i<routes.length;i++)for(let j=i+1;j<routes.length;j++)if(routes[i].id.split(':')[1]!==routes[j].id.split(':')[1])assert.ok(!sharedSegment(routes[i],routes[j]),`Merged routes ${routes[i].id}, ${routes[j].id}`);
}
function assertContent(document:CanvasPresentationDocument,diagram:ClassDiagram){
  const rendered=labels(document).map(label=>flat(label.text));
  for(const text of diagram.classes.flatMap(node=>[node.name,...node.attributes,...node.operations]))assert.ok(rendered.includes(text),`Missing class text ${text}`);
  for(const relationship of diagram.relationships)for(const text of [relationship.label,relationship.fromMultiplicity,relationship.toMultiplicity])if(text)assert.ok(rendered.includes(text),`Missing relationship text ${text}`);
}

test('class cards retain complete named compartments and immutable deterministic bounded geometry',async()=>{
  const {layout}=await components(),diagram=basic();diagram.classes[0].name='주문 & Order';diagram.classes[0].annotation='abstract';const before=structuredClone(diagram),document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);assert.deepEqual(diagram,before);assert.deepEqual(layout.layoutClassDiagram(diagram),document);
  for(const type of diagram.classes){const card=boxes(document).find(box=>box.id===`class:${type.id}`)!,dividers=lines(document).filter(line=>line.id.startsWith(`class:${type.id}:divider:`));assert.ok(card);assert.equal(dividers.length,2);assert.ok(dividers[0].y1<dividers[1].y1);for(const field of labels(document).filter(label=>label.id.startsWith(`class:${type.id}:attribute:`)))assert.ok(field.y>=dividers[0].y1&&field.y+field.height<=dividers[1].y1);for(const field of labels(document).filter(label=>label.id.startsWith(`class:${type.id}:operation:`)))assert.ok(field.y>=dividers[1].y1&&field.y+field.height<=card.y+card.height);}
  assert.ok(labels(document).some(label=>label.text.includes('abstract')));assert.ok(labels(document).some(label=>label.text.includes('범례')));
});
test('every relation kind retains its semantic marker endpoint in either left-to-right or right-to-left order',async()=>{
  const {layout}=await components();
  for(const kind of ['inheritance','composition','aggregation','association','dependency','realization','solid-link','dashed-link'] as const)for(const reverse of [false,true]){
    const diagram=basic();diagram.relationships=[relation('edge',kind,reverse?'Item':'Order',reverse?'Order':'Item',null)];const document=layout.layoutClassDiagram(diagram);assertGeometry(document);
    const edge=diagram.relationships[0],route=lines(document).filter(line=>line.id.startsWith('relationship:edge:route:')),markerLines=lines(document).filter(line=>line.id.startsWith('relationship:edge:marker:')),markerBoxes=boxes(document).filter(box=>box.id.startsWith('relationship:edge:marker:'));
    assert.equal(route.length,3);assert.ok(route.every(line=>line.arrow==='none'));assert.ok(route.every(line=>line.dash===(['dependency','realization','dashed-link'].includes(kind)?'dash':'solid')));
    const endpoint=boxes(document).find(box=>box.id===`class:${kind==='composition'||kind==='aggregation'?edge.from:edge.to}`)!;
    if(kind==='composition'){assert.equal(markerBoxes.length,1);assert.equal(markerBoxes[0].geometry,'diamond');assert.equal(markerBoxes[0].fill,'ink');assert.equal(markerBoxes[0].y,endpoint.y+endpoint.height);assert.ok(markerBoxes[0].x>endpoint.x&&markerBoxes[0].x+markerBoxes[0].width<endpoint.x+endpoint.width);assert.equal(route[0].y1,markerBoxes[0].y+markerBoxes[0].height);}
    else if(kind==='aggregation'){assert.equal(markerLines.length,4);assert.equal(Math.min(...markerLines.flatMap(line=>[line.y1,line.y2])),endpoint.y+endpoint.height);assert.equal(route[0].y1,Math.max(...markerLines.flatMap(line=>[line.y1,line.y2])));}
    else if(kind==='inheritance'||kind==='realization'){assert.equal(markerLines.length,3);assert.equal(Math.min(...markerLines.flatMap(line=>[line.y1,line.y2])),endpoint.y+endpoint.height);assert.equal(route[2].y2,Math.max(...markerLines.flatMap(line=>[line.y1,line.y2])),'stem stops at the triangle base');}
    else if(kind==='association'||kind==='dependency'){assert.equal(markerLines.length,2);assert.equal(route[2].y2,endpoint.y+endpoint.height);}
    else {assert.equal(markerLines.length,0);assert.equal(markerBoxes.length,0);}
  }
});
test('multiple endpoint multiplicities stay beside their own class ports without masking other stems or markers',async()=>{
  const {layout}=await components(),diagram=basic();diagram.classes.push(node('Payment'));diagram.relationships=[{...relation('a','composition'),fromMultiplicity:'1',toMultiplicity:'0..*'},{...relation('b','association','Payment','Order','pays'),fromMultiplicity:'100..999',toMultiplicity:'0..1'},{...relation('c','dependency','Order','Payment','uses'),fromMultiplicity:'*',toMultiplicity:'2..20'}];const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);
  const laneTop=Math.min(...lines(document).filter(line=>line.id.endsWith(':route:span')).map(line=>line.y1));
  for(const edge of diagram.relationships)for(const side of ['from','to'] as const){const label=labels(document).find(label=>label.id===`relationship:${edge.id}:multiplicity:${side}`)!,card=boxes(document).find(box=>box.id===`class:${edge[side]}`)!;assert.ok(label.y>=card.y+card.height+28);assert.ok(label.y+label.height<laneTop);assert.ok(label.x>=card.x&&label.x+label.width<=card.x+card.width);}
});
test('cycles and parallel relationships use independent lanes and unobstructed labels between cards',async()=>{
  const {layout}=await components(),diagram=basic();diagram.classes.push(node('Payment'));diagram.relationships=[relation('a','association'),relation('b','dependency','Item','Order','returns'),relation('c','solid-link','Order','Item','audits'),relation('d','realization','Payment','Order','implements'),relation('e','aggregation','Item','Payment','groups')];const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);const spans=lines(document).filter(line=>line.id.endsWith(':route:span'));assert.equal(new Set(spans.map(line=>line.y1)).size,diagram.relationships.length);
  for(const label of labels(document).filter(label=>label.id.endsWith(':label')))for(const card of boxes(document).filter(box=>box.id.startsWith('class:')))assert.ok(label.x+label.width<=card.x||label.x>=card.x+card.width,'relationship labels occupy gaps without vertical stems');
});
test('ordinary six-class ten-relationship diagrams retain all members and fit one useful overview',async()=>{
  const {layout}=await components();const diagram:ClassDiagram={kind:'class',classes:Array.from({length:6},(_,i)=>node(`Class${i}`,['+id: string','-active: bool'],['+save(): void','+load(id): void'])),relationships:Array.from({length:10},(_,i)=>({...relation(`edge${i}`,i%2?'association':'dependency',`Class${i%6}`,`Class${(i+1)%6}`,`uses ${i}`),fromMultiplicity:i%3===0?'1':null,toMultiplicity:i%3===0?'0..*':null}))};const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);assert.ok(document.slides[0].width<=3400);
});
test('product example keeps short ASCII members and names on one line and wraps longer signatures at readable boundaries',async()=>{
  const {layout}=await components(),diagram=parseClassDiagram(classSample),document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);
  for(const field of ['+name: String','+save(): bool','+model: String','+run(): Result','LocalRepository']){const rendered=labels(document).find(label=>flat(label.text)===field)!;assert.equal(rendered.text,field,'short ASCII text should not strand its final character on a new line');}
  for(const rendered of labels(document).filter(label=>flat(label.text)==='+execute(task: Task): Result'))for(const row of rendered.text.split('\n').slice(0,-1))assert.match(row,/[\s():,]$/u);
});
test('full Unicode names and members preserve combining marks, joined emoji and flags across wrapping',async()=>{
  const {layout}=await components(),diagram=basic();diagram.classes[0].name='a'.repeat(16)+'e\u0301'+'한'.repeat(20);diagram.classes[0].attributes=['+설명: '+'한'.repeat(60)+'👩‍👩‍👧‍👦'+'글'.repeat(60)];diagram.classes[1].operations=['+메서드('+ 'a'.repeat(45)+'🇰🇷'+'): void'];diagram.relationships[0].label='r'.repeat(15)+'e\u0301'+'설명'.repeat(45);const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);
  for(const text of [diagram.classes[0].name,...diagram.classes[0].attributes,...diagram.classes[1].operations,diagram.relationships[0].label!]){const label=labels(document).find(label=>flat(label.text)===text)!;assert.deepEqual(label.text.split('\n').flatMap(graphemes),graphemes(text));}assert.ok(labels(document).some(label=>label.text.includes('\n')));
});
test('wide ASCII, CJK and emoji retain conservative room while word wrapping preserves repeated spaces',async()=>{
  const {layout}=await components(),diagram=basic();const wide='+value: '+'W@M한🙂'.repeat(20),spaced='+value: '+'Alpha  Beta,  '.repeat(8)+'Tail';diagram.classes[0].attributes=[wide,spaced];const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);
  const rendered=labels(document).find(label=>flat(label.text)===wide)!;
  for(const row of rendered.text.split('\n'))assert.ok(graphemes(row).filter(part=>/^[W@M한🙂]$/u.test(part)).length*18<=rendered.width,'wide glyphs must not receive narrow Latin allowances');
  const spacedLabel=labels(document).find(label=>flat(label.text)===spaced)!;assert.ok(spacedLabel.text.includes('\n'));assert.equal(flat(spacedLabel.text),spaced);assert.ok(spacedLabel.text.includes('  '));
});
test('empty compartments and disconnected classes remain visible without inventing relationships',async()=>{
  const {layout}=await components();const diagram:ClassDiagram={kind:'class',classes:[node('Standalone',[],[]),{...node('Contract',[],[]),annotation:'interface'}],relationships:[]};const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);assert.equal(boxes(document).filter(box=>box.id.startsWith('class:')).length,2);assert.equal(lines(document).filter(line=>line.id.startsWith('relationship:')).length,0);
});
test('ten short classes and twenty unlabeled relationships can use compact cards without dropping the declared maximum',async()=>{
  const {layout}=await components();const diagram:ClassDiagram={kind:'class',classes:Array.from({length:10},(_,i)=>node(`Class${i}`,[],[])),relationships:Array.from({length:20},(_,i)=>relation(`edge${i}`,'association',`Class${i%10}`,`Class${(i+1+Math.floor(i/10))%10}`,null))};const document=layout.layoutClassDiagram(diagram);assertGeometry(document);assertContent(document,diagram);assert.equal(boxes(document).filter(box=>box.id.startsWith('class:')).length,10);assert.equal(lines(document).filter(line=>line.id.endsWith(':route:span')).length,20);
});
test('valid high-degree wide multiplicities fail explicitly before any partial SVG is rendered',async()=>{
  const {layout,preview}=await components();const diagram:ClassDiagram={kind:'class',classes:Array.from({length:10},(_,i)=>node(`Class${i}`,[],[])),relationships:Array.from({length:20},(_,i)=>({...relation(`edge${i}`,'association',`Class${i%10}`,`Class${(i+1+Math.floor(i/10))%10}`,`link ${i}`),fromMultiplicity:'100..999',toMultiplicity:'100..999'}))};assert.throws(()=>layout.layoutClassDiagram(diagram),/^Error: CLASS_LAYOUT_LIMIT$/);const html=renderToStaticMarkup(createElement(preview.ClassDiagramPreview,{diagram}));assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg/);
});
test('overfull member text cannot be silently truncated, shrunk or omitted to fit',async()=>{
  const {layout}=await components();const diagram:ClassDiagram={kind:'class',classes:Array.from({length:5},(_,i)=>node(`Class${i}`,Array.from({length:16},(_,member)=>`+field${member}: `+'한'.repeat(140)),[])),relationships:[]};assert.throws(()=>layout.layoutClassDiagram(diagram),/^Error: CLASS_LAYOUT_LIMIT$/);
});
test('malformed ASTs cannot bypass validation and never produce partial SVG',async()=>{
  const {layout,preview}=await components();for(const bad of [null,{...basic(),kind:'sequence'},{...basic(),html:'<script>x</script>'},{...basic(),classes:[{...node('Bad'),name:'<img src=x>'}]}]){assert.throws(()=>layout.layoutClassDiagram(bad as ClassDiagram),/^Error: INVALID_CLASS_DIAGRAM$/);const html=renderToStaticMarkup(createElement(preview.ClassDiagramPreview,{diagram:bad as ClassDiagram}));assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg|<script/);}
});
test('actual fixed preview escapes user labels and stays inert while exposing native-sized keyboard scrolling',async()=>{
  const {layout,preview}=await components(),diagram=basic();diagram.classes[0].name='Order & Team';diagram.classes[0].attributes.push('+caption: "quoted" & string');const document=layout.layoutClassDiagram(diagram),html=renderToStaticMarkup(createElement(preview.ClassDiagramPreview,{diagram}));assert.match(html,/Order &amp; Team/);assert.match(html,/&quot;quoted&quot; &amp; string/);assert.match(html,/tabindex="0"/);assert.match(html,/방향키로 스크롤/);assert.match(html,/사용자.*작성/);assert.match(html,/소스 코드/);assert.match(html,new RegExp(`viewBox="0 0 ${document.slides[0].width} ${document.slides[0].height}"`));assert.doesNotMatch(html,/<a\b|<button\b|<input\b|<iframe\b|<foreignObject\b|<script\b|href=/);
});
