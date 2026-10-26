import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32,inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { serializePresentation } from '../server/visualization/pptx.ts';
import { toPresentationDocument } from '../web/visualization/presentation.ts';

// Independent ZIP consumer: central-directory offsets and Node's own CRC implementation.
// No production packing, geometry, XML escaping or CRC helpers are used to derive expectations.
function unpack(bytes:Uint8Array):Map<string,string> {
  const data=Buffer.from(bytes);
  assert.ok(data.length>=22,'must contain a complete ZIP archive');
  assert.equal(data.readUInt32LE(0),0x04034b50,'must be an actual ZIP archive');
  const end=data.length-22;
  assert.equal(data.readUInt32LE(end),0x06054b50);
  assert.equal(data.readUInt16LE(end+4),0);assert.equal(data.readUInt16LE(end+6),0);
  const count=data.readUInt16LE(end+10),length=data.readUInt32LE(end+12);
  let offset=data.readUInt32LE(end+16);const directoryStart=offset;
  const result=new Map<string,string>();
  for(let i=0;i<count;i++) {
    assert.equal(data.readUInt32LE(offset),0x02014b50);
    const flags=data.readUInt16LE(offset+8),method=data.readUInt16LE(offset+10);
    assert.equal(flags&1,0,'no encrypted entries');
    const crc=data.readUInt32LE(offset+16),compressed=data.readUInt32LE(offset+20),size=data.readUInt32LE(offset+24);
    const nameLength=data.readUInt16LE(offset+28),extra=data.readUInt16LE(offset+30),comment=data.readUInt16LE(offset+32);
    const local=data.readUInt32LE(offset+42),name=data.subarray(offset+46,offset+46+nameLength).toString('utf8');
    assert.ok(!result.has(name));assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));
    assert.equal(data.readUInt32LE(local),0x04034b50);
    assert.equal(data.subarray(local+30,local+30+data.readUInt16LE(local+26)).toString('utf8'),name);
    const start=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28);
    const packed=data.subarray(start,start+compressed);
    assert.ok(method===0||method===8);
    const body=method===8?inflateRawSync(packed):packed;
    assert.equal(body.length,size);assert.equal(crc32(body),crc,'CRC must cover the exact UTF-8 entry');
    result.set(name,body.toString('utf8'));offset+=46+nameLength+extra+comment;
  }
  assert.equal(offset-directoryStart,length);assert.equal(offset,end);
  return result;
}

const graph={nodes:[{id:'browser',label:'한글 & 서비스',kind:'client'},{id:'server',label:'로컬 서버',kind:'service'}],edges:[{from:'browser',to:'server',label:'HTTP'}]};
const document=()=>toPresentationDocument(graph);

test('serializes a complete PPTX ZIP with internal relationships and correct content types',()=>{
  const parts=unpack(serializePresentation(document()));
  for(const name of ['[Content_Types].xml','_rels/.rels','ppt/presentation.xml','ppt/_rels/presentation.xml.rels','ppt/slides/slide1.xml','ppt/slides/_rels/slide1.xml.rels','ppt/slideMasters/slideMaster1.xml','ppt/slideMasters/_rels/slideMaster1.xml.rels','ppt/slideLayouts/slideLayout1.xml','ppt/slideLayouts/_rels/slideLayout1.xml.rels','ppt/theme/theme1.xml']) assert.ok(parts.has(name),name);
  const types=parts.get('[Content_Types].xml')!;
  assert.match(types,/application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation\.main\+xml/);
  for(const [name,xml] of parts) {
    assert.match(xml,/^<\?xml /);assert.doesNotMatch(xml,/<!DOCTYPE|<!ENTITY|TargetMode="External"|vbaProject|macroEnabled/);
    if(name.endsWith('.rels')) {
      const base=name==='_rels/.rels'?'':posix.dirname(posix.dirname(name));
      const ids=new Set<string>();
      for(const rel of xml.matchAll(/<Relationship\s+Id="([^"]+)"\s+Type="[^"]+"\s+Target="([^"]+)"\s*\/>/g)) {
        assert.ok(!ids.has(rel[1]));ids.add(rel[1]);
        assert.ok(parts.has(posix.normalize(posix.join(base,rel[2]))),`${name} -> ${rel[2]}`);
      }
      assert.ok(ids.size>0);
    } else if(name.endsWith('.xml')&&name!=='[Content_Types].xml') assert.ok(types.includes(`PartName="/${name}"`),name);
  }
});

