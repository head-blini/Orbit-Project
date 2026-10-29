import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {HarnessStore, type HarnessStorePorts} from '../server/harness-store.ts';
import {harnessV0} from '../server/harness-policy.ts';
import {HarnessEvaluation, type HarnessEvaluationRunner, type HarnessRunInput, type HarnessRunOutput, type HarnessSuiteCase} from '../server/harness-evaluation.ts';
import {completionPolicyDigest} from '../server/task-completion.ts';
import {CODE_GATES} from '../shared/task-completion.ts';
import type {CompletionBinding, CompletionEvidence, CompletionPolicy} from '../shared/task-completion.ts';
import type {QualityDimension} from '../shared/quality-progress.ts';
import type {FailureCase} from '../server/failure-cases.ts';

const P = 'project-1', target = 'claude_task' as const, FAMILY = 'f'.repeat(64);
const dim = (status: QualityDimension['status'] = 'not_run'): QualityDimension => ({status, evidenceIds: [], blockers: [], nextAction: null});
const failureCase = (caseId: string): FailureCase => ({id: caseId, requestId: 'case-request-' + caseId, familyId: FAMILY, failureId: 'failure-1',
  expected: 'same_failure', inputDigests: {}, conditions: {}, provenance: {sourceTable: 'runs', recordId: 'run-1',
    recordBodySha256: 'b'.repeat(64), indexerVersion: 'fe-1', createdAt: '2026-10-29T00:00:00.000Z'}});

/** Test double of a live Claude run: CQG code evidence, passing unless `fail` says otherwise. Not a real live run. */
function output(pass: boolean, opts: {source?: 'native' | 'mock' | 'unknown'; runtime?: string; extraCommand?: boolean} = {}): HarnessRunOutput {
  const policy: CompletionPolicy = {projectKind: 'code', requiredGates: [...CODE_GATES], gateCommandMap: Object.fromEntries(CODE_GATES.map(g => [g, [g]])),
    notApplicable: [], requireIndependentReview: false, dependencyRelease: 'quality_passed'};
  const binding: CompletionBinding = {projectId: 'project', taskId: 'task', runId: 'run-producer', planningVersionId: 'plan', planningContentHash: 'baseline',
    acceptanceDigest: 'acceptance', artifactId: 'artifact', artifactDigest: 'artifact-hash', graphRevision: 'revision', contractDigest: 'contract',
    policyDigest: completionPolicyDigest(policy), configDigest: 'config', baseSha: 'base', inputSnapshotDigest: null, artifactScope: 'workspace'};
  const evidence: CompletionEvidence = {quality: {execution: {...dim('completed'), evidenceSource: 'native'}, format: dim(), codeVerification: dim(), semantic: dim(),
    independentReview: dim(), repair: dim(), revalidation: dim(), userApproval: dim(), evidence: []},
  producer: {binding: {...binding}, model: {providerId: 'provider', modelId: 'producer', sessionId: 's', runId: 'run-producer', source: 'native_observed', evidenceSource: opts.source ?? 'native'}},
  bindings: {}, checks: [], commands: [], loops: [], gateResults: [], approvals: []};
  for (const gate of [...CODE_GATES, ...(opts.extraCommand ? ['extra'] : [])]) {
    const verdict = pass || gate !== 'unit' ? 'passed' : 'failed';
    evidence.quality.evidence.push({id: gate, kind: 'verification_check', evidenceSource: 'local', freshness: 'current', recordedStatus: verdict, binding: {...binding}, blockers: []});
    evidence.bindings[gate] = {...binding};
    evidence.commands.push({id: gate, configDigest: 'command-config'});
    evidence.checks.push({id: gate, requestId: gate, runId: 'run-producer', projectId: 'project', workspaceId: 'artifact', taskId: 'task', planningVersionId: 'plan',
      planningContentHash: 'baseline', acceptanceDigest: 'acceptance', commandId: gate, configDigest: 'command-config', baseSha: 'base', sourceDigest: 'artifact-hash',
      finishedDigest: 'artifact-hash', createdAt: '2026-10-29T00:00:00Z', completedAt: '2026-10-29T00:01:00Z', execution: 'completed', verdict,
      exitCode: verdict === 'passed' ? 0 : 1, durationMs: 1, output: '', recoveredAt: null, evidenceSource: 'local'});
  }
  return {runtime: opts.runtime ?? 'claude-code', evidence, policy, binding};
}

