import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePresentationDocument} from '../web/visualization/presentation.ts';
import {serializePresentation} from '../server/visualization/pptx.ts';

const document=()=>({format:'canvas-v1',slides:[{id:'c4-overview',width:1200,height:900,elements:[
  {type:'box',id:'system',x:40,y:40,width:700,height:600,geometry:'rect',fill:'none',stroke:'solid'},
  {type:'box',id:'container',x:100,y:120,width:300,height:180,geometry:'rect',fill:'blue',stroke:'solid'},
  {type:'label',id:'label',x:112,y:132,width:276,height:66,text:'로컬 API\n[Container]\nTypeScript',fontSize:18,align:'center'},
  {type:'line',id:'relation',x1:400,y1:210,x2:650,y2:210,dash:'solid',arrow:'triangle'},
]}]});

test('generic fixed canvas exports editable native geometry while preserving equivalent sequence bytes',()=>{
  const doc=document();assert.equal(validatePresentationDocument(doc),true);
  const bytes=Buffer.from(serializePresentation(doc));assert.equal(bytes.subarray(0,4).toString('hex'),'504b0304');
  assert.match(bytes.toString(),/<p:sldSz cx="15240000" cy="11430000"/);
  assert.match(bytes.toString(),/로컬 API/);assert.match(bytes.toString(),/<p:cxnSp>/);
  assert.doesNotMatch(bytes.toString(),/<p:pic|<a:blip|TargetMode="External"|hlinkClick/);
  assert.deepEqual(serializePresentation({...doc,format:'sequence-v1'}),bytes);
});

test('generic canvas rejects unknown formats, unsafe primitives and nonportable geometry',()=>{
  const edits:((d:any)=>void)[]=[d=>d.format='canvas-v2',d=>d.extra=true,d=>d.slides[0].height=1201,
    d=>d.slides[0].elements[0].fill='url(file)',d=>d.slides[0].elements[2].text='\ud800',
    d=>d.slides[0].elements[3].x2=Infinity,d=>d.slides[0].elements[3].x2=400,
    d=>d.slides[0].elements[2].href='https://example.invalid',d=>d.slides[0].elements[0].width=0,
    d=>d.slides[0].elements[1].id='system',d=>d.slides[0].width=71];
  for(const edit of edits){const doc=document();edit(doc);assert.equal(validatePresentationDocument(doc),false);assert.throws(()=>serializePresentation(doc),/INVALID_PRESENTATION/);}
});

test('fixed composition diamonds export as native editable geometry with a bounded foreground fill',()=>{
  const doc=document();Object.assign(doc.slides[0].elements[0],{geometry:'diamond',fill:'ink'});
  assert.equal(validatePresentationDocument(doc),true);
  const xml=Buffer.from(serializePresentation(doc)).toString();
  assert.match(xml,/<a:prstGeom prst="diamond"/);assert.match(xml,/<a:solidFill><a:srgbClr val="355C86"\/><\/a:solidFill>/);
  for(const geometry of ['path','polygon','star','diamond<script>']){
    const invalid=document();Object.assign(invalid.slides[0].elements[0],{geometry,fill:'ink'});
    assert.equal(validatePresentationDocument(invalid),false);assert.throws(()=>serializePresentation(invalid),/INVALID_PRESENTATION/);
  }
});
