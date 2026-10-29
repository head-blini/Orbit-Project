import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

async function components(){
 const root=new URL('../web/',import.meta.url).href;
 const hook=registerHooks({load(url,context,next){if(url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});
 try{return {...await import('../web/development-results.tsx'),...await import('../web/pages.tsx'),...await import('../web/app-preview.tsx'),...await import('../web/reuse-vendor.tsx'),...await import('../web/agent-center.tsx'),...await import('../web/studios.tsx')};}finally{hook.deregister();}
}
const run=(id:string,execution='completed',workspaceId='w')=>({id,workspaceId,execution,createdAt:'2026-10-27T00:00:00Z',updatedAt:'2026-10-27T00:00:00Z',prompt:'fixture',response:'',verification:'not_run'});
const state:any={provider:'disconnected',runs:[run('first'),run('second')],lastSeq:5,selectedWorkspaceId:'w',workspaces:[{id:'w',projectId:'p',status:'ready',path:'/fixture',branch:'orbit/w',baseSha:'a'.repeat(40)}]};
const view:any={workspaceId:'w',projectId:'p',sourceDigest:'a'.repeat(64),sourceIssue:null,observedAt:'2026-10-27T00:00:00Z',run:run('first'),task:{id:'t',title:'할 일 추가',requirementLabels:['TODO']},planning:{id:'plan',title:'할 일 앱',revision:1,contentHash:'b'.repeat(64),state:'approved',current:true},linkIssue:null,verification:{available:true,canApprove:true,approvalCurrent:false,quarantined:false,commands:[{id:'test',label:'Check',configDigest:'c'.repeat(64)}],checks:[],scope:'fixture scope'}};
test('explicit Run selection survives newer Runs and never borrows a foreign or missing Run',async()=>{
 const {selectedDevelopmentRun}=await components();
 assert.equal(selectedDevelopmentRun(state,null)?.id,'second');
 assert.equal(selectedDevelopmentRun({...state,runs:[...state.runs,run('third')]},{workspaceId:'w',runId:'first'})?.id,'first');
 assert.equal(selectedDevelopmentRun(state,{workspaceId:'w',runId:'missing'}),null);
 assert.equal(selectedDevelopmentRun({...state,runs:[run('foreign','completed','other')]},null),null);
});
test('Development sends the explicitly selected terminal Run to every result action panel',async()=>{
 const {Development}=await components();
 const tree=Development({state,projectId:'p',onProjects:()=>{},online:true,selection:{workspaceId:'w',runId:'first'}} as any);
 const children=(v:any):any[]=>Array.isArray(v)?v.flatMap(children):v&&typeof v==='object'&&v.props?[v,...children(v.props.children)]:[];
 for(const name of ['ReviewPanel','VerificationPanel','MergePanel'])assert.equal(children(tree).find(e=>e.type.name===name)?.props.runId,'first',name);
 const active=Development({state:{...state,runs:[...state.runs,run('active','running')]},projectId:'p',onProjects:()=>{},online:true,selection:{workspaceId:'w',runId:'active'}} as any);
 for(const name of ['ReviewPanel','VerificationPanel','MergePanel'])assert.equal(children(active).find(e=>e.type.name===name)?.props.runId,null,name);
});
test('preview success evidence requires exact workspace/source and current authoritative check approval eligibility',async()=>{
 const {PreviewVerificationEvidence}=await components();
 const preview:any={workspaceId:'w',sourceDigest:view.sourceDigest};
 const html=(evidence:any)=>renderToStaticMarkup(createElement(PreviewVerificationEvidence,{preview,evidence}));
 assert.match(html(view),/같은 소스.*모두 통과/);
 assert.doesNotMatch(html({...view,sourceDigest:'d'.repeat(64)}),/모두 통과/);
 assert.doesNotMatch(html({...view,workspaceId:'other'}),/모두 통과/);
 assert.doesNotMatch(html({...view,verification:{...view.verification,canApprove:false}}),/모두 통과/);
 assert.doesNotMatch(html({...view,verification:{...view.verification,available:false}}),/모두 통과/);
});
test('result summary distinguishes planning provenance, command success, superseded planning and unknown source',async()=>{
 const {DevelopmentResultSummary}=await components();
 const html=(value:any)=>renderToStaticMarkup(createElement(DevelopmentResultSummary,{view:value}));
 assert.match(html(view),/할 일 추가/);assert.match(html(view),/현재 등록 명령 모두 통과/);assert.match(html(view),/요구사항 전체의 수용 판정/);
 assert.match(html({...view,planning:{...view.planning,state:'superseded',current:false}}),/이전 기획/);
 assert.doesNotMatch(html({...view,sourceDigest:null,sourceIssue:'SOURCE_UNAVAILABLE',verification:null}),/모두 통과/);
 assert.match(html({...view,verification:{...view.verification,commands:[],canApprove:false}}),/검증 명령 미설정/);
});

test('Planning result links require the exact project, workspace, Task and planning version',async()=>{
 const {taskResultRun,AgentCenter}=await components();
 const task:any={id:'t',projectId:'p',planningVersionId:'plan'};
 const correct={...run('correct'),taskId:'t',planningVersionId:'plan'};
 const snapshot={...state,runs:[correct,{...run('wrong'),taskId:'t',planningVersionId:'other'}]};
 assert.equal(taskResultRun('p',task,snapshot)?.id,'correct');
 assert.equal(taskResultRun('other',task,snapshot),null);
 assert.equal(taskResultRun('p',task,{...snapshot,runs:[{...correct,workspaceId:'elsewhere'}]}),null);
 const markup=renderToStaticMarkup(createElement(AgentCenter,{state:snapshot,matches:true,online:true,onResult:()=>{},prompt:'',pending:null} as any));
 assert.match(markup,/이 실행의 결과 확인/);
});
test('reuse vendor list shows adopt decisions with an import button, then files, sha256 prefix, license and source',async()=>{
 const {ReuseVendorList}=await components();
 const decision={planningVersionId:'plan',topic:'재사용: left-pad',decision:'재사용 채택: left-pad 1.3.0 (WTFPL) · https://www.npmjs.com/package/left-pad · 확인 2026-10-30T12:04:05+09:00'};
 const entry={name:'left-pad',version:'1.3.0',license:{decision:'WTFPL',package:'WTFPL'},sourceDecision:decision.topic,sourceUrl:'https://www.npmjs.com/package/left-pad',
  files:[{path:'vendor/left-pad-1.3.0/left-pad.min.js',url:'https://cdn.jsdelivr.net/npm/left-pad@1.3.0/dist/left-pad.min.js',sha256:'f'.repeat(64),bytes:23}],licenseFile:'license_file:absent',checkedAt:'2026-10-30T12:04:05+09:00',planningVersionId:'plan'};
 const html=(view:any,extra:any={})=>renderToStaticMarkup(createElement(ReuseVendorList,{view,busy:false,disabled:false,error:'',onImport:()=>{},...extra}));
 const before=html({evidence:{entries:[]},decisions:[decision]});
 assert.match(before,/aria-label="재사용: left-pad 재사용 구성요소 가져오기"/);assert.match(before,/재사용 구성요소 가져오기<\/button>/);assert.doesNotMatch(before,/sha256/);
 const after=html({evidence:{entries:[entry]},decisions:[decision]});
 assert.match(after,/vendor\/left-pad-1\.3\.0\/left-pad\.min\.js<\/code> · sha256 ffffffffffff · 23 bytes/);assert.doesNotMatch(after,/f{13}/);
 assert.match(after,/라이선스 WTFPL/);assert.match(after,/license_file:absent/);assert.match(after,/출처 https:\/\/www\.npmjs\.com\/package\/left-pad/);
 assert.match(html({evidence:{entries:[]},decisions:[decision]},{error:'재사용 구성요소를 가져오지 못했습니다: REUSE_VENDOR_UNSUPPORTED'}),/role="alert">[^<]*REUSE_VENDOR_UNSUPPORTED/);
 assert.match(html({evidence:{entries:[]},decisions:[decision]},{disabled:true}),/<button disabled=""/);
 assert.match(html({evidence:{entries:[]},decisions:[]}),/채택된 재사용 구성요소가 없습니다/);
});
