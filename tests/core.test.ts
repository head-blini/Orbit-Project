import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { safeText } from '../server/privacy.ts';
import { createWorkspace, assertWorkspace } from '../server/workspace.ts';

test('durable run/event history survives restart; incomplete run becomes lost, verification never inferred', () => {
  const path=join(mkdtempSync(join(tmpdir(),'aicc-db-')),'events.sqlite');
  let s=new Store(path);
  const run=s.createRun('request-0001','digest','hello');
  s.updateRun(run.id,{execution:'running',turnId:'turn-1'},'run.started');
  s.setThread('thread-1'); const cursor=s.lastSeq(); s.close();
  s=new Store(path);
  assert.equal(s.getRun(run.id)?.execution,'lost');
  assert.equal(s.getRun(run.id)?.verification,'not_run');
  assert.equal(s.getThread(),'thread-1');
  assert.equal(s.eventsAfter(cursor)[0].kind,'run.lost'); s.close();
});
test('request IDs are unique and conflicting prompts cannot create a second run', () => {
  const s=new Store(':memory:'); s.createRun('request-0001','digest-a','a');
  assert.equal(s.findRequest('request-0001')?.digest,'digest-a');
  assert.throws(()=>s.createRun('request-0001','digest-b','b'));
  assert.equal(s.runs().length,1); s.close();
});
test('terminal runs cannot regress from a late started event', () => {
  const s=new Store(':memory:'); const r=s.createRun('request-0001','digest','hi');
  s.updateRun(r.id,{execution:'completed'},'run.completed');
  s.updateRun(r.id,{execution:'running'},'run.started');
  assert.equal(s.getRun(r.id)?.execution,'completed');
  assert.equal(s.getRun(r.id)?.verification,'not_run'); s.close();
});
test('streamed text holds unfinished words and redacts known credentials across arbitrary chunk boundaries', () => {
  const secret='sk-FAKEONLY123456789';
  const input='hello '+secret+' done';
  for(let i=1;i<=input.length;i++) assert.equal(safeText(input.slice(0,i),false).includes('FAKEONLY'),false);
  assert.equal(safeText('Bearer fake-token-value',true).includes('fake-token-value'),false);
  assert.equal(safeText('access_token = abc123',true).includes('abc123'),false);
  assert.equal(safeText('normal answer',true),'normal answer');
});
test('only a generated fixture repository is accepted; junction substitution is rejected', () => {
  const base=mkdtempSync(join(tmpdir(),'aicc-workspace-')); const root=createWorkspace(base);
  assertWorkspace(root);
  assert.throws(()=>assertWorkspace(base));
  const link=join(base,'redirect');symlinkSync(root,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>assertWorkspace(link));
});
