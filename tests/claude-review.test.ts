import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeReviewPrompt,parseClaudeReview} from '../server/runtimes/claude-review.ts';
import type {HandoffPackage} from '../shared/handoff.ts';

const handoff:HandoffPackage={projectId:'p',taskId:'t',sourceRunId:'r1',baseline:{planningVersionId:'v1',revision:2,contentHash:'ab'.repeat(32),current:true},
  goal:'여행 결제 서비스 비교',constraints:['유료 API 금지'],nonGoals:['가격 협상'],decisions:[{decision:'Markdown 사용',rationale:'로컬에서 읽기 쉬움'}],
  requirements:[{label:'R1',acceptanceCriteria:['출처 3개 이상','자료 날짜 기록']}],artifacts:[],verification:{execution:'completed',checks:[]},openQuestions:['환율 기준일'],
  nextAction:'검토',allowedTools:[],markdown:'unused'};

test('the review prompt hands over baseline, decisions, non-goals, criteria and targets, and forbids changes',()=>{
  const prompt=claudeReviewPrompt({handoff,producer:'codex',targets:['task-2d5a1ea8.md','sub/notes.txt']});
  for(const part of ['여행 결제 서비스 비교','r2','abababababab','Markdown 사용','로컬에서 읽기 쉬움','가격 협상','유료 API 금지','출처 3개 이상','자료 날짜 기록','환율 기준일','task-2d5a1ea8.md','sub/notes.txt','Codex'])assert.ok(prompt.includes(part),part);
  assert.match(prompt,/파일을 수정하지/);assert.match(prompt,/JSON/);assert.match(prompt,/검증 통과가 아니/);
  assert.throws(()=>claudeReviewPrompt({handoff,producer:'codex',targets:['../secret']}),/INVALID_REVIEW_TARGET/);
  assert.throws(()=>claudeReviewPrompt({handoff,producer:'codex',targets:[]}),/INVALID_REVIEW_TARGET/);
});

test('a well-formed review is parsed into per-criterion opinions and findings, labelled as AI opinion',()=>{
  const review=parseClaudeReview(JSON.stringify({verdict:'changes_requested',baseline_respected:true,
    criteria:[{criterion:'출처 3개 이상',status:'not_met',evidence:'출처 후보만 있고 확인되지 않음'},{criterion:'자료 날짜 기록',status:'met',evidence:'작성일 표기'}],
    findings:[{severity:'high',summary:'출처 미확인',path:'task-2d5a1ea8.md'}]}),handoff);
  assert.equal(review.kind,'ai_review_opinion');assert.equal(review.verdict,'changes_requested');assert.equal(review.baselineRespected,true);
  assert.deepEqual(review.criteria.map(c=>[c.criterion,c.status]),[['출처 3개 이상','not_met'],['자료 날짜 기록','met']]);
  assert.equal(review.findings[0].severity,'high');
});

test('unknown criteria, invented verdicts, credentials and non-JSON output are never accepted as a review',()=>{
  const ok={verdict:'approve',baseline_respected:null,criteria:[{criterion:'출처 3개 이상',status:'met',evidence:'x'},{criterion:'자료 날짜 기록',status:'unclear',evidence:'y'}],findings:[]};
  assert.equal(parseClaudeReview(JSON.stringify(ok),handoff).verdict,'approve');
  for(const bad of ['not json','```json\n{}\n```',JSON.stringify({...ok,verdict:'verified'}),JSON.stringify({...ok,criteria:[{criterion:'만들어낸 조건',status:'met',evidence:'x'}]}),
    JSON.stringify({...ok,criteria:[ok.criteria[0]]}),JSON.stringify({...ok,findings:[{severity:'high',summary:'key sk-abcdefghijklmnopqrstuv',path:null}]}),JSON.stringify({...ok,findings:[{severity:'high',summary:'x',path:'/etc/passwd'}]})])
    assert.throws(()=>parseClaudeReview(bad,handoff),/REVIEW_OUTPUT_INVALID|REVIEW_OUTPUT_BLOCKED/,bad.slice(0,40));
  // An approve verdict with an unmet criterion is inconsistent and rejected rather than trusted.
  assert.throws(()=>parseClaudeReview(JSON.stringify({...ok,criteria:[{...ok.criteria[0],status:'not_met'},ok.criteria[1]]}),handoff),/REVIEW_OUTPUT_INVALID/);
});
