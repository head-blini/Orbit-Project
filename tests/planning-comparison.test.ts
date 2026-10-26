import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PlanningDraft, PlanningVersion, SavedTask } from '../shared/parallel.ts';
import { AppError } from '../server/errors.ts';
import { comparePlanningVersions } from '../server/planning/comparison.ts';
import { MAX_PLANNING_BYTES, parsePlanningDraft, serializePlanningDraft } from '../server/planning/parser.ts';
import { InMemoryPlanningRepository } from '../server/planning/repository.ts';

const hash=(draft:PlanningDraft)=>createHash('sha256').update(JSON.stringify(draft)).digest('hex');
function fixture():{base:PlanningVersion;target:PlanningVersion;tasks:SavedTask[]} {
  const draft:PlanningDraft={schemaVersion:'1.0',title:'Search',goal:'Find relevant items',requirements:[
    {label:'REQ-A',description:'Show matching results',acceptanceCriteria:['Exact matches first','Hide unrelated items']},
    {label:'REQ-B',description:'Sort results',acceptanceCriteria:['Sort by name']},
    {label:'REQ-C',description:'Filter results',acceptanceCriteria:['Filter by category']},
  ],constraints:['Local data only','Keep the API'],openQuestions:[],source:'manual'};
  const base:PlanningVersion={id:'plan-1',projectId:'project-a',lineageId:'plan-1',revision:1,
    contentHash:hash(draft),state:'approved',draft};
  const target:PlanningVersion={...structuredClone(base),id:'plan-2',revision:2,state:'draft'};
  const tasks:SavedTask[]=draft.requirements.map((requirement,index)=>({id:`task-${index+1}`,projectId:'project-a',
    title:`${requirement.label}: ${requirement.description}`,description:requirement.description,
    acceptanceCriteria:[...requirement.acceptanceCriteria],planningVersionId:'plan-1',requirementLabels:[requirement.label],
    state:'draft',verification:'not_run',createdAt:'2026-10-26T00:00:00.000Z'}));
  return {base,target,tasks};
}
function rejects(work:()=>unknown,code:string){
  assert.throws(work,(error:unknown)=>error instanceof AppError&&error.message===code&&error.status===409);
}

test('requirements use explicit labels and retain base order before appended additions',()=>{
  const {base,target,tasks}=fixture();
  target.draft.requirements=[
    {...target.draft.requirements[2],description:'Filter by category and availability'},
    {label:'REQ-D',description:'Show matching results',acceptanceCriteria:['Exact matches first','Hide unrelated items']},
    target.draft.requirements[1],
    {label:'REQ-E',description:'Save a search',acceptanceCriteria:['Restore the same query']},
  ];target.contentHash=hash(target.draft);
  const result=comparePlanningVersions(base,target,tasks);
  assert.deepEqual(result.requirements.map(({label,status})=>({label,status})),[
    {label:'REQ-A',status:'removed'},{label:'REQ-B',status:'unchanged'},{label:'REQ-C',status:'changed'},
    {label:'REQ-D',status:'added'},{label:'REQ-E',status:'added'},
  ]);
  assert.deepEqual(result.requirements[0],{label:'REQ-A',status:'removed',before:{label:'REQ-A',description:'Show matching results',
    acceptanceCriteria:['Exact matches first','Hide unrelated items']},after:null});
  assert.deepEqual(result.requirements[3],{label:'REQ-D',status:'added',before:null,after:{label:'REQ-D',description:'Show matching results',
    acceptanceCriteria:['Exact matches first','Hide unrelated items']}});
  assert.deepEqual(result.affectedTasks,[
    {taskId:'task-1',planningVersionId:'plan-1',requirementLabels:['REQ-A'],reasons:['requirement_removed']},
    {taskId:'task-3',planningVersionId:'plan-1',requirementLabels:['REQ-C'],reasons:['requirement_changed']},
  ]);
});

test('field changes include scalar values and order-sensitive lists in a stable field order',()=>{
  const {base,target}=fixture();
  base.draft.openQuestions=['Which format?','Which locale?'];base.contentHash=hash(base.draft);
  target.draft.title='Find';target.draft.goal='Find and save items';target.draft.constraints.reverse();
  target.draft.openQuestions=['Which locale?','Which format?'];target.draft.source='import';target.draft.requirements.reverse();
  target.contentHash=hash(target.draft);
  assert.deepEqual(comparePlanningVersions(base,target,[]).fields,[
    {field:'title',before:'Search',after:'Find'},
    {field:'goal',before:'Find relevant items',after:'Find and save items'},
    {field:'constraints',before:['Local data only','Keep the API'],after:['Keep the API','Local data only']},
    {field:'openQuestions',before:['Which format?','Which locale?'],after:['Which locale?','Which format?']},
    {field:'source',before:'manual',after:'import'},
    {field:'requirementOrder',before:['REQ-A','REQ-B','REQ-C'],after:['REQ-C','REQ-B','REQ-A']},
  ]);
});

