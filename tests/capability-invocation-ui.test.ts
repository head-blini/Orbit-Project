import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
async function view(name:string){const hooks=registerHooks({load(url,context,next){if(url.startsWith(new URL('../web/',import.meta.url).href)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});try{return await import(`../web/${name}.tsx`);}finally{hooks.deregister();}}
const decision={id:'route',projectId:'p',taskId:'t',runId:'run',invocationDigest:'digest',status:'recommended',intent:'interrupt',runtimeId:'codex'};
test('interrupt requires explicit approval; missing target or digest cannot invoke',async()=>{
 const {CapabilityInvocation}=await view('capability-invocation');const post=async()=>{throw Error('render cannot invoke');};
 const html=renderToStaticMarkup(createElement(CapabilityInvocation,{decision,post}));assert.match(html,/중단 요청을 승인합니다/);assert.match(html,/<button disabled="">승인하고 중단 요청/);assert.doesNotMatch(html,/checked=""/);assert.match(html,/새 모델 작업을 시작하지 않습니다/);
 for(const extra of [{runId:undefined},{invocationDigest:undefined},{status:'blocked'}]){const missing=renderToStaticMarkup(createElement(CapabilityInvocation,{decision:{...decision,intent:'result',...extra},post}));assert.match(missing,/<button disabled="">저장된 실행 결과 조회/);}
});
test('interrupt requested and mock quality passed do not imply stopped or live verified',async()=>{
 const {InvocationEvidence}=await view('capability-invocation');
 const html=renderToStaticMarkup(createElement(InvocationEvidence,{record:{id:'i',routeId:'route',runId:'run',status:'requested',issue:null,result:{execution:'interrupting',terminal:false,stopConfirmed:false,response:'<script>unsafe</script>',providerEvidence:{source:'mock',quality:'passed',livePipelineVerified:true}}}}));
 assert.match(html,/요청 접수 · 종료 확인 아님/);assert.match(html,/작업 정지 기록: 미확인/);assert.match(html,/실행 증거 출처: mock/);assert.match(html,/실 Provider 전체 흐름: 검증 대기/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('target select is explicit and scoped to this task and project',async()=>{
 const {CapabilityRouting}=await view('capability-routing');
 const html=renderToStaticMarkup(createElement(CapabilityRouting,{projectId:'p',taskId:'t',advanced:false,post:async()=>{},executions:[{id:'a',projectId:'p',taskId:'t',runId:'run',runtimeId:'codex',status:'running'},{id:'b',projectId:'other',taskId:'t',runId:'foreign',runtimeId:'codex',status:'running'},{id:'c',projectId:'p',taskId:'other',runId:'other-task',runtimeId:'codex',status:'running'}]}));
 assert.match(html,/<option value="" selected="">대상을 직접 선택하세요/);assert.match(html,/<option value="run">/);assert.doesNotMatch(html,/foreign|other-task/);
});
test('support matrix separates discovery invocation verification and historical sources',async()=>{
 const {CapabilityMatrixDetails}=await view('capability-matrix');
 const html=renderToStaticMarkup(createElement(CapabilityMatrixDetails,{registry:{providers:[{runtimeId:'codex',version:null,capabilities:[{id:'slash_commands',discovery:'implemented',invocation:'unsupported',verification:'unknown',policy:'blocked',validation:{nativeRuns:1,mockRuns:2,unknownRuns:3,lastRunId:'historical-run'}}]}]}}));
 assert.match(html,/<th>발견<\/th><th>호출<\/th><th>검증<\/th>/);assert.match(html,/미지원/);assert.match(html,/native 1 · mock 2 · unknown 3/);assert.match(html,/과거 실행 증거는 현재 실행의 성공이나 권한을 보장하지 않습니다/);assert.match(html,/historical-run/);
});

const toolState=(kind:string,itemId:string,over:object={})=>({key:{runtimeId:'codex',kind,itemId},installed:'discovered',permitted:null,invoked:{native:0,mock:0,unknown:0},verified:0,...over});
const toolRegistry=(tools?:object)=>({providers:[],tools});
test('tool states render four separate states and mock-only shows verification 0',async()=>{
 const {CapabilityMatrixDetails,ToolStatePanel}=await view('capability-matrix');
 const tools={states:[toolState('mcp','abcdefghijklmnopqrstuvwxyz',{permitted:{grantId:'g',itemDigest:'d'},invoked:{native:0,mock:2,unknown:1}}),toolState('hook','h1',{installed:'unknown'}),{...toolState('mcp','cc',{installed:'absent'}),key:{runtimeId:'claude-code',kind:'mcp',itemId:'cc'}},toolState('plugin','p1'),toolState('skill','s1')],totals:{keys:5,installed:4,permitted:1,invoked:{native:0,mock:2,unknown:1},verified:0}};
 const simple=renderToStaticMarkup(createElement(CapabilityMatrixDetails,{registry:toolRegistry(tools) as never}));
 assert.match(simple,/설치: 발견됨 4건 · 허용: 현재 작업 grant 1건 · 호출: native 0 · mock 2 · unknown 1 · 검증: native 0건/);
 assert.match(simple,/mock\/unknown 호출은 검증이 아닙니다/);assert.doesNotMatch(simple,/검증됨/);assert.doesNotMatch(simple,/<tbody>/);
 for(const reason of ['Claude MCP 차단','발견 전용','플러그인 로드 안 함','스킬 미지원'])assert.match(simple,new RegExp(reason));
 const adv=renderToStaticMarkup(createElement(ToolStatePanel,{tools:tools as never,mode:'advanced'}));
 assert.match(adv,/<th scope="row">abcdefghijkl<\/th><td>발견됨<\/td><td>현재 작업 grant 있음<\/td><td>native 0 · mock 2 · unknown 1<\/td><td>native 0건<\/td>/);
 assert.doesNotMatch(adv,/abcdefghijklm/);assert.match(adv,/<td>미확인<\/td><td>없음<\/td>/);assert.match(adv,/<td>없음<\/td><td>없음<\/td>/);assert.doesNotMatch(adv,/검증됨/);
 const before=renderToStaticMarkup(createElement(CapabilityMatrixDetails,{registry:toolRegistry() as never}));
 assert.doesNotMatch(adv,/<button|<form/);assert.doesNotMatch(simple,/<button|<form/);assert.doesNotMatch(before,/<button|<form/);
});
test('absent tools field shows no-information notice',async()=>{
 const {CapabilityMatrixDetails}=await view('capability-matrix');
 const html=renderToStaticMarkup(createElement(CapabilityMatrixDetails,{registry:toolRegistry() as never}));
 assert.match(html,/도구 상태 정보 없음/);assert.doesNotMatch(html,/검증: native/);
});

test('lost journal terminal state is not presented as an observed process exit',async()=>{
 const {InvocationEvidence}=await view('capability-invocation');
 const html=renderToStaticMarkup(createElement(InvocationEvidence,{record:{id:'i',routeId:'route',runId:'run',status:'completed',issue:null,result:{execution:'lost',terminal:true,stopConfirmed:false,response:null,providerEvidence:{source:'unknown',quality:'not_started',livePipelineVerified:false}}}}));
 assert.match(html,/기록상 종결 상태: 예/);assert.match(html,/작업 정지 기록: 미확인/);assert.doesNotMatch(html,/실행 종료: 관측됨/);
});
