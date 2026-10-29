import {assertWorkerOwnership,type WorkerDispatchContext} from './worker-scheduler.ts';
import {SubscriptionUsageStore} from './subscription-usage.ts';
import {normalizeClaudeSubscriptionUsage} from './usage.ts';
import {createHash} from 'node:crypto';
import type {Run} from '../shared/types.ts';
import {terminal} from '../shared/types.ts';
import type {SavedTask} from '../shared/parallel.ts';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import {Studio} from './studio.ts';
import {generalAcceptance} from './acceptance.ts';
import {HandoffService} from './handoff-service.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {briefPiiInspectionText} from './planning/execution.ts';
import {repairPiiInspectionText} from './repair-pii.ts';
import {ClaudeCodeRun,findClaude,claudeEnv,type ClaudeEvent,type ClaudeOutcome} from './runtimes/claude-code.ts';
import {claudeTaskPrompt,executionForClaudeOutcome} from './runtimes/claude-task.ts';
import {nativeModelId} from './runtimes/model-identity.ts';
import {listMaterials} from './materials.ts';
import {ProjectAiPreferencesService} from './project-ai-preferences.ts';
import {HarnessStore} from './harness-store.ts';
import {classifyHarnessCandidate,harnessDigest} from './harness-policy.ts';
import {renderOverlay,type HarnessTarget,type HarnessVersion} from '../shared/harness.ts';

type Runner=Pick<ClaudeCodeRun,'start'|'interrupt'>;
type Quota=Extract<ClaudeEvent,{kind:'quota'}>;
export interface ClaudeTaskServiceOptions {
  findExecutable?:()=>string;
  runnerFactory?:(options:{executable:string;cwd:string;mode:'write';env:NodeJS.ProcessEnv;beforeDispatch:()=>void})=>Runner;
  /** HE-5a pointer reader; defaults to the durable HarnessStore. */
  harness?:Pick<HarnessStore,'current'>;
}
type Active={runner:Runner;done:Promise<void>};

/** HE-5a: the promoted pointer only, re-checked against AX06 at injection. Anything unreadable or unsafe refuses
 * dispatch: HE-D1 names a silent v0 fallback only for the Codex length bound, so Claude fails closed. */
function activeHarness(harness:Pick<HarnessStore,'current'>,projectId:string,target:HarnessTarget):{version:HarnessVersion;overlay:string}{
  let version:HarnessVersion,overlay:string;
  try{version=harness.current(projectId,target);overlay=renderOverlay(version);}
  catch(error){throw new AppError(error instanceof AppError&&/^HARNESS_[A-Z_]+$/.test(error.message)?error.message:'HARNESS_INTEGRITY',409);}
  if(version.target!==target||version.class!=='execution_guidance'||version.digest!==harnessDigest(version))throw new AppError('HARNESS_INTEGRITY',409);
  if(version.revision>0){
    const verdict=classifyHarnessCandidate({class:version.class,target,lines:version.lines,origin:'user',evidence:null});
    if(verdict.status==='blocked')throw new AppError(verdict.reasons[0],409);
    if(containsCredential(overlay)||outboundDenial(overlay))throw new AppError('HARNESS_UNSAFE_TEXT',409);
  }
  return {version,overlay};
}