test('requirement order changes preserve unchanged status and do not affect tasks',()=>{
  const {base,target,tasks}=fixture();target.draft.requirements.reverse();target.contentHash=hash(target.draft);
  const result=comparePlanningVersions(base,target,tasks);
  assert.deepEqual(result.fields,[{field:'requirementOrder',before:['REQ-A','REQ-B','REQ-C'],after:['REQ-C','REQ-B','REQ-A']}]);
  assert.deepEqual(result.requirements.map(({label,status})=>({label,status})),[
    {label:'REQ-A',status:'unchanged'},{label:'REQ-B',status:'unchanged'},{label:'REQ-C',status:'unchanged'},
  ]);assert.deepEqual(result.affectedTasks,[]);
});

test('acceptance criteria order is a requirement change even when description is unchanged',()=>{
  const {base,target,tasks}=fixture();target.draft.requirements[0].acceptanceCriteria.reverse();target.contentHash=hash(target.draft);
  const result=comparePlanningVersions(base,target,tasks);
  assert.deepEqual(result.fields,[]);assert.equal(result.requirements[0].status,'changed');
  assert.deepEqual(result.affectedTasks,[{taskId:'task-1',planningVersionId:'plan-1',requirementLabels:['REQ-A'],reasons:['requirement_changed']}]);
});

test('title and source changes do not affect tasks',()=>{
  const {base,target,tasks}=fixture();target.draft.title='Find';target.draft.source='import';target.contentHash=hash(target.draft);
  const result=comparePlanningVersions(base,target,tasks);
  assert.deepEqual(result.fields.map(change=>change.field),['title','source']);assert.deepEqual(result.affectedTasks,[]);
});

for(const field of ['goal','constraints','openQuestions'] as const){
  test(`${field} changes affect every base task in the same project only`,()=>{
    const {base,target,tasks}=fixture();
    if(field==='goal')target.draft.goal='Find and save items';
    else target.draft[field].push('A new planning context item');
    target.contentHash=hash(target.draft);
    tasks.push({...structuredClone(tasks[0]),id:'foreign-project',projectId:'project-b'},
      {...structuredClone(tasks[0]),id:'target-task',planningVersionId:'plan-2'},
      {...structuredClone(tasks[0]),id:'another-version',planningVersionId:'plan-other'});
    assert.deepEqual(comparePlanningVersions(base,target,tasks).affectedTasks,[
      {taskId:'task-1',planningVersionId:'plan-1',requirementLabels:['REQ-A'],reasons:['plan_context_changed']},
      {taskId:'task-2',planningVersionId:'plan-1',requirementLabels:['REQ-B'],reasons:['plan_context_changed']},
      {taskId:'task-3',planningVersionId:'plan-1',requirementLabels:['REQ-C'],reasons:['plan_context_changed']},
    ]);
  });
}

test('task impacts preserve task and label order and list each applicable reason once',()=>{
  const {base,target,tasks}=fixture();target.draft.requirements.shift();
  target.draft.requirements[0].description='Sort by newest';target.draft.requirements[1].acceptanceCriteria.push('Filter by availability');
  target.draft.constraints.push('No network');target.contentHash=hash(target.draft);
  const combined={...tasks[0],id:'combined',requirementLabels:['REQ-C','REQ-A','REQ-B']};
  assert.deepEqual(comparePlanningVersions(base,target,[tasks[2],combined,tasks[1]]).affectedTasks,[
    {taskId:'task-3',planningVersionId:'plan-1',requirementLabels:['REQ-C'],reasons:['requirement_changed','plan_context_changed']},
    {taskId:'combined',planningVersionId:'plan-1',requirementLabels:['REQ-C','REQ-A','REQ-B'],
      reasons:['requirement_changed','requirement_removed','plan_context_changed']},
    {taskId:'task-2',planningVersionId:'plan-1',requirementLabels:['REQ-B'],reasons:['requirement_changed','plan_context_changed']},
  ]);
});

test('requirement changes do not affect identical labels from other projects or versions',()=>{
  const {base,target,tasks}=fixture();target.draft.requirements[0].description='Search titles';target.contentHash=hash(target.draft);
  assert.deepEqual(comparePlanningVersions(base,target,[
    {...tasks[0],id:'foreign-project',projectId:'project-b'},
    {...tasks[0],id:'target-task',planningVersionId:'plan-2'},
    {...tasks[0],id:'another-version',planningVersionId:'plan-other'},tasks[1],tasks[0],
  ]).affectedTasks,[{taskId:'task-1',planningVersionId:'plan-1',requirementLabels:['REQ-A'],reasons:['requirement_changed']}]);
});

