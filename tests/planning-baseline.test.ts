import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {InMemoryPlanningRepository} from '../server/planning/repository.ts';
import {parsePlanningDraft,serializePlanningDraft} from '../server/planning/parser.ts';
import {serializePlanningExport} from '../server/planning/export.ts';
import type {PlanningDraft,PlanningVersion,SavedTask} from '../shared/parallel.ts';

const legacy:PlanningDraft={schemaVersion:'1.0',title:'Search',goal:'Find an item',requirements:[{label:'R1',description:'Find matches',acceptanceCriteria:['Results appear']}],constraints:[],openQuestions:[],source:'manual'};
const input=(extra:object={})=>({format:'json' as const,source:'manual' as const,text:JSON.stringify({...JSON.parse(serializePlanningDraft(legacy)),...extra})});

test('nonGoals preserves the exact legacy draft bytes and contentHash when absent or empty',()=>{
  const oldBytes=JSON.stringify(legacy),oldHash=createHash('sha256').update(oldBytes).digest('hex');
  assert.equal(oldHash,'1f5ba4bad1320531ad224edb1285b104e9b6fd492ee858e55a4afb1849e1b6cf');
  for(const extra of [{},{non_goals:[]},{non_goals:[' ','']}]){
    const version=new InMemoryPlanningRepository().create('project-a',input(extra));
    assert.equal(JSON.stringify(version.draft),oldBytes);assert.equal(version.contentHash,oldHash);
    assert.equal(Object.hasOwn(version.draft,'nonGoals'),false);
    assert.deepEqual(parsePlanningDraft({format:'json',source:'manual',text:serializePlanningDraft(version.draft)}),{ok:true,draft:legacy});
  }
  const markdown=serializePlanningExport(legacy,'markdown').text+'\n## Non-goals\n';
  assert.equal(JSON.stringify(new InMemoryPlanningRepository().create('project-a',{format:'markdown',source:'manual',text:markdown}).draft),oldBytes);
});

test('nonGoals JSON and Markdown sections roundtrip and reject malformed lists',()=>{
  const result=parsePlanningDraft(input({non_goals:[' No paid services ','']}));assert.ok(result.ok);
  assert.deepEqual(result.draft.nonGoals,['No paid services']);
  for(const format of ['json','markdown'] as const){
    const exported=serializePlanningExport(result.draft,format);
    assert.deepEqual(parsePlanningDraft({format,source:'manual',text:exported.text}),result);
  }
  for(const heading of ['Non-goals','Non goals','하지 않을 것']){
    const parsed=parsePlanningDraft({format:'markdown',source:'manual',text:serializePlanningExport(legacy,'markdown').text+`\n## ${heading}\n- No paid services\n`});
    assert.deepEqual(parsed,result);
  }
  for(const value of [null,'No paid services',[3],{}])assert.equal(parsePlanningDraft(input({non_goals:value})).ok,false);
  assert.throws(()=>serializePlanningExport({...result.draft,nonGoals:['api_key=synthetic-secret']},'json'),/PLANNING_EXPORT_BLOCKED/);
});

test('proposal_does_not_mutate_approved_baseline: revisions and explicit approval preserve history',()=>{
  const store=new Store(':memory:'),studio=new Studio(store),projectId='project-a';
  store.saveProject({id:projectId,name:'Fixture',kind:'general',path:'/unused',createdAt:'',writeEnabled:false});
  try{
    const first=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input:input()}) as PlanningVersion;
    const approved=studio.mutate(projectId,'plans',first.id,'approve',{expectedRevision:1}) as PlanningVersion;
    const [task]=studio.mutate(projectId,'plans',first.id,'task-drafts',{}) as SavedTask[];
    const other=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input:input()}) as PlanningVersion;
    studio.mutate(projectId,'plans',other.id,'approve',{expectedRevision:1});
    const next=studio.mutate(projectId,'plans',first.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:input({non_goals:['No network']})}) as PlanningVersion;
    const read=()=> (studio.read(projectId,'plans') as PlanningVersion[]).find(v=>v.id===first.id)!;
    assert.deepEqual(read(),approved);assert.equal(next.state,'draft');assert.notEqual(next.id,first.id);
    assert.throws(()=>studio.execution(projectId,task.id),/PLANNING_VERSION_STALE/);
    const final=studio.mutate(projectId,'plans',next.id,'approve',{expectedRevision:2}) as PlanningVersion;
    assert.equal(final.state,'approved');assert.equal(final.revision,2);
    // Approval history is never rewritten; the lineage head decides which approval is current.
    assert.deepEqual(read(),approved);assert.throws(()=>studio.execution(projectId,task.id),/PLANNING_VERSION_STALE/);
    assert.equal((studio.read(projectId,'plans') as PlanningVersion[]).find(v=>v.id===other.id)!.state,'approved');
    assert.deepEqual(studio.read(projectId,'tasks'),[task]);
    const comparison=studio.comparePlanning(projectId,final.id,first.id);
    assert.equal(comparison.affectedTasks[0].reasons[0],'plan_context_changed');
    assert.deepEqual(comparison.nonGoalsChange,{before:[],after:['No network']});
  }finally{store.close();}
});

test('memory repository keeps prior approval records unchanged after a new approval',()=>{
  const repo=new InMemoryPlanningRepository(),first=repo.create('project-a',input());
  const approved=repo.approve('project-a',first.id,1),next=repo.revise('project-a',first.id,1,input({goal:'New goal'}));
  assert.deepEqual(repo.list('project-a')[0],approved);
  repo.approve('project-a',next.id,2);assert.deepEqual(repo.list('project-a')[0],approved);
});

test('failed approval keeps the approved hash, plan records and event sequence',()=>{
  const store=new Store(':memory:'),studio=new Studio(store),projectId='project-a';
  store.saveProject({id:projectId,name:'Fixture',kind:'general',path:'/unused',createdAt:'',writeEnabled:false});
  try{
    const first=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input:input()}) as PlanningVersion;
    studio.mutate(projectId,'plans',first.id,'approve',{expectedRevision:1});
    const next=studio.mutate(projectId,'plans',first.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:input({goal:'New goal'})}) as PlanningVersion;
    const before=studio.read(projectId,'plans'),seq=store.lastSeq();
    store.db.exec("CREATE TRIGGER deny_approval BEFORE UPDATE ON planning_versions WHEN json_extract(NEW.body,'$.state')='approved' BEGIN SELECT RAISE(ABORT,'fixture approval failure'); END");
    assert.throws(()=>studio.mutate(projectId,'plans',next.id,'approve',{expectedRevision:2}),/fixture approval failure/);
    assert.deepEqual(studio.read(projectId,'plans'),before);assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});
