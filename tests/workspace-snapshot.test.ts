import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { fingerprintWorkspace,readWorkspaceSnapshot,readWorkspaceSourceSnapshot,assertWorkspaceManifest } from '../server/workspace-fingerprint.ts';

const baseSha='a'.repeat(40),entry=(path:string,mode='100644')=>({path,mode});
const unavailable=/^Error: WORKSPACE_SNAPSHOT_UNAVAILABLE$/;
function fixture(t:TestContext){const root=fs.mkdtempSync(join(tmpdir(),'orbit-workspace-snapshot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('raw snapshot is sorted, retains binary/empty/deleted/Git modes, and equals the existing digest',t=>{
  const root=fixture(t),binary=Buffer.from([0,255,192,175,10]);
  fs.writeFileSync(join(root,'binary.bin'),binary);fs.writeFileSync(join(root,'empty.ts'),'');fs.writeFileSync(join(root,'invalid.TS'),binary);
  if(process.platform!=='win32')fs.chmodSync(join(root,'binary.bin'),0o755);
  const files=[entry('removed/deep.bin','100755'),entry('invalid.TS'),entry('empty.ts'),entry('binary.bin','100755')],before=structuredClone(files);
  const snapshot=readWorkspaceSnapshot(root,baseSha,files);
  assert.equal(snapshot.sourceDigest,fingerprintWorkspace(root,baseSha,files));assert.deepEqual(files,before);
  assert.deepEqual(snapshot.files.map(({path,mode,presence})=>({path,mode,presence})),[
    {path:'binary.bin',mode:'100755',presence:'present'},{path:'empty.ts',mode:'100644',presence:'present'},
    {path:'invalid.TS',mode:'100644',presence:'present'},{path:'removed/deep.bin',mode:'100755',presence:'deleted'}]);
  for(const file of snapshot.files){if(file.presence==='present')assert.deepEqual(Buffer.from(file.bytes),file.path==='empty.ts'?Buffer.alloc(0):binary);else assert.equal(Object.hasOwn(file,'bytes'),false);}
  assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,files),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);
  assert.deepEqual(readWorkspaceSnapshot(root,baseSha,[...files].reverse()),snapshot);
  assert.deepEqual(readWorkspaceSnapshot(root,baseSha,[]),{sourceDigest:fingerprintWorkspace(root,baseSha,[]),files:[]});
});

