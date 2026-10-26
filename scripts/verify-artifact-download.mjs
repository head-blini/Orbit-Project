#!/usr/bin/env node
// Narrow Windows browser-download probe; no model, user DB, installation or full E2E.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter,dirname,isAbsolute,join,posix,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32,inflateRawSync } from 'node:zlib';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
import { Controller } from '../server/controller.ts';
import { Studio } from '../server/studio.ts';
import { createWorkspace } from '../server/workspace.ts';
import { createHttpServer } from '../server/http.ts';
import { buttonRef,cliData,containedPath,findAgentBrowser,isolatedEnvironment,runProcess } from './lib/orbit-ui-e2e.ts';

if(process.argv.length!==2)throw new Error('NO_ARGUMENTS_SUPPORTED');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=mkdtempSync(join(tmpdir(),'orbit-download-'));
const out=(...parts)=>containedPath(root,...parts);
for(const directory of ['source','downloads','baseline','logs'])mkdirSync(out(directory));
writeFileSync(out('owned.json'),JSON.stringify({purpose:'Orbit isolated artifact browser-download probe',ownerPid:process.pid}));
const env=isolatedEnvironment(process.env),session='orbit-download-'+randomUUID();
const config=out('agent-browser.json');writeFileSync(config,'{}\n');
const emptyGitConfig=out('empty.gitconfig');writeFileSync(emptyGitConfig,'');
Object.assign(env,{GIT_CONFIG_GLOBAL:emptyGitConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
const report={status:'running',startedAt:new Date().toISOString(),runDir:root,
  actualAiExecuted:false,productFilesChanged:false,sourcePreserved:false,
  method:'plain --download-path at launch; product UI button click; verify actual disk bytes',
  downloads:[],baseline:{status:'not_run'},cleanupErrors:[],limitations:[
    'Windows native agent-browser/Chrome probe only; no PowerPoint GUI edit verification.',
    'Dedicated fixture Studio record seeded with production service; browser UI exports real HTTP bytes.',
    'Windows canonicalized path is a source-based hypothesis unless separately observed; probe compares public CLI paths.'
  ]};
let store,controller,server,browserAttempted=false,number=0,binary;
const signal=new AbortController();
const interrupt=()=>signal.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
async function browser(args,allowFailure=false,cleanup=false){
  const result=await runProcess(binary,['--config',config,'--session',session,'--namespace',session,
    '--engine','chrome','--allowed-domains','127.0.0.1','--download-path',out('downloads'),
    '--idle-timeout','3m','--json',...args],{cwd:root,env:{...env,AGENT_BROWSER_DEFAULT_TIMEOUT:'15000'},
    timeoutMs:cleanup?15000:45000,signal:cleanup?undefined:signal.signal});
  writeFileSync(out('logs',String(++number).padStart(2,'0')+'.json'),JSON.stringify({args,...result},null,2));
  if(!allowFailure){assert.equal(result.code,0,'BROWSER_COMMAND_FAILED');cliData(result.stdout);}
  return result;
}
async function click(label,prefix=false){
  const snapshot=await browser(['snapshot','-i']);
  const ref=buttonRef(snapshot.stdout,label,prefix);
  await browser(['scrollintoview',ref]);await browser(['click',ref]);
}
async function diskFile(filename,expected){
  const path=out('downloads',filename),deadline=Date.now()+15000;
  while(Date.now()<deadline){
    if(signal.signal.aborted)throw new Error('PROBE_INTERRUPTED');
    if(existsSync(path)&&!existsSync(path+'.crdownload')){
      const bytes=readFileSync(path);
      if(bytes.equals(expected))return {path,bytes};
    }
    await new Promise(resolveWait=>setTimeout(resolveWait,100));
  }
  throw new Error('BROWSER_FILE_NOT_SAVED_OR_BYTES_MISMATCH');
}
// Independently read the ZIP central directory, local records and CRC, without
// importing the product serializer's ZIP writer or relying on signature alone.
function inspectPptx(bytes){
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  const end=bytes.length-22,count=bytes.readUInt16LE(end+10),start=bytes.readUInt32LE(end+16),parts=new Map();
  let offset=start;
  for(let i=0;i<count;i++){
    assert.equal(bytes.readUInt32LE(offset),0x02014b50);
    const method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24);
    const names=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
    const name=bytes.subarray(offset+46,offset+46+names).toString('utf8');assert.ok(!parts.has(name));
    assert.equal(bytes.readUInt32LE(local),0x04034b50);
    assert.equal(bytes.subarray(local+30,local+30+bytes.readUInt16LE(local+26)).toString('utf8'),name);
    const dataStart=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    const data=bytes.subarray(dataStart,dataStart+compressed);assert.ok(method===0||method===8);
    const plain=method===0?data:inflateRawSync(data);assert.equal(plain.length,size);assert.equal(crc32(plain),crc);
    parts.set(name,plain.toString('utf8'));offset+=46+names+extra+comment;
  }
  assert.equal(offset,end);assert.equal(offset-start,bytes.readUInt32LE(end+12));
  for(const name of ['[Content_Types].xml','_rels/.rels','ppt/presentation.xml','ppt/slides/slide1.xml',
    'ppt/slideMasters/slideMaster1.xml','ppt/slideLayouts/slideLayout1.xml','ppt/theme/theme1.xml'])assert.ok(parts.has(name));
  for(const [name,xml] of parts){
    assert.ok(!/<!DOCTYPE|<!ENTITY|TargetMode="External"|vbaProject|macroEnabled/.test(xml));
    if(name.endsWith('.rels'))for(const match of xml.matchAll(/<Relationship\s+Id="[^"]+"\s+Type="[^"]+"\s+Target="([^"]+)"\s*\/>/g)){
      const base=name==='_rels/.rels'?'':posix.dirname(posix.dirname(name));assert.ok(parts.has(posix.normalize(posix.join(base,match[1]))));
    }
  }
  const slide=parts.get('ppt/slides/slide1.xml');
  assert.equal((slide.match(/<p:sp>/g)??[]).length,5);assert.equal((slide.match(/<p:cxnSp>/g)??[]).length,1);
  assert.ok(slide.includes('Download Browser')&&slide.includes('\uD55C\uAE00 Local Server')&&!/<p:pic|<a:blip/.test(slide));
  const ids=new Set([...slide.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="(\d+)"/g)].map(match=>match[1]));
  const endpoints=[...slide.matchAll(/<a:(?:stCxn|endCxn) id="(\d+)"/g)];
  assert.equal(endpoints.length,2);assert.ok(endpoints.every(match=>ids.has(match[1])));
  return {parts:parts.size,editableShapes:5,editableConnectors:1};
}
try{
  assert.ok(existsSync(join(repo,'dist','app.js')),'EXISTING_PRODUCT_BUILD_REQUIRED');
  report.buildSha256=sha(readFileSync(join(repo,'dist','app.js')));
  try{binary=findAgentBrowser();}catch(error){
    // Managed shells may omit npm's existing global bin directory from PATH.
    // Resolve the already-installed native binary; never install or alter PATH.
    const existing=process.platform==='win32'&&process.env.APPDATA?
      join(process.env.APPDATA,'npm','node_modules','agent-browser','bin',`agent-browser-win32-${process.arch}.exe`):null;
    if(!existing||!existsSync(existing))throw error;binary=existing;
  }
  const version=await runProcess(binary,['--version'],{cwd:root,env,timeoutMs:10000});assert.equal(version.code,0);
  report.agentBrowserVersion=version.stdout.trim();
  const gitBinary=(process.env.PATH??'').split(delimiter).filter(isAbsolute)
    .map(path=>join(path,process.platform==='win32'?'git.exe':'git')).find(existsSync);assert.ok(gitBinary);
  const git=(...args)=>execFileSync(gitBinary,['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
    {cwd:out('source'),env,encoding:'utf8',windowsHide:true,shell:false,timeout:15000,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(out('source','README.md'),'Orbit isolated artifact download fixture\n');
  git('add','README.md');git('-c','user.name=Orbit Download','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','owned download fixture');
  const originalHead=git('rev-parse','HEAD');
  store=new Store(out('fixture.sqlite'));const projects=new Projects(store,out('workspaces'),[out('source')]);
  const project=projects.register(out('source'));
  controller=new Controller(store,createWorkspace(root),()=>{throw new Error('DOWNLOAD_PROBE_AI_DISABLED');},projects);
  const studio=new Studio(store),title='Orbit browser download fixture';
  const source='flowchart TD\n  browser["Download Browser"]\n  server["\uD55C\uAE00 Local Server"]\n  browser -->|HTTP| server';
  const artifact=studio.mutate(project.id,'artifacts',undefined,undefined,{requestId:randomUUID(),input:{kind:'mermaid',source,metadata:{title}}});
  report.artifact={id:artifact.id,revision:artifact.revision,contentHash:artifact.contentHash};
  const expected=new Map(['pptx','markdown'].map(format=>[format,studio.exportArtifact(project.id,artifact.id,artifact.revision,artifact.contentHash,format)]));
  server=createHttpServer(controller,join(repo,'dist'));
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  const address=`http://127.0.0.1:${server.address().port}`;
  browserAttempted=true;await browser(['open',address+'/#/visualization']);
  await browser(['wait','--fn','!!document.querySelector(".viz-studio")']);
  await click(title+' \u00B7',true);
  await browser(['wait','--fn','[...document.querySelectorAll(".viz-studio button")].some(button=>button.textContent==="PPTX \uB0B4\uBCF4\uB0B4\uAE30"&&!button.disabled)']);
  for(const [format,label] of [['pptx','PPTX \uB0B4\uBCF4\uB0B4\uAE30'],['markdown','Markdown \uB0B4\uBCF4\uB0B4\uAE30']]){
    const target=expected.get(format);await click(label);const saved=await diskFile(target.filename,target.bytes);
    const details=format==='pptx'?inspectPptx(saved.bytes):{sourceExact:saved.bytes.toString('utf8').includes(source),versionExact:saved.bytes.toString('utf8').includes('Version: 1')};
    if(format==='markdown')assert.ok(details.sourceExact&&details.versionExact);
    report.downloads.push({format,path:saved.path,bytes:saved.bytes.length,sha256:sha(saved.bytes),...details});
  }
  assert.deepEqual(cliData((await browser(['errors'])).stdout).errors,[]);
  // Controlled A/B: the same product button in the same browser, only changing
  // from launch's plain directory behavior to download command's path handling.
  const ref=buttonRef((await browser(['snapshot','-i'])).stdout,'PPTX \uB0B4\uBCF4\uB0B4\uAE30');
  const baseline=await browser(['download',ref,out('baseline','artifact.pptx')],true);
  let baselineMessage;try{baselineMessage=JSON.parse(baseline.stdout).error;}catch{}
  report.baseline={status:baseline.code===0?'saved':baselineMessage==='Download was canceled'?'canceled':'failed',exitCode:baseline.code};
  if(baseline.code===0)inspectPptx(readFileSync(out('baseline','artifact.pptx')));
  report.downloadDirectoryFiles=readdirSync(out('downloads'));
  report.sourcePreserved=git('rev-parse','HEAD')===originalHead&&git('status','--porcelain')===''&&readFileSync(out('source','README.md'),'utf8')==='Orbit isolated artifact download fixture\n';
  assert.equal(report.sourcePreserved,true);report.status='passed';
}catch(error){
  report.status='failed';report.failure=error instanceof Error?error.message:'PROBE_FAILED';
  if(browserAttempted)try{await browser(['snapshot','-i'],true,true);}catch{}
}
finally{
  if(browserAttempted)try{await browser(['close'],false,true);}catch{report.cleanupErrors.push('OWNED_BROWSER_CLOSE_FAILED');}
  if(server)try{server.closeAllConnections();await new Promise((resolveClose,reject)=>server.close(error=>error?reject(error):resolveClose()));}catch{report.cleanupErrors.push('OWNED_HTTP_CLOSE_FAILED');}
  if(controller)try{await controller.close();}catch{report.cleanupErrors.push('OWNED_CONTROLLER_CLOSE_FAILED');}
  if(store)try{store.close();}catch{report.cleanupErrors.push('OWNED_STORE_CLOSE_FAILED');}
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  if(report.cleanupErrors.length)report.status='failed';report.finishedAt=new Date().toISOString();
  writeFileSync(out('result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,runDir:root,downloads:report.downloads.map(item=>({format:item.format,bytes:item.bytes})),
    baseline:report.baseline.status,sourcePreserved:report.sourcePreserved,cleanupErrors:report.cleanupErrors}));
  process.exitCode=report.status==='passed'?0:1;
}
