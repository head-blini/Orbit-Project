import type {Run} from './types.ts';
import type {CheckRecord} from './verification.ts';

/** Read-only manual transfer. Historical checks do not grant execution or approval. */
export interface HandoffPackage {
  projectId:string;taskId:string;sourceRunId:string|null;
  baseline:{planningVersionId:string;revision:number;contentHash:string;current:boolean};
  goal:string;constraints:string[];nonGoals:string[];
  decisions:{decision:string;rationale:string}[];
  requirements:{label:string;acceptanceCriteria:string[]}[];
  /** Latest references across the project, not a claim of task/run authorship. */
  artifacts:{id:string;title:string}[];
  verification:{execution:Run['execution']|null;checks:Pick<CheckRecord,'verdict'|'execution'>[]};
  openQuestions:string[];nextAction:string;
  /** Unknown: the empty placeholder is not permission to use any tool. */
  allowedTools:[];
  markdown:string;
}

/** Append-only delivery record. Digests and ids only: package text is never stored. */
export interface HandoffHistoryEntry {
  seq:number;at:string;runId:string;requestId:string;projectId:string;taskId:string;
  destination:'claude-code'|'codex';packageDigest:string;planningVersionId:string;planningContentHash:string;
  /** acknowledged only when the executor itself reported start for this run; never from a client claim. */
  receipt:'delivered'|'acknowledged';runExecution:Run['execution']|null;
}
