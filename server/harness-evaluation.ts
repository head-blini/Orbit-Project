import {createHash, randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {classifyHarnessCandidate} from './harness-policy.ts';
import {evaluateTaskCompletion} from './task-completion.ts';
import type {FailureCaseReader} from './failure-cases.ts';
import type {HarnessPromotionGrant, HarnessStore} from './harness-store.ts';
import {HARNESS_ALLOWED, HARNESS_MAX_LINE_CHARS, HARNESS_MAX_LINES, HARNESS_MAX_OVERLAY_CHARS, HARNESS_REASON_ORDER, renderOverlay,
  type HarnessTarget, type HarnessVersion} from '../shared/harness.ts';
import type {CompletionBinding, CompletionEvidence, CompletionPolicy} from '../shared/task-completion.ts';

/** HE-4: protected A/B evaluation of a stored candidate (docs/ORBIT-HE-D1.md 2(d)) and the user-approval
 * port HarnessStore needs for promotion (2(e)). Never moves the pointer: only HarnessStore.promote does,
 * and only with a fresh approval recorded here. No model/provider call happens in this module. */

export type HarnessCaseKind = 'failing' | 'normal' | 'protected';
export interface HarnessSuiteCase {caseId: string; digest: string}
export interface HarnessRunInput {
  projectId: string; target: HarnessTarget; arm: 'A' | 'B'; version: HarnessVersion; overlay: string;
  kind: HarnessCaseKind; caseId: string; caseDigest: string;
}
/** Raw evidence only; the verdict is computed here with evaluateTaskCompletion, never taken from the runner. */
export interface HarnessRunOutput {runtime: string; evidence: CompletionEvidence; policy: CompletionPolicy; binding: CompletionBinding}
/** Server-owned. 'fake' results are always unverified. A 'live' runner must execute A and B in PW isolated
 * spaces with the existing Claude runtime; none is wired yet (live evaluation is blocked). */
export interface HarnessEvaluationRunner {mode: 'fake' | 'live'; runCase(input: HarnessRunInput): Promise<HarnessRunOutput>}
export interface HarnessEvaluationPorts {
  harness: Pick<HarnessStore, 'getVersion' | 'current'>;
  cases: Pick<FailureCaseReader, 'getCase'>;
  /** Server-owned normal (user-registered passing manifests) and protected suites; read-only. */
  suite: {normalCases(projectId: string, target: HarnessTarget): HarnessSuiteCase[]; protectedCases(projectId: string, target: HarnessTarget): HarnessSuiteCase[]};
  runner: HarnessEvaluationRunner;
}
export interface HarnessEvaluationRequest {
  requestId: string; projectId: string; candidateVersionId: string;
  /** Per-evaluation live-call approval (HE-D1 default 4). Required for a live runner. */
  liveApproval: {confirmed: true} | null;
}
export type HarnessEvaluationVerdict = 'passed' | 'not_improved' | 'regressed' | 'unverified';
export interface HarnessRunResult {kind: HarnessCaseKind; caseId: string; arm: 'A' | 'B'; passed: boolean; verified: boolean; policyDigest: string | null; reasons: string[]}
export interface HarnessEvaluationRecord {
  evaluationId: string; requestId: string; projectId: string; target: HarnessTarget;
  candidateVersionId: string; candidateDigest: string; parentVersionId: string; parentDigest: string;
  suite: Record<HarnessCaseKind, HarnessSuiteCase[]>; suiteDigest: string; policyDigest: string;
  runnerMode: HarnessEvaluationRunner['mode']; results: HarnessRunResult[];
  verdict: HarnessEvaluationVerdict; reasons: string[]; createdAt: string; evaluationDigest: string;
}
export interface HarnessPromotionApproval {
  requestId: string; projectId: string; evaluationId: string; candidateDigest: string; evaluationDigest: string; confirmed: true;
}

/** Bump when the evaluation or AX06 rules change: every prior evaluation and approval becomes stale. */
export const HARNESS_EVALUATION_POLICY_VERSION = 'orbit-harness-eval/1';
export const HARNESS_EVALUATION_POLICY_DIGEST = createHash('sha256').update(JSON.stringify([HARNESS_EVALUATION_POLICY_VERSION, HARNESS_ALLOWED,
  HARNESS_MAX_LINES, HARNESS_MAX_LINE_CHARS, HARNESS_MAX_OVERLAY_CHARS, HARNESS_REASON_ORDER])).digest('hex');
/** v1 evaluation runs on Claude only; Codex has no observed model, so it cannot pass CQG (HE-D1 default 4). */
const EVALUABLE: readonly HarnessTarget[] = ['claude_task', 'repair'];
const MAX_SUITE_CASES = 64;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(code: string, status = 409): never {throw new AppError(code, status);}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, keys: readonly string[]) => plain(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/u.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$(?![\s\S])/u.test(v);
/** Stored reason codes are allowlisted tokens; anything else (free text, paths, secrets) is replaced, never copied. */
const code = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$(?![\s\S])/u.test(v) && !containsCredential(v) ? v : 'HARNESS_EVAL_REASON_FILTERED';
const suiteDigest = (suite: HarnessEvaluationRecord['suite']) => sha(JSON.stringify(['orbit-harness-suite/1',
  (['failing', 'normal', 'protected'] as const).map(kind => [kind, suite[kind].map(c => [c.caseId, c.digest])])]));
const evaluationDigest = (record: Omit<HarnessEvaluationRecord, 'evaluationDigest'>) => sha(JSON.stringify(['orbit-harness-evaluation/1', record]));

function suiteCases(list: unknown): HarnessSuiteCase[] {
  if (!Array.isArray(list) || list.length > MAX_SUITE_CASES) fail('HARNESS_EVAL_SUITE_INVALID');
  const cases = list.map(c => exact(c, ['caseId', 'digest']) && id(c.caseId) && hex(c.digest) ? {caseId: c.caseId, digest: c.digest} : fail('HARNESS_EVAL_SUITE_INVALID'));
  if (new Set(cases.map(c => c.caseId)).size !== cases.length) fail('HARNESS_EVAL_SUITE_INVALID');
  return cases.sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
}

/** Judge one run with the existing CQG evaluator only. Mock/unknown/stale/foreign-runtime evidence is unverified. */
function judge(output: HarnessRunOutput): {passed: boolean; verified: boolean; policyDigest: string | null; commands: string; reasons: string[]} {
  const reasons: string[] = [];
  if (output.runtime !== 'claude-code') reasons.push('HARNESS_EVAL_RUNTIME_UNSUPPORTED');
  const e = output.evidence;
  if (e.producer?.model.evidenceSource !== 'native') reasons.push('HARNESS_EVAL_NATIVE_REQUIRED');
  if (e.quality.evidence.some(item => item.evidenceSource !== 'native' && item.evidenceSource !== 'local')) reasons.push('HARNESS_EVAL_OBSERVED_EVIDENCE_REQUIRED');
  const completion = evaluateTaskCompletion(e, output.policy, output.binding);
  if (completion.gates.some(g => g.status !== 'not_applicable' && (g.source === 'mock' || g.source === 'unknown' || g.freshness !== 'current')))
    reasons.push('HARNESS_EVAL_EVIDENCE_NOT_CURRENT');
  return {passed: completion.qualityPassed, verified: reasons.length === 0, policyDigest: completion.policyDigest,
    commands: JSON.stringify([...new Set(e.commands.map(c => c.id))].sort()), reasons: [...reasons, ...completion.reasonCodes].map(code)};
}

/** Append-only evaluation and approval records plus the HarnessStore `promotions` port. */
export class HarnessEvaluation {
  private store: Store;
  private ports: HarnessEvaluationPorts;
  private inflight = new Map<string, Promise<HarnessEvaluationRecord>>();
  constructor(store: Store, ports: HarnessEvaluationPorts) {
    this.store = store; this.ports = ports;
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS harness_evaluations(
        evaluation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
        body TEXT NOT NULL, body_digest TEXT NOT NULL, UNIQUE(project_id,request_id));
        CREATE TABLE IF NOT EXISTS harness_promotion_approvals(
        request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_digest TEXT NOT NULL, body TEXT NOT NULL, body_digest TEXT NOT NULL);`);
      for (const table of ['harness_evaluations', 'harness_promotion_approvals'])
        store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;
          CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;`);
    });
  }

  /** Current A (pointer), B (candidate) and suite. Throws on any precondition; used at evaluation and on every approval read. */
  private subject(projectId: string, candidateVersionId: string) {
    const stored = this.ports.harness.getVersion(projectId, candidateVersionId), candidate = stored.version;
    if (candidate.revision === 0 || !candidate.parentId) fail('HARNESS_EVAL_INVALID', 400);
    if (!EVALUABLE.includes(candidate.target)) fail('HARNESS_EVAL_RUNTIME_UNSUPPORTED');
    // AX06 is re-checked now, not trusted from append time.
    const classification = classifyHarnessCandidate({class: candidate.class, target: candidate.target, lines: candidate.lines,
      origin: stored.provenance.origin, evidence: stored.provenance.evidence});
    if (classification.status === 'blocked') fail(classification.reasons[0]);
    const parent = this.ports.harness.current(projectId, candidate.target);
    if (parent.versionId !== candidate.parentId) fail('HARNESS_STALE_POINTER');
    const failing = suiteCases((stored.provenance.evidence?.caseIds ?? []).map(caseId => {
      const c = this.ports.cases.getCase(caseId);
      if (c.id !== caseId) fail('HARNESS_PROVENANCE');
      return {caseId, digest: sha(JSON.stringify(['orbit-failure-case/1', c.id, c.familyId, c.failureId, c.provenance.recordBodySha256, c.provenance.indexerVersion]))};
    }));
    const suite = {failing, normal: suiteCases(this.ports.suite.normalCases(projectId, candidate.target)),
      protected: suiteCases(this.ports.suite.protectedCases(projectId, candidate.target))};
    // An empty kind cannot prove improvement or absence of regression.
    if (!suite.failing.length || !suite.normal.length || !suite.protected.length) fail('HARNESS_EVAL_SUITE_INCOMPLETE');
    return {candidate, parent, suite, suiteDigest: suiteDigest(suite)};
  }

  evaluate(request: HarnessEvaluationRequest): Promise<HarnessEvaluationRecord> {
    if (!exact(request, ['requestId', 'projectId', 'candidateVersionId', 'liveApproval']) || ![request.requestId, request.projectId, request.candidateVersionId].every(id)
      || !(request.liveApproval === null || (exact(request.liveApproval, ['confirmed']) && request.liveApproval.confirmed === true)))
      return Promise.reject(new AppError('HARNESS_EVAL_INVALID', 400));
    const key = JSON.stringify([request.projectId, request.requestId]);
    const running = this.inflight.get(key);
    if (running) return running.then(record => record.candidateVersionId === request.candidateVersionId ? record : fail('HARNESS_REQUEST_CONFLICT'));
    const promise = this.run(request).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async run(request: HarnessEvaluationRequest): Promise<HarnessEvaluationRecord> {
    const requestDigest = sha(JSON.stringify([request.projectId, request.requestId, request.candidateVersionId, request.liveApproval !== null]));
    const prior = this.store.db.prepare('SELECT evaluation_id,request_digest FROM harness_evaluations WHERE project_id=? AND request_id=?').get(request.projectId, request.requestId);
    if (prior) {
      if (prior.request_digest !== requestDigest) fail('HARNESS_REQUEST_CONFLICT');
      return this.getEvaluation(request.projectId, String(prior.evaluation_id));
    }
    const runner = this.ports.runner;
    if (runner.mode === 'live' && request.liveApproval === null) fail('HARNESS_EVAL_LIVE_APPROVAL_REQUIRED');
    const {candidate, parent, suite, suiteDigest: digestAtStart} = this.subject(request.projectId, request.candidateVersionId);
    const results: HarnessRunResult[] = [];
    const changed: string[] = [];
    for (const kind of ['failing', 'normal', 'protected'] as const) for (const c of suite[kind]) {
      const pair: Array<ReturnType<typeof judge> | null> = [];
      for (const [arm, version] of [['A', parent], ['B', candidate]] as const) {
        let judged: ReturnType<typeof judge> | null = null;
        try {
          judged = judge(await runner.runCase({projectId: request.projectId, target: candidate.target, arm, version: structuredClone(version),
            overlay: renderOverlay(version), kind, caseId: c.caseId, caseDigest: c.digest}));
        } catch {/* recorded as unverified below */}
        pair.push(judged);
        results.push({kind, caseId: c.caseId, arm, passed: judged?.passed ?? false, verified: judged?.verified ?? false,
          policyDigest: judged?.policyDigest ?? null, reasons: judged ? judged.reasons : ['HARNESS_EVAL_RUNNER_ERROR']});
      }
      // A new lint/test or a changed policy on one arm is not an improvement.
      if (pair[0] && pair[1] && (pair[0].policyDigest !== pair[1].policyDigest || pair[0].commands !== pair[1].commands)) changed.push(c.caseId);
    }
    const reasons: string[] = [];
    if (runner.mode !== 'live') reasons.push('HARNESS_EVAL_FAKE_RUNNER');
    if (results.some(r => !r.verified)) reasons.push('HARNESS_EVAL_UNVERIFIED_RUN');
    if (changed.length) reasons.push('HARNESS_EVAL_CHECKS_CHANGED');
    const arm = (kind: HarnessCaseKind, caseId: string, a: 'A' | 'B') => results.find(r => r.kind === kind && r.caseId === caseId && r.arm === a)!.passed;
    const regressions = (['normal', 'protected'] as const).flatMap(kind => suite[kind].filter(c => arm(kind, c.caseId, 'A') && !arm(kind, c.caseId, 'B')));
    if (regressions.length) reasons.push('HARNESS_EVAL_REGRESSION');
    const gained = suite.failing.filter(c => arm('failing', c.caseId, 'B')).length - suite.failing.filter(c => arm('failing', c.caseId, 'A')).length;
    if (gained <= 0) reasons.push('HARNESS_EVAL_NOT_IMPROVED');
    const verdict: HarnessEvaluationVerdict = reasons.some(r => r === 'HARNESS_EVAL_FAKE_RUNNER' || r === 'HARNESS_EVAL_UNVERIFIED_RUN' || r === 'HARNESS_EVAL_CHECKS_CHANGED') ? 'unverified'
      : regressions.length ? 'regressed' : gained > 0 ? 'passed' : 'not_improved';
    const body: Omit<HarnessEvaluationRecord, 'evaluationDigest'> = {evaluationId: randomUUID(), requestId: request.requestId, projectId: request.projectId,
      target: candidate.target, candidateVersionId: candidate.versionId, candidateDigest: candidate.digest, parentVersionId: parent.versionId,
      parentDigest: parent.digest, suite, suiteDigest: digestAtStart, policyDigest: HARNESS_EVALUATION_POLICY_DIGEST, runnerMode: runner.mode,
      results, verdict, reasons, createdAt: new Date().toISOString()};
    const record: HarnessEvaluationRecord = {...body, evaluationDigest: evaluationDigest(body)};
    const text = JSON.stringify(record);
    if (containsCredential(text)) fail('HARNESS_UNSAFE_TEXT');
    return this.store.transaction(() => {
      // A concurrent writer of the same request (another process) wins; replay it.
      const raced = this.store.db.prepare('SELECT evaluation_id,request_digest FROM harness_evaluations WHERE project_id=? AND request_id=?').get(request.projectId, request.requestId);
      if (raced) return raced.request_digest === requestDigest ? this.getEvaluation(request.projectId, String(raced.evaluation_id)) : fail('HARNESS_REQUEST_CONFLICT');
      this.store.db.prepare('INSERT INTO harness_evaluations VALUES(?,?,?,?,?,?)').run(record.evaluationId, request.projectId, request.requestId, requestDigest, text, sha(text));
      return record;
    });
  }

  getEvaluation(projectId: string, evaluationId: string): HarnessEvaluationRecord {
    if (!id(projectId) || !id(evaluationId)) fail('HARNESS_EVAL_INVALID', 400);
    const row = this.store.db.prepare('SELECT body,body_digest FROM harness_evaluations WHERE project_id=? AND evaluation_id=?').get(projectId, evaluationId);
    if (!row) fail('HARNESS_EVAL_NOT_FOUND', 404);
    if (typeof row.body !== 'string' || sha(row.body) !== row.body_digest) fail('HARNESS_INTEGRITY');
    const record = JSON.parse(row.body) as HarnessEvaluationRecord;
    const {evaluationDigest: stored, ...body} = record;
    if (stored !== evaluationDigest(body) || record.projectId !== projectId || record.evaluationId !== evaluationId) fail('HARNESS_INTEGRITY');
    return record;
  }

  /** Throws unless the evaluation passed and every binding (candidate, parent pointer, suite, policy) is unchanged. */
  private fresh(record: HarnessEvaluationRecord): ReturnType<HarnessEvaluation['subject']> {
    if (record.verdict !== 'passed' || record.runnerMode !== 'live') fail('HARNESS_EVAL_NOT_PASSED');
    if (record.policyDigest !== HARNESS_EVALUATION_POLICY_DIGEST) fail('HARNESS_EVAL_STALE');
    let now: ReturnType<HarnessEvaluation['subject']>;
    try {now = this.subject(record.projectId, record.candidateVersionId);} catch {fail('HARNESS_EVAL_STALE');}
    if (now.candidate.digest !== record.candidateDigest || now.parent.versionId !== record.parentVersionId
      || now.parent.digest !== record.parentDigest || now.suiteDigest !== record.suiteDigest) fail('HARNESS_EVAL_STALE');
    return now;
  }

  /** Records explicit user approval bound to the evaluated candidate digest. Does NOT promote. */
  approvePromotion(approval: HarnessPromotionApproval, expectedSequence: number): HarnessPromotionGrant {
    if (!exact(approval, ['requestId', 'projectId', 'evaluationId', 'candidateDigest', 'evaluationDigest', 'confirmed'])
      || ![approval.requestId, approval.projectId, approval.evaluationId].every(id) || !hex(approval.candidateDigest) || !hex(approval.evaluationDigest))
      fail('HARNESS_EVAL_INVALID', 400);
    if (approval.confirmed !== true) fail('HARNESS_APPROVAL_REQUIRED');
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) fail('HARNESS_EVAL_INVALID', 400);
    const requestDigest = sha(JSON.stringify([approval.requestId, approval.projectId, approval.evaluationId, approval.candidateDigest, approval.evaluationDigest, expectedSequence]));
    return this.store.transaction(() => {
      const prior = this.store.db.prepare('SELECT request_digest FROM harness_promotion_approvals WHERE request_id=?').get(approval.requestId);
      if (prior) {
        if (prior.request_digest !== requestDigest) fail('HARNESS_REQUEST_CONFLICT');
        return this.storedGrant(approval.requestId) ?? fail('HARNESS_INTEGRITY');
      }
      const record = this.getEvaluation(approval.projectId, approval.evaluationId);
      if (record.candidateDigest !== approval.candidateDigest || record.evaluationDigest !== approval.evaluationDigest) fail('HARNESS_APPROVAL_MISMATCH');
      this.fresh(record);
      const grant: HarnessPromotionGrant = {requestId: approval.requestId, projectId: record.projectId, target: record.target,
        versionId: record.candidateVersionId, fromVersionId: record.parentVersionId, expectedSequence,
        candidateDigest: record.candidateDigest, evaluationDigest: record.evaluationDigest};
      const body = JSON.stringify({grant, evaluationId: record.evaluationId, approvedAt: new Date().toISOString()});
      this.store.db.prepare('INSERT INTO harness_promotion_approvals VALUES(?,?,?,?,?)').run(approval.requestId, record.projectId, requestDigest, body, sha(body));
      return grant;
    });
  }

  private storedGrant(requestId: string): HarnessPromotionGrant | null {
    const row = this.store.db.prepare('SELECT body,body_digest FROM harness_promotion_approvals WHERE request_id=?').get(requestId);
    if (!row || typeof row.body !== 'string' || sha(row.body) !== row.body_digest) return null;
    return (JSON.parse(row.body) as {grant: HarnessPromotionGrant}).grant;
  }

  /** HarnessStorePorts.promotions. Read-only; null unless the approved evaluation is still passed and fresh. */
  getApprovedPromotion(requestId: string): HarnessPromotionGrant | null {
    try {
      if (!id(requestId)) return null;
      const row = this.store.db.prepare('SELECT body FROM harness_promotion_approvals WHERE request_id=?').get(requestId);
      const grant = this.storedGrant(requestId);
      if (!row || !grant) return null;
      const record = this.getEvaluation(grant.projectId, (JSON.parse(String(row.body)) as {evaluationId: string}).evaluationId);
      if (record.candidateDigest !== grant.candidateDigest || record.evaluationDigest !== grant.evaluationDigest
        || record.candidateVersionId !== grant.versionId || record.parentVersionId !== grant.fromVersionId) return null;
      this.fresh(record);
      return grant;
    } catch {return null;}
  }
}