test('identical content in distinct revisions yields no field or task changes',()=>{
  const {base,target,tasks}=fixture();const result=comparePlanningVersions(base,target,tasks);
  assert.equal(result.projectId,'project-a');
  assert.deepEqual(result.base,{id:base.id,revision:1,contentHash:base.contentHash,state:'approved'});
  assert.deepEqual(result.target,{id:target.id,revision:2,contentHash:target.contentHash,state:'draft'});
  assert.deepEqual(result.fields,[]);assert.deepEqual(result.affectedTasks,[]);
  assert.deepEqual(result.requirements.map(item=>item.status),['unchanged','unchanged','unchanged']);
});

test('structurally valid incomplete or superseded drafts remain comparable without approval evidence',()=>{
  const {base,target}=fixture();base.state='superseded';
  base.draft={schemaVersion:'1.0',title:'',goal:'',requirements:[],constraints:[],openQuestions:['Pending'],source:'manual'};
  base.contentHash=hash(base.draft);target.draft=structuredClone(base.draft);target.contentHash=hash(target.draft);
  const result=comparePlanningVersions(base,target,[]);assert.deepEqual(result.fields,[]);assert.deepEqual(result.requirements,[]);
});

test('different project, missing lineage, different lineage, repeated ID or non-older base is rejected',()=>{
  for(const patch of [{projectId:'project-b'},{lineageId:undefined},{lineageId:''},{lineageId:'another-lineage'},
    {id:'plan-1'},{revision:1}]){
    const {base,target}=fixture();rejects(()=>comparePlanningVersions(base,{...target,...patch},[]),'PLANNING_COMPARISON_SCOPE_INVALID');
  }
  const {base,target}=fixture();rejects(()=>comparePlanningVersions(target,base,[]),'PLANNING_COMPARISON_SCOPE_INVALID');
  delete base.lineageId;delete target.lineageId;
  rejects(()=>comparePlanningVersions(base,target,[]),'PLANNING_COMPARISON_SCOPE_INVALID');
});

test('invalid version identity, state and revision use a fixed error without exposing content',()=>{
  for(const patch of [{id:'../private-value'},{projectId:''},{revision:0},{revision:1.5},{revision:NaN},{revision:Number.MAX_SAFE_INTEGER+1},{state:'invalid'}]){
    const {base,target}=fixture();
    rejects(()=>comparePlanningVersions({...base,...patch} as PlanningVersion,target,[]),'PLANNING_VERSION_INVALID');
    rejects(()=>comparePlanningVersions(base,{...target,...patch} as PlanningVersion,[]),'PLANNING_VERSION_INVALID');
  }
});

test('both versions must match their persisted draft hash',()=>{
  for(const side of ['base','target'] as const){
    const pair=fixture();pair[side].draft.goal='Unsaved content';
    rejects(()=>comparePlanningVersions(pair.base,pair.target,[]),'PLANNING_VERSION_INVALID');
    pair[side].contentHash='not-a-valid-hash';
    rejects(()=>comparePlanningVersions(pair.base,pair.target,[]),'PLANNING_VERSION_INVALID');
  }
});

test('malformed and noncanonical drafts fail structural validation even with a matching hash',()=>{
  const changes:Record<string,unknown>[]=[{requirements:null},{schemaVersion:'2.0'},{source:'other'},
    {constraints:[123]},{title:' Search '},{decisions:[{topic:'Storage',decision:'External service'}]},
    {unknownField:'private-value'},
    {requirements:[{label:'REQ-A',description:'First',acceptanceCriteria:[]},{label:'REQ-A',description:'Second',acceptanceCriteria:[]}]},
    {requirements:[{label:'REQ-A',description:'First',acceptanceCriteria:[],unknownField:'private-value'}]},
  ];
  for(const side of ['base','target'] as const)for(const change of changes){
    const pair=fixture();Object.assign(pair[side].draft,change);pair[side].contentHash=hash(pair[side].draft);
    rejects(()=>comparePlanningVersions(pair.base,pair.target,[]),'PLANNING_VERSION_INVALID');
  }
});

