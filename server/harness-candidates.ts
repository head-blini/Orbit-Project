import {createHash} from 'node:crypto';
import {classifyHarnessCandidate} from './harness-policy.ts';
import type {FailureIndex} from './failure-index.ts';
import type {FailureCase, FailureCaseReader} from './failure-cases.ts';
import type {HarnessStore, HarnessStoredVersion} from './harness-store.ts';
import type {FailureFamilyTuple, FailureOccurrence} from '../shared/failure-intelligence.ts';
import type {HarnessCandidate, HarnessClassification, HarnessTarget} from '../shared/harness.ts';

/** HE-3: deterministic candidate drafts from FE evidence (docs/ORBIT-HE-D1.md 2(b)). No model call.
 * Candidates are appended as unpromoted versions only; promotion/evaluation/injection belong to HE-4/HE-5. */

interface HarnessRule {id: string; target: 'runtime' | 'repair'; line: string}
/** Deterministic table: `category:source:code` -> guidance template. Only output_rejected families with
 * run/request ids qualify; tool, auth, quota and policy refusals are not fixable by prompt guidance. */
export const HARNESS_RULES: Readonly<Record<string, HarnessRule>> = Object.freeze({
  'output_rejected:quality:QUALITY_EVIDENCE_INVALID': {id: 'report-observed-only/1', target: 'runtime',
    line: '결과를 보고할 때는 실제로 실행한 명령과 관찰한 결과만 적고, 확인하지 않은 내용은 확인하지 않았다고 밝힌다.'},
  'output_rejected:quality:QUALITY_REPAIR_EVIDENCE_INVALID': {id: 'repair-scoped-evidence/1', target: 'repair',
    line: '수정할 때는 지적된 문제에 필요한 범위만 바꾸고, 바꾼 내용과 그 근거를 함께 적는다.'},
});
/** Runtime ids from shared/capability-orchestration.ts RuntimeId; anything else is unmapped. */
const RUNTIME_TARGET: Readonly<Record<string, HarnessTarget>> = Object.freeze({'claude-code': 'claude_task', codex: 'codex_brief'});
/** HarnessStore evidenceValid bound. */
const MAX_EVIDENCE_IDS = 64;

export type HarnessCandidateSkipReason = 'NO_RULE' | 'RUNTIME_UNMAPPED' | 'INSUFFICIENT_REAL_EVIDENCE' | 'CASE_REQUIRED'
  | 'INDEXER_VERSION_MIXED' | 'EVIDENCE_TOO_LARGE' | 'ALREADY_PRESENT';