test('keeps shapes, Korean text and endpoint-linked connectors independently editable',()=>{
  const parts=unpack(serializePresentation(document())),xml=parts.get('ppt/slides/slide1.xml')!;
  assert.equal([...xml.matchAll(/<p:sp>/g)].length,5,'two boxes and three editable text boxes');
  assert.equal([...xml.matchAll(/<p:cxnSp>/g)].length,1);
  assert.match(xml,/<a:t[^>]*>한글 &amp; 서비스<\/a:t>/);assert.match(xml,/<a:t[^>]*>로컬 서버<\/a:t>/);
  assert.doesNotMatch(xml,/<p:pic|<a:blip|<p:graphicFrame/);
  const shapeIds=[...xml.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="(\d+)" name="(browser|server)"/g)];
  assert.equal(shapeIds.length,2);
  assert.match(xml,new RegExp(`<a:stCxn id="${shapeIds[0][1]}" idx="3"\\s*/>`));
  assert.match(xml,new RegExp(`<a:endCxn id="${shapeIds[1][1]}" idx="1"\\s*/>`));
  const ids=[...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  assert.match(xml,/<a:tailEnd type="triangle"/);
});

test('escapes XML attributes and text without turning markup or URLs into active relationships',()=>{
  const doc=document();
  doc.slides[0].elements.find(e=>e.type==='text')!.text='한글 <tag> "quoted" & https://example.invalid\n두 번째 줄';
  doc.slides[0].elements[0].id='node"&<';
  const connector=doc.slides[0].elements.find(e=>e.type==='connector')!;connector.from='node"&<';
  const xml=unpack(serializePresentation(doc)).get('ppt/slides/slide1.xml')!;
  assert.match(xml,/name="node&quot;&amp;&lt;"/);assert.match(xml,/한글 &lt;tag&gt; &quot;quoted&quot; &amp; https:\/\/example.invalid/);
  assert.match(xml,/두 번째 줄/);assert.doesNotMatch(xml,/<tag>|hlinkClick|hlinkHover/);
});

test('rejects malformed, oversized and XML-invalid documents before returning any bytes',()=>{
  const invalid:unknown[]=[null,{}, {slides:[]},{...document(),url:'file:///private'},{slides:[...document().slides,...document().slides]}];
  for(const edit of [(d:any)=>d.slides[0].elements.push({...d.slides[0].elements[0]}),(d:any)=>d.slides[0].width=0,(d:any)=>d.slides[0].height=NaN,(d:any)=>d.slides[0].elements[0].width=0,(d:any)=>d.slides[0].elements[0].x=-1,(d:any)=>d.slides[0].elements[0].x=100000,(d:any)=>d.slides[0].elements[0].extra='unsupported',(d:any)=>d.slides[0].elements.find((e:any)=>e.type==='connector').to='missing',(d:any)=>d.slides[0].elements.find((e:any)=>e.type==='text').text='invalid\u0000XML',(d:any)=>d.slides[0].elements.find((e:any)=>e.type==='text').text='\ud800',(d:any)=>d.slides[0].elements.find((e:any)=>e.type==='text').text='x'.repeat(161),(d:any)=>d.slides[0].elements=Array.from({length:801},(_,i)=>({...d.slides[0].elements[0],id:`n${i}`}))]) {
    const doc=document();edit(doc);invalid.push(doc);
  }
  for(const doc of invalid)assert.throws(()=>serializePresentation(doc),/INVALID_PRESENTATION/);
});

test('supports reverse, vertical and self connectors and fits a dense generated canvas to the slide',()=>{
  const nodes=Array.from({length:100},(_,i)=>({id:`n${i}`,label:`서비스 ${i}`,kind:'service'}));
  const doc=toPresentationDocument({nodes,edges:[{from:'n1',to:'n0'},{from:'n0',to:'n4'},{from:'n0',to:'n0'}]});
  const parts=unpack(serializePresentation(doc)),xml=parts.get('ppt/slides/slide1.xml')!;
  assert.equal([...xml.matchAll(/<p:cxnSp>/g)].length,3);
  assert.doesNotMatch(xml,/NaN|Infinity/);
  assert.match(xml,/flipH="1"/);
  assert.match(parts.get('ppt/presentation.xml')!,/<p:sldSz cx="9144000" cy="5143500"/);
  for(const match of xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
    const [,x,y,w,h]=match.map(Number);assert.ok(x>=0&&y>=0&&x+w<=9144000&&y+h<=5143500);
  }
});

test('rejects a valid-shape-count document whose actual UTF-8 payload exceeds the source budget',()=>{
  const doc=document(),shape=doc.slides[0].elements[0];
  doc.slides[0].elements=[shape,...Array.from({length:799},(_,i)=>({type:'text' as const,id:`text${i}`,x:0,y:0,width:10,height:10,text:'한'.repeat(160)}))];
  assert.throws(()=>serializePresentation(doc),/INVALID_PRESENTATION/);
});
