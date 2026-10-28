import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addMaterials,listMaterials} from '../server/materials.ts';
import {evidenceCheck,listDeliverables} from '../server/deliverables.ts';
import {buildClaudePlanningPrompt,parseClaudePlanningProposal} from '../server/planning/agent-input.ts';
import {claudeTaskPrompt} from '../server/runtimes/claude-task.ts';
import {materialIssue,planningRequestText,projectNameFrom} from '../web/new-task-model.ts';

// F01/F02/F08 · A01, A13, A16: first general (non-code) flow — "compare attached materials into a table and summary".
const a='item,unit_price,delivery_days\nLaptop,1200000,7\nMonitor,350000,5\n',b='item,unit_price,delivery_days\nLaptop,1150000,10\nMonitor,380000,4\n';
const folder=()=>mkdtempSync(join(tmpdir(),'orbit-first-flow-'));

test('materials are stored once under inputs/, same content is idempotent and different content conflicts',()=>{
  const root=folder();
  const items=addMaterials(root,{files:[{name:'vendor-a.csv',text:a},{name:'vendor-b.csv',text:b}]});
  assert.deepEqual(items.map(item=>item.path),['inputs/vendor-a.csv','inputs/vendor-b.csv']);
  assert.equal(readFileSync(join(root,'inputs','vendor-a.csv'),'utf8'),a);
  assert.deepEqual(addMaterials(root,{files:[{name:'vendor-a.csv',text:a}]}),items);
  assert.throws(()=>addMaterials(root,{files:[{name:'vendor-a.csv',text:b}]}),/MATERIAL_EXISTS/);
  assert.equal(readFileSync(join(root,'inputs','vendor-a.csv'),'utf8'),a);
});

test('materials reject paths, unsupported types, credentials and personal data before writing',()=>{
  const root=folder();
  for(const name of ['../x.csv','a/b.csv','.env','run.sh','x.pdf'])assert.throws(()=>addMaterials(root,{files:[{name,text:'a,b'}]}),/INVALID_MATERIAL/);
  assert.throws(()=>addMaterials(root,{files:[{name:'k.txt',text:'key sk-abcdefghijklmnopqrstuvwxyz0123456789'}]}),/CREDENTIAL_LIKE_INPUT/);
  assert.throws(()=>addMaterials(root,{files:[{name:'p.txt',text:'연락처 010-1234-5678'}]}),/PERSONAL_DATA_BLOCKED/);
  assert.throws(()=>addMaterials(root,{files:[],extra:1}),/INVALID_FIELDS/);
  assert.deepEqual(listMaterials(root),[]);
});

test('a symlinked inputs folder is refused',()=>{
  const root=folder(),elsewhere=folder();symlinkSync(elsewhere,join(root,'inputs'));
  assert.throws(()=>listMaterials(root),/MATERIALS_UNAVAILABLE/);
});

test('deliverables separate inputs from outputs and compare table numbers with the inputs',()=>{
  const root=folder();addMaterials(root,{files:[{name:'vendor-a.csv',text:a},{name:'vendor-b.csv',text:b}]});
  writeFileSync(join(root,'task-11111111.md'),'# 비교\n\n| 품목 | A | B |\n|---|---|---|\n| Laptop | 1,200,000 | 1,150,000 |\n| Monitor | 350,000 | 380,000 |\n\n요약 문장 2026.\n');
  writeFileSync(join(root,'task-22222222.md'),'| 품목 | A | B |\n|---|---|---|\n| Laptop | 1,250,000 | 1,150,000 |\n');
  const list=listDeliverables(root,[]);
  const input=list.items.find(item=>item.path==='inputs/vendor-a.csv')!,good=list.items.find(item=>item.path==='task-11111111.md')!,bad=list.items.find(item=>item.path==='task-22222222.md')!;
  assert.equal(input.role,'input');assert.equal(input.checks.evidence,undefined);
  assert.equal(good.role,'output');assert.deepEqual(good.checks.evidence,{status:'passed',numbers:4,matched:4,unmatched:[]});
  assert.equal(good.checks.meaning,'unverified');
  assert.deepEqual(bad.checks.evidence,{status:'needs_review',numbers:2,matched:1,unmatched:['1250000']});
  assert.ok(!JSON.stringify(list).includes('buffer'));
});

