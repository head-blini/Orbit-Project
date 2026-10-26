import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {PlanningDraft} from '../shared/parallel.ts';
import type {PlanningComparison} from '../shared/planning-revisions.ts';

async function components(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,nextLoad){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return nextLoad(url,context);
  }});
  try{return {studio:await import('../web/planning/PlanningStudio.tsx'),comparison:await import('../web/planning/PlanningComparison.tsx')};}finally{hooks.deregister();}
}
// Literal normalized records keep display tests independent of the import parser.
const draft:PlanningDraft={schemaVersion:'1.0',title:'기획 결정과 출처',goal:'로컬에서 검토한다',requirements:[{label:'REQ-01',description:'기획을 보존한다',acceptanceCriteria:['저장한 내용이 유지된다']}],constraints:[],openQuestions:[],source:'import',
  decisions:[{topic:'Storage <svg onload=topic()>',decision:'Use <script>decision()</script>',rationale:'Keep <img src=x onerror=rationale()> offline'}],
  provenance:{kind:'external <em>claim</em>',providerId:'provider <img src=x>',author:'author <script>claim()</script>',externalUrl:'https://example.invalid/plan?title=<svg>&from=source',references:[{title:'Reference <iframe src=x>',url:'https://example.invalid/reference?title=<img>&from=ref'}]}};

test('actual planning preview renders decisions with topic, decision and rationale as escaped text',async()=>{
  const {studio}=await components();const html=renderToStaticMarkup(createElement(studio.PlanningPreview,{draft}));
  assert.match(html,/<h4>결정 사항<\/h4>/);assert.match(html,/Storage &lt;svg onload=topic\(\)&gt;/);assert.match(html,/Use &lt;script&gt;decision\(\)&lt;\/script&gt;/);assert.match(html,/Keep &lt;img src=x onerror=rationale\(\)&gt; offline/);
  assert.match(html,/>결정</);assert.match(html,/>근거</);assert.doesNotMatch(html,/<script|<svg|<img|<iframe|<a(?:\s|>)/);
});

test('actual planning preview labels source claims unverified and renders all URLs and references as inert text',async()=>{
  const {studio}=await components();const html=renderToStaticMarkup(createElement(studio.PlanningPreview,{draft}));
  assert.match(html,/aria-label="출처 정보"/);assert.match(html,/<h4>출처 정보 · 미검증<\/h4>/);assert.match(html,/검증하지 않/);assert.match(html,/출처 유형/);assert.match(html,/제공자 표기/);assert.match(html,/작성자 표기/);assert.match(html,/외부 원문 URL/);assert.match(html,/참고 자료/);
  assert.match(html,/external &lt;em&gt;claim&lt;\/em&gt;/);assert.match(html,/provider &lt;img src=x&gt;/);assert.match(html,/author &lt;script&gt;claim\(\)&lt;\/script&gt;/);
  assert.match(html,/https:\/\/example\.invalid\/plan\?title=&lt;svg&gt;&amp;from=source/);assert.match(html,/Reference &lt;iframe src=x&gt;/);assert.match(html,/https:\/\/example\.invalid\/reference\?title=&lt;img&gt;&amp;from=ref/);
  assert.doesNotMatch(html,/<a(?:\s|>)|<script|<img|<iframe|<svg|<[^>]+\s(?:href|src|srcset)=/);
});

test('legacy drafts omit optional metadata sections while partial source and decision text remains readable',async()=>{
  const {studio}=await components();const {decisions:_,provenance:__,...legacy}=draft;
  const old=renderToStaticMarkup(createElement(studio.PlanningPreview,{draft:legacy}));assert.doesNotMatch(old,/출처 정보|<h4>결정 사항<\/h4>|undefined|null/);assert.match(old,/기획을 보존한다/);
  const partial=renderToStaticMarkup(createElement(studio.PlanningPreview,{draft:{...legacy,decisions:[{topic:'Pending choice',decision:'',rationale:''}],provenance:{kind:'file',providerId:null,externalUrl:null}}}));
  assert.match(partial,/Pending choice/);assert.match(partial,/결정 미입력/);assert.match(partial,/근거 미입력/);assert.match(partial,/미기재/);assert.doesNotMatch(partial,/undefined|null|<a(?:\s|>)/);
});

test('editor starter and help expose Markdown Decisions and canonical JSON source fields without invoking callbacks',async()=>{
  const {studio}=await components();let calls=0;
  const unexpected=async()=>{calls++;throw new Error('SSR must not request, save, approve or execute');};
  const html=renderToStaticMarkup(createElement(studio.PlanningStudio,{projectId:'project-a',list:unexpected,create:unexpected,revise:unexpected,approve:unexpected,toTasks:unexpected,onExport:unexpected,onCompare:unexpected,onReplan:unexpected}));
  const editor=/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];assert.ok(editor);assert.match(editor,/## Decisions/);
  assert.match(html,/###.*주제/);assert.match(html,/#### Decision/);assert.match(html,/#### Rationale/);
  for(const field of ['source','kind','provider_id','external_url','author','references','title','url'])assert.ok(html.includes(field),`${field} source field must be explained in the editor`);
  assert.match(html,/사용자 제공/);assert.match(html,/검증하지 않/);assert.equal(calls,0);assert.doesNotMatch(html,/<a(?:\s|>)|<iframe|<script|<img/);
});

test('comparison uses human metadata labels and escapes both JSON displays without creating navigation or actions',async()=>{
  const {comparison}=await components();let calls=0;
  const value:PlanningComparison={projectId:'project-a',base:{id:'base',revision:1,state:'superseded',contentHash:'a'.repeat(64)},target:{id:'target',revision:2,state:'draft',contentHash:'b'.repeat(64)},fields:[
    {field:'decisions',before:'[{"topic":"Old topic","decision":"Old decision","rationale":"Old rationale"}]',after:'[{"topic":"<script>new topic</script>","decision":"New decision","rationale":"New rationale"}]'},
    {field:'provenance',before:'{"kind":"file","author":"Previous author"}',after:'{"kind":"external","providerId":"<img src=x>","externalUrl":"https://example.invalid/reference"}'},
  ],requirements:[],affectedTasks:[],targetCurrent:true,canReplan:false,previewDigest:'c'.repeat(64),availableLabels:[],existingLabels:[]};
  const html=renderToStaticMarkup(createElement(comparison.PlanningComparisonPreview,{comparison:value,selectedLabels:[],consent:false,onSelect:()=>{calls++;},onConsent:()=>{calls++;},onCreate:()=>{calls++;}}));
  assert.match(html,/<th scope="row">결정 사항<\/th>/);assert.match(html,/<th scope="row">사용자 제공 출처 정보/);assert.match(html,/미검증|검증하지 않/);
  for(const text of ['Old topic','Old decision','Old rationale','New decision','New rationale','Previous author','https://example.invalid/reference'])assert.ok(html.includes(text));
  assert.match(html,/&lt;script&gt;new topic&lt;\/script&gt;/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<a(?:\s|>)|<script|<img|<iframe/);assert.equal(calls,0);
  assert.match(html,/<button[^>]*disabled[^>]*>선택한 후속 Task 초안 생성/);
});
