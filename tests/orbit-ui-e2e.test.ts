import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { buttonRef,cliData,evalResult,containedPath,isolatedEnvironment,phaseSignal,runProcess,overallStatus } from '../scripts/lib/orbit-ui-e2e.ts';

test('E2E CLI response parsing rejects false, malformed, and unknown evaluation responses',()=>{
  assert.deepEqual(cliData('{"success":true,"data":{"result":false}}'),{result:false});
  assert.equal(evalResult('{"success":true,"data":{"result":false}}'),false);
  assert.equal(evalResult('{"success":true,"data":{"result":true}}'),true);
  for(const output of ['','true','{"success":false,"error":"denied"}','{"success":true}','{"data":{"result":true}}'])assert.throws(()=>evalResult(output));
  assert.throws(()=>evalResult('{"success":true,"data":{"value":true}}'));
});
test('E2E evidence paths cannot escape their own run directory, including junctions',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-e2e-path-test-'));
  const outside=mkdtempSync(join(tmpdir(),'orbit-e2e-outside-'));
  try{
    mkdirSync(join(root,'screenshots'));
    assert.equal(containedPath(root,'screenshots','a.png'),join(root,'screenshots','a.png'));
    assert.throws(()=>containedPath(root,'..','outside'));
    symlinkSync(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>containedPath(root,'escape','x.png'));
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('E2E child env excludes provider/profile/secrets and keeps inherited approval constraints',()=>{
  const env=isolatedEnvironment({PATH:'tools',SystemRoot:'windows',USERPROFILE:'profile',OPENAI_API_KEY:'synthetic',AGENT_BROWSER_PROFILE:'Default',AGENT_BROWSER_PROVIDER:'cloud',AGENT_BROWSER_ARGS:'unsafe',AGENT_BROWSER_ACTION_POLICY:'policy.json',AGENT_BROWSER_CONFIRM_ACTIONS:'navigate',ORBIT_ALLOWED_PROJECTS:'["real"]'});
  assert.equal(env.PATH,'tools');assert.equal(env.USERPROFILE,'profile');
  assert.equal(env.AGENT_BROWSER_ACTION_POLICY,'policy.json');assert.equal(env.AGENT_BROWSER_CONFIRM_ACTIONS,'navigate');
  for(const key of ['OPENAI_API_KEY','AGENT_BROWSER_PROFILE','AGENT_BROWSER_PROVIDER','AGENT_BROWSER_ARGS','ORBIT_ALLOWED_PROJECTS'])assert.equal(env[key],undefined);
});
test('E2E command transport preserves quotes, Korean, newlines and shell syntax as literal arguments',async()=>{
  const value='한글 "quotes"\n$(literal) & | %PATH%';
  const result=await runProcess(process.execPath,['-e','process.stdout.write(JSON.stringify(process.argv[1]))',value]);
  assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout),value);
});
test('E2E timed-out command is failed and its owned process is stopped',async()=>{
  const result=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:150});
  assert.equal(result.timedOut,true);assert.notEqual(result.code,0);
  assert.throws(()=>process.kill(result.pid!,0),{code:'ESRCH'});
});
test('E2E preflight and partial evidence never produce a browser pass',()=>{
  assert.equal(overallStatus(true,[{status:'passed'}],[]),'not_run');
  assert.equal(overallStatus(false,[{status:'passed'},{status:'not_run'}],[]),'failed');
  assert.equal(overallStatus(false,[{status:'passed'}],['browser close failed']),'failed');
  assert.equal(overallStatus(false,[{status:'passed'}],[]),'passed');
});
test('E2E interruption cancels actions but still permits evidence and owned-session cleanup',async()=>{
  const active=new AbortController();active.abort();
  await assert.rejects(runProcess(process.execPath,['-e','process.exit(0)'],{signal:phaseSignal(active.signal,false)}),/E2E_INTERRUPTED/);
  const cleanup=await runProcess(process.execPath,['-e','process.stdout.write("cleanup-ran")'],{signal:phaseSignal(active.signal,true)});
  assert.equal(cleanup.code,0);assert.equal(cleanup.stdout,'cleanup-ran');
});
test('E2E button actions require an unambiguous current accessibility ref',()=>{
  const snapshot=(refs:object)=>JSON.stringify({success:true,data:{refs}});
  assert.equal(buttonRef(snapshot({e4:{role:'button',name:'초안 저장'}}),'초안 저장'),'@e4');
  assert.equal(buttonRef(snapshot({e8:{role:'button',name:'Fixture · mermaid · 버전 1'}}),'Fixture ·',true),'@e8');
  assert.throws(()=>buttonRef(snapshot({e1:{role:'button',name:'저장'},e2:{role:'button',name:'저장'}}),'저장'));
  assert.throws(()=>buttonRef(snapshot({e1:{role:'link',name:'저장'}}),'저장'));
});
