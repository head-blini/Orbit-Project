import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {HarnessStore, type HarnessStorePorts} from '../server/harness-store.ts';
import {harnessV0} from '../server/harness-policy.ts';
import {HarnessEvaluation, type HarnessEvaluationRunner, type HarnessRunInput, type HarnessRunOutput} from '../server/harness-evaluation.ts';
import {HarnessEffects} from '../server/harness-effects.ts';
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


type Obs = {at: string; src: 'native' | 'mock' | 'unknown'};
function fixture(t: test.TestContext, mode: HarnessEvaluationRunner['mode'] = 'live') {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-he6-'));
  const db = new Store(join(dir, 'store.sqlite'));
  t.after(() => {db.db.close(); rmSync(dir, {recursive: true, force: true});});
  const cases = {getCase: (caseId: string) => failureCase(caseId)};
  const ports: HarnessStorePorts = {cases};
  const harness = new HarnessStore(db, ports);
  const runner: HarnessEvaluationRunner = {mode, runCase: async (i: HarnessRunInput) => output(i.kind !== 'failing' || i.arm === 'B')};
  const evaluation = new HarnessEvaluation(db, {harness, cases, runner,
    suite: {normalCases: () => [{caseId: 'n1', digest: 'c'.repeat(64)}], protectedCases: () => [{caseId: 'p1', digest: 'd'.repeat(64)}]}});
  ports.promotions = evaluation;
  const candidate = harness.append({projectId: P, requestId: 'append-1', parentId: harnessV0(target).versionId, candidate: {class: 'execution_guidance', target,
    lines: ['입력 자료를 다시 확인하세요.'], origin: 'user', evidence: {familyIds: [FAMILY], caseIds: ['case-1'], indexerVersion: 'fe-1'}}}).version;
  const obs: {list: Obs[] | 'throw'} = {list: []};
  const failures = {
    list: () => {if (obs.list === 'throw') throw new Error('boom'); return obs.list.map((o, i) => ({id: 'f' + i, source: 'run' as const, recordId: String(i), projectId: P, code: 'X',
      category: 'output_rejected' as const, evidenceSource: o.src, at: o.at, bindingDigest: 'b'}));},
    families: () => obs.list === 'throw' ? [] : [{familyId: FAMILY, evidenceIds: obs.list.map((_, i) => 'f' + i)}],
  } as unknown as ConstructorParameters<typeof HarnessEffects>[1]['failures'];
  const effects = new HarnessEffects(db, {harness, evaluation, failures});
  const promote = async () => {
    const r = await evaluation.evaluate({requestId: 'eval-1', projectId: P, candidateVersionId: candidate.versionId, liveApproval: {confirmed: true}});
    const grant = evaluation.approvePromotion({requestId: 'promo-1', projectId: P, evaluationId: r.evaluationId, candidateDigest: r.candidateDigest,
      evaluationDigest: r.evaluationDigest, confirmed: true}, 0);
    harness.promote(grant);
    return r;
  };
  return {db, harness, evaluation, candidate, obs, effects, promote};
}
const PAST = '2026-01-01T00:00:00.000Z', FUTURE = '2099-01-01T00:00:00.000Z';
const claude = (v: ReturnType<HarnessEffects['view']>) => v.targets.find(x => x.target === target)!;
const win = (v: ReturnType<HarnessEffects['view']>) => claude(v).versions.at(-1)!.windows[0];

test('empty project: v0 active everywhere, no data shown as unknown, zero writes', t => {
  const f = fixture(t);
  const before = f.db.db.prepare('SELECT total_changes() AS n').get()!.n;
  const v = f.effects.view(P);
  assert.equal(v.targets.length, 3);
  assert.ok(v.targets.every(x => x.state === 'ok' && x.activeRevision === 0 && x.pointerSequence === 0 && x.history.length === 0));
  const c = claude(v);
  assert.equal(c.versions.length, 2);
  assert.deepEqual(c.versions[1].windows, []); // never promoted: no effect window, not a zero
  assert.deepEqual(c.versions[1].evaluations, []);
  assert.equal(f.db.db.prepare('SELECT total_changes() AS n').get()!.n, before);
});

