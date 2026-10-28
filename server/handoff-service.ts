import type {HandoffPackage} from '../shared/handoff.ts';
import type {ArtifactRecord,PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {CheckRecord} from '../shared/verification.ts';
import type {Store} from './store.ts';
import {Studio} from './studio.ts';
import {AppError} from './errors.ts';
import {safeText} from './privacy.ts';
import {validatePlanningVersion} from './planning/comparison.ts';
import {handoffBlock} from './planning-handoff-service.ts';

// Transfer references by ID. Conservatively omit path-like tokens, including
// project-local paths, so a prose field cannot disclose an external location.
function transferText(text:string):string {
  return safeText(text).replace(/(?:file:\/\/|[A-Za-z]:[\\/]|~[\\/]|\.\.[\\/]|\/|\\\\)[^\s<>"'`]+/gu,'[PATH REDACTED]');
}
function markdown(value:Omit<HandoffPackage,'markdown'>):string {
  const text=JSON.stringify(value,null,2);
  return `# Orbit 작업 인계\n\n수동 전달용 읽기 전용 기록입니다. 실행 완료와 검증 통과, 사용자 승인은 별개입니다.\nchecks는 저장된 과거 판정이며 현재 소스의 검증·승인을 뜻하지 않습니다.\nartifacts는 프로젝트 결과물 참조이며 이 작업이 생성했다는 뜻은 아닙니다.\nallowedTools: []는 허용 도구를 확인하지 못했다는 뜻이며 실행 권한을 부여하지 않습니다.\n\n${handoffBlock(text)}\n`;
}

/** Reads stored records only: no verification probes, filesystem access or events. */
export class HandoffService {
  private store:Store;private studio:Studio;
  constructor(store:Store,studio:Studio){this.store=store;this.studio=studio;}
  build(projectId:string,taskId:string):HandoffPackage {
    const task=(this.studio.read(projectId,'tasks') as SavedTask[]).find(task=>task.id===taskId);
    if(!task)throw new AppError('TASK_NOT_FOUND',404);
    const plan=(this.studio.read(projectId,'plans') as PlanningVersion[]).find(plan=>plan.id===task.planningVersionId);
    if(!plan)throw new AppError('VERSION_NOT_FOUND',404);
    validatePlanningVersion(plan);
    if(task.projectId!==projectId||plan.projectId!==projectId
      ||!plan.approvedAt||!plan.approvedBy||!['approved','superseded'].includes(plan.state))throw new AppError('HANDOFF_CONTEXT_MISMATCH',409);
    const requirements=plan.draft.requirements.filter(requirement=>task.requirementLabels.includes(requirement.label));
    if(task.requirementLabels.length!==1||requirements.length!==1
      ||task.description!==requirements[0].description||JSON.stringify(task.acceptanceCriteria)!==JSON.stringify(requirements[0].acceptanceCriteria))throw new AppError('HANDOFF_CONTEXT_MISMATCH',409);
    const head=this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(plan.lineageId??plan.id);
    const current=plan.state==='approved'&&head?.version_id===plan.id;
    const run=this.store.runs().filter(run=>run.taskId===task.id).at(-1);
    if(run&&(run.planningVersionId!==plan.id||(run.planningContentHash!==undefined&&run.planningContentHash!==plan.contentHash)
      ||(run.workspaceId!==undefined&&!this.store.workspaces().some(workspace=>workspace.id===run.workspaceId&&workspace.projectId===projectId))
      ||!['starting','running','interrupting','completed','interrupted','failed','lost'].includes(run.execution)))throw new AppError('HANDOFF_CONTEXT_MISMATCH',409);
    let checks:HandoffPackage['verification']['checks']=[];
    // VerificationService construction performs recovery writes. Do not instantiate
    // it for a GET or call view(), which inspects the current code workspace.
    if(run&&this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verification_checks'").get()){
      const records=this.store.db.prepare('SELECT body FROM verification_checks ORDER BY rowid').all().map(row=>JSON.parse(row.body as string) as CheckRecord);
      checks=records.filter(check=>check.projectId===projectId&&check.runId===run.id&&check.workspaceId===run.workspaceId).map(check=>{
        if(!['running','completed','lost'].includes(check.execution)||!['not_run','passed','failed','interrupted','timed_out','stale'].includes(check.verdict))throw new AppError('HANDOFF_CONTEXT_MISMATCH',409);
        return {verdict:check.verdict,execution:check.execution};
      });
    }
    const nextAction=!current?'현재 승인 기준을 검토하고 작업을 새 기준에 연결한 뒤 실행 여부를 결정하세요.':
      plan.draft.openQuestions.length?'미해결 질문을 검토하고 필요한 기준 변경을 별도로 승인하세요.':
      !run?'승인된 작업과 허용 도구를 검토한 뒤 실행을 요청하세요.':
      ['starting','running','interrupting'].includes(run.execution)?'진행 중 실행의 상태를 확인하세요. 중복 실행하지 마세요.':
      run.execution==='lost'?'실행 종료 여부와 복구 상태를 확인한 뒤 다음 작업을 결정하세요.':
      '결과물과 저장된 검증 기록을 검토하고 필요한 검증 또는 후속 작업을 결정하세요.';
    const result:Omit<HandoffPackage,'markdown'>={projectId,taskId,sourceRunId:run?.id??null,
      baseline:{planningVersionId:plan.id,revision:plan.revision,contentHash:plan.contentHash,current},
      goal:transferText(plan.draft.goal),constraints:plan.draft.constraints.map(transferText),nonGoals:(plan.draft.nonGoals??[]).map(transferText),
      decisions:(plan.draft.decisions??[]).map(({decision,rationale})=>({decision:transferText(decision),rationale:transferText(rationale)})),
      requirements:requirements.map(({label,acceptanceCriteria})=>({label,acceptanceCriteria:acceptanceCriteria.map(transferText)})),
      artifacts:(this.studio.read(projectId,'artifacts') as ArtifactRecord[]).map(artifact=>({id:artifact.id,title:transferText(artifact.metadata.title??artifact.kind)})),
      verification:{execution:run?.execution??null,checks},openQuestions:plan.draft.openQuestions.map(transferText),nextAction,allowedTools:[]};
    return {...result,markdown:markdown(result)};
  }
}
