import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Store} from '../server/store.ts';
import {FailureCaseStore,failureCaseReader,type FailureCaseCreate} from '../server/failure-cases.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const RUN_BODY=JSON.stringify({id:'run-1',prompt:'raw prompt never copied',response:'raw response never copied'});
const D1='a'.repeat(64),D2='b'.repeat(64),FAMILY='f'.repeat(64);

function fixture(){
  const store=new Store(':memory:');
  store.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('run-1','req-run-1','d',RUN_BODY);
  return {store,cases:new FailureCaseStore(store)};
}
const input=(over:Partial<Record<keyof FailureCaseCreate,unknown>>={}):FailureCaseCreate=>({
  requestId:'case-req-0001',familyId:FAMILY,failureId:'run:run-1',sourceTable:'runs',recordId:'run-1',recordBodySha256:sha(RUN_BODY),
  expected:'same_failure',inputDigests:{artifact:D1,config:D2},conditions:{commandId:'npm-test',runtime:'codex'},indexerVersion:'fe-2.v1',confirmed:true,
  ...over,
} as FailureCaseCreate);
const code=(name:string)=>(error:unknown)=>error instanceof Error&&error.message===name;

test('create stores only the allow-listed digest manifest with provenance', ()=>{
  const {cases}=fixture(),created=cases.create(input());
  assert.deepEqual(Object.keys(created).sort(),['conditions','expected','failureId','familyId','id','inputDigests','provenance','requestId']);
  assert.deepEqual(created.inputDigests,{artifact:D1,config:D2});
  assert.deepEqual(created.conditions,{commandId:'npm-test',runtime:'codex'});
  assert.deepEqual(Object.keys(created.provenance).sort(),['createdAt','indexerVersion','recordBodySha256','recordId','sourceTable']);
  assert.equal(created.provenance.recordBodySha256,sha(RUN_BODY));
  assert.ok(!JSON.stringify(cases.listCases()).includes('raw'));
  assert.deepEqual(cases.getCase(created.id),created);
});

test('credential-like strings refuse the whole request instead of redacting', ()=>{
  const {store,cases}=fixture();
  for(const over of [{failureId:'sk-abcdefghijklmnop1234'},{conditions:{runtime:'sk-abcdefghijklmnop1234'}},{recordId:'glpat-abcdefghijklmnop'}]){
    assert.throws(()=>cases.create(input(over)),code('FAILURE_CASE_SENSITIVE_INPUT'));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM failure_cases').get()!.n,0);
});

test('free text, extra fields and malformed ids or digests are refused', ()=>{
  const {cases}=fixture();
  assert.throws(()=>cases.create(input({note:'it failed because'} as never)),code('FAILURE_CASE_CONFIRMATION_REQUIRED'));
  assert.throws(()=>cases.create(input({confirmed:false})),code('FAILURE_CASE_CONFIRMATION_REQUIRED'));
  for(const over of [
    {conditions:{runtime:'codex cli with spaces'}},{conditions:{commandId:'x',output:'y'}},{inputDigests:{artifact:'not-a-digest'}},
    {inputDigests:{prompt:D1}},{familyId:'F'.repeat(64)},{expected:'different'},{sourceTable:'projects'},{failureId:'/Users/x/file'},
    {recordBodySha256:`${D1}\n`},{indexerVersion:''},{requestId:'short'},{inputDigests:[D1]},
  ])assert.throws(()=>cases.create(input(over)),code('INVALID_FIELDS'),JSON.stringify(over));
});

test('provenance must match the current source row body', ()=>{
  const {store,cases}=fixture();
  assert.throws(()=>cases.create(input({recordBodySha256:D1})),code('FAILURE_CASE_PROVENANCE_MISMATCH'));
  assert.throws(()=>cases.create(input({recordId:'run-missing'})),code('FAILURE_CASE_SOURCE_NOT_FOUND'));
  assert.throws(()=>cases.create(input({sourceTable:'capability_executions'})),code('FAILURE_CASE_SOURCE_NOT_FOUND'));
  store.db.prepare('UPDATE runs SET body=? WHERE id=?').run('{"changed":true}','run-1');
  assert.throws(()=>cases.create(input()),code('FAILURE_CASE_PROVENANCE_MISMATCH'));
  assert.equal(store.db.prepare('SELECT body FROM runs WHERE id=?').get('run-1')!.body,'{"changed":true}');
});

test('requestId is idempotent and conflicts on different input', ()=>{
  const {cases}=fixture(),first=cases.create(input());
  assert.deepEqual(cases.create(input({inputDigests:{config:D2,artifact:D1}})),first);
  assert.throws(()=>cases.create(input({conditions:{runtime:'claude'}})),code('IDEMPOTENCY_CONFLICT'));
  const second=cases.create(input({requestId:'case-req-0002',familyId:D2}));
  assert.notEqual(second.id,first.id);
  assert.deepEqual(cases.listCases(FAMILY).map(c=>c.id),[first.id]);
  assert.equal(cases.listCases().length,2);
});

test('reads do not write and delete requires explicit confirmation', ()=>{
  const {store,cases}=fixture(),created=cases.create(input());
  const before=store.db.prepare('SELECT total_changes() AS n').get()!.n;
  cases.listCases();cases.getCase(created.id);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
  assert.throws(()=>cases.getCase('missing'),code('FAILURE_CASE_NOT_FOUND'));
  for(const options of [undefined,{},{confirmed:false},{confirmed:'true'},{confirmed:true,force:true}]){
    assert.throws(()=>cases.delete(created.id,options as never),code('FAILURE_CASE_CONFIRMATION_REQUIRED'));
  }
  assert.equal(cases.listCases().length,1);
  assert.deepEqual(cases.delete(created.id,{confirmed:true}),{id:created.id,deleted:true});
  assert.throws(()=>cases.getCase(created.id),code('FAILURE_CASE_NOT_FOUND'));
});

test('reader port exposes only listCases and getCase', ()=>{
  const {cases}=fixture(),created=cases.create(input()),reader=failureCaseReader(cases) as unknown as Record<string,unknown>;
  assert.deepEqual(Object.keys(reader).sort(),['getCase','listCases']);
  assert.equal(reader.create,undefined);assert.equal(reader.delete,undefined);assert.ok(Object.isFrozen(reader));
  assert.deepEqual((reader.getCase as (id:string)=>unknown)(created.id),created);
});

test('failure cases import no write-capable orchestration modules', ()=>{
  const source=readFileSync(new URL('../server/failure-cases.ts',import.meta.url),'utf8');
  const imports=[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(m=>m[1]??m[2]);
  assert.ok(imports.length>0);
  for(const forbidden of ['verification-configuration','verification-setup','tool-permissions','worker-scheduler','studio','goal-service','controller']){
    assert.ok(!imports.some(path=>path.includes(forbidden)),forbidden);
  }
});
