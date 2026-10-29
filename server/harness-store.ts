import {createHash, randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {classifyHarnessCandidate, harnessDigest, harnessV0} from './harness-policy.ts';
import {HARNESS_ALLOWED, renderOverlay, type HarnessCandidate, type HarnessEvidence, type HarnessTarget, type HarnessVersion} from '../shared/harness.ts';
import type {FailureCaseProvenance, FailureCaseReader} from './failure-cases.ts';

export interface HarnessAppend {projectId: string; requestId: string; parentId: string; candidate: HarnessCandidate}
export interface HarnessStoredVersion {
  projectId: string;
  version: HarnessVersion;
  provenance: {requestId: string | null; origin: HarnessCandidate['origin'] | 'baseline'; evidence: HarnessEvidence | null;
    cases: Array<FailureCaseProvenance & {caseId: string; familyId: string}>; createdAt: string | null};
}
export interface HarnessPromotionGrant {
  requestId: string; projectId: string; target: HarnessTarget; versionId: string; fromVersionId: string;
  expectedSequence: number; candidateDigest: string; evaluationDigest: string;
}
export interface HarnessRollback {
  requestId: string; projectId: string; target: HarnessTarget; versionId: string; fromVersionId: string;
  expectedSequence: number; confirmed: true;
}
export interface HarnessPointerRecord {
  sequence: number; kind: 'promotion' | 'rollback'; request: HarnessPromotionGrant | HarnessRollback; createdAt: string;
}
export interface HarnessStorePorts {
  cases?: Pick<FailureCaseReader, 'getCase'>;
  /** Trusted server-owned HE-4 port, never a client assertion. Return null unless the CURRENT evaluation
   * is native, verified, fresh and user-approved with these exact bindings. HE-2 does not evaluate.
   * Called synchronously within the write transaction; implementations must not perform writes. */
  promotions?: {getApprovedPromotion(requestId: string): HarnessPromotionGrant | null};
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(code: string): never {throw new AppError(code);}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, keys: readonly string[]) => plain(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(v) && !/[\r\n]/u.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v) && v.length === 64;
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const targetValid = (v: unknown): v is HarnessTarget => HARNESS_ALLOWED.execution_guidance.includes(v as HarnessTarget);
const APPEND_KEYS = ['projectId', 'requestId', 'parentId', 'candidate'];
const POINTER_KEYS = ['requestId', 'projectId', 'target', 'versionId', 'fromVersionId', 'expectedSequence'];
const PROMOTION_KEYS = [...POINTER_KEYS, 'candidateDigest', 'evaluationDigest'];
const ROLLBACK_KEYS = [...POINTER_KEYS, 'confirmed'];
const PROVENANCE_KEYS = ['sourceTable', 'recordId', 'recordBodySha256', 'indexerVersion', 'createdAt', 'caseId', 'familyId'];
const SOURCE_TABLES = ['runs', 'events', 'verification_checks', 'quality_loops', 'integration_queue', 'worker_integration_refusals', 'capability_executions'];

/** Bound traversal and inspect every supplied string, including metadata; reject rather than redact. */
function safeInput(value: unknown): void {
  const strings: string[] = [];
  let nodes = 0;
  function walk(v: unknown, depth: number): void {
    if (++nodes > 512 || depth > 8) fail('HARNESS_INVALID');
    if (typeof v === 'string') {
      if (v.length > 4096 || containsCredential(v)) fail('HARNESS_UNSAFE_TEXT');
      strings.push(v);
    } else if (v !== null && typeof v === 'object') {
      if (!Array.isArray(v) && !plain(v)) fail('HARNESS_INVALID');
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if (!('value' in descriptor)) fail('HARNESS_INVALID');
        walk(key, depth + 1); walk(descriptor.value, depth + 1);
      }
    } else if (v !== null && typeof v !== 'boolean' && typeof v !== 'number') fail('HARNESS_INVALID');
  }
  walk(value, 0);
  if (containsCredential(strings.join('\n'))) fail('HARNESS_UNSAFE_TEXT');
}
function scope(projectId: string, target?: HarnessTarget): void {
  safeInput(projectId);
  if (!id(projectId) || (target !== undefined && !targetValid(target))) fail('HARNESS_INVALID');
}
function evidenceValid(e: HarnessEvidence | null): boolean {
  return e === null || (exact(e, ['familyIds', 'caseIds', 'indexerVersion']) && id(e.indexerVersion)
    && [e.familyIds, e.caseIds].every(a => Array.isArray(a) && a.length > 0 && a.length <= 64 && a.every(id) && new Set(a).size === a.length));
}
function candidateValid(c: HarnessCandidate): void {
  if (!exact(c, ['class', 'target', 'lines', 'origin', 'evidence']) || !evidenceValid(c.evidence)) fail('HARNESS_INVALID');
  const result = classifyHarnessCandidate(c);
  if (result.status === 'blocked') fail(result.reasons[0]);
}
function pointerValid(request: HarnessPromotionGrant | HarnessRollback, kind: HarnessPointerRecord['kind']): void {
  safeInput(request);
  if (!exact(request, kind === 'promotion' ? PROMOTION_KEYS : ROLLBACK_KEYS)
    || ![request.requestId, request.projectId, request.versionId, request.fromVersionId].every(id)
    || !targetValid(request.target) || !Number.isSafeInteger(request.expectedSequence) || request.expectedSequence < 0)
    fail('HARNESS_INVALID');
  if (kind === 'promotion') {
    const r = request as HarnessPromotionGrant;
    if (!digest(r.candidateDigest) || !digest(r.evaluationDigest)) fail('HARNESS_INVALID');
  } else if ((request as HarnessRollback).confirmed !== true) fail('HARNESS_APPROVAL_REQUIRED');
}
const sameRequest = (a: HarnessPromotionGrant | HarnessRollback, b: HarnessPromotionGrant | HarnessRollback, kind: HarnessPointerRecord['kind']) =>
  (kind === 'promotion' ? PROMOTION_KEYS : ROLLBACK_KEYS).every(k => (a as unknown as Record<string, unknown>)[k] === (b as unknown as Record<string, unknown>)[k]);

