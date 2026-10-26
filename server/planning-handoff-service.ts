import type { Store } from './store.ts';
import { Studio,exact } from './studio.ts';
import { AppError } from './errors.ts';
import { containsCredential } from './privacy.ts';
import { inspectOutbound } from './guardrails/outbound.ts';
import { serializePlanningExport } from './planning/export.ts';
import type { PlanningVersion,SavedTask } from '../shared/parallel.ts';
import type { PlanningFeedback } from '../shared/planning-handoff.ts';
import type { VerificationView } from '../shared/verification.ts';
import type { WorkspaceDiff } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';

function safeContent(text:string){
  if(Buffer.byteLength(text,'utf8')>256*1024)throw new AppError('PLANNING_EXPORT_TOO_LARGE',413);
  if(containsCredential(text)||inspectOutbound(text).length)throw new AppError('PLANNING_EXPORT_BLOCKED',422);
}
function block(text:string,kind='json'){
  let length=3;for(const match of text.matchAll(/`+/g))length=Math.max(length,match[0].length+1);
  const fence='`'.repeat(length);
  return `${fence}${kind}\n${text}\n${fence}`;
}

/** Explicit local preview only. Never records questions, sends content or changes planning authority. */
export class PlanningHandoffService {
  private store:Store;private studio:Studio;
  private verification:(workspaceId:string,runId:string)=>VerificationView;
  private diff:(workspaceId:string)=>WorkspaceDiff;
  constructor(store:Store,verification:(workspaceId:string,runId:string)=>VerificationView,diff:(workspaceId:string)=>WorkspaceDiff){
    this.store=store;this.studio=new Studio(store);this.verification=verification;this.diff=diff;
  }
  create(projectId:string,data:Record<string,unknown>):PlanningFeedback{
    exact(data,['taskId','runId','question']);
    if(typeof data.taskId!=='string'||typeof data.runId!=='string'||![data.taskId,data.runId].every(id=>/^[a-f0-9-]{36}$/.test(id))
      ||typeof data.question!=='string'||data.question.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.question))throw new AppError('INVALID_FIELDS',400);
    const tasks=this.studio.read(projectId,'tasks') as SavedTask[],task=tasks.find(item=>item.id===data.taskId);
    if(!task)throw new AppError('TASK_NOT_FOUND',404);
    const plans=this.studio.read(projectId,'plans') as PlanningVersion[],plan=plans.find(item=>item.id===task.planningVersionId);
    const run=this.store.getRun(data.runId),workspace=this.store.workspaces().find(item=>item.id===run?.workspaceId);
    if(!plan||plan.projectId!==projectId||task.projectId!==projectId||!run||run.taskId!==task.id||run.planningVersionId!==plan.id||!workspace||workspace.projectId!==projectId)
      throw new AppError('FEEDBACK_CONTEXT_MISMATCH',409);
    safeContent(data.question);
    const planningText=serializePlanningExport(plan.draft,'json').text;
    safeContent(JSON.stringify(task.requirementLabels));
    const head=this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(plan.lineageId??plan.id);
    let verification:PlanningFeedback['verification']={available:false,sourceDigest:null,quarantined:null,canApprove:false,approvalCurrent:false,approvalId:null,checks:[]};
    if(terminal(run.execution))try{
      const view=this.verification(workspace.id,run.id);
      if(view.sourceIssue||view.workspaceId!==workspace.id||view.runId!==run.id||view.checks.length>100||view.checks.some(check=>check.projectId!==projectId||check.runId!==run.id||check.workspaceId!==workspace.id))throw new Error('EVIDENCE_UNAVAILABLE');
      verification={available:true,sourceDigest:view.sourceDigest,quarantined:view.quarantined,canApprove:view.canApprove,approvalCurrent:view.approvalCurrent,
        approvalId:view.approval?.id??null,checks:view.checks.map(({id,commandId,configDigest,sourceDigest,finishedDigest,createdAt,completedAt,execution,verdict,exitCode,durationMs})=>({id,commandId,configDigest,sourceDigest,finishedDigest,createdAt,completedAt,execution,verdict,exitCode,durationMs}))};
    }catch{/* A failed current-source read is unknown, never historical success. */}
    let changes:PlanningFeedback['changes']={available:false,baseSha:null,files:[]};
    try{
      const diff=this.diff(workspace.id);
      if(diff.workspaceId!==workspace.id||diff.files.length>200)throw new Error('CONTEXT_MISMATCH');
      changes={available:true,baseSha:diff.baseSha,files:diff.files.map(({path,status})=>({path,status}))};
    }catch{/* Do not include raw filesystem errors or partial diff as complete evidence. */}
    for(const check of verification.checks)safeContent(check.commandId);
    for(const file of changes.files)safeContent(file.path);
    const result:PlanningFeedback={projectId,generatedAt:new Date().toISOString(),filename:`orbit-feedback-${task.id}-${run.id}.md`,markdown:'',
      planning:{id:plan.id,revision:plan.revision,contentHash:plan.contentHash,state:plan.state,current:head?.version_id===plan.id},
      task:{id:task.id,requirementLabels:[...task.requirementLabels]},
      run:{id:run.id,workspaceId:workspace.id,execution:run.execution,verification:run.verification,createdAt:run.createdAt,updatedAt:run.updatedAt},verification,changes};
    const {markdown:_,filename:__,...evidence}=result;
    result.markdown=`# Orbit 기획 재검토 요청\n\n이 문서는 수동 인계용입니다. 외부 서비스로 자동 전송하지 않았습니다.\n에이전트 실행 완료와 실제 검증 통과는 다릅니다. 아래 상태는 생성 시점의 관찰이며 승인 권한을 부여하지 않습니다.\n\n## 참조 기획 (JSON v1)\n\n${block(planningText)}\n\n## 개발 증거\n\n${block(JSON.stringify(evidence,null,2))}\n\nchecks의 verdict/exitCode는 과거 실행 기록입니다. 현재 소스·설정의 승인 가능 여부는 canApprove, 실제 리뷰 승인의 현재성은 approvalCurrent로 구분합니다. available=false는 확인 불가입니다.\nchanges는 현재 작업 공간의 변경 파일 목록이며 이 Run이 모두 변경했다는 뜻은 아닙니다. diff와 검증 현재성은 별도로 조회하며 원자적 저장소 스냅샷이 아닙니다. 체크는 최대 100개입니다. 원문 코드·패치·명령·실행 로그·모델 응답은 포함하지 않습니다.\n\n## 사용자 재검토 질문\n\n${block(data.question||'추가 질문 없음','text')}\n\n## 다음 기획 요청\n\n기존 요구사항에서 유지할 것과 수정할 것을 구분하고, 변경 이유와 완료 조건을 적어주세요. 불확실한 사항은 미결정 질문으로 남겨주세요. 수정안은 JSON v1 또는 지원 Markdown의 새 초안으로 가져와 별도로 검토·승인합니다. 기존 승인·Task·Run은 자동 변경되지 않습니다.\n`;
    if(Buffer.byteLength(result.markdown,'utf8')>512*1024)throw new AppError('PLANNING_EXPORT_TOO_LARGE',413);
    return result;
  }
}
