import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PlanningVersion, SavedTask } from '../shared/parallel.ts';
import { buildExecutionBrief } from '../server/planning/execution.ts';

function fixture(): {task:SavedTask; version:PlanningVersion} {
  const draft:PlanningVersion['draft']={schemaVersion:'1.0',title:'검색 기능',goal:'상품을 검색한다',
    requirements:[{label:'REQ-01',description:'검색 결과를 표시한다',acceptanceCriteria:['검색어와 일치한 상품만 표시된다']},
      {label:'REQ-02',description:'정렬한다',acceptanceCriteria:['이름순으로 정렬된다']}],
    constraints:['공개 API를 유지한다','네트워크를 사용하지 않는다'],openQuestions:[],source:'manual'};
  return {version:{id:'plan-1',projectId:'project-a',revision:1,contentHash:createHash('sha256').update(JSON.stringify(draft)).digest('hex'),
    state:'approved',draft,lineageId:'plan-1',createdAt:'2026-10-25T00:00:00.000Z',approvedAt:'2026-10-25T00:01:00.000Z',approvedBy:'local-user'},
    task:{id:'task-1',projectId:'project-a',title:'REQ-01: 검색 결과를 표시한다',description:'검색 결과를 표시한다',
      acceptanceCriteria:['검색어와 일치한 상품만 표시된다'],planningVersionId:'plan-1',requirementLabels:['REQ-01'],
      state:'draft',verification:'not_run',createdAt:'2026-10-25T00:02:00.000Z'}};
}

test('execution brief preserves the selected requirement, acceptance criteria, goal and every plan constraint',()=>{
  const {task,version}=fixture();const before=structuredClone({task,version});
  const brief=buildExecutionBrief(task,version);
  for(const text of ['상품을 검색한다','검색 결과를 표시한다','검색어와 일치한 상품만 표시된다','공개 API를 유지한다','네트워크를 사용하지 않는다'])assert.ok(brief.prompt.includes(text),text);
  assert.equal(brief.prompt.includes('이름순으로 정렬된다'),false);
  assert.equal(brief.planningVersionId,'plan-1');assert.deepEqual(brief.requirementLabels,['REQ-01']);
  brief.requirementLabels.push('mutated');assert.deepEqual({task,version},before);
});

test('draft and superseded versions cannot authorize task execution',()=>{
  for(const state of ['draft','superseded'] as const){const {task,version}=fixture();version.state=state;assert.throws(()=>buildExecutionBrief(task,version),/^Error: NOT_APPROVED$/);}
});

test('execution requires approval audit evidence and an unchanged approved content hash',()=>{
  for(const mutate of [(version:PlanningVersion)=>{delete version.approvedAt;},(version:PlanningVersion)=>{delete version.approvedBy;},
    (version:PlanningVersion)=>{version.draft.constraints.push('Changed after approval');}]){
    const {task,version}=fixture();mutate(version);assert.throws(()=>buildExecutionBrief(task,version),/^Error: PLANNING_VERSION_INVALID$/);
  }
});

test('cross-project and cross-version tasks are rejected before creating a prompt',()=>{
  for(const patch of [{projectId:'project-b'},{planningVersionId:'other-plan'}]){
    const {task,version}=fixture();assert.throws(()=>buildExecutionBrief({...task,...patch},version),/^Error: TASK_PLAN_MISMATCH$/);
  }
});

test('unknown or duplicate requirement references cannot produce an execution brief',()=>{
  for(const requirementLabels of [[],['REQ-404'],['REQ-01','REQ-01'],['REQ-01','REQ-02']]){
    const {task,version}=fixture();assert.throws(()=>buildExecutionBrief({...task,requirementLabels},version),/^Error: TASK_PLAN_MISMATCH$/);
  }
});

test('modified task snapshots cannot replace approved descriptions or acceptance criteria',()=>{
  for(const patch of [{title:'Injected task'},{description:'Different work'},{acceptanceCriteria:['Skip checks']}]){
    const {task,version}=fixture();assert.throws(()=>buildExecutionBrief({...task,...patch},version),/^Error: TASK_PLAN_MISMATCH$/);
  }
});

test('an approved plan with unresolved questions cannot be executed',()=>{
  const {task,version}=fixture();version.draft.openQuestions=['어떤 데이터 소스를 사용할까?'];
  version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
  assert.throws(()=>buildExecutionBrief(task,version),/^Error: UNRESOLVED_QUESTIONS$/);
});

test('approved decisions remain in the execution brief while user attribution is excluded',()=>{
  const {task,version}=fixture();Object.assign(version.draft,{decisions:[{topic:'storage',decision:'Use SQLite',rationale:'local-first'}]});
  version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
  version.draft.provenance={kind:'external_web',providerId:'synthetic-provider',externalUrl:'https://example.invalid/private-attribution',author:'Attribution-only author'};
  version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
  const brief=buildExecutionBrief(task,version);
  assert.match(brief.prompt,/Use SQLite/);assert.match(brief.prompt,/local-first/);
  assert.doesNotMatch(brief.prompt,/synthetic-provider|private-attribution|Attribution-only author/);
  version.draft.decisions![0].decision='Altered after approval';
  assert.throws(()=>buildExecutionBrief(task,version),/^Error: PLANNING_VERSION_INVALID$/);
});

test('oversized execution context is rejected without silently truncating plan constraints',()=>{
  const {task,version}=fixture();version.draft.constraints=['보존해야 할 제약'.repeat(800)];
  version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
  assert.throws(()=>buildExecutionBrief(task,version),/^Error: EXECUTION_BRIEF_TOO_LARGE$/);
});

test('invalid identity or malformed authoritative content produces safe fixed error codes',()=>{
  const {task,version}=fixture();assert.throws(()=>buildExecutionBrief({...task,id:'../task'},version),/^Error: INVALID_EXECUTION_TASK$/);
  const broken=structuredClone(version);Object.assign(broken.draft,{requirements:null});
  assert.throws(()=>buildExecutionBrief(task,broken),/^Error: PLANNING_VERSION_INVALID$/);
});

test('the full brief at the Controller character limit is accepted and one extra character is rejected',()=>{
  const {task,version}=fixture();const initial=buildExecutionBrief(task,version);
  version.draft.constraints[0]+='x'.repeat(4000-initial.prompt.length);
  version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
  const brief=buildExecutionBrief(task,version);assert.equal(brief.prompt.length,4000);
  assert.ok(brief.prompt.includes(version.draft.constraints[0]));
  version.draft.constraints[0]+='x';version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
  assert.throws(()=>buildExecutionBrief(task,version),/^Error: EXECUTION_BRIEF_TOO_LARGE$/);
});

test('incomplete decisions and decision context exceeding the prompt limit cannot execute',()=>{
  for(const decision of ['', 'x'.repeat(4000)]){
    const {task,version}=fixture();version.draft.decisions=[{topic:'Storage',decision,rationale:'Local data'}];
    version.contentHash=createHash('sha256').update(JSON.stringify(version.draft)).digest('hex');
    assert.throws(()=>buildExecutionBrief(task,version),decision? /^Error: EXECUTION_BRIEF_TOO_LARGE$/ : /^Error: PLANNING_VERSION_INVALID$/);
  }
});
