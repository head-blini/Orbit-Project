import {createHash} from 'node:crypto';
import type {Run} from '../shared/types.ts';
import {terminal} from '../shared/types.ts';
import type {SavedTask} from '../shared/parallel.ts';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import {Studio} from './studio.ts';
import {HandoffService} from './handoff-service.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {ClaudeCodeRun,findClaude,claudeEnv,type ClaudeEvent,type ClaudeOutcome} from './runtimes/claude-code.ts';
import {claudeTaskPrompt,executionForClaudeOutcome} from './runtimes/claude-task.ts';
import {nativeModelId} from './runtimes/model-identity.ts';
import {listMaterials} from './materials.ts';

type Runner=Pick<ClaudeCodeRun,'start'|'interrupt'>;
type Quota=Extract<ClaudeEvent,{kind:'quota'}>;
export interface ClaudeTaskServiceOptions {
  findExecutable?:()=>string;
  runnerFactory?:(options:{executable:string;cwd:string;mode:'write';env:NodeJS.ProcessEnv})=>Runner;
}
type Active={runner:Runner;done:Promise<void>};

/** One owner per saved task; native execution remains entirely in ClaudeCodeRun. */
export class ClaudeTaskService {
  private store:Store;private projects?:Projects;private options:ClaudeTaskServiceOptions;
  private active=new Map<string,Active>();private latestQuota:Quota|null=null;private closing=false;
  constructor(store:Store,projects?:Projects,options:ClaudeTaskServiceOptions={}){this.store=store;this.projects=projects;this.options=options;}
  quota():Quota|null{return this.latestQuota?structuredClone(this.latestQuota):null;}
  submit(projectId:string,taskId:string,requestId:string):Run {
    return this.dispatch(projectId,taskId,requestId);
  }
  /** Internal Quality Loop repair path; callers retain the Controller's global execution gates. */
  repair(sourceRunId:string,requestId:string,prompt:string):Run {
    const source=this.store.getRun(sourceRunId);
    if(!source||!source.projectId||!source.taskId||source.execution!=='completed')throw new AppError('QUALITY_SOURCE_INVALID',409);
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>32000)throw new AppError('INVALID_REPAIR_INPUT',400);
    return this.dispatch(source.projectId,source.taskId,requestId,{source,prompt});
  }
  private dispatch(projectId:string,taskId:string,requestId:string,repair?:{source:Run;prompt:string}):Run {
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw new AppError('INVALID_REQUEST_ID',400);
    const repairDigest=repair?createHash('sha256').update(JSON.stringify({sourceRunId:repair.source.id,prompt:repair.prompt})).digest('hex'):null;
    const prior=this.store.findRequest(requestId);
    if(prior){
      if(prior.run.runtime!=='claude-code'||prior.run.projectId!==projectId||prior.run.taskId!==taskId||repairDigest&&prior.digest!==repairDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);
      return prior.run;
    }
    const runs=this.store.runs().filter(run=>run.taskId===taskId);
    // One writer per project folder: tasks of the same general project run one at a time.
    if(runs.some(run=>!terminal(run.execution))||this.store.runs().some(run=>run.runtime==='claude-code'&&run.projectId===projectId&&!terminal(run.execution)))throw new AppError('RUN_ACTIVE',409);
    if(runs.some(run=>run.execution==='lost'))throw new AppError('SOLO_RECOVERY_REQUIRED',409);
    if(this.closing)throw new AppError('SESSION_BUSY',409);
    if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
    const project=this.projects.generalProject(projectId),studio=new Studio(this.store);
    const brief=studio.execution(projectId,taskId),handoff=new HandoffService(this.store,studio).build(projectId,taskId);
    if(repair&&(repair.source.planningVersionId!==brief.planningVersionId||repair.source.planningContentHash!==brief.planningContentHash))throw new AppError('QUALITY_BASELINE_CHANGED',409);
    const task=(studio.read(projectId,'tasks') as SavedTask[]).find(task=>task.id===taskId)!;
    // Same input gate as Codex runs (Controller.start), applied to the same raw execution brief:
    // block instead of silently redacting, and audit the denial.
    const raw=brief.prompt+'\n'+task.title+(repair?'\n'+repair.prompt:'');
    const denial=containsCredential(raw)?'CREDENTIAL_LIKE_INPUT':outboundDenial(raw);
    if(denial){this.store.append('guardrail.denied',null,{providerId:'claude-code',code:denial});throw new AppError(denial,400);}
    const prompt=claudeTaskPrompt({title:task.title,goal:handoff.goal,baseline:handoff.baseline,
      acceptanceCriteria:handoff.requirements.flatMap(requirement=>requirement.acceptanceCriteria),
      constraints:handoff.constraints,nonGoals:handoff.nonGoals,decisions:handoff.decisions,deliverable:`task-${taskId.slice(0,8)}.md`,materials:listMaterials(project.path).map(item=>item.path)})+(repair?'\n품질 검증에서 실패한 항목만 수정하세요. 기존 통과 항목과 승인 기준은 보존하세요.\n'+repair.prompt:'');
    const executable=(this.options.findExecutable??findClaude)();
    // No await between ownership checks, durable intent and launch.
    const run=this.store.createRun(requestId,repairDigest??createHash('sha256').update(prompt).digest('hex'),prompt,undefined,
      {runtime:'claude-code',projectId,taskId,planningVersionId:brief.planningVersionId,planningContentHash:brief.planningContentHash,requirementLabels:brief.requirementLabels});
    let runner:Runner;
    try{
      if(repair)this.store.append('run.repair_source',run.id,{sourceRunId:repair.source.id,planningVersionId:brief.planningVersionId,planningContentHash:brief.planningContentHash});
      // Revalidate after synchronous Store observers, immediately before launch.
      this.projects.generalProject(projectId);
      runner=(this.options.runnerFactory??(options=>new ClaudeCodeRun(options)))({executable,cwd:project.path,mode:'write',env:claudeEnv()});
    }catch{
      return this.store.updateRun(run.id,{execution:'failed'},'run.failed',{reason:'RUNTIME_NOT_STARTED'});
    }
    const active:Active={runner,done:Promise.resolve()};this.active.set(run.id,active);
    active.done=this.execute(run.id,runner).finally(()=>this.active.delete(run.id));
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
        this.store.append('claude.quota',id,{status:quota.status,windows:quota.windows});this.latestQuota=structuredClone(quota);break;
      }
      // Result/error lines are not exit observations. Only start()'s outcome is terminal.
    }
  }
  private async execute(id:string,runner:Runner):Promise<void>{
    let result:ReturnType<typeof executionForClaudeOutcome>;
    try{
      const outcome:ClaudeOutcome=await runner.start(this.store.getRun(id)!.prompt,event=>this.observe(id,event));
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
    this.closing=true;
    for(const [id,active] of this.active){
      try{this.interrupt(id);}
      catch{
        // Shutdown must still stop the owned child if auditing is unavailable.
        // The durable intent stays unresolved until exit is actually observed.
        try{active.runner.interrupt();}catch{/* Best effort; never invent exit. */}
      }
    }
    await Promise.all([...this.active.values()].map(active=>active.done));
  }
}
