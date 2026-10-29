#!/usr/bin/env node
// Adaptive model routing for Claude workers spawned by the orchestrator. Ledger only: it never calls a model.
// Usage:
//   route.mjs availability --model <sonnet|opus|fable> --observed <model id> --evidence <path>
//   route.mjs select --task <id> --class <impl|ui|test|docs|concurrency|recovery|security|architecture> --sha <sha>
//   route.mjs record --task <id> --result <pass|fail> --sha <sha> --verify <summary> [--fingerprint <f>] [--usage <json>]
//   route.mjs escalate --task <id> --reason <code_defect|environment|provider_capacity|quota_exhausted|approval_blocked> --fingerprint <f> --sha <sha> --evidence <path>
//   route.mjs show --task <id>
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.ORBIT_MODEL_LEDGER??join(repo,'.local/orchestrator/models');
const ladder=['sonnet','opus','fable'];
const heavy=new Set(['concurrency','recovery','security','architecture']),classes=new Set(['impl','ui','test','docs',...heavy]);
// Failures that a stronger model cannot fix never escalate.
const nonModel=new Set(['environment','provider_capacity','quota_exhausted','approval_blocked']);
const MAX_PER_FINGERPRINT=4,MAX_PER_MODEL=2;
const [command,...rest]=process.argv.slice(2);
const opt=name=>{const i=rest.indexOf('--'+name);return i>=0?rest[i+1]:undefined;};
const need=name=>{const v=opt(name);if(!v)stop(2,{error:'MISSING_'+name.toUpperCase()});return v;};
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
const now=()=>new Date().toISOString();
function stop(code,value){console.log(JSON.stringify(value,null,2));process.exit(code);}
mkdirSync(root,{recursive:true});
const availabilityPath=join(root,'availability.json'),availability=read(availabilityPath)??{};
const taskPath=id=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id))stop(2,{error:'INVALID_TASK'});return join(root,id+'.json');};
const available=model=>availability[model]?.verified===true;

if(command==='availability'){
  const model=need('model');if(!ladder.includes(model))stop(2,{error:'UNKNOWN_MODEL'});
  availability[model]={verified:true,observed:need('observed'),evidence:need('evidence'),checkedAt:now()};
  writeFileSync(availabilityPath,JSON.stringify(availability,null,2));stop(0,availability[model]);
}
const id=need('task'),path=taskPath(id),task=read(path);
const save=value=>{writeFileSync(path,JSON.stringify(value,null,2));return value;};
if(command==='show')stop(task?0:1,task??{error:'NOT_FOUND'});
if(command==='select'){
  // An existing task keeps its current model; re-selecting never silently changes it.
  if(task)stop(0,{task:id,model:task.model,reused:true});
  const kind=need('class');if(!classes.has(kind))stop(2,{error:'UNKNOWN_CLASS'});
  const model=heavy.has(kind)?'opus':'sonnet';if(!available(model))stop(3,{error:'MODEL_NOT_VERIFIED',model});
  stop(0,save({task:id,class:kind,model,createdAt:now(),events:[{at:now(),type:'select',model,reason:'class:'+kind,sha:need('sha')}]}));
}
if(!task)stop(1,{error:'NOT_FOUND'});
if(command==='record'){
  const result=need('result');if(!['pass','fail'].includes(result))stop(2,{error:'INVALID_RESULT'});
  let usage=null;if(opt('usage')){try{usage=JSON.parse(opt('usage'));}catch{stop(2,{error:'INVALID_USAGE'});}}
  task.events.push({at:now(),type:'result',model:task.model,result,sha:need('sha'),verify:need('verify'),fingerprint:opt('fingerprint')??null,usage});
  stop(0,save(task));
}
if(command==='escalate'){
  const reason=need('reason'),fingerprint=need('fingerprint'),sha=need('sha'),evidence=need('evidence');
  const failures=task.events.filter(e=>e.type==='result'&&e.result==='fail'&&e.fingerprint===fingerprint);
  const deny=(error,extra={})=>{task.events.push({at:now(),type:'escalation_denied',model:task.model,reason,fingerprint,sha,evidence,error});save(task);stop(3,{error,model:task.model,...extra});};
  if(nonModel.has(reason))deny('NOT_A_MODEL_PROBLEM');
  if(reason!=='code_defect')deny('UNKNOWN_REASON');
  if(!failures.some(e=>e.model===task.model))deny('NO_RECORDED_FAILURE_ON_CURRENT_MODEL');
  if(failures.length>=MAX_PER_FINGERPRINT)deny('ATTEMPT_LIMIT_REACHED',{attempts:failures.length});
  const next=ladder.slice(ladder.indexOf(task.model)+1).find(available);
  if(!next){
    // Top of the ladder: allow a bounded retry on the same model, then stop for the user.
    if(failures.filter(e=>e.model===task.model).length<MAX_PER_MODEL)stop(0,{task:id,model:task.model,escalated:false,note:'retry on current model'});
    deny('NO_HIGHER_MODEL');
  }
  task.events.push({at:now(),type:'escalate',from:task.model,model:next,reason,fingerprint,sha,evidence,failures:failures.length});
  task.model=next;stop(0,save(task));
}
stop(2,{error:'UNKNOWN_COMMAND'});
