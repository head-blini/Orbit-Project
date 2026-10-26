import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {CanvasPresentationDocument} from '../shared/canvas.ts';
import {toPresentationDocument} from '../web/visualization/presentation.ts';

async function component(){
  assert.ok(existsSync(new URL('../web/visualization/FixedCanvasPreview.tsx',import.meta.url)),'Fixed canvas preview is not implemented');
  const root=new URL('../web/visualization/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/visualization/FixedCanvasPreview.tsx');}finally{hooks.deregister();}
}
const document=():CanvasPresentationDocument=>({format:'canvas-v1',slides:[{id:'overview',width:800,height:600,elements:[
  {type:'box',id:'node',x:20,y:30,width:300,height:120,geometry:'rect',fill:'blue',stroke:'solid'},
  {type:'label',id:'name',x:30,y:40,width:280,height:44,text:'<script> & plain text',fontSize:18,align:'center'},
  {type:'line',id:'arrow',x1:320,y1:90,x2:600,y2:90,dash:'dash',arrow:'triangle'},
]}]});

test('fixed canvas SVG preserves editable geometry, inert text and keyboard-scrollable natural dimensions',async t=>{
  const {FixedCanvasPreview}=await component();let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('No remote render');});
  const html=renderToStaticMarkup(createElement(FixedCanvasPreview,{document:document(),label:'C4'}));
  assert.equal(requests,0);assert.match(html,/viewBox="0 0 800 600"/);assert.match(html,/width:800px;height:600px/);
  assert.match(html,/&lt;script&gt; &amp; plain text/);assert.match(html,/x1="320" y1="90" x2="600" y2="90"/);
  assert.match(html,/stroke-dasharray="7 5"/);assert.match(html,/marker-end="url\(#/);assert.match(html,/tabindex="0"/);
  assert.doesNotMatch(html,/<script|<image|foreignObject|<a(?:\s|>)|<iframe|\s(?:href|src|onload|onclick)=/);
});

test('fixed canvas preview rejects invalid primitives before emitting SVG',async()=>{
  const {FixedCanvasPreview}=await component(),doc=document();doc.slides[0].elements[0].id='';
  const html=renderToStaticMarkup(createElement(FixedCanvasPreview,{document:doc,label:'C4'}));
  assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg/);
});

test('multiline labels use font-sized leading without overlapping larger editable text',async()=>{
  const {FixedCanvasPreview}=await component(),doc=document();
  doc.slides[0].elements[1]={type:'label',id:'name',x:30,y:40,width:700,height:120,text:'Large heading\nSecond line',fontSize:48,align:'left'};
  const html=renderToStaticMarkup(createElement(FixedCanvasPreview,{document:doc,label:'C4'}));
  const baseline=Number(/dy="([\d.]+)"[^>]*>Second line/.exec(html)?.[1]);
  assert.ok(baseline>=57.6&&baseline<=58,'48-point text requires at least 120% line spacing');
});

test('legacy presentation objects are rejected by the fixed-primitive preview without throwing',async()=>{
  const {FixedCanvasPreview}=await component();
  const legacy=toPresentationDocument({nodes:[{id:'a',kind:'component',label:'A'}],edges:[]});
  const html=renderToStaticMarkup(createElement(FixedCanvasPreview,{document:legacy as unknown as CanvasPresentationDocument,label:'C4'}));
  assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<svg/);
});
