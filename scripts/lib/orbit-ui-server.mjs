// Test-only host. Production HTTP, storage and project services; never imports a Codex factory.
import { mkdirSync,existsSync,readFileSync,lstatSync } from 'node:fs';
import { resolve,join,relative } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createMockServer } from 'node:http';
import { Store } from '../../server/store.ts';
import { Studio } from '../../server/studio.ts';
import { Controller } from '../../server/controller.ts';
import { Projects } from '../../server/projects.ts';
import { createWorkspace } from '../../server/workspace.ts';
import { createHttpServer } from '../../server/http.ts';
import { readModelHubConfiguration } from '../../server/providers/model-hub-configuration.ts';
import { containedPath } from './orbit-ui-e2e.ts';
import { trustedGit } from '../../server/git-process.ts';

if(!process.send)throw new Error('E2E_SERVER_REQUIRES_OWNING_IPC_PARENT');
const [runDirectory,assetDirectory,requestedPort='0',requestedMergePath,requestedWorkflowPath,requestedReviewPath,requestedInventoryPath,...extra]=process.argv.slice(2);
const root=resolve(runDirectory),sandbox=containedPath(root,'sandbox');
if(!existsSync(containedPath(root,'e2e-owned.json')))throw new Error('E2E_OWNERSHIP_MARKER_REQUIRED');
mkdirSync(sandbox,{recursive:true});
const store=new Store(containedPath(root,'sandbox','test.sqlite'));
let workspace=store.getMeta('workspace');
if(!workspace){workspace=createWorkspace(sandbox);store.setMeta('workspace',workspace);}
const projectPath=containedPath(root,'sandbox','orbit-ui-fixture');
const mergeProjectPath=containedPath(root,'sandbox','orbit-ui-merge');
const workflowProjectPath=containedPath(root,'sandbox','orbit-ui-workflow');
if(requestedMergePath!==undefined&&resolve(requestedMergePath)!==mergeProjectPath)throw new Error('INVALID_MERGE_FIXTURE_GRANT');
if(requestedWorkflowPath!==undefined&&resolve(requestedWorkflowPath)!==workflowProjectPath)throw new Error('INVALID_WORKFLOW_FIXTURE_GRANT');
if(extra.length||(requestedReviewPath!==undefined&&(resolve(requestedReviewPath)!==workflowProjectPath||requestedMergePath===undefined||requestedWorkflowPath===undefined)))throw new Error('INVALID_REVIEW_FIXTURE_GRANT');
const mergeEnabled=requestedMergePath!==undefined;
const workflowEnabled=requestedWorkflowPath!==undefined;
const reviewEnabled=requestedReviewPath!==undefined;
if(requestedInventoryPath!==undefined&&(resolve(requestedInventoryPath)!==workflowProjectPath||!reviewEnabled||!mergeEnabled||!workflowEnabled))throw new Error('INVALID_INVENTORY_FIXTURE_GRANT');
const inventoryEnabled=requestedInventoryPath!==undefined;
const projects=new Projects(store,join(sandbox,'workspaces'),[projectPath,...(mergeEnabled?[mergeProjectPath]:[]),...(workflowEnabled?[workflowProjectPath]:[])]);
// Fixture-only server approval: browser requests can select this ID, never an
// arbitrary executable/cwd/argument. The tracked test writes no source/output files.
const verificationConfig=[{projectPath,id:'e2e-node-check',label:'E2E Node fixture test',executable:process.execPath,args:['--test','check.test.mjs'],timeoutMs:10000}];
if(mergeEnabled)verificationConfig.push({projectPath:mergeProjectPath,id:'e2e-merge-node-check',label:'E2E merge fixture test',executable:process.execPath,args:['--test','check.test.mjs'],timeoutMs:10000});
if(workflowEnabled)for(const mode of ['first','second','fail','hang'])verificationConfig.push({projectPath:workflowProjectPath,id:'e2e-workflow-'+mode,label:'E2E workflow '+mode,executable:process.execPath,args:['workflow-check.mjs',mode],timeoutMs:10000});
// In-process, loopback-only protocol fixture: never a real model or proxy. Keep
// its private port stable across this run's restarts so the approved config and
// persisted catalog can be checked without changing a destination silently.
const modelCounts={total:0,models:0,chats:0,activeHangs:0,abortedHangs:0,boundedTimeouts:0,rejected:0};
const modelMock=createMockServer((req,res)=>{void (async()=>{
  modelCounts.total++;
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.authorization){modelCounts.rejected++;res.writeHead(403);res.end();return;}
  if(req.method==='GET'&&req.url==='/v1/models'){
    modelCounts.models++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;
  }
  if(req.method!=='POST'||req.url!=='/v1/chat/completions'){modelCounts.rejected++;res.writeHead(404);res.end();return;}
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>18000){modelCounts.rejected++;res.writeHead(413);res.end();return;}chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{modelCounts.rejected++;res.writeHead(400);res.end();return;}
  if(body.model!=='fixture-model'||body.stream!==true||body.max_tokens!==8||!Array.isArray(body.messages)||body.messages.length!==1||body.messages[0]?.role!=='user'||typeof body.messages[0]?.content!=='string'){
    modelCounts.rejected++;res.writeHead(400);res.end();return;
  }
  modelCounts.chats++;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
  if(body.messages[0].content.includes('ORBIT_MODEL_HUB_HANG')){
    modelCounts.activeHangs++;
    const timer=setTimeout(()=>{modelCounts.boundedTimeouts++;res.destroy();},6500);
    res.once('close',()=>{clearTimeout(timer);modelCounts.activeHangs--;if(!res.writableFinished)modelCounts.abortedHangs++;});
    res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'ORBIT_MODEL_HUB_WAITING '}}]})+'\n\n');return;
  }
  res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'ORBIT_MODEL_HUB_REPLY'}}]})+'\n\n');
  res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}})+'\n\n');res.end('data: [DONE]\n\n');
})().catch(()=>{modelCounts.rejected++;if(!res.headersSent)res.writeHead(400);res.end();});});
modelMock.requestTimeout=10000;modelMock.headersTimeout=5000;
const priorModelPort=store.getMeta('e2eModelMockPort'),modelPort=priorModelPort===null?0:Number(priorModelPort);
if(!Number.isInteger(modelPort)||modelPort<0||modelPort>65535)throw new Error('INVALID_FIXTURE_MODEL_PORT');
await new Promise((resolveListen,reject)=>{modelMock.once('error',reject);modelMock.listen(modelPort,'127.0.0.1',resolveListen);});
const modelAddress=modelMock.address();store.setMeta('e2eModelMockPort',String(modelAddress.port));
const modelHubDefinitions=[{id:'e2e-local-model',label:'E2E localhost model fixture',providerId:'local',endpoint:`http://127.0.0.1:${modelAddress.port}/v1`,
  locality:'loopback',enabled:true,projectPaths:[projectPath],models:['fixture-model'],requireCredential:false,credentialEnv:null,timeoutMs:5000,maxOutputTokens:8}];
