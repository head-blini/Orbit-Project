#!/usr/bin/env node
// Runs one `codex exec` task with a durable record, a per-task lock and no sandbox bypass.
// Usage: node codex-run.mjs --task <id> --cwd <dir> [--sandbox read-only|workspace-write] [--model <m>] [--resume <sessionId>] [--ack-unconfirmed] < prompt.md
//        node codex-run.mjs --status [--task <id>]
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,appendFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=join(repo,'.local/orchestrator/codex');
const args=process.argv.slice(2),flag=name=>args.includes('--'+name),opt=name=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:undefined;};
const json=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const out=value=>console.log(JSON.stringify(value,null,2));

if(flag('status')){
  const tasks=opt('task')?[opt('task')]:existsSync(root)?readdirSync(root):[];
  out(tasks.map(task=>{const dir=join(root,task),lock=json(join(dir,'lock.json'));
    const runs=existsSync(dir)?readdirSync(dir).filter(name=>name!=='lock.json').map(id=>json(join(dir,id,'meta.json'))).filter(Boolean).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)):[];
    return {task,lock:lock?{...lock,alive:alive(lock.pid)}:null,runs:runs.map(({runId,status,exitCode,sessionId,startedAt,finishedAt})=>({runId,status,exitCode,sessionId,startedAt,finishedAt}))};}));
  process.exit(0);
}

const task=opt('task'),cwd=opt('cwd'),sandbox=opt('sandbox')??'read-only';
if(!task||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(task))throw new Error('--task <id> required ([A-Za-z0-9._-])');
if(!cwd||!existsSync(cwd))throw new Error('--cwd <existing dir> required');
// Never default to, or allow, unrestricted execution from this wrapper.
if(!['read-only','workspace-write'].includes(sandbox))throw new Error('sandbox must be read-only or workspace-write');
const realCwd=realpathSync(cwd);
if(!realCwd.startsWith(realpathSync(repo)))throw new Error('cwd must be inside the Orbit repository or its .worktrees');

const taskDir=join(root,task),lockPath=join(taskDir,'lock.json');
mkdirSync(taskDir,{recursive:true});
const lock=json(lockPath);
if(lock){
  if(alive(lock.pid)){out({status:'duplicate_refused',reason:'same task is running',lock});process.exit(3);}
  // Process gone but no finish recorded: the outcome is unknown; never re-dispatch silently.
  const meta=json(join(taskDir,lock.runId,'meta.json'));
  if(!meta?.finishedAt&&!flag('ack-unconfirmed')){out({status:'unconfirmed_refused',reason:'previous run ended without a recorded finish; inspect it, then pass --ack-unconfirmed',lock,meta});process.exit(4);}
  if(meta&&!meta.finishedAt){meta.status='unconfirmed';meta.finishedAt=new Date().toISOString();writeFileSync(join(taskDir,lock.runId,'meta.json'),JSON.stringify(meta,null,2));}
  rmSync(lockPath);
}

const prompt=readFileSync(0,'utf8');
if(!prompt.trim())throw new Error('prompt required on stdin');
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),dir=join(taskDir,runId);
mkdirSync(dir);
writeFileSync(join(dir,'prompt.md'),prompt);
const resume=opt('resume'),model=opt('model');
// exec-level options precede the `resume` subcommand, which does not accept -s/-C itself.
const codexArgs=['exec','--json','-s',sandbox,'-C',realCwd,'-o',join(dir,'last.md'),...(model?['-m',model]:[]),...(resume?['resume',resume]:[]),'-'];
const meta={runId,task,cwd:realCwd,sandbox,model:model??null,resume:resume??null,command:['codex',...codexArgs],pid:null,sessionId:null,status:'running',exitCode:null,startedAt:new Date().toISOString(),finishedAt:null,error:null};
const save=()=>writeFileSync(join(dir,'meta.json'),JSON.stringify(meta,null,2));

const child=spawn('codex',codexArgs,{cwd:realCwd,stdio:['pipe','pipe','pipe']});
meta.pid=child.pid;save();
writeFileSync(lockPath,JSON.stringify({runId,pid:child.pid,startedAt:meta.startedAt}));
child.stdin.end(prompt);
let buffer='',errors='';
child.stdout.on('data',chunk=>{
  appendFileSync(join(dir,'events.jsonl'),chunk);buffer+=chunk;
  let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    try{const event=JSON.parse(line);const id=event.thread_id??event.session_id??event.payload?.thread_id;if(id&&!meta.sessionId){meta.sessionId=id;save();}
      if(event.type==='error'||event.type==='turn.failed')errors+=JSON.stringify(event)+'\n';}catch{}}
});
child.stderr.on('data',chunk=>{appendFileSync(join(dir,'stderr.log'),chunk);errors+=chunk;});
const stop=signal=>{child.kill(signal);};
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
child.on('error',error=>{meta.error=error.message;});
child.on('close',(code,signal)=>{
  meta.exitCode=code;meta.finishedAt=new Date().toISOString();
  meta.status=code===0?'completed':signal?'interrupted':/usage limit|rate limit|quota|429|too many requests/i.test(errors)?'quota_exhausted':'failed';
  if(meta.status!=='completed')meta.error=(meta.error??errors.trim().split('\n').slice(-3).join('\n'))||null;
  save();rmSync(lockPath,{force:true});
  out({runId,status:meta.status,exitCode:code,sessionId:meta.sessionId,record:dir,lastMessage:existsSync(join(dir,'last.md'))?join(dir,'last.md'):null,error:meta.error});
  process.exit(code??1);
});
