import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningVersion, TaskDraft } from '../../shared/parallel.ts';
import { parsePlanningDraft } from './parser.ts';
import { planningApprovalIssues } from './brief.ts';
import type { PlanningInput } from './parser.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface PlanningRepository {
  create(projectId: string, input: PlanningInput): PlanningVersion;
  revise(projectId: string, versionId: string, expectedRevision: number, input: PlanningInput): PlanningVersion;
  approve(projectId: string, versionId: string, expectedRevision: number): PlanningVersion;
  list(projectId: string): PlanningVersion[];
  toTasks(projectId: string, versionId: string): TaskDraft[];
}

/** SQLite mutations are called inside the host Store.transaction (including audit/receipts). */
export class SqlitePlanningRepository implements PlanningRepository {
  private db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;}
  create(projectId:string,input:PlanningInput):PlanningVersion {
    const version=new InMemoryPlanningRepository().create(projectId,input);
    version.lineageId=version.id;version.createdAt=new Date().toISOString();
    this.db.prepare('INSERT INTO planning_versions VALUES(?,?,?,?,?)').run(version.id,projectId,version.lineageId,JSON.stringify(version),JSON.stringify(input));
    this.db.prepare('INSERT INTO planning_heads VALUES(?,?)').run(version.lineageId,version.id);
    return version;
  }
  private get(projectId:string,id:string):PlanningVersion {
    validateId(projectId);validateId(id);
    const row=this.db.prepare('SELECT body FROM planning_versions WHERE id=? AND project_id=?').get(id,projectId);
    if(!row)throw new PlanningError('VERSION_NOT_FOUND');return JSON.parse(row.body as string);
  }
  private current(projectId:string,id:string,revision:number):PlanningVersion {
    const version=this.get(projectId,id);
    const head=this.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(version.lineageId!);
    if(!Number.isSafeInteger(revision)||revision!==version.revision||head?.version_id!==id)throw new PlanningError('REVISION_CONFLICT');
    return version;
  }
  revise(projectId:string,id:string,revision:number,input:PlanningInput):PlanningVersion {
    const previous=this.current(projectId,id,revision);
    const next=new InMemoryPlanningRepository().create(projectId,input);
    next.revision=previous.revision+1;next.lineageId=previous.lineageId;next.createdAt=new Date().toISOString();
    if(previous.state==='draft'){
      previous.state='superseded';this.db.prepare('UPDATE planning_versions SET body=? WHERE id=?').run(JSON.stringify(previous),id);
    }
    this.db.prepare('INSERT INTO planning_versions VALUES(?,?,?,?,?)').run(next.id,projectId,next.lineageId!,JSON.stringify(next),JSON.stringify(input));
    this.db.prepare('UPDATE planning_heads SET version_id=? WHERE lineage_id=?').run(next.id,next.lineageId!);
    return next;
  }
  approve(projectId:string,id:string,revision:number,actor='local-user'):PlanningVersion {
    const version=this.current(projectId,id,revision);const issues=planningApprovalIssues(version.draft);
    if(issues.length)throw new PlanningError('INCOMPLETE_DRAFT',issues);
    version.state='approved';version.approvedAt??=new Date().toISOString();version.approvedBy??=actor;
    this.db.prepare('UPDATE planning_versions SET body=? WHERE id=?').run(JSON.stringify(version),id);
    return version;
  }
  list(projectId:string):PlanningVersion[]{
    validateId(projectId);return this.db.prepare('SELECT body FROM planning_versions WHERE project_id=? ORDER BY rowid').all(projectId).map(row=>JSON.parse(row.body as string));
  }
  toTasks(projectId:string,id:string):TaskDraft[]{return toTaskDrafts(snapshot(this.get(projectId,id)));}
}

export class PlanningError extends Error {
  readonly code: string;
  readonly issues: { field: string; code: string }[];
  constructor(code: string, issues: { field: string; code: string }[] = []) {
    super(code); this.name = 'PlanningError'; this.code = code; this.issues = structuredClone(issues);
  }
}