test('all raw bytes come from one read per present file and do not alias the reused read buffer or later disk writes',t=>{
  const root=fixture(t),bytes=Buffer.alloc(150_000);for(let index=0;index<bytes.length;index++)bytes[index]=Math.floor(index/65_536)+index%251;
  fs.writeFileSync(join(root,'asset.bin'),bytes);fs.writeFileSync(join(root,'other.txt'),'second');
  const files=[entry('asset.bin'),entry('other.txt'),entry('deleted.txt')],digest=fingerprintWorkspace(root,baseSha,files),open=fs.openSync.bind(fs),opened:string[]=[];
  t.mock.method(fs,'openSync',((path:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{opened.push(String(path));return open(path,flags,mode);}) as typeof fs.openSync);
  const snapshot=readWorkspaceSnapshot(root,baseSha,files);
  assert.equal(snapshot.sourceDigest,digest);assert.equal(opened.length,2);assert.equal(new Set(opened).size,2);
  const file=snapshot.files.find(file=>file.path==='asset.bin');assert.ok(file?.presence==='present');assert.deepEqual(Buffer.from(file.bytes),bytes);
  fs.writeFileSync(join(root,'asset.bin'),'changed');assert.deepEqual(Buffer.from(file.bytes),bytes);
});

test('POSIX executable-mode mismatch rejects only full snapshots; Windows retains the trusted Git mode independently',t=>{
  const root=fixture(t),target=join(root,'source.ts');fs.writeFileSync(target,'export {};');
  if(process.platform==='win32'){
    assert.equal(readWorkspaceSnapshot(root,baseSha,[entry('source.ts','100755')]).files[0].mode,'100755');
    assert.equal(readWorkspaceSnapshot(root,baseSha,[entry('source.ts','100644')]).files[0].mode,'100644');return;
  }
  fs.chmodSync(target,0o755);
  assert.throws(()=>readWorkspaceSnapshot(root,baseSha,[entry('source.ts')]),unavailable);
  assert.match(fingerprintWorkspace(root,baseSha,[entry('source.ts')]),/^[a-f0-9]{64}$/);
  assert.equal(readWorkspaceSourceSnapshot(root,baseSha,[entry('source.ts')]).files[0].content,'export {};');
  assert.equal(readWorkspaceSnapshot(root,baseSha,[entry('source.ts','100755')]).files[0].mode,'100755');
  fs.chmodSync(target,0o644);assert.throws(()=>readWorkspaceSnapshot(root,baseSha,[entry('source.ts','100755')]),unavailable);
});

test('full snapshots retain the original whole-workspace limits rather than JS/TS graph limits',t=>{
  const root=fixture(t);fs.writeFileSync(join(root,'large.ts'),Buffer.alloc(4*1024*1024,255));
  const files=[entry('large.ts'),...Array.from({length:101},(_,index)=>entry(`missing-${index}.ts`))];
  const snapshot=readWorkspaceSnapshot(root,baseSha,files);assert.equal(snapshot.files.length,102);
  const present=snapshot.files.find(file=>file.presence==='present');assert.ok(present?.presence==='present');assert.equal(present.bytes.byteLength,4*1024*1024);
  assert.equal(snapshot.sourceDigest,fingerprintWorkspace(root,baseSha,files));
  const boundary=Array.from({length:2000},(_,index)=>entry(`deleted-${index}.bin`));assert.equal(readWorkspaceSnapshot(root,baseSha,boundary).files.length,2000);
});

test('count, per-file and total caps are checked before any content is opened',t=>{
  const root=fixture(t),files=[];for(let index=0;index<9;index++){const path=`large-${index}.bin`;fs.writeFileSync(join(root,path),'');fs.truncateSync(join(root,path),4*1024*1024);files.push(entry(path));}
  fs.writeFileSync(join(root,'too-large.bin'),'');fs.truncateSync(join(root,'too-large.bin'),4*1024*1024+1);
  let opened=0;t.mock.method(fs,'openSync',(()=>{opened++;throw new Error('PRIVATE_OPEN_DETAILS');}) as typeof fs.openSync);
  for(const manifest of [Array.from({length:2001},(_,index)=>entry(`deleted-${index}.bin`)),[entry('too-large.bin')],files])assert.throws(()=>readWorkspaceSnapshot(root,baseSha,manifest),unavailable);
  assert.equal(opened,0);
});

test('sensitive or invalid entries anywhere in the manifest reject before reading ordinary content',t=>{
  const root=fixture(t);fs.writeFileSync(join(root,'aaa-safe.txt'),'ordinary');let opened=0;
  t.mock.method(fs,'openSync',(()=>{opened++;throw new Error('PRIVATE_OPEN_DETAILS');}) as typeof fs.openSync);
  for(const path of ['auth.json','.env.production','nested/credentials.backup','.git/config','.codex/auth.json','.aws/config','private.pem','state.db','out.log',
    '../outside','/outside','C:/outside','a\\b','bad\0name','a//b',''])
    assert.throws(()=>readWorkspaceSnapshot(root,baseSha,[entry('aaa-safe.txt'),entry(path)]),unavailable);
  assert.equal(opened,0);
});

test('directories, hardlinks, parent junctions and root junctions still reject without exposing bytes',t=>{
  const root=fixture(t),outside=fixture(t);fs.mkdirSync(join(root,'directory'));fs.writeFileSync(join(outside,'outside.bin'),'PRIVATE_OUTSIDE_VALUE');
  fs.linkSync(join(outside,'outside.bin'),join(root,'hard.bin'));fs.symlinkSync(outside,join(root,'redirect'),'junction');
  const holder=fixture(t),alias=join(holder,'root-link');fs.symlinkSync(root,alias,'junction');
  for(const [target,files] of [[root,[entry('directory')]],[root,[entry('hard.bin')]],[root,[entry('redirect/outside.bin')]],[alias,[entry('missing.bin')]]] as const)
    assert.throws(()=>readWorkspaceSnapshot(target,baseSha,files),unavailable);
});

test('observed mutation during read rejects with a fixed error and no partial snapshot',t=>{
  const root=fixture(t),target=join(root,'asset.bin');fs.writeFileSync(target,'original');const read=fs.readSync.bind(fs);let changed=false;
  t.mock.method(fs,'readSync',((...args:unknown[])=>{const count=(read as (...values:unknown[])=>number)(...args);if(!changed){changed=true;fs.writeFileSync(target,'PRIVATE_CHANGED_VALUE');}return count;}) as typeof fs.readSync);
  assert.throws(()=>readWorkspaceSnapshot(root,baseSha,[entry('asset.bin')]),unavailable);
});

test('final recheck detects an earlier file or deleted entry changed while a later file was read',t=>{
  const root=fixture(t);fs.writeFileSync(join(root,'a.bin'),'first');fs.writeFileSync(join(root,'z.bin'),'last');
  const open=fs.openSync.bind(fs);let changed=false;
  t.mock.method(fs,'openSync',((path:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{
    if(!changed&&String(path)===join(root,'z.bin')){changed=true;fs.writeFileSync(join(root,'a.bin'),'PRIVATE_REPLACEMENT');fs.writeFileSync(join(root,'deleted.bin'),'created');}
    return open(path,flags,mode);
  }) as typeof fs.openSync);
  assert.throws(()=>readWorkspaceSnapshot(root,baseSha,[entry('a.bin'),entry('deleted.bin'),entry('z.bin')]),unavailable);assert.equal(changed,true);
});

test('pure manifest assertion validates all fields and aliases without touching filesystem or invoking getters',t=>{
  for(const method of ['lstatSync','openSync','readFileSync'] as const)t.mock.method(fs,method,(()=>{throw new Error('UNEXPECTED_IO');}) as never);
  const valid=[entry('nested/source.ts','100755'),entry('asset.bin')],before=structuredClone(valid);assert.equal(assertWorkspaceManifest(valid),undefined);assert.deepEqual(valid,before);
  const invalid=()=>/^Error: WORKSPACE_MANIFEST_UNAVAILABLE$/;
  for(const files of [[entry('auth.json')],[entry('../outside')],[entry('a'),entry('a')],[entry('a','120000')],[entry('a','160000')]])assert.throws(()=>assertWorkspaceManifest(files),invalid());
  let accessed=false;const accessor={mode:'100644'};Object.defineProperty(accessor,'path',{enumerable:true,get(){accessed=true;return 'source.ts';}});
  assert.throws(()=>assertWorkspaceManifest([accessor as {path:string;mode:string}]),invalid());assert.equal(accessed,false);
  if(process.platform==='win32')for(const files of [[entry('a.ts'),entry('A.ts')],[entry('CON')],[entry('file:stream')],[entry('file.')] , [entry('file ')]])assert.throws(()=>assertWorkspaceManifest(files),invalid());
});