type Plan = (input: HarnessRunInput) => HarnessRunOutput;
/** Default: baseline fails the failing case, candidate fixes it; normal/protected pass on both arms. */
const improves: Plan = i => output(i.kind !== 'failing' || i.arm === 'B');

function fixture(t: test.TestContext, plan: Plan = improves, mode: HarnessEvaluationRunner['mode'] = 'live') {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-he4-'));
  const db = new Store(join(dir, 'store.sqlite'));
  t.after(() => {db.db.close(); rmSync(dir, {recursive: true, force: true});});
  const cases = {getCase: (caseId: string) => failureCase(caseId)};
  const storePorts: HarnessStorePorts = {cases};
  const harness = new HarnessStore(db, storePorts);
  const suite = {normal: [{caseId: 'normal-1', digest: 'c'.repeat(64)}] as HarnessSuiteCase[], protected: [{caseId: 'protected-1', digest: 'd'.repeat(64)}] as HarnessSuiteCase[]};
  const calls: HarnessRunInput[] = [];
  const runner: HarnessEvaluationRunner = {mode, runCase: async input => {calls.push(input); return plan(input);}};
  const evaluation = new HarnessEvaluation(db, {harness, cases, runner,
    suite: {normalCases: () => structuredClone(suite.normal), protectedCases: () => structuredClone(suite.protected)}});
  storePorts.promotions = evaluation; // wired after construction: HarnessStore keeps the ports object
  const candidate = harness.append({projectId: P, requestId: 'append-1', parentId: harnessV0(target).versionId, candidate: {class: 'execution_guidance', target,
    lines: ['입력 자료를 다시 확인하세요.'], origin: 'user', evidence: {familyIds: [FAMILY], caseIds: ['case-1'], indexerVersion: 'fe-1'}}}).version;
  const evaluate = (requestId = 'eval-1', liveApproval: {confirmed: true} | null = {confirmed: true}) =>
    evaluation.evaluate({requestId, projectId: P, candidateVersionId: candidate.versionId, liveApproval});
  const approve = async (requestId = 'promo-1') => {
    const record = await evaluate();
    return evaluation.approvePromotion({requestId, projectId: P, evaluationId: record.evaluationId, candidateDigest: record.candidateDigest,
      evaluationDigest: record.evaluationDigest, confirmed: true}, harness.history(P, target).length);
  };
  return {db, harness, evaluation, candidate, suite, calls, evaluate, approve};
}
const changes = (db: Store) => db.db.prepare('SELECT total_changes() AS n').get()!.n;

test('improvement with zero regressions passes, runs A/B per case and never moves the pointer', async t => {
  const f = fixture(t);
  const record = await f.evaluate();
  assert.equal(record.verdict, 'passed');
  assert.deepEqual(record.reasons, []);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.calls.filter(c => c.arm === 'A').map(c => c.overlay), ['', '', '']);
  assert.ok(f.calls.filter(c => c.arm === 'B').every(c => c.overlay.startsWith('추가 실행 지침(Orbit 하네스 v1):')));
  assert.equal(record.candidateDigest, f.candidate.digest);
  assert.equal(record.parentVersionId, harnessV0(target).versionId);
  assert.deepEqual(f.harness.current(P, target), harnessV0(target));
  assert.deepEqual(f.harness.history(P, target), []);
});

