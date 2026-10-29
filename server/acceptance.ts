import {createHash} from 'node:crypto';
import type {GeneralAcceptanceBaseline,TaskAcceptanceStatus,TaskVerificationPreview} from '../shared/acceptance.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {VerificationCommandPreview} from '../shared/verification.ts';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import {Studio} from './studio.ts';
import {AppError} from './errors.ts';
import {assertWorkspaceManifest} from './workspace-fingerprint.ts';

const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const compare=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const scope='승인된 Task 인수조건·호스트 명령 설정·선택한 Git-visible 테스트/runner/manifest 파일의 바이트와 모드를 고정합니다. 선택하지 않은 파일, ignored 의존성, 외부 도구·런타임 바이너리, 실행 중 변경 후 원복을 모두 증명하지 않습니다. 동일성은 인수조건 충족·격리·목표 달성의 증명이 아닙니다.';
function record(value:unknown,keys:string[]):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)return false;
  return keys.every(key=>{const property=Object.getOwnPropertyDescriptor(value,key);return property&&'value' in property;});
}
function ordinaryList(value:unknown,max:number):value is unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>max||Reflect.ownKeys(value).length!==value.length+1)return false;
  for(let i=0;i<value.length;i++){const property=Object.getOwnPropertyDescriptor(value,String(i));if(!property||!('value' in property))return false;}
  return true;
}
/** Host configuration only. Exact relative paths, never globs or browser authority. */
export function protectedFilePaths(value:unknown):string[]{
  try{
    if(!ordinaryList(value,128))throw new Error();
    const paths:string[]=[];
    for(const path of value){
      if(typeof path!=='string'||path.length>512||/[\x00-\x1f\x7f\\:*?\[\]{}]/.test(path))throw new Error();
      paths.push(path);
    }
    // Reuse the hardened fingerprint manifest policy, including sensitive paths,
    // aliases, platform case collisions and Git mode restrictions, without I/O.
    assertWorkspaceManifest(paths.map(path=>({path,mode:'100644'})));
    return paths.sort(compare);
  }catch{throw new Error('INVALID_PROTECTED_FILES');}
}
/** Stable field order; callers persist the returned preview, never raw source bytes. */
export function acceptanceDigest(value:Omit<TaskVerificationPreview,'digest'>|TaskVerificationPreview):string{
  return createHash('sha256').update(JSON.stringify({projectId:value.projectId,workspaceId:value.workspaceId,taskId:value.taskId,
    planningVersionId:value.planningVersionId,planHash:value.planHash,baseSha:value.baseSha,criteria:value.criteria,commands:value.commands,files:value.files,scope:value.scope})).digest('hex');
}
function baseline(value:unknown):TaskVerificationPreview{
  if(!record(value,['projectId','workspaceId','taskId','planningVersionId','planHash','baseSha','criteria','commands','files','digest','scope'])
    ||![value.projectId,value.workspaceId,value.taskId,value.planningVersionId].every(id)||!digest(value.planHash)||!digest(value.digest)
    ||typeof value.baseSha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseSha)||typeof value.scope!=='string'||!value.scope||value.scope.length>4096
    ||!ordinaryList(value.criteria,100)||!ordinaryList(value.commands,32)||!ordinaryList(value.files,2000)||JSON.stringify(value).length>512*1024)throw new Error();
  const labels=new Set<string>(),commands=new Set<string>(),required=new Set<string>();
  for(const item of value.criteria){
    if(!record(item,['label','description','acceptanceCriteria'])||!id(item.label)||labels.has(item.label)||typeof item.description!=='string'||!item.description
      ||!ordinaryList(item.acceptanceCriteria,1000)||item.acceptanceCriteria.some(text=>typeof text!=='string'||!text.trim()))throw new Error();labels.add(item.label);
  }
  for(const command of value.commands){
    if(!record(command,['id','label','configDigest','protectedFiles'])||!id(command.id)||commands.has(command.id)||typeof command.label!=='string'||!command.label||!digest(command.configDigest))throw new Error();
    const paths=protectedFilePaths(command.protectedFiles);if(JSON.stringify(paths)!==JSON.stringify(command.protectedFiles))throw new Error();paths.forEach(path=>required.add(path));commands.add(command.id);
  }
  const files:string[]=[];
  for(const file of value.files){
    if(!record(file,['path','mode','sha256'])||typeof file.path!=='string'||typeof file.mode!=='string'||!['100644','100755'].includes(file.mode)||!digest(file.sha256))throw new Error();files.push(file.path);
  }
  assertWorkspaceManifest((value.files as TaskVerificationPreview['files']).map(({path,mode})=>({path,mode})));
  if(required.size!==files.length||files.some(path=>!required.has(path))||JSON.stringify([...files].sort(compare))!==JSON.stringify(files))throw new Error();
  const result=value as unknown as TaskVerificationPreview;if(acceptanceDigest(result)!==result.digest)throw new Error();return result;
}
const generalScope='승인된 계획 버전의 Task 인수조건 원문만 고정합니다. 산출물·입력 파일·검사 결과를 포함하지 않으며, 동일성은 인수조건 충족의 증명이 아닙니다.';
function criteriaFor(plan:PlanningVersion,task:SavedTask){
  return plan.draft.requirements.filter(requirement=>task.requirementLabels.includes(requirement.label)).map(({label,description,acceptanceCriteria})=>({label,description,acceptanceCriteria:[...acceptanceCriteria]})).sort((a,b)=>compare(a.label,b.label));
}
/** General task baseline. Studio.execution enforces approval, open questions, task/plan match and head freshness; any failure throws (fail closed). */
export function generalAcceptance(store:Store,projectId:string,taskId:string):GeneralAcceptanceBaseline{
  if(store.projects().find(value=>value.id===projectId)?.kind!=='general')throw new AppError('GENERAL_PROJECT_REQUIRED',409);
  const studio=new Studio(store);studio.execution(projectId,taskId);
  const task=(studio.read(projectId,'tasks') as SavedTask[]).find(value=>value.id===taskId)!;
  const plan=(studio.read(projectId,'plans') as PlanningVersion[]).find(value=>value.id===task.planningVersionId)!;
  const view={kind:'general' as const,projectId,taskId,planningVersionId:plan.id,planHash:plan.contentHash,criteria:criteriaFor(plan,task),scope:generalScope};
  // Domain tag keeps a general digest from ever colliding with a code acceptanceDigest().
  return {...view,digest:createHash('sha256').update(JSON.stringify({domain:'orbit.acceptance.general.v1',...view})).digest('hex')};
}
const unknown=():TaskAcceptanceStatus=>({state:'unavailable',baseline:null,issue:'ACCEPTANCE_BASELINE_UNAVAILABLE'});

