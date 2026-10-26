import type { Execution } from './types.ts';
import type { CheckRecord } from './verification.ts';

export type PlanningExportFormat='json'|'markdown';
export type PlanningFeedbackCheck=Pick<CheckRecord,'id'|'commandId'|'configDigest'|'sourceDigest'|'finishedDigest'|'createdAt'|'completedAt'|'execution'|'verdict'|'exitCode'|'durationMs'>;
export interface PlanningFeedback {
  projectId:string;generatedAt:string;filename:string;markdown:string;
  planning:{id:string;revision:number;contentHash:string;state:'draft'|'approved'|'superseded';current:boolean};
  task:{id:string;requirementLabels:string[]};
  run:{id:string;workspaceId:string;execution:Execution;verification:'not_run'|'recorded';createdAt:string;updatedAt:string};
  verification:{available:boolean;sourceDigest:string|null;quarantined:boolean|null;canApprove:boolean;approvalCurrent:boolean;approvalId:string|null;checks:PlanningFeedbackCheck[]};
  changes:{available:boolean;baseSha:string|null;files:{path:string;status:string}[]};
}