// Only server-returned snapshots are eligible. Client JSON and modified objects are never authority.
const snapshots = new WeakMap<PlanningVersion, PlanningVersion>();
function snapshot(version: PlanningVersion): PlanningVersion {
  const result = structuredClone(version);
  snapshots.set(result, structuredClone(version));
  return result;
}

export function toTaskDrafts(version: PlanningVersion): TaskDraft[] {
  const trusted = snapshots.get(version);
  if (!trusted || !isDeepStrictEqual(version, trusted)) throw new PlanningError('UNTRUSTED_VERSION');
  if (trusted.state !== 'approved') throw new PlanningError('NOT_APPROVED');
  return trusted.draft.requirements.map(requirement => ({
    title: `${requirement.label}: ${requirement.description.split('\n')[0]}`,
    description: requirement.description, acceptanceCriteria: [...requirement.acceptanceCriteria],
    planningVersionId: trusted.id, requirementLabels: [requirement.label],
  }));
}

function validateId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new PlanningError('INVALID_ID');
}

interface StoredVersion {
  version: PlanningVersion;
  lineageId: string;
  originalInput: PlanningInput;
  createdAt: string;
  approvedAt?: string;
}

/** Synchronous in-memory implementation; integration must supply durable storage and project authorization. */
export class InMemoryPlanningRepository implements PlanningRepository {
  #records = new Map<string, StoredVersion>();
  #heads = new Map<string, string>();

  create(projectId: string, input: PlanningInput): PlanningVersion {
    validateId(projectId);
    const record = this.#prepare(projectId, 1, input);
    this.#records.set(record.version.id, record);
    this.#heads.set(record.lineageId, record.version.id);
    return snapshot(record.version);
  }

  revise(projectId: string, versionId: string, expectedRevision: number, input: PlanningInput): PlanningVersion {
    const previous = this.#current(projectId, versionId, expectedRevision);
    const next = this.#prepare(projectId, previous.version.revision + 1, input, previous.lineageId);
    // Keep prior approval evidence. A draft superseded by a new revision is no longer approvable.
    if (previous.version.state === 'draft') previous.version.state = 'superseded';
    this.#records.set(next.version.id, next);
    this.#heads.set(next.lineageId, next.version.id);
    return snapshot(next.version);
  }

  approve(projectId: string, versionId: string, expectedRevision: number): PlanningVersion {
    const record = this.#current(projectId, versionId, expectedRevision);
    const issues = planningApprovalIssues(record.version.draft);
    if (issues.length) throw new PlanningError('INCOMPLETE_DRAFT', issues);
    record.version.state = 'approved';
    record.approvedAt ??= new Date().toISOString();
    return snapshot(record.version);
  }

  list(projectId: string): PlanningVersion[] {
    validateId(projectId);
    return [...this.#records.values()].filter(record => record.version.projectId === projectId).map(record => snapshot(record.version));
  }

  toTasks(projectId: string, versionId: string): TaskDraft[] {
    return toTaskDrafts(snapshot(this.#get(projectId, versionId).version));
  }

  #get(projectId: string, versionId: string): StoredVersion {
    validateId(projectId); validateId(versionId);
    const record = this.#records.get(versionId);
    if (!record || record.version.projectId !== projectId) throw new PlanningError('VERSION_NOT_FOUND');
    return record;
  }

  #current(projectId: string, versionId: string, expectedRevision: number): StoredVersion {
    const record = this.#get(projectId, versionId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== record.version.revision
      || this.#heads.get(record.lineageId) !== versionId) throw new PlanningError('REVISION_CONFLICT');
    return record;
  }

  #prepare(projectId: string, revision: number, input: PlanningInput, lineageId?: string): StoredVersion {
    const parsed = parsePlanningDraft(input);
    if (!parsed.ok) throw new PlanningError('INVALID_DRAFT', parsed.issues);
    const id = randomUUID();
    const version: PlanningVersion = { id, projectId, revision,
      contentHash: createHash('sha256').update(JSON.stringify(parsed.draft)).digest('hex'),
      state: 'draft', draft: parsed.draft };
    return { version, lineageId: lineageId ?? id, originalInput: structuredClone(input), createdAt: new Date().toISOString() };
  }
}
