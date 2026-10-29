import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {HarnessStore} from '../server/harness-store.ts';
import {classifyHarnessCandidate} from '../server/harness-policy.ts';
import {familyId} from '../server/failure-fingerprint.ts';
import {HARNESS_RULES, draftHarnessCandidates, generateHarnessCandidates} from '../server/harness-candidates.ts';
import type {IndexedFailureFamily} from '../server/failure-index.ts';
import type {FailureCase, FailureCaseReader} from '../server/failure-cases.ts';
import type {FailureOccurrence, FailureRecord} from '../shared/failure-intelligence.ts';

const project = 'project-1';
const digest = (c: string) => c.repeat(64);
const occ = (n: number, evidenceSource: FailureRecord['evidenceSource'] = 'native', over: Partial<FailureOccurrence> = {}): FailureOccurrence =>
  ({id: `quality:loop:${n}`, runId: `run-${n}`, requestId: `req-${n}`, qualityLoopId: `loop-${n}`, evidenceSource, ...over});
function family(code: string, runtime: string | null, occurrences: FailureOccurrence[], taskId = 'task-1'): IndexedFailureFamily {
  const tuple = ['output_rejected', code, 'quality', null, runtime] as const;
  return {familyId: familyId(...tuple), tuple, projectId: project, taskId, bindingDigest: digest('b'),
    realCount: occurrences.filter(o => o.evidenceSource !== 'mock' && o.evidenceSource !== 'unknown').length,
    mockCount: occurrences.filter(o => o.evidenceSource === 'mock').length,
    unknownCount: occurrences.filter(o => o.evidenceSource === 'unknown').length,
    evidenceIds: occurrences.map(o => o.id), occurrences};
}
const kase = (id: string, f: IndexedFailureFamily, failureId: string, indexerVersion = 'fe-index-1'): FailureCase => ({
  id, requestId: `case-request-${id}`, familyId: f.familyId, failureId, expected: 'same_failure', inputDigests: {}, conditions: {},
  provenance: {sourceTable: 'quality_loops', recordId: failureId.split(':').at(-1)!, recordBodySha256: digest('c'), indexerVersion,
    createdAt: '2026-10-29T00:00:00.000Z'}});
function reader(cases: FailureCase[]): FailureCaseReader {
  return {listCases: (id?: string) => cases.filter(c => id === undefined || c.familyId === id),
    getCase: (id: string) => cases.find(c => c.id === id) ?? (() => {throw new Error('FAILURE_CASE_NOT_FOUND');})()};
}
function fixture(t: test.TestContext, families: IndexedFailureFamily[], cases: FailureCase[]) {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-he3-'));
  const db = new Store(join(dir, 'store.sqlite'));
  t.after(() => {db.db.close(); rmSync(dir, {recursive: true, force: true});});
  const casePort = reader(cases);
  const harness = new HarnessStore(db, {cases: casePort});
  return {db, harness, ports: {failures: {families: (id: string) => families.filter(f => f.projectId === id)}, cases: casePort, harness}};
}
const changes = (db: Store) => db.db.prepare('SELECT total_changes() AS n').get()!.n;

test('every rule template passes AX06 on its own', () => {
  for (const rule of Object.values(HARNESS_RULES)) {
    const target = rule.target === 'repair' ? 'repair' : 'claude_task';
    assert.deepEqual(classifyHarnessCandidate({class: 'execution_guidance', target, lines: [rule.line], origin: 'rule',
      evidence: {familyIds: ['f'], caseIds: ['c'], indexerVersion: 'v'}}), {status: 'eligible'});
  }
});

test('stores a cited, unpromoted candidate and is idempotent', t => {
  const f = family('QUALITY_EVIDENCE_INVALID', 'claude-code', [occ(1), occ(2), occ(3, 'mock')]);
  const x = fixture(t, [f], [kase('case-2', f, occ(2).id), kase('case-1', f, occ(1).id)]);
  const before = changes(x.db);
  const draft = draftHarnessCandidates(project, x.ports);
  assert.equal(changes(x.db), before, 'drafting is read-only');
  assert.deepEqual(draft, draftHarnessCandidates(project, x.ports), 'deterministic');
  const first = generateHarnessCandidates(project, x.ports);
  assert.equal(first.stored.length, 1);
  const [record] = first.stored;
  assert.equal(record.version.target, 'claude_task');
  assert.deepEqual(record.version.lines, [HARNESS_RULES['output_rejected:quality:QUALITY_EVIDENCE_INVALID'].line]);
  assert.deepEqual(record.provenance.evidence, {familyIds: [f.familyId], caseIds: ['case-1', 'case-2'], indexerVersion: 'fe-index-1'});
  assert.equal(record.provenance.origin, 'rule');
  assert.equal(record.provenance.cases.length, 2);
  assert.equal(x.harness.current(project, 'claude_task').revision, 0, 'never activated');
  assert.deepEqual(x.harness.history(project, 'claude_task'), []);
  const again = generateHarnessCandidates(project, x.ports);
  assert.deepEqual(again.stored, first.stored);
  assert.equal(x.harness.listVersions(project, 'claude_task').length, 2);
});

