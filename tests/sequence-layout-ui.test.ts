import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {SequenceDiagram,SequenceEvent,SequencePresentationDocument,SequencePrimitive} from '../shared/sequence.ts';

async function components(){
  assert.ok(existsSync(new URL('../web/visualization/sequence-layout.ts',import.meta.url)),'Sequence layout is not implemented');
  const root=new URL('../web/visualization/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return {layout:await import('../web/visualization/sequence-layout.ts'),preview:await import('../web/visualization/SequencePreview.tsx')};}finally{hooks.deregister();}
}
const message=(text:string,from='A',to='B',arrow:'solid'|'dashed'='solid'):SequenceEvent=>({type:'message',from,to,arrow,text});
const basic=(events:SequenceEvent[]=[message('Request'),message('Reply','B','A','dashed'),message('Self call','A','A')]):SequenceDiagram=>({kind:'sequence',participants:[{id:'A',label:'사용자 & Client',kind:'actor'},{id:'B',label:'로컬 서버',kind:'participant'}],autonumber:false,events});
type Label=Extract<SequencePrimitive,{type:'label'}>;
const labels=(document:SequencePresentationDocument)=>document.slides.flatMap(slide=>slide.elements.filter((e):e is Label=>e.type==='label'));
const unwrapped=(value:string)=>value.replaceAll('\n','');
const graphemes=(value:string)=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(value)].map(part=>part.segment);
function assertBounded(document:SequencePresentationDocument){
  assert.equal(document.format,'sequence-v1');assert.ok(document.slides.length>0&&document.slides.length<=32);
  assert.ok(document.slides.reduce((total,slide)=>total+slide.elements.length,0)<=8000);assert.ok(new TextEncoder().encode(JSON.stringify(document)).length<=1024*1024);
  for(const slide of document.slides){
    assert.equal(slide.width,document.slides[0].width);assert.equal(slide.height,document.slides[0].height);assert.ok(slide.width<=3600&&slide.height<=1200);assert.ok(slide.elements.length<=800);
    assert.equal(new Set(slide.elements.map(e=>e.id)).size,slide.elements.length);
    for(const e of slide.elements){
      if(e.type==='line'){
        for(const [x,y] of [[e.x1,e.y1],[e.x2,e.y2]]){assert.ok(Number.isFinite(x)&&Number.isFinite(y));assert.ok(x>=0&&x<=slide.width&&y>=0&&y<=slide.height,JSON.stringify(e));}
        assert.ok(Math.hypot(e.x2-e.x1,e.y2-e.y1)>=1,JSON.stringify(e));
      }else{
        for(const value of [e.x,e.y,e.width,e.height])assert.ok(Number.isFinite(value));assert.ok(e.x>=0&&e.y>=0&&e.width>=1&&e.height>=1&&e.x+e.width<=slide.width&&e.y+e.height<=slide.height,JSON.stringify(e));
        if(e.type==='label'){
          assert.ok(e.fontSize>=17&&e.fontSize<=48);assert.ok(e.text.length<=512);assert.ok(e.height>=e.text.split('\n').length*e.fontSize);
          for(const line of e.text.split('\n'))assert.ok(graphemes(line).length*e.fontSize<=e.width,JSON.stringify(e));
        }
      }
    }
  }
}

test('layout preserves solid, dashed, self-call and actor semantics with bounded deterministic native geometry',async()=>{
  const {layout}=await components();const diagram=basic(),before=structuredClone(diagram),document=layout.layoutSequence(diagram);assertBounded(document);assert.deepEqual(diagram,before);assert.deepEqual(layout.layoutSequence(diagram),document);
  const page=document.slides[0],arrows=page.elements.filter(e=>e.type==='line'&&e.arrow==='triangle');assert.equal(arrows.length,3);assert.ok(arrows.some(e=>e.type==='line'&&e.dash==='dash'&&e.x1>e.x2));assert.ok(page.elements.some(e=>e.type==='box'&&e.geometry==='ellipse'));
  const self=labels(document).find(e=>unwrapped(e.text)==='Self call')!;assert.ok(self);
  const route=page.elements.filter(e=>e.type==='line'&&e.dash==='solid'&&e.y1>=self.y+self.height&&e.y2>=self.y+self.height&&e.y1<self.y+self.height+45&&e.y2<self.y+self.height+45);
  assert.ok(route.some(e=>e.type==='line'&&e.x1===e.x2&&e.y2>e.y1));assert.ok(route.some(e=>e.type==='line'&&e.arrow==='triangle'&&e.x2<e.x1));
  for(const text of ['사용자 & Client','로컬 서버','Request','Reply','Self call'])assert.ok(labels(document).some(e=>unwrapped(e.text)===text),text);
});

