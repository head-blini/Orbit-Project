import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import {planningDepth} from '../shared/planning-agent.ts';
import {createHash,randomUUID} from 'node:crypto';
import {parsePlanningDraft,serializePlanningDraft,normalizeStoredPlanningDraft,approvalIssues} from '../server/planning/parser.ts';
import {InMemoryPlanningRepository} from '../server/planning/repository.ts';
import {serializePlanningExport} from '../server/planning/export.ts';
import {parsePlanningProposal,parseClaudePlanningProposal,planningOutputSchema,claudePlanningOutputSchema,buildPlanningPrompt} from '../server/planning/agent-input.ts';
const document=()=>({schema_version:'1.0',title:'보고서',goal:'자료 요약',requirements:[{id:'R1',description:'요약 작성',acceptance_criteria:['핵심 수치 포함']}],constraints:['외부 전송 금지'],open_questions:[],decisions:[],non_goals:['추가 조사']});
const input=(value:unknown)=>({format:'json' as const,source:'import' as const,text:JSON.stringify(value)});
function parse(value:unknown){const result=parsePlanningDraft(input(value));assert.ok(result.ok);return result.draft;}
test('depth normalizes unknown values conservatively and preserves legacy bytes',()=>{
  const legacy=parse(document());assert.equal(Object.hasOwn(legacy,'depth'),false);
  assert.deepEqual(normalizeStoredPlanningDraft(legacy),{ok:true,draft:legacy});
  for(const depth of ['simple','detailed',null,'brief',{},42]){
    const draft=parse({...document(),depth,depth_reason:' 요청 규모 ',risks:[' 자료 누락 ']});
    assert.equal(draft.depth,depth==='simple'?'simple':'detailed');
    assert.equal(draft.depthReason,'요청 규모');assert.deepEqual(draft.risks,['자료 누락']);
    for(const format of ['json','markdown'] as const){const exported=serializePlanningExport(draft,format);assert.deepEqual(parsePlanningDraft({...input(null),format,text:exported.text}),{ok:true,draft});}
  }
});
test('depth-only revision changes hash, preserves prior approval, and rejects stale CAS',()=>{
  const repository=new InMemoryPlanningRepository();const original=repository.create('project',input(document()));
  const oldHash=createHash('sha256').update(JSON.stringify(original.draft)).digest('hex');
  repository.approve('project',original.id,1);
  const next=repository.revise('project',original.id,1,input({...JSON.parse(serializePlanningDraft(original.draft)),depth:'simple'}));
  assert.notEqual(next.contentHash,oldHash);assert.equal(next.state,'draft');assert.equal(next.revision,2);
  assert.equal(repository.list('project')[0].contentHash,oldHash);assert.equal(repository.list('project')[0].state,'approved');
  assert.throws(()=>repository.approve('project',original.id,1),/REVISION_CONFLICT/);
  assert.deepEqual(next.draft.nonGoals,['추가 조사']);
  assert.throws(()=>repository.toTasks('project',next.id),/NOT_APPROVED/);
  repository.approve('project',next.id,2);assert.deepEqual(repository.toTasks('project',next.id)[0].acceptanceCriteria,['핵심 수치 포함']);
});
test('simple still requires acceptance and all existing required fields',()=>{
  const value={...document(),depth:'simple'};value.requirements[0].acceptance_criteria=[];
  assert.ok(approvalIssues(parse(value)).some(issue=>issue.field==='requirements.0.acceptanceCriteria'));
  const {constraints:_,...missing}=value;assert.equal(parsePlanningDraft(input(missing)).ok,false);
});
test('both provider schemas and fake proposals support depth, reasons and risks',()=>{
  for(const schema of [planningOutputSchema,claudePlanningOutputSchema])assert.deepEqual(schema.properties.depth.enum,['simple','detailed']);
  const {non_goals:_,...codex}=document();
  for(const [parser,doc] of [[parsePlanningProposal,codex],[parseClaudePlanningProposal,document()]] as const){
    for(const depth of ['simple','detailed','invalid']){const draft=parser(JSON.stringify({...doc,depth,depth_reason:'요청 규모',risks:['자료 누락']}));assert.equal(draft.depth,depth==='simple'?'simple':'detailed');assert.equal(draft.depthReason,'요청 규모');}
  }
  assert.match(buildPlanningPrompt('보고서 요약').instructions,/simple/);assert.match(buildPlanningPrompt('보고서 요약').instructions,/constraints.*tasks/i);
});


test('SQLite depth revisions preserve old bytes and stale task rules through the existing Studio API',()=>{
  const store=new Store(':memory:'),studio=new Studio(store);
  try{
    store.saveProject({id:'project',kind:'general',name:'Report',path:'never-accessed',createdAt:'',writeEnabled:false});
    const first=studio.mutate('project','plans',undefined,undefined,{requestId:randomUUID(),input:input(document())}) as PlanningVersion;
    studio.mutate('project','plans',first.id,'approve',{expectedRevision:1});
    const [task]=studio.mutate('project','plans',first.id,'task-drafts',{}) as SavedTask[];
    const before=store.db.prepare('SELECT body FROM planning_versions WHERE id=?').get(first.id)!.body;
    assert.equal(planningDepth(first.draft.depth),'detailed');
    const next=studio.mutate('project','plans',first.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:input({...document(),depth:'simple'})}) as PlanningVersion;
    assert.notEqual(next.contentHash,first.contentHash);assert.equal(next.draft.depth,'simple');
    studio.mutate('project','plans',next.id,'approve',{expectedRevision:2});
    assert.equal(store.db.prepare('SELECT body FROM planning_versions WHERE id=?').get(first.id)!.body,before);
    assert.throws(()=>studio.execution('project',task.id),/STALE/);
    assert.equal(store.runs().length,0);
  }finally{store.close();}
});

test('new depth metadata keeps privacy checks and optional empty risks roundtrip',()=>{
  for(const field of ['depth_reason','risks']){
    const value={...document(),depth:'simple',[field]:field==='risks'?['api_key=fixture-secret']:'api_key=fixture-secret'};
    assert.throws(()=>serializePlanningExport(parse(value),'json'),/PLANNING_EXPORT_BLOCKED/);
  }
  const value=parse({...document(),depth:'detailed',risks:[' ']});
  assert.equal(Object.hasOwn(value,'risks'),false);assert.deepEqual(normalizeStoredPlanningDraft(value),{ok:true,draft:value});
});
