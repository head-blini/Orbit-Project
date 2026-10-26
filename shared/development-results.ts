import type {Run} from './types.ts';
import type {CheckRecord,VerificationCommandPreview} from './verification.ts';
import type {PlanningVersion} from './parallel.ts';

/** Read-only observations; these associations never grant execution or approval authority. */
export interface DevelopmentResultView {
  projectId:string;workspaceId:string;observedAt:string;sourceDigest:string|null;sourceIssue:string|null;
  run:Pick<Run,'id'|'execution'|'createdAt'|'updatedAt'>|null;
  task:{id:string;title:string;requirementLabels:string[]}|null;
  planning:{id:string;title:string;revision:number;contentHash:string;state:PlanningVersion['state'];current:boolean}|null;
  linkIssue:'TASK_LINK_UNAVAILABLE'|null;
  verification:null|{
    available:boolean;canApprove:boolean;approvalCurrent:boolean;quarantined:boolean;scope:string;
    commands:Pick<VerificationCommandPreview,'id'|'label'|'configDigest'>[];
    checks:Omit<CheckRecord,'requestId'|'output'>[];
  };
}
export interface DevelopmentSelection {workspaceId:string;runId:string}
