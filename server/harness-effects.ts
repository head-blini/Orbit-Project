import {createHash} from 'node:crypto';
import type {Store} from './store.ts';
import type {HarnessPointerRecord, HarnessStore, HarnessStoredVersion} from './harness-store.ts';
import type {HarnessEvaluation, HarnessEvaluationRecord} from './harness-evaluation.ts';
import type {FailureIndex} from './failure-index.ts';
import {HARNESS_ALLOWED, type HarnessTarget} from '../shared/harness.ts';

/** HE-6: read-only effects projection (docs/ORBIT-HE-D1.md 2(e), HE-6). SELECT and in-memory only: no write,
 * execution, model call, promotion or rollback. Time comes only from stored records, never the clock.
 * Counts are null (unknown), never 0, when they cannot be established. There is deliberately no "improved"
 * state: windows have no exposure denominator, so absence of recurrence is only "no_recurrence_observed". */

export interface HarnessEffectsPorts {
  harness: Pick<HarnessStore, 'listVersions' | 'history'>;
  evaluation: Pick<HarnessEvaluation, 'getEvaluation'>;
  failures: Pick<FailureIndex, 'families' | 'list'>;
}
export interface EvidenceCounts {real: number; mock: number; unknown: number; undated: number}
export type EffectStatus = 'baseline' | 'no_evidence' | 'unknown' | 'insufficient_baseline' | 'recurrence_observed' | 'no_recurrence_observed' | 'unverified';
export interface FamilyEffect {familyId: string; before: EvidenceCounts | null; after: EvidenceCounts | null}
export interface EffectWindow {
  /** Pointer event that made this version active, and the event that ended it (null while active). */
  startSequence: number; startedAt: string; endedAt: string | null;
  families: FamilyEffect[]; status: EffectStatus;
  /** A proposal only (HE-D1 default 5). Never executed here. */
  rollbackProposed: boolean;
}
export interface EvaluationSummary {
  evaluationId: string; state: 'ok' | 'invalid'; verdict: HarnessEvaluationRecord['verdict'] | null; runnerMode: HarnessEvaluationRecord['runnerMode'] | null;
  reasons: string[]; createdAt: string | null; evaluationDigest: string | null;
  /** True only for a live, passed evaluation; fake/unverified/not_improved never count as evidence of improvement. */
  verified: boolean;
}
export interface ApprovalSummary {requestId: string; evaluationId: string; approvedAt: string; evaluationDigest: string; candidateDigest: string}
export interface VersionEffect {
  versionId: string; revision: number; digest: string; parentId: string | null; origin: HarnessStoredVersion['provenance']['origin'];
  createdAt: string | null; evaluations: EvaluationSummary[]; approvals: ApprovalSummary[]; windows: EffectWindow[];
}
export interface TargetEffect {
  target: HarnessTarget; state: 'ok' | 'error'; error: string | null;
  activeVersionId: string | null; activeRevision: number | null; pointerSequence: number | null;
  history: Array<{sequence: number; kind: 'promotion' | 'rollback'; versionId: string; fromVersionId: string; requestId: string; createdAt: string}>;
  versions: VersionEffect[];
}
export interface HarnessEffectsView {projectId: string; targets: TargetEffect[]}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const zero = (): EvidenceCounts => ({real: 0, mock: 0, unknown: 0, undated: 0});
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const message = (e: unknown) => e instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(e.message) ? e.message : 'HARNESS_EFFECTS_UNAVAILABLE';

export class HarnessEffects {
  private store: Store;
  private ports: HarnessEffectsPorts;
  constructor(store: Store, ports: HarnessEffectsPorts) {this.store = store; this.ports = ports;}

  private has(table: string) {return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}

  private evaluations(projectId: string): Map<string, EvaluationSummary[]> {
    const out = new Map<string, EvaluationSummary[]>();
    if (!this.has('harness_evaluations')) return out;
    for (const row of this.store.db.prepare('SELECT evaluation_id,body FROM harness_evaluations WHERE project_id=? ORDER BY rowid').all(projectId)) {
      const evaluationId = String(row.evaluation_id);
      let versionId = '', summary: EvaluationSummary;
      try {
        const r = this.ports.evaluation.getEvaluation(projectId, evaluationId); // verifies body and evaluation digests
        versionId = r.candidateVersionId;
        summary = {evaluationId, state: 'ok', verdict: r.verdict, runnerMode: r.runnerMode, reasons: [...r.reasons], createdAt: r.createdAt,
          evaluationDigest: r.evaluationDigest, verified: r.verdict === 'passed' && r.runnerMode === 'live'};
      } catch {
        // Corrupt record: surface as invalid, attached to its claimed version only if it parses as such.
        try {versionId = String((JSON.parse(String(row.body)) as {candidateVersionId?: unknown}).candidateVersionId ?? '');} catch {/* unattributable */}
        summary = {evaluationId, state: 'invalid', verdict: null, runnerMode: null, reasons: ['HARNESS_INTEGRITY'], createdAt: null, evaluationDigest: null, verified: false};
      }
      out.set(versionId, [...(out.get(versionId) ?? []), summary]);
    }
    return out;
  }