test('mock, unknown and non-independent failures never produce candidates', t => {
  const mockOnly = family('QUALITY_EVIDENCE_INVALID', 'claude-code', [occ(1, 'mock'), occ(2, 'mock'), occ(3, 'unknown')]);
  const sameLoop = family('QUALITY_EVIDENCE_INVALID', 'codex', [occ(4), occ(5, 'native', {qualityLoopId: 'loop-4'})]);
  const sameRun = family('QUALITY_REPAIR_EVIDENCE_INVALID', 'codex', [occ(6), occ(7, 'native', {runId: 'run-6'})]);
  const x = fixture(t, [mockOnly, sameLoop, sameRun], [kase('case-1', mockOnly, occ(1).id), kase('case-4', sameLoop, occ(4).id), kase('case-6', sameRun, occ(6).id)]);
  const result = generateHarnessCandidates(project, x.ports);
  assert.deepEqual(result.stored, []);
  assert.deepEqual(result.skipped.map(s => s.reason), ['INSUFFICIENT_REAL_EVIDENCE', 'INSUFFICIENT_REAL_EVIDENCE', 'INSUFFICIENT_REAL_EVIDENCE']);
});

test('requires a case reproducing a real occurrence in this project', t => {
  const f = family('QUALITY_EVIDENCE_INVALID', 'claude-code', [occ(1), occ(2), occ(3, 'mock')]);
  const x = fixture(t, [f], [kase('case-mock', f, occ(3).id), kase('case-other', f, 'quality:loop:999')]);
  const result = generateHarnessCandidates(project, x.ports);
  assert.deepEqual(result.stored, []);
  assert.deepEqual(result.skipped, [{familyIds: [f.familyId], reason: 'CASE_REQUIRED'}]);
  assert.deepEqual(generateHarnessCandidates('project-2', x.ports), {stored: [], blocked: [], skipped: []});
});

test('unmapped rules/runtimes, mixed indexer versions and present lines are skipped', t => {
  const noRule = family('QUALITY_STEP_FAILED', 'claude-code', [occ(1), occ(2)]);
  const noRuntime = family('QUALITY_EVIDENCE_INVALID', 'unknown', [occ(3), occ(4)]);
  const repairA = family('QUALITY_REPAIR_EVIDENCE_INVALID', 'codex', [occ(5), occ(6)]);
  const repairB = family('QUALITY_REPAIR_EVIDENCE_INVALID', 'claude-code', [occ(7), occ(8)]);
  const x = fixture(t, [noRule, noRuntime, repairA, repairB],
    [kase('case-5', repairA, occ(5).id, 'fe-index-1'), kase('case-7', repairB, occ(7).id, 'fe-index-2')]);
  const result = generateHarnessCandidates(project, x.ports);
  assert.deepEqual(result.stored, []);
  assert.deepEqual(result.skipped.map(s => s.reason).sort(), ['INDEXER_VERSION_MIXED', 'NO_RULE', 'RUNTIME_UNMAPPED']);
  const mixed = result.skipped.find(s => s.reason === 'INDEXER_VERSION_MIXED')!;
  assert.deepEqual(mixed.familyIds, [repairA.familyId, repairB.familyId].sort());
});

test('families sharing a rule and target merge into one candidate across task scopes', t => {
  const a = family('QUALITY_REPAIR_EVIDENCE_INVALID', 'codex', [occ(1)], 'task-1');
  const b = family('QUALITY_REPAIR_EVIDENCE_INVALID', 'codex', [occ(2)], 'task-2');
  const c = family('QUALITY_REPAIR_EVIDENCE_INVALID', 'claude-code', [occ(3), occ(4)]);
  const x = fixture(t, [a, b, c], [kase('case-1', a, occ(1).id), kase('case-3', c, occ(3).id)]);
  const {stored} = generateHarnessCandidates(project, x.ports);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].version.target, 'repair');
  assert.deepEqual(stored[0].provenance.evidence?.familyIds, [a.familyId, c.familyId].sort());
  assert.deepEqual(stored[0].provenance.evidence?.caseIds, ['case-1', 'case-3']);
});

test('extends the current pointer, skips a line already present and reports AX06 blocks without storing', t => {
  const f = family('QUALITY_EVIDENCE_INVALID', 'codex', [occ(1), occ(2)]);
  const x = fixture(t, [f], [kase('case-1', f, occ(1).id)]);
  const current = {versionId: 'v-current', class: 'execution_guidance' as const, target: 'codex_brief' as const, revision: 5,
    lines: ['a', 'b', 'c', 'd', 'e'], parentId: 'p', digest: digest('d')};
  const full = {...x.ports, harness: {current: () => current, append: () => assert.fail('blocked draft must not be stored')}};
  const result = generateHarnessCandidates(project, full);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].parentId, 'v-current');
  assert.deepEqual(result.blocked[0].classification, {status: 'blocked', reasons: ['HARNESS_TOO_LARGE']});
  const present = {...x.ports, harness: {current: () => ({...current, lines: [HARNESS_RULES['output_rejected:quality:QUALITY_EVIDENCE_INVALID'].line]}),
    append: () => assert.fail('nothing to store')}};
  assert.deepEqual(generateHarnessCandidates(project, present).skipped.map(s => s.reason), ['ALREADY_PRESENT']);
});

test('credential-bearing evidence is refused by the store filters', t => {
  const f = family('QUALITY_EVIDENCE_INVALID', 'claude-code', [occ(1), occ(2)]);
  const x = fixture(t, [f], [kase('case-1', f, occ(1).id, 'sk-ant-api03-' + 'A'.repeat(40))]);
  assert.throws(() => generateHarnessCandidates(project, x.ports), /HARNESS_UNSAFE_TEXT|HARNESS_INVALID/);
  assert.equal(x.harness.listVersions(project, 'claude_task').length, 1);
});

test('no model, network, promotion or protected write imports', () => {
  const source = readFileSync(new URL('../server/harness-candidates.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['../shared/failure-intelligence.ts', '../shared/harness.ts', './failure-cases.ts', './failure-index.ts', './harness-policy.ts', './harness-store.ts', 'node:crypto']);
  assert.doesNotMatch(source, /\.promote\(|\.rollback\(/);
});
