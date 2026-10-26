import { createHash,randomUUID } from 'node:crypto';
import type { CheckRecord,VerificationApproval,VerificationView,VerificationCommandPreview } from '../shared/verification.ts';
import { terminal } from '../shared/types.ts';
import { Store } from './store.ts';
import type { Projects } from './projects.ts';
import { AppError } from './errors.ts';
import { validateVerificationCommand,runVerification } from './verification.ts';
import {AcceptanceService} from './acceptance.ts';

export {readVerificationConfiguration,verificationCommandPreviews,type VerificationConfiguration} from './verification-configuration.ts';
import {resolveVerificationCommands,type VerificationConfigurationSource,type VerificationCommandResolver} from './verification-configuration.ts';
type StartInput={requestId:string;runId:string;workspaceId:string;commandId:string;expectedSourceDigest:string;expectedConfigDigest:string};
type ApprovalInput={requestId:string;runId:string;workspaceId:string;expectedSourceDigest:string;expectedCheckSetDigest:string};
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope='Git 추적 파일과 무시되지 않은 파일의 실행 전후 일치만 검사합니다. ignored 의존성·외부 도구·중간 변경 후 원복은 증명하지 않습니다. 명령은 Codex sandbox 밖의 로컬 OS 권한으로 실행됩니다.';
function exact(value:object,keys:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new AppError('INVALID_FIELDS',400);
}

