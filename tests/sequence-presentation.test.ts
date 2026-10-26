import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import type { SequencePresentationDocument } from '../shared/sequence.ts';
import { validatePresentationDocument,toPresentationDocument } from '../web/visualization/presentation.ts';
import { serializePresentation } from '../server/visualization/pptx.ts';

function document():SequencePresentationDocument {
  const page={id:'page1',width:800,height:1000,elements:[
    {type:'box' as const,id:'actor',x:80,y:30,width:30,height:30,geometry:'ellipse' as const,fill:'paper' as const,stroke:'solid' as const},
    {type:'box' as const,id:'frame',x:40,y:100,width:700,height:700,geometry:'rect' as const,fill:'none' as const,stroke:'solid' as const},
    {type:'line' as const,id:'reply',x1:650,y1:220,x2:100,y2:220,dash:'dash' as const,arrow:'triangle' as const},
    {type:'label' as const,id:'message',x:100,y:180,width:550,height:40,text:'한글 & Reply\nNext',fontSize:18,align:'center' as const},
    {type:'line' as const,id:'life',x1:100,y1:100,x2:100,y2:900,dash:'dash' as const,arrow:'none' as const},
  ]};
  return {format:'sequence-v1',slides:[page,{...structuredClone(page),id:'page2'}]};
}
function unpack(bytes:Uint8Array) {
  const data=Buffer.from(bytes),parts=new Map<string,string>();let offset=0;
  while(data.readUInt32LE(offset)===0x04034b50){
    assert.equal(data.readUInt16LE(offset+8),0);const size=data.readUInt32LE(offset+18),n=data.readUInt16LE(offset+26),extra=data.readUInt16LE(offset+28);
    const name=data.subarray(offset+30,offset+30+n).toString(),start=offset+30+n+extra,body=data.subarray(start,start+size);
    assert.equal(crc32(body),data.readUInt32LE(offset+14));assert.ok(!parts.has(name));parts.set(name,body.toString());offset=start+size;
  }
  assert.equal(data.readUInt32LE(offset),0x02014b50);assert.equal(data.readUInt32LE(data.length-22),0x06054b50);return parts;
}

test('accepts bounded sequence pages without widening the legacy single-slide contract',()=>{
  assert.equal(validatePresentationDocument(document()),true);
  const legacy=toPresentationDocument({nodes:[{id:'a',label:'A',kind:'component'}],edges:[]});
  assert.equal(validatePresentationDocument(legacy),true);
  assert.equal(validatePresentationDocument({slides:document().slides}),false);
  assert.equal(validatePresentationDocument({...document(),format:'sequence-v2'}),false);
  assert.equal(validatePresentationDocument({...legacy,format:'sequence-v1'}),false);
});

test('serializes multiple editable point-sized pages with safe internal relationships',()=>{
  const doc=document(),bytes=serializePresentation(doc),parts=unpack(bytes);
  assert.deepEqual(serializePresentation(doc),bytes,'deterministic archive');
  const presentation=parts.get('ppt/presentation.xml')!;
  assert.match(presentation,/<p:sldSz cx="10160000" cy="12700000"/);
  assert.equal([...presentation.matchAll(/<p:sldId /g)].length,2);
  assert.match(parts.get('ppt/_rels/presentation.xml.rels')!,/Target="slides\/slide2.xml"/);
  assert.match(parts.get('[Content_Types].xml')!,/PartName="\/ppt\/slides\/slide2.xml"/);
  for(let page=1;page<=2;page++){
    const xml=parts.get(`ppt/slides/slide${page}.xml`)!;
    assert.equal([...xml.matchAll(/<p:sp>/g)].length,3);
    assert.equal([...xml.matchAll(/<p:cxnSp>/g)].length,2);
    assert.match(xml,/prst="ellipse"/);assert.match(xml,/<a:prstDash val="dash"/);
    assert.match(xml,/<a:tailEnd type="triangle"/);assert.match(xml,/flipH="1"/);
    assert.match(xml,/sz="1800"/);assert.match(xml,/algn="ctr"/);
    assert.match(xml,/한글 &amp; Reply/);assert.match(xml,/>Next<\/a:t>/);
    assert.ok(xml.indexOf('name="actor"')<xml.indexOf('name="frame"')&&xml.indexOf('name="frame"')<xml.indexOf('name="reply"'),'preserves layout z order');
    assert.ok(parts.has(`ppt/slides/_rels/slide${page}.xml.rels`));
  }
  for(const xml of parts.values())assert.doesNotMatch(xml,/<p:pic|<a:blip|TargetMode="External"|hlinkClick|vbaProject|NaN|Infinity/);
});

