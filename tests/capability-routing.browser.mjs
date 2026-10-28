// Disposable Chrome profile and mocked POST only; no server or model calls.
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildSync} from 'esbuild';
import assert from 'node:assert/strict';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if(!existsSync(chrome))throw new Error('Chrome unavailable; browser test not run');
const temp=mkdtempSync(join(tmpdir(),'orbit-route-browser-'));
try{
 const source=`import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{CapabilityRouting}from'./web/capability-routing.tsx';
 const root=createRoot(document.getElementById('app')),requests=[];
 const post=(path,body)=>new Promise(resolve=>requests.push({path,body,resolve}));
 const render=(projectId,taskId,advanced=false,records=[])=>flushSync(()=>root.render(React.createElement(CapabilityRouting,{projectId,taskId,advanced,post,records})));
 const check=(ok,label)=>{if(!ok)throw Error(label)},delay=()=>new Promise(resolve=>setTimeout(resolve,40));
 const type=text=>{const field=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,text);field.dispatchEvent(new Event('input',{bubbles:true}));};
 const answer=(index,over={})=>{const {body,resolve}=requests[index];resolve({ok:true,json:async()=>({id:'route-'+index,requestId:body.requestId,projectId:'project-b',taskId:body.taskId,createdAt:'2026-10-28',intent:'review',status:'recommended',runtimeId:'codex',capabilityId:'review.text',reasons:['reason-evidence'],baseline:{planningVersionId:'v',planningContentHash:'baseline-evidence'},preferencesRevision:1,registryDigest:'registry-evidence',textDigest:'text-evidence',executionAuthorized:false,actualModel:'unknown',...over})})};
 (async()=>{render('project-a','task-a');await delay();type('자료를 검토하세요');await delay();document.querySelector('button').click();await delay();check(requests.length===1,'one recommendation request');check(requests[0].path==='/api/projects/project-a/capability-routes','scoped endpoint');check(Object.keys(requests[0].body).sort().join(',')==='requestId,taskId,text','no model override');
 render('project-b','task-b');await delay();answer(0,{projectId:'project-a',taskId:'task-a',runtimeId:'claude-code'});await delay();check(!document.body.textContent.includes('claude-code'),'stale project response');
 type('보고서를 검토하세요');await delay();document.querySelector('button').click();await delay();check(requests.length===2,'second recommendation');answer(1);await delay();check(document.body.textContent.includes('실행 승인이 아닙니다'),'not execution approval');check(document.body.textContent.includes('codex'),'recommendation shown');check(!document.body.textContent.includes('registry-evidence'),'simple hides provenance');const newer={id:'newer-route',projectId:'project-b',taskId:'task-b',createdAt:'2026-10-29',status:'recommended',runtimeId:'claude-code',capabilityId:'review.text'};render('project-b','task-b',false,[newer]);await delay();check(document.body.textContent.includes('claude-code'),'new server record visible');check(!document.body.textContent.includes('codex'),'old local result does not hide new record');render('project-b','task-b',true);await delay();check(document.body.textContent.includes('registry-evidence'),'advanced provenance');check(document.body.textContent.includes('실제 실행 모델: unknown'),'actual unknown');
 type('다시 검토하세요');await delay();document.querySelector('button').click();await delay();render('project-b','task-c');await delay();answer(2);await delay();check(!document.body.textContent.includes('registry-evidence'),'stale task response');check(requests.every(r=>r.path.endsWith('/capability-routes')),'recommendation only');document.body.dataset.result='passed';})().catch(error=>document.body.dataset.result=error.message);`;
 buildSync({stdin:{contents:source,resolveDir:resolve('.'),loader:'jsx'},bundle:true,outfile:join(temp,'app.js'),platform:'browser',format:'iife'});
 writeFileSync(join(temp,'index.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><div id="app"></div><script src="app.js"></script></html>');
 const html=execFileSync(chrome,['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--user-data-dir='+join(temp,'profile'),'--virtual-time-budget=4000','--dump-dom','file://'+join(temp,'index.html')],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
 assert.match(html,/data-result="passed"/);console.log('Capability routing browser smoke passed: mocked POST, stale project/task suppression, simple/advanced evidence.');
}finally{rmSync(temp,{recursive:true,force:true});}