test('ordinary two-participant diagrams keep a readable compact canvas without reserving long-label margins',async()=>{
  const {layout}=await components();const document=layout.layoutSequence(basic());assertBounded(document);assert.ok(document.slides[0].width<=1200,'short diagrams should fit a normal preview region');
});

test('notes preserve left, right and over placement while long Unicode labels wrap without truncation',async()=>{
  const {layout}=await components();const long='한🙂'.repeat(80);const diagram=basic([{type:'note',placement:'left',participants:['A'],text:long},{type:'note',placement:'right',participants:['B'],text:'Right note'},{type:'note',placement:'over',participants:['A','B'],text:'Over both'}]);diagram.participants[0].label=long;
  const document=layout.layoutSequence(diagram);assertBounded(document);
  assert.ok(labels(document).filter(e=>unwrapped(e.text)===long).length>=2);assert.ok(labels(document).some(e=>e.text.includes('\n')));assert.ok(!labels(document).some(e=>e.text.includes('…')));
  const notes=document.slides.flatMap(slide=>slide.elements.filter(e=>e.type==='box'&&e.fill==='note'));assert.equal(notes.length,3);assert.ok(notes.every(e=>e.type==='box'&&e.width>0&&e.height>0));
  const page=document.slides[0],lifelines=page.elements.filter(e=>e.type==='line'&&e.dash==='dash'&&e.x1===e.x2);
  const [a,b]=lifelines.map(e=>e.type==='line'?e.x1:0).sort((x,y)=>x-y);
  assert.ok(notes[0].type==='box'&&notes[0].x+notes[0].width<a);assert.ok(notes[1].type==='box'&&notes[1].x>b);assert.ok(notes[2].type==='box'&&notes[2].x<a&&notes[2].x+notes[2].width>b);
});

test('wrapping preserves combining characters, joined emoji and flags as indivisible visible characters',async()=>{
  const {layout}=await components();
  for(const text of ['a'.repeat(43)+'e\u0301'+'z'.repeat(40),'a'.repeat(40)+'👩‍👩‍👧‍👦'+'z'.repeat(40),'a'.repeat(43)+'🇰🇷'+'z'.repeat(40)]){
    const document=layout.layoutSequence(basic([message(text,'A','A')]));assertBounded(document);
    const rendered=labels(document).find(e=>unwrapped(e.text)===text)!;assert.ok(rendered);assert.deepEqual(rendered.text.split('\n').flatMap(graphemes),graphemes(text));
  }
});

test('autonumber applies in source order across pages and does not number notes or activation events',async()=>{
  const {layout}=await components();const diagram=basic([{type:'activation',participant:'A',action:'activate'},message('First'),{type:'note',placement:'over',participants:['A'],text:'Aside'},message('Second'),{type:'activation',participant:'A',action:'deactivate'}]);diagram.autonumber=true;
  const document=layout.layoutSequence(diagram);assertBounded(document);const text=labels(document).map(e=>unwrapped(e.text));assert.ok(text.includes('1. First'));assert.ok(text.includes('2. Second'));assert.ok(text.includes('Aside'));assert.ok(!text.includes('2. Aside'));
});

test('adjacent activation and deactivation connect to their matching message boundaries including self returns',async()=>{
  const {layout}=await components();
  for(const first of [message('Incoming','A','B'),message('Self incoming','B','B')]){
    const document=layout.layoutSequence(basic([first,{type:'activation',participant:'B',action:'activate'},message('Outgoing','B','A'),{type:'activation',participant:'B',action:'deactivate'}]));assertBounded(document);
    const arrows=document.slides[0].elements.filter(e=>e.type==='line'&&e.arrow==='triangle'),bar=document.slides[0].elements.find(e=>e.type==='box'&&e.fill==='blue');assert.ok(bar&&bar.type==='box');assert.equal(arrows.length,2);
    assert.equal(bar.y,arrows[0].type==='line'?arrows[0].y2:-1);assert.equal(bar.y+bar.height,arrows[1].type==='line'?arrows[1].y1:-1);
  }
});

test('short message backgrounds and self-call labels leave active bars and lifelines visible',async()=>{
  const {layout}=await components();const document=layout.layoutSequence(basic([{type:'activation',participant:'A',action:'activate'},message('Request'),message('Self','A','A'),message('Reply','B','A'),{type:'activation',participant:'A',action:'deactivate'}]));assertBounded(document);
  const page=document.slides[0],bar=page.elements.find(e=>e.type==='box'&&e.fill==='blue');assert.ok(bar&&bar.type==='box');
  for(const background of page.elements.filter(e=>e.type==='box'&&e.fill==='paper'&&e.stroke==='none'))if(background.type==='box')assert.ok(background.x+background.width<=bar.x||background.x>=bar.x+bar.width||background.y+background.height<=bar.y||background.y>=bar.y+bar.height,'message background must not mask the active bar');
});

