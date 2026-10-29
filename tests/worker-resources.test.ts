import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkerClaim,workerClaimsConflict} from '../server/worker-resources.ts';
import type {WorkerPath,WorkerResourceClaim} from '../shared/parallel-workers.ts';
const path=(value:string):WorkerPath=>({path:value,canonicalPath:value,aliasStatus:'verified_no_alias'});
const file=(value:string,mode:'read'|'write'='write',repositoryId='a'.repeat(64)):WorkerResourceClaim=>({kind:'repository_file',repositoryId,path:path(value),mode});
const db=(value:string):WorkerResourceClaim=>({kind:'db_file_group',host:'host-a',path:path(value)});
test('file conflict matrix uses repository identity, case folding and read/write mode',()=>{
  for(const a of ['read','write'] as const)for(const b of ['read','write'] as const){
    assert.equal(workerClaimsConflict(file('Src/a.ts',a),file('src/A.ts',b)),a==='write'||b==='write');
    assert.equal(workerClaimsConflict(file('src/a.ts',a),file('src/b.ts',b)),false);
  }
  assert.equal(workerClaimsConflict(file('src/a.ts'),file('src/a.ts','write','b'.repeat(64))),false);
});
test('rejects traversal and ambiguous aliases without filesystem access',()=>{
  for(const value of ['../x','a/../x','/root','a\\b','a//b','./x','a/./b','a/','a:stream','a%2fb','a\u0000b','a.','a ','CON','a/PRN.txt']){
    assert.throws(()=>normalizeWorkerClaim(file(value)),/WORKER_PATH/);
  }
  for(const aliasStatus of ['alias','unknown'] as const)assert.throws(()=>normalizeWorkerClaim({...file('a'),path:{...path('a'),aliasStatus}} as WorkerResourceClaim),/WORKER_PATH/);
  assert.throws(()=>normalizeWorkerClaim({...file('A'),path:{...path('A'),canonicalPath:'a'}} as WorkerResourceClaim),/WORKER_PATH/);
  assert.throws(()=>normalizeWorkerClaim(file('cafe\u0301')),/WORKER_PATH/);
});
test('glob overlap is conservative; unsupported syntax is refused',()=>{
  for(const [a,b,conflict] of [['src/**','src/a.ts',true],['src/*.ts','src/*.js',true],['**/a','docs/b',true],['src/**','docs/**',false],['src/a?','src/ab',true],['src','src/a',true]] as const){
    assert.equal(workerClaimsConflict(file(a),file(b)),conflict);
    assert.equal(workerClaimsConflict(file(b),file(a)),conflict);
  }
  for(const value of ['src/[ab]','src/{a,b}','!src/a','src/+(a)','src/a**b'])assert.throws(()=>normalizeWorkerClaim(file(value)),/WORKER_PATH/);
});
test('DB, WAL and SHM are one exclusive group; folders cover descendants',()=>{
  for(const a of ['','-wal','-shm'])for(const b of ['','-wal','-shm'])assert.equal(workerClaimsConflict(db('/data/test.db'+a),db('/data/test.db'+b)),true);
  assert.equal(workerClaimsConflict(db('/data/a.db'),db('/data/b.db')),false);
  const folder:WorkerResourceClaim={kind:'isolated_folder',host:'host-a',path:path('/data')};
  assert.equal(workerClaimsConflict(folder,db('/data/test.db')),true);
  assert.equal(workerClaimsConflict(folder,{...folder,path:path('/database')}),false);
  assert.equal(workerClaimsConflict(db('/data/test.db'),{...folder,path:path('/data/test.db-wal')}),true);
  assert.equal(workerClaimsConflict(file('test.db'),db('/data/test.db')),true);
});
test('ports compare host/protocol/address/port and refuse unresolved addresses',()=>{
  const port:WorkerResourceClaim={kind:'port',host:'host-a',protocol:'tcp',address:'127.0.0.1',port:3456};
  assert.equal(workerClaimsConflict(port,{...port}),true);
  for(const change of [{port:3457},{protocol:'udp' as const},{host:'host-b'},{address:'127.0.0.2'}])assert.equal(workerClaimsConflict(port,{...port,...change}),false);
  assert.equal(workerClaimsConflict(port,{...port,address:'0.0.0.0'}),true);
  for(const change of [{port:0},{port:65536},{port:1.5},{address:'localhost'},{host:'HOST-A'}])assert.throws(()=>normalizeWorkerClaim({...port,...change}),/WORKER_RESOURCE/);
});
test('external targets are exclusive and unknown kinds or fields fail closed',()=>{
  const target:WorkerResourceClaim={kind:'external_target',targetKey:'account:document:42'};
  assert.equal(workerClaimsConflict(target,target),true);
  assert.equal(workerClaimsConflict(target,{...target,targetKey:'account:document:43'}),false);
  for(const claim of [{kind:'unknown'},{...target,extra:true},{...target,targetKey:''}])assert.throws(()=>normalizeWorkerClaim(claim as WorkerResourceClaim),/WORKER_RESOURCE/);
});
test('normalization is idempotent and does not mutate DB suffix paths',()=>{
  for(const value of ['/data/test.db','/data/test.db-wal','/data/test.db-wal-wal']){
    const claim=db(value),before=structuredClone(claim),normalized=normalizeWorkerClaim(claim);
    assert.deepEqual(claim,before);assert.deepEqual(normalizeWorkerClaim(normalized),normalized);
    assert.equal(workerClaimsConflict(claim,db(value+'-shm')),true);
  }
});
test('IPv6 wildcard conflicts conservatively and alternate address spellings are refused',()=>{
  const port:WorkerResourceClaim={kind:'port',host:'host-a',protocol:'tcp',address:'::1',port:3456};
  assert.equal(workerClaimsConflict(port,port),true);
  assert.equal(workerClaimsConflict(port,{...port,address:'::'}),true);
  assert.equal(workerClaimsConflict({...port,address:'127.0.0.1'},{...port,address:'::'}),true);
  for(const address of ['0:0:0:0:0:0:0:1','::ffff:127.0.0.1','::ffff:7f00:1','fe80::1%lo0'])assert.throws(()=>normalizeWorkerClaim({...port,address}),/WORKER_RESOURCE/);
});