test('fake evaluation is shown but never verified; pointer stays at v0', async t => {
  const f = fixture(t, 'fake');
  await f.evaluation.evaluate({requestId: 'eval-1', projectId: P, candidateVersionId: f.candidate.versionId, liveApproval: null});
  const c = claude(f.effects.view(P));
  assert.equal(c.activeRevision, 0);
  const e = c.versions[1].evaluations[0];
  assert.equal(e.verdict, 'unverified');
  assert.equal(e.verified, false);
  assert.deepEqual(c.versions[1].approvals, []);
});

test('promoted version: before/after real recurrence, honest statuses', async t => {
  const f = fixture(t);
  f.obs.list = [{at: PAST, src: 'native'}, {at: PAST, src: 'native'}];
  await f.promote();
  let v = f.effects.view(P), c = claude(v), ver = c.versions[1];
  assert.equal(c.activeVersionId, f.candidate.versionId);
  assert.equal(c.history[0].kind, 'promotion');
  assert.equal(ver.evaluations[0].verified, true);
  assert.equal(ver.approvals.length, 1);
  assert.deepEqual(win(v).families[0].before, {real: 2, mock: 0, unknown: 0, undated: 0});
  assert.equal(win(v).status, 'no_recurrence_observed');
  assert.equal(win(v).rollbackProposed, false);

  f.obs.list = [{at: PAST, src: 'native'}, {at: FUTURE, src: 'native'}];
  v = f.effects.view(P);
  assert.equal(win(v).status, 'recurrence_observed');
  assert.equal(win(v).rollbackProposed, true);

  f.obs.list = [{at: PAST, src: 'native'}, {at: FUTURE, src: 'mock'}];
  assert.equal(win(f.effects.view(P)).status, 'unverified');
  f.obs.list = [{at: PAST, src: 'native'}, {at: '', src: 'native'}];
  assert.equal(win(f.effects.view(P)).status, 'unverified');
  f.obs.list = [{at: PAST, src: 'mock'}, {at: PAST, src: 'unknown'}];
  const w = win(f.effects.view(P));
  assert.equal(w.status, 'insufficient_baseline'); // mock/unknown never count as a real baseline
  assert.deepEqual(w.families[0].before, {real: 0, mock: 1, unknown: 1, undated: 0});
  assert.ok(!['no_recurrence_observed'].includes(w.status));
});

test('failure index unavailable: counts are null (unknown), not zero', async t => {
  const f = fixture(t);
  await f.promote();
  f.obs.list = 'throw';
  const w = win(f.effects.view(P));
  assert.equal(w.status, 'unknown');
  assert.deepEqual(w.families, [{familyId: FAMILY, before: null, after: null}]);
});

test('rollback ends the window; corrupted evaluation is reported invalid', async t => {
  const f = fixture(t);
  f.obs.list = [{at: PAST, src: 'native'}, {at: FUTURE, src: 'native'}];
  await f.promote();
  f.harness.rollback({requestId: 'rb-1', projectId: P, target, versionId: harnessV0(target).versionId, fromVersionId: f.candidate.versionId, expectedSequence: 1, confirmed: true});
  const c = claude(f.effects.view(P));
  assert.equal(c.activeRevision, 0);
  assert.equal(c.history.length, 2);
  const w = c.versions[1].windows[0];
  assert.notEqual(w.endedAt, null);
  assert.equal(w.rollbackProposed, false); // only an active version gets a proposal
  f.db.db.exec('DROP TRIGGER harness_evaluations_no_update');
  f.db.db.prepare('UPDATE harness_evaluations SET body=body||?').run(' ');
  const e = claude(f.effects.view(P)).versions[1].evaluations[0];
  assert.equal(e.state, 'invalid');
  assert.equal(e.verified, false);
});
