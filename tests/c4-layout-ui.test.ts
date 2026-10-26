import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {C4Diagram,C4Element,C4Relationship} from '../shared/c4.ts';
import type {CanvasPresentationDocument,CanvasPrimitive} from '../shared/canvas.ts';
import {validatePresentationDocument} from '../web/visualization/presentation.ts';
import {validateC4} from '../web/visualization/c4.ts';
import {c4Samples} from '../web/visualization/c4-samples.ts';

async function components(){
  assert.ok(existsSync(new URL('../web/visualization/c4-layout.ts',import.meta.url)),'C4 layout is not implemented');
  const root=new URL('../web/visualization/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return {layout:await import('../web/visualization/c4-layout.ts'),preview:await import('../web/visualization/C4Preview.tsx')};}finally{hooks.deregister();}
}
const element=(id:string,kind:C4Element['kind'],name:string,parentId:string|null=null,technology:string|null=null,description='책임을 설명합니다.'):C4Element=>({id,kind,name,description,parentId,technology});
const relation=(id:string,from:string,to:string,description:string,technology:string|null=null):C4Relationship=>({id,from,to,description,technology});
const context=():C4Diagram=>({format:'c4-v1',title:'주문 시스템의 주변 관계',view:'context',scope:'orders',elements:[element('customer','person','Customer & Client'),element('orders','system','Orders'),element('payment','system','Payment')],relationships:[relation('buy','customer','orders','주문을 요청합니다.'),relation('pay','orders','payment','결제를 요청합니다.')]});
const container=():C4Diagram=>({format:'c4-v1',title:'주문 컨테이너',view:'container',scope:'orders',elements:[element('orders','system','Orders'),element('customer','person','Customer'),element('web','container','Web','orders','React'),element('api','container','API','orders','Node.js'),element('payment','system','Payment')],relationships:[relation('browse','customer','web','화면을 사용합니다.'),relation('request','web','api','주문을 전송합니다.','JSON over HTTPS'),relation('pay','api','payment','결제를 요청합니다.')]});
const component=():C4Diagram=>({format:'c4-v1',title:'주문 API 내부',view:'component',scope:'api',elements:[element('orders','system','Orders'),element('api','container','API','orders','Node.js'),element('web','container','Web','orders','React'),element('controller','component','Controller','api','TypeScript'),element('service','component','Service','api','TypeScript'),element('payment','system','Payment')],relationships:[relation('request','web','controller','주문을 전송합니다.','JSON over HTTPS'),relation('delegate','controller','service','처리를 위임합니다.'),relation('pay','service','payment','결제를 요청합니다.')]});
type Box=Extract<CanvasPrimitive,{type:'box'}>;type Label=Extract<CanvasPrimitive,{type:'label'}>;type Line=Extract<CanvasPrimitive,{type:'line'}>;
const labels=(doc:CanvasPresentationDocument)=>doc.slides[0].elements.filter((e):e is Label=>e.type==='label');
const boxes=(doc:CanvasPresentationDocument)=>doc.slides[0].elements.filter((e):e is Box=>e.type==='box');
const lines=(doc:CanvasPresentationDocument)=>doc.slides[0].elements.filter((e):e is Line=>e.type==='line');
const flat=(text:string)=>text.replaceAll('\n','');
const graphemes=(value:string)=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(value)].map(p=>p.segment);
const overlaps=(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number})=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const contains=(outer:Box,inner:{x:number;y:number;width:number;height:number})=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
function crossesInterior(line:Line,rect:{x:number;y:number;width:number;height:number}){
  if(line.y1===line.y2)return line.y1>rect.y&&line.y1<rect.y+rect.height&&Math.max(line.x1,line.x2)>rect.x&&Math.min(line.x1,line.x2)<rect.x+rect.width;
  assert.equal(line.x1,line.x2,'C4 connectors are orthogonal');return line.x1>rect.x&&line.x1<rect.x+rect.width&&Math.max(line.y1,line.y2)>rect.y&&Math.min(line.y1,line.y2)<rect.y+rect.height;
}
function sharesSegment(a:Line,b:Line){
  if(a.y1===a.y2&&b.y1===b.y2&&a.y1===b.y1)return Math.min(Math.max(a.x1,a.x2),Math.max(b.x1,b.x2))>Math.max(Math.min(a.x1,a.x2),Math.min(b.x1,b.x2));
  if(a.x1===a.x2&&b.x1===b.x2&&a.x1===b.x1)return Math.min(Math.max(a.y1,a.y2),Math.max(b.y1,b.y2))>Math.max(Math.min(a.y1,a.y2),Math.min(b.y1,b.y2));return false;
}
function assertGeometry(doc:CanvasPresentationDocument){
  assert.equal(doc.format,'canvas-v1');assert.equal(doc.slides.length,1);assert.ok(validatePresentationDocument(doc));
  const slide=doc.slides[0];assert.ok(slide.width<=3600&&slide.height<=1200);assert.equal(new Set(slide.elements.map(e=>e.id)).size,slide.elements.length);
  const text=labels(doc);
  for(const e of text){assert.ok(e.fontSize>=18);assert.ok(e.height>=e.text.split('\n').length*22);for(const line of e.text.split('\n'))assert.ok(graphemes(line).length*18<=e.width,JSON.stringify(e));}
  for(let a=0;a<text.length;a++)for(let b=a+1;b<text.length;b++)assert.ok(!overlaps(text[a],text[b]),`Text overlaps: ${text[a].id}, ${text[b].id}`);
  const connectors=lines(doc).filter(e=>e.id.startsWith('relationship:'));
  for(let i=0;i<connectors.length;i++)for(let j=i+1;j<connectors.length;j++)if(connectors[i].id.split(':')[1]!==connectors[j].id.split(':')[1])assert.ok(!sharesSegment(connectors[i],connectors[j]),`Relationship lines merge: ${connectors[i].id}, ${connectors[j].id}`);
  for(const line of connectors){
    for(const box of boxes(doc).filter(e=>e.id.startsWith('node:')))assert.ok(!crossesInterior(line,box),`Connector obscures card ${box.id}`);
    for(const label of text)assert.ok(!crossesInterior(line,label),`Connector obscures text ${label.id}`);
  }
}
function assertAllText(doc:CanvasPresentationDocument,diagram:C4Diagram){
  const rendered=labels(doc).map(e=>flat(e.text));
  for(const text of [diagram.title,...diagram.elements.flatMap(e=>[e.name,e.description,...(e.technology?[e.technology]:[])]),...diagram.relationships.flatMap(e=>[e.description,...(e.technology?[e.technology]:[])])])assert.ok(rendered.includes(text),`Missing complete text: ${text}`);
}

