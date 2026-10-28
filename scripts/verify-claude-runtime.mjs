// Live check of the Claude Code adapter against the installed, already-logged-in CLI.
// Uses an empty temporary directory, read-only tools and the subscription login only.
// Prints sanitized outcome fields; never prints prompts' tool inputs, stderr or credentials.
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeCodeRun,findClaude} from '../server/runtimes/claude-code.ts';

const root=mkdtempSync(join(tmpdir(),'orbit-claude-live-'));
const report={executable:null,completion:null,interrupt:null,workspaceUntouched:null};
try{
  const executable=findClaude();report.executable='found';
  const kinds=[];let auth=null;
  const done=await new ClaudeCodeRun({executable,cwd:root,mode:'read'}).start('Reply with exactly the word OK.',event=>{kinds.push(event.kind);if(event.kind==='session')auth=event.auth;});
  report.completion={status:done.status,exit:done.exit,exitCode:done.exitCode,auth,sessionIdPresent:!!done.sessionId,response:done.response.slice(0,20),events:[...new Set(kinds)],ignoredLines:done.ignoredLines};
  const run=new ClaudeCodeRun({executable,cwd:root,mode:'read'});let requested=null;
  const stopped=await run.start('Count slowly from 1 to 400, one number per line, with a short sentence about each number.',event=>{if(event.kind==='session'&&requested===null)requested=run.interrupt();});
  report.interrupt={requested,status:stopped.status,exit:stopped.exit,forced:stopped.forced,signal:stopped.signal,exitCode:stopped.exitCode};
  report.workspaceUntouched=readdirSync(root).length===0;
}catch(error){report.error=error instanceof Error?error.message:'failed';process.exitCode=1;}
finally{rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
if(report.completion?.status!=='completed'||report.interrupt?.status!=='interrupted'||!report.workspaceUntouched)process.exitCode=1;
