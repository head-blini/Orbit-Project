// Isolated browser smoke: temporary profile, no server, network or model calls.
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildSync} from 'esbuild';
import assert from 'node:assert/strict';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if(!existsSync(chrome))throw new Error('Chrome not installed; browser smoke not run');
const temp=mkdtempSync(join(tmpdir(),'orbit-quality-browser-'));
try{
 const loop={id:'loop',result:{status:'reviewing',repairs:1,rounds:[{failures:[{criterion:'출처',evidence:'독립검증근거'}]}],issue:null},recoveryRequired:false,
 producer:{providerId:'anthropic',modelId:'unknown',sessionId:'source-session',runId:'source-run'},reviewers:[{providerId:'openai',modelId:'chosen-model'}],
 verification:{status:'unknown'},version:{id:'approved-v1'},baseline:{digest:'frozen-baseline'},steps:[{id:'repair',kind:'repair',state:'completed',evidence:{providerId:'anthropic',modelId:'observed-model',sessionId:'repair-session',runId:'repair-run',source:'native_observed'}}]};
 const source=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{QualityLoopStatus}from'./web/project-progress.tsx';
 const loop=${JSON.stringify(loop)};function App(){const[advanced,set]=useState(false);return React.createElement('main',null,React.createElement('button',{id:'mode',onClick:()=>set(v=>!v)},'모드 전환'),React.createElement(QualityLoopStatus,{loop,advanced}));}createRoot(document.getElementById('app')).render(React.createElement(App));
 const check=(v,m)=>{if(!v)throw Error(m)};setTimeout(()=>{try{check(document.body.textContent.includes('재검증 중'),'simple status');check(!document.body.textContent.includes('repair-session'),'simple evidence leak');document.getElementById('mode').click();setTimeout(()=>{try{check(document.body.textContent.includes('repair-session'),'advanced evidence');document.querySelector('summary').click();check(document.querySelector('details').open,'evidence expand');check(document.body.textContent.includes('독립검증근거'),'findings');check(document.body.textContent.includes('미확인'),'unknown check');document.getElementById('mode').click();setTimeout(()=>{try{check(!document.body.textContent.includes('repair-session'),'return simple');document.body.dataset.result='passed';}catch(e){document.body.dataset.result=e.message}},100)}catch(e){document.body.dataset.result=e.message}},100)}catch(e){document.body.dataset.result=e.message}},100);`;
 buildSync({stdin:{contents:source,resolveDir:resolve('.'),loader:'jsx'},bundle:true,outfile:join(temp,'app.js'),platform:'browser',format:'iife'});
 writeFileSync(join(temp,'index.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><div id="app"></div><script src="app.js"></script></html>');
 const html=execFileSync(chrome,['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--user-data-dir='+join(temp,'profile'),'--virtual-time-budget=3000','--dump-dom','file://'+join(temp,'index.html')],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
 assert.match(html,/data-result="passed"/);console.log('Quality Loop Chrome smoke passed: simple → advanced → expand evidence → simple. No model calls.');
}finally{rmSync(temp,{recursive:true,force:true});}
