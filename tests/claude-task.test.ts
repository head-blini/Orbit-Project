import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeTaskPrompt,executionForClaudeOutcome,quotaFromClaudeWindows} from '../server/runtimes/claude-task.ts';
import type {ClaudeOutcome} from '../server/runtimes/claude-code.ts';

const outcome=(status:ClaudeOutcome['status'],extra:Partial<ClaudeOutcome>={}):ClaudeOutcome=>({status,sessionId:null,exit:'observed',exitCode:0,signal:null,forced:false,ignoredLines:0,response:'',...extra});

test('outcomes map to Orbit executions without ever inventing completion',()=>{
  assert.deepEqual(executionForClaudeOutcome(outcome('completed')),{execution:'completed',reason:null});
  assert.deepEqual(executionForClaudeOutcome(outcome('interrupted')),{execution:'interrupted',reason:null});
  assert.deepEqual(executionForClaudeOutcome(outcome('unknown')),{execution:'lost',reason:'RESULT_NOT_OBSERVED'});
  assert.deepEqual(executionForClaudeOutcome(outcome('auth_required')),{execution:'failed',reason:'LOGIN_REQUIRED'});
  assert.deepEqual(executionForClaudeOutcome(outcome('quota_exhausted')),{execution:'failed',reason:'QUOTA_EXHAUSTED'});
  assert.deepEqual(executionForClaudeOutcome(outcome('spawn_failed',{exit:'not_observed'})),{execution:'failed',reason:'RUNTIME_NOT_STARTED'});
  assert.deepEqual(executionForClaudeOutcome(outcome('error')),{execution:'failed',reason:'RUNTIME_ERROR'});
  // A completed status without an observed exit cannot be trusted as final.
  assert.deepEqual(executionForClaudeOutcome(outcome('completed',{exit:'not_observed'})),{execution:'lost',reason:'EXIT_NOT_OBSERVED'});
});

test('the task prompt carries the approved baseline, decisions and non-goals, and states that AI completion is not verification',()=>{
  const prompt=claudeTaskPrompt({title:'공개 자료 수집',goal:'여행 결제 서비스 3곳 비교',baseline:{planningVersionId:'v1',revision:2,contentHash:'ab'.repeat(32)},
    acceptanceCriteria:['출처 3개 이상','자료 날짜 기록'],constraints:['유료 API 사용 금지'],nonGoals:['가격 협상'],decisions:[{decision:'국내 서비스만',rationale:'초기 범위'}],deliverable:'sources.md'});
  for(const part of ['공개 자료 수집','여행 결제 서비스 3곳 비교','r2','abababababab','출처 3개 이상','자료 날짜 기록','유료 API 사용 금지','가격 협상','국내 서비스만','초기 범위','sources.md'])assert.ok(prompt.includes(part),part);
  assert.match(prompt,/검증은 Orbit/);assert.match(prompt,/승인 기준을 바꾸지/);
});

test('prompt inputs cannot smuggle credentials or unbounded text',()=>{
  const prompt=claudeTaskPrompt({title:'t',goal:'key sk-abcdefghijklmnop0123',baseline:{planningVersionId:'v',revision:1,contentHash:'c'.repeat(64)},acceptanceCriteria:['x'.repeat(5000)],constraints:[],nonGoals:[],decisions:[],deliverable:'out.md'});
  assert.doesNotMatch(prompt,/sk-abcdefghijklmnop0123/);assert.ok(prompt.length<4000);
  assert.throws(()=>claudeTaskPrompt({title:'t',goal:'g',baseline:{planningVersionId:'v',revision:1,contentHash:'c'.repeat(64)},acceptanceCriteria:[],constraints:[],nonGoals:[],decisions:[],deliverable:'../escape.md'}),/INVALID_DELIVERABLE/);
  assert.throws(()=>claudeTaskPrompt({title:'t',goal:'g',baseline:{planningVersionId:'v',revision:1,contentHash:'c'.repeat(64)},acceptanceCriteria:[],constraints:[],nonGoals:[],decisions:[],deliverable:'/abs/out.md'}),/INVALID_DELIVERABLE/);
});

test('Claude quota windows become a progress signal only when observed',()=>{
  assert.equal(quotaFromClaudeWindows(null),'unknown');
  assert.equal(quotaFromClaudeWindows({status:'unknown',windows:[]}),'unknown');
  assert.equal(quotaFromClaudeWindows({status:'allowed',windows:[{id:'five_hour',utilization:0.1,resetsAt:null,status:'allowed'}]}),'available');
  assert.equal(quotaFromClaudeWindows({status:'allowed_warning',windows:[{id:'five_hour',utilization:0.95,resetsAt:null,status:'allowed_warning'}]}),'available');
  assert.equal(quotaFromClaudeWindows({status:'rejected',windows:[]}),'exhausted');
  assert.equal(quotaFromClaudeWindows({status:'allowed',windows:[{id:'seven_day',utilization:1,resetsAt:null,status:'rejected'}]}),'exhausted');
});