test('comparison is deterministic, does not mutate inputs and returns detached nested output',()=>{
  const {base,target,tasks}=fixture();target.draft.constraints.push('No network');target.draft.requirements[0].acceptanceCriteria.push('Show loading');
  target.contentHash=hash(target.draft);const before=structuredClone({base,target,tasks});
  const result=comparePlanningVersions(base,target,tasks);assert.deepEqual(comparePlanningVersions(base,target,tasks),result);
  assert.deepEqual({base,target,tasks},before);
  result.base.id='mutated';result.target.state='approved';
  (result.fields[0].before as string[]).push('mutated');(result.fields[0].after as string[]).push('mutated');
  result.requirements[0].before!.acceptanceCriteria.push('mutated');result.requirements[0].after!.description='mutated';
  result.affectedTasks[0].requirementLabels.push('mutated');result.affectedTasks[0].reasons.push('requirement_removed');
  assert.deepEqual({base,target,tasks},before);
});

test('saved compact JSON near the input cap remains comparable when formatting exceeds the cap',()=>{
  const repository=new InMemoryPlanningRepository();
  const document={schema_version:'1.0',title:'Large plan',goal:'',requirements:[
    {id:'REQ-A',description:'Preserve all details',acceptance_criteria:['Every detail is retained']},
  ],constraints:[],open_questions:[]};
  document.goal='x'.repeat(MAX_PLANNING_BYTES-1-Buffer.byteLength(JSON.stringify(document)));
  const text=JSON.stringify(document);assert.equal(Buffer.byteLength(text),MAX_PLANNING_BYTES-1);
  const base=repository.create('project-a',{format:'json',text,source:'manual'});
  const target=repository.revise('project-a',base.id,base.revision,{format:'json',text,source:'manual'});
  base.lineageId=base.id;target.lineageId=base.id;
  assert.ok(Buffer.byteLength(serializePlanningDraft(base.draft))>MAX_PLANNING_BYTES);
  const result=comparePlanningVersions(base,target,[]);
  assert.deepEqual(result.fields,[]);assert.deepEqual(result.requirements.map(item=>item.status),['unchanged']);
  assert.equal(result.base.contentHash,base.contentHash);assert.equal(result.target.contentHash,target.contentHash);
});

test('saved Markdown remains comparable when JSON escaping expands beyond the external input cap',()=>{
  const repository=new InMemoryPlanningRepository();
  const prefix='# Large plan\n## Goal\n';
  const suffix='\n## Requirements\n### REQ-A\nPreserve all details\n#### Acceptance criteria\n- Every detail is retained\n';
  const goal='\\'.repeat(MAX_PLANNING_BYTES-1-Buffer.byteLength(prefix+suffix));
  const text=prefix+goal+suffix;assert.equal(Buffer.byteLength(text),MAX_PLANNING_BYTES-1);
  const base=repository.create('project-a',{format:'markdown',text,source:'manual'});
  const changedText=prefix+goal.slice(0,-1)+'x'+suffix;
  const target=repository.revise('project-a',base.id,base.revision,{format:'markdown',text:changedText,source:'manual'});
  base.lineageId=base.id;target.lineageId=base.id;
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(serializePlanningDraft(base.draft))))>MAX_PLANNING_BYTES);
  const result=comparePlanningVersions(base,target,[]);
  assert.deepEqual(result.fields,[{field:'goal',before:goal,after:goal.slice(0,-1)+'x'}]);
  assert.deepEqual(result.requirements.map(item=>item.status),['unchanged']);
  assert.deepEqual(parsePlanningDraft({format:'markdown',text:text+'xx',source:'manual'}),
    {ok:false,issues:[{field:'text',code:'INPUT_TOO_LARGE'}]});
});

test('decisions change global task context while source attribution changes only the displayed metadata',()=>{
  const {base,target,tasks}=fixture();
  target.draft.provenance={kind:'external_web',providerId:'manual-reference',externalUrl:'https://example.invalid/reference',author:'Fixture Author'};
  target.contentHash=hash(target.draft);
  const attribution=comparePlanningVersions(base,target,tasks);
  assert.deepEqual(attribution.fields.map(item=>item.field),['provenance']);assert.equal(attribution.affectedTasks.length,0);
  assert.match(String(attribution.fields[0].after),/Fixture Author/);
  target.draft.decisions=[{topic:'Storage',decision:'Use SQLite',rationale:'Offline support'}];target.contentHash=hash(target.draft);
  const changed=comparePlanningVersions(base,target,tasks);
  assert.deepEqual(changed.fields.map(item=>item.field),['decisions','provenance']);
  assert.equal(changed.affectedTasks.length,3);assert.ok(changed.affectedTasks.every(task=>task.reasons.length===1&&task.reasons[0]==='plan_context_changed'));
  assert.match(String(changed.fields[0].after),/Offline support/);
  const before=structuredClone({base,target,tasks});changed.fields[0].after='tampered';assert.deepEqual({base,target,tasks},before);
  target.draft.provenance.author='Tampered';assert.throws(()=>comparePlanningVersions(base,target,tasks),/PLANNING_VERSION_INVALID/);
});
