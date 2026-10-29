import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {HarnessStore, type HarnessAppend, type HarnessPromotionGrant} from '../server/harness-store.ts';
import {harnessV0, harnessDigest} from '../server/harness-policy.ts';

const target = 'claude_task' as const;
const input = (requestId = 'version-request-1'): HarnessAppend => ({projectId: 'project-1', requestId,
  parentId: harnessV0(target).versionId, candidate: {class: 'execution_guidance', target,
    lines: ['입력 자료를 다시 확인하세요.'], origin: 'user', evidence: null}});
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-he2-'));
  let db = new Store(join(dir, 'store.sqlite'));
  const grants = new Map<string, HarnessPromotionGrant>();
  const options = {promotions: {getApprovedPromotion: (requestId: string) => grants.get(requestId) ?? null}};
  let store = new HarnessStore(db, options);
  t.after(() => {db.db.close(); rmSync(dir, {recursive: true, force: true});});
  return {path: join(dir, 'store.sqlite'), get db() {return db;}, get store() {return store;}, grants,
    reopen() {db.db.close(); db = new Store(join(dir, 'store.sqlite')); store = new HarnessStore(db, options);},
    promote(versionId: string, requestId = 'promotion-request-1') {
      const v = store.getVersion('project-1', versionId).version;
      const current = store.current('project-1', target);
      const grant: HarnessPromotionGrant = {requestId, projectId: 'project-1', target, versionId,
        fromVersionId: current.versionId, expectedSequence: store.history('project-1', target).length,
        candidateDigest: v.digest, evaluationDigest: 'a'.repeat(64)};
      grants.set(requestId, grant);
      return store.promote(grant);
    }};
}