test('rejects invalid sequence primitives, dimensions, IDs, text and budgets before export',()=>{
  const edits:((d:any)=>void)[]=[
    d=>d.extra=true,d=>d.slides=[],d=>d.slides[1].id='page1',d=>d.slides[1].width=801,
    d=>d.slides[0].width=3601,d=>d.slides[0].height=1201,
    d=>d.slides.forEach((s:any)=>s.width=Number.MIN_VALUE),d=>d.slides[0].elements[0].width=Number.MIN_VALUE,
    d=>d.slides[0].elements[0].geometry='path',d=>d.slides[0].elements[0].fill='url(file)',
    d=>d.slides[0].elements[0].width=0,d=>d.slides[0].elements[0].x=-1,
    d=>d.slides[0].elements[2].x1=Infinity,d=>d.slides[0].elements[2].y2=1001,
    d=>d.slides[0].elements[2].x2=650,d=>d.slides[0].elements[2].dash='script',
    d=>d.slides[0].elements[2].x2=650.0000001,
    d=>d.slides[0].elements[3].fontSize=0,d=>d.slides[0].elements[3].align='justify',
    d=>d.slides[0].elements[3].text='\ud800',d=>d.slides[0].elements[3].text='x'.repeat(513),
    d=>d.slides[0].elements[3].url='file:///private',d=>d.slides[0].elements[3].id='actor',
    d=>d.slides[0].elements=Array.from({length:801},(_,i)=>({...d.slides[0].elements[0],id:`b${i}`})),
    d=>d.slides=Array.from({length:33},(_,i)=>({...d.slides[0],id:`p${i}`})),
  ];
  for(const edit of edits){const doc=document();edit(doc);assert.equal(validatePresentationDocument(doc),false,String(edit));assert.throws(()=>serializePresentation(doc),/INVALID_PRESENTATION/);}
});

test('sequence labels remain inert XML and every segment keeps its absolute direction',()=>{
  const doc=document();doc.slides[0].elements[3]={type:'label',id:'label',x:20,y:20,width:500,height:60,text:'<a> https://example.invalid "quotes"',fontSize:17,align:'left'};
  doc.slides[0].elements.push({type:'line',id:'up',x1:200,y1:400,x2:200,y2:300,dash:'solid',arrow:'none'});
  const xml=unpack(serializePresentation(doc)).get('ppt/slides/slide1.xml')!;
  assert.match(xml,/&lt;a&gt; https:\/\/example.invalid &quot;quotes&quot;/);assert.match(xml,/flipV="1"/);
  assert.doesNotMatch(xml,/hlinkClick|TargetMode="External"/);
});

test('sequence validation enforces aggregate element and UTF-8 budgets independently of page counts',()=>{
  const many=document(),box=many.slides[0].elements[0];
  many.slides=Array.from({length:11},(_,p)=>({id:`p${p}`,width:800,height:1000,elements:Array.from({length:750},(_,i)=>({...box,id:`b${i}`}))}));
  assert.equal(validatePresentationDocument(many),false);assert.throws(()=>serializePresentation(many),/INVALID_PRESENTATION/);
  const bytes=document();
  bytes.slides.forEach(slide=>{slide.elements=[box,...Array.from({length:350},(_,i)=>({type:'label' as const,id:`t${i}`,x:0,y:0,width:800,height:1000,text:'한'.repeat(512),fontSize:18,align:'left' as const}))];});
  assert.ok(Buffer.byteLength(JSON.stringify(bytes))>1024*1024);assert.equal(validatePresentationDocument(bytes),false);
  const unicode=document();unicode.slides[0].elements[3]={type:'label',id:'unicode',x:0,y:0,width:800,height:1000,text:('😀'.repeat(160)).split('').join('').replace(/(.{20})/gu,'$1\n'),fontSize:18,align:'left'};
  assert.equal(validatePresentationDocument(unicode),true);serializePresentation(unicode);
});

test('sequence slide dimensions meet the OOXML one-inch minimum',()=>{
  const doc=document();doc.slides=[{id:'tiny',width:1,height:1,elements:[{type:'box',id:'box',x:0,y:0,width:1,height:1,geometry:'rect',fill:'paper',stroke:'solid'}]}];
  assert.equal(validatePresentationDocument(doc),false);assert.throws(()=>serializePresentation(doc),/INVALID_PRESENTATION/);
  doc.slides[0].width=72;doc.slides[0].height=72;assert.equal(validatePresentationDocument(doc),true);
  assert.match(unpack(serializePresentation(doc)).get('ppt/presentation.xml')!,/<p:sldSz cx="914400" cy="914400"/);
});
