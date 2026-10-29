/** Harness Evolution (X06) contract, HE-1. Browser-safe: no node imports. See docs/ORBIT-HE-D1.md. */

export type HarnessClass = 'execution_guidance';
export type HarnessTarget = 'claude_task' | 'codex_brief' | 'repair';
export type HarnessReason = 'HARNESS_INVALID' | 'HARNESS_CLASS_PROTECTED' | 'HARNESS_TOO_LARGE' | 'HARNESS_UNSAFE_TEXT' | 'HARNESS_POLICY_OVERRIDE';

export interface HarnessVersion {
  versionId: string;
  class: HarnessClass;
  target: HarnessTarget;
  /** N in "Orbit 하네스 vN"; 0 is the empty overlay and the final rollback point. */
  revision: number;
  lines: string[];
  parentId: string | null;
  digest: string;
}

export interface HarnessEvidence { familyIds: string[]; caseIds: string[]; indexerVersion: string }

export interface HarnessCandidate {
  class: HarnessClass;
  target: HarnessTarget;
  lines: string[];
  evidence: HarnessEvidence | null;
  origin: 'rule' | 'user';
}

export type HarnessClassification = {status: 'eligible'} | {status: 'blocked'; reasons: HarnessReason[]};

/** Structural allow table: the only class/target pairs HE may ever change (append-only). */
export const HARNESS_ALLOWED: Readonly<Record<HarnessClass, readonly HarnessTarget[]>> = Object.freeze({
  execution_guidance: Object.freeze(['claude_task', 'codex_brief', 'repair'] as const),
});

export const HARNESS_MAX_LINES = 5;
export const HARNESS_MAX_LINE_CHARS = 160;
/** Worst case render is ~840 chars, leaving most of the 4000-char Codex brief bound (MAX_EXECUTION_PROMPT_CHARS) to the plan. */
export const HARNESS_MAX_OVERLAY_CHARS = 1000;
export const HARNESS_REASON_ORDER: readonly HarnessReason[] = ['HARNESS_INVALID', 'HARNESS_CLASS_PROTECTED', 'HARNESS_TOO_LARGE', 'HARNESS_UNSAFE_TEXT', 'HARNESS_POLICY_OVERRIDE'];

/** C0/C1 controls (incl. newlines/tabs) and format chars (zero-width, bidi overrides). */
export const HARNESS_CONTROL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export const harnessOverlayHeader = (revision: number) => `추가 실행 지침(Orbit 하네스 v${revision}):`;

/** Exact overlay block; '' for v0 so injection stays byte-identical. Validated versions only; throws on structural violations. */
export function renderOverlay(version: Pick<HarnessVersion, 'revision' | 'lines'>): string {
  const {revision, lines} = version;
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(lines) || lines.length > HARNESS_MAX_LINES || (revision === 0) !== (lines.length === 0)
    || !lines.every(line => typeof line === 'string' && line.trim() === line && line.length > 0 && line.length <= HARNESS_MAX_LINE_CHARS && !HARNESS_CONTROL_CHARS.test(line)))
    throw new Error('HARNESS_RENDER_INVALID');
  if (revision === 0) return '';
  const text = [harnessOverlayHeader(revision), ...lines.map(line => '- ' + line)].join('\n');
  if (text.length > HARNESS_MAX_OVERLAY_CHARS) throw new Error('HARNESS_RENDER_INVALID');
  return text;
}

/** HE-7 read model (GET /api/projects/:id/harness): HE-6 effects plus line text, AX06 status and approval freshness. */
export type HarnessEffectStatus = 'baseline' | 'no_evidence' | 'unknown' | 'insufficient_baseline' | 'recurrence_observed' | 'no_recurrence_observed' | 'unverified';
export interface HarnessEvaluationView {
  evaluationId: string; state: 'ok' | 'invalid'; verdict: 'passed' | 'not_improved' | 'regressed' | 'unverified' | null;
  runnerMode: 'fake' | 'live' | null; reasons: string[]; createdAt: string | null; evaluationDigest: string | null;
  /** True only for a live, passed evaluation. */
  verified: boolean;
}
export interface HarnessApprovalView {requestId: string; evaluationId: string; approvedAt: string; evaluationDigest: string; candidateDigest: string; fresh: boolean}
export interface HarnessVersionView {
  versionId: string; revision: number; digest: string; parentId: string | null; origin: 'rule' | 'user' | 'baseline'; createdAt: string | null;
  lines: string[]; evidence: HarnessEvidence | null; classification: HarnessClassification;
  evaluations: HarnessEvaluationView[]; approvals: HarnessApprovalView[];
  windows: Array<{startSequence: number; startedAt: string; endedAt: string | null; status: HarnessEffectStatus; rollbackProposed: boolean;
    families: Array<{familyId: string; before: Record<'real' | 'mock' | 'unknown' | 'undated', number> | null; after: Record<'real' | 'mock' | 'unknown' | 'undated', number> | null}>}>;
}
export interface HarnessTargetView {
  target: HarnessTarget; state: 'ok' | 'error'; error: string | null;
  activeVersionId: string | null; activeRevision: number | null; pointerSequence: number | null;
  history: Array<{sequence: number; kind: 'promotion' | 'rollback'; versionId: string; fromVersionId: string; requestId: string; createdAt: string}>;
  versions: HarnessVersionView[];
}
export interface HarnessProjectView {projectId: string; runnerMode: 'fake' | 'live' | null; targets: HarnessTargetView[]}
