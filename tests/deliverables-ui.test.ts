import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {Deliverable} from '../shared/deliverables.ts';

async function view(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/deliverables.tsx');}finally{hooks.deregister();}
}
const item=(path:string,over:Partial<Deliverable>={}):Deliverable=>({path,size:120,modifiedAt:'2026-10-28T03:33:13.000Z',sha256:'ab'.repeat(32),mediaType:'text/markdown',taskId:null,taskTitle:null,previewable:true,role:'output',
  checks:{exists:true,readable:true,nonEmpty:true,format:'passed',meaning:'unverified'},...over});

test('deliverables show producing task, layered checks and never claim the content is correct',async()=>{
  const {DeliverablesView}=await view();
  const html=renderToStaticMarkup(createElement(DeliverablesView,{list:{items:[item('task-2d5a1ea8.md',{taskId:'t1',taskTitle:'R1: 자료 수집'}),item('image.png',{mediaType:'image/png',previewable:false,checks:{exists:true,readable:true,nonEmpty:true,format:'unsupported',meaning:'unverified'}}),item('empty.md',{size:0,checks:{exists:true,readable:true,nonEmpty:false,format:'failed',meaning:'unverified'}})],skipped:1,truncated:false},preview:null,onPreview:()=>{}}));
  assert.match(html,/R1: 자료 수집/);assert.match(html,/형식 확인/);assert.match(html,/형식 검사 미지원/);assert.match(html,/형식 오류/);
  assert.match(html,/내용 적합성은 확인하지 않았습니다/);assert.match(html,/1개 항목은 보안상 표시하지 않았습니다/);
  assert.equal((html.match(/미리보기<\/button>/g)??[]).length,2);
  assert.doesNotMatch(html,/검증 통과|완료됨/);
});
test('previews render as inert text and truncated previews are labelled',async()=>{
  const {DeliverablesView}=await view();
  const html=renderToStaticMarkup(createElement(DeliverablesView,{list:{items:[item('a.md')],skipped:0,truncated:false},preview:{kind:'text',path:'a.md',mediaType:'text/markdown',text:'<script>x</script>',truncated:true},onPreview:()=>{}}));
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/일부만 표시/);
});
test('an empty folder is stated plainly',async()=>{
  const {DeliverablesView}=await view();
  const html=renderToStaticMarkup(createElement(DeliverablesView,{list:{items:[],skipped:0,truncated:false},preview:null,onPreview:()=>{}}));
  assert.match(html,/아직 결과물 파일이 없습니다/);
});

test('one-click output download uses opaque IDs; inputs have no download and missing old bytes are honest',async()=>{
  const {DeliverablesView}=await view(),id='a'.repeat(64);
  const html=renderToStaticMarkup(createElement(DeliverablesView,{projectId:'project',list:{items:[item('result.txt',{id}),item('inputs/source.txt',{role:'input'})],skipped:0,truncated:false},preview:null,onPreview:()=>{},onHistory:()=>{},history:{id,versions:[{id:'version',deliverableId:id,path:'result.txt',size:120,sha256:'b'.repeat(64),taskId:null,runId:null,runAt:null,observedAt:'2026-10-29T00:00:00Z',available:false}]}}));
  assert.match(html,new RegExp(`/api/projects/project/deliverables/${id}/download`));assert.match(html,/파일 받기/);assert.match(html,/이전 버전 보기/);
  assert.doesNotMatch(html,/href="[^"]*inputs|href="[^"]*version/);assert.match(html,/파일이 보존되어 있지 않아/);assert.match(html,/생성 실행 미확인/);
});
