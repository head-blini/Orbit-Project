#!/usr/bin/env node
// LIVE smoke: root must review this file before its one authorized execution.
// Uses only the official native Codex App Server and its existing ChatGPT login.
// No installation, auth-file reads, HOME changes, paid API fallback or external HTTP UI server.
// All writes/commits target this script's new disposable repository, worktree and DB.
// One turn/start is NOT a guarantee of one internal model request or a token/cost cap.
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,delimiter,isAbsolute,posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { crc32,inflateRawSync } from 'node:zlib';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
import { Controller } from '../server/controller.ts';
import { Studio } from '../server/studio.ts';
import { codexFactory } from '../server/codex.ts';
import { readVerificationConfiguration } from '../server/verification-service.ts';
import { buildChildEnv } from '../server/child-env.ts';
import { terminal } from '../shared/types.ts';

const before='export const greeting = "before";\n',after='export const greeting = "Orbit";\n';
const checkSource=`import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.equal(readFileSync(new URL('./greeting.ts',import.meta.url),'utf8'),${JSON.stringify(after)},'ORBIT_GREETING_MISMATCH');
console.log('ORBIT_CHECK_OK');
`;
const result={status:'not_run',stage:'setup',exitCode:1,evidenceDirectory:null,
  flags:{fixtureCreated:false,planApproved:false,taskCreated:false,connected:false,taskLinked:false,agentCompleted:false,
    oneNativeTurn:false,oneFileChange:false,strictDiff:false,checkUnchanged:false,sourceUnchanged:false,
    checkPassed:false,approvalServiceExercised:false,approvalCurrent:false,pptxVerified:false,markdownVerified:false,
    fixtureApprovalsOnly:true,httpBrowserE2E:false,powerPointGuiVerified:false,cleanupComplete:false},
  counts:{nativeProcesses:0,nativeTurns:0,fileChanges:0,approvalDenials:0},verificationExitCode:null,
  usageReadAttempted:false,usageStatus:'not_run'};
let directory,root,base,gitBinary,store,controller,nativeRpc,workspace,stopRequested=false,cleanupFailed=false,watchdog;
const requireThat=condition=>{if(!condition)throw new Error('SMOKE_REQUIREMENT_FAILED');};
const sha=value=>createHash('sha256').update(value).digest('hex');
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
function stopping(){if(stopRequested)throw new Error('SMOKE_INTERRUPTED');}
function interrupt(){
  stopRequested=true;
  if(nativeRpc)void nativeRpc.close().catch(()=>{cleanupFailed=true;});
  if(controller)void controller.verification.close().catch(()=>{cleanupFailed=true;});
}
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);