/** One owner per saved task; native execution remains entirely in ClaudeCodeRun. */
export class ClaudeTaskService {
  readonly subscriptionUsage:SubscriptionUsageStore;
  private store:Store;private projects?:Projects;private options:ClaudeTaskServiceOptions;
  private active=new Map<string,Active>();private latestQuota:Quota|null=null;private closing=false;private harness:Pick<HarnessStore,'current'>;
  constructor(store:Store,projects?:Projects,options:ClaudeTaskServiceOptions={},subscriptionUsage=new SubscriptionUsageStore(store)){this.subscriptionUsage=subscriptionUsage;this.store=store;this.projects=projects;this.options=options;this.harness=options.harness??new HarnessStore(store);}
  quota():Quota|null{return this.latestQuota?structuredClone(this.latestQuota):null;}
  submit(projectId:string,taskId:string,requestId:string,worker?:WorkerDispatchContext):Run {
    return this.dispatch(projectId,taskId,requestId,undefined,worker);
  }
  /** Internal Quality Loop repair path; callers retain the Controller's global execution gates. */
  repair(sourceRunId:string,requestId:string,prompt:string):Run {
    const source=this.store.getRun(sourceRunId);
    if(!source||!source.projectId||!source.taskId||source.execution!=='completed')throw new AppError('QUALITY_SOURCE_INVALID',409);
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>32000)throw new AppError('INVALID_REPAIR_INPUT',400);
    return this.dispatch(source.projectId,source.taskId,requestId,{source,prompt});
  }
  private dispatch(projectId:string,taskId:string,requestId:string,repair?:{source:Run;prompt:string},worker?:WorkerDispatchContext):Run {
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw new AppError('INVALID_REQUEST_ID',400);
    const repairDigest=repair?createHash('sha256').update(JSON.stringify({sourceRunId:repair.source.id,prompt:repair.prompt})).digest('hex'):null;
    const prior=this.store.findRequest(requestId);
    if(prior){
      if(prior.run.runtime!=='claude-code'||prior.run.projectId!==projectId||prior.run.taskId!==taskId||repairDigest&&prior.digest!==repairDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);
      return prior.run;
    }
    assertWorkerOwnership(this.store,projectId,taskId,worker);
    const runs=this.store.runs().filter(run=>run.taskId===taskId);
    // One writer per project folder: tasks of the same general project run one at a time.
    // Lost is not proof of process exit. Only verified PW-3 spaces narrow folder ownership.
    const isolated=(run:Run)=>!!this.store.db.prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.worker_space'").get(run.id);
    const conflicts=this.store.runs().filter(run=>run.runtime==='claude-code'&&run.projectId===projectId&&!isolated(run));
    // Worker spaces live under the project folder, so a non-isolated run there can still reach them: it blocks workers too.
    if(runs.some(run=>!terminal(run.execution))||conflicts.some(run=>!terminal(run.execution)))throw new AppError('RUN_ACTIVE',409);
    if(runs.some(run=>run.execution==='lost')||conflicts.some(run=>run.execution==='lost'))throw new AppError('SOLO_RECOVERY_REQUIRED',409);
    worker?.beforeDispatch();
    if(this.closing)throw new AppError('SESSION_BUSY',409);
    if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
    const project=this.projects.generalProject(projectId),studio=new Studio(this.store);
    const brief=studio.execution(projectId,taskId),handoff=new HandoffService(this.store,studio).build(projectId,taskId);
    if(repair&&(repair.source.planningVersionId!==brief.planningVersionId||repair.source.planningContentHash!==brief.planningContentHash))throw new AppError('QUALITY_BASELINE_CHANGED',409);
    const task=(studio.read(projectId,'tasks') as SavedTask[]).find(task=>task.id===taskId)!;
    const acceptance=generalAcceptance(this.store,projectId,taskId);
    const acceptanceSame=()=>{try{return generalAcceptance(this.store,projectId,taskId).digest===acceptance.digest;}catch{return false;}};
    // Same input gate as Codex runs (Controller.start), applied to the same raw execution brief:
    // block instead of silently redacting, and audit the denial.
    const raw=brief.prompt+'\n'+task.title+(repair?'\n'+repair.prompt:'');
    const inspected=briefPiiInspectionText(brief.prompt+'\n'+task.title)+(repair?'\n'+repairPiiInspectionText(repair.prompt):'');
    const denial=containsCredential(raw)?'CREDENTIAL_LIKE_INPUT':outboundDenial(inspected);
    if(denial){this.store.append('guardrail.denied',null,{providerId:'claude-code',code:denial});throw new AppError(denial,400);}
    const harness=[activeHarness(this.harness,projectId,'claude_task'),...(repair?[activeHarness(this.harness,projectId,'repair')]:[])];
    const harnessSame=()=>{try{return harness.every(({version})=>{const now=this.harness.current(projectId,version.target);return now.versionId===version.versionId&&now.digest===version.digest;});}catch{return false;}};
    const prompt=claudeTaskPrompt({title:task.title,goal:handoff.goal,baseline:handoff.baseline,
      acceptanceCriteria:handoff.requirements.flatMap(requirement=>requirement.acceptanceCriteria),
      constraints:handoff.constraints,nonGoals:handoff.nonGoals,decisions:handoff.decisions,deliverable:`${worker?'output/':''}task-${taskId.slice(0,8)}.md`,materials:listMaterials(worker?.space.path??project.path).map(item=>item.path),harness:harness[0].version})+(repair?'\n품질 검증에서 실패한 항목만 수정하세요. 기존 통과 항목과 승인 기준은 보존하세요.\n'+(harness[1].overlay?harness[1].overlay+'\n':'')+repair.prompt:'');
    const executable=(this.options.findExecutable??findClaude)();
    // No await between ownership checks, durable intent and launch.
    worker?.beforeDispatch();
    const run=this.store.createRun(requestId,repairDigest??createHash('sha256').update(prompt).digest('hex'),prompt,undefined,
      {runtime:'claude-code',projectId,taskId,planningVersionId:brief.planningVersionId,planningContentHash:brief.planningContentHash,requirementLabels:brief.requirementLabels},undefined,acceptance);
    let runner:Runner;
    try{
      if(worker)this.store.append('run.worker_space',run.id,{reservationId:worker.fence.reservationId,path:worker.space.path});
      for(const {version} of harness)this.store.append('harness.applied',run.id,{target:version.target,versionId:version.versionId,revision:version.revision,digest:version.digest});
      this.store.append('run.runtime_source',run.id,{source:this.options.runnerFactory?'mock':'native',interface:'claude.print'});
      if(repair)this.store.append('run.repair_source',run.id,{sourceRunId:repair.source.id,planningVersionId:brief.planningVersionId,planningContentHash:brief.planningContentHash});
      // Revalidate after synchronous Store observers, immediately before launch.
      this.projects.generalProject(projectId);
      runner=(this.options.runnerFactory??(options=>new ClaudeCodeRun(options)))({executable,cwd:worker?.space.path??project.path,mode:'write',env:claudeEnv(),beforeDispatch:()=>{
        this.projects!.generalProject(projectId);
        worker?.beforeDispatch();
        if(this.closing||new ProjectAiPreferencesService(this.store).read(projectId).execution!=='claude-code'||JSON.stringify(studio.execution(projectId,taskId))!==JSON.stringify(brief)||!acceptanceSame()||!harnessSame())throw new AppError('LAUNCH_CONTEXT_CHANGED',409);
      }});
    }catch{
      return this.store.updateRun(run.id,{execution:'failed'},'run.failed',{reason:'RUNTIME_NOT_STARTED'});
    }
    const active:Active={runner,done:Promise.resolve()};this.active.set(run.id,active);
    active.done=this.execute(run.id,runner).finally(()=>{this.subscriptionUsage.disconnect('claude-code',run.id);this.active.delete(run.id);});
    return this.store.getRun(run.id)!;
  }
  private observe(id:string,event:ClaudeEvent){
    const run=this.store.getRun(id);if(!run||terminal(run.execution))return;
    switch(event.kind){
      case 'session':
        this.store.append('run.model_configuration',id,{selectedModelId:null,requestedModelId:null,serverModelId:nativeModelId(event.model),source:'claude.system.init'});
        this.store.updateRun(id,{execution:run.execution==='interrupting'?'interrupting':'running'},'run.started',{sessionId:event.sessionId});break;
      case 'message':
        this.store.updateRun(id,{response:event.text.slice(0,64000)},'message.updated',{});break;
      case 'tool':this.store.append('claude.tool',id,{name:event.name});break;
      case 'quota':{
        const quota:Quota={kind:'quota',status:event.status,windows:event.windows.map(({id,utilization,resetsAt,status})=>({id,utilization,resetsAt,status}))};
        const observed=this.store.append('claude.quota',id,{status:quota.status,windows:quota.windows});
        this.subscriptionUsage.record(normalizeClaudeSubscriptionUsage(quota,{providerId:'claude-code',runtimeId:'claude-code',connectionRef:id,evidence:this.options.runnerFactory?'mock':'native',evidenceRefs:['event:'+observed.seq],observedAt:observed.at,lastAttemptAt:observed.at,now:observed.at,connected:true}));this.latestQuota=structuredClone(quota);break;
      }
      // Result/error lines are not exit observations. Only start()'s outcome is terminal.
    }
  }
  private async execute(id:string,runner:Runner):Promise<void>{
    let result:ReturnType<typeof executionForClaudeOutcome>;
    try{
      const outcome:ClaudeOutcome=await runner.start(this.store.getRun(id)!.prompt,event=>this.observe(id,event));
      this.store.append('run.runtime_outcome',id,{source:this.options.runnerFactory?'mock':outcome.evidenceSource==='native'?'native':outcome.evidenceSource==='mock'?'mock':'unknown',
        dispatch:outcome.dispatch==='started'?'started':outcome.dispatch==='not_started'?'not_started':'unknown',exit:outcome.exit==='observed'?'observed':'not_observed'});
      if(outcome.identity)this.store.append('run.identity',id,{...outcome.identity,runId:id});
      result=executionForClaudeOutcome(outcome);
    }catch{result={execution:'lost',reason:'EXIT_NOT_OBSERVED'};}
    try{this.store.updateRun(id,{execution:result.execution},'run.'+result.execution,{reason:result.reason});}
    catch{/* The durable nonterminal intent still blocks this task and becomes lost on restart. */}
  }
  interrupt(id:string):void {
    const run=this.store.getRun(id);if(!run||run.runtime!=='claude-code')throw new AppError('RUN_NOT_FOUND',404);
    if(terminal(run.execution)||run.execution==='interrupting')return;
    this.store.updateRun(id,{execution:'interrupting'},'run.interrupting',{});
    const active=this.active.get(id);
    if(!active){this.store.updateRun(id,{execution:'lost'},'run.lost',{reason:'EXIT_NOT_OBSERVED'});return;}
    try{active.runner.interrupt();}
    catch{throw new AppError('INTERRUPT_UNCERTAIN',503);}
  }
  async close():Promise<void>{
    this.closing=true;this.subscriptionUsage.disconnect('claude-code');
    for(const [id,active] of this.active){
      try{this.interrupt(id);}
      catch{
        // Shutdown must still stop the owned child if auditing is unavailable.
        // The durable intent stays unresolved until exit is actually observed.
        try{active.runner.interrupt();}catch{/* Best effort; never invent exit. */}
      }
    }
    await Promise.all([...this.active.values()].map(active=>active.done));
    this.subscriptionUsage.disconnect('claude-code');
  }
}