/** Durable append-only storage. No HTTP, runtime, candidate generation or evaluation ownership. */
export class HarnessStore {
  private store: Store;
  private ports: HarnessStorePorts;
  constructor(store: Store, ports: HarnessStorePorts = {}) {
    this.store = store; this.ports = ports;
    // DDL only: a SAVEPOINT is atomic both standalone and inside a caller's transaction
    // (store.transaction would throw NESTED_TRANSACTION when constructed inside one).
    const ddl = (work: () => void) => {
      store.db.exec('SAVEPOINT harness_store_init');
      try { work(); store.db.exec('RELEASE harness_store_init'); }
      catch (error) { store.db.exec('ROLLBACK TO harness_store_init; RELEASE harness_store_init'); throw error; }
    };
    ddl(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS harness_versions(
        version_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target TEXT NOT NULL,
        request_id TEXT NOT NULL, request_digest TEXT NOT NULL, body TEXT NOT NULL, body_digest TEXT NOT NULL,
        UNIQUE(project_id,request_id));
        CREATE TABLE IF NOT EXISTS harness_pointer_history(
        project_id TEXT NOT NULL, target TEXT NOT NULL, sequence INTEGER NOT NULL,
        request_id TEXT NOT NULL, body TEXT NOT NULL, body_digest TEXT NOT NULL,
        PRIMARY KEY(project_id,target,sequence), UNIQUE(project_id,request_id));`);
      for (const table of ['harness_versions', 'harness_pointer_history']) {
        store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
          BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;
          CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
          BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;`);
      }
      // REPLACE may skip delete triggers when recursive_triggers is off; block conflicts before insertion.
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS harness_versions_no_replace BEFORE INSERT ON harness_versions
        WHEN EXISTS(SELECT 1 FROM harness_versions WHERE version_id=NEW.version_id OR (project_id=NEW.project_id AND request_id=NEW.request_id))
        BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;
        CREATE TRIGGER IF NOT EXISTS harness_pointer_history_no_replace BEFORE INSERT ON harness_pointer_history
        WHEN EXISTS(SELECT 1 FROM harness_pointer_history WHERE project_id=NEW.project_id AND
          (request_id=NEW.request_id OR (target=NEW.target AND sequence=NEW.sequence)))
        BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;`);
    });
  }

  private baseline(projectId: string, target: HarnessTarget): HarnessStoredVersion {
    return {projectId, version: harnessV0(target), provenance: {requestId: null, origin: 'baseline', evidence: null, cases: [], createdAt: null}};
  }

  listVersions(projectId: string, target: HarnessTarget): HarnessStoredVersion[] {
    scope(projectId, target);
    const result = [this.baseline(projectId, target)];
    const parents = new Map(result.map(r => [r.version.versionId, r.version]));
    for (const row of this.store.db.prepare('SELECT * FROM harness_versions WHERE project_id=? AND target=? ORDER BY rowid').all(projectId, target)) {
      try {
        if (typeof row.body !== 'string' || sha(row.body) !== row.body_digest) fail('HARNESS_INTEGRITY');
        const record = JSON.parse(row.body) as HarnessStoredVersion;
        safeInput(record);
        if (!exact(record, ['projectId', 'version', 'provenance'])) fail('HARNESS_INTEGRITY');
        const v = record.version, p = record.provenance;
        if (!exact(v, ['versionId', 'class', 'target', 'revision', 'lines', 'parentId', 'digest'])
          || !exact(p, ['requestId', 'origin', 'evidence', 'cases', 'createdAt'])
          || record.projectId !== projectId || v.target !== target || v.versionId !== row.version_id || !id(v.versionId)
          || p.requestId !== row.request_id || !id(p.requestId) || !timestamp(p.createdAt)) fail('HARNESS_INTEGRITY');
        const c: HarnessCandidate = {class: v.class, target: v.target, lines: v.lines, origin: p.origin as HarnessCandidate['origin'], evidence: p.evidence};
        candidateValid(c); renderOverlay(v);
        if (v.digest !== harnessDigest(v) || !v.parentId) fail('HARNESS_INTEGRITY');
        const parent = parents.get(v.parentId);
        if (!parent || v.revision !== parent.revision + 1 || v.lines.length <= parent.lines.length
          || !parent.lines.every((line, i) => v.lines[i] === line)) fail('HARNESS_INTEGRITY');
        this.validateCaseSnapshots(p.evidence, p.cases);
        if (row.request_digest !== this.appendDigest({projectId, requestId: p.requestId, parentId: v.parentId, candidate: c})) fail('HARNESS_INTEGRITY');
        parents.set(v.versionId, v); result.push(record);
      } catch {fail('HARNESS_INTEGRITY');}
    }
    return result;
  }

  getVersion(projectId: string, versionId: string): HarnessStoredVersion {
    scope(projectId); safeInput(versionId);
    if (!id(versionId)) fail('HARNESS_INVALID');
    for (const target of HARNESS_ALLOWED.execution_guidance) {
      if (versionId === harnessV0(target).versionId) return this.baseline(projectId, target);
    }
    const row = this.store.db.prepare('SELECT target FROM harness_versions WHERE project_id=? AND version_id=?').get(projectId, versionId);
    if (!row) fail('HARNESS_VERSION_NOT_FOUND');
    if (!targetValid(row.target)) fail('HARNESS_INTEGRITY');
    return this.listVersions(projectId, row.target).find(r => r.version.versionId === versionId) ?? fail('HARNESS_INTEGRITY');
  }

  private appendDigest(input: HarnessAppend): string {
    const {candidate: c} = input;
    return sha(JSON.stringify([input.projectId, input.requestId, input.parentId, c.class, c.target, c.lines,
      c.origin, c.evidence && [c.evidence.familyIds, c.evidence.caseIds, c.evidence.indexerVersion]]));
  }

  private validateCaseSnapshots(e: HarnessEvidence | null, cases: HarnessStoredVersion['provenance']['cases']): void {
    if (!Array.isArray(cases) || cases.length !== (e?.caseIds.length ?? 0)) fail('HARNESS_PROVENANCE');
    for (const [i, p] of cases.entries()) {
      if (!exact(p, PROVENANCE_KEYS) || !e || p.caseId !== e.caseIds[i] || !e.familyIds.includes(p.familyId)
        || p.indexerVersion !== e.indexerVersion || !SOURCE_TABLES.includes(p.sourceTable) || !id(p.recordId)
        || !digest(p.recordBodySha256) || !timestamp(p.createdAt)) fail('HARNESS_PROVENANCE');
    }
    if (e && !e.familyIds.every(f => cases.some(c => c.familyId === f))) fail('HARNESS_PROVENANCE');
  }

  append(input: HarnessAppend): HarnessStoredVersion {
    safeInput(input);
    if (!exact(input, APPEND_KEYS) || ![input.projectId, input.requestId, input.parentId].every(id)) fail('HARNESS_INVALID');
    candidateValid(input.candidate);
    return this.store.transaction(() => {
      const requestDigest = this.appendDigest(input);
      const prior = this.store.db.prepare('SELECT version_id,request_digest FROM harness_versions WHERE project_id=? AND request_id=?').get(input.projectId, input.requestId);
      if (prior) {
        if (prior.request_digest !== requestDigest) fail('HARNESS_REQUEST_CONFLICT');
        return this.getVersion(input.projectId, String(prior.version_id));
      }
      const parent = this.getVersion(input.projectId, input.parentId).version, c = input.candidate;
      if (parent.target !== c.target || parent.class !== c.class || c.lines.length <= parent.lines.length
        || !parent.lines.every((line, i) => c.lines[i] === line)) fail('HARNESS_APPEND_ONLY');
      const cases: HarnessStoredVersion['provenance']['cases'] = [];
      for (const caseId of c.evidence?.caseIds ?? []) {
        if (!this.ports.cases) fail('HARNESS_PROVENANCE');
        let record;
        try {record = this.ports.cases.getCase(caseId);} catch {fail('HARNESS_PROVENANCE');}
        if (record.id !== caseId) fail('HARNESS_PROVENANCE');
        const p = record.provenance;
        cases.push({caseId, familyId: record.familyId, sourceTable: p.sourceTable, recordId: p.recordId,
          recordBodySha256: p.recordBodySha256, indexerVersion: p.indexerVersion, createdAt: p.createdAt});
      }
      this.validateCaseSnapshots(c.evidence, cases);
      const version: HarnessVersion = {versionId: randomUUID(), class: c.class, target: c.target,
        revision: parent.revision + 1, lines: [...c.lines], parentId: parent.versionId, digest: harnessDigest(c)};
      renderOverlay(version);
      const record: HarnessStoredVersion = {projectId: input.projectId, version, provenance: {requestId: input.requestId,
        origin: c.origin, evidence: c.evidence === null ? null : {familyIds: [...c.evidence.familyIds], caseIds: [...c.evidence.caseIds], indexerVersion: c.evidence.indexerVersion},
        cases, createdAt: new Date().toISOString()}};
      safeInput(record);
      const body = JSON.stringify(record);
      this.store.db.prepare('INSERT INTO harness_versions VALUES(?,?,?,?,?,?,?)').run(version.versionId, input.projectId, c.target, input.requestId, requestDigest, body, sha(body));
      return record;
    });
  }

  history(projectId: string, target: HarnessTarget): HarnessPointerRecord[] {
    scope(projectId, target);
    const versions = new Map(this.listVersions(projectId, target).map(r => [r.version.versionId, r.version]));
    const events: HarnessPointerRecord[] = [];
    let current = harnessV0(target).versionId;
    for (const row of this.store.db.prepare('SELECT * FROM harness_pointer_history WHERE project_id=? AND target=? ORDER BY sequence').all(projectId, target)) {
      try {
        if (typeof row.body !== 'string' || sha(row.body) !== row.body_digest) fail('HARNESS_INTEGRITY');
        const event = JSON.parse(row.body) as HarnessPointerRecord, r = event.request;
        if (!exact(event, ['sequence', 'kind', 'request', 'createdAt']) || !['promotion', 'rollback'].includes(event.kind)) fail('HARNESS_INTEGRITY');
        pointerValid(r, event.kind);
        if (event.sequence !== events.length + 1 || event.sequence !== row.sequence || !timestamp(event.createdAt)
          || r.requestId !== row.request_id || r.projectId !== projectId || r.target !== target
          || r.expectedSequence !== events.length || r.fromVersionId !== current) fail('HARNESS_INTEGRITY');
        this.checkMove(r, event.kind, versions, events);
        current = r.versionId; events.push(event);
      } catch {fail('HARNESS_INTEGRITY');}
    }
    return events;
  }

  current(projectId: string, target: HarnessTarget): HarnessVersion {
    const last = this.history(projectId, target).at(-1);
    return last ? this.getVersion(projectId, last.request.versionId).version : harnessV0(target);
  }

  private checkMove(r: HarnessPromotionGrant | HarnessRollback, kind: HarnessPointerRecord['kind'], versions: Map<string, HarnessVersion>, history: HarnessPointerRecord[]): void {
    const version = versions.get(r.versionId), from = versions.get(r.fromVersionId);
    if (!version || !from) fail('HARNESS_VERSION_NOT_FOUND');
    if (kind === 'promotion') {
      if (version.parentId !== from.versionId || version.digest !== (r as HarnessPromotionGrant).candidateDigest) fail('HARNESS_PROMOTION_INVALID');
    } else {
      let parentId = from.parentId;
      while (parentId && parentId !== version.versionId) parentId = versions.get(parentId)?.parentId ?? null;
      if (!parentId || (version.revision !== 0 && !history.some(e => e.request.versionId === version.versionId))) fail('HARNESS_ROLLBACK_INVALID');
    }
  }

  promote(request: HarnessPromotionGrant): HarnessPointerRecord {return this.move(request, 'promotion');}
  rollback(request: HarnessRollback): HarnessPointerRecord {return this.move(request, 'rollback');}

  private move(request: HarnessPromotionGrant | HarnessRollback, kind: HarnessPointerRecord['kind']): HarnessPointerRecord {
    pointerValid(request, kind);
    return this.store.transaction(() => {
      const events = this.history(request.projectId, request.target);
      const prior = this.store.db.prepare('SELECT target FROM harness_pointer_history WHERE project_id=? AND request_id=?').get(request.projectId, request.requestId);
      if (prior) {
        const event = events.find(e => e.request.requestId === request.requestId);
        if (!event || event.kind !== kind || !sameRequest(event.request, request, kind)) fail('HARNESS_REQUEST_CONFLICT');
        return event;
      }
      const currentId = events.at(-1)?.request.versionId ?? harnessV0(request.target).versionId;
      if (request.expectedSequence !== events.length || request.fromVersionId !== currentId) fail('HARNESS_STALE_POINTER');
      const versions = new Map(this.listVersions(request.projectId, request.target).map(r => [r.version.versionId, r.version]));
      this.checkMove(request, kind, versions, events);
      if (kind === 'promotion') {
        const grant = this.ports.promotions?.getApprovedPromotion(request.requestId);
        if (!grant) fail('HARNESS_APPROVAL_REQUIRED');
        pointerValid(grant, 'promotion');
        if (!sameRequest(grant, request, kind)) fail('HARNESS_APPROVAL_REQUIRED');
      }
      const event: HarnessPointerRecord = {sequence: events.length + 1, kind, request: structuredClone(request), createdAt: new Date().toISOString()};
      const body = JSON.stringify(event);
      this.store.db.prepare('INSERT INTO harness_pointer_history VALUES(?,?,?,?,?,?)').run(request.projectId, request.target, event.sequence, request.requestId, body, sha(body));
      return event;
    });
  }
}