function git(cwd,...args){
  const env={...buildChildEnv(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',
    GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''};
  return execFileSync(gitBinary,['--no-pager','--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','commit.gpgSign=false','-c','protocol.allow=never',...args],{cwd,env,encoding:'utf8',windowsHide:true,
    shell:false,stdio:'pipe',timeout:15000,maxBuffer:1024*1024});
}
function originalUnchanged(){
  return git(root,'rev-parse','HEAD').trim()===base&&git(root,'branch','--show-current').trim()==='main'
    &&git(root,'status','--porcelain')===''
    &&readFileSync(join(root,'greeting.ts'),'utf8')===before&&readFileSync(join(root,'check.mjs'),'utf8')===checkSource;
}

// Independent ZIP consumer: central directory + Node CRC/inflater, without extracting paths.
function inspectPptx(bytes){
  const zip=Buffer.from(bytes),parts=new Map();requireThat(zip.length>=22&&zip.readUInt32LE(0)===0x04034b50);
  const end=zip.length-22;requireThat(zip.readUInt32LE(end)===0x06054b50);
  let offset=zip.readUInt32LE(end+16);const start=offset,count=zip.readUInt16LE(end+10);
  for(let i=0;i<count;i++){
    requireThat(zip.readUInt32LE(offset)===0x02014b50);
    const method=zip.readUInt16LE(offset+10),length=zip.readUInt32LE(offset+20),size=zip.readUInt32LE(offset+24);
    const nameLength=zip.readUInt16LE(offset+28),extra=zip.readUInt16LE(offset+30),comment=zip.readUInt16LE(offset+32),local=zip.readUInt32LE(offset+42);
    const name=zip.subarray(offset+46,offset+46+nameLength).toString('utf8');
    requireThat(!(zip.readUInt16LE(offset+8)&1)&&!parts.has(name)&&!name.startsWith('/')&&!name.split('/').includes('..'));
    requireThat(zip.readUInt32LE(local)===0x04034b50&&(method===0||method===8));
    const bodyStart=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28),packed=zip.subarray(bodyStart,bodyStart+length);
    const body=method===8?inflateRawSync(packed):packed;
    requireThat(body.length===size&&crc32(body)===zip.readUInt32LE(offset+16));
    parts.set(name,body.toString('utf8'));offset+=46+nameLength+extra+comment;
  }
  requireThat(offset===end&&offset-start===zip.readUInt32LE(end+12));
  for(const part of ['[Content_Types].xml','_rels/.rels','ppt/presentation.xml','ppt/slides/slide1.xml',
    'ppt/slideMasters/slideMaster1.xml','ppt/slideLayouts/slideLayout1.xml','ppt/theme/theme1.xml'])requireThat(parts.has(part));
  for(const [name,xml] of parts){
    requireThat(!/<!DOCTYPE|<!ENTITY|TargetMode="External"|macroEnabled|vbaProject/.test(xml));
    if(name.endsWith('.rels')){
      const basePath=name==='_rels/.rels'?'':posix.dirname(posix.dirname(name));
      const targets=[...xml.matchAll(/<Relationship\s+Id="[^"]+"\s+Type="[^"]+"\s+Target="([^"]+)"\s*\/>/g)];
      requireThat(targets.length>0&&targets.every(match=>parts.has(posix.normalize(posix.join(basePath,match[1])))));
    }
  }
  const slide=parts.get('ppt/slides/slide1.xml');
  requireThat((slide.match(/<p:sp>/g)??[]).length===8&&(slide.match(/<p:cxnSp>/g)??[]).length===3);
  requireThat(slide.includes('Orbit patch')&&!/<p:pic|<a:blip/.test(slide));
  const shapeIds=new Set([...slide.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="(\d+)"/g)].map(match=>match[1]));
  const endpoints=[...slide.matchAll(/<a:(?:stCxn|endCxn) id="(\d+)"/g)];
  requireThat(endpoints.length===6&&endpoints.every(match=>shapeIds.has(match[1])));
}