export interface HarnessCandidateSkip {familyIds: string[]; reason: HarnessCandidateSkipReason}
export interface HarnessCandidateDraft {
  requestId: string; parentId: string; ruleId: string; candidate: HarnessCandidate; classification: HarnessClassification;
}
export interface HarnessCandidatePorts {
  failures: Pick<FailureIndex, 'families'>;
  cases: Pick<FailureCaseReader, 'listCases'>;
  harness: Pick<HarnessStore, 'current'>;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const real = (o: FailureOccurrence) => o.evidenceSource === 'native' || o.evidenceSource === 'local';
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** FE-D1 default 2: two real failures with different runId and requestId, not rounds of one quality loop. */
function independentlyRepeated(occurrences: FailureOccurrence[]): boolean {
  const usable = occurrences.filter(o => real(o) && o.runId && o.requestId);
  return usable.some((a, i) => usable.slice(i + 1).some(b => a.runId !== b.runId && a.requestId !== b.requestId
    && (a.qualityLoopId === null || a.qualityLoopId !== b.qualityLoopId)));
}

/** Read-only. Same FE evidence and same current pointer give byte-identical drafts. */
export function draftHarnessCandidates(projectId: string, ports: HarnessCandidatePorts): {drafts: HarnessCandidateDraft[]; skipped: HarnessCandidateSkip[]} {
  // familyId hashes the tuple only, so one family may appear in several task/binding scopes: merge them.
  const families = new Map<string, {tuple: FailureFamilyTuple; occurrences: FailureOccurrence[]}>();
  for (const f of ports.failures.families(projectId)) {
    const entry = families.get(f.familyId) ?? {tuple: f.tuple, occurrences: []};
    entry.occurrences.push(...f.occurrences);
    families.set(f.familyId, entry);
  }
  const skipped: HarnessCandidateSkip[] = [];
  const groups = new Map<string, {target: HarnessTarget; rule: HarnessRule; familyIds: string[]; cases: FailureCase[]}>();
  for (const familyId of sorted(families.keys())) {
    const {tuple: [category, code, source, , runtime], occurrences} = families.get(familyId)!;
    const skip = (reason: HarnessCandidateSkipReason) => skipped.push({familyIds: [familyId], reason});
    const rule = Object.hasOwn(HARNESS_RULES, `${category}:${source}:${code}`) ? HARNESS_RULES[`${category}:${source}:${code}`] : undefined;
    if (!rule) {skip('NO_RULE'); continue;}
    if (!runtime || !Object.hasOwn(RUNTIME_TARGET, runtime)) {skip('RUNTIME_UNMAPPED'); continue;}
    // Mock and unknown-provenance occurrences never count (FE-D1 2(b)); a mock-only family stops here.
    if (!independentlyRepeated(occurrences)) {skip('INSUFFICIENT_REAL_EVIDENCE'); continue;}
    // A case counts only if it reproduces a real occurrence of this family in this project.
    const realIds = new Set(occurrences.filter(real).map(o => o.id));
    const cases = ports.cases.listCases(familyId).filter(c => c.familyId === familyId && realIds.has(c.failureId));
    if (!cases.length) {skip('CASE_REQUIRED'); continue;}
    const target = rule.target === 'repair' ? 'repair' : RUNTIME_TARGET[runtime];
    const key = JSON.stringify([target, rule.id]);
    const group = groups.get(key) ?? {target, rule, familyIds: [], cases: []};
    group.familyIds.push(familyId); group.cases.push(...cases);
    groups.set(key, group);
  }
  const drafts: HarnessCandidateDraft[] = [];
  for (const key of sorted(groups.keys())) {
    const {target, rule, familyIds, cases} = groups.get(key)!;
    const skip = (reason: HarnessCandidateSkipReason) => skipped.push({familyIds, reason});
    const caseIds = sorted(cases.map(c => c.id)), versions = sorted(cases.map(c => c.provenance.indexerVersion));
    if (versions.length !== 1) {skip('INDEXER_VERSION_MIXED'); continue;}
    if (familyIds.length > MAX_EVIDENCE_IDS || caseIds.length > MAX_EVIDENCE_IDS) {skip('EVIDENCE_TOO_LARGE'); continue;}
    const parent = ports.harness.current(projectId, target);
    if (parent.lines.includes(rule.line)) {skip('ALREADY_PRESENT'); continue;}
    const candidate: HarnessCandidate = {class: 'execution_guidance', target, lines: [...parent.lines, rule.line], origin: 'rule',
      evidence: {familyIds, caseIds, indexerVersion: versions[0]}};
    const requestId = 'harness-candidate-' + sha(JSON.stringify(['orbit-harness-candidate/1', projectId, parent.versionId, candidate]));
    drafts.push({requestId, parentId: parent.versionId, ruleId: rule.id, candidate, classification: classifyHarnessCandidate(candidate)});
  }
  return {drafts, skipped};
}

/** Appends eligible drafts as candidate versions. Idempotent: deterministic requestIds replay in HarnessStore.
 * Blocked drafts (AX06) are returned, never stored or evaluated. The pointer is never moved here. */
export function generateHarnessCandidates(projectId: string, ports: HarnessCandidatePorts & {harness: Pick<HarnessStore, 'current' | 'append'>}):
  {stored: HarnessStoredVersion[]; blocked: HarnessCandidateDraft[]; skipped: HarnessCandidateSkip[]} {
  const {drafts, skipped} = draftHarnessCandidates(projectId, ports);
  const stored: HarnessStoredVersion[] = [], blocked: HarnessCandidateDraft[] = [];
  for (const draft of drafts) {
    if (draft.classification.status === 'blocked') {blocked.push(draft); continue;}
    stored.push(ports.harness.append({projectId, requestId: draft.requestId, parentId: draft.parentId, candidate: draft.candidate}));
  }
  return {stored, blocked, skipped};
}
