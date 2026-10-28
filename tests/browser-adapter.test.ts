import test from 'node:test';
import assert from 'node:assert/strict';
import {browserTargetPolicy,sanitizeBrowserEvent,probeBrowserAdapters,BrowserSessionLog} from '../server/browser/adapter.ts';

test('ChatGPT web automation stays blocked until terms and an official path are confirmed',()=>{
  for(const url of ['https://chatgpt.com/','https://chat.openai.com/c/abc','https://www.chatgpt.com/g/x','https://CHATGPT.com'])
    assert.deepEqual(browserTargetPolicy(url,{allowedOrigins:['https://chatgpt.com']}),{allowed:false,code:'POLICY_REVIEW_REQUIRED'});
});

test('loopback is allowed, external origins need an explicit project allowance, unsafe schemes are refused',()=>{
  assert.deepEqual(browserTargetPolicy('http://127.0.0.1:4317/#/progress',{}),{allowed:true});
  assert.deepEqual(browserTargetPolicy('http://localhost:5173/',{}),{allowed:true});
  assert.deepEqual(browserTargetPolicy('https://example.com/report',{}),{allowed:false,code:'ORIGIN_APPROVAL_REQUIRED'});
  assert.deepEqual(browserTargetPolicy('https://example.com/report',{allowedOrigins:['https://example.com']}),{allowed:true});
  assert.deepEqual(browserTargetPolicy('https://example.com.evil.test/',{allowedOrigins:['https://example.com']}),{allowed:false,code:'ORIGIN_APPROVAL_REQUIRED'});
  for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,x','chrome://settings','not a url','http://user:pw@127.0.0.1/'])
    assert.equal(browserTargetPolicy(url,{}).allowed,false,url);
});

test('session events keep only origin, path shape and status: no query, cookies, profile paths or page text',()=>{
  const event=sanitizeBrowserEvent({kind:'navigated',url:'https://example.com/a/b?token=abc#frag',profilePath:'/Users/x/Library/Chrome/Default',cookies:'sid=1',text:'page body'});
  assert.deepEqual(event,{kind:'navigated',origin:'https://example.com',path:'/a/b'});
  assert.deepEqual(sanitizeBrowserEvent({kind:'error',code:'TIMEOUT',message:'at /Users/x secret sk-abc'}),{kind:'error',code:'TIMEOUT'});
  assert.deepEqual(sanitizeBrowserEvent({kind:'error',code:'weird code with spaces'}),{kind:'error',code:'UNKNOWN'});
  assert.equal(sanitizeBrowserEvent({kind:'evaluate',script:'document.cookie'}),null);
});

test('a browser session log separates interrupt request from confirmed close and never invents completion',()=>{
  const log=new BrowserSessionLog('s1','agent-browser');
  log.record({kind:'started'});log.record({kind:'navigated',url:'http://127.0.0.1:4317/'});
  assert.equal(log.view().state,'running');
  log.record({kind:'interrupt_requested'});assert.equal(log.view().state,'interrupt_requested');
  log.record({kind:'closed',observed:true});assert.equal(log.view().state,'closed');
  const silent=new BrowserSessionLog('s2','playwright');silent.record({kind:'started'});
  assert.equal(silent.view().state,'running');assert.equal(silent.view().lastObservedAt!==null,true);
  const failed=new BrowserSessionLog('s3','playwright');failed.record({kind:'started'});failed.record({kind:'error',code:'NAVIGATION_FAILED'});
  assert.equal(failed.view().state,'error');assert.equal(failed.view().error,'NAVIGATION_FAILED');
  failed.record({kind:'navigated',url:'http://127.0.0.1/'});assert.equal(failed.view().state,'error','a late event cannot clear an error');
});

test('probes report not_installed without installing or downloading anything',async()=>{
  const calls:string[][]=[];
  const probes=await probeBrowserAdapters({
    findExecutable:name=>{calls.push(['find',name]);return null;},
    run:async(path,args)=>{calls.push([path,...args]);return {code:0,stdout:'1.0.0'};},
    resolvePackage:name=>{calls.push(['resolve',name]);return null;},
  });
  assert.deepEqual(probes.map(p=>[p.id,p.status,p.purpose]),[['agent-browser','not_installed','ai_browsing'],['playwright','not_installed','ui_e2e']]);
  assert.ok(!calls.some(call=>call.some(part=>/install|npx|download/.test(part))));
});

test('an installed tool is only "installed"; features stay unknown until verified',async()=>{
  const probes=await probeBrowserAdapters({
    findExecutable:name=>name==='agent-browser'?'/opt/bin/agent-browser':null,
    run:async()=>({code:0,stdout:'agent-browser 0.9.1\n'}),
    resolvePackage:name=>name==='playwright'?'/repo/node_modules/playwright/package.json':null,
    readVersion:()=>'1.55.0',
  });
  const agent=probes.find(p=>p.id==='agent-browser')!,pw=probes.find(p=>p.id==='playwright')!;
  assert.equal(agent.status,'installed');assert.equal(agent.version,'0.9.1');assert.equal(agent.verified,false);
  assert.equal(pw.status,'installed');assert.equal(pw.version,'1.55.0');
  for(const p of probes)assert.ok(Object.values(p.capabilities).every(v=>v==='unknown'));
  const broken=await probeBrowserAdapters({findExecutable:()=>'/opt/bin/agent-browser',run:async()=>({code:1,stdout:''}),resolvePackage:()=>null});
  assert.equal(broken.find(p=>p.id==='agent-browser')!.status,'error');
});
