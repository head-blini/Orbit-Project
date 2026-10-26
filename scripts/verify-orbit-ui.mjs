#!/usr/bin/env node
// Run in normal PowerShell: node scripts/verify-orbit-ui.mjs
// Sandbox-safe: node scripts/verify-orbit-ui.mjs --check-only (never launches a browser).
import assert from 'node:assert/strict';
import { appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { dirname,join,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parsePlanningDraft } from '../server/planning/parser.ts';
import { trustedGit } from '../server/git-process.ts';
import { fingerprintWorkspace } from '../server/workspace-fingerprint.ts';
import { buttonRef,cliData,evalResult,containedPath,findAgentBrowser,isolatedEnvironment,overallStatus,phaseSignal,runProcess,stopOwnedProcess } from './lib/orbit-ui-e2e.ts';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const args=process.argv.slice(2);
if(args.includes('--help')){
  console.log('node scripts/verify-orbit-ui.mjs [--check-only]\nDefault: typecheck, full tests, build, isolated local Chrome E2E.\n--check-only: static checks and tests only; browser scenarios are NOT RUN.\nEvidence: Windows OS temp/orbit-e2e-*; other platforms .local/ui-e2e/<unique-run>/; latest report: docs/ORBIT-E2E-RESULTS.md');
  process.exit(0);
}
if(args.some(arg=>arg!=='--check-only'))throw new Error('Unknown argument. Only --check-only is supported; arbitrary URLs/DB/project paths are intentionally unavailable.');
const checkOnly=args.includes('--check-only');
// Short Windows fixture paths avoid Git's legacy MAX_PATH limit without changing
// Git/OS policies. Every fixture, DB and evidence file stays under this owned root.
const outputRoot=process.platform==='win32'?tmpdir():containedPath(repo,'.local','ui-e2e');mkdirSync(outputRoot,{recursive:true});
const runDir=mkdtempSync(join(outputRoot,process.platform==='win32'?'orbit-e2e-':'run-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'));
const out=(...parts)=>containedPath(runDir,...parts);
mkdirSync(out('screenshots'));mkdirSync(out('logs'));mkdirSync(out('sandbox'));mkdirSync(out('downloads'));
writeFileSync(out('commands.jsonl'),'');
writeFileSync(out('e2e-owned.json'),JSON.stringify({purpose:'Orbit isolated UI E2E',createdAt:new Date().toISOString(),ownerPid:process.pid}));
const session='orbit-e2e-'+randomUUID();
const env=isolatedEnvironment(process.env);
const gitConfig=out('sandbox','empty.gitconfig');writeFileSync(gitConfig,'');
Object.assign(env,{GIT_CONFIG_GLOBAL:gitConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
const config=out('sandbox','agent-browser.json');writeFileSync(config,'{}\n');
const browserEnv={...env,AGENT_BROWSER_DEFAULT_TIMEOUT:'15000'};
const menus=[['dashboard','대시보드'],['projects','프로젝트'],['planning','기획 스튜디오'],['agents','에이전트 센터'],['development','개발'],['visualization','시각화 스튜디오'],['automation','자동화'],['providers','모델 제공자'],['extensions','확장 기능'],['security','개인정보 및 보안'],['usage','사용량 및 분석'],['settings','설정']];
const names=['CLI 설치·명령 확인','스크립트 정적 검사','타입 검사','전체 테스트','제품 빌드','임시 Git·DB 서버','Chrome 접속','전체 메뉴 이동','프로젝트 등록·선택','작업 공간·Git Diff','Planning 저장·승인·Task','Visualization 저장·복구','모의 개인정보 반출 차단','새로고침 데이터 복원','서버 재시작 데이터 복원','1366×768 전체 메뉴·캡처','1744×864 전체 메뉴·캡처','원본 fixture 보존','실제 Node 검증·사용자 승인','소스 변경 후 검증 무효화·복구','실제 소스 그래프·파일 탐색·Artifact','소스 그래프·Artifact 무효화·복구','Model Hub 명시 동의·로컬 HTTP·반출 차단','Model Hub 중단·이력 복구','Planning MD·JSON 실제 다운로드·재가져오기','Planning 개발 증거·질문 폐기·승인 보존','Merge 전용 검증·리뷰 승인·후보 생성','Merge 별도 승인·실제 ff 반영·source 보존','Merge 새로고침·재시작 기록 복구'];
const report={runDir,startedAt:new Date().toISOString(),mode:checkOnly?'check-only':'browser-e2e',status:'running',session,legacyUiStepCount:18,steps:names.map(name=>({name,status:'not_run'})),screenshots:[],cleanupErrors:[],limitations:['실제 Codex/외부 AI 추론은 의도적으로 비활성화; 성공한 연결·응답·중단 검증 대상 아님.','검증 단계의 terminal Run은 전용 fixture 서버 IPC로 생성한 synthetic 기록이다. 실제 Codex 실행으로 주장하지 않는다. Node --test 검증 명령만 서버에 고정 등록하고 disposable worktree에서 실제 실행한다.','소스 그래프는 새 disposable worktree에 직접 만든 두 TS 파일의 정적 import·함수 호출과 파일 탐색·Artifact 연결을 검사한다. 동적 실행·전체 런타임 정확성·의존 패키지 분석을 보장하지 않는다.','Capability Registry는 GET·표시·확장 필터만 검사하며 로컬 CLI 버전 진단 버튼은 누르지 않는다. 실행 모드는 설명 열기만 검사하며 모델·확장 설치·모드 실행은 하지 않는다.','Usage는 연결하지 않은 fixture의 GET·unknown·계정 전체 범위·조회 버튼 비활성·과금 전환 없음 표시만 확인한다. 공식 사용량 조회 버튼은 누르지 않으며 실제 계정 RPC·quota·token 활동은 조회하지 않는다.','브라우저 파일 다운로드는 이번 E2E에 포함하지 않는다. 이전 CLI download <ref> <path> 경로의 Download was canceled 실패는 남아 있다. 별도 전용 fixture에서는 launch --download-path와 제품 버튼 click으로 실제 PPTX·Markdown 파일 및 bytes를 검증했다(docs/visualization/DOWNLOAD-RESULTS.md). 이번 run은 다운로드 재검증·CLI 결함 수정·PowerPoint GUI 편집 성공을 주장하지 않는다.','자동 레이아웃 검사는 viewport/가로 넘침/메뉴 경계 검사이며 시각적 품질 전체를 증명하지 않음.']};
report.limitations.push('Model Hub는 전용 child의 127.0.0.1 HTTP fixture를 실제 제품 transport로 호출한다. literal text/SSE/합성 usage/중단/이력만 검증하며 실제 모델 추론·외부 서비스·인증·요금·Bedrock 지원을 검증하지 않는다. 모델 기본 설정은 제품에서 활성화하지 않으며 fixture의 정확한 프로젝트 경로만 허용한다.');
report.limitations=report.limitations.map(item=>item.startsWith('브라우저 파일 다운로드는')?'이번 브라우저 다운로드는 저장 기획 MD/JSON와 수동 handoff Markdown만 검사한다. plain --download-path와 제품 버튼 click을 사용하며 CLI download 명령은 사용하지 않는다. Artifact PPTX/MD 저장은 별도 증거(docs/visualization/DOWNLOAD-RESULTS.md)이며 이번에 재검증하지 않는다.':item);
report.limitations.push('Planning feedback은 실제 AI 실행 대신 Task metadata가 결합된 synthetic terminal Run과 실제 Node Check/현재성 조회를 사용한다. 저장 파일 bytes·parser roundtrip·UI 파일 재가져오기·별도 draft 저장을 검사하며 외부 AI 전달이나 기존 승인·Task 변경은 하지 않는다.');
report.limitations.push('Merge는 별도로 만든 세 번째 disposable repository의 primary에만 UI 명시 승인 후 실제 fast-forward를 수행한다. 이전 두 primary fixture는 그대로 보존한다. 원 source HEAD/index/bytes와 target 전후 SHA는 fixture 전용 read-only IPC로 비교한다. unknown/lost 복구는 제품 focused HTTP/unit 증거이며 이 브라우저 run에서 DB를 조작해 생성하지 않는다.');
names.push('Workflow 전용 DAG 저장·미리보기·실제 명령 통과','Workflow 실패·종속 단계 생략·명시 재시도·버전 보존','Workflow 실제 중단·새로고침·재시작·재실행 없음','Bedrock 명시 동의·없는 CLI 실패·진단 복구·전송 차단','Native Review 정확한 입력·동의·mock 완료·복구','Native Review mock 시작·중단·복구·재실행 없음','Extensions 명시 조회·정제된 목록·캐시 재사용','Extensions 새로고침·재시작 unknown·자동 수집 없음');
report.steps.push(...names.slice(29).map(name=>({name,status:'not_run'})));
report.limitations.push('Workflow는 네 번째 disposable repository의 고정 Node 명령만 실제 OS 권한으로 실행한다. ignored 표식은 의도한 부작용이며 sandbox 격리·AI Run·검증 Check·리뷰 승인으로 자동 승격을 주장하지 않는다. 순차 DAG·실패 시 생략·명시 재시도·실제 중단·기록 복구를 검사하며 lost 복구는 focused 서비스/HTTP 증거 범위이다.');
report.limitations.push('Bedrock은 네 번째 fixture에만 등록한 존재하지 않는 CLI 경로의 명시 모델 진단 실패를 검사한다. AWS CLI 설치·계정·인증정보·AWS 네트워크·실제 추론·과금·임시 입력 파일 생성/정리 성공은 검사하지 않는다. 다른 프로젝트는 project_blocked이며 실패 진단의 복원은 재시도나 모델 요청을 생성하지 않아야 한다.');
report.limitations.push('Native Review는 여섯 번째 CLI 인자로 명시한 네 번째 worktree의 read-only factory에만 별도 fake RpcPort를 허용한다. 실제 제품 native protocol runner/ReviewService/HTTP/UI를 거치지만 계정 응답·리뷰 텍스트·프로세스 종료는 합성 RPC 증거이며 실제 Codex CLI·ChatGPT 로그인·AI 추론·구독 사용량·원격 전송을 검증하지 않는다. 고정 README marker는 worktree 생성 직후 baseline 전에만 seed하며 이후 source HEAD/index/digest와 primary를 보존한다. lost·종료 미확인 복구는 focused unit/HTTP 범위이고 브라우저 DB를 조작하지 않는다.');
report.limitations.push('Extensions는 일곱 번째 exact grant를 받은 네 번째 worktree에서만 fake RpcPort 목록을 수집한다. 명시 수집·60초 캐시·원문 비노출·재시작 unknown을 검증하며 실제 CLI, 계정, 확장 설치·실행·설정 변경이나 외부 요청은 하지 않는다. 설정상 enabled와 Orbit의 실행 허용 상태는 별도로 표시한다.');
let commandNumber=0,currentStep='',binary,server,serverPort,browserAttempted=false,browserReady=false,projectId,secondProjectId,workspacePath,syntheticRun,sourceWorkspaceId,sourceWorkspacePath,mergeProjectId,mergeWorkspaceId,mergeWorkspacePath,mergeRun,workflowProjectId,workflowWorkspaceId,workflowWorkspacePath;
const abortController=new AbortController();
const interrupt=()=>abortController.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const planTitle='Orbit E2E 기획 '+session.slice(-8),artifactTitle='Orbit E2E Artifact '+session.slice(-8);
const planSource=`# ${planTitle}\n\n## Goal\n임시 UI 데이터의 저장과 복원을 검증한다.\n\n## Requirements\n### REQ-01\n임시 프로젝트의 기획 및 Task를 보존한다.\n#### Acceptance criteria\n- 새로고침 뒤 저장된 기획과 Task를 확인할 수 있다.\n\n## Constraints\n- 외부 AI를 호출하지 않는다.\n\n## Open questions\n`;
const mermaid='flowchart TD\n  browser["E2E Browser"]\n  server["E2E Local Server"]\n  browser -->|HTTP| server';
const projectPath=out('sandbox','orbit-ui-fixture'),secondPath=out('sandbox','orbit-ui-other'),mergeProjectPath=out('sandbox','orbit-ui-merge'),workflowProjectPath=out('sandbox','orbit-ui-workflow');

function persist(){writeFileSync(out('result.json'),JSON.stringify(report,null,2)+'\n');}
async function command(executable,argv,{timeoutMs=45000,cwd=repo,signal=abortController.signal,commandEnv=env}={}){
  const id=String(++commandNumber).padStart(4,'0'),startedAt=new Date().toISOString();
  const result=await runProcess(executable,argv,{cwd,env:commandEnv,timeoutMs,signal});
  writeFileSync(out('logs',id+'.stdout.log'),result.stdout);writeFileSync(out('logs',id+'.stderr.log'),result.stderr);
  appendFileSync(out('commands.jsonl'),JSON.stringify({id,step:currentStep,startedAt,executable,argv,cwd,code:result.code,timedOut:result.timedOut,aborted:result.aborted,pid:result.pid})+'\n');
  if(result.code!==0||result.timedOut||result.aborted)throw new Error(`COMMAND_FAILED [${id}] exit=${result.code} timeout=${result.timedOut} aborted=${result.aborted}: ${result.stderr.trim().slice(0,1600)||result.stdout.trim().slice(0,1600)}`);
  return result.stdout;
}
async function browser(argv,diagnostic=false){
  // Evidence collection and close must still run after Ctrl+C aborts the active action.
  const signal=phaseSignal(abortController.signal,diagnostic);
  const output=await command(binary,['--config',config,'--session',session,'--namespace',session,'--engine','chrome','--allowed-domains','127.0.0.1','--download-path',out('downloads'),'--idle-timeout','3m','--json',...argv],{cwd:out('sandbox'),commandEnv:browserEnv,timeoutMs:diagnostic?10000:45000,signal});
  cliData(output);return output;
}
const expression=body=>`(()=>{const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const $$=s=>[...document.querySelectorAll(s)].filter(visible);const $=s=>$$(s)[0];return (${body});})()`;
async function evaluate(body){return evalResult(await browser(['eval','-b',Buffer.from(expression(body)).toString('base64')]));}
async function expectUI(body,message){
  await browser(['wait','--fn',expression(body)]);
  assert.equal(await evaluate(body),true,message);
}
async function button(label,prefix=false){
  const ref=buttonRef(await browser(['snapshot','-i']),label,prefix);
  await browser(['scrollintoview',ref]);await browser(['click',ref]);
}
async function fill(selector,value){await browser(['scrollintoview',selector]);await browser(['fill',selector,value]);}
async function navigate(id){
  const label=menus.find(menu=>menu[0]===id)[1];
  await browser(['click',`.sidebar a[href="#/${id}"]`]);
  await expectUI(`location.hash==='#/${id}'&&$('.page-heading h1')?.textContent===${JSON.stringify(label)}&&$$('.sidebar a[aria-current="page"]').length===1&&$('.sidebar a[aria-current="page"]')?.getAttribute('href')==='#/${id}'`,'Wrong route, heading or active menu: '+id);
}
async function capabilityPolicy(extensionsOnly=false){
  await navigate(extensionsOnly?'extensions':'providers');
  await expectUI(`!!$('.capability-panel[aria-label="Capability Registry"]')&&$$('.capability-provider').length===2&&$('.capability-panel').innerText.includes('로컬 진단 미실행')`,'Capability Registry did not load without a native probe');
  await browser(['click','.capability-provider:nth-of-type(2) > summary']);
  await expectUI(`document.querySelectorAll('.capability-provider')[1]?.open&&$('.capability-panel').innerText.includes('Codex')&&$('.capability-panel').innerText.includes('Claude Code')&&$('.capability-panel').innerText.includes('Orbit 어댑터 미연결')&&$('.capability-panel').innerText.includes('unknown')&&$$('.capability-provider').every(provider=>provider.innerText.includes('로컬 CLI: 미확인')&&provider.innerText.includes('현재 런타임 미확인'))`,'Unknown versions, runtime and disconnected adapter must remain explicit');
  await expectUI(`['MCP','Hooks','Plugins','서브에이전트'].every(label=>[...document.querySelector('.capability-provider .capability-list').children].some(row=>row.querySelector('b')?.textContent===label&&row.querySelector('.badge')?.textContent==='현재 정책에서 비활성'))&&$$('.capability-list .badge').every(badge=>badge.textContent!=='연결됨')`,'Capability display must preserve the current blocked execution policy');
  if(extensionsOnly)await expectUI(`document.querySelectorAll('.capability-provider')[0].querySelectorAll('.capability-list > li').length===5&&document.querySelectorAll('.capability-provider')[1].querySelectorAll('.capability-list > li').length===6&&$$('.capability-list > li').every(row=>['Skills','MCP','Hooks','Plugins','서브에이전트','Agent Teams'].includes(row.querySelector('b')?.textContent))`,'Extension view must filter capabilities without enabling restricted tools');
}
async function executionModeDescriptions(){
  await navigate('agents');
  await expectUI(`!!$('details.capability-panel > summary')&&$('details.capability-panel > summary').textContent.includes('실행 모드')&&!$('details.capability-panel').open`,'Execution mode summary missing');
  await browser(['click','details.capability-panel > summary']);
  await expectUI(`$('details.capability-panel')?.open&&$$('details.capability-panel .capability-list > li').length===6&&['Solo','Cross Review','Debate','Race','Cooperate','Goal'].every(label=>$$('details.capability-panel .capability-list > li b').some(node=>node.textContent===label))&&$$('details.capability-panel .badge').filter(badge=>badge.textContent==='미연결').length===5&&$('details.capability-panel').innerText.includes('기존 Codex 경로')`,'Six mode descriptions must open while disconnected modes stay unavailable');
}
async function unknownAccountUsage(){
  await navigate('usage');
  await expectUI(`!!$('.usage-panel')&&$('.usage-panel').innerText.includes('출처: 아직 조회하지 않음')&&$('.usage-panel').innerText.includes('구독: unknown')&&$('.usage-panel').innerText.includes('API 비용: unknown')&&$$('.usage-panel .policy-list dd').length===3&&$$('.usage-panel .policy-list dd').every(value=>value.textContent.startsWith('unknown'))`,'Disconnected account usage must remain unknown rather than zero');
  await expectUI(`$('.usage-panel').innerText.includes('계정 전체의 공식 조회값입니다. 현재 프로젝트만의 사용량이 아닙니다.')&&$('.usage-panel').innerText.includes('API 과금 전환은 수행하지 않습니다.')&&$('.usage-panel').innerText.includes('잔여량 초기화·크레딧 구매')&&$$('.usage-panel button').some(button=>button.textContent==='공식 사용량 조회'&&button.disabled)`,'Account-wide read-only scope and disabled usage refresh must remain explicit');
  report.usageChecks={disconnectedUnknown:true,accountWide:true,refreshDisabled:true,billingTransition:false,refreshButtonClicked:false};
}
async function ready(){await expectUI(`!!$('.connection')&&!$('.connection').textContent.includes('로컬 서버 연결 끊김')&&!!$('select[aria-label="현재 프로젝트"]:enabled')`,'Orbit did not become ready');}
async function capture(label,width,height){
  const filename=`${String(report.screenshots.length+1).padStart(2,'0')}-${label}.png`,path=out('screenshots',filename);
  await browser(['screenshot',path],true);
  const png=readFileSync(path);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a','Screenshot is not PNG');
  if(width){assert.equal(png.readUInt32BE(16),width);assert.equal(png.readUInt32BE(20),height);}
  report.screenshots.push({step:currentStep,file:'screenshots/'+filename,width:png.readUInt32BE(16),height:png.readUInt32BE(20)});persist();
}
async function diagnostics(label,allowedConsole=[]){
  const errors=cliData(await browser(['errors'],true)),consoleOutput=cliData(await browser(['console'],true));
  writeFileSync(out('logs',label+'-browser.json'),JSON.stringify({errors,console:consoleOutput},null,2));
  assert.ok(Array.isArray(errors.errors),'Unknown agent-browser errors schema; inspect saved JSON');
  assert.equal(errors.errors.length,0,'Browser JavaScript errors: '+JSON.stringify(errors.errors));
  const messages=consoleOutput.messages??consoleOutput.logs;
  assert.ok(Array.isArray(messages),'Unknown agent-browser console schema; inspect saved JSON');
  for(const message of messages){
    if(message.type==='error'||message.level==='error'){
      const text=String(message.text??message.message??JSON.stringify(message));
      assert.ok(allowedConsole.some(pattern=>pattern.test(text)),'Unexpected browser console error: '+text);
    }
  }
  await browser(['errors','--clear'],true);await browser(['console','--clear'],true);
}
async function step(name,work,{consoleAllow=[]}={}){
  currentStep=name;const item=report.steps.find(step=>step.name===name);item.startedAt=new Date().toISOString();persist();console.log('▶ '+name);
  try{await work();if(browserReady)await diagnostics('step-'+report.steps.indexOf(item),consoleAllow);item.status='passed';}
  catch(error){item.status='failed';item.error=String(error.stack??error);throw error;}
  finally{item.finishedAt=new Date().toISOString();persist();}
}
async function startServer(port=0){
  const child=fork(join(repo,'scripts/lib/orbit-ui-server.mjs'),[runDir,join(repo,'dist'),String(port),mergeProjectPath,workflowProjectPath,workflowProjectPath,workflowProjectPath],{cwd:out('sandbox'),env,execArgv:[],silent:true,windowsHide:true});
  server=child;report.serverPids??=[];report.serverPids.push(child.pid);
  child.stdout.on('data',data=>appendFileSync(out('logs','server.log'),data));child.stderr.on('data',data=>appendFileSync(out('logs','server.log'),data));
  const address=await new Promise((resolveReady,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('TEST_SERVER_START_TIMEOUT'));},15000);
    const clean=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',error);};
    const message=value=>{if(value?.kind==='ready'){clean();resolveReady(value);}};
    const exit=code=>{clean();reject(new Error('TEST_SERVER_EXIT_BEFORE_READY '+code));};
    const error=value=>{clean();reject(value);};
    child.on('message',message);child.once('exit',exit);child.once('error',error);
  });
  assert.match(address.url,/^http:\/\/127\.0\.0\.1:\d+$/);serverPort=address.port;report.url=address.url;return address.url;
}
async function stopServer(){
  if(!server)return;const child=server;
  if(child.exitCode!==null||child.signalCode!==null){server=null;if(child.exitCode!==0)throw new Error(`TEST_SERVER_UNEXPECTED_EXIT code=${child.exitCode} signal=${child.signalCode}`);return;}
  try{
    await new Promise((resolveStopped,reject)=>{
      const timer=setTimeout(()=>reject(new Error('TEST_SERVER_STOP_TIMEOUT')),8000);
      child.once('exit',code=>{clearTimeout(timer);code===0?resolveStopped():reject(new Error('TEST_SERVER_STOP_EXIT '+code));});
      if(child.connected)child.send({kind:'stop'});else{clearTimeout(timer);reject(new Error('TEST_SERVER_IPC_DISCONNECTED'));}
    });
  }catch(error){if(child.exitCode===null&&child.signalCode===null)await stopOwnedProcess(child.pid);throw error;}
  finally{server=null;}
}
async function seedTerminalRun(requireTask=true){
  assert.ok(server?.connected,'Owned fixture server is not connected');const child=server;
  const result=await new Promise((resolveSeed,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('SYNTHETIC_RUN_SEED_TIMEOUT'));},5000);
    const clean=()=>{clearTimeout(timer);child.off('message',message);};
    const message=value=>{if(value?.kind==='synthetic-run-ready'){clean();resolveSeed(value);}else if(value?.kind==='fixture-error'){clean();reject(new Error('SYNTHETIC_RUN_SEED_FAILED'));}};
    child.on('message',message);child.send({kind:'seed-terminal-run'});
  });
  assert.match(result.runId,/^[a-f0-9-]{36}$/);assert.match(result.workspaceId,/^[a-f0-9-]{36}$/);if(requireTask){assert.match(result.taskId,/^[a-f0-9-]{36}$/);assert.match(result.planningVersionId,/^[a-f0-9-]{36}$/);}return result;
}
async function planningRecords(){
  return evaluate(`(async()=>{const response=await fetch('/api/projects/${projectId}/plans');if(!response.ok)throw new Error('FIXTURE_PLANS_READ_FAILED');return response.json();})()`);
}
async function downloadedFile(filename,expected){
  const path=out('downloads',filename),deadline=Date.now()+15000;
  while(Date.now()<deadline){
    if(abortController.signal.aborted)throw new Error('E2E_INTERRUPTED');
    try{const bytes=readFileSync(path);if(bytes.equals(expected))return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolveWait=>setTimeout(resolveWait,100));
  }
  throw new Error('BROWSER_DOWNLOAD_MISSING_OR_BYTES_MISMATCH');
}
async function verificationView(run=syntheticRun){
  return evaluate(`(async()=>{const response=await fetch('/api/workspaces/${run.workspaceId}/verification?runId=${run.runId}');if(!response.ok)throw new Error('FIXTURE_VERIFICATION_VIEW_FAILED');return response.json();})()`);
}
async function mergeView(){
  return evaluate(`(async()=>{const response=await fetch('/api/workspaces/${mergeWorkspaceId}/merge?runId=${mergeRun.runId}');if(!response.ok)throw new Error('FIXTURE_MERGE_VIEW_FAILED');return response.json();})()`);
}
async function mergeEvidence(){
  assert.ok(server?.connected,'Owned merge fixture IPC is not connected');const child=server;
  const value=await new Promise((resolveEvidence,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('MERGE_FIXTURE_EVIDENCE_TIMEOUT'));},20000);
    const clean=()=>{clearTimeout(timer);child.off('message',message);};
    const message=result=>{if(result?.kind==='merge-fixture-evidence'){clean();resolveEvidence(result);}else if(result?.kind==='fixture-error'){clean();reject(new Error('MERGE_FIXTURE_EVIDENCE_FAILED'));}};
    child.on('message',message);child.send({kind:'merge-fixture-evidence'});
  });
  assert.equal(value.projectId,mergeProjectId);assert.equal(value.workspaceId,mergeWorkspaceId);assert.equal(value.actualAiExecuted,false);assert.equal(value.source.sourceDigest,value.source.snapshotDigest);return value;
}
async function preservedOriginalFixtures(){
  for(const [index,path] of [projectPath,secondPath].entries()){
    assert.equal((await command('git',['status','--porcelain'],{cwd:path})).trim(),'');assert.equal(readFileSync(join(path,'README.md'),'utf8'),'Orbit E2E disposable fixture\n');
    assert.equal((await command('git',['rev-parse','HEAD'],{cwd:path})).trim(),report.originalFixtureHeads[index]);
  }
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const marker=text=>({present:true,bytes:Buffer.byteLength(text),sha256:sha(text)});
async function workflowView(){
  return evaluate(`(async()=>{const response=await fetch('/api/projects/${workflowProjectId}/workflows?workspaceId=${workflowWorkspaceId}');if(!response.ok)throw new Error('FIXTURE_WORKFLOW_VIEW_FAILED');return response.json();})()`);
}
async function reviewView(){return evaluate(`(async()=>{const response=await fetch('/api/workspaces/${workflowWorkspaceId}/reviews');if(!response.ok)throw new Error('FIXTURE_REVIEW_VIEW_FAILED');return response.json();})()`);}
async function inventoryView(){return evaluate(`(async()=>{const response=await fetch('/api/extensions');if(!response.ok)throw new Error('FIXTURE_INVENTORY_VIEW_FAILED');return response.json();})()`);}
async function inventoryFixture(){
  assert.ok(server?.connected,'Owned inventory fixture IPC is not connected');const child=server;
  const result=await new Promise((resolveStats,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('INVENTORY_FIXTURE_IPC_TIMEOUT'));},10000),clean=()=>{clearTimeout(timer);child.off('message',message);};
    const message=value=>{if(value?.kind==='inventory-fixture'){clean();resolveStats(value);}else if(value?.kind==='fixture-error'){clean();reject(new Error('INVENTORY_FIXTURE_CONTROL_FAILED'));}};
    child.on('message',message);child.send({kind:'inventory-fixture'});
  });
  assert.equal(result.actualAiExecuted,false);assert.equal(result.actualCliExecuted,false);assert.equal(result.externalRequests,0);assert.equal(result.counts.forbidden,0);return result;
}
const inventoryVisible=`$('.extensions-summary')?.innerText.includes('Codex App Server')&&$('.extensions-panel')?.innerText.includes('fixture skill')&&$('.extensions-panel')?.innerText.includes('preToolUse')&&$('.extensions-panel')?.innerText.includes('fixture-disabled-mcp')&&$('.extensions-panel')?.innerText.includes('버전: unknown')&&$('.extensions-panel')?.innerText.includes('설정상 enabled: 켜짐')&&$('.extensions-panel')?.innerText.includes('설정상 enabled: 꺼짐')&&$('.extensions-panel')?.innerText.includes('현재 정책에서 비활성')&&$('[data-extension-kind="plugins"]')?.innerText.includes('Orbit 미연결')&&!document.body.innerText.includes('ORBIT_INVENTORY_FORBIDDEN_RAW')`;
const inventoryUnknown=`$('.extensions-summary')?.innerText.includes('아직 조회하지 않음')&&!$('.extensions-panel')?.innerText.includes('fixture skill')&&$$('.extensions-panel button').some(node=>node.textContent==='공식 확장 목록 조회'&&node.disabled)&&['skills','hooks','mcp'].every(kind=>document.querySelector('[data-extension-kind="'+kind+'"]')?.innerText.includes('미조회 · unknown'))`;
async function reviewPreview(){return evaluate(`(async()=>{const response=await fetch('/api/workspaces/${workflowWorkspaceId}/reviews/preview');if(!response.ok)throw new Error('FIXTURE_REVIEW_PREVIEW_FAILED');return response.json();})()`);}
async function reviewFixture(mode){
  assert.ok(server?.connected,'Owned review fixture IPC is not connected');const child=server;
  const result=await new Promise((resolveStats,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('REVIEW_FIXTURE_IPC_TIMEOUT'));},10000),clean=()=>{clearTimeout(timer);child.off('message',message);};
    const message=value=>{if(value?.kind==='review-fixture'){clean();resolveStats(value);}else if(value?.kind==='fixture-error'){clean();reject(new Error('REVIEW_FIXTURE_CONTROL_FAILED'));}};
    child.on('message',message);child.send({kind:'review-fixture',...(mode?{mode}:{})});
  });
  assert.equal(result.actualAiExecuted,false);assert.equal(result.actualCliExecuted,false);assert.equal(result.externalRequests,0);for(const value of Object.values(result.counts))assert.ok(Number.isSafeInteger(value)&&value>=0);assert.ok(!JSON.stringify(result).includes('ORBIT_E2E_REVIEW_INPUT'));return result;
}
async function waitReview(status,exclude=[]){
  return evaluate(`(async()=>{const deadline=Date.now()+12000;while(Date.now()<deadline){const response=await fetch('/api/workspaces/${workflowWorkspaceId}/reviews');if(!response.ok)throw new Error('FIXTURE_REVIEW_WAIT_READ_FAILED');const view=await response.json(),record=view.records.find(value=>value.execution===${JSON.stringify(status)}&&!${JSON.stringify(exclude)}.includes(value.id));if(record)return record;await new Promise(resolve=>setTimeout(resolve,120));}throw new Error('FIXTURE_REVIEW_STATUS_TIMEOUT');})()`);
}
async function previewReviewAndConsent(){
  const preview=await reviewPreview();assert.equal(preview.workspaceId,workflowWorkspaceId);assert.equal(preview.runId,null);assert.equal(preview.sourceDigest,report.workflow.before.source.sourceDigest);assert.equal(preview.timeoutMs,60000);assert.equal(preview.turnLimit,1);assert.deepEqual(preview.files.map(value=>[value.path,value.status]),[['README.md','modified']]);assert.ok(preview.instructions.includes('ORBIT_E2E_REVIEW_INPUT'));
  await button('Native Review 입력 미리보기');await expectUI(`$('.review-instructions')?.textContent===${JSON.stringify(preview.instructions)}&&$('.review-preview')?.innerText.includes(${JSON.stringify(preview.previewDigest)})&&$('.review-preview')?.innerText.includes(${JSON.stringify(preview.sourceDigest)})&&!!$('#review-start-consent:enabled')&&!$('#review-start-consent').checked&&$$('.review-preview button').some(node=>node.textContent==='동의한 Native Review 시작'&&node.disabled)`,'Exact source-bound review input must be visible before a separate consent');
  const before=await reviewFixture();await browser(['check','#review-start-consent']);await button('동의한 Native Review 시작');return {preview:{inputDigest:preview.inputDigest,previewDigest:preview.previewDigest,sourceDigest:preview.sourceDigest,files:preview.files,timeoutMs:preview.timeoutMs,turnLimit:preview.turnLimit,exactInstructionsVerified:true},before};
}
async function reviewDidNotApprove(){
  const evidence=await evaluate(`(async()=>{const responses=await Promise.all([fetch('/api/state'),fetch('/api/workspaces/${workflowWorkspaceId}/verification')]);if(responses.some(value=>!value.ok))throw new Error('FIXTURE_REVIEW_INDEPENDENT_EVIDENCE_FAILED');const [state,verification]=await Promise.all(responses.map(value=>value.json()));return {runs:state.runs.filter(value=>value.workspaceId==='${workflowWorkspaceId}').length,checks:verification.checks.length,approval:verification.approval,canApprove:verification.canApprove};})()`);
  assert.deepEqual(evidence,{runs:0,checks:0,approval:null,canApprove:false});return evidence;
}
async function workflowEvidence(){
  assert.ok(server?.connected,'Owned workflow fixture IPC is not connected');const child=server;
  const value=await new Promise((resolveEvidence,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('WORKFLOW_FIXTURE_EVIDENCE_TIMEOUT'));},20000);
    const clean=()=>{clearTimeout(timer);child.off('message',message);};
    const message=result=>{if(result?.kind==='workflow-fixture-evidence'){clean();resolveEvidence(result);}else if(result?.kind==='fixture-error'){clean();reject(new Error('WORKFLOW_FIXTURE_EVIDENCE_FAILED'));}};
    child.on('message',message);child.send({kind:'workflow-fixture-evidence'});
  });
  assert.equal(value.projectId,workflowProjectId);assert.equal(value.workspaceId,workflowWorkspaceId);assert.equal(value.actualAiExecuted,false);return value;
}
async function waitWorkflow(versionId,status,exclude=[]){
  return evaluate(`(async()=>{const deadline=Date.now()+12000;while(Date.now()<deadline){const response=await fetch('/api/projects/${workflowProjectId}/workflows?workspaceId=${workflowWorkspaceId}');if(!response.ok)throw new Error('FIXTURE_WORKFLOW_WAIT_READ_FAILED');const view=await response.json();const run=view.runs.find(value=>value.versionId===${JSON.stringify(versionId)}&&value.status===${JSON.stringify(status)}&&!${JSON.stringify(exclude)}.includes(value.id));if(run)return run;await new Promise(resolve=>setTimeout(resolve,120));}throw new Error('FIXTURE_WORKFLOW_STATUS_TIMEOUT');})()`);
}
function assertWorkflowContext(value){
  const before=report.workflow.before;assert.deepEqual(value.primary,before.primary,'workflow execution must preserve the fourth primary');
  for(const key of ['head','baseSha','indexSha256','sourceDigest'])assert.equal(value.source[key],before.source[key],'workflow source context changed: '+key);
}
function preservedMergeFixture(){
  const git=(cwd,...args)=>trustedGit(cwd,args).toString('utf8').trim();
  const indexHash=cwd=>sha(readFileSync(containedPath(runDir,relative(runDir,resolve(cwd,git(cwd,'rev-parse','--git-path','index'))))));
  for(const [cwd,expected] of [[mergeProjectPath,report.merge.afterApply.primary],[mergeWorkspacePath,report.merge.before.source]]){
    assert.equal(git(cwd,'rev-parse','HEAD'),expected.head);assert.equal(indexHash(cwd),expected.indexSha256);assert.equal(git(cwd,'status','--porcelain'),expected.status);
    if(expected.snapshotFiles)assert.equal(fingerprintWorkspace(cwd,expected.baseSha,expected.snapshotFiles.map(({path,mode})=>({path,mode}))),expected.sourceDigest);
    for(const [name,file] of Object.entries(expected.files)){
      const path=containedPath(runDir,relative(runDir,cwd),name);
      if(file.present){const bytes=readFileSync(path);assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);}
      else assert.throws(()=>readFileSync(path),{code:'ENOENT'});
    }
  }
}
async function workflowPreviewAndConsent(retry=false){
  await button('현재 명령·소스 미리보기');
  await expectUI(`!!$('.workflow-preview')&&$$('.workflow-preview ol > li').length===2&&$('.workflow-preview').innerText.includes('총 timeout 20000 ms')&&$$('.workflow-preview pre').every(node=>JSON.parse(node.textContent)[1]==='workflow-check.mjs')&&!!$('#workflow-execution-consent:enabled')&&!$('#workflow-execution-consent').checked&&$('.workflow-preview button').disabled`,'Full fixed command preview must require separate execution consent');
  await browser(['check','#workflow-execution-consent']);await button(retry?'동일 조건으로 명시 재시도':'승인한 워크플로 실행');
}
async function sourceGraphView(){
  return evaluate(`(async()=>{const response=await fetch('/api/workspaces/${sourceWorkspaceId}/source-graph');if(!response.ok)throw new Error('FIXTURE_GRAPH_VIEW_FAILED');return response.json();})()`);
}
async function modelHubView(scope=projectId){
  return evaluate(`(async()=>{const response=await fetch('/api/model-hub?projectId=${scope}');if(!response.ok)throw new Error('FIXTURE_MODEL_HUB_VIEW_FAILED');return response.json();})()`);
}
async function modelHubStats(){
  assert.ok(server?.connected,'Owned model fixture IPC is not connected');const child=server;
  const result=await new Promise((resolveStats,reject)=>{
    const timer=setTimeout(()=>{clean();reject(new Error('MODEL_FIXTURE_STATS_TIMEOUT'));},3000);
    const clean=()=>{clearTimeout(timer);child.off('message',message);};
    const message=value=>{if(value?.kind==='model-hub-stats'){clean();resolveStats(value);}};
    child.on('message',message);child.send({kind:'model-hub-stats'});
  });
  assert.ok(Number.isInteger(result.port)&&result.port>0&&result.port<65536);assert.equal(result.actualAiExecuted,false);assert.equal(result.externalRequests,0);
  for(const key of ['total','models','chats','activeHangs','abortedHangs','boundedTimeouts','rejected'])assert.ok(Number.isInteger(result.counts[key])&&result.counts[key]>=0);
  report.modelHubFixtureCounts??=[];report.modelHubFixtureCounts.push({step:currentStep,port:result.port,counts:result.counts});return result;
}
async function loadSourceArtifact(){
  await navigate('visualization');
  await expectUI(`$$('button').some(button=>button.textContent==='저장 기록 다시 불러오기'&&!button.disabled)`,'Stored Artifact reload is not ready');
  await button('저장 기록 다시 불러오기');
  await expectUI(`$$('.viz-studio button').some(button=>button.textContent.startsWith('소스 파일 의존도 · architecture · 버전 1'))`,'Source graph Artifact missing from stored records');
  await button('소스 파일 의존도 ·',true);
  await expectUI(`$('.viz-editor input')?.value==='소스 파일 의존도'&&$('.viz-editor textarea')?.value.includes('src/main.ts')&&!!$('.viz-canvas svg')&&!!$('.artifact-source-status')`,'Stored source diagram did not load');
  await button('Artifact 소스 상태 확인');
}
async function fixture(path){
  mkdirSync(path);
  await command('git',['init','--quiet','--initial-branch=main',path]);
  writeFileSync(join(path,'README.md'),'Orbit E2E disposable fixture\n');
  writeFileSync(join(path,'check.test.mjs'),'import test from "node:test";import assert from "node:assert/strict";import {readFileSync} from "node:fs";test("E2E source fixture check",()=>assert.match(readFileSync(new URL("./README.md",import.meta.url),"utf8"),/Orbit E2E disposable fixture/));\n');
  await command('git',['add','README.md','check.test.mjs'],{cwd:path});
  await command('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','E2E fixture'],{cwd:path});
}
async function workflowFixture(){
  await fixture(workflowProjectPath);
  writeFileSync(join(workflowProjectPath,'.gitignore'),'.workflow-*.tmp\n');
  writeFileSync(join(workflowProjectPath,'workflow-check.mjs'),`import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const mode=process.argv[2];
if(mode==='first'){appendFileSync('.workflow-order.tmp','first\\n');console.log('ORBIT_WORKFLOW_FIRST');}
else if(mode==='second'){if(readFileSync('.workflow-order.tmp','utf8')!=='first\\n')throw new Error('WORKFLOW_ORDER_MISMATCH');appendFileSync('.workflow-order.tmp','second\\n');console.log('ORBIT_WORKFLOW_SECOND');}
else if(mode==='fail'){appendFileSync('.workflow-fail.tmp','fail\\n');console.log('ORBIT_WORKFLOW_EXPECTED_FAILURE');process.exitCode=7;}
else if(mode==='hang'){writeFileSync('.workflow-hang.tmp','started\\n');console.log('ORBIT_WORKFLOW_STARTED');setTimeout(()=>console.log('ORBIT_WORKFLOW_UNEXPECTED_HANG_COMPLETION'),30000);}
else throw new Error('WORKFLOW_MODE_REJECTED');
`);
  await command('git',['add','.gitignore','workflow-check.mjs'],{cwd:workflowProjectPath});
  await command('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','Fixed local workflow fixture'],{cwd:workflowProjectPath});
}
async function restored(){
  await navigate('planning');
  await expectUI(`[...document.querySelectorAll('.planning-studio > .planning-toolbar select option')].some(e=>e.textContent.includes(${JSON.stringify(planTitle)}))`,'Saved plan option missing');
  // Options are not layout boxes in Chrome; read their DOM value, then select through the CLI.
  const planId=await evaluate(`[...document.querySelectorAll('.planning-studio > .planning-toolbar select option')].find(e=>e.textContent.includes(${JSON.stringify(planTitle)}))?.value`);
  assert.equal(typeof planId,'string');assert.ok(planId);
  await browser(['select','.planning-studio > .planning-toolbar select',planId]);
  await expectUI(`$('.planning-editor textarea')?.value.includes(${JSON.stringify(planTitle)})&&$('.planning-studio').innerText.includes('approved')&&$('.saved-tasks')?.innerText.includes('REQ-01')`,'Approved plan/Task not restored');
  await navigate('visualization');
  await button(artifactTitle+' ·',true);
  await expectUI(`$('.viz-editor textarea')?.value===${JSON.stringify(mermaid)}&&$('.viz-editor input')?.value===${JSON.stringify(artifactTitle)}&&!!$('.viz-canvas svg')`,'Artifact source/preview not restored');
}
try{
  await step(names[0],async()=>{
    assert.equal(Number(process.versions.node.split('.')[0]),24,'Use Node 24 as required by package.json');
    binary=findAgentBrowser();report.agentBrowser=String(await command(binary,['--version'])).trim();
    const help=await command(binary,['--help']);
    for(const feature of ['--config','--namespace','--allowed-domains','--download-path','snapshot','screenshot','eval','console','errors','reload','viewport','upload'])assert.ok(help.includes(feature),'Installed CLI lacks '+feature);
    await command(binary,['skills','get','core']);
  });
  await step(names[1],async()=>{for(const file of ['scripts/verify-orbit-ui.mjs','scripts/lib/orbit-ui-server.mjs','scripts/lib/orbit-ui-e2e.ts'])await command(process.execPath,['--check',file]);});
  await step(names[2],()=>command(process.execPath,[require.resolve('typescript/bin/tsc'),'--noEmit'],{timeoutMs:120000}));
  await step(names[3],()=>command(process.execPath,['--test',...readdirSync(join(repo,'tests')).filter(file=>file.endsWith('.test.ts')).map(file=>'tests/'+file),...readdirSync(join(repo,'spikes/phase0')).filter(file=>file.endsWith('.test.mjs')).map(file=>'spikes/phase0/'+file)],{timeoutMs:180000}));
  if(!checkOnly){
    await step(names[4],()=>command(process.execPath,['scripts/build.mjs'],{timeoutMs:120000}));
    await step(names[5],async()=>{await fixture(projectPath);await fixture(secondPath);await fixture(mergeProjectPath);await workflowFixture();report.originalFixtureHeads=[];for(const path of [projectPath,secondPath])report.originalFixtureHeads.push((await command('git',['rev-parse','HEAD'],{cwd:path})).trim());await startServer();});
    await step(names[6],async()=>{browserAttempted=true;await browser(['open',report.url]);browserReady=true;await browser(['set','viewport','1366','768']);await ready();});
    await step(names[7],async()=>{
      await expectUI(`$$('.sidebar .nav-item').length===12`,'Expected 12 sidebar menus');for(const [id] of menus)await navigate(id);
      await capabilityPolicy();await capabilityPolicy(true);await executionModeDescriptions();await unknownAccountUsage();
      const modelStats=await modelHubStats();assert.equal(modelStats.counts.total,0,'Initial GETs and all-menu navigation must not contact the local model fixture');
      report.modelHubChecks={initialNavigationNetworkRequests:0,actualAiExecuted:false,externalServiceRequests:0,explicitOperationsStarted:false};
      report.capabilityChecks={providers:true,extensionsPolicy:true,executionModeDescriptions:6,nativeProbeButtonClicked:false,modeExecutionStarted:false};
    });
    await step(names[8],async()=>{
      await navigate('projects');await fill('#project-path',projectPath);await button('프로젝트 등록');
      await expectUI(`$('.project-location')?.innerText.includes('orbit-ui-fixture')`,'Project registration missing');projectId=await evaluate(`$('select[aria-label="현재 프로젝트"]').value`);assert.ok(projectId);
      await fill('#project-path',secondPath);await button('프로젝트 등록');await expectUI(`$('.project-location')?.innerText.includes('orbit-ui-other')`,'Second registration missing');secondProjectId=await evaluate(`$('select[aria-label="현재 프로젝트"]').value`);assert.notEqual(projectId,secondProjectId);
      await browser(['select','select[aria-label="현재 프로젝트"]',projectId]);await expectUI(`$('.project-location')?.innerText.includes('orbit-ui-fixture')`,'Project switch failed');
    });
    await step(names[9],async()=>{
      await button('새 작업 공간 만들기');await expectUI(`!!$('select[aria-label="실행할 작업 공간"]')?.value`,'Worktree not selected');
      await navigate('development');await expectUI(`!!$('.diff-panel')&&$('.diff-panel').innerText.includes('변경된 파일이 없습니다.')`,'Initial Diff did not load');
      const path=await evaluate(`$('.record-list li p').textContent`);const target=containedPath(runDir,relative(runDir,path),'e2e-proof.txt');
      assert.ok(resolve(path).startsWith(out('sandbox','workspaces')+ (process.platform==='win32'?'\\':'/')),'Foreign workspace');
      workspacePath=path;
      writeFileSync(target,'ORBIT_E2E_DIFF_PROOF\n');await button('Diff 새로고침');await expectUI(`$('.patch pre')?.textContent.includes('ORBIT_E2E_DIFF_PROOF')`,'Actual Git Diff missing');
    });
    await step(names[10],async()=>{
      await navigate('planning');await expectUI(`!!$('.planning-editor textarea:enabled')`,'Planning editor not ready');
      await fill('.planning-editor textarea',planSource);await expectUI(`$('.planning-preview')?.innerText.includes(${JSON.stringify(planTitle)})`,'Planning preview missing');
      await button('초안 저장');await expectUI(`$('.planning-studio [role="status"]')?.textContent.includes('초안을 저장했습니다.')`,'Plan was not saved');
      await button('저장된 버전 승인');await expectUI(`$('.planning-studio [role="status"]')?.textContent.includes('승인했습니다.')`,'Plan not approved');
      await button('Task 초안 생성');await expectUI(`$('.saved-tasks article')?.innerText.includes('REQ-01')&&$('.saved-tasks').innerText.includes('검증 미실행')`,'Persisted Task missing');
    });
    await step(names[11],async()=>{
      await navigate('visualization');await fill('.viz-editor input',artifactTitle);await fill('.viz-editor textarea',mermaid);
      await expectUI(`$('.viz-canvas svg')?.textContent.includes('E2E Browser')&&!!$('.viz-valid')`,'Mermaid preview not rendered');await button('Artifact 저장');
      await expectUI(`$('.viz-studio [role="status"]')?.textContent.includes('버전 1 저장 완료.')`,'Artifact save missing');
      await browser(['reload']);await ready();await restored();await button('버전 이력 불러오기');await expectUI(`$$('.viz-studio button').some(e=>e.textContent.startsWith('버전 1 ·'))`,'Artifact history not restored');
    });
    await step(names[12],async()=>{
      await navigate('providers');await fill('.mock-providers textarea','Synthetic email: orbit-ui-person@example.invalid');await button('모의 정책 검사');
      await expectUI(`$('.mock-providers [role="status"]')?.textContent.includes('개인정보 패턴이 감지되어 전송을 차단했습니다.')`,'Expected synthetic privacy block missing');
    },{consoleAllow:[/^Failed to load resource: the server responded with a status of 422\b/]});
    await step(names[13],async()=>{
      await browser(['reload']);await ready();await expectUI(`location.hash==='#/providers'&&$('select[aria-label="현재 프로젝트"]')?.value===${JSON.stringify(projectId)}`,'Route/project not restored');await restored();
    });
    await step(names[14],async()=>{
      // Leave Orbit for an allowed same-origin static resource before stopping
      // the server: SSE closes without weakening the browser domain allowlist.
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/visualization']);await ready();
      await expectUI(`$('select[aria-label="현재 프로젝트"]')?.value===${JSON.stringify(projectId)}`,'Project preference lost after restart');await restored();
      await navigate('development');await expectUI(`$('.patch pre')?.textContent.includes('ORBIT_E2E_DIFF_PROOF')`,'Worktree diff lost after restart');
    });
    for(const [index,width,height] of [[15,1366,768],[16,1744,864]])await step(names[index],async()=>{
      await browser(['set','viewport',String(width),String(height)]);
      for(const [id] of menus){
        await navigate(id);await expectUI(`innerWidth===${width}&&innerHeight===${height}&&document.documentElement.scrollWidth<=innerWidth+1&&$$('.sidebar .nav-item').every(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;})`,'Viewport overflow or clipped sidebar: '+id);
        await capture(`${width}x${height}-${id}`,width,height);
      }
    });
    await step(names[17],async()=>{for(const path of [projectPath,secondPath]){assert.equal((await command('git',['status','--porcelain'],{cwd:path})).trim(),'');assert.equal(readFileSync(join(path,'README.md'),'utf8'),'Orbit E2E disposable fixture\n');}});
    await step(names[18],async()=>{
      syntheticRun=await seedTerminalRun();await navigate('development');
      await expectUI(`!!$('.verification-panel')&&$('.verification-panel').innerText.includes('E2E Node fixture test')&&$('.verification-panel').innerText.includes('Codex sandbox 밖의 로컬 OS 사용자 권한')&&$('.verification-panel .record-list pre')?.textContent===${JSON.stringify(JSON.stringify([process.execPath,'--test','check.test.mjs']))}&&$$('.verification-panel button').some(button=>button.textContent==='명령 승인 후 실행'&&!button.disabled)`,'Approved fixture command preview or synthetic terminal Run missing');
      await button('명령 승인 후 실행');
      await expectUI(`$('.verification-panel').innerText.includes('e2e-node-check · 통과')&&$('.verification-panel').innerText.includes('exit 0')&&$$('.verification-panel button').some(button=>button.textContent==='Diff와 검증 결과 확인 후 승인'&&!button.disabled)`,'Real Node fixture verification did not pass');
      await browser(['click','.verification-panel .record-list details > summary']);
      await expectUI(`$('.verification-panel details pre')?.textContent.includes('E2E source fixture check')`,'Actual test output missing');
      await button('Diff와 검증 결과 확인 후 승인');
      await expectUI(`$('.verification-panel').innerText.includes('조회 당시 소스와 검증 결과를 사용자가 승인했습니다.')`,'Verification approval did not persist');
      const view=await verificationView();assert.equal(view.checks[0].exitCode,0);assert.equal(view.checks[0].verdict,'passed');assert.equal(view.approvalCurrent,true);
      report.verification={syntheticRunId:syntheticRun.runId,workspaceId:syntheticRun.workspaceId,actualAiExecuted:false,commandId:'e2e-node-check',checkId:view.checks[0].id,sourceDigest:view.sourceDigest,approvalId:view.approval.id,exitCode:0};
      await browser(['scrollintoview','.verification-panel']);await capture('verification-approved',1744,864);
    });
    await step(names[19],async()=>{
      writeFileSync(containedPath(runDir,relative(runDir,workspacePath),'e2e-proof.txt'),'ORBIT_E2E_DIFF_PROOF\nChanged after verification approval\n');
      await button('검증 상태 새로고침');
      const stale=`$('.verification-panel')?.innerText.includes('현재 소스와 다른 과거 증거입니다.')&&$('.verification-panel')?.innerText.includes('이전 승인은 현재 소스·검증과 일치하지 않습니다.')&&$$('.verification-panel button').some(button=>button.textContent==='Diff와 검증 결과 확인 후 승인'&&button.disabled)`;
      await expectUI(stale,'Source change did not invalidate verification approval');
      await browser(['reload']);await ready();await expectUI(stale,'Stale evidence did not survive refresh');
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/development']);await ready();await expectUI(stale,'Stale verification evidence did not survive server restart');
      const view=await verificationView();assert.equal(view.checks[0].id,report.verification.checkId);assert.equal(view.approval.id,report.verification.approvalId);assert.equal(view.approvalCurrent,false);assert.equal(view.canApprove,false);assert.notEqual(view.sourceDigest,report.verification.sourceDigest);
      Object.assign(report.verification,{sourceChanged:true,staleAfterRefresh:true,staleAfterRestart:true});
      await browser(['scrollintoview','.verification-panel']);await capture('verification-stale-after-restart',1744,864);
      for(const path of [projectPath,secondPath])assert.equal((await command('git',['status','--porcelain'],{cwd:path})).trim(),'');
    });
    await step(names[20],async()=>{
      await navigate('projects');await button('새 작업 공간 만들기');
      await expectUI(`!!$('select[aria-label="실행할 작업 공간"]')?.value&&$('select[aria-label="실행할 작업 공간"]').value!==${JSON.stringify(syntheticRun.workspaceId)}`,'New source graph worktree was not selected');
      sourceWorkspaceId=await evaluate(`$('select[aria-label="실행할 작업 공간"]').value`);assert.match(sourceWorkspaceId,/^[a-f0-9-]{36}$/);
      await navigate('development');
      sourceWorkspacePath=await evaluate(`[...document.querySelectorAll('.record-list li')].find(row=>row.querySelector('.badge')?.textContent==='현재 작업 공간')?.querySelector('p')?.textContent`);
      assert.equal(typeof sourceWorkspacePath,'string');assert.ok(resolve(sourceWorkspacePath).startsWith(out('sandbox','workspaces')+(process.platform==='win32'?'\\':'/')));
      const directory=containedPath(runDir,relative(runDir,sourceWorkspacePath),'src');mkdirSync(directory);
      writeFileSync(containedPath(runDir,relative(runDir,directory),'greet.ts'),'export function greet(){return "E2E_SOURCE_GRAPH_BEFORE";}\n');
      writeFileSync(containedPath(runDir,relative(runDir,directory),'main.ts'),'import {greet} from "./greet";export function main(){return greet();}\n');
      await button('현재 소스 분석');
      await expectUI(`$('.source-graph-panel > .badge')?.textContent==='조회 당시 소스와 일치'&&!!$('.source-graph-panel .viz-canvas svg')&&!!$('select[aria-label="소스 파일 탐색"]:enabled')`,'Actual source analysis did not produce a current graph');
      const view=await sourceGraphView(),graph=view.record.graph;
      const main=graph.nodes.find(node=>node.kind==='file'&&node.path==='src/main.ts'),greet=graph.nodes.find(node=>node.kind==='file'&&node.path==='src/greet.ts');
      assert.ok(main&&greet);assert.ok(graph.edges.some(edge=>edge.kind==='imports'&&edge.from===main.id&&edge.to===greet.id));
      const mainFunction=graph.nodes.find(node=>node.kind==='function'&&node.path==='src/main.ts'),greetFunction=graph.nodes.find(node=>node.kind==='function'&&node.path==='src/greet.ts');
      assert.ok(mainFunction&&greetFunction);assert.ok(graph.edges.some(edge=>edge.kind==='calls'&&edge.from===mainFunction.id&&edge.to===greetFunction.id));
      assert.ok(graph.impact.fileIds.includes(main.id)&&graph.impact.fileIds.includes(greet.id));
      await browser(['select','select[aria-label="소스 파일 탐색"]',main.id]);
      await expectUI(`$('.source-preview pre code')?.textContent.includes('return greet();')&&$('.source-preview summary')?.textContent.includes('src/main.ts')`,'Authoritative source file preview did not load');
      await browser(['scrollintoview','.source-graph-panel']);await capture('source-graph-current',1744,864);
      await button('소스 다이어그램을 Artifact로 저장');
      await expectUI(`$('.source-graph-panel [role="status"]')?.textContent.includes('소스 기준이 기록된 Artifact를 저장했습니다.')`,'Source graph Artifact was not stored');
      const artifact=await evaluate(`(async()=>{const response=await fetch('/api/projects/${projectId}/artifacts');if(!response.ok)throw new Error('FIXTURE_ARTIFACT_READ_FAILED');return (await response.json()).find(value=>value.metadata.source_graph_id===${JSON.stringify(view.record.id)});})()`);
      assert.ok(artifact);assert.equal(artifact.metadata.source_workspace_id,sourceWorkspaceId);assert.equal(artifact.metadata.source_digest,graph.sourceDigest);
      report.sourceGraph={workspaceId:sourceWorkspaceId,recordId:view.record.id,sourceDigest:graph.sourceDigest,artifactId:artifact.id,artifactRevision:artifact.revision,files:graph.coverage.files,importsVerified:true,callsVerified:true,filePreviewVerified:true,actualAiExecuted:false};
      await loadSourceArtifact();
      await expectUI(`$('.artifact-source-status')?.innerText.includes('조회 당시 소스와 일치하는 정적 다이어그램')`,'Stored Artifact source binding is not current');
      await browser(['scrollintoview','.artifact-source-status']);await capture('source-artifact-current',1744,864);
    });
    await step(names[21],async()=>{
      writeFileSync(containedPath(runDir,relative(runDir,sourceWorkspacePath),'src','greet.ts'),'export function greet(){return "E2E_SOURCE_GRAPH_CHANGED";}\n');
      await navigate('development');await button('그래프 상태 새로고침');
      const staleGraph=`$('.source-graph-panel > .badge')?.textContent==='소스 변경 · 다시 분석 필요'&&!!$('select[aria-label="소스 파일 탐색"]:disabled')`;
      await expectUI(staleGraph,'Source edit did not invalidate the stored graph');
      await loadSourceArtifact();const staleArtifact=`$('.artifact-source-status')?.innerText.includes('소스 변경 · 이 Artifact는 과거 분석 결과')`;
      await expectUI(staleArtifact,'Source edit did not invalidate the saved source Artifact');
      await browser(['reload']);await ready();await loadSourceArtifact();await expectUI(staleArtifact,'Stale source Artifact did not survive refresh');
      await navigate('development');await expectUI(staleGraph,'Stale graph did not survive refresh');
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/development']);await ready();await expectUI(staleGraph,'Stale graph did not survive server restart');
      const view=await sourceGraphView();assert.equal(view.record.id,report.sourceGraph.recordId);assert.equal(view.freshness,'stale');assert.notEqual(view.currentSourceDigest,report.sourceGraph.sourceDigest);
      await browser(['scrollintoview','.source-graph-panel']);await capture('source-graph-stale-after-restart',1744,864);
      await loadSourceArtifact();await expectUI(staleArtifact,'Stale source Artifact did not survive server restart');
      await browser(['scrollintoview','.artifact-source-status']);await capture('source-artifact-stale-after-restart',1744,864);
      Object.assign(report.sourceGraph,{sourceChanged:true,staleAfterRefresh:true,graphStaleAfterRestart:true,artifactStaleAfterRestart:true});
      for(const path of [projectPath,secondPath]){assert.equal((await command('git',['status','--porcelain'],{cwd:path})).trim(),'');assert.equal(readFileSync(join(path,'README.md'),'utf8'),'Orbit E2E disposable fixture\n');}
    });
    await step(names[22],async()=>{
      await navigate('providers');
      await expectUI(`!!$('.model-hub-panel')&&$$('.model-hub-provider-list > li').length===7&&$('#model-hub-destination')?.value==='e2e-local-model'&&$('#model-hub-consent')?.checked===false&&!!$('#model-hub-model:disabled')&&$$('.model-hub-panel button').some(node=>node.textContent==='모델 목록 조회'&&node.disabled)`,'Model Hub must load seven provider states without consent or discovery');
      const initial=await modelHubView(),before=await modelHubStats();assert.equal(before.counts.total,0);assert.equal(initial.requests.length,0);
      assert.equal(initial.destinations.find(value=>value.id==='bedrock-missing-cli')?.status,'project_blocked','Bedrock fixture must be unavailable outside its exact fourth project');
      const destination=initial.destinations.find(value=>value.id==='e2e-local-model');assert.ok(destination);assert.equal(destination.catalog.status,'not_queried');
      assert.equal(destination.timeoutMs,5000);assert.equal(destination.maxOutputTokens,8);assert.equal(destination.locality,'loopback');assert.equal(destination.credential,'not_required');
      report.modelHubChecks.explicitOperationsStarted=true;report.modelHubChecks.preConsentNetworkRequests=0;
      await browser(['check','#model-hub-consent']);await button('모델 목록 조회');
      await expectUI(`!!$('#model-hub-model:enabled')&&[...$('#model-hub-model').options].some(option=>option.value==='fixture-model')&&$('#model-hub-consent')?.checked===false`,'Explicit catalog discovery or consumed consent is missing');
      await browser(['select','#model-hub-model','fixture-model']);await fill('#model-hub-prompt','ORBIT_MODEL_HUB_NORMAL');
      await expectUI(`$$('.model-hub-panel button').some(node=>node.textContent==='모델 요청 전송'&&node.disabled)`,'Changed prompt must require renewed consent');
      await browser(['check','#model-hub-consent']);await button('모델 요청 전송');
      await expectUI(`$$('.model-hub-history li').some(row=>row.innerText.includes('응답 완료')&&row.querySelector('.model-hub-response')?.textContent==='ORBIT_MODEL_HUB_REPLY'&&row.innerText.includes('토큰 출처: 공급자 응답 · 입력 2 · 출력 3 · 합계 5')&&row.innerText.includes('API 비용 unknown'))&&$('#model-hub-consent')?.checked===false&&$('#model-hub-prompt')?.value===''`,'Actual local text response, provider usage, unknown cost or consumed input is missing');
      const completedView=await modelHubView(),completed=completedView.requests.find(value=>value.execution==='completed');assert.ok(completed);
      assert.equal(completed.response,'ORBIT_MODEL_HUB_REPLY');assert.deepEqual(completed.usage,{promptTokens:2,completionTokens:3,totalTokens:5,source:'provider'});assert.equal(completed.costUsd,null);assert.equal(completedView.costSource,'unknown');
      const after=await modelHubStats();assert.deepEqual(after.counts,{total:2,models:1,chats:1,activeHangs:0,abortedHangs:0,boundedTimeouts:0,rejected:0});
      Object.assign(report.modelHubChecks,{destinationId:destination.id,configDigest:destination.configDigest,completedId:completed.id,completedResponseVerified:true,providerUsageVerified:true,costUnknown:true,localHttpRequests:2});
      await browser(['scrollintoview','.model-hub-panel']);await capture('model-hub-current',1744,864);
      const privateText='orbit-model-e2e@example.invalid';await fill('#model-hub-prompt',privateText);await browser(['check','#model-hub-consent']);await button('모델 요청 전송');
      await expectUI(`!!$('.model-hub-panel > [role="alert"]')&&$('#model-hub-consent')?.checked===false&&$('#model-hub-prompt')?.value===${JSON.stringify(privateText)}`,'Private input denial must retain draft, reset consent and show a safe failure');
      const blockedView=await modelHubView(),blockedStats=await modelHubStats();assert.equal(blockedView.requests.length,completedView.requests.length);assert.equal(blockedView.activeRequestId,null);assert.deepEqual(blockedStats.counts,after.counts);
      report.modelHubChecks.privateInputBlockedBeforeNetwork=true;
    },{consoleAllow:[/^Failed to load resource: the server responded with a status of 403\b/]});
    await step(names[23],async()=>{
      await fill('#model-hub-prompt','ORBIT_MODEL_HUB_HANG');await browser(['check','#model-hub-consent']);await button('모델 요청 전송');
      await expectUI(`$$('.model-hub-panel button').some(node=>node.textContent==='요청 중단'&&!node.disabled)&&$('.model-hub-history')?.innerText.includes('응답 생성 중')`,'Bounded hanging request did not offer an enabled interrupt');
      const hangingView=await modelHubView(),hanging=hangingView.requests.find(value=>value.execution==='running');assert.ok(hanging);assert.equal(hangingView.activeRequestId,hanging.id);
      const hangingStats=await modelHubStats();assert.equal(hangingStats.counts.chats,2);assert.equal(hangingStats.counts.activeHangs,1);
      await button('요청 중단');
      await expectUI(`$$('.model-hub-history li').some(row=>row.innerText.includes(${JSON.stringify(hanging.id)})&&row.innerText.includes('중단 확인'))&&!$$('.model-hub-panel button').some(node=>node.textContent==='요청 중단')`,'Interrupt acknowledgment must become confirmed terminal interruption');
      const interruptedView=await modelHubView(),interrupted=interruptedView.requests.find(value=>value.id===hanging.id);assert.equal(interrupted.execution,'interrupted');assert.equal(interrupted.issue,'PROVIDER_ABORTED');assert.equal(interruptedView.activeRequestId,null);
      const interruptedStats=await modelHubStats();assert.equal(interruptedStats.counts.total,3);assert.equal(interruptedStats.counts.activeHangs,0);assert.equal(interruptedStats.counts.abortedHangs,1);assert.equal(interruptedStats.counts.boundedTimeouts,0);assert.equal(interruptedStats.counts.rejected,0);
      Object.assign(report.modelHubChecks,{interruptedId:hanging.id,interruptConfirmed:true,hangingSocketClosed:true});
      const restoredUi=`$$('.model-hub-history li').some(row=>row.innerText.includes(${JSON.stringify(report.modelHubChecks.completedId)})&&row.querySelector('.model-hub-response')?.textContent==='ORBIT_MODEL_HUB_REPLY'&&row.innerText.includes('응답 완료'))&&$$('.model-hub-history li').some(row=>row.innerText.includes(${JSON.stringify(hanging.id)})&&row.innerText.includes('중단 확인'))&&$('#model-hub-consent')?.checked===false`;
      await browser(['reload']);await ready();await expectUI(restoredUi,'Completed and interrupted model history did not survive refresh');
      await button('Model Hub 상태 새로고침');await expectUI(restoredUi,'Explicit history refresh lost terminal model results');
      assert.deepEqual((await modelHubStats()).counts,interruptedStats.counts,'History GET refresh must not resend requests');
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/providers']);await ready();await expectUI(restoredUi,'Model history did not survive server restart');
      const afterRestart=await modelHubView(),afterRestartStats=await modelHubStats();assert.equal(afterRestart.destinations.find(value=>value.id==='e2e-local-model').configDigest,report.modelHubChecks.configDigest);
      assert.equal(afterRestart.requests.find(value=>value.id===report.modelHubChecks.completedId).response,'ORBIT_MODEL_HUB_REPLY');assert.equal(afterRestart.requests.find(value=>value.id===hanging.id).execution,'interrupted');assert.equal(afterRestartStats.counts.total,0,'Restoring persisted model history and catalog must be inert');
      Object.assign(report.modelHubChecks,{restoredAfterRefresh:true,restoredAfterServerRestart:true,restoredWithoutResend:true,configDigestStableAfterRestart:true});
      await browser(['scrollintoview','.model-hub-panel']);await capture('model-hub-restored',1744,864);
      for(const path of [projectPath,secondPath]){assert.equal((await command('git',['status','--porcelain'],{cwd:path})).trim(),'');assert.equal(readFileSync(join(path,'README.md'),'utf8'),'Orbit E2E disposable fixture\n');}
    });
    await step(names[24],async()=>{
      await navigate('planning');
      const plans=await planningRecords(),plan=plans.find(value=>value.id===syntheticRun.planningVersionId);assert.ok(plan);assert.equal(plan.state,'approved');assert.equal(plan.draft.title,planTitle);
      await expectUI(`!!$('.planning-studio > .planning-toolbar select:enabled')&&[...$('.planning-studio > .planning-toolbar select').options].some(option=>option.value===${JSON.stringify(plan.id)})`,'Saved planning versions did not finish loading');
      await browser(['select','.planning-studio > .planning-toolbar select',plan.id]);
      await expectUI(`$$('.planning-export-actions button').length===2&&$$('.planning-export-actions button').every(node=>!node.disabled)`,'Unchanged saved planning export controls are not ready');
      report.planningHandoff={planId:plan.id,revision:plan.revision,contentHash:plan.contentHash,originalDraft:plan.draft,downloads:[],actualAiExecuted:false};
      for(const [format,label,extension] of [['markdown','저장 버전 Markdown 내보내기','md'],['json','저장 버전 JSON 내보내기','json']]){
        const expected=await evaluate(`(async()=>{const response=await fetch('/api/projects/${projectId}/plans/${plan.id}/export?revision=${plan.revision}&hash=${plan.contentHash}&format=${format}');if(!response.ok)throw new Error('FIXTURE_PLANNING_EXPORT_FAILED');return {bytes:Array.from(new Uint8Array(await response.arrayBuffer())),disposition:response.headers.get('content-disposition')};})()`);
        assert.ok(expected.disposition.includes('attachment'));const filename=`orbit-plan-${plan.id}-v${plan.revision}.${extension}`;assert.ok(expected.disposition.includes(filename));
        await button(label);const file=await downloadedFile(filename,Buffer.from(expected.bytes));
        const parsed=parsePlanningDraft({format,text:readFileSync(file.path,'utf8'),source:plan.draft.source});assert.equal(parsed.ok,true);assert.deepEqual(parsed.draft,plan.draft);
        report.planningHandoff.downloads.push({format,...file,serverBytesExact:true,roundtripExact:true});
      }
      const originalText=await evaluate(`$('.planning-editor textarea').value`);await fill('.planning-editor textarea',originalText+'\n');
      await expectUI(`$$('.planning-export-actions button').every(node=>node.disabled)`,'Dirty planning input must disable both saved-version exports');report.planningHandoff.dirtyExportDisabled=true;
      for(const file of report.planningHandoff.downloads){
        await button('새 기획안 / 편집 내용 버리기');
        await browser(['upload','.planning-studio input[type="file"]',file.path]);
        const text=readFileSync(file.path,'utf8');
        await expectUI(`$('.planning-editor textarea')?.value===${JSON.stringify(text)}&&$('.planning-preview h4')?.textContent===${JSON.stringify(planTitle)}&&$$('.planning-export-actions button').every(node=>node.disabled)&&$('.planning-studio')?.getAttribute('aria-busy')==='false'`,'Downloaded planning file did not reimport as an unsaved new draft');
      }
      await button('초안 저장');await expectUI(`$('.planning-studio [role="status"]')?.textContent.includes('초안을 저장했습니다.')`,'Reimported JSON did not save as a separate draft');
      const importedId=await evaluate(`$('.planning-studio > .planning-toolbar select').value`);assert.notEqual(importedId,plan.id);
      const after=await planningRecords(),original=after.find(value=>value.id===plan.id),imported=after.find(value=>value.id===importedId);
      assert.equal(original.state,'approved');assert.equal(original.contentHash,plan.contentHash);assert.equal(imported.state,'draft');assert.deepEqual(imported.draft,{...plan.draft,source:'import'});
      Object.assign(report.planningHandoff,{importedDraftId:importedId,browserReimportedFormats:['markdown','json'],importedDraftSource:'import',originalApprovalPreserved:true});
      await browser(['scrollintoview','.planning-export-actions']);await capture('planning-reimported-draft',1744,864);
    });
    await step(names[25],async()=>{
      await navigate('projects');await browser(['select','select[aria-label="실행할 작업 공간"]',syntheticRun.workspaceId]);
      await expectUI(`$('select[aria-label="실행할 작업 공간"]')?.value===${JSON.stringify(syntheticRun.workspaceId)}`,'Task-bound evidence workspace was not selected');
      await ready();
      await navigate('planning');
      await expectUI(`[...$('#planning-feedback-task').options].some(option=>option.value===${JSON.stringify(syntheticRun.taskId)})`,'Stored Task is unavailable for feedback');
      await browser(['select','#planning-feedback-task',syntheticRun.taskId]);
      await expectUI(`[...$('#planning-feedback-run').options].some(option=>option.value===${JSON.stringify(syntheticRun.runId)})`,'Current workspace snapshot does not expose the synthetic Task Run');
      await browser(['select','#planning-feedback-run',syntheticRun.runId]);
      await fill('#planning-feedback-question','ORBIT_E2E_REPLAN_QUESTION');await button('개발 증거 미리보기');
      await expectUI(`!!$('.planning-feedback-preview pre code')&&$('.planning-feedback-preview').innerText.includes('현재 검증 통과 근거 없음')&&$('.planning-feedback-preview').innerText.includes('현재 리뷰 승인 유효하지 않음')&&$('.planning-feedback-checks tbody')?.innerText.includes('passed')`,'Historical passed Check and invalid current approval must remain distinct');
      const markdown=await evaluate(`$('.planning-feedback-preview pre code').textContent`);
      const section=/## 개발 증거\n\n(`{3,})json\n([\s\S]*?)\n\1\n/.exec(markdown);assert.ok(section);const evidence=JSON.parse(section[2]);
      assert.equal(evidence.projectId,projectId);assert.equal(evidence.planning.id,report.planningHandoff.planId);assert.equal(evidence.run.id,syntheticRun.runId);assert.equal(evidence.task.id,syntheticRun.taskId);
      assert.equal(evidence.run.execution,'completed');assert.equal(evidence.verification.available,true);assert.equal(evidence.verification.canApprove,false);assert.equal(evidence.verification.approvalCurrent,false);
      const historical=evidence.verification.checks.find(value=>value.id===report.verification.checkId);assert.ok(historical);assert.equal(historical.verdict,'passed');assert.equal(historical.exitCode,0);assert.notEqual(historical.sourceDigest,evidence.verification.sourceDigest);
      assert.ok(markdown.includes('ORBIT_E2E_REPLAN_QUESTION'));assert.ok(!markdown.includes('Fixture-only seed; this is not an AI response'));
      await button('피드백 Markdown 다운로드');const feedbackFile=await downloadedFile(`orbit-planning-feedback-${syntheticRun.runId}.md`,Buffer.from(markdown,'utf8'));
      report.planningHandoff.feedback={...feedbackFile,previewBytesExact:true,taskId:syntheticRun.taskId,runId:syntheticRun.runId,historicalVerdict:'passed',historicalExitCode:0,currentCanApprove:false,currentApproval:false};
      await fill('#planning-feedback-question','ORBIT_E2E_REVISED_QUESTION');
      await expectUI(`!$('.planning-feedback-preview')&&!$$('.planning-feedback button').some(node=>node.textContent==='피드백 Markdown 다운로드')`,'Changing the question must discard the previous preview and its download');
      report.planningHandoff.questionChangeDiscardedPreview=true;
      await browser(['reload']);await ready();
      await expectUI(`!!$('.planning-feedback')&&!$('.planning-feedback-preview')&&$('#planning-feedback-question')?.value===''`,'Feedback preview and transient question must not restore automatically');
      await expectUI(`!!$('.planning-studio > .planning-toolbar select:enabled')&&[...$('.planning-studio > .planning-toolbar select').options].some(option=>option.value===${JSON.stringify(report.planningHandoff.planId)})`,'Original approved planning version did not load after refresh');
      await browser(['select','.planning-studio > .planning-toolbar select',report.planningHandoff.planId]);
      await expectUI(`$('.planning-studio')?.innerText.includes('approved')&&$$('.planning-export-actions button').every(node=>!node.disabled)`,'Original approved saved version did not survive refresh after reimport');
      const plans=await planningRecords();assert.equal(plans.find(value=>value.id===report.planningHandoff.planId).state,'approved');assert.equal(plans.find(value=>value.id===report.planningHandoff.importedDraftId).state,'draft');
      const tasks=await evaluate(`(async()=>{const response=await fetch('/api/projects/${projectId}/tasks');if(!response.ok)throw new Error('FIXTURE_TASK_READ_FAILED');return response.json();})()`);assert.equal(tasks.length,1);assert.equal(tasks[0].id,syntheticRun.taskId);assert.equal(tasks[0].planningVersionId,report.planningHandoff.planId);
      Object.assign(report.planningHandoff,{transientQuestionNotRestored:true,previewNotRestored:true,approvalPreservedAfterRefresh:true,taskUnchanged:true});
      await browser(['scrollintoview','.planning-feedback']);await capture('planning-handoff-restored',1744,864);
      const stats=await modelHubStats();assert.equal(stats.counts.total,0,'Planning exports, previews, uploads and handoff must never invoke a model');
      for(const path of [projectPath,secondPath]){assert.equal((await command('git',['status','--porcelain'],{cwd:path})).trim(),'');assert.equal(readFileSync(join(path,'README.md'),'utf8'),'Orbit E2E disposable fixture\n');}
    });
    await step(names[26],async()=>{
      await navigate('projects');await fill('#project-path',mergeProjectPath);await button('프로젝트 등록');
      await expectUI(`$('.project-location')?.innerText.includes('orbit-ui-merge')`,'Dedicated merge project was not registered');mergeProjectId=await evaluate(`$('select[aria-label="현재 프로젝트"]').value`);assert.ok(mergeProjectId);assert.notEqual(mergeProjectId,projectId);assert.notEqual(mergeProjectId,secondProjectId);
      await button('새 작업 공간 만들기');await expectUI(`!!$('select[aria-label="실행할 작업 공간"]')?.value`,'Dedicated merge worktree was not selected');
      const workspace=await evaluate(`(async()=>{const response=await fetch('/api/state');if(!response.ok)throw new Error('FIXTURE_MERGE_STATE_FAILED');const state=await response.json();return state.workspaces.find(value=>value.id===state.selectedWorkspaceId);})()`);
      assert.equal(workspace.projectId,mergeProjectId);mergeWorkspaceId=workspace.id;mergeWorkspacePath=workspace.path;assert.ok(resolve(mergeWorkspacePath).startsWith(out('sandbox','workspaces')+(process.platform==='win32'?'\\':'/')));
      writeFileSync(containedPath(runDir,relative(runDir,mergeWorkspacePath),'README.md'),'Orbit E2E disposable fixture\nApproved merge fixture target\n');
      writeFileSync(containedPath(runDir,relative(runDir,mergeWorkspacePath),'merge-proof.txt'),'ORBIT_E2E_MERGE_BYTES\n');
      mergeRun=await seedTerminalRun(false);assert.equal(mergeRun.workspaceId,mergeWorkspaceId);assert.equal(mergeRun.taskId,undefined);
      await navigate('development');
      await expectUI(`$('.verification-panel')?.innerText.includes('E2E merge fixture test')&&$$('.verification-panel button').some(node=>node.textContent==='명령 승인 후 실행'&&!node.disabled)`,'Dedicated fixed Node check is unavailable');
      await button('명령 승인 후 실행');
      await expectUI(`$('.verification-panel')?.innerText.includes('e2e-merge-node-check · 통과')&&$$('.verification-panel button').some(node=>node.textContent==='Diff와 검증 결과 확인 후 승인'&&!node.disabled)`,'Merge fixture Node check did not pass');
      await button('Diff와 검증 결과 확인 후 승인');await expectUI(`$('.verification-panel')?.innerText.includes('조회 당시 소스와 검증 결과를 사용자가 승인했습니다.')`,'Merge fixture review approval did not persist');
      const verified=await verificationView(mergeRun);assert.equal(verified.canApprove,true);assert.equal(verified.approvalCurrent,true);assert.equal(verified.checks[0].verdict,'passed');assert.equal(verified.checks[0].exitCode,0);
      await expectUI(`$$('.merge-panel button').some(node=>node.textContent==='병합 상태 새로고침'&&!node.disabled)`,'Read-only merge refresh is unavailable');await button('병합 상태 새로고침');
      await expectUI(`$$('.merge-panel button').some(node=>node.textContent==='승인 내용의 병합 후보 만들기'&&!node.disabled)`,'Current review and clean same-base target did not permit candidate creation');
      const before=await mergeEvidence();assert.equal(before.primary.branch,'main');assert.equal(before.primary.status,'');assert.equal(before.primary.head,before.source.baseSha);assert.equal(before.source.head,before.source.baseSha);assert.equal(before.primary.files['merge-proof.txt'].present,false);assert.equal(before.source.files['merge-proof.txt'].present,true);
      report.merge={projectId:mergeProjectId,workspaceId:mergeWorkspaceId,runId:mergeRun.runId,actualAiExecuted:false,sourceDigest:verified.sourceDigest,checkSetDigest:verified.checkSetDigest,approvalId:verified.approval.id,checkId:verified.checks[0].id,before};
      await button('승인 내용의 병합 후보 만들기');
      await expectUI(`!!$('.merge-candidate')&&$('.merge-history')?.innerText.includes('후보 준비됨 · 아직 반영하지 않음')&&!!$('#merge-apply-consent:enabled')&&!$('#merge-apply-consent').checked&&$$('.merge-panel button').some(node=>node.textContent==='승인한 후보를 대상 브랜치에 반영'&&node.disabled)`,'Prepared candidate must require a separate fresh primary-write approval');
      const preparedView=await mergeView(),record=preparedView.records.find(value=>value.status==='prepared');assert.ok(record?.candidate);assert.equal(record.projectId,mergeProjectId);assert.equal(record.workspaceId,mergeWorkspaceId);assert.equal(record.runId,mergeRun.runId);assert.equal(record.target.head,before.primary.head);assert.equal(record.sourceDigest,before.source.sourceDigest);assert.equal(record.checkSetDigest,verified.checkSetDigest);assert.equal(record.approvalId,verified.approval.id);
      const afterPrepare=await mergeEvidence();assert.deepEqual(afterPrepare.primary,before.primary,'candidate creation must preserve primary HEAD/index/bytes');assert.deepEqual(afterPrepare.source,before.source,'candidate creation must preserve dirty source HEAD/index/bytes');
      Object.assign(report.merge,{recordId:record.id,candidate:record.candidate,target:record.target,afterPrepare,preparePreservedPrimary:true,preparePreservedSource:true,separateApplyConsentRequired:true});await preservedOriginalFixtures();
      await browser(['scrollintoview','.merge-panel']);await capture('merge-candidate-prepared',1744,864);
    });
    await step(names[27],async()=>{
      await browser(['check','#merge-apply-consent']);await button('승인한 후보를 대상 브랜치에 반영');
      await expectUI(`$('.merge-history')?.innerText.includes('반영 확인 · Git/bytes 검증')&&!$('#merge-apply-consent').checked`,'Explicit primary apply did not become a server-verified terminal result');
      const appliedView=await mergeView(),record=appliedView.records.find(value=>value.id===report.merge.recordId);assert.equal(record.status,'applied');assert.equal(record.phase,'apply');assert.equal(record.completionBasis,'git_and_bytes');assert.equal(record.candidate.commitSha,report.merge.candidate.commitSha);
      const after=await mergeEvidence();assert.equal(after.primary.branch,report.merge.before.primary.branch);assert.equal(after.primary.head,record.candidate.commitSha);assert.equal(after.primary.treeSha,record.candidate.treeSha);assert.equal(after.primary.status,'');assert.deepEqual(after.primary.files,report.merge.before.source.files,'the primary must contain the approved source raw bytes');assert.deepEqual(after.source,report.merge.before.source,'primary fast-forward must preserve original source HEAD/index/files and dirty state');
      const parent=(await command('git',['--no-pager','show','--no-patch','--format=%P',record.candidate.commitSha],{cwd:mergeProjectPath})).trim();assert.equal(parent,report.merge.before.primary.head,'one-parent candidate must fast-forward from the original primary');
      Object.assign(report.merge,{afterApply:after,appliedStatus:'applied',completionBasis:'git_and_bytes',singleParentSha:parent,primaryBytesMatchApprovedSource:true,sourcePreservedAfterApply:true});await preservedOriginalFixtures();
      await browser(['scrollintoview','.merge-history']);await capture('merge-applied',1744,864);
    });
    await step(names[28],async()=>{
      await browser(['reload']);await ready();
      const restored=`$('.merge-history')?.innerText.includes('반영 확인 · Git/bytes 검증')&&$('.merge-history')?.innerText.includes(${JSON.stringify(report.merge.recordId)})&&$('.merge-history')?.innerText.includes(${JSON.stringify(report.merge.candidate.commitSha)})`;
      await expectUI(restored,'Verified apply history did not survive browser refresh');const refreshed=await mergeEvidence();assert.deepEqual(refreshed.primary,report.merge.afterApply.primary);assert.deepEqual(refreshed.source,report.merge.before.source);
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/development']);await ready();await expectUI(restored,'Verified apply history did not survive server restart');
      const afterRestart=await mergeEvidence(),view=await mergeView();assert.deepEqual(afterRestart.primary,report.merge.afterApply.primary,'restoring state must never apply again');assert.deepEqual(afterRestart.source,report.merge.before.source);assert.equal(view.records.filter(record=>record.id===report.merge.recordId).length,1);assert.equal(view.records.find(record=>record.id===report.merge.recordId).completionBasis,'git_and_bytes');
      const stats=await modelHubStats();assert.equal(stats.counts.total,0,'merge preview, prepare, apply and restoration must never invoke the model fixture');await preservedOriginalFixtures();
      Object.assign(report.merge,{afterRestart,appliedAfterRefresh:true,appliedAfterRestart:true,noReapplication:true,originalTwoFixturesPreserved:true,sourcePreservedAfterRestart:true});
      await browser(['scrollintoview','.merge-history']);await capture('merge-applied-restored',1744,864);
    });
    await step(names[29],async()=>{
      await navigate('projects');await fill('#project-path',workflowProjectPath);await button('프로젝트 등록');
      await expectUI(`$('.project-location')?.innerText.includes('orbit-ui-workflow')`,'Dedicated workflow project was not registered');workflowProjectId=await evaluate(`$('select[aria-label="현재 프로젝트"]').value`);assert.ok(workflowProjectId);assert.ok(![projectId,secondProjectId,mergeProjectId].includes(workflowProjectId));
      await button('새 작업 공간 만들기');await expectUI(`!!$('select[aria-label="실행할 작업 공간"]')?.value`,'Dedicated workflow worktree was not selected');
      const workspace=await evaluate(`(async()=>{const response=await fetch('/api/state');if(!response.ok)throw new Error('FIXTURE_WORKFLOW_STATE_FAILED');const state=await response.json();return state.workspaces.find(value=>value.id===state.selectedWorkspaceId);})()`);
      assert.equal(workspace.projectId,workflowProjectId);workflowWorkspaceId=workspace.id;workflowWorkspacePath=containedPath(runDir,relative(runDir,workspace.path));
      writeFileSync(containedPath(runDir,relative(runDir,workflowWorkspacePath),'README.md'),'Orbit E2E disposable fixture\nORBIT_E2E_REVIEW_INPUT\nSynthetic read-only review fixture.\n');
      const before=await workflowEvidence();for(const part of [before.primary,before.source])for(const value of Object.values(part.markers))assert.deepEqual(value,{present:false});
      report.workflow={projectId:workflowProjectId,workspaceId:workflowWorkspaceId,actualAiExecuted:false,before};
      await navigate('automation');await expectUI(`!!$('.workflows-panel')&&$$('.workflows-panel button').some(node=>node.textContent==='등록 명령 단계 추가'&&!node.disabled)`,'Registered fixed workflow commands did not load');
      const empty=await workflowView();assert.equal(empty.runs.length,0);assert.equal(empty.versions.length,0);assert.deepEqual(empty.commands.map(value=>value.id).sort(),['e2e-workflow-fail','e2e-workflow-first','e2e-workflow-hang','e2e-workflow-second']);
      await fill('#workflow-name','Orbit E2E fixed DAG');await button('등록 명령 단계 추가');await button('등록 명령 단계 추가');
      await browser(['select','select[aria-label="step-1 등록 명령"]','e2e-workflow-first']);await browser(['select','select[aria-label="step-2 등록 명령"]','e2e-workflow-second']);await browser(['check','.workflow-step:nth-of-type(2) .workflow-dependencies input']);
      await button('워크플로 저장');await expectUI(`!!$('#workflow-version')?.value&&$$('.workflows-panel button').some(node=>node.textContent==='현재 명령·소스 미리보기'&&!node.disabled)`,'Workflow version save did not become ready for preview');
      const versionId=await evaluate(`$('#workflow-version').value`),saved=await workflowView(),version=saved.versions.find(value=>value.id===versionId);assert.equal(version.revision,1);assert.deepEqual(version.definition.steps,[{id:'step-1',commandId:'e2e-workflow-first',dependsOn:[]},{id:'step-2',commandId:'e2e-workflow-second',dependsOn:['step-1']}]);
      await workflowPreviewAndConsent();const passed=await waitWorkflow(versionId,'passed');assert.deepEqual(passed.steps.map(value=>[value.id,value.status,value.exitCode]),[['step-1','passed',0],['step-2','passed',0]]);assert.ok(passed.steps[0].finishedAt<=passed.steps[1].startedAt);assert.equal(passed.attempt,1);assert.equal(passed.retryOfId,null);
      await button('워크플로 상태 새로고침');await expectUI(`$('.workflow-history')?.innerText.includes(${JSON.stringify(passed.id)})&&$('.workflow-history')?.innerText.includes('등록 명령 통과 · 리뷰·병합 아님')&&!$('#workflow-execution-consent')`,'Actual command pass must be a separate workflow result with consumed consent');
      const after=await workflowEvidence();assertWorkflowContext(after);assert.deepEqual(after.source.markers['.workflow-order.tmp'],marker('first\nsecond\n'));assert.deepEqual(after.source.markers['.workflow-fail.tmp'],{present:false});assert.deepEqual(after.source.markers['.workflow-hang.tmp'],{present:false});
      Object.assign(report.workflow,{version1:version,passed,afterPass:after,separateConsentRequired:true,actualDagOrderVerified:true});await preservedOriginalFixtures();preservedMergeFixture();
      await browser(['scrollintoview','.workflow-history']);await capture('workflow-passed',1744,864);
    });
    await step(names[30],async()=>{
      await browser(['select','select[aria-label="step-1 등록 명령"]','e2e-workflow-fail']);await expectUI(`!$('.workflow-preview')`,'Editing a command must invalidate any prior preview');await button('워크플로 새 버전 저장');
      await expectUI(`$('#workflow-version')?.value!==${JSON.stringify(report.workflow.version1.id)}&&$$('.workflows-panel button').some(node=>node.textContent==='현재 명령·소스 미리보기'&&!node.disabled)`,'Second immutable workflow version did not save');
      const versionId=await evaluate(`$('#workflow-version').value`);await workflowPreviewAndConsent();const failed=await waitWorkflow(versionId,'failed');assert.deepEqual(failed.steps.map(value=>[value.id,value.status,value.exitCode]),[['step-1','failed',7],['step-2','skipped',null]]);
      await button('워크플로 상태 새로고침');await expectUI(`$('.workflow-history')?.innerText.includes(${JSON.stringify(failed.id)})&&$$('.workflow-history button').some(node=>node.textContent==='이 실패 실행을 재시도 대상으로 선택'&&!node.disabled)`,'Failed command must allow explicit retry selection');
      const afterFailure=await workflowEvidence();assertWorkflowContext(afterFailure);assert.deepEqual(afterFailure.source.markers['.workflow-order.tmp'],report.workflow.afterPass.source.markers['.workflow-order.tmp']);assert.deepEqual(afterFailure.source.markers['.workflow-fail.tmp'],marker('fail\n'));
      await button('이 실패 실행을 재시도 대상으로 선택');await expectUI(`$('.workflows-panel')?.innerText.includes('재시도 기준 ${failed.id}')`,'Explicit retry must bind the failed run before a fresh preview');
      await workflowPreviewAndConsent(true);const retried=await waitWorkflow(versionId,'failed',[failed.id]);assert.equal(retried.retryOfId,failed.id);assert.equal(retried.attempt,2);assert.deepEqual(retried.steps.map(value=>[value.id,value.status,value.exitCode]),[['step-1','failed',7],['step-2','skipped',null]]);
      await button('워크플로 상태 새로고침');await expectUI(`$('.workflow-history')?.innerText.includes(${JSON.stringify(retried.id)})`,'Explicit retry result did not load');
      const view=await workflowView(),version=view.versions.find(value=>value.id===versionId);assert.equal(version.revision,2);assert.equal(version.workflowId,report.workflow.version1.workflowId);assert.deepEqual(view.versions.find(value=>value.id===report.workflow.version1.id),report.workflow.version1);assert.equal(view.runs.length,3);assert.equal(view.runs.filter(value=>value.retryOfId===failed.id).length,1);
      const after=await workflowEvidence();assertWorkflowContext(after);assert.deepEqual(after.source.markers['.workflow-order.tmp'],marker('first\nsecond\n'));assert.deepEqual(after.source.markers['.workflow-fail.tmp'],marker('fail\nfail\n'));assert.deepEqual(after.source.markers['.workflow-hang.tmp'],{present:false});
      Object.assign(report.workflow,{version2:version,failed,retried,afterRetry:after,dependentSkipped:true,noAutomaticRetry:true,immutableVersionPreserved:true});await preservedOriginalFixtures();preservedMergeFixture();
      await browser(['click','.workflow-history .record-list > li:first-child summary']);await expectUI(`$('.workflow-history')?.innerText.includes('ORBIT_WORKFLOW_EXPECTED_FAILURE')&&$('.workflow-history')?.innerText.includes('실행하지 않음')`,'Actual failure output and dependent skipped status are missing');
      await browser(['scrollintoview','.workflow-history']);await capture('workflow-failed-retry',1744,864);
    });
    await step(names[31],async()=>{
      await browser(['select','select[aria-label="step-1 등록 명령"]','e2e-workflow-hang']);await button('워크플로 새 버전 저장');
      await expectUI(`$('#workflow-version')?.value!==${JSON.stringify(report.workflow.version2.id)}&&$$('.workflows-panel button').some(node=>node.textContent==='현재 명령·소스 미리보기'&&!node.disabled)`,'Third workflow version did not save');
      const versionId=await evaluate(`$('#workflow-version').value`);await workflowPreviewAndConsent();const running=await waitWorkflow(versionId,'running');
      const hangPath=containedPath(runDir,relative(runDir,workflowWorkspacePath),'.workflow-hang.tmp'),deadline=Date.now()+5000;let started=false;
      while(Date.now()<deadline){try{if(readFileSync(hangPath,'utf8')==='started\n'){started=true;break;}}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolveWait=>setTimeout(resolveWait,80));}assert.equal(started,true,'The actual child must start before UI interruption');
      await expectUI(`$$('.workflow-history button').some(node=>node.textContent==='워크플로 중단'&&!node.disabled)`,'Running workflow did not expose enabled interruption');await button('워크플로 중단');
      const interrupted=await waitWorkflow(versionId,'interrupted');assert.equal(interrupted.id,running.id);assert.deepEqual(interrupted.steps.map(value=>value.status),['interrupted','skipped']);
      await button('워크플로 상태 새로고침');const restored=`$('.workflow-history')?.innerText.includes(${JSON.stringify(interrupted.id)})&&$('.workflow-history')?.innerText.includes('중단 확인')&&!$$('.workflow-history button').some(node=>node.textContent==='워크플로 중단')`;
      await expectUI(restored,'Interrupt request must become a confirmed terminal workflow result');const beforeRestart=await workflowEvidence();assertWorkflowContext(beforeRestart);assert.deepEqual(beforeRestart.source.markers['.workflow-order.tmp'],marker('first\nsecond\n'));assert.deepEqual(beforeRestart.source.markers['.workflow-fail.tmp'],marker('fail\nfail\n'));assert.deepEqual(beforeRestart.source.markers['.workflow-hang.tmp'],marker('started\n'));
      await browser(['reload']);await ready();await expectUI(restored,'Workflow terminal records did not survive refresh');assert.deepEqual(await workflowEvidence(),beforeRestart);
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/automation']);await ready();await expectUI(restored,'Workflow terminal records did not survive server restart');
      const after=await workflowEvidence(),view=await workflowView();assert.deepEqual(after,beforeRestart,'History restoration must never replay fixed commands');assert.equal(view.runs.length,4);assert.equal(view.versions.length,3);assert.equal(view.busy,false);assert.equal(view.recoveryRequired,false);assert.equal(view.runs.find(value=>value.id===interrupted.id).status,'interrupted');
      for(const version of [report.workflow.version1,report.workflow.version2])assert.deepEqual(view.versions.find(value=>value.id===version.id),version);assert.equal(view.versions.find(value=>value.id===versionId).revision,3);
      assert.equal((await modelHubStats()).counts.total,0,'Workflow operations and history restoration must never invoke the model fixture');await preservedOriginalFixtures();preservedMergeFixture();
      Object.assign(report.workflow,{version3:view.versions.find(value=>value.id===versionId),interrupted,actualProcessStarted:true,beforeRestart,afterRestart:after,restoredAfterRefresh:true,restoredAfterServerRestart:true,noReplay:true,originalTwoPreserved:true,mergePrimaryAndSourcePreserved:true});
      await browser(['scrollintoview','.workflow-history']);await capture('workflow-interrupted-restored',1744,864);
    });
    await step(names[32],async()=>{
      const sourceBefore=await workflowEvidence(),networkBefore=await modelHubStats();assert.equal(networkBefore.counts.total,0);
      await navigate('providers');await expectUI(`[...$('#model-hub-destination')?.options??[]].some(option=>option.value==='bedrock-missing-cli')`,'Explicit fourth-project Bedrock fixture destination is missing');
      await browser(['select','#model-hub-destination','bedrock-missing-cli']);
      await expectUI(`$('#model-hub-destination')?.value==='bedrock-missing-cli'&&!!$('.model-hub-bedrock-disclosure')&&$('.model-hub-bedrock-disclosure').innerText.includes('비스트리밍')&&$('.model-hub-bedrock-disclosure').innerText.includes('별도인 API 과금')&&$('.model-hub-bedrock-disclosure').innerText.includes('비정상 종료 후 파일이 남을 수')&&$('.model-hub-bedrock-disclosure').innerText.includes('요금 상한이 아닙니다')&&$('.model-hub-consent').innerText.includes('임시 입력 파일')&&!$('#model-hub-consent').checked&&$$('.model-hub-panel button').some(node=>node.textContent==='모델 목록 조회'&&node.disabled)&&!!$('#model-hub-model:disabled')`,'Bedrock risks and temporary input disclosure must be visible before explicit consent');
      const before=await modelHubView(workflowProjectId),destination=before.destinations.find(value=>value.id==='bedrock-missing-cli');assert.equal(destination.status,'configured');assert.equal(destination.providerId,'bedrock');assert.equal(destination.transport,'aws_cli_converse');assert.deepEqual(destination.configuredModels,['amazon.nova-micro-v1:0']);assert.equal(destination.catalog.status,'not_queried');assert.equal(before.requests.length,0);
      for(const scope of [projectId,secondProjectId,mergeProjectId])assert.equal((await modelHubView(scope)).destinations.find(value=>value.id===destination.id)?.status,'project_blocked');
      await browser(['check','#model-hub-consent']);await button('모델 목록 조회');
      const failedUi=`$('#model-hub-destination')?.value==='bedrock-missing-cli'&&$('.model-hub-controls')?.innerText.includes('BEDROCK_CLI_NOT_FOUND')&&$('.model-hub-controls')?.innerText.includes('조회 실패')&&$('#model-hub-consent')?.checked===false&&!!$('#model-hub-model:disabled')&&$$('.model-hub-panel button').some(node=>node.textContent==='모델 요청 전송'&&node.disabled)`;
      await expectUI(failedUi,'Actual missing CLI diagnosis must fail closed and leave chat unavailable');
      const failed=await modelHubView(workflowProjectId),catalog=failed.destinations.find(value=>value.id===destination.id).catalog;assert.equal(catalog.status,'failed');assert.equal(catalog.issue,'BEDROCK_CLI_NOT_FOUND');assert.deepEqual(catalog.models,[]);assert.ok(catalog.checkedAt);assert.equal(failed.requests.length,0);assert.equal(failed.activeRequestId,null);assert.deepEqual((await modelHubStats()).counts,networkBefore.counts);
      await fill('#model-hub-prompt','ORBIT_BEDROCK_DISABLED_INPUT');await browser(['check','#model-hub-consent']);await expectUI(`$('#model-hub-consent')?.checked===true&&!!$('#model-hub-model:disabled')&&$$('.model-hub-panel button').some(node=>node.textContent==='모델 요청 전송'&&node.disabled)`,'Renewed consent and nonempty input must not bypass a failed empty catalog');
      await browser(['reload']);await ready();await expectUI(failedUi,'Missing CLI diagnostic did not restore after browser refresh');assert.deepEqual((await modelHubView(workflowProjectId)).destinations.find(value=>value.id===destination.id).catalog,catalog);
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/providers']);await ready();await expectUI(failedUi,'Missing CLI diagnostic did not restore after server restart');
      const restored=await modelHubView(workflowProjectId),after=await workflowEvidence();assert.deepEqual(restored.destinations.find(value=>value.id===destination.id).catalog,catalog,'Restoring the failure must not re-run CLI diagnosis');assert.equal(restored.requests.length,0);assert.equal(restored.activeRequestId,null);assert.deepEqual(after,sourceBefore,'Missing CLI diagnosis and restoration must preserve fourth primary/source and ignored markers');assert.equal((await modelHubStats()).counts.total,0);await preservedOriginalFixtures();preservedMergeFixture();
      report.bedrockMissingCli={projectId:workflowProjectId,destinationId:destination.id,configDigest:destination.configDigest,catalog,otherProjectsBlocked:true,explicitConsentRequired:true,chatDeniedWithRenewedConsent:true,noModelRequestCreated:true,noAutomaticRetry:true,diagnosticRestoredAfterRefresh:true,diagnosticRestoredAfterRestart:true,sourcePreserved:true,actualAwsCliExecuted:false,actualAiExecuted:false,externalServiceRequests:0,before:sourceBefore,after};
      await browser(['scrollintoview','.model-hub-bedrock-disclosure']);await capture('bedrock-missing-cli-restored',1744,864);
    });
    await step(names[33],async()=>{
      const before=await workflowEvidence();assert.deepEqual(before,report.workflow.afterRestart);const initialStats=await reviewFixture('complete');assert.equal(initialStats.counts.created,0);assert.equal(initialStats.counts.reviewStarts,0);
      await navigate('development');await expectUI(`!!$('.review-panel')&&$$('.review-panel button').some(node=>node.textContent==='Native Review 입력 미리보기'&&!node.disabled)`,'Explicit native review preview is unavailable for the fourth fixture');
      const initial=await reviewView();assert.equal(initial.records.length,0);assert.equal(initial.recoveryRequired,false);assert.equal(initial.sourceDigest,before.source.sourceDigest);await reviewDidNotApprove();
      const prepared=await previewReviewAndConsent();assert.equal(prepared.before.counts.created,0,'GET and preview must never create a native review session');assert.equal(prepared.before.counts.reviewStarts,0);
      const completed=await waitReview('completed');assert.equal(completed.processStopped,true);assert.equal(completed.runId,null);assert.equal(completed.sourceDigest,before.source.sourceDigest);assert.equal(completed.finishedDigest,before.source.sourceDigest);assert.equal(completed.response,'Synthetic review fixture. No actual AI was executed. No concrete finding is asserted.');
      await button('리뷰 상태 새로고침');const restored=`$('.review-history')?.innerText.includes(${JSON.stringify(completed.id)})&&$('.review-history')?.innerText.includes('리뷰 완료 · 검증 승인 아님')&&$('.review-response')?.textContent===${JSON.stringify(completed.response)}&&$('.review-history')?.innerText.includes('종료 확인됨')&&!$('#review-start-consent')`;
      await expectUI(restored,'Matching synthetic review completion must remain separate from verification and consume consent');const completedStats=await reviewFixture();assert.deepEqual(completedStats.counts,{created:1,reviewStarts:1,interrupts:0,closed:1,rejectedFactory:0,active:0});assert.equal(completedStats.last.workspaceId,workflowWorkspaceId);assert.equal(completedStats.last.threadId,completed.threadId);assert.equal(completedStats.last.turnId,completed.turnId);assert.deepEqual(await workflowEvidence(),before);await reviewDidNotApprove();
      await browser(['reload']);await ready();await expectUI(restored,'Synthetic completed review did not survive refresh');assert.deepEqual((await reviewFixture()).counts,completedStats.counts);
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/development']);await ready();await expectUI(restored,'Synthetic completed review did not survive server restart');
      const restartedStats=await reviewFixture(),after=await workflowEvidence();assert.equal(restartedStats.counts.created,0);assert.equal(restartedStats.counts.reviewStarts,0,'Restoring review metadata must not reconnect or repeat inference');assert.deepEqual(after,before);await reviewDidNotApprove();await preservedOriginalFixtures();preservedMergeFixture();assert.equal((await modelHubStats()).counts.total,0);
      report.nativeReview={workspaceId:workflowWorkspaceId,projectId:workflowProjectId,actualAiExecuted:false,actualCliExecuted:false,preview:prepared.preview,completed,completedStats,before,afterCompletedRestart:after,noVerificationOrApprovalFabricated:true,completedAfterRefresh:true,completedAfterRestart:true,noCompletionReplay:true};
      await browser(['scrollintoview','.review-history']);await capture('native-review-completed-restored',1744,864);
    });
    await step(names[34],async()=>{
      const mode=await reviewFixture('hang');assert.equal(mode.counts.reviewStarts,0);const prepared=await previewReviewAndConsent();assert.equal(prepared.before.counts.reviewStarts,0);const running=await waitReview('running',[report.nativeReview.completed.id]);
      const deadline=Date.now()+5000;let runningStats;do{runningStats=await reviewFixture();if(runningStats.counts.reviewStarts===1)break;await new Promise(resolveWait=>setTimeout(resolveWait,60));}while(Date.now()<deadline);assert.equal(runningStats.counts.created,1);assert.equal(runningStats.counts.reviewStarts,1);assert.equal(runningStats.counts.active,1);assert.equal(runningStats.last.mode,'hang');
      await expectUI(`$$('.review-history button').some(node=>node.textContent==='Native Review 중단'&&!node.disabled)`,'Actual fake review/start acceptance must expose an enabled own interrupt');await button('Native Review 중단');
      const interrupted=await waitReview('interrupted');assert.equal(interrupted.id,running.id);assert.equal(interrupted.processStopped,true);assert.equal(interrupted.response,'');await button('리뷰 상태 새로고침');
      const restored=`$('.review-history')?.innerText.includes(${JSON.stringify(interrupted.id)})&&$('.review-history')?.innerText.includes('중단 결과')&&$('.review-history')?.innerText.includes(${JSON.stringify(report.nativeReview.completed.id)})&&!$$('.review-history button').some(node=>node.textContent==='Native Review 중단')&&!$('.review-recovery')`;
      await expectUI(restored,'Review interruption must become a persisted terminal result with observed fake RPC closure');const interruptedStats=await reviewFixture();assert.deepEqual(interruptedStats.counts,{created:1,reviewStarts:1,interrupts:1,closed:1,rejectedFactory:0,active:0});assert.deepEqual(await workflowEvidence(),report.nativeReview.before);await reviewDidNotApprove();
      await browser(['reload']);await ready();await expectUI(restored,'Interrupted synthetic review did not survive refresh');assert.deepEqual((await reviewFixture()).counts,interruptedStats.counts);
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/development']);await ready();await expectUI(restored,'Interrupted synthetic review did not survive server restart');
      const view=await reviewView(),stats=await reviewFixture(),after=await workflowEvidence();assert.equal(view.records.length,2);assert.equal(view.records.find(value=>value.id===interrupted.id).execution,'interrupted');assert.equal(view.records.find(value=>value.id===report.nativeReview.completed.id).execution,'completed');assert.equal(view.recoveryRequired,false);assert.equal(view.busy,false);assert.equal(stats.counts.created,0);assert.equal(stats.counts.reviewStarts,0);assert.deepEqual(after,report.nativeReview.before);await reviewDidNotApprove();await preservedOriginalFixtures();preservedMergeFixture();assert.equal((await modelHubStats()).counts.total,0);
      Object.assign(report.nativeReview,{interrupted,interruptedStats,actualMockReviewStarted:true,interruptedAfterRefresh:true,interruptedAfterRestart:true,noReplay:true,noAutomaticConnect:true,afterRestart:after,firstTwoAndMergePreserved:true,fourthPrimaryAndSourcePreserved:true});
      await browser(['scrollintoview','.review-history']);await capture('native-review-interrupted-restored',1744,864);
    });
    await step(names[35],async()=>{
      const before=await workflowEvidence(),initial=await inventoryFixture();assert.deepEqual(before,report.nativeReview.before);assert.deepEqual(initial.counts,{created:0,mcp:0,skills:0,hooks:0,closed:0,forbidden:0});
      await navigate('extensions');await expectUI(inventoryUnknown,'Disconnected inventory must be unknown with collection disabled');assert.equal((await inventoryView()).source,'not_queried');
      await navigate('agents');await button('Codex 연결');await expectUI(`$('.connection')?.innerText.includes('Codex 연결됨')`,'Explicit synthetic session did not connect');
      assert.deepEqual((await inventoryFixture()).counts,{created:1,mcp:1,skills:0,hooks:0,closed:0,forbidden:0});assert.equal((await inventoryView()).source,'not_queried','Connection alone must not collect metadata');
      await navigate('extensions');await button('공식 확장 목록 조회');await expectUI(inventoryVisible,'Sanitized extension inventory or configured/effective distinction is missing');
      const inventory=await inventoryView(),collected=await inventoryFixture(),cacheStarted=Date.now();assert.equal(inventory.workspaceId,workflowWorkspaceId);assert.equal(inventory.source,'codex_app_server');assert.ok(inventory.checkedAt);assert.ok(!JSON.stringify(inventory).includes(workflowWorkspacePath));assert.deepEqual(collected.counts,{created:1,mcp:2,skills:1,hooks:1,closed:0,forbidden:0});
      await button('공식 확장 목록 조회');await button('목록 상태 새로고침');await expectUI(inventoryVisible,'Cached inventory disappeared');assert.ok(Date.now()-cacheStarted<60000,'Cache scenario exceeded its 60-second window');assert.deepEqual((await inventoryFixture()).counts,collected.counts,'Immediate repeat and state refresh must not recollect');assert.deepEqual(await inventoryView(),inventory);
      assert.deepEqual(await workflowEvidence(),before);await reviewDidNotApprove();assert.equal((await modelHubStats()).counts.total,0);
      report.extensions={workspaceId:workflowWorkspaceId,actualAiExecuted:false,actualCliExecuted:false,before,collected,inventory,explicitCollection:true,cacheReused:true,rawMarkerAbsent:true};
      await browser(['scrollintoview','.extensions-panel']);await capture('extensions-collected',1744,864);
    });
    await step(names[36],async()=>{
      await browser(['reload']);await ready();await expectUI(inventoryVisible,'Browser refresh must read the current session cache');assert.deepEqual((await inventoryFixture()).counts,report.extensions.collected.counts);assert.deepEqual(await inventoryView(),report.extensions.inventory);
      await browser(['open',report.url+'/app.css']);await stopServer();await startServer(serverPort);await browser(['open',report.url+'/#/extensions']);await ready();await expectUI(inventoryUnknown,'Server restart must clear inventory and require explicit reconnection');
      const after=await inventoryFixture(),view=await inventoryView();assert.deepEqual(after.counts,{created:0,mcp:0,skills:0,hooks:0,closed:0,forbidden:0});assert.equal(view.source,'not_queried');assert.equal(view.status,'unknown');assert.equal(view.checkedAt,null);
      assert.deepEqual(await workflowEvidence(),report.extensions.before);await reviewDidNotApprove();await preservedOriginalFixtures();preservedMergeFixture();assert.equal((await modelHubStats()).counts.total,0);
      for(const suffix of ['','-wal','-shm']){const path=out('sandbox','test.sqlite'+suffix);if(existsSync(path))assert.equal(readFileSync(path).includes(Buffer.from('ORBIT_INVENTORY_FORBIDDEN_RAW')),false,'Native metadata must not enter the database');}
      Object.assign(report.extensions,{cacheAfterReload:true,unknownAfterRestart:true,noAutomaticConnect:true,noAutomaticCollection:true,sourcePreserved:true,rawDatabaseMarkerAbsent:true,afterRestart:after});await browser(['scrollintoview','.extensions-panel']);await capture('extensions-restarted-unknown',1744,864);
    });
  }
}catch(error){
  report.failure={step:currentStep,cause:String(error.stack??error)};
  if(browserAttempted){
    for(const [label,action] of [['screenshot',()=>capture('failure')],['snapshot',async()=>writeFileSync(out('logs','failure-snapshot.json'),await browser(['snapshot'],true))],['errors',async()=>writeFileSync(out('logs','failure-errors.json'),await browser(['errors'],true))],['console',async()=>writeFileSync(out('logs','failure-console.json'),await browser(['console'],true))]])try{await action();}catch(captureError){report.failure[label+'Error']=String(captureError);}
  }
}finally{
  if(browserAttempted)try{await browser(['close'],true);}catch(error){report.cleanupErrors.push('Browser: '+String(error));}
  try{await stopServer();}catch(error){report.cleanupErrors.push('Server: '+String(error));}
  if(abortController.signal.aborted&&!report.failure)report.failure={step:currentStep,cause:'E2E_INTERRUPTED'};
  report.finishedAt=new Date().toISOString();report.status=report.failure?'failed':overallStatus(checkOnly,report.steps,report.cleanupErrors);persist();
  const link=path=>relative(join(repo,'docs'),path).replaceAll('\\','/');
  const markdown=`# Orbit UI E2E 결과\n\n- 실행: ${report.startedAt}\n- 모드: ${report.mode}\n- 결과: **${report.status}**\n- agent-browser: ${report.agentBrowser??'확인 실패'}\n- 격리 서버: ${report.url??'실행하지 않음'}\n- 기록: [result.json](${link(out('result.json'))}) · [commands.jsonl](${link(out('commands.jsonl'))})\n\n## 실행 방법\n\n일반 PowerShell에서 프로젝트 루트 기준:\n\n\`\`\`powershell\nnode scripts/verify-orbit-ui.mjs\n\`\`\`\n\n샌드박스용: \`node scripts/verify-orbit-ui.mjs --check-only\`. 이 모드는 제품 빌드·브라우저를 실행하지 않으며 E2E 결과를 not_run으로 남긴다. 설치·권한 확대·자동 수정은 하지 않는다.\n\n## 단계\n\n| 단계 | 결과 |\n| --- | --- |\n${report.steps.map(item=>`| ${item.name} | ${item.status} |`).join('\n')}\n\n## 실패 및 정리\n\n${report.failure?'실패 단계: '+report.failure.step+'\n\n```text\n'+report.failure.cause+'\n```':'실행한 검사에서 보고된 실패 없음. not_run은 성공이 아니다.'}\n\n정리 오류: ${report.cleanupErrors.length?report.cleanupErrors.join('\n'):'없음'}\n\n최소 후속 조치: 실패한 단계의 stdout/stderr와 브라우저 증거를 먼저 확인한다. CLI 스키마 불일치는 설치 버전의 JSON 출력을 확인해 파서만 수정한다. CDP 실행 실패나 파일시스템 접근 거부는 정상 PowerShell의 동일 명령으로 비교하며 보안 우회나 원인 추정으로 성공 처리하지 않는다.\n\n## 스크린샷\n\n${report.screenshots.length?report.screenshots.map(image=>`- [${image.file}](${link(out(image.file))}) (${image.width}×${image.height})`).join('\n'):'0장 — 브라우저 미실행 또는 캡처 단계 미도달. 기존 수동 캡처를 이번 자동 검증 증거로 대체하지 않는다.'}\n\n## 격리와 검증 한계\n\n새 run 디렉터리의 test.sqlite와 두 disposable Git 저장소만 사용한다. 서버는 실제 제품 HTTP/Controller/Store/Projects를 재사용하고 AI factory는 항상 거절한다. 사용자 DB·인증 파일·실제 프로젝트에 접근하지 않는다. 브라우저는 전용 session/namespace, 빈 명시적 설정, 127.0.0.1 도메인 제한을 사용하며 기존 승인 관련 환경변수는 유지한다. 테스트 중 사용한 DB와 증거는 삭제하지 않는다. SIGINT/SIGTERM은 finally 정리를 수행하며 강제 프로세스 종료·OS 종료는 보장할 수 없다.\n\n${report.limitations.map(item=>'- '+item).join('\n')}\n`;
  // The run-local report and docs entry live at different depths.
  const documented=markdown.replace('새 run 디렉터리의 test.sqlite와 두 disposable Git 저장소만 사용한다.','새 run 디렉터리의 test.sqlite와 네 disposable Git 저장소를 사용한다. 첫 두 primary fixture는 보존하고 실제 병합은 별도 승인된 세 번째 primary에만 반영한다. 네 번째 worktree에서만 고정 workflow 명령과 ignored 표식 및 baseline 전 고정 리뷰 marker를 사용하며 primary와 앞선 세 저장소는 보존한다.').replace('AI factory는 항상 거절한다.','기본 AI factory는 거절하며 여섯 번째 exact grant의 읽기 전용 리뷰와 일곱 번째 exact grant의 확장 목록에만 네 번째 worktree의 fake RpcPort를 허용한다. 실제 Codex CLI·AI는 실행하지 않는다.');
  writeFileSync(out('report.md'),documented.replaceAll('('+link(runDir)+'/', '('));
  writeFileSync(join(repo,'docs','ORBIT-E2E-RESULTS.md'),documented);
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  console.log(`\n${report.status}: ${runDir}`);process.exitCode=report.status==='failed'?1:0;
}