test('message-attached activations stay on their arrow page and repeat into a following reply page',async()=>{
  const {layout}=await components();const document=layout.layoutSequence(basic([...Array.from({length:23},(_,i)=>message(`Fill ${i}`)),message('Begin work'),{type:'activation',participant:'B',action:'activate'},message('Finish work','B','A'),{type:'activation',participant:'B',action:'deactivate'}]));assertBounded(document);assert.equal(document.slides.length,2);
  const first=document.slides[0],second=document.slides[1],firstBar=first.elements.find(e=>e.type==='box'&&e.fill==='blue'),secondBar=second.elements.find(e=>e.type==='box'&&e.fill==='blue');assert.ok(firstBar&&firstBar.type==='box');assert.ok(secondBar&&secondBar.type==='box');
  const incoming=first.elements.filter(e=>e.type==='line'&&e.arrow==='triangle').at(-1)!,reply=second.elements.find(e=>e.type==='line'&&e.arrow==='triangle')!;assert.equal(firstBar.y,incoming.type==='line'?incoming.y2:-1);assert.equal(secondBar.y+secondBar.height,reply.type==='line'?reply.y1:-1);assert.ok(second.elements.some(e=>e.type==='label'&&e.text.includes('활성화 계속')));
});

test('long accepted participant and message text paginates atomically with complete content and repeated headers',async()=>{
  const {layout}=await components();const diagram:SequenceDiagram={kind:'sequence',autonumber:false,participants:Array.from({length:10},(_,i)=>({id:`P${i}`,label:String(i)+'한'.repeat(159),kind:'actor'})),events:Array.from({length:120},(_,i)=>message(String(i).padStart(3,'0')+' '+'字'.repeat(156),'P9','P9'))};
  const document=layout.layoutSequence(diagram);assertBounded(document);assert.ok(document.slides.length>1);
  for(const participant of diagram.participants)for(const slide of document.slides)assert.ok(slide.elements.some(e=>e.type==='label'&&unwrapped(e.text)===participant.label));
  for(const event of diagram.events){assert.equal(event.type,'message');if(event.type==='message')assert.equal(labels(document).filter(e=>unwrapped(e.text)===event.text).length,1);}
  assert.equal(document.slides.flatMap(slide=>slide.elements).filter(e=>e.type==='line'&&e.arrow==='triangle').length,120);
});

test('nested fragments, parallel operands and activation stacks continue explicitly on every crossed page',async()=>{
  const {layout}=await components();const events:SequenceEvent[]=[{type:'fragment-start',id:'parallelBlock',kind:'par',text:'동시 작업'},{type:'fragment-start',id:'choiceBlock',kind:'alt',text:'조건 확인'},{type:'fragment-start',id:'repeatBlock',kind:'loop',text:'반복'},{type:'fragment-start',id:'optionBlock',kind:'opt',text:'추가 처리'},...Array.from({length:4},():SequenceEvent=>({type:'activation',participant:'A',action:'activate'})),...Array.from({length:35},(_,i)=>message(`앞쪽 ${i} `+'한'.repeat(130),'A','A')),{type:'fragment-end',id:'optionBlock'},{type:'fragment-end',id:'repeatBlock'},{type:'fragment-branch',id:'choiceBlock',kind:'else',text:'다른 조건'},message('Fallback'),{type:'fragment-end',id:'choiceBlock'},{type:'fragment-branch',id:'parallelBlock',kind:'and',text:'병렬 분기'},...Array.from({length:20},(_,i)=>message(`뒤쪽 ${i} `+'한'.repeat(130))),...Array.from({length:4},():SequenceEvent=>({type:'activation',participant:'A',action:'deactivate'})),{type:'fragment-end',id:'parallelBlock'}];
  const document=layout.layoutSequence(basic(events));assertBounded(document);assert.ok(document.slides.length>2);
  for(const slide of document.slides.slice(1)){assert.ok(slide.elements.some(e=>e.type==='label'&&/계속/.test(e.text)));assert.ok(slide.elements.some(e=>e.type==='box'&&e.fill==='blue'));}
  const text=labels(document).map(e=>unwrapped(e.text)).join('\n');for(const word of ['par','and','alt','else','loop','opt','활성화 계속','동시 작업','병렬 분기'])assert.ok(text.includes(word),word);
  const first=document.slides[0].elements.filter(e=>e.type==='box'&&e.fill==='blue');assert.ok(new Set(first.map(e=>e.type==='box'?e.x:0)).size>=4);
});

