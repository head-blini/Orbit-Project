import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire,registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {PlanningDraft,PlanningVersion} from '../shared/parallel.ts';
import type {PlanningAgentPanelProps,PlanningAgentPreview,PlanningAgentView,PlanningSuggestion} from '../shared/planning-agent.ts';

const scope={projectId:'project-a',workspaceId:'workspace-a',online:true,busy:false};
const preview:PlanningAgentPreview={...scope,inputDigest:'a'.repeat(64),previewDigest:'b'.repeat(64),instructions:'Exact outbound input <script>unsafe()</script>',timeoutMs:60000,turnLimit:1,scope:'Native read-only workspace-a'};
const proposal:PlanningDraft={schemaVersion:'1.0',title:'Local task board',goal:'Track local tasks',requirements:[{label:'REQ-01',description:'Add a task',acceptanceCriteria:['Task appears']}],constraints:[],openQuestions:[],source:'manual'};
const completed:PlanningSuggestion={id:'suggestion-a',requestId:'request-a',projectId:scope.projectId,workspaceId:scope.workspaceId,inputDigest:preview.inputDigest,previewDigest:preview.previewDigest,execution:'completed',proposal,outputDigest:'c'.repeat(64),issue:null,threadId:'thread-a',turnId:'turn-a',processStopped:true,recoveredAt:null,createdAt:'2026-10-27T00:00:00Z',finishedAt:'2026-10-27T00:00:01Z',durationMs:1000,timeoutMs:60000,turnLimit:1,savedPlanningVersionId:null};
const saved:PlanningVersion={id:'plan-a',projectId:scope.projectId,lineageId:'plan-a',revision:1,contentHash:'d'.repeat(64),state:'draft',draft:proposal};
const view=(records:PlanningSuggestion[]=[]):PlanningAgentView=>({...scope,records,busy:false,recoveryRequired:false,timeoutMs:60000,turnLimit:1,scope:preview.scope});
async function components(){
  const root=new URL('../web/',import.meta.url).href,hooks=registerHooks({load(url,context,next){
    if(url.startsWith(root)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/planning/PlanningAgent.tsx');}finally{hooks.deregister();}
}

test('simple planning presents an accessible idea input and collapses technical disclosure without starting requests',async()=>{
  const {PlanningAgentPanel}=await components();let posts=0;
  const props:PlanningAgentPanelProps={...scope,presentation:'simple',workspaceId:null,post:async()=>{posts++;throw Error('Unexpected POST');},onSaved:()=>{throw Error('Unexpected save');}};
  const html=renderToStaticMarkup(createElement(PlanningAgentPanel,props));
  assert.match(html,/<h3>무엇을 만들고 싶으세요\?<\/h3>/);
  assert.match(html,/<label>만들고 싶은 프로그램<textarea[^>]*placeholder="[^"]*웹[^"]*"/);
  assert.match(html,/<details[^>]*><summary>기획 도우미의 실행 범위와 제한<\/summary>/);
  assert.match(html,/네이티브 파일 읽기/);assert.match(html,/컨텍스트.*보존.*공급자 전송/);assert.match(html,/1 turn.*60초/);
  assert.match(html,/maxLength="8000"/i);assert.match(html,/8,000자.*32 KiB/);assert.match(html,/요청 원문을 저장하지 않습니다/);
  assert.match(html,/<button[^>]*disabled[^>]*>기획 요청 미리보기/);assert.equal(posts,0);
  const advanced=renderToStaticMarkup(createElement(PlanningAgentPanel,{...props,presentation:undefined}));
  assert.match(advanced,/<h3>Codex 기획 제안 · 선택 기능<\/h3>/);assert.match(advanced,/<label>기획 요청<textarea/);
  assert.doesNotMatch(advanced,/<summary>기획 도우미의 실행 범위와 제한/);
});

// Execute the production panel and coordinator with generic hooks. The polling
// effect is inert; explicit refresh handlers drive the real HTTP boundary. Only
// the unrelated draft renderer is replaced; preview/history handlers stay real.
function panelFixture(props:PlanningAgentPanelProps,get:()=>PlanningAgentView){
  const target=new URL('../web/planning/PlanningAgent.tsx',import.meta.url),require=createRequire(target),slots:any[]=[];let cursor=0;
  const hooks={useRef(initial:any){const i=cursor++;return slots[i]??={current:initial};},useMemo(run:()=>unknown){const i=cursor++;if(!(i in slots))slots[i]=run();return slots[i];},useSyncExternalStore(_subscribe:any,snapshot:()=>unknown){cursor++;return snapshot();},useLayoutEffect(run:()=>unknown,deps:unknown[]){const i=cursor++,old=slots[i] as unknown[]|undefined;if(!old||deps.some((value,j)=>value!==old[j])){slots[i]=deps;run();}},useEffect(){cursor++;}};
  const source=ts.transpileModule(readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,module={exports:{} as any};
  new Function('require','module','exports','fetch',source)((id:string)=>id==='react'?{...require('react'),...hooks}:id.endsWith('.css')?{}:id==='./PlanningStudio.tsx'?{PlanningPreview:()=>null}:require(id),module,module.exports,async()=>({ok:true,json:async()=>get()}));
  return {render(){cursor=0;return module.exports.PlanningAgentPanel(props);}};
}
function nodes(tree:any):any[]{if(tree==null||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(nodes);if(typeof tree.type==='function')return nodes(tree.type(tree.props));return [tree,...nodes(tree.props?.children)];}
const text=(node:any):string=>node==null?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node);
function button(tree:any,label:string){const found=nodes(tree).find(node=>node.type==='button'&&text(node)===label);assert.ok(found,'Missing button: '+label);return found;}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('simple panel keeps explicit consent, exact preview scope, start receipt and proposal save host callback',async()=>{
  const posts:{path:string;body:any}[]=[],notifications:PlanningVersion[]=[];let records:PlanningSuggestion[]=[];
  let confirmStart!:()=>void;const startPosted=new Promise<void>(resolve=>{confirmStart=resolve;});
  const panel=panelFixture({...scope,presentation:'simple',post:async(path,body)=>{posts.push({path,body});if(path.endsWith('/preview'))return preview;if(path.endsWith('/start')){confirmStart();return {...completed,execution:'running',proposal:null,outputDigest:null,processStopped:false};}if(path.endsWith('/save'))return saved;throw Error(path);},onSaved:version=>notifications.push(version)},()=>view(records));
  let tree=panel.render();assert.equal(posts.length,0);button(tree,'기획 상태 새로고침').props.onClick();await settle();tree=panel.render();
  for(const value of ['   ','a'.repeat(8001)]){
    nodes(tree).find(node=>node.type==='textarea').props.onChange({target:{value}});tree=panel.render();
    assert.equal(button(tree,'기획 요청 미리보기').props.disabled,true);button(tree,'기획 요청 미리보기').props.onClick();await settle();assert.equal(posts.length,0);
  }
  nodes(tree).find(node=>node.type==='textarea').props.onChange({target:{value:'A local task board web app'}});tree=panel.render();
  assert.equal(button(tree,'기획 요청 미리보기').props.disabled,false);button(tree,'기획 요청 미리보기').props.onClick();await settle();tree=panel.render();
  assert.equal(posts.length,1);assert.deepEqual(posts[0],{path:'/api/projects/project-a/planning-suggestions/preview',body:{workspaceId:'workspace-a',text:'A local task board web app'}});
  const disclosure=nodes(tree).find(node=>node.type==='details'&&text(node).includes('정확한 전송 입력'));
  assert.ok(disclosure,'Exact instructions must remain available in a disclosure');assert.ok(text(disclosure).includes(preview.instructions));
  const previewSection=nodes(tree).find(node=>node.props?.['aria-label']==='기획 요청 전송 미리보기');
  assert.ok(text(previewSection).includes(preview.scope));assert.ok(text(previewSection).includes('60초'));
  const consent=nodes(previewSection).find(node=>node.type==='input'&&node.props.type==='checkbox');assert.equal(consent.props.checked,false);
  const start=button(tree,'동의한 기획 제안 시작');assert.equal(start.props.disabled,true);start.props.onClick();await settle();assert.equal(posts.length,1);
  consent.props.onChange({target:{checked:true}});tree=panel.render();assert.equal(button(tree,'동의한 기획 제안 시작').props.disabled,false);
  button(tree,'동의한 기획 제안 시작').props.onClick();await startPosted;await settle();tree=panel.render();assert.equal(posts.length,2);
  assert.equal(posts[1].path,'/api/projects/project-a/planning-suggestions/start');assert.match(posts[1].body.requestId,/^[a-f0-9-]{36}$/);
  assert.deepEqual({...posts[1].body,requestId:'receipt'},{requestId:'receipt',workspaceId:'workspace-a',text:'A local task board web app',expectedPreviewDigest:'b'.repeat(64),confirmed:true});
  assert.deepEqual(notifications,[]);records=[completed];button(tree,'기획 상태 새로고침').props.onClick();await settle();tree=panel.render();
  const save=button(tree,'제안을 새 기획 초안으로 저장');assert.equal(save.props.disabled,false);save.props.onClick();await settle();
  assert.deepEqual(posts[2],{path:'/api/projects/project-a/planning-suggestions/suggestion-a/save',body:{workspaceId:'workspace-a',expectedOutputDigest:'c'.repeat(64)}});assert.deepEqual(notifications,[saved]);
});
