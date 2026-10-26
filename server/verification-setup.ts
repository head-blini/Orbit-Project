import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {ConfigureVerificationInput,VerificationSetupCandidate,VerificationSetupReceipt,VerificationSetupView} from '../shared/verification-setup.ts';
import type {VerificationCommandPreview} from '../shared/verification.ts';
import type {Project} from '../shared/types.ts';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import {AppError} from './errors.ts';
import {readDataRecord} from './guardrails/outbound.ts';
import {protectedFilePaths} from './acceptance.ts';
import {containsCredential} from './privacy.ts';
import {readVerificationConfiguration,verificationCommandPreviews,type VerificationConfiguration} from './verification-configuration.ts';

type Preset={version:1;projectId:string;projectPath:string;workspaceId:string;revision:number;profileId:'node-test-v1';
  tests:string[];protectedFiles:string[];sourceDigest:string;baseSha:string;requestId:string;previewDigest:string;createdAt:string};
type SavedReceipt={version:1;projectPath:string;requestDigest:string;input:ConfigureVerificationInput;receipt:VerificationSetupReceipt};
type Row={project_id:string;digest:string;body:string;revision?:number;request_id?:string};
const compare=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)&&!containsCredential(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const testPath=(path:string)=>/\.test\.(?:js|mjs|cjs)$/.test(path);
const scope='Git 추적 파일과 무시되지 않은 파일에서 발견한 Node 테스트만 명시 등록합니다. 등록은 테스트를 실행하지 않습니다. 실행 시 로컬 OS 권한을 사용하며 OS sandbox가 없습니다. 테스트 통과는 테스트 품질이나 전체 요구사항 충족을 증명하지 않습니다.';
const corrupt=():never=>{throw new AppError('VERIFICATION_SETUP_CORRUPT',503);};
function input(value:unknown):ConfigureVerificationInput{
  let result:ConfigureVerificationInput;
  try{
    const data=readDataRecord(value,['requestId','profileId','expectedPreviewDigest','confirmed']);
    if(!data||!id(data.requestId)||data.profileId!=='node-test-v1'||!digest(data.expectedPreviewDigest)||typeof data.confirmed!=='boolean')throw new Error();
    result={requestId:data.requestId,profileId:data.profileId,expectedPreviewDigest:data.expectedPreviewDigest,confirmed:data.confirmed};
  }catch{throw new AppError('INVALID_FIELDS',400);}
  if(!result.confirmed)throw new AppError('VERIFICATION_SETUP_CONFIRMATION_REQUIRED',409);
  return result;
}
const requestDigest=(workspaceId:string,value:ConfigureVerificationInput)=>hash({workspaceId,...value});
function validatedPaths(tests:unknown,protectedFiles:unknown){
  const selected=protectedFilePaths(tests),protectedPaths=protectedFilePaths(protectedFiles);
  if(selected.length>60||selected.some(path=>!testPath(path))||!equal(selected,tests)||!equal(protectedPaths,protectedFiles)
    ||selected.some(path=>!protectedPaths.includes(path))||protectedPaths.some(path=>!selected.includes(path)&&path!=='package.json'&&path!=='package-lock.json'))throw new Error();
  return {tests:selected,protectedFiles:protectedPaths};
}
function command(projectPath:string,tests:string[],protectedFiles:string[]):VerificationCommandPreview{
  const configuration=readVerificationConfiguration(JSON.stringify([{projectPath,id:'orbit-node-tests',label:'Node 테스트',executable:process.execPath,args:['--test','--',...tests],timeoutMs:60000,protectedFiles}]));
  return verificationCommandPreviews(configuration,projectPath)[0];
}

/** Only the built-in profile and validated exact file lists survive persistence.
 * Discovery uses the existing whole-workspace snapshot; no test code is imported or executed.
 */
export class VerificationSetupService {
  private store:Store;private projects:Projects|undefined;private hostConfig:VerificationConfiguration[];
  constructor(store:Store,projects:Projects|undefined,hostConfig:VerificationConfiguration[]=[]){
    this.store=store;this.projects=projects;this.hostConfig=readVerificationConfiguration(JSON.stringify(hostConfig));
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS verification_setup_presets(project_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,revision));
      CREATE TABLE IF NOT EXISTS verification_setup_receipts(request_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL);`);
  }
  private context(workspaceId:string){
    if(!this.projects)throw new AppError('VERIFICATION_SETUP_UNAVAILABLE',404);
    const workspace=this.projects.writable(workspaceId),project=this.projects.list().find(value=>value.id===workspace.projectId);
    if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    if(workspace.id!==workspaceId||!project.writeEnabled)throw new AppError('WRITES_DISABLED',403);
    return {workspace,project};
  }
  private receipt(row:Row):SavedReceipt{
    try{
      if(typeof row.body!=='string'||row.body.length>64000)throw new Error();
      const data=readDataRecord(JSON.parse(row.body),['version','projectPath','requestDigest','input','receipt']);
      if(!data||data.version!==1||typeof data.projectPath!=='string'||!digest(data.requestDigest))throw new Error();
      const normalized=input(data.input),r=readDataRecord(data.receipt,['requestId','projectId','workspaceId','revision','profileId','createdAt']);
      if(!r||![r.requestId,r.projectId,r.workspaceId].every(id)||r.requestId!==normalized.requestId||r.requestId!==row.request_id||r.projectId!==row.project_id
        ||!Number.isSafeInteger(r.revision)||Number(r.revision)<1||r.profileId!=='node-test-v1'||!timestamp(r.createdAt)
        ||data.requestDigest!==requestDigest(r.workspaceId as string,normalized))throw new Error();
      const result:SavedReceipt={version:1,projectPath:data.projectPath,requestDigest:data.requestDigest,input:normalized,receipt:{...r} as unknown as VerificationSetupReceipt};
      if(!equal(result,JSON.parse(row.body))||hash(result)!==row.digest)throw new Error();
      return result;
    }catch{return corrupt();}
  }
  private history(project:Project):Preset|null{
    try{
      const rows=this.store.db.prepare('SELECT project_id,revision,digest,body FROM verification_setup_presets WHERE project_id=? ORDER BY revision LIMIT 101').all(project.id) as unknown as Row[];
      const receipts=this.store.db.prepare('SELECT request_id,project_id,digest,body FROM verification_setup_receipts WHERE project_id=? LIMIT 101').all(project.id) as unknown as Row[];
      if(rows.length>100||rows.length!==receipts.length)throw new Error();
      const saved=new Map(receipts.map(row=>{const value=this.receipt(row);return [value.receipt.requestId,value];}));let latest:Preset|null=null;
      for(let index=0;index<rows.length;index++){
        const row=rows[index];if(typeof row.body!=='string'||row.body.length>64000)throw new Error();
        const data=readDataRecord(JSON.parse(row.body),['version','projectId','projectPath','workspaceId','revision','profileId','tests','protectedFiles','sourceDigest','baseSha','requestId','previewDigest','createdAt']);
        if(!data||data.version!==1||data.projectId!==project.id||data.projectPath!==project.path||row.project_id!==project.id
          ||data.revision!==index+1||row.revision!==data.revision||data.profileId!=='node-test-v1'||![data.projectId,data.workspaceId,data.requestId].every(id)
          ||!digest(data.sourceDigest)||!digest(data.previewDigest)||typeof data.baseSha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(data.baseSha)||!timestamp(data.createdAt))throw new Error();
        const paths=validatedPaths(data.tests,data.protectedFiles),preset={...data,...paths} as unknown as Preset;
        if(hash(preset)!==row.digest)throw new Error();
        // Regenerate through the same host validator; persisted fields cannot add executable or argv authority.
        command(project.path,preset.tests,preset.protectedFiles);
        const receipt=saved.get(preset.requestId);
        if(!receipt||receipt.projectPath!==project.path||receipt.receipt.projectId!==preset.projectId||receipt.receipt.workspaceId!==preset.workspaceId
          ||receipt.receipt.revision!==preset.revision||receipt.receipt.createdAt!==preset.createdAt||receipt.input.expectedPreviewDigest!==preset.previewDigest)throw new Error();
        latest=preset;
      }
      return latest;
    }catch{return corrupt();}
  }
  commands(projectPath:string):VerificationCommandPreview[]{
    const matching=this.store.projects().filter(project=>project.path===projectPath);if(matching.length>1)return corrupt();
    const preset=matching.length?this.history(matching[0]):null,host=verificationCommandPreviews(this.hostConfig,projectPath);
    if(host.length)return host;
    return preset?[command(projectPath,preset.tests,preset.protectedFiles)]:[];
  }
  view(workspaceId:string):VerificationSetupView{
    const {workspace,project}=this.context(workspaceId),preset=this.history(project),host=verificationCommandPreviews(this.hostConfig,project.path);
    const commands=host.length?host:preset?[command(project.path,preset.tests,preset.protectedFiles)]:[];
    const view:VerificationSetupView={projectId:project.id,workspaceId,revision:preset?.revision??0,lastRequestId:preset?.requestId??null,
      source:host.length?'host':preset?'preset':'none',commands,candidate:null,issue:null,scope};
    if(host.length)return {...view,issue:'HOST_CONFIGURATION'};
    try{
      const snapshot=this.projects!.snapshot(workspaceId),present=snapshot.files.filter(file=>file.presence==='present'),tests=present.map(file=>file.path).filter(testPath).sort(compare);
      if(!tests.length)return {...view,issue:'NO_NODE_TEST_FILES'};
      if(tests.length>60)return {...view,issue:'TOO_MANY_TEST_FILES'};
      const manifests=['package.json','package-lock.json'].filter(path=>lstatSync(join(workspace.path,path),{throwIfNoEntry:false})!==undefined);
      // An ignored manifest can alter the runner but is outside our snapshot. Do not read or silently omit it.
      if(manifests.some(path=>!present.some(file=>file.path===path)))throw new Error();
      const protectedFiles=[...tests,...manifests].sort(compare);
      validatedPaths(tests,protectedFiles);const preview=command(project.path,tests,protectedFiles);
      const candidate:VerificationSetupCandidate={profileId:'node-test-v1',label:'Node 테스트',sourceDigest:snapshot.sourceDigest,baseSha:workspace.baseSha,tests,command:preview,
        previewDigest:hash({policy:'orbit-verification-setup-v1',projectId:project.id,projectPath:project.path,workspaceId,workspacePath:workspace.path,baseSha:workspace.baseSha,
          sourceDigest:snapshot.sourceDigest,revision:view.revision,commands,profileId:'node-test-v1',command:preview})};
      return {...view,candidate};
    }catch{return {...view,issue:'SOURCE_UNAVAILABLE'};}
  }
  configure(workspaceId:string,value:ConfigureVerificationInput):VerificationSetupReceipt{
    const normalized=input(value);
    return this.store.transaction(()=>{
      const {project}=this.context(workspaceId),current=this.history(project);
      const prior=this.store.db.prepare('SELECT request_id,project_id,digest,body FROM verification_setup_receipts WHERE request_id=?').get(normalized.requestId) as unknown as Row|undefined;
      if(prior){
        const saved=this.receipt(prior);
        if(saved.receipt.projectId!==project.id||saved.projectPath!==project.path||saved.requestDigest!==requestDigest(workspaceId,normalized))throw new AppError('IDEMPOTENCY_CONFLICT',409);
        return saved.receipt;
      }
      if((current?.revision??0)>=100)throw new AppError('VERIFICATION_SETUP_QUOTA',413);
      const view=this.view(workspaceId);
      if(!view.candidate)throw new AppError(view.issue??'SOURCE_UNAVAILABLE',409);
      if(view.candidate.previewDigest!==normalized.expectedPreviewDigest)throw new AppError('VERIFICATION_SETUP_PREVIEW_STALE',409);
      const revision=view.revision+1,createdAt=new Date().toISOString(),candidate=view.candidate;
      const receipt:VerificationSetupReceipt={requestId:normalized.requestId,projectId:project.id,workspaceId,revision,profileId:'node-test-v1',createdAt};
      const preset:Preset={version:1,projectId:project.id,projectPath:project.path,workspaceId,revision,profileId:'node-test-v1',tests:candidate.tests,
        protectedFiles:candidate.command.protectedFiles!,sourceDigest:candidate.sourceDigest,baseSha:candidate.baseSha,requestId:normalized.requestId,previewDigest:candidate.previewDigest,createdAt};
      const saved:SavedReceipt={version:1,projectPath:project.path,requestDigest:requestDigest(workspaceId,normalized),input:normalized,receipt};
      this.store.db.prepare('INSERT INTO verification_setup_presets VALUES(?,?,?,?)').run(project.id,revision,hash(preset),JSON.stringify(preset));
      this.store.db.prepare('INSERT INTO verification_setup_receipts VALUES(?,?,?,?)').run(normalized.requestId,project.id,hash(saved),JSON.stringify(saved));
      this.store.append('verification.setup.configured',null,{projectId:project.id,workspaceId,revision,requestId:normalized.requestId});
      return receipt;
    });
  }
}