  private approvals(projectId: string): Map<string, ApprovalSummary[]> {
    const out = new Map<string, ApprovalSummary[]>();
    if (!this.has('harness_promotion_approvals')) return out;
    for (const row of this.store.db.prepare('SELECT request_id,body,body_digest FROM harness_promotion_approvals WHERE project_id=? ORDER BY rowid').all(projectId)) {
      try {
        if (typeof row.body !== 'string' || sha(row.body) !== row.body_digest) continue; // unverifiable approvals are not shown as approvals
        const b = JSON.parse(row.body) as {grant: {versionId: string; candidateDigest: string; evaluationDigest: string}; evaluationId: string; approvedAt: string};
        out.set(b.grant.versionId, [...(out.get(b.grant.versionId) ?? []), {requestId: String(row.request_id), evaluationId: b.evaluationId,
          approvedAt: b.approvedAt, evaluationDigest: b.grant.evaluationDigest, candidateDigest: b.grant.candidateDigest}]);
      } catch {/* skipped */}
    }
    return out;
  }

  /** familyId -> dated observation list; null when the failure index is unavailable (unknown, not zero). */
  private failureTimes(projectId: string): Map<string, Array<{at: string; evidence: 'real' | 'mock' | 'unknown'}>> | null {
    try {
      const at = new Map(this.ports.failures.list(projectId).map(r => [r.id, r]));
      const out = new Map<string, Array<{at: string; evidence: 'real' | 'mock' | 'unknown'}>>();
      const seen = new Set<string>();
      for (const f of this.ports.failures.families(projectId)) for (const id of f.evidenceIds) {
        const rec = at.get(id), key = f.familyId + '\0' + id;
        if (!rec || seen.has(key)) continue;
        seen.add(key);
        const evidence = rec.evidenceSource === 'native' || rec.evidenceSource === 'local' ? 'real' : rec.evidenceSource === 'mock' ? 'mock' : 'unknown';
        out.set(f.familyId, [...(out.get(f.familyId) ?? []), {at: rec.at, evidence}]);
      }
      return out;
    } catch {return null;}
  }

  private window(familyIds: string[] | null, times: ReturnType<HarnessEffects['failureTimes']>, start: HarnessPointerRecord, end: HarnessPointerRecord | null, baseline: boolean): EffectWindow {
    const base = {startSequence: start.sequence, startedAt: start.createdAt, endedAt: end?.createdAt ?? null, rollbackProposed: false};
    if (baseline) return {...base, families: [], status: 'baseline'};
    if (!familyIds?.length) return {...base, families: [], status: 'no_evidence'};
    if (!times) return {...base, families: familyIds.map(familyId => ({familyId, before: null, after: null})), status: 'unknown'};
    const families = familyIds.map((familyId): FamilyEffect => {
      const before = zero(), after = zero();
      for (const o of times.get(familyId) ?? []) {
        const bucket = !ISO.test(o.at) ? null : o.at < start.createdAt ? before : (end === null || o.at < end.createdAt) ? after : null;
        if (!ISO.test(o.at)) {before.undated++; after.undated++;} // cannot place it in either window
        else if (bucket) bucket[o.evidence]++;
      }
      return {familyId, before, after};
    });
    const sum = (k: 'before' | 'after', f: keyof EvidenceCounts) => families.reduce((n, x) => n + (x[k]?.[f] ?? 0), 0);
    let status: EffectStatus;
    if (sum('before', 'real') === 0) status = 'insufficient_baseline'; // no real prior failure: cannot tell what changed
    else if (sum('after', 'real') > 0) status = 'recurrence_observed';
    else if (sum('after', 'mock') + sum('after', 'unknown') + sum('after', 'undated') > 0) status = 'unverified';
    else status = 'no_recurrence_observed';
    return {...base, families, status, rollbackProposed: status === 'recurrence_observed' && end === null};
  }

  private target(projectId: string, target: HarnessTarget, evals: Map<string, EvaluationSummary[]>, apps: Map<string, ApprovalSummary[]>,
    times: ReturnType<HarnessEffects['failureTimes']>): TargetEffect {
    const empty = (error: string): TargetEffect => ({target, state: 'error', error, activeVersionId: null, activeRevision: null, pointerSequence: null, history: [], versions: []});
    try {
      const stored = this.ports.harness.listVersions(projectId, target), events = this.ports.harness.history(projectId, target);
      const activeId = events.at(-1)?.request.versionId ?? stored[0].version.versionId;
      const versions = stored.map((s): VersionEffect => {
        const v = s.version;
        const windows = events.flatMap((e, i) => e.request.versionId === v.versionId ? [this.window(s.provenance.evidence?.familyIds ?? null, times, e, events[i + 1] ?? null, v.revision === 0)] : []);
        return {versionId: v.versionId, revision: v.revision, digest: v.digest, parentId: v.parentId, origin: s.provenance.origin, createdAt: s.provenance.createdAt,
          evaluations: evals.get(v.versionId) ?? [], approvals: apps.get(v.versionId) ?? [], windows};
      });
      return {target, state: 'ok', error: null, activeVersionId: activeId, activeRevision: stored.find(s => s.version.versionId === activeId)?.version.revision ?? null,
        pointerSequence: events.length, versions,
        history: events.map(e => ({sequence: e.sequence, kind: e.kind, versionId: e.request.versionId, fromVersionId: e.request.fromVersionId, requestId: e.request.requestId, createdAt: e.createdAt}))};
    } catch (e) {return empty(message(e));}
  }

  view(projectId: string): HarnessEffectsView {
    let evals = new Map<string, EvaluationSummary[]>(), apps = new Map<string, ApprovalSummary[]>();
    try {evals = this.evaluations(projectId); apps = this.approvals(projectId);} catch {/* shown as no records; per-version lists stay empty */}
    const times = this.failureTimes(projectId);
    return {projectId, targets: HARNESS_ALLOWED.execution_guidance.map(t => this.target(projectId, t, evals, apps, times))};
  }
}
