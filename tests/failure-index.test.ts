import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Store} from '../server/store.ts';
import {FailureIndex} from '../server/failure-index.ts';
import {familyId} from '../server/failure-fingerprint.ts';

const SECRETS=['sk-ant-api03-PLANTEDSECRETvalue000000000000','ghp_PLANTEDGITHUBTOKEN000000000000000000','planted prompt text','planted response text',
  'planted check output','planted quality evidence','planted review body','/Users/someone/private/file.ts','planted integration reason'];
const at='2026-10-29T01:02:03.000Z',hash='a'.repeat(64),P='project-1';

function seed(){
  const store=new Store(':memory:'),db=store.db;
  db.exec(`CREATE TABLE verification_checks(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
    CREATE TABLE quality_loops(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE integration_queue(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,slot INTEGER UNIQUE CHECK(slot=1),body TEXT NOT NULL);
    CREATE TABLE worker_reservations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,dispatch_request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
    CREATE TABLE worker_integration_refusals(reservation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,reason TEXT NOT NULL);
    CREATE TABLE capability_executions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,body TEXT NOT NULL);`);
  const run=(id:string,runtime:string,extra:object={})=>{
    const body={id,requestId:'req-'+id,runtime,projectId:P,taskId:'task-1',planningContentHash:hash,prompt:SECRETS[0]+' '+SECRETS[2],response:SECRETS[1]+' '+SECRETS[3],execution:'failed',...extra};
    db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(id,'req-'+id,'d',JSON.stringify(body));return body;
  };
  const event=(kind:string,runId:string,data:object)=>db.prepare('INSERT INTO events(kind,at,run_id,data) VALUES(?,?,?,?)').run(kind,at,runId,JSON.stringify(data));
  // Codex run events embed the full Run, including prompt/response; the index may read only $.reason.
  const codex=run('run-codex','codex');event('run.runtime_source','run-codex',{source:'native',interface:'codex.app_server'});
  event('run.failed','run-codex',{run:codex});
  run('run-claude','claude-code');event('run.runtime_source','run-claude',{source:'mock',interface:'claude.print'});
  event('run.lost','run-claude',{reason:'LOGIN_REQUIRED',note:SECRETS[2]});
  run('run-other','claude-code',{projectId:'project-2'});event('run.failed','run-other',{reason:'QUOTA_EXHAUSTED'});
  db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run('check-1','creq-1',JSON.stringify({id:'check-1',requestId:'creq-1',runId:'run-codex',projectId:P,taskId:'task-1',
    commandId:'unit',execution:'completed',verdict:'failed',exitCode:1,output:SECRETS.join('\n'),evidenceSource:'local',createdAt:at,completedAt:at,planningContentHash:hash}));
  db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run('check-ok','creq-2',JSON.stringify({id:'check-ok',projectId:P,execution:'completed',verdict:'passed',output:SECRETS[4]}));
  const loop=(id:string,runId:string,issue:string,evidenceSource='native')=>db.prepare('INSERT INTO quality_loops VALUES(?,?,?,?,?)').run(id,'qreq-'+id,'d',P,JSON.stringify({
    id,projectId:P,taskId:'task-1',sourceRunId:runId,updatedAt:at,version:{contentHash:hash},producer:{evidenceSource},
    result:{status:'failed',issue,rounds:[{failures:[{reviewerId:'r',criterion:SECRETS[6],evidence:SECRETS[5],status:'not_met'}]}],artifact:{body:SECRETS[6]}},
    steps:[{state:'failed',issue,result:{evidence:SECRETS[5]}}],task:{title:SECRETS[2]}}));
  run('run-q1','codex');run('run-q2','claude-code');run('run-q3','claude-code');
  loop('loop-1','run-q1','QUALITY_EVIDENCE_INVALID');loop('loop-2','run-q2','QUALITY_EVIDENCE_INVALID');loop('loop-3','run-q3','QUALITY_EVIDENCE_INVALID','mock');
  loop('loop-4','run-q3','some free text '+SECRETS[0]);
  const reservation=(id:string,state:string)=>db.prepare('INSERT INTO worker_reservations VALUES(?,?,?,?,?,?)').run(id,'wreq-'+id,'d','att-'+id,'disp-'+id,JSON.stringify({
    reservationId:id,state,batch:{projectId:P,planningHash:hash},attempt:{taskId:'task-1',runtimeId:'codex'},claims:[{kind:'repository_file',path:{path:SECRETS[7]}}],updatedAt:at}));
  reservation('res-1','lost_unknown');reservation('res-2','released');
  db.prepare('INSERT INTO worker_integration_refusals VALUES(?,?,?)').run('res-2',P,'INTEGRATION_BASELINE_CHANGED');
  db.prepare('INSERT INTO integration_queue VALUES(?,?,?,NULL,?)').run('iq-1','ireq-1','d',JSON.stringify({id:'iq-1',projectId:P,status:'refused',reason:'INTEGRATION_VERIFICATION_FAILED',
    fence:{reservationId:'res-1'},approvedBaseline:hash,candidatePath:SECRETS[7],space:{path:SECRETS[7]}}));
  db.prepare('INSERT INTO integration_queue VALUES(?,?,?,NULL,?)').run('iq-2','ireq-2','d',JSON.stringify({id:'iq-2',projectId:P,status:'blocked',reason:SECRETS[8]+' '+SECRETS[0],fence:{reservationId:'res-2'}}));
  db.prepare('INSERT INTO capability_executions VALUES(?,?,?,?,?)').run('cap-1',P,'capreq-1','d',JSON.stringify({id:'cap-1',projectId:P,taskId:'task-1',runId:'run-codex',
    dispatchRequestId:'req-run-codex',runtimeId:'codex',issue:'EXECUTION_UNCONFIRMED',providerEvidence:{source:'native',responseDigest:'b'.repeat(64)},updatedAt:at,
    baseline:{planningContentHash:hash},quality:{task:{title:SECRETS[2]}}}));
  return store;
}

