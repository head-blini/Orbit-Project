import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

async function components(){
  const root=new URL('../web/',import.meta.url).href;
  const hook=registerHooks({load(url,context,next){if(url.startsWith(root)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});
  try{return {...await import('../web/app-preview.tsx'),...await import('../web/pages.tsx'),...await import('../web/development-results.tsx')};}finally{hook.deregister();}
}
test('preview follows observed workspace revisions even when the latest Run has not changed',async()=>{
  const {Development,DevelopmentResultPanel}=await components();
  const state:any={provider:'disconnected',runs:[],lastSeq:5,selectedWorkspaceId:'w',workspaces:[{id:'w',projectId:'p',status:'ready',path:'/fixture',branch:'orbit/w',baseSha:'a'.repeat(40)}]};
  const panel=(state:any)=>{const element=Development({state,projectId:'p',onProjects:()=>{},online:true});return element.props.children.find((child:any)=>child?.type===DevelopmentResultPanel);};
  assert.notEqual(panel(state).props.refreshKey,panel({...state,lastSeq:6}).props.refreshKey);
  assert.equal(panel({...state,verificationBusy:true}).props.locked,true);
});
test('preview URL must match the origin authorized by the loaded document, including across restart',async()=>{
  const {previewOriginMatches}=await components();
  assert.equal(previewOriginMatches('http://127.0.0.1:50001/token/index.html','http://127.0.0.1:50000'),false);
  assert.equal(previewOriginMatches('http://127.0.0.1:50000/token/index.html','http://127.0.0.1:50000'),true);
  assert.equal(previewOriginMatches('javascript:alert(1)',''),false);
});
test('app preview frame grants scripts without origin, navigation, form, popup or download permissions',async()=>{
  const {AppPreviewFrame}=await components();
  const preview={id:'a'.repeat(64),workspaceId:'w',sourceDigest:'b'.repeat(64),entryPath:'index.html',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),url:'http://127.0.0.1:50000/'+'a'.repeat(64)+'/index.html',fileCount:1};
  const markup=renderToStaticMarkup(createElement(AppPreviewFrame,{preview}));
  assert.match(markup,/sandbox="allow-scripts"/);assert.match(markup,/referrerPolicy="no-referrer"/);assert.match(markup,/title="생성된 웹앱 미리보기"/);
  assert.doesNotMatch(markup,/allow-same-origin|allow-popups|allow-top-navigation|allow-forms|allow-downloads|srcDoc|<script/);
});
test('app preview UI describes actual static scope and requires a live server',async()=>{
  const {AppPreviewPanel}=await components();let posts=0;
  const markup=renderToStaticMarkup(createElement(AppPreviewPanel,{workspaceId:'w',online:false,locked:false,refreshKey:'',post:async()=>{posts++;}}));
  assert.match(markup,/결과 미리보기/);assert.match(markup,/HTML/);assert.match(markup,/빌드/);assert.match(markup,/서버 연결/);assert.match(markup,/disabled/);
  assert.doesNotMatch(markup,/<iframe|검증 성공|개발 완료/);assert.equal(posts,0);
});