test('bounded note-heavy fragmented input remains within document budgets without dropping events',async()=>{
  const {layout}=await components();const diagram:SequenceDiagram={kind:'sequence',autonumber:false,participants:Array.from({length:10},(_,i)=>({id:`P${i}`,label:'參'.repeat(160),kind:'actor'})),events:[...Array.from({length:4},(_,i):SequenceEvent=>({type:'fragment-start',id:`F${i}`,kind:'loop',text:'條'.repeat(160)})),...Array.from({length:24},(_,i):SequenceEvent=>({type:'note',placement:i%2?'left':'right',participants:[i%2?'P0':'P9'],text:String(i).padStart(2,'0')+' '+'註'.repeat(157)})),...Array.from({length:88},(_,i)=>message(String(i).padStart(2,'0')+' '+'文'.repeat(157),'P9','P9')),...Array.from({length:4},(_,i):SequenceEvent=>({type:'fragment-end',id:`F${3-i}`}))]};
  const document=layout.layoutSequence(diagram);assertBounded(document);assert.equal(document.slides.flatMap(s=>s.elements).filter(e=>e.type==='box'&&e.fill==='note').length,24);assert.equal(document.slides.flatMap(s=>s.elements).filter(e=>e.type==='line'&&e.arrow==='triangle').length,88);
});

test('malicious or malformed direct ASTs cannot bypass the parser validation boundary',async()=>{
  const {layout,preview}=await components();for(const diagram of [null,{...basic(),extra:true},{...basic(),participants:[{id:'A',label:'<script>bad()</script>',kind:'participant'}]},{...basic(),events:[message('bad','A','missing')]},{...basic(),events:[{type:'activation',participant:'A',action:'activate'}]},{...basic(),events:[{type:'fragment-end',id:'missing'}]}]){
    assert.throws(()=>layout.layoutSequence(diagram as SequenceDiagram),/INVALID_SEQUENCE/);const html=renderToStaticMarkup(createElement(preview.SequencePreview,{diagram:diagram as SequenceDiagram}));assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg|<script|<image|foreignObject/);
  }
});

test('a grammar-valid document beyond the page budget fails explicitly instead of truncating its source',async()=>{
  const {layout,preview}=await components();const {validateSequenceDiagram}=await import('../web/visualization/sequence.ts');
  const events:SequenceEvent[]=[];for(let i=0;i<4;i++)events.push({type:'fragment-start',id:`F${i}`,kind:'alt',text:'條'.repeat(160)},{type:'fragment-branch',id:`F${i}`,kind:'else',text:'枝'.repeat(160)});events.push(...Array.from({length:108},()=>message('文'.repeat(160),'P9','P9')));for(let i=3;i>=0;i--)events.push({type:'fragment-end',id:`F${i}`});
  const diagram:SequenceDiagram={kind:'sequence',autonumber:false,participants:Array.from({length:10},(_,i)=>({id:`P${i}`,label:'參'.repeat(160),kind:'actor'})),events};assert.equal(validateSequenceDiagram(diagram),true);assert.throws(()=>layout.layoutSequence(diagram),/^Error: SEQUENCE_LAYOUT_LIMIT$/);
  const html=renderToStaticMarkup(createElement(preview.SequencePreview,{diagram}));assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg/);
});

test('actual SVG preview uses the same geometry and natural page sizes without external rendering or actions',async t=>{
  const {layout,preview}=await components();let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('Preview must remain inert');});
  const diagram=basic(Array.from({length:16},(_,i)=>message(`Message ${i} `+'한'.repeat(120),'A','A'))),document=layout.layoutSequence(diagram);
  const html=renderToStaticMarkup(createElement(preview.SequencePreview,{diagram}));assert.equal(requests,0);assert.equal((html.match(/<svg\b/g)??[]).length,document.slides.length);assert.match(html,new RegExp(`총 ${document.slides.length}페이지`));assert.match(html,/사용자 &amp; Client/);assert.match(html,/시퀀스 다이어그램/);
  for(const slide of document.slides){assert.ok(html.includes(`viewBox="0 0 ${slide.width} ${slide.height}"`));assert.ok(html.includes(`width:${slide.width}px`));}
  const line=document.slides[0].elements.find(e=>e.type==='line'&&e.arrow==='triangle')!;assert.equal(line.type,'line');if(line.type==='line')for(const value of [`x1="${line.x1}"`,`y1="${line.y1}"`,`x2="${line.x2}"`,`y2="${line.y2}"`])assert.ok(html.includes(value));
  assert.match(html,/<div class="viz-sequence-scroll"[^>]*tabindex="0"[^>]*aria-label=/);assert.doesNotMatch(html,/<script|<image|foreignObject|<a(?:\s|>)|<iframe|<[^>]+\s(?:href|src|onload|onclick)=/);
});