test('context layout retains all authored fields, legend and directed relationships in deterministic compact geometry',async()=>{
  const {layout}=await components(),diagram=context(),before=structuredClone(diagram),document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);assert.deepEqual(diagram,before);assert.deepEqual(layout.layoutC4(diagram),document);
  assert.ok(document.slides[0].width<=2000);assert.equal(lines(document).filter(e=>e.arrow==='triangle').length,2);assert.ok(labels(document).some(e=>e.text.includes('범례')));assert.ok(labels(document).some(e=>e.text.includes('시스템 컨텍스트')));assert.ok(labels(document).some(e=>e.text.includes('외부')));
});
test('container view encloses only owned containers and keeps every card field inside its card',async()=>{
  const {layout}=await components(),diagram=container(),document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);
  const boundary=boxes(document).find(e=>e.id==='boundary:orders')!;assert.ok(boundary);
  for(const id of ['web','api']){const box=boxes(document).find(e=>e.id===`node:${id}`)!;assert.ok(contains(boundary,box));for(const label of labels(document).filter(e=>e.id.startsWith(`node:${id}:`)))assert.ok(contains(box,label));}
  for(const id of ['customer','payment'])assert.ok(!overlaps(boundary,boxes(document).find(e=>e.id===`node:${id}`)!));
});
test('component view preserves nested scope boundaries and sibling containers outside the inner scope',async()=>{
  const {layout}=await components(),diagram=component(),document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);
  const outer=boxes(document).find(e=>e.id==='boundary:orders')!,inner=boxes(document).find(e=>e.id==='boundary:api')!,sibling=boxes(document).find(e=>e.id==='node:web')!;assert.ok(contains(outer,inner));assert.ok(contains(outer,sibling));assert.ok(!overlaps(inner,sibling));
  assert.notEqual(sibling.fill,'blue','a sibling container is outside the selected container scope');
  for(const id of ['controller','service'])assert.ok(contains(inner,boxes(document).find(e=>e.id===`node:${id}`)!));assert.ok(!overlaps(outer,boxes(document).find(e=>e.id==='node:payment')!));
});
test('all product starter examples render complete geometry with unambiguous separate relationship lines',async()=>{
  const {layout}=await components();
  for(const diagram of Object.values(c4Samples)){
    const document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);assert.equal(lines(document).filter(e=>e.arrow==='triangle').length,diagram.relationships.length);
  }
});
test('cycles and parallel relationships retain distinct labels, ports and correctly directed arrow endpoints',async()=>{
  const {layout}=await components(),diagram=context();diagram.relationships=[relation('a','customer','orders','Send order'),relation('b','orders','customer','Return receipt'),relation('c','customer','orders','Cancel order'),relation('d','orders','payment','Authorize'),relation('e','payment','orders','Return result')];const document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);
  const endings=new Set<string>();
  for(const relationship of diagram.relationships){const route=lines(document).filter(e=>e.id.startsWith(`relationship:${relationship.id}:`));assert.ok(route.length>=1);const arrow=route.filter(e=>e.arrow==='triangle');assert.equal(arrow.length,1);const source=boxes(document).find(e=>e.id===`node:${relationship.from}`)!,target=boxes(document).find(e=>e.id===`node:${relationship.to}`)!;
    for(const [box,x,y] of [[source,route[0].x1,route[0].y1],[target,arrow[0].x2,arrow[0].y2]] as const)assert.ok((x===box.x||x===box.x+box.width)&&y>box.y&&y<box.y+box.height||(y===box.y||y===box.y+box.height)&&x>box.x&&x<box.x+box.width);
    const key=`${arrow[0].x2},${arrow[0].y2}`;assert.ok(!endings.has(key),'parallel relations use distinct attachment points');endings.add(key);}
});
test('long Unicode fields wrap completely without splitting combining marks, joined emoji or flags',async()=>{
  const {layout}=await components(),diagram=context();diagram.elements=diagram.elements.slice(0,2);diagram.relationships=diagram.relationships.slice(0,1);
  diagram.title='a'.repeat(36)+'e\u0301'+'한'.repeat(25);diagram.elements[0].name='a'.repeat(15)+'👩‍👩‍👧‍👦'+'한국어'.repeat(9);diagram.elements[1].description='한'.repeat(72)+'🇰🇷'+'글'.repeat(72);diagram.relationships[0].description='r'.repeat(15)+'e\u0301'+'설명'.repeat(45);
  const document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);
  for(const text of [diagram.title,diagram.elements[0].name,diagram.elements[1].description,diagram.relationships[0].description]){const rendered=labels(document).find(e=>flat(e.text)===text)!;assert.deepEqual(rendered.text.split('\n').flatMap(graphemes),graphemes(text));}assert.ok(labels(document).some(e=>e.text.includes('\n')));
});
test('six alternating parallel relationships retain separate complete labels and nonmerged native routes',async()=>{
  const {layout}=await components(),diagram=context();diagram.elements=diagram.elements.slice(0,2);diagram.relationships=Array.from({length:6},(_,i)=>relation(`parallel${i}`,i%2?'orders':'customer',i%2?'customer':'orders',`Relationship ${i}`));const document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);assert.equal(lines(document).filter(e=>e.arrow==='triangle').length,6);
});
test('disconnected authored leaves and an empty relationship list remain visible',async()=>{
  const {layout}=await components(),diagram=container();diagram.relationships=[];const document=layout.layoutC4(diagram);assertGeometry(document);assertAllText(document,diagram);assert.equal(lines(document).filter(e=>e.arrow==='triangle').length,0);
});
test('dense overfull content returns the fixed layout limit instead of dropping fields or shrinking text',async()=>{
  const {layout}=await components();const diagram:C4Diagram={format:'c4-v1',title:'한'.repeat(80),view:'context',scope:'s0',elements:Array.from({length:12},(_,i)=>element(`s${i}`,'system','한'.repeat(80),null,null,'설'.repeat(160))),relationships:Array.from({length:24},(_,i)=>relation(`r${i}`,`s${i%12}`,`s${(i+1+Math.floor(i/12))%12}`,'관'.repeat(160),'기'.repeat(80)))};assert.ok(validateC4(diagram).ok);assert.throws(()=>layout.layoutC4(diagram),/^Error: C4_LAYOUT_LIMIT$/);
});
test('dense short-label routing is bounded and returns no partial preview when its work budget is exhausted',async()=>{
  const {layout,preview}=await components();const diagram:C4Diagram={format:'c4-v1',title:'Dense',view:'context',scope:'s0',elements:Array.from({length:12},(_,i)=>element(`s${i}`,'system',`s${i}`,null,null,'Element')),relationships:Array.from({length:24},(_,i)=>relation(`r${i}`,`s${i%12}`,`s${(i+1+Math.floor(i/12))%12}`,`r${i}`))};assert.ok(validateC4(diagram).ok);assert.throws(()=>layout.layoutC4(diagram),/^Error: C4_LAYOUT_LIMIT$/);const html=renderToStaticMarkup(createElement(preview.C4Preview,{diagram}));assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg/);
});
test('malformed or active content fails before geometry and renders no partial SVG',async()=>{
  const {layout,preview}=await components();for(const bad of [null,{...context(),scope:'missing'},{...context(),html:'<script>x</script>'},{...context(),elements:[{...context().elements[0],name:'<script>alert(1)</script>'}]}]){assert.throws(()=>layout.layoutC4(bad as C4Diagram),/^Error: INVALID_C4$/);const html=renderToStaticMarkup(createElement(preview.C4Preview,{diagram:bad as C4Diagram}));assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg|<script/);}
});
test('real preview escapes authored text and exposes keyboard scrolling without links or automatic actions',async()=>{
  const {layout,preview}=await components(),diagram=context();diagram.title='Orders & "Team"';const document=layout.layoutC4(diagram);const html=renderToStaticMarkup(createElement(preview.C4Preview,{diagram}));assert.match(html,/Orders &amp; &quot;Team&quot;/);assert.match(html,/tabindex="0"/);assert.match(html,/방향키로 스크롤/);assert.match(html,/사용자.*작성/);assert.match(html,/소스 코드/);assert.doesNotMatch(html,/<a\b|<button\b|<input\b|<iframe\b|<foreignObject\b|<script\b|href=/);assert.match(html,new RegExp(`viewBox="0 0 ${document.slides[0].width} ${document.slides[0].height}"`));assert.match(html,new RegExp(`width:${document.slides[0].width}px`));
});
