import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,chmodSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {FakeClaudeRun,outcome} from './claude-task-fixture.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import {createNativeProbeService} from '../server/capability-probe.ts';
import {createClaudeAuthenticationService} from '../server/native-readiness.ts';
import {readVerificationConfiguration} from '../server/verification-service.ts';
import {defaultCompletionPolicy} from '../server/project-progress.ts';
import {CODE_GATES,type CompletionEvidence,type CompletionBinding} from '../shared/task-completion.ts';
import type {QualityDimension} from '../shared/quality-progress.ts';
import type {IntegrationCompletionEvidence} from '../server/integration-queue.ts';
import {trustedGit} from '../server/git-process.ts';

// Same app-server protocol fake as tests/cqg-6b-code.test.ts; explicit mock provenance.
class FakeCodex extends EventEmitter {
  evidenceSource='mock' as const;
  threadId=randomUUID();turnId=randomUUID();starts=0;
  async initialize(){} async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:params.threadId??this.threadId,status:{type:'idle'}},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
    if(method==='turn/start'){this.starts++;return {turn:{id:this.turnId}};}return {};
  }
  finish(){this.emit('notification',{method:'turn/completed',params:{threadId:this.threadId,turn:{id:this.turnId,status:'completed'}}});}
}
export async function until(predicate:()=>boolean,label:string){
  const deadline=Date.now()+60000;
  while(!predicate()){assert.ok(Date.now()<deadline,`Timed out: ${label}`);await new Promise(r=>setTimeout(r,10));}
}

