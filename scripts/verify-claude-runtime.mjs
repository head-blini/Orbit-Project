// Live check of the Claude Code adapter against the installed, already-logged-in CLI.
// Uses empty temporary directories and the subscription login only: read-only tools,
// then one write-mode Task whose deliverable must stay inside its own folder.
// Prints sanitized outcome fields; never prints prompts' tool inputs, stderr or credentials.
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeCodeRun,findClaude} from '../server/runtimes/claude-code.ts';
import {claudeTaskPrompt,executionForClaudeOutcome} from '../server/runtimes/claude-task.ts';

const root=mkdtempSync(join(tmpdir(),'orbit-claude-live-'));
const report={executable:null,completion:null,interrupt:null,workspaceUntouched:null,write:null};
try{
  const executable=findClaude();report.executable='found';
  const kinds=[];let auth=null;
  const done=await new ClaudeCodeRun({executable,cwd:root,mode:'read'}).start('Reply with exactly the word OK.',event=>{kinds.push(event.kind);if(event.kind==='session')auth=event.auth;});
  report.completion={status:done.status,exit:done.exit,exitCode:done.exitCode,auth,sessionIdPresent:!!done.sessionId,response:done.response.slice(0,20),events:[...new Set(kinds)],ignoredLines:done.ignoredLines};
  const run=new ClaudeCodeRun({executable,cwd:root,mode:'read'});let requested=null;
  const stopped=await run.start('Count slowly from 1 to 400, one number per line, with a short sentence about each number.',event=>{if(event.kind==='session'&&requested===null)requested=run.interrupt();});
  report.interrupt={requested,status:stopped.status,exit:stopped.exit,forced:stopped.forced,signal:stopped.signal,exitCode:stopped.exitCode};
  report.workspaceUntouched=readdirSync(root).length===0;
  // Write mode: a non-code deliverable inside a sibling folder that stands in for a general project.
  const project=mkdtempSync(join(root,'project-')),outside=readdirSync(root).length;
  const prompt=claudeTaskPrompt({title:'짧은 요약 작성',goal:'Orbit 어댑터 확인용 한 줄 요약',baseline:{planningVersionId:'live',revision:1,contentHash:'0'.repeat(64)},
    acceptanceCriteria:['summary.md 파일에 한 문장'],constraints:['다른 파일을 만들지 않는다'],nonGoals:['웹 검색'],decisions:[],deliverable:'summary.md'});
  const wrote=await new ClaudeCodeRun({executable,cwd:project,mode:'write'}).start(prompt,()=>{});
  const files=readdirSync(project);
  report.write={status:wrote.status,mapped:executionForClaudeOutcome(wrote),files,deliverableBytes:existsSync(join(project,'summary.md'))?readFileSync(join(project,'summary.md')).length:0,outsideUnchanged:readdirSync(root).length===outside};
}catch(error){report.error=error instanceof Error?error.message:'failed';process.exitCode=1;}
finally{rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
if(report.completion?.status!=='completed'||report.interrupt?.status!=='interrupted'||!report.workspaceUntouched||report.write?.status!=='completed'||!report.write?.deliverableBytes||!report.write?.outsideUnchanged)process.exitCode=1;
