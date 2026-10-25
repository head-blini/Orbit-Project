import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialRun, applyEvent, denyRequest, safeLog, ProviderRegistry, validatePlan, validateRoot } from './contracts.ts';

test('delta and completed fixture keep agent outcome separate from verification', () => {
  let s = initialRun('thread-fixture');
  s = applyEvent(s, {method:'turn/started',params:{threadId:s.threadId,turn:{id:'turn-fixture',status:'inProgress'}}});
  s = applyEvent(s, {method:'item/agentMessage/delta',params:{threadId:s.threadId,turnId:s.turnId,delta:'fixture'}});
  assert.equal(s.deltaCount,1);
  s = applyEvent(s, {method:'turn/completed',params:{threadId:s.threadId,turn:{id:s.turnId,status:'completed'}}});
  assert.equal(s.execution,'succeeded'); assert.equal(s.verification,'not_run');
});
test('interrupted, failed and transport loss fixtures are distinct', () => {
  for (const [status,expected] of [['interrupted','interrupted'],['failed','failed']]) {
    const s = applyEvent(initialRun('t'),{method:'turn/completed',params:{threadId:'t',turn:{id:'u',status}}});
    assert.equal(s.execution,expected);
  }
  assert.equal(applyEvent(initialRun('t'),{method:'transport/closed'}).execution,'lost');
  assert.equal(applyEvent(initialRun('t'),{method:'error',params:{threadId:'t',willRetry:true}}).execution,'created');
  assert.equal(applyEvent(initialRun('t'),{method:'error',params:{threadId:'t',willRetry:false}}).execution,'failed');
});
test('foreign thread/turn events cannot complete the current run', () => {
  let s = applyEvent(initialRun('t'),{method:'turn/started',params:{threadId:'t',turn:{id:'u'}}});
  s = applyEvent(s,{method:'turn/completed',params:{threadId:'other',turn:{id:'u',status:'completed'}}});
  s = applyEvent(s,{method:'turn/completed',params:{threadId:'t',turn:{id:'old',status:'completed'}}});
  assert.equal(s.execution,'running');
});
test('server approval fixtures deny by default and unknown requests fail closed', () => {
  for (const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval']) {
    assert.deepEqual(denyRequest({id:3,method,params:{}}),{id:3,result:{decision:'decline'}});
  }
  assert.deepEqual(denyRequest({id:4,method:'item/permissions/requestApproval'}).result,{permissions:{},scope:'turn'});
  assert.equal(denyRequest({id:5,method:'unknown/request'}).error.code,-32601);
});
test('log allowlist drops secrets and arbitrary sensitive text at any depth', () => {
  const log = JSON.stringify(safeLog({method:'error',id:2,params:{token:'secret',message:'private',command:'private',nested:{apiKey:'secret'}},stderr:'private'}));
  assert.equal(log.includes('secret'),false); assert.equal(log.includes('private'),false);
  assert.deepEqual(JSON.parse(log),{method:'error',id:2});
});
test('registry supports zero, one and two providers without pretending adapters exist', () => {
  const r = new ProviderRegistry(); assert.equal(r.ready().length,0);
  r.register({id:'codex',status:'ready',capabilities:{stream:'verified',approvals:'unknown'}});
  assert.equal(r.ready().length,1);
  r.register({id:'future-fixture',status:'not_installed',capabilities:{}});
  assert.equal(r.all().length,2); assert.equal(r.ready().length,1);
  for (const status of ['auth_required','unsupported','unknown']) r.register({id:status,status,capabilities:{}});
  assert.throws(()=>r.register({id:'bad',status:'fake',capabilities:{}}));
  assert.throws(()=>r.register({id:'codex',status:'ready',capabilities:{}}));
});
test('manual Markdown and external JSON provenance share account-free planning validation', () => {
  for (const format of ['markdown','json']) {
    const p = {schemaVersion:'0.1',version:1,source:{kind:format==='markdown'?'manual':'external',format},body:'fixture',acceptanceCriteria:['observable result']};
    assert.equal(validatePlan(p),true);
    assert.equal(validatePlan({...p,version:0}),false);
    assert.equal(validatePlan({...p,acceptanceCriteria:[]}),false);
    assert.equal(validatePlan({...p,source:{}}),false);
  }
});
test('canonical root validation rejects traversal, siblings, missing paths and symlink escape', () => {
  const base = mkdtempSync(join(tmpdir(),'phase0-path-')); const root=join(base,'root'); const outside=join(base,'root-other');
  mkdirSync(root); mkdirSync(outside); mkdirSync(join(root,'child'));
  assert.equal(validateRoot(root,join(root,'child')),true);
  assert.equal(validateRoot(root,join(root,'..','root-other')),false);
  assert.equal(validateRoot(root,join(root,'missing')),false);
  symlinkSync(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir');
  assert.equal(validateRoot(root,join(root,'escape')),false);
});