/** Host-approved commands only. This service does not add a process sandbox. */
export class VerificationService {
  readonly acceptance:AcceptanceService;
  private pending:{id:string;workspaceId:string;abort:AbortController;promise:Promise<void>}|null=null;
  private resolveCommands:VerificationCommandResolver;
  constructor(privateStore:Store,projects:Projects|undefined,configuration:VerificationConfigurationSource=[],agentBusy:()=>boolean=()=>false){
    this.store=privateStore;this.projects=projects;this.agentBusy=agentBusy;
    this.resolveCommands=resolveVerificationCommands(configuration);
    this.acceptance=new AcceptanceService(this.store,projects,path=>this.commands(path));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS verification_checks(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS verification_approvals(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);');
    for(const check of this.checks())if(check.execution==='running')this.save({...check,execution:'lost',verdict:'not_run',output:'VERIFICATION_INTERRUPTED_BY_RESTART',completedAt:new Date().toISOString()},'verification.lost');
  }
  private store:Store;private projects:Projects|undefined;private agentBusy:()=>boolean;
  get active(){return this.pending!==null;}
  private checks():CheckRecord[]{return this.store.db.prepare('SELECT body FROM verification_checks ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.body)));}
  private approvals():VerificationApproval[]{return this.store.db.prepare('SELECT body FROM verification_approvals ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.body)));}
  private save(check:CheckRecord,event:string){
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(check.id,check.requestId,JSON.stringify(check));this.store.markVerificationRecorded(check.runId);this.store.append(event,check.runId,{checkId:check.id,workspaceId:check.workspaceId});});
  }
  private context(workspaceId:string,runId:string|null){
    if(!this.projects)throw new AppError('VERIFICATION_UNAVAILABLE',404);
    const workspace=this.projects.writable(workspaceId);
    const project=this.projects.list().find(project=>project.id===workspace.projectId);
    if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    const run=runId?this.store.getRun(runId):null;
    if(runId&&(!run||run.workspaceId!==workspaceId||!terminal(run.execution)))throw new AppError('VERIFICATION_RUN_NOT_TERMINAL',409);
    return {workspace,project,run};
  }
  private commands(projectPath:string):VerificationCommandPreview[]{return this.resolveCommands(projectPath);}
  private fingerprint(workspaceId:string){return this.projects!.fingerprint(workspaceId);}
  ensureAvailable(workspaceId?:string){
    if(this.pending)throw new AppError('VERIFICATION_ACTIVE',409);
    if(workspaceId&&this.checks().some(check=>check.workspaceId===workspaceId&&check.execution==='lost'&&!check.recoveredAt))throw new AppError('VERIFICATION_RECOVERY_REQUIRED',409);
  }
  view(workspaceId:string,runId:string|null):VerificationView{
    const {project,workspace,run}=this.context(workspaceId,runId),commands=this.commands(project.path);
    const acceptance=runId?this.acceptance.status(workspaceId,runId):undefined;
    const all=this.checks().filter(check=>check.workspaceId===workspaceId),checks=all.filter(check=>check.runId===runId);
    const quarantined=all.some(check=>check.execution==='lost'&&!check.recoveredAt);
    let sourceDigest:string|null=null,sourceIssue:string|null=null;
    if(commands.length)try{sourceDigest=this.fingerprint(workspaceId);}catch{sourceIssue='FINGERPRINT_UNAVAILABLE';}
    const latest=commands.map(command=>checks.find(check=>check.commandId===command.id));
    const canApprove=!!runId&&run?.execution!=='lost'&&!!sourceDigest&&commands.length>0&&!quarantined&&!this.pending&&!this.agentBusy()&&(!acceptance||['unbound','current'].includes(acceptance.state))&&latest.every((check,index)=>check&&check.execution==='completed'&&check.verdict==='passed'&&check.exitCode===0&&check.baseSha===workspace.baseSha&&check.configDigest===commands[index].configDigest&&check.sourceDigest===sourceDigest&&check.finishedDigest===sourceDigest&&check.acceptanceDigest===run?.acceptanceDigest);
    const checkSetDigest=canApprove?hash({sourceDigest,checks:latest.map(check=>({id:check!.id,configDigest:check!.configDigest}))}):null;
    const approval=this.approvals().find(item=>item.workspaceId===workspaceId&&item.runId===runId)??null;
    return {workspaceId,runId,commands,sourceDigest,sourceIssue,checks:checks.slice(0,100),quarantined,checkSetDigest,canApprove,approval,approvalCurrent:!!approval&&canApprove&&approval.sourceDigest===sourceDigest&&approval.checkSetDigest===checkSetDigest,scope,...(acceptance?{acceptance}:{})};
  }
  start(input:StartInput):CheckRecord{
    exact(input,['requestId','runId','workspaceId','commandId','expectedSourceDigest','expectedConfigDigest']);
    if(![input.requestId,input.runId,input.workspaceId,input.commandId].every(id)||!digest(input.expectedSourceDigest)||!digest(input.expectedConfigDigest))throw new AppError('INVALID_FIELDS',400);
    const prior=this.checks().find(check=>check.requestId===input.requestId);
    if(prior){
      if(prior.runId!==input.runId||prior.workspaceId!==input.workspaceId||prior.commandId!==input.commandId||prior.configDigest!==input.expectedConfigDigest||prior.sourceDigest!==input.expectedSourceDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);
      return prior;
    }
    if(this.agentBusy())throw new AppError('RUN_ACTIVE',409);this.ensureAvailable(input.workspaceId);
    const {workspace,project,run}=this.context(input.workspaceId,input.runId),command=this.commands(project.path).find(command=>command.id===input.commandId);
    if(run?.execution==='lost')throw new AppError('VERIFICATION_RECOVERY_REQUIRED',409);
    this.assertAcceptance(workspace.id,input.runId);
    if(!command)throw new AppError('VERIFICATION_COMMAND_NOT_FOUND',404);
    if(command.configDigest!==input.expectedConfigDigest||this.fingerprint(workspace.id)!==input.expectedSourceDigest)throw new AppError('VERIFICATION_PREVIEW_STALE',409);
    const {configDigest,protectedFiles:_,...preview}=command,validated=validateVerificationCommand(preview);
    const check:CheckRecord={id:randomUUID(),requestId:input.requestId,runId:input.runId,projectId:workspace.projectId,workspaceId:workspace.id,commandId:command.id,configDigest,baseSha:workspace.baseSha,sourceDigest:input.expectedSourceDigest,finishedDigest:null,createdAt:new Date().toISOString(),completedAt:null,execution:'running',verdict:'not_run',exitCode:null,durationMs:null,output:'',recoveredAt:null,...(run?.acceptanceDigest?{acceptanceDigest:run.acceptanceDigest}:{})};
    this.save(check,'verification.started');
    const abort=new AbortController();
    const promise=Promise.resolve().then(async()=>{
      try{
        const result=await runVerification(validated,{workspaceId:workspace.id,cwd:workspace.path,baseSha:workspace.baseSha,fingerprint:()=>{
          this.assertAcceptance(workspace.id,input.runId);
          const current=this.fingerprint(workspace.id);
          if(current!==check.sourceDigest)throw new Error('VERIFICATION_PREVIEW_STALE');
          return current;
        },signal:abort.signal});
        // The runner must start against the exact source the human approved.
        const verdict=result.sourceDigest===check.sourceDigest?result.status:'stale';
        this.save({...check,execution:'completed',verdict,finishedDigest:result.finishedDigest,exitCode:result.exitCode,durationMs:result.durationMs,output:result.output,completedAt:new Date().toISOString()},'verification.completed');
      }catch{this.save({...check,execution:'completed',verdict:'failed',output:'VERIFICATION_FAILED',completedAt:new Date().toISOString()},'verification.completed');}
    }).finally(()=>{if(this.pending?.id===check.id)this.pending=null;});
    this.pending={id:check.id,workspaceId:workspace.id,abort,promise};
    return check;
  }
  private assertAcceptance(workspaceId:string,runId:string){
    const status=this.acceptance.status(workspaceId,runId);
    if(status.state!=='unbound'&&status.state!=='current')throw new AppError('ACCEPTANCE_BASELINE_CHANGED',409);
  }
  interrupt(workspaceId:string,checkId:string){
    const check=this.checks().find(check=>check.id===checkId&&check.workspaceId===workspaceId);if(!check)throw new AppError('CHECK_NOT_FOUND',404);
    if(check.execution!=='running')return;
    if(this.pending?.id!==checkId)throw new AppError('VERIFICATION_RECOVERY_REQUIRED',409);
    this.pending.abort.abort();
  }
  acknowledgeStopped(workspaceId:string,checkId:string){
    const check=this.checks().find(check=>check.id===checkId&&check.workspaceId===workspaceId);if(!check)throw new AppError('CHECK_NOT_FOUND',404);
    if(check.execution!=='lost')throw new AppError('CHECK_NOT_LOST',409);
    if(!check.recoveredAt)this.save({...check,recoveredAt:new Date().toISOString()},'verification.recovery_confirmed');
  }
  approve(input:ApprovalInput):VerificationApproval{
    exact(input,['requestId','runId','workspaceId','expectedSourceDigest','expectedCheckSetDigest']);
    if(![input.requestId,input.runId,input.workspaceId].every(id)||!digest(input.expectedSourceDigest)||!digest(input.expectedCheckSetDigest))throw new AppError('INVALID_FIELDS',400);
    const prior=this.approvals().find(item=>item.requestId===input.requestId);
    if(prior){if(prior.runId!==input.runId||prior.workspaceId!==input.workspaceId||prior.sourceDigest!==input.expectedSourceDigest||prior.checkSetDigest!==input.expectedCheckSetDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return prior;}
    const view=this.view(input.workspaceId,input.runId);
    if(!view.canApprove||view.sourceDigest!==input.expectedSourceDigest||view.checkSetDigest!==input.expectedCheckSetDigest)throw new AppError('VERIFICATION_REQUIRED',409);
    const approval:VerificationApproval={id:randomUUID(),requestId:input.requestId,runId:input.runId,workspaceId:input.workspaceId,sourceDigest:input.expectedSourceDigest,checkSetDigest:input.expectedCheckSetDigest,createdAt:new Date().toISOString()};
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO verification_approvals VALUES(?,?,?)').run(approval.id,approval.requestId,JSON.stringify(approval));this.store.append('verification.approved',input.runId,{approvalId:approval.id,workspaceId:input.workspaceId});});return approval;
  }
  async settle(){await this.pending?.promise;}
  async close(){this.pending?.abort.abort();await this.settle();}
}