/** Reads authoritative records and hardened snapshots; never writes a baseline or dispatches work. */
export class AcceptanceService {
  private store:Store;private projects:Projects|undefined;private commands:(projectPath:string)=>VerificationCommandPreview[];
  constructor(store:Store,projects:Projects|undefined,commands:(projectPath:string)=>VerificationCommandPreview[]){this.store=store;this.projects=projects;this.commands=commands;}
  preview(projectId:string,workspaceId:string,taskId:string):TaskVerificationPreview|null{
    const project=this.store.projects().find(value=>value.id===projectId),workspace=this.store.workspaces().find(value=>value.id===workspaceId);
    if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    if(!workspace||workspace.projectId!==projectId)throw new AppError('WORKSPACE_MISMATCH',409);
    if(!this.projects)throw new AppError('ACCEPTANCE_SOURCE_UNAVAILABLE',409);
    const studio=new Studio(this.store);studio.execution(projectId,taskId);
    const task=(studio.read(projectId,'tasks') as SavedTask[]).find(value=>value.id===taskId)!;
    const plan=(studio.read(projectId,'plans') as PlanningVersion[]).find(value=>value.id===task.planningVersionId)!;
    const configured=this.commands(project.path);
    if(!configured.length||configured.every(command=>command.protectedFiles===undefined))return null;
    if(configured.some(command=>command.protectedFiles===undefined))throw new AppError('ACCEPTANCE_CONFIGURATION_INCOMPLETE',409);
    const selected=configured.map(command=>{
      if(!id(command.id)||typeof command.label!=='string'||!command.label||!digest(command.configDigest))throw new AppError('INVALID_ACCEPTANCE_CONFIGURATION',503);
      return {id:command.id,label:command.label,configDigest:command.configDigest,protectedFiles:protectedFilePaths(command.protectedFiles)};
    }).sort((a,b)=>compare(a.id,b.id));
    if(selected.length>32||new Set(selected.map(command=>command.id)).size!==selected.length)throw new AppError('INVALID_ACCEPTANCE_CONFIGURATION',503);
    const paths=[...new Set(selected.flatMap(command=>command.protectedFiles))].sort(compare);
    let snapshot:ReturnType<Projects['snapshot']>;
    try{snapshot=this.projects.snapshot(workspaceId);}catch{throw new AppError('ACCEPTANCE_SOURCE_UNAVAILABLE',409);}
    const files=paths.map(path=>{
      const file=snapshot.files.find(value=>value.path===path);
      if(!file||file.presence!=='present')throw new AppError('ACCEPTANCE_FILE_UNAVAILABLE',409);
      return {path,mode:file.mode,sha256:createHash('sha256').update(file.bytes).digest('hex')};
    });
    assertWorkspaceManifest(files.map(({path,mode})=>({path,mode})));
    const view={projectId,workspaceId,taskId,planningVersionId:plan.id,planHash:plan.contentHash,baseSha:workspace.baseSha,
      criteria:criteriaFor(plan,task),
      commands:selected,files,scope};
    return baseline({...view,digest:acceptanceDigest(view)});
  }
  status(workspaceId:string,runId:string):TaskAcceptanceStatus{
    let saved:TaskVerificationPreview;
    try{
      const run=this.store.getRun(runId),workspace=this.store.workspaces().find(value=>value.id===workspaceId);
      if(!run||run.workspaceId!==workspaceId||!workspace)return unknown();
      if(run.acceptanceDigest===undefined)return {state:'unbound',baseline:null,issue:null};
      if(!digest(run.acceptanceDigest))return unknown();
      const row=this.store.db.prepare('SELECT digest,body FROM run_acceptance_baselines WHERE run_id=?').get(runId);
      if(!row||row.digest!==run.acceptanceDigest)return unknown();saved=baseline(JSON.parse(String(row.body)));
      if(saved.digest!==run.acceptanceDigest||saved.workspaceId!==workspaceId||saved.projectId!==workspace.projectId||saved.taskId!==run.taskId||saved.planningVersionId!==run.planningVersionId)return unknown();
      if(saved.baseSha!==workspace.baseSha)return {state:'changed',baseline:saved,issue:'ACCEPTANCE_CONTEXT_CHANGED'};
    }catch{return unknown();}
    try{
      const current=this.preview(saved.projectId,workspaceId,saved.taskId);
      return current?.digest===saved.digest?{state:'current',baseline:saved,issue:null}:{state:'changed',baseline:saved,issue:'ACCEPTANCE_CHANGED'};
    }catch(error){
      const changed=error instanceof AppError&&['PLANNING_VERSION_STALE','NOT_APPROVED','TASK_PLAN_MISMATCH','UNRESOLVED_QUESTIONS','ACCEPTANCE_FILE_UNAVAILABLE','ACCEPTANCE_CONFIGURATION_INCOMPLETE'].includes(error.message);
      return {state:changed?'changed':'unavailable',baseline:saved,issue:changed?'ACCEPTANCE_CHANGED':'ACCEPTANCE_SOURCE_UNAVAILABLE'};
    }
  }
}