// Explicit fourth-project fixture only. Never create an executable, read AWS
// credential values, or contact AWS. Runtime absence must precede credential IO.
if(workflowEnabled)modelHubDefinitions.push({id:'bedrock-missing-cli',label:'Bedrock CLI missing fixture',providerId:'bedrock',enabled:true,projectPaths:[workflowProjectPath],
  models:['amazon.nova-micro-v1:0'],cliPath:containedPath(root,'missing-bedrock',process.platform==='win32'?'aws.exe':'aws'),region:'us-east-1',
  credentialEnvs:{accessKeyId:'ORBIT_BEDROCK_ACCESS_KEY',secretAccessKey:'ORBIT_BEDROCK_SECRET_KEY',sessionToken:null},timeoutMs:2000,maxOutputTokens:8});
const modelHubConfig=readModelHubConfiguration(JSON.stringify(modelHubDefinitions));
// Separate explicit sixth-argument grant. This fake implements RpcPort only;
// the production native-review runner still owns consent, protocol and closure.
let reviewMode='complete',lastReview=null;
const reviewCounts={created:0,reviewStarts:0,interrupts:0,closed:0,rejectedFactory:0};
const liveReviews=new Set();
function selectedReviewWorkspace(){
  if(!reviewEnabled)throw new Error('REVIEW_FIXTURE_NOT_ENABLED');
  const selected=store.getMeta('selectedWorkspace');if(!selected)throw new Error('REVIEW_FIXTURE_NOT_SELECTED');
  const source=projects.writable(selected),project=projects.list().find(value=>value.id===source.projectId);
  if(!project||resolve(project.path)!==workflowProjectPath)throw new Error('REVIEW_FIXTURE_SCOPE_REJECTED');return source;
}
class ReviewFixtureRpc extends EventEmitter {
  constructor(source){super();this.source=source;this.mode=reviewMode;this.threadId='fixture_review_thread_'+randomUUID().replaceAll('-','');this.turnId='fixture_review_turn_'+randomUUID().replaceAll('-','');this.stage=0;this.ended=false;this.completion=null;reviewCounts.created++;liveReviews.add(this);}
  async initialize(){if(this.stage!==0)throw new Error('REVIEW_FIXTURE_RPC_REJECTED');this.stage=1;}
  async close(){if(this.ended)return;this.ended=true;if(this.completion)clearImmediate(this.completion);reviewCounts.closed++;liveReviews.delete(this);this.emit('closed');}
  async request(method,params){
    if(this.ended)throw new Error('REVIEW_FIXTURE_RPC_CLOSED');
    const reject=()=>{throw new Error('REVIEW_FIXTURE_RPC_REJECTED');};
    if(method==='account/read'){if(this.stage!==1||params?.refreshToken!==false)reject();this.stage=2;return {account:{type:'chatgpt'}};}
    if(method==='config/read'){if(this.stage!==2||params?.includeLayers!==false||params?.cwd!==this.source.path)reject();this.stage=3;return {config:{mcp_servers:{}}};}
    if(method==='thread/start'){
      if(this.stage!==3||params?.cwd!==this.source.path||params?.sandbox!=='read-only'||params?.approvalPolicy!=='untrusted'||params?.approvalsReviewer!=='user'||params?.ephemeral!==true||typeof params?.developerInstructions!=='string'||JSON.stringify(params?.config)!=='{"mcp_servers":{}}')reject();this.stage=4;
      return {thread:{id:this.threadId,status:{type:'idle'},turns:[]},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};
    }
    if(method==='mcpServerStatus/list'){if(this.stage!==4||params?.threadId!==this.threadId||params?.detail!=='toolsAndAuthOnly'||params?.limit!==100)reject();this.stage=5;return {data:[],nextCursor:null};}
    if(method==='review/start'){
      if(this.stage!==5||params?.threadId!==this.threadId||params?.delivery!=='inline'||params?.target?.type!=='custom'||typeof params?.target?.instructions!=='string'||!params.target.instructions.includes('ORBIT_E2E_REVIEW_INPUT'))reject();this.stage=6;reviewCounts.reviewStarts++;
      lastReview={workspaceId:this.source.id,threadId:this.threadId,turnId:this.turnId,mode:this.mode};
      if(this.mode==='complete')this.completion=setImmediate(()=>{if(this.ended)return;this.emit('notification',{method:'item/completed',params:{threadId:this.threadId,turnId:this.turnId,item:{id:'fixture_review_result',type:'exitedReviewMode',review:'Synthetic review fixture. No actual AI was executed. No concrete finding is asserted.'}}});this.emit('notification',{method:'turn/completed',params:{threadId:this.threadId,turn:{id:this.turnId,status:'completed',items:[]}}});});
      return {reviewThreadId:this.threadId,turn:{id:this.turnId,status:'inProgress',items:[]}};
    }
    if(method==='turn/interrupt'){if(this.stage!==6||params?.threadId!==this.threadId||params?.turnId!==this.turnId)reject();reviewCounts.interrupts++;return {};}
    return reject();
  }
}
const inventoryCounts={created:0,mcp:0,skills:0,hooks:0,closed:0,forbidden:0};
function selectedInventoryWorkspace(){if(!inventoryEnabled)throw new Error('INVENTORY_FIXTURE_NOT_ENABLED');return selectedReviewWorkspace();}
class InventoryFixtureRpc extends EventEmitter {
  constructor(source){super();this.source=source;this.threadId='fixture_inventory_'+randomUUID().replaceAll('-','');this.stage=0;this.ended=false;inventoryCounts.created++;}
  async initialize(){if(this.stage!==0)throw new Error('INVENTORY_FIXTURE_RPC_REJECTED');this.stage=1;}
  async close(){if(this.ended)return;this.ended=true;inventoryCounts.closed++;this.emit('closed');}
  async request(method,params){
    const reject=()=>{inventoryCounts.forbidden++;throw new Error('INVENTORY_FIXTURE_RPC_REJECTED');};
    if(this.ended)return reject();
    if(method==='account/read'){if(this.stage!==1||params?.refreshToken!==false)return reject();this.stage=2;return {account:{type:'chatgpt'}};}
    if(method==='config/read'){if(this.stage!==2||params?.includeLayers!==false||params?.cwd!==this.source.path)return reject();this.stage=3;return {config:{mcp_servers:{'fixture-disabled-mcp':{enabled:true,command:'ORBIT_INVENTORY_FORBIDDEN_RAW'}}}};}
    if(method==='thread/start'||method==='thread/resume'){
      if(this.stage!==3||params?.cwd!==this.source.path||params?.sandbox!=='workspace-write'||params?.approvalPolicy!=='on-request'||params?.approvalsReviewer!=='user'||JSON.stringify(params?.config?.mcp_servers)!=='{"fixture-disabled-mcp":{"enabled":false}}')return reject();
      const policy=params.config.sandbox_workspace_write;if(!policy||policy.network_access!==false||policy.exclude_tmpdir_env_var!==true||policy.exclude_slash_tmp!==true||!Array.isArray(policy.writable_roots)||policy.writable_roots.length)return reject();
      if(method==='thread/resume'){if(typeof params.threadId!=='string'||!/^fixture_inventory_[a-f0-9]{32}$/.test(params.threadId))return reject();this.threadId=params.threadId;}
      this.stage=4;return {thread:{id:this.threadId,status:{type:'idle'}},sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true},approvalPolicy:'on-request',approvalsReviewer:'user'};
    }
    if(this.stage!==4)return reject();
    if(method==='mcpServerStatus/list'){
      if(params?.threadId!==this.threadId||params?.detail!=='toolsAndAuthOnly'||params?.limit!==100)return reject();inventoryCounts.mcp++;
      return {data:[{name:'fixture-disabled-mcp',runtimeStatus:'disabled',tools:{},serverInfo:{description:'ORBIT_INVENTORY_FORBIDDEN_RAW'}}],nextCursor:null};
    }
    if(JSON.stringify(params?.cwds)!==JSON.stringify([this.source.path]))return reject();
    if(method==='skills/list'){
      if(params.forceReload!==false)return reject();inventoryCounts.skills++;
      return {data:[{cwd:this.source.path,errors:[],skills:[{name:'fixture skill',path:join(this.source.path,'ORBIT_INVENTORY_FORBIDDEN_RAW','SKILL.md'),scope:'repo',enabled:true,description:'ORBIT_INVENTORY_FORBIDDEN_RAW',dependencies:{tools:[{command:'ORBIT_INVENTORY_FORBIDDEN_RAW'}]}}]}]};
    }
    if(method==='hooks/list'){
      if(Object.keys(params).join(',')!=='cwds')return reject();inventoryCounts.hooks++;
      return {data:[{cwd:this.source.path,errors:[],warnings:[],hooks:[{key:'fixture-hook',eventName:'preToolUse',source:'project',enabled:true,handlerType:'command',trustStatus:'untrusted',command:'ORBIT_INVENTORY_FORBIDDEN_RAW',sourcePath:'ORBIT_INVENTORY_FORBIDDEN_RAW',matcher:'ORBIT_INVENTORY_FORBIDDEN_RAW'}]}]};
    }
    return reject();
  }
}
const factory=(path,write)=>{
  if(inventoryEnabled&&write===true)try{const source=selectedInventoryWorkspace();if(resolve(path)===resolve(source.path))return new InventoryFixtureRpc(source);}catch{}
  if(reviewEnabled&&write===false)try{const source=selectedReviewWorkspace();if(resolve(path)===resolve(source.path))return new ReviewFixtureRpc(source);}catch{}
  reviewCounts.rejectedFactory++;throw new Error('E2E_REAL_AI_DISABLED');
};
const controller=new Controller(store,workspace,factory,projects,verificationConfig,modelHubConfig);
const server=createHttpServer(controller,resolve(assetDirectory));
let stopping=false;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function mergeFixtureEvidence(){
  if(!mergeEnabled)throw new Error('MERGE_FIXTURE_NOT_ENABLED');
  const selected=store.getMeta('selectedWorkspace');if(!selected)throw new Error('MERGE_FIXTURE_NOT_SELECTED');
  const source=projects.writable(selected),project=projects.list().find(value=>value.id===source.projectId);
  if(!project||resolve(project.path)!==mergeProjectPath)throw new Error('MERGE_FIXTURE_SCOPE_REJECTED');
  const git=(cwd,...args)=>trustedGit(cwd,args).toString('utf8').trim();
  const indexHash=cwd=>{const path=resolve(cwd,git(cwd,'rev-parse','--git-path','index'));return sha(readFileSync(containedPath(root,relative(root,path))));};
  const files=cwd=>Object.fromEntries(['README.md','check.test.mjs','merge-proof.txt'].map(name=>{const path=containedPath(root,relative(root,cwd),name);if(!existsSync(path))return [name,{present:false}];const bytes=readFileSync(path);return [name,{present:true,bytes:bytes.length,sha256:sha(bytes)}];}));
  const snapshot=projects.snapshot(source.id),sourceDigest=projects.fingerprint(source.id);
  return {kind:'merge-fixture-evidence',projectId:project.id,workspaceId:source.id,actualAiExecuted:false,
    primary:{branch:git(project.path,'branch','--show-current'),head:git(project.path,'rev-parse','HEAD'),treeSha:git(project.path,'rev-parse','HEAD^{tree}'),status:git(project.path,'status','--porcelain'),indexSha256:indexHash(project.path),files:files(project.path)},
    source:{branch:git(source.path,'branch','--show-current'),head:git(source.path,'rev-parse','HEAD'),baseSha:source.baseSha,indexSha256:indexHash(source.path),status:git(source.path,'status','--porcelain'),sourceDigest,snapshotDigest:snapshot.sourceDigest,
      snapshotFiles:snapshot.files.map(file=>({path:file.path,mode:file.mode,presence:file.presence,...(file.presence==='present'?{bytes:file.bytes.length,sha256:sha(file.bytes)}:{})})),files:files(source.path)}};
}
function workflowFixtureEvidence(){
  if(!workflowEnabled)throw new Error('WORKFLOW_FIXTURE_NOT_ENABLED');
  const selected=store.getMeta('selectedWorkspace');if(!selected)throw new Error('WORKFLOW_FIXTURE_NOT_SELECTED');
  const source=projects.writable(selected),project=projects.list().find(value=>value.id===source.projectId);
  if(!project||resolve(project.path)!==workflowProjectPath)throw new Error('WORKFLOW_FIXTURE_SCOPE_REJECTED');
  const git=(cwd,...args)=>trustedGit(cwd,args).toString('utf8').trim();
  const indexHash=cwd=>{const path=containedPath(root,relative(root,resolve(cwd,git(cwd,'rev-parse','--git-path','index')))),stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1||stat.size>4*1024*1024)throw new Error('WORKFLOW_FIXTURE_INDEX_REJECTED');return sha(readFileSync(path));};
  const markers=cwd=>Object.fromEntries(['.workflow-order.tmp','.workflow-fail.tmp','.workflow-hang.tmp'].map(name=>{
    const path=containedPath(root,relative(root,cwd),name);if(!existsSync(path))return [name,{present:false}];
    const stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1||stat.size>4096)throw new Error('WORKFLOW_FIXTURE_MARKER_REJECTED');
    const bytes=readFileSync(path);if(bytes.length>4096)throw new Error('WORKFLOW_FIXTURE_MARKER_REJECTED');return [name,{present:true,bytes:bytes.length,sha256:sha(bytes)}];
  }));
  return {kind:'workflow-fixture-evidence',projectId:project.id,workspaceId:source.id,actualAiExecuted:false,
    primary:{head:git(project.path,'rev-parse','HEAD'),indexSha256:indexHash(project.path),markers:markers(project.path)},
    source:{head:git(source.path,'rev-parse','HEAD'),baseSha:source.baseSha,indexSha256:indexHash(source.path),sourceDigest:projects.fingerprint(source.id),markers:markers(source.path)}};
}
async function stop(){
  if(stopping)return;stopping=true;
  server.closeAllConnections();
  await new Promise(resolveClose=>server.close(resolveClose));
  await controller.close();modelMock.closeAllConnections();await new Promise(resolveClose=>modelMock.close(resolveClose));store.close();
  process.send?.({kind:'stopped'});process.disconnect?.();
}
process.on('message',message=>{
  if(message?.kind==='stop'){void stop();return;}
  if(message?.kind==='model-hub-stats'){process.send?.({kind:'model-hub-stats',port:modelAddress.port,counts:{...modelCounts},actualAiExecuted:false,externalRequests:0});return;}
  if(message?.kind==='inventory-fixture'){
    try{selectedInventoryWorkspace();if(Object.keys(message).join(',')!=='kind')throw new Error();process.send?.({kind:'inventory-fixture',counts:{...inventoryCounts},actualAiExecuted:false,actualCliExecuted:false,externalRequests:0});}
    catch{process.send?.({kind:'fixture-error',code:'INVENTORY_FIXTURE_CONTROL_FAILED'});}return;
  }
  if(message?.kind==='review-fixture'){
    try{
      selectedReviewWorkspace();if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).some(key=>!['kind','mode'].includes(key))||(Object.hasOwn(message,'mode')&&!['complete','hang'].includes(message.mode)))throw new Error();
      if(Object.hasOwn(message,'mode')){if(liveReviews.size)throw new Error();reviewMode=message.mode;}
      process.send?.({kind:'review-fixture',mode:reviewMode,counts:{...reviewCounts,active:liveReviews.size},last:lastReview?{...lastReview}:null,actualAiExecuted:false,actualCliExecuted:false,externalRequests:0});
    }catch{process.send?.({kind:'fixture-error',code:'REVIEW_FIXTURE_CONTROL_FAILED'});}return;
  }
  if(message?.kind==='merge-fixture-evidence'){
    try{process.send?.(mergeFixtureEvidence());}catch{process.send?.({kind:'fixture-error',code:'MERGE_FIXTURE_EVIDENCE_FAILED'});}return;
  }
  if(message?.kind==='workflow-fixture-evidence'){
    try{process.send?.(workflowFixtureEvidence());}catch{process.send?.({kind:'fixture-error',code:'WORKFLOW_FIXTURE_EVIDENCE_FAILED'});}return;
  }
  if(message?.kind==='seed-terminal-run'){
    try{
      const selected=store.getMeta('selectedWorkspace');if(!selected)throw new Error();
      const workspace=projects.writable(selected),project=projects.list().find(project=>project.id===workspace.projectId);
      if(!project||![projectPath,...(mergeEnabled?[mergeProjectPath]:[])].includes(resolve(project.path)))throw new Error();
      const task=new Studio(store).read(project.id,'tasks')[0];
      const taskEvidence=task?{taskId:task.id,planningVersionId:task.planningVersionId,requirementLabels:[...task.requirementLabels]}:undefined;
      const requestId='orbit-ui-synthetic-terminal-run'+(resolve(project.path)===mergeProjectPath?'-merge':''),previous=store.findRequest(requestId);
      if(previous&&(previous.run.workspaceId!==workspace.id||previous.run.taskId!==taskEvidence?.taskId||previous.run.planningVersionId!==taskEvidence?.planningVersionId))throw new Error();
      const run=previous?.run??store.createRun(requestId,'fixture-only-no-ai','Synthetic fixture terminal run. No Codex or other model was executed.',workspace.id,taskEvidence);
      store.updateRun(run.id,{execution:'completed',response:'Fixture-only seed; this is not an AI response or verification result.'},'run.completed');
      store.append('fixture.synthetic_run_seeded',run.id,{workspaceId:workspace.id,actualAiExecuted:false});
      process.send?.({kind:'synthetic-run-ready',runId:run.id,workspaceId:workspace.id,...taskEvidence});
    }catch{process.send?.({kind:'fixture-error',code:'SYNTHETIC_RUN_SEED_FAILED'});}
  }
});
process.on('disconnect',()=>{void stop();});
process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
server.on('error',error=>{console.error(error.message);void stop().finally(()=>{process.exitCode=1;});});
const port=Number(requestedPort);
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('INVALID_TEST_PORT');
server.listen(port,'127.0.0.1',()=>{const address=server.address();process.send?.({kind:'ready',port:address.port,url:`http://127.0.0.1:${address.port}`});});