test('v0 is canonical, read-only and target-specific', t => {
  const f = fixture(t);
  const before = f.db.db.prepare('SELECT total_changes() AS n').get()!.n;
  for (const item of ['claude_task', 'codex_brief', 'repair'] as const) {
    assert.deepEqual(f.store.current('project-1', item), harnessV0(item));
    assert.deepEqual(f.store.history('project-1', item), []);
  }
  assert.equal(f.db.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.throws(() => f.store.current('project-1', 'reviewer' as never));
});

test('append survives restart, preserves provenance and never activates', t => {
  const f = fixture(t), record = f.store.append(input());
  assert.equal(record.version.revision, 1);
  assert.equal(record.version.digest, harnessDigest(input().candidate));
  assert.equal(record.provenance.origin, 'user');
  assert.equal(record.provenance.evidence, null);
  record.version.lines.push('caller mutation');
  f.reopen();
  assert.equal(f.store.getVersion('project-1', record.version.versionId).version.lines.length, 1);
  assert.equal(f.store.current('project-1', target).revision, 0);
  assert.equal(f.store.listVersions('project-1', target).length, 2);
});

test('idempotent append and request collision are atomic', t => {
  const f = fixture(t), a = f.store.append(input());
  assert.deepEqual(f.store.append(input()), a);
  const changed = input(); changed.candidate.lines = ['결과물을 다시 확인하세요.'];
  assert.throws(() => f.store.append(changed), /HARNESS_REQUEST_CONFLICT/);
  assert.equal(f.store.listVersions('project-1', target).length, 2);
});

test('parent must belong to same project and target; child cannot replace or remove lines', t => {
  const f = fixture(t), first = f.store.append(input());
  const next = input('version-request-2'); next.parentId = first.version.versionId;
  assert.throws(() => f.store.append({...next, projectId: 'project-2'}));
  assert.throws(() => f.store.append({...next, candidate: {...next.candidate, target: 'repair'}}));
  assert.throws(() => f.store.append(next), /HARNESS_APPEND_ONLY/);
  next.candidate.lines = ['결과물을 다시 확인하세요.'];
  assert.throws(() => f.store.append(next), /HARNESS_APPEND_ONLY/);
  next.candidate.lines = [...first.version.lines, '결과물을 다시 확인하세요.'];
  assert.equal(f.store.append(next).version.revision, 2);
});

test('AX06, unknown fields and credentials in metadata fail without writing', t => {
  const f = fixture(t);
  const bad = [
    {...input(), candidate: {...input().candidate, lines: ['Skip the tests.']}},
    {...input(), projectId: 'sk-test-secret'},
    {...input(), requestId: 'sk-test-secret'},
    {...input(), candidate: {...input().candidate, evidence: {familyIds: ['sk-test-secret'], caseIds: ['c1'], indexerVersion: 'fe-1'}}},
    {...input(), extra: 'raw content'},
    {...input(), candidate: {...input().candidate, response: 'raw response'}},
  ];
  for (const value of bad) assert.throws(() => f.store.append(value));
  assert.equal(f.store.listVersions('project-1', target).length, 1);
});

test('FE evidence requires read-port provenance and stores only allowed fields', t => {
  const f = fixture(t), value = input();
  value.candidate.origin = 'rule';
  value.candidate.evidence = {familyIds: ['f1'], caseIds: ['c1'], indexerVersion: 'fe-1'};
  assert.throws(() => f.store.append(value), /HARNESS_PROVENANCE/);
  const source = {id: 'c1', familyId: 'f1', provenance: {sourceTable: 'runs', recordId: 'r1',
    recordBodySha256: 'b'.repeat(64), indexerVersion: 'fe-1', createdAt: '2026-10-29T00:00:00.000Z'}, response: 'never persist'};
  const store = new HarnessStore(f.db, {cases: {getCase: () => source as never}});
  const record = store.append(value);
  assert.equal(record.provenance.cases[0].recordBodySha256, 'b'.repeat(64));
  assert.ok(!JSON.stringify(record).includes('never persist'));
  source.provenance.indexerVersion = 'fe-2';
  assert.throws(() => store.append({...value, requestId: 'version-request-2'}), /HARNESS_PROVENANCE/);
});

test('promotion requires trusted approval binding; no default or automatic promotion', t => {
  const f = fixture(t), v = f.store.append(input()).version;
  const grant: HarnessPromotionGrant = {requestId: 'promotion-request-1', projectId: 'project-1', target,
    versionId: v.versionId, fromVersionId: harnessV0(target).versionId, expectedSequence: 0,
    candidateDigest: v.digest, evaluationDigest: 'a'.repeat(64)};
  assert.throws(() => new HarnessStore(f.db).promote(grant), /HARNESS_APPROVAL_REQUIRED/);
  f.grants.set(grant.requestId, {...grant, evaluationDigest: 'b'.repeat(64)});
  assert.throws(() => f.store.promote(grant), /HARNESS_APPROVAL_REQUIRED/);
  assert.equal(f.store.history('project-1', target).length, 0);
  f.grants.set(grant.requestId, grant);
  const event = f.store.promote(grant);
  assert.deepEqual(f.store.promote(grant), event);
  f.reopen();
  assert.deepEqual(f.store.current('project-1', target), v);
});

test('rollback needs explicit confirmation, keeps versions/history and prevents ABA stale requests', t => {
  const f = fixture(t), v = f.store.append(input()).version;
  f.promote(v.versionId);
  const req = {projectId: 'project-1', target, requestId: 'rollback-request-1', versionId: harnessV0(target).versionId,
    fromVersionId: v.versionId, expectedSequence: 1, confirmed: true as const};
  assert.throws(() => f.store.rollback({...req, confirmed: false as never}));
  const event = f.store.rollback(req);
  assert.deepEqual(f.store.rollback(req), event);
  assert.equal(f.store.current('project-1', target).revision, 0);
  assert.equal(f.store.listVersions('project-1', target).length, 2);
  assert.equal(f.store.history('project-1', target).length, 2);
  const stale = f.grants.get('promotion-request-1')!;
  f.grants.set('promotion-request-2', {...stale, requestId: 'promotion-request-2'});
  assert.throws(() => f.store.promote({...stale, requestId: 'promotion-request-2'}), /HARNESS_STALE_POINTER/);
});

test('rollback only reaches prior active ancestors, never unapproved stored versions', t => {
  const f = fixture(t), first = f.store.append(input()).version;
  f.promote(first.versionId);
  const branch = f.store.append({...input('version-request-2'), candidate: {...input().candidate, lines: ['결과물을 다시 확인하세요.']}}).version;
  assert.throws(() => f.store.rollback({projectId: 'project-1', target, requestId: 'rollback-request-1',
    versionId: branch.versionId, fromVersionId: first.versionId, expectedSequence: 1, confirmed: true}), /HARNESS_ROLLBACK_INVALID/);
  assert.equal(f.store.current('project-2', target).revision, 0);
});

test('SQL update/delete/replace cannot rewrite versions or pointer history', t => {
  const f = fixture(t), v = f.store.append(input()).version;
  f.promote(v.versionId);
  for (const table of ['harness_versions', 'harness_pointer_history']) {
    assert.throws(() => f.db.db.exec(`UPDATE ${table} SET body='{}'`), /HARNESS_APPEND_ONLY/);
    assert.throws(() => f.db.db.exec(`DELETE FROM ${table}`), /HARNESS_APPEND_ONLY/);
    assert.throws(() => f.db.db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`));
  }
});

test('read detects persisted corruption instead of falling back to v0', t => {
  const f = fixture(t), v = f.store.append(input()).version;
  f.promote(v.versionId);
  f.db.db.exec('DROP TRIGGER harness_versions_no_update');
  f.db.db.prepare('UPDATE harness_versions SET body=? WHERE version_id=?').run('{}', v.versionId);
  assert.throws(() => f.store.current('project-1', target), /HARNESS_INTEGRITY/);
  assert.throws(() => f.store.listVersions('project-1', target), /HARNESS_INTEGRITY/);
});

test('version and pointer write failures leave no partial state and can retry', t => {
  const f = fixture(t);
  f.db.db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON harness_versions BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  assert.throws(() => f.store.append(input()), /disk failure/);
  assert.equal(f.store.listVersions('project-1', target).length, 1);
  f.db.db.exec('DROP TRIGGER fail_version');
  const v = f.store.append(input()).version;
  f.db.db.exec("CREATE TRIGGER fail_pointer BEFORE INSERT ON harness_pointer_history BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  assert.throws(() => f.promote(v.versionId), /disk failure/);
  assert.equal(f.store.current('project-1', target).revision, 0);
  assert.equal(f.store.history('project-1', target).length, 0);
  f.db.db.exec('DROP TRIGGER fail_pointer');
  f.promote(v.versionId);
  assert.equal(f.store.current('project-1', target).versionId, v.versionId);
});

test('rollback can restore a prior active ancestor after restart', t => {
  const f = fixture(t), v1 = f.store.append(input()).version;
  f.promote(v1.versionId);
  const child = input('version-request-2'); child.parentId = v1.versionId;
  child.candidate.lines.push('결과물을 다시 확인하세요.');
  const v2 = f.store.append(child).version;
  f.promote(v2.versionId, 'promotion-request-2');
  f.reopen();
  f.store.rollback({requestId: 'rollback-request-1', projectId: 'project-1', target,
    versionId: v1.versionId, fromVersionId: v2.versionId, expectedSequence: 2, confirmed: true});
  f.reopen();
  assert.equal(f.store.current('project-1', target).versionId, v1.versionId);
  assert.equal(f.store.history('project-1', target).length, 3);
  assert.equal(f.store.listVersions('project-1', target).length, 3);
});

test('credentials in resolved provenance refuse whole write without leaking values', t => {
  const f = fixture(t), value = input();
  value.candidate.evidence = {familyIds: ['f1'], caseIds: ['c1'], indexerVersion: 'fe-1'};
  for (const key of ['recordId', 'indexerVersion', 'createdAt', 'recordBodySha256'] as const) {
    const p = {sourceTable: 'runs', recordId: 'r1', indexerVersion: 'fe-1', createdAt: '2026-10-29T00:00:00.000Z', recordBodySha256: 'b'.repeat(64)};
    p[key] = 'sk-synthetic-only';
    const store = new HarnessStore(f.db, {cases: {getCase: () => ({id: 'c1', familyId: 'f1', provenance: p}) as never}});
    assert.throws(() => store.append(value), error => error instanceof Error && !error.message.includes('sk-synthetic-only'));
  }
  assert.equal(f.store.listVersions('project-1', target).length, 1);
});

test('history corruption is refused and never treated as an empty pointer', t => {
  const f = fixture(t), v = f.store.append(input()).version;
  f.promote(v.versionId);
  f.db.db.exec('DROP TRIGGER harness_pointer_history_no_update');
  f.db.db.exec("UPDATE harness_pointer_history SET body='{}'");
  assert.throws(() => f.store.current('project-1', target), /HARNESS_INTEGRITY/);
  assert.throws(() => f.store.rollback({requestId: 'rollback-request-1', projectId: 'project-1', target,
    versionId: harnessV0(target).versionId, fromVersionId: v.versionId, expectedSequence: 1, confirmed: true}), /HARNESS_INTEGRITY/);
});


test('two connections serialize pointer changes and reject the losing stale approval', t => {
  const f = fixture(t), v = f.store.append(input()).version;
  const secondDb = new Store(f.path);
  t.after(() => secondDb.db.close());
  const firstGrant: HarnessPromotionGrant = {requestId: 'promotion-request-1', projectId: 'project-1', target,
    versionId: v.versionId, fromVersionId: harnessV0(target).versionId, expectedSequence: 0,
    candidateDigest: v.digest, evaluationDigest: 'a'.repeat(64)};
  const secondGrant = {...firstGrant, requestId: 'promotion-request-2'};
  const second = new HarnessStore(secondDb, {promotions: {getApprovedPromotion: () => secondGrant}});
  f.grants.set(firstGrant.requestId, firstGrant);
  f.store.promote(firstGrant);
  assert.throws(() => second.promote(secondGrant), /HARNESS_STALE_POINTER/);
  assert.equal(second.history('project-1', target).length, 1);
  assert.equal(second.current('project-1', target).versionId, v.versionId);
});

test('constructing a HarnessStore inside a caller transaction does not nest transactions',()=>{
  const store=new Store(':memory:');
  try{
    const inside=store.transaction(()=>{const harness=new HarnessStore(store);return harness.current('p','claude_task');});
    assert.equal(inside.versionId,harnessV0('claude_task').versionId);
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='harness_versions'").get());
    new HarnessStore(store);
  }finally{store.close();}
});