test('evidence is unverified without inputs or without table numbers',()=>{
  assert.equal(evidenceCheck('text/markdown','| a | 1 |',[]).status,'unverified');
  assert.equal(evidenceCheck('text/markdown','숫자 1200000 은 표 밖에 있다',[a]).status,'unverified');
  assert.equal(evidenceCheck('text/plain','| a | 1 |',[a]).status,'unverified');
  // CSV fields separated by commas are separate numbers; 1,200,000 is one number.
  assert.equal(evidenceCheck('text/markdown','| Laptop | 7 | 1,200,000 |',['Laptop,1200000,7']).status,'passed');
});

test('Claude planning may read only the listed materials, and the list changes the input digest',()=>{
  const plain=buildClaudePlanningPrompt('비교해 줘'),withFiles=buildClaudePlanningPrompt('비교해 줘',['inputs/vendor-a.csv']);
  assert.ok(!plain.instructions.includes('Exception'));
  assert.match(withFiles.instructions,/may use Read only on these user-attached material files.*"inputs\/vendor-a.csv"/);
  assert.notEqual(plain.inputDigest,withFiles.inputDigest);
});

test('a planning answer wrapped in one json code fence parses; other prose still fails',()=>{
  const body=JSON.stringify({schema_version:'1.0',title:'비교 보고서',goal:'두 자료를 비교한다',requirements:[{id:'R1',description:'비교표',acceptance_criteria:['표가 있다']}],constraints:[],open_questions:[],decisions:[],non_goals:[]});
  assert.equal(parseClaudePlanningProposal('```json\n'+body+'\n```').title,'비교 보고서');
  assert.throws(()=>parseClaudePlanningProposal('설명입니다\n```json\n'+body+'\n```'),/PLANNING_PROPOSAL_INVALID/);
});

test('the Claude task brief lists materials only when they exist',()=>{
  const base={title:'R1',goal:'g',baseline:{planningVersionId:'p',revision:1,contentHash:'a'.repeat(64)},acceptanceCriteria:[],constraints:[],nonGoals:[],decisions:[],deliverable:'task-1.md'};
  assert.ok(!claudeTaskPrompt(base).includes('사용자 자료'));
  assert.match(claudeTaskPrompt({...base,materials:['inputs/vendor-a.csv']}),/사용자 자료\(읽기 전용, 수정 금지\):\n- inputs\/vendor-a.csv\n.*지어내지 마세요/);
});

test('home helpers: honest file limits, safe project names and a visible material list',()=>{
  assert.equal(materialIssue([{name:'a.csv',size:10}]),'');
  assert.match(materialIssue([{name:'a.xlsx',size:10}]),/텍스트 자료/);
  assert.match(materialIssue([{name:'a.csv',size:200*1024}]),/128 KB/);
  assert.equal(projectNameFrom('첨부한 자료를 비교해서 / 표와 <요약> 보고서를 만들어 줘.'),'첨부한 자료를 비교해서 표와 요약 보고서를 만들어 줘.');
  assert.equal(projectNameFrom('x'.repeat(60)).length,40);
  assert.equal(projectNameFrom('  '),'새 작업');
  assert.equal(planningRequestText(' 비교 ',[{path:'inputs/a.csv'}]),'비교\n\n첨부 자료(프로젝트 폴더에 저장됨, 읽기 전용):\n- inputs/a.csv');
});

test('answering open questions records user decisions and keeps unanswered questions open',async()=>{
  const {answerOpenQuestions}=await import('../web/plan-answers.ts');
  const draft={schemaVersion:'1.0' as const,title:'t',goal:'g',requirements:[],constraints:[],openQuestions:['통화는?','수량은?'],source:'import' as const,decisions:[{topic:'a',decision:'b',rationale:'c'}]};
  const next=answerOpenQuestions(draft,{0:' KRW '});
  assert.deepEqual(next.openQuestions,['수량은?']);
  assert.deepEqual(next.decisions,[{topic:'a',decision:'b',rationale:'c'},{topic:'통화는?',decision:'KRW',rationale:'사용자가 기획 검토 중 직접 답변함'}]);
  assert.deepEqual(draft.openQuestions,['통화는?','수량은?']);
});