export async function productFixture(kind:'general'|'code',nativeFixture=false,semanticFixture=true){
  const dir=mkdtempSync(join(tmpdir(),'orbit-product-e2e-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const {project,workspace}=projects.createProject({requestId:randomUUID(),name:'Product '+kind,kind});
  if(kind==='code')trustedGit(project.path,['checkout','-b','dev']);
  const policy={...defaultCompletionPolicy(kind),dependencyRelease:'quality_passed' as const,
    ...(kind==='code'?{gateCommandMap:Object.fromEntries(CODE_GATES.map(g=>[g,['full']]))}:{})};
  // This tiny fixture command proves local execution and artifact content only, not Orbit's full suite.
  const config=readVerificationConfiguration(JSON.stringify([{projectPath:project.path,id:'full',label:'Fixture artifact contract',executable:process.execPath,
    args:['-e',kind==='code'?`const a=require('node:assert/strict'),f=require('node:fs');a.equal(f.readFileSync('result.txt','utf8'),'Evidence: 42\\n');`:`const a=require('node:assert/strict'),f=require('node:fs');const paths=f.readdirSync('output');a.ok(paths.length);for(const p of paths)a.equal(f.readFileSync('output/'+p,'utf8'),'Evidence: 42\\n');`],timeoutMs:5000,...(kind==='code'?{categories:[...CODE_GATES],protectedFiles:['README.md']}:{})}]));
  const planners:FakeClaudeRun[]=[],runners:FakeClaudeRun[]=[],codex:FakeCodex[]=[];
  const nativeEvidence=new Map<string,CompletionEvidence>();
  const nativeProbe=createNativeProbeService(async()=>({checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.165.0'},claude:{status:'found',version:'2.1.312'}}));
  const claudeAuthentication=createClaudeAuthenticationService(async()=>({checkedAt:new Date().toISOString(),authentication:'subscription',source:'claude.auth.status',issue:null}));
  await nativeProbe.refresh();
  const controller=new Controller(store,dir,()=>{const rpc=new FakeCodex();codex.push(rpc);return rpc;},projects,config,[],
    {findExecutable:()=>'/fake/claude',runnerFactory:options=>{options.beforeDispatch();const runner=new FakeClaudeRun();runners.push(runner);return runner;}},
    {findExecutable:()=>'/fake/claude',runnerFactory:()=>{const runner=new FakeClaudeRun();planners.push(runner);return runner;}},{},
    {nativeProbe,claudeAuthentication,configuredCredentialRefs:[],
      ...(nativeFixture&&kind==='general'?{candidateCompletion:(item:Parameters<NonNullable<import('../server/controller.ts').ControllerRegistryOptions['candidateCompletion']>>[0]):IntegrationCompletionEvidence=>{
        // Same trusted candidate/source evidence seams as tests/worker-http.test.ts.
        // Review/model/semantic observations below are fixtures, never live verification.
        const reservation=JSON.parse(String(store.db.prepare('SELECT body FROM worker_reservations WHERE id=?').get(item.fence.reservationId)!.body));
        const run=store.findRequest(reservation.attempt.dispatchRequestId)!.run;
        const source=controller.progress.read(project.id,{}).tasks.find(t=>t.id===run.taskId)!.completion!.binding;
        nativeEvidence.set(run.id,fixtureEvidence(source));
        const binding={...source,artifactId:item.id,artifactDigest:item.candidateDigest,configDigest:item.configDigest};
        const evidence:IntegrationCompletionEvidence['evidence']=fixtureEvidence(binding);
        if(semanticFixture){const id=item.id+'semantic';evidence.bindings[id]={...binding};evidence.quality.evidence.push({id,kind:'artifact_check',binding:{...binding},evidenceSource:'local',freshness:'current',recordedStatus:'passed',blockers:[]});evidence.gateResults.push({gate:'semantic_review',evidenceId:id,status:'passed'});}
        return {subject:{integrationId:item.id,candidateDigest:item.candidateDigest!,targetDigest:item.generalTargetDigest},binding,evidence};
      }}:{}),completion:{policy:()=>policy,evidence:(base,run)=>{
      if(nativeEvidence.has(run.id))return structuredClone(nativeEvidence.get(run.id)!);
      if(!nativeFixture||kind!=='code'||!base.producer)return base;
      // Trusted CompletionReaders.evidence seam: tests/task-completion-wiring.test.ts and
      // tests/worker-http.test.ts. Only model/transport observations are native-shaped fixtures;
      // checks still come from real Controller.startVerification and persisted local results.
      base.producer.model={providerId:'fixture',modelId:'fixture-producer',sessionId:'fixture-session',runId:run.id,source:'native_observed',evidenceSource:'native'};
      base.quality.execution={...base.quality.execution,evidenceSource:'native',blockers:[]};return base;
    }}});
  const dispatchErrors:string[]=[];
  // Observe, rethrow unchanged: HTTP worker receipts intentionally redact dispatch exceptions.
  const submit=controller.submitTask.bind(controller);controller.submitTask=async(...args)=>{try{return await submit(...args);}catch(e){dispatchErrors.push(e instanceof Error?e.message:String(e));throw e;}};
  if(workspace){await controller.selectWorkspace(workspace.id);await controller.connect();}
  const server=createHttpServer(controller,'unused',{workers:{targetBranch:'dev',projects:[{projectPath:project.path,defaultBranch:'main',requiredChecks:['full']}]}});
  // Socketless real handler/session seam from tests/deliverables-route.test.ts.
  server.address=()=>({address:'127.0.0.1',family:'IPv4',port:45678});
  let cookie='',csrf='';
  async function request(method:string,url:string,data?:object,headers:Record<string,string>={}){
    return new Promise<{status:number;body:any;bytes:Buffer;headers:Record<string,string>}>((resolve,reject)=>{
      const req=Object.assign(Readable.from(data?[Buffer.from(JSON.stringify(data))]:[]),{method,url,headers:{host:'127.0.0.1:45678',origin:'http://127.0.0.1:45678',cookie,'content-type':'application/json','x-csrf-token':csrf,...headers}});
      const response={status:200,headers:{} as Record<string,string>,headersSent:false,
        setHeader(k:string,v:string){this.headers[k.toLowerCase()]=v;},
        writeHead(status:number,values:Record<string,string>={}){this.status=status;this.headersSent=true;for(const [k,v] of Object.entries(values))this.setHeader(k,v);},
        end(data:Buffer|string=''){try{const bytes=Buffer.from(data);let body:any;try{body=JSON.parse(bytes.toString());}catch{body=null;}resolve({status:this.status,body,bytes,headers:this.headers});}catch(e){reject(e);}}};
      server.emit('request',req,response);
    });
  }
  const session=await request('GET','/api/session');cookie=session.headers['set-cookie'].split(';')[0];csrf=session.body.csrfToken;
  const base=`/api/projects/${project.id}`;
  async function get(path:string){const r=await request('GET',path);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
  async function post(path:string,data:object){
    // Every user mutation proves both guards, with no database write on rejection.
    const changes=()=>store.db.prepare('SELECT total_changes() AS n').get()!.n,before=changes();
    assert.equal((await request('POST',path,data,{'x-csrf-token':''})).status,403,path);
    assert.equal((await request('POST',path,data,{origin:'http://evil.invalid'})).status,403,path);
    assert.equal(changes(),before);
    const r=await request('POST',path,data);assert.equal(r.status,200,path+' '+JSON.stringify(r.body));return r.body;
  }
  return {dir,store,projects,project,workspace,controller,server,base,request,get,post,planners,runners,codex,policy,nativeEvidence,dispatchErrors,
    async close(){await controller.stopWorkers();for(const r of [...planners,...runners])r.finish(outcome('interrupted'));await controller.close();server.emit('close');store.close();
      const writable=(path:string)=>{chmodSync(path,0o700);for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())writable(join(path,entry.name));};writable(dir);rmSync(dir,{recursive:true,force:true});}};
}
export type ProductFixture=Awaited<ReturnType<typeof productFixture>>;

// Native-shaped fixtures from tests/worker-http.test.ts; not provider observations.
function fixtureEvidence(binding:CompletionBinding):CompletionEvidence {
 const model=(id:string)=>({providerId:'fixture',modelId:id,runId:id==='producer'?binding.runId:'candidate-'+id,sessionId:'session-'+id,source:'native_observed' as const,evidenceSource:'native' as const});
 const d=(status:QualityDimension['status']='not_run',evidenceIds:string[]=[]):QualityDimension=>({status,evidenceIds,blockers:[],nextAction:null});
 const id=binding.artifactId+'review',artifact={id:binding.artifactId!,digest:binding.artifactDigest!};
 const review={modelKey:'fixture/reviewer',sessionId:'session-reviewer',baselineDigest:binding.planningContentHash!,artifactDigest:artifact.digest,criteria:[{criterion:'Cite evidence',status:'met' as const,evidence:'candidate fixture checked'}],findings:[]};
 const evidence:CompletionEvidence={quality:{execution:{...d('completed'),evidenceSource:'native'},format:d(),codeVerification:d(),semantic:d('passed',[id]),independentReview:d('completed',[id]),repair:d(),revalidation:d(),userApproval:d(),evidence:[]},producer:{binding,model:model('producer')},bindings:{},checks:[],commands:[],gateResults:[],approvals:[],loops:[{id,projectId:binding.projectId!,taskId:binding.taskId!,sourceRunId:binding.runId!,baseline:{id:binding.planningVersionId!,digest:binding.planningContentHash!,criteria:['Cite evidence']},producer:model('producer'),reviewers:[{id:'reviewer',providerId:'fixture',modelId:'reviewer'}],recoveryRequired:false,result:{status:'passed',issue:null,calls:1,repairs:0,artifact,rounds:[{number:1,artifact,reviews:[{reviewerId:'reviewer',result:review}],failures:[]}]},steps:[{id:'step',index:1,kind:'review',state:'completed',requestDigest:'request',startedAt:'start',finishedAt:'finish',issue:null,evidence:model('reviewer'),result:review}],verification:{status:'passed',checkIds:[],issue:null}}]};
 for(const [key,kind] of [[id,'quality_loop'],[binding.artifactId+'format','artifact_check'],[binding.artifactId+'numeric','artifact_check']] as const){evidence.bindings[key]={...binding};evidence.quality.evidence.push({id:key,kind,binding:{...binding},evidenceSource:kind==='quality_loop'?'native':'local',freshness:'current',recordedStatus:'passed',blockers:[]});}
 evidence.gateResults=[{gate:'artifact_format',evidenceId:binding.artifactId+'format',status:'passed'},{gate:'numeric_source',evidenceId:binding.artifactId+'numeric',status:'passed'}];
 return evidence;
}
