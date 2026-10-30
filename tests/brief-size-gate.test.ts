import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {ProjectProgressService} from '../server/project-progress.ts';
import {buildExecutionBrief,MAX_EXECUTION_PROMPT_CHARS} from '../server/planning/execution.ts';
import {BRIEF_PLACEHOLDER_IDS,briefPrompt,briefSizeIssues,planningApprovalIssues} from '../server/planning/brief.ts';
import {buildClaudePlanningPrompt,buildPlanningPrompt} from '../server/planning/agent-input.ts';
import {PlanningError} from '../server/planning/repository.ts';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=(constraint:string)=>JSON.stringify({schema_version:'1.0',title:'Market report',goal:'Summarise the market',
  requirements:[{id:'R1',description:'Collect sources',acceptance_criteria:['Three sources cited']}],constraints:[constraint],open_questions:[],
  decisions:[{topic:'Scope',decision:'Use public sources',rationale:'No access to paid data'}]});
function studio(){
  const store=new Store(':memory:'),s=new Studio(store);
  store.saveProject({id:'project-a',name:'a',path:'never-open-this-path',createdAt:'',writeEnabled:false});
  const create=(constraint:string)=>s.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:json(constraint)}}) as PlanningVersion;
  return {store,s,create};
}
/** Constraint padding that makes the placeholder-id brief exactly `target` chars. */
function padTo(target:number){
  const {store,create}=studio();try{
    const base=create('');const empty=briefPrompt(BRIEF_PLACEHOLDER_IDS,base.draft,base.draft.requirements).length;
    return 'x'.repeat(target-empty);
  }finally{store.close();}
}

test('helper parity: placeholder brief has the exact length of the real brief with UUID ids and a sha256 hash',()=>{
  const {store,s,create}=studio();try{
    const version=s.mutate('project-a','plans',create(padTo(1500)).id,'approve',{expectedRevision:1}) as PlanningVersion;
    const task=(s.mutate('project-a','plans',version.id,'task-drafts',{}) as SavedTask[])[0];
    assert.match(task.id,/^[0-9a-f-]{36}$/);
    assert.equal(buildExecutionBrief(task,version).prompt.length,briefPrompt(BRIEF_PLACEHOLDER_IDS,version.draft,version.draft.requirements).length);
    assert.equal(version.contentHash.length,BRIEF_PLACEHOLDER_IDS.contentHash.length);
  }finally{store.close();}
});

test('approval refuses a plan whose execution brief would exceed the limit and accepts one exactly at it',()=>{
  const {store,s,create}=studio();try{
    const over=create(padTo(MAX_EXECUTION_PROMPT_CHARS+1));
    assert.deepEqual(briefSizeIssues(over.draft),[{field:'requirements.0',code:'EXECUTION_BRIEF_TOO_LARGE'}]);
    assert.deepEqual(planningApprovalIssues(over.draft),[{field:'requirements.0',code:'EXECUTION_BRIEF_TOO_LARGE'}]);
    assert.throws(()=>s.mutate('project-a','plans',over.id,'approve',{expectedRevision:1}),(e:unknown)=>e instanceof PlanningError&&e.code==='INCOMPLETE_DRAFT'
      &&e.issues.some(i=>i.code==='EXECUTION_BRIEF_TOO_LARGE'));
    assert.equal((s.read('project-a','plans') as PlanningVersion[]).find(v=>v.id===over.id)!.state,'draft');
    const fit=create(padTo(MAX_EXECUTION_PROMPT_CHARS));
    assert.deepEqual(planningApprovalIssues(fit.draft),[]);
    const approved=s.mutate('project-a','plans',fit.id,'approve',{expectedRevision:1}) as PlanningVersion;
    const task=(s.mutate('project-a','plans',approved.id,'task-drafts',{}) as SavedTask[])[0];
    assert.equal(buildExecutionBrief(task,approved).prompt.length,MAX_EXECUTION_PROMPT_CHARS);
  }finally{store.close();}
});

test('progress lists a task blocker and withholds execute_task for an already approved oversized plan; GET stays read-only',()=>{
  const {store,s,create}=studio();try{
    const small=s.mutate('project-a','plans',create('short').id,'approve',{expectedRevision:1}) as PlanningVersion;
    const task=(s.mutate('project-a','plans',small.id,'task-drafts',{}) as SavedTask[])[0];
    const service=new ProjectProgressService(store,s);
    const ok=service.read('project-a',{});
    assert.deepEqual(ok.blockers,[]);assert.equal(ok.tasks[0].quality!.execution.nextAction,'execute_task');
    // Legacy state: approved before the gate existed. Rewrite the stored body directly (rehashing) to simulate it.
    const legacy:PlanningVersion={...small,draft:{...small.draft,constraints:[padTo(MAX_EXECUTION_PROMPT_CHARS+200)]}};legacy.contentHash=sha(legacy.draft);
    store.db.prepare('UPDATE planning_versions SET body=? WHERE id=?').run(JSON.stringify(legacy),small.id);
    assert.throws(()=>buildExecutionBrief(task,legacy),/EXECUTION_BRIEF_TOO_LARGE/);
    const seq=store.lastSeq(),runs=store.runs().length;
    const progress=service.read('project-a',{});service.read('project-a',{});
    assert.deepEqual(progress.blockers,[{code:'EXECUTION_BRIEF_TOO_LARGE',scope:'task',taskId:task.id}]);
    assert.equal(progress.tasks[0].quality!.execution.nextAction,null);
    assert.ok(progress.tasks[0].quality!.execution.blockers.includes('EXECUTION_BRIEF_TOO_LARGE'));
    assert.equal(progress.plan?.id,small.id);
    assert.equal(store.lastSeq(),seq);assert.equal(store.runs().length,runs);
  }finally{store.close();}
});

test('both planning prompts tell the planner the brief limit',()=>{
  for(const prompt of [buildPlanningPrompt('보고서를 쓴다'),buildClaudePlanningPrompt('보고서를 쓴다')])
    assert.match(prompt.instructions,new RegExp(`execution brief for each requirement[^.]*under ${MAX_EXECUTION_PROMPT_CHARS} characters`));
});