test('promotion requires explicit approval bound to the evaluated digests; approval itself does not promote', async t => {
  const f = fixture(t);
  const record = await f.evaluate();
  const grant0 = {requestId: 'promo-1', projectId: P, target, versionId: f.candidate.versionId, fromVersionId: harnessV0(target).versionId,
    expectedSequence: 0, candidateDigest: f.candidate.digest, evaluationDigest: record.evaluationDigest};
  assert.throws(() => f.harness.promote(grant0), /HARNESS_APPROVAL_REQUIRED/);
  const base = {requestId: 'promo-1', projectId: P, evaluationId: record.evaluationId, candidateDigest: record.candidateDigest, evaluationDigest: record.evaluationDigest};
  assert.throws(() => f.evaluation.approvePromotion({...base, confirmed: false as unknown as true}, 0), /HARNESS_APPROVAL_REQUIRED/);
  assert.throws(() => f.evaluation.approvePromotion({...base, candidateDigest: 'e'.repeat(64), confirmed: true}, 0), /HARNESS_APPROVAL_MISMATCH/);
  assert.throws(() => f.evaluation.approvePromotion({...base, evaluationDigest: 'e'.repeat(64), confirmed: true}, 0), /HARNESS_APPROVAL_MISMATCH/);
  const grant = f.evaluation.approvePromotion({...base, confirmed: true}, 0);
  assert.deepEqual(grant, grant0);
  assert.deepEqual(f.harness.history(P, target), []);
  assert.deepEqual(f.evaluation.approvePromotion({...base, confirmed: true}, 0), grant); // idempotent replay
  assert.throws(() => f.evaluation.approvePromotion({...base, confirmed: true}, 1), /HARNESS_REQUEST_CONFLICT/);
  assert.throws(() => f.harness.promote({...grant, evaluationDigest: 'e'.repeat(64)}), /HARNESS_APPROVAL_REQUIRED/);
  f.harness.promote(grant);
  assert.equal(f.harness.current(P, target).versionId, f.candidate.versionId);
  // Pointer moved: the same approval is now stale for any further use.
  assert.equal(f.evaluation.getApprovedPromotion('promo-1'), null);
});

test('fake runner, mock/unknown producer, foreign runtime and runner errors are unverified and never approvable', async t => {
  const plans: Array<[string, Plan, HarnessEvaluationRunner['mode']]> = [
    ['fake', improves, 'fake'],
    ['mock', i => i.arm === 'B' ? output(true, {source: 'mock'}) : improves(i), 'live'],
    ['unknown baseline', i => i.arm === 'A' ? output(i.kind !== 'failing', {source: 'unknown'}) : improves(i), 'live'],
    ['codex runtime', i => ({...improves(i), runtime: 'codex'}), 'live'],
    ['runner error', i => {if (i.kind === 'protected') throw new Error('boom /Users/secret'); return improves(i);}, 'live'],
    ['new check only on B', i => i.arm === 'B' ? output(true, {extraCommand: true}) : improves(i), 'live'],
  ];
  for (const [name, plan, mode] of plans) {
    const f = fixture(t, plan, mode);
    const record = await f.evaluate();
    assert.equal(record.verdict, 'unverified', name);
    assert.ok(!JSON.stringify(record).includes('secret'), name);
    assert.throws(() => f.evaluation.approvePromotion({requestId: 'promo-1', projectId: P, evaluationId: record.evaluationId,
      candidateDigest: record.candidateDigest, evaluationDigest: record.evaluationDigest, confirmed: true}, 0), /HARNESS_EVAL_NOT_PASSED/, name);
  }
});

test('regression on a normal or protected case blocks; no gain is not_improved', async t => {
  for (const kind of ['normal', 'protected'] as const) {
    const f = fixture(t, i => i.kind === kind ? output(i.arm === 'A') : improves(i));
    const record = await f.evaluate();
    assert.equal(record.verdict, 'regressed');
    assert.ok(record.reasons.includes('HARNESS_EVAL_REGRESSION'));
  }
  const f = fixture(t, i => output(i.kind !== 'failing'));
  assert.equal((await f.evaluate()).verdict, 'not_improved');
});

test('live runner requires per-evaluation live approval; preconditions fail closed without running', async t => {
  const f = fixture(t);
  await assert.rejects(f.evaluate('eval-x', null), /HARNESS_EVAL_LIVE_APPROVAL_REQUIRED/);
  f.suite.protected = [];
  await assert.rejects(f.evaluate('eval-y'), /HARNESS_EVAL_SUITE_INCOMPLETE/);
  f.suite.protected = [{caseId: 'protected-1', digest: 'zz'}];
  await assert.rejects(f.evaluate('eval-z'), /HARNESS_EVAL_SUITE_INVALID/);
  await assert.rejects(f.evaluation.evaluate({requestId: 'eval-w', projectId: P, candidateVersionId: harnessV0(target).versionId, liveApproval: {confirmed: true}}), /HARNESS_EVAL_INVALID/);
  assert.equal(f.calls.length, 0);
});

