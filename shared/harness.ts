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