test('lists allow-listed failures from all six sources without leaking text, and never writes',()=>{
  const store=seed(),index=new FailureIndex(store);
  const before=store.db.prepare('SELECT total_changes() AS n').get()!.n,seq=store.lastSeq();
  const list=index.list(P),families=index.families(P),hypotheses=index.hypotheses(P);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
  assert.equal(store.lastSeq(),seq);
  assert.deepEqual([...new Set(list.map(r=>r.source))].sort(),['capability','check','integration','quality','run','worker']);
  const json=JSON.stringify({list,families,hypotheses});
  for(const secret of SECRETS)assert.ok(!json.includes(secret),'leaked '+secret);
  for(const word of ['prompt','response','"output"','planted','/Users'])assert.ok(!json.includes(word),'leaked '+word);
  const by=(id:string)=>list.find(r=>r.id===id)!;
  const codexRun=list.find(r=>r.source==='run'&&r.runId==='run-codex')!;
  assert.deepEqual(codexRun,{id:'run:event:'+codexRun.recordId,source:'run',recordId:codexRun.recordId,projectId:P,taskId:'task-1',runId:'run-codex',
    code:'UNCLASSIFIED',category:'unknown',evidenceSource:'native',at,bindingDigest:hash});
  assert.equal(list.find(r=>r.runId==='run-claude')!.code,'LOGIN_REQUIRED');
  assert.equal(list.find(r=>r.runId==='run-claude')!.evidenceSource,'mock');
  assert.ok(!list.some(r=>r.runId==='run-other'),'other project excluded');
  assert.deepEqual([by('check:check:check-1').code,by('check:check:check-1').category,by('check:check:check-1').evidenceSource],['FAILED','unknown','local']);
  assert.ok(!list.some(r=>r.recordId==='check-ok'));
  assert.equal(by('quality:loop:loop-1').category,'output_rejected');
  assert.deepEqual([by('quality:loop:loop-4').code,by('quality:loop:loop-4').category],['UNCLASSIFIED','unknown']);
  assert.deepEqual([by('integration:queue:iq-1').code,by('integration:queue:iq-1').category],['INTEGRATION_VERIFICATION_FAILED','output_rejected']);
  assert.deepEqual([by('integration:queue:iq-2').code,by('integration:queue:iq-2').category],['UNCLASSIFIED','unknown']);
  assert.deepEqual([by('worker:lost:res-1').code,by('worker:lost:res-1').category],['LOST_UNKNOWN','tool_environment']);
  assert.equal(by('worker:refusal:res-2').code,'INTEGRATION_BASELINE_CHANGED');
  assert.deepEqual([by('capability:execution:cap-1').code,by('capability:execution:cap-1').category,by('capability:execution:cap-1').evidenceSource],['EXECUTION_UNCONFIRMED','tool_environment','native']);
  for(const r of list)assert.deepEqual(Object.keys(r).filter(k=>!['id','source','recordId','projectId','taskId','runId','code','category','evidenceSource','at','bindingDigest'].includes(k)),[]);
  // Families hash with FE-1 fingerprint and keep mock counts apart; mock never feeds hypotheses.
  const quality=families.find(f=>f.tuple[1]==='QUALITY_EVIDENCE_INVALID'&&f.tuple[4]==='claude-code')!;
  assert.equal(quality.familyId,familyId(...quality.tuple));
  assert.deepEqual([quality.realCount,quality.mockCount],[1,1]);
  assert.equal(hypotheses.length,1);
  assert.deepEqual(hypotheses[0].evidence,['quality:loop:loop-1','quality:loop:loop-2']);
  assert.match(hypotheses[0].statement,/across runtimes/);
  store.close();
});

test('tolerates missing source tables and empty projects',()=>{
  const store=new Store(':memory:'),index=new FailureIndex(store),before=store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual([index.list(P),index.families(P),index.hypotheses(P)],[[],[],[]]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='verification_checks'").get()!.n,0);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
  store.close();
});

test('failure index imports no write APIs and contains no write SQL',()=>{
  const source=readFileSync(new URL('../server/failure-index.ts',import.meta.url),'utf8');
  for(const module of ['verification-configuration','verification-setup','tool-permissions','worker-scheduler','studio','goal-service','verification-service','integration-queue','controller'])
    assert.ok(!new RegExp(`from '[^']*${module}(\\.ts)?'`).test(source),module);
  assert.doesNotMatch(source,/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b|\.exec\(|\.append\(|\.transaction\(|\$\.run'/);
  assert.doesNotMatch(source,/'\$\.(prompt|response|output|run|evidence)'/);
});