try{
  requireThat(process.argv.length===2&&Number(process.versions.node.split('.')[0])===24);
  gitBinary=(process.env.PATH??'').split(delimiter).filter(isAbsolute)
    .map(path=>join(path,process.platform==='win32'?'git.exe':'git')).find(path=>existsSync(path)&&lstatSync(path).isFile());
  requireThat(!!gitBinary);
  directory=mkdtempSync(join(tmpdir(),'orbit-approved-live-'));result.evidenceDirectory=directory;
  root=join(directory,'source');mkdirSync(root);mkdirSync(join(directory,'artifacts'));
  git(root,'init','-q','-b','main');
  writeFileSync(join(root,'greeting.ts'),before);writeFileSync(join(root,'check.mjs'),checkSource);
  git(root,'add','greeting.ts','check.mjs');
  git(root,'-c','user.name=Orbit Smoke','-c','user.email=orbit@example.invalid','commit','-qm','isolated approved workflow fixture');
  base=git(root,'rev-parse','HEAD').trim();
  store=new Store(join(directory,'test.sqlite'));
  const projects=new Projects(store,join(directory,'workspaces'),[root]),project=projects.register(root);
  workspace=projects.create(project.id);result.flags.fixtureCreated=true;
  const config=readVerificationConfiguration(JSON.stringify([{projectPath:root,id:'exact-orbit',label:'Exact greeting assertion',
    executable:process.execPath,args:['check.mjs'],timeoutMs:10000}]));
  controller=new Controller(store,workspace.path,(path,write)=>{
    requireThat(result.counts.nativeProcesses===0);result.counts.nativeProcesses++;
    const rpc=codexFactory(path,write)();nativeRpc=rpc;
    const request=rpc.request.bind(rpc);
    rpc.request=(method,params)=>{
      if(method==='turn/start'){
        if(result.counts.nativeTurns!==0)return Promise.reject(new Error('SMOKE_TURN_LIMIT'));
        result.counts.nativeTurns++;
      }
      return request(method,params);
    };
    rpc.on('notification',event=>{
      if(event.method==='item/completed'&&event.params?.item?.type==='fileChange'){
        result.counts.fileChanges++;
        if(event.params.item.status!=='completed'||result.counts.fileChanges>1)interrupt();
      }
    });
    return rpc;
  },projects,config);
  watchdog=setTimeout(interrupt,180000);
  const studio=new Studio(store);
  result.stage='planning';
  const planSource={schema_version:'1.0',title:'Approved isolated greeting smoke',
    goal:'Make the one approved greeting.ts patch in the selected disposable worktree.',
    requirements:[{id:'REQ-1',description:'Use apply_patch exactly once to change greeting.ts from '+JSON.stringify(before)+' to '+JSON.stringify(after)+'.',
      acceptance_criteria:['greeting.ts exactly matches the approved Orbit text with a final newline.','check.mjs remains byte-for-byte unchanged.','Only greeting.ts changes.']}],
    constraints:['Use only apply_patch for the single file edit inside the current worktree.','Do not use shell, network, other agents or external tools.',
      'Do not edit check.mjs, configuration, .git, protected directories or any original project file.','Do not install, commit, merge or alter authentication.',
      'Do not run checks yourself. The server will run the fixed check after your turn.','After the successful patch, respond with ORBIT_EDIT_DONE.'],open_questions:[],decisions:[]};
  const plan=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify(planSource)}});
  const approved=studio.mutate(project.id,'plans',plan.id,'approve',{expectedRevision:plan.revision});
  requireThat(approved.state==='approved');result.flags.planApproved=true;
  const tasks=studio.mutate(project.id,'plans',approved.id,'task-drafts',{});
  requireThat(Array.isArray(tasks)&&tasks.length===1&&tasks[0].planningVersionId===approved.id);result.flags.taskCreated=true;
  result.stage='native_connection';stopping();
  await controller.selectWorkspace(workspace.id);await controller.connect();stopping();
  requireThat(controller.snapshot().provider==='ready');result.flags.connected=true;
  result.stage='usage_read';result.usageReadAttempted=true;
  // One read-only refresh: account/rateLimits/read and account/usage/read.
  // Unavailable usage is metadata, never a workflow pass/fail condition.
  try{
    const usage=await controller.refreshUsage();
    result.usageStatus=['unknown','partial','available'].includes(usage?.status)?usage.status:'unknown';
  }catch{result.usageStatus='unknown';}
  stopping();
  result.stage='native_task';const deadline=Date.now()+125000;
  const run=await controller.submitTask(project.id,tasks[0].id,{requestId:randomUUID(),workspaceId:workspace.id});
  while(!terminal(store.getRun(run.id)?.execution)&&Date.now()<deadline){stopping();await pause();}
  stopping();const completed=store.getRun(run.id);
  requireThat(completed?.taskId===tasks[0].id&&completed.planningVersionId===approved.id);result.flags.taskLinked=true;
  requireThat(completed.execution==='completed');result.flags.agentCompleted=true;
  requireThat(result.counts.nativeTurns===1);result.flags.oneNativeTurn=true;
  requireThat(result.counts.fileChanges===1);result.flags.oneFileChange=true;
  result.stage='diff';
  requireThat(readFileSync(join(workspace.path,'greeting.ts'),'utf8')===after);
  requireThat(readFileSync(join(workspace.path,'check.mjs'),'utf8')===checkSource);result.flags.checkUnchanged=true;
  requireThat(git(workspace.path,'diff','--name-only','-z','HEAD','--')==='greeting.ts\0');
  requireThat(git(workspace.path,'ls-files','--others','--exclude-standard','-z')==='');
  requireThat(['.codex','.agents','.aws'].every(name=>readdirSync(join(workspace.path,name)).length===0));
  const diff=projects.diff(workspace.id);
  requireThat(diff.files.length===1&&diff.files[0].path==='greeting.ts'&&diff.files[0].patch?.includes('+export const greeting = "Orbit";'));
  result.flags.strictDiff=true;requireThat(originalUnchanged());result.flags.sourceUnchanged=true;
  result.stage='verification';stopping();
  const preview=controller.verification.view(workspace.id,run.id);
  requireThat(preview.commands.length===1&&preview.sourceDigest&&!preview.canApprove);
  const check=controller.startVerification({requestId:randomUUID(),runId:run.id,workspaceId:workspace.id,commandId:'exact-orbit',
    expectedSourceDigest:preview.sourceDigest,expectedConfigDigest:preview.commands[0].configDigest});
  await controller.verification.settle();stopping();
  const verified=controller.verification.view(workspace.id,run.id),evidence=verified.checks.find(record=>record.id===check.id);
  result.verificationExitCode=evidence?.exitCode??null;
  requireThat(evidence?.execution==='completed'&&evidence.verdict==='passed'&&evidence.exitCode===0
    &&evidence.sourceDigest===preview.sourceDigest&&evidence.finishedDigest===preview.sourceDigest&&verified.canApprove);
  result.flags.checkPassed=true;
  // This authorized script attests the fixed fixture diff; it is not a human browser click.
  result.stage='fixture_review_approval';
  const approval=controller.approveVerification({requestId:randomUUID(),runId:run.id,workspaceId:workspace.id,
    expectedSourceDigest:verified.sourceDigest,expectedCheckSetDigest:verified.checkSetDigest});
  result.flags.approvalServiceExercised=true;
  requireThat(controller.verification.view(workspace.id,run.id).approvalCurrent);result.flags.approvalCurrent=true;
  result.stage='artifact_export';stopping();
  const graph={nodes:[{id:'plan',label:'Approved plan',kind:'plan'},{id:'patch',label:'Orbit patch',kind:'source'},
    {id:'check',label:'Exact Node check',kind:'evidence'},{id:'approval',label:'Fixture review approval',kind:'approval'}],
    edges:[{from:'plan',to:'patch'},{from:'patch',to:'check'},{from:'check',to:'approval'}]};
  const source=JSON.stringify(graph);
  const artifact=studio.mutate(project.id,'artifacts',undefined,undefined,{requestId:randomUUID(),input:{kind:'architecture',source,
    metadata:{title:'Approved workflow smoke',runId:run.id,checkId:check.id,approvalId:approval.id,sourceDigest:verified.sourceDigest}}});
  const pptx=studio.exportArtifact(project.id,artifact.id,artifact.revision,artifact.contentHash,'pptx');
  inspectPptx(pptx.bytes);requireThat(pptx.mime==='application/vnd.openxmlformats-officedocument.presentationml.presentation');
  writeFileSync(join(directory,'artifacts',pptx.filename),pptx.bytes);result.flags.pptxVerified=true;
  const markdown=studio.exportArtifact(project.id,artifact.id,artifact.revision,artifact.contentHash,'markdown');
  const expected=`# Orbit Artifact\n\nVersion: ${artifact.revision}\nSHA-256: ${sha(source)}\n\n\`\`\`json\n${source}\n\`\`\`\n`;
  requireThat(Buffer.from(markdown.bytes).equals(Buffer.from(expected,'utf8'))&&markdown.mime==='text/markdown; charset=utf-8');
  writeFileSync(join(directory,'artifacts',markdown.filename),markdown.bytes);result.flags.markdownVerified=true;
  requireThat(originalUnchanged());stopping();result.status='passed';result.stage='complete';
}catch{
  result.status=stopRequested?'interrupted':'failed';
}finally{
  clearTimeout(watchdog);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  try{if(controller)await controller.close();else if(nativeRpc)await nativeRpc.close();}catch{cleanupFailed=true;}
  if(root&&base)try{result.flags.sourceUnchanged=originalUnchanged();}catch{result.flags.sourceUnchanged=false;}
  if(store){
    try{result.counts.approvalDenials=store.eventsAfter(0).filter(event=>event.kind==='approval.denied').length;}catch{cleanupFailed=true;}
    try{store.close();}catch{cleanupFailed=true;}
  }
  result.flags.cleanupComplete=!cleanupFailed;
  if(result.status==='passed'&&(!result.flags.sourceUnchanged||cleanupFailed||stopRequested))result.status=stopRequested?'interrupted':'failed';
  result.exitCode=result.status==='passed'?0:1;
  if(directory)try{writeFileSync(join(directory,'summary.json'),JSON.stringify(result,null,2)+'\n');}catch{result.status='failed';result.exitCode=1;result.flags.cleanupComplete=false;}
  // Fixed enums, booleans, counters, exit code and owned evidence path only.
  // No raw RPC, account/config responses, provider response text or stderr are printed.
  console.log(JSON.stringify(result));process.exitCode=result.exitCode;
}