test('codex_brief and user candidates without failing cases are not evaluated', async t => {
  const f = fixture(t);
  const codex = f.harness.append({projectId: P, requestId: 'append-codex', parentId: harnessV0('codex_brief').versionId, candidate: {class: 'execution_guidance',
    target: 'codex_brief', lines: ['입력 자료를 다시 확인하세요.'], origin: 'user', evidence: {familyIds: [FAMILY], caseIds: ['case-1'], indexerVersion: 'fe-1'}}}).version;
  await assert.rejects(f.evaluation.evaluate({requestId: 'eval-c', projectId: P, candidateVersionId: codex.versionId, liveApproval: {confirmed: true}}), /HARNESS_EVAL_RUNTIME_UNSUPPORTED/);
  const bare = f.harness.append({projectId: P, requestId: 'append-bare', parentId: harnessV0('repair').versionId, candidate: {class: 'execution_guidance',
    target: 'repair', lines: ['입력 자료를 다시 확인하세요.'], origin: 'user', evidence: null}}).version;
  await assert.rejects(f.evaluation.evaluate({requestId: 'eval-b', projectId: P, candidateVersionId: bare.versionId, liveApproval: {confirmed: true}}), /HARNESS_EVAL_SUITE_INCOMPLETE/);
  assert.equal(f.calls.length, 0);
});

test('requestIds are idempotent: replay returns the stored record without rerunning; changed input conflicts', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.evaluate(), f.evaluate()]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(await f.evaluate(), a);
  assert.equal(f.calls.length, 6);
  await assert.rejects(f.evaluate('eval-1', null), /HARNESS_REQUEST_CONFLICT/);
});

test('approval goes stale when the suite, the parent pointer or the stored evaluation changes', async t => {
  {
    const f = fixture(t);
    await f.approve();
    assert.ok(f.evaluation.getApprovedPromotion('promo-1'));
    f.suite.normal.push({caseId: 'normal-2', digest: 'e'.repeat(64)});
    assert.equal(f.evaluation.getApprovedPromotion('promo-1'), null);
    assert.throws(() => f.harness.promote(f.evaluation['storedGrant']('promo-1')!), /HARNESS_APPROVAL_REQUIRED/);
  }
  {
    const f = fixture(t);
    const record = await f.evaluate();
    // A sibling candidate is promoted first: the evaluated parent is no longer current.
    const sibling = f.harness.append({projectId: P, requestId: 'append-2', parentId: harnessV0(target).versionId, candidate: {class: 'execution_guidance', target,
      lines: ['결과를 확인한 뒤 보고하세요.'], origin: 'user', evidence: {familyIds: [FAMILY], caseIds: ['case-1'], indexerVersion: 'fe-1'}}}).version;
    const other = await f.evaluation.evaluate({requestId: 'eval-2', projectId: P, candidateVersionId: sibling.versionId, liveApproval: {confirmed: true}});
    f.harness.promote(f.evaluation.approvePromotion({requestId: 'promo-2', projectId: P, evaluationId: other.evaluationId, candidateDigest: other.candidateDigest,
      evaluationDigest: other.evaluationDigest, confirmed: true}, 0));
    assert.throws(() => f.evaluation.approvePromotion({requestId: 'promo-1', projectId: P, evaluationId: record.evaluationId, candidateDigest: record.candidateDigest,
      evaluationDigest: record.evaluationDigest, confirmed: true}, 1), /HARNESS_EVAL_STALE/);
  }
  {
    const f = fixture(t);
    await f.approve();
    assert.throws(() => f.db.db.prepare("UPDATE harness_evaluations SET body=body||' '").run(), /HARNESS_APPEND_ONLY/);
    assert.throws(() => f.db.db.prepare('DELETE FROM harness_promotion_approvals').run(), /HARNESS_APPEND_ONLY/);
  }
});

test('getApprovedPromotion is read-only and returns null for unknown or malformed ids', async t => {
  const f = fixture(t);
  await f.approve();
  const before = changes(f.db);
  assert.ok(f.evaluation.getApprovedPromotion('promo-1'));
  assert.equal(f.evaluation.getApprovedPromotion('missing'), null);
  assert.equal(f.evaluation.getApprovedPromotion('bad id\n'), null);
  assert.equal(changes(f.db), before);
});

test('stored results keep allowlisted codes only', async t => {
  const f = fixture(t, i => {const o = improves(i); o.evidence.quality.evidence[0].blockers = ['sk-ant-api03-' + 'x'.repeat(40)]; return o;});
  const record = await f.evaluate();
  assert.ok(!JSON.stringify(record).includes('sk-ant'));
});
