import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { fingerprintWorkspace,readWorkspaceSourceSnapshot } from '../server/workspace-fingerprint.ts';

const baseSha='a'.repeat(40),entry=(path:string,mode='100644')=>({path,mode});
const fixture=()=>fs.mkdtempSync(join(tmpdir(),'orbit-fingerprint-'));

test('hashes sorted visible source bytes and Git modes deterministically without depending on workspace location',()=>{
  const a=fixture(),b=fixture();for(const root of [a,b]){fs.mkdirSync(join(root,'src'));fs.writeFileSync(join(root,'src','한글.ts'),'export const message="안녕";\n');fs.writeFileSync(join(root,'asset.bin'),Buffer.from([0,255,1,10]));}
  const files=[entry('src/한글.ts'),entry('asset.bin')],before=structuredClone(files);
  const digest=fingerprintWorkspace(a,baseSha,files);assert.match(digest,/^[a-f0-9]{64}$/);
  assert.equal(fingerprintWorkspace(a,baseSha,[...files].reverse()),digest);assert.equal(fingerprintWorkspace(b,baseSha,files),digest);assert.deepEqual(files,before);
  fs.writeFileSync(join(a,'asset.bin'),Buffer.from([0,255,2,10]));assert.notEqual(fingerprintWorkspace(a,baseSha,files),digest);
  assert.notEqual(fingerprintWorkspace(b,'b'.repeat(40),files),digest);assert.notEqual(fingerprintWorkspace(b,baseSha,[entry('src/한글.ts','100755'),entry('asset.bin')]),digest);
});

test('deleted paths remain represented and differ from empty files and absent manifest entries',()=>{
  const root=fixture();fs.writeFileSync(join(root,'empty.ts'),'');
  const deleted=fingerprintWorkspace(root,baseSha,[entry('removed.ts'),entry('gone/deep.ts')]);
  assert.notEqual(deleted,fingerprintWorkspace(root,baseSha,[]));assert.notEqual(deleted,fingerprintWorkspace(root,baseSha,[entry('empty.ts')]));
  fs.writeFileSync(join(root,'removed.ts'),'');assert.notEqual(fingerprintWorkspace(root,baseSha,[entry('removed.ts'),entry('gone/deep.ts')]),deleted);
});

test('sensitive entries are rejected before any source file is opened, even when their content is missing',t=>{
  const root=fixture();fs.writeFileSync(join(root,'ordinary.ts'),'ordinary');fs.writeFileSync(join(root,'auth.json'),'SYNTHETIC_PRIVATE_VALUE');
  let opened=0;t.mock.method(fs,'openSync',(()=>{opened++;throw new Error('SYNTHETIC_OPEN_DETAILS');}) as typeof fs.openSync);
  for(const path of ['auth.json','.env','.env.production','nested/.env-secret','credentials','credentials.backup','.git/config','.codex/auth.json','.agents/skills/data.ts',
    '.aws/config','private.key','private.pem','private.p12','private.pfx','state.sqlite','state.sqlite-wal','state.db-shm','output.log'])
    assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('ordinary.ts'),entry(path)]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  assert.equal(opened,0);
});

test('traversal, absolute, backslash, control, duplicate and unsupported Git-mode entries fail closed',()=>{
  const root=fixture();fs.writeFileSync(join(root,'code.ts'),'ordinary');
  for(const path of ['../outside.ts','a/../outside.ts','./code.ts','/outside.ts','C:/outside.ts','a\\code.ts','bad\0name','bad\nname','a//b','a/',''])
    assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry(path)]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('code.ts'),entry('code.ts')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  for(const mode of ['120000','160000','040000','untracked','100664',''])assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('code.ts',mode)]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  if(process.platform==='win32')for(const path of ['CODE.ts','code.ts.','code.ts ','CON','code.ts:alternate'])
    assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('code.ts'),entry(path)]),/^Error: FINGERPRINT_UNAVAILABLE$/);
});

test('directories, hardlinks and parent or root junctions cannot masquerade as ordinary source files',()=>{
  const root=fixture(),outside=fixture();fs.mkdirSync(join(root,'directory'));fs.writeFileSync(join(outside,'outside.ts'),'SYNTHETIC_OUTSIDE_VALUE');
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('directory')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  fs.linkSync(join(outside,'outside.ts'),join(root,'hardlink.ts'));
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('hardlink.ts')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  fs.symlinkSync(outside,join(root,'redirect'),'junction');assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('redirect/outside.ts')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  const alias=join(fixture(),'root-link');fs.symlinkSync(root,alias,'junction');assert.throws(()=>fingerprintWorkspace(alias,baseSha,[entry('missing.ts')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
});

test('only caller-listed source is hashed, while listed build outputs are never silently skipped',()=>{
  const root=fixture();fs.writeFileSync(join(root,'source.ts'),'source');fs.mkdirSync(join(root,'dist'));fs.writeFileSync(join(root,'dist','output.js'),'before');
  const source=fingerprintWorkspace(root,baseSha,[entry('source.ts')]),build=fingerprintWorkspace(root,baseSha,[entry('source.ts'),entry('dist/output.js')]);
  fs.writeFileSync(join(root,'dist','output.js'),'after');assert.equal(fingerprintWorkspace(root,baseSha,[entry('source.ts')]),source);
  assert.notEqual(fingerprintWorkspace(root,baseSha,[entry('source.ts'),entry('dist/output.js')]),build);
});

test('file count, individual file size and total byte ceilings reject rather than omit source',()=>{
  const root=fixture();assert.throws(()=>fingerprintWorkspace(root,baseSha,Array.from({length:2001},(_,index)=>entry('file-'+index+'.ts'))),/^Error: FINGERPRINT_UNAVAILABLE$/);
  fs.writeFileSync(join(root,'large.bin'),'');fs.truncateSync(join(root,'large.bin'),4*1024*1024+1);
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('large.bin')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  const files:{path:string;mode:string}[]=[];for(let index=0;index<9;index++){const path='total-'+index+'.bin';fs.writeFileSync(join(root,path),'');fs.truncateSync(join(root,path),4*1024*1024);files.push(entry(path));}
  assert.throws(()=>fingerprintWorkspace(root,baseSha,files),/^Error: FINGERPRINT_UNAVAILABLE$/);
});

test('a file replaced between lstat and open is rejected before reading its replacement',t=>{
  const root=fixture(),target=join(root,'source.ts');fs.writeFileSync(target,'original');const open=fs.openSync.bind(fs);let replaced=false,read=0;
  t.mock.method(fs,'openSync',((path:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{if(!replaced&&String(path)===target){replaced=true;fs.renameSync(target,target+'.old');fs.writeFileSync(target,'SYNTHETIC_REPLACEMENT');}return open(path,flags,mode);}) as typeof fs.openSync);
  const originalRead=fs.readSync.bind(fs);t.mock.method(fs,'readSync',((...args:unknown[])=>{read++;return (originalRead as (...input:unknown[])=>number)(...args);}) as typeof fs.readSync);
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('source.ts')]),/^Error: FINGERPRINT_UNAVAILABLE$/);assert.equal(read,0);
});

test('mutation while reading invalidates the hash and errors contain no underlying content or path details',t=>{
  const root=fixture(),target=join(root,'source.ts');fs.writeFileSync(target,'original');const read=fs.readSync.bind(fs);let changed=false;
  t.mock.method(fs,'readSync',((...args:unknown[])=>{const count=(read as (...input:unknown[])=>number)(...args);if(!changed){changed=true;fs.writeFileSync(target,'SYNTHETIC_CHANGED_PRIVATE_VALUE');}return count;}) as typeof fs.readSync);
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[entry('source.ts')]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  assert.throws(()=>fingerprintWorkspace(join(root,'SYNTHETIC_PRIVATE_PATH'),baseSha,[]),/^Error: FINGERPRINT_UNAVAILABLE$/);
});

test('malformed bases and accessor records fail without invoking input getters',()=>{
  const root=fixture();for(const base of ['', 'not-a-sha','a'.repeat(41)])assert.throws(()=>fingerprintWorkspace(root,base,[]),/^Error: FINGERPRINT_UNAVAILABLE$/);
  let accessed=false;const file={mode:'100644'};Object.defineProperty(file,'path',{enumerable:true,get(){accessed=true;return 'source.ts';}});
  assert.throws(()=>fingerprintWorkspace(root,baseSha,[file as {path:string;mode:string}]),/^Error: FINGERPRINT_UNAVAILABLE$/);assert.equal(accessed,false);
});

test('source snapshot returns the same hashed bytes once and excludes unsupported or deleted entries',t=>{
  const root=fixture();fs.mkdirSync(join(root,'src'));
  const content='export const message="안녕 🌱";\n';fs.writeFileSync(join(root,'src','한글.TsX'),content);fs.writeFileSync(join(root,'asset.bin'),Buffer.from([0,255,1]));fs.writeFileSync(join(root,'README.md'),'fixture');
  const files=[entry('removed.ts'),entry('README.md'),entry('src/한글.TsX'),entry('asset.bin')];
  const before=fingerprintWorkspace(root,baseSha,files),opened:string[]=[],open=fs.openSync.bind(fs);
  t.mock.method(fs,'openSync',((path:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{opened.push(String(path));return open(path,flags,mode);}) as typeof fs.openSync);
  const snapshot=readWorkspaceSourceSnapshot(root,baseSha,files);
  assert.equal(snapshot.sourceDigest,before);assert.deepEqual(snapshot.files,[{path:'src/한글.TsX',content}]);assert.equal(snapshot.excludedFileCount,3);
  assert.equal(opened.length,3);assert.equal(new Set(opened).size,3);
  fs.writeFileSync(join(root,'asset.bin'),Buffer.from([0,255,2]));assert.notEqual(readWorkspaceSourceSnapshot(root,baseSha,files).sourceDigest,before);
});

test('source snapshot supports only the fixed JS and TS extension list case-insensitively',()=>{
  const root=fixture(),names=['a.ts','b.tsx','c.js','d.jsx','e.mts','f.cts','g.mjs','h.cjs','UPPER.JSX'];
  for(const name of names)fs.writeFileSync(join(root,name),'export {};\n');
  fs.writeFileSync(join(root,'a.ts.map'),'not source');
  const snapshot=readWorkspaceSourceSnapshot(root,baseSha,[...names,'a.ts.map','deleted.js'].map(name=>entry(name)));
  assert.equal(snapshot.files.length,9);assert.deepEqual(new Set(snapshot.files.map(file=>file.path)),new Set(names));assert.equal(snapshot.excludedFileCount,2);
});

test('source count and byte limits are checked before opening any manifest content',t=>{
  const root=fixture(),files=Array.from({length:101},(_,index)=>entry('source-'+index+'.ts'));
  for(const file of files)fs.writeFileSync(join(root,file.path),'');
  let opened=0;t.mock.method(fs,'openSync',(()=>{opened++;throw new Error('SYNTHETIC_OPEN_DETAILS');}) as typeof fs.openSync);
  assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,files),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);assert.equal(opened,0);
  const large='large.ts';fs.writeFileSync(join(root,large),'x'.repeat(256*1024+1));
  assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,[entry(large)]),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);assert.equal(opened,0);
  const total:{path:string;mode:string}[]=[];for(let index=0;index<17;index++){const path='total-'+index+'.js';fs.writeFileSync(join(root,path),'x'.repeat(256*1024));total.push(entry(path));}
  assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,total),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);assert.equal(opened,0);
});

test('source exact limits remain accepted while fingerprint-only keeps its original larger binary policy',()=>{
  const root=fixture(),files=[];for(let index=0;index<16;index++){const path='source-'+index+'.ts';fs.writeFileSync(join(root,path),'x'.repeat(256*1024));files.push(entry(path));}
  const snapshot=readWorkspaceSourceSnapshot(root,baseSha,files);assert.equal(snapshot.files.length,16);assert.equal(snapshot.files[0].content.length,256*1024);assert.equal(snapshot.sourceDigest,fingerprintWorkspace(root,baseSha,files));
  fs.writeFileSync(join(root,'too-large.ts'),'x'.repeat(256*1024+1));assert.match(fingerprintWorkspace(root,baseSha,[entry('too-large.ts')]),/^[a-f0-9]{64}$/);
  const countBoundary=Array.from({length:100},(_,index)=>entry('empty-'+index+'.tsx'));for(const file of countBoundary)fs.writeFileSync(join(root,file.path),'');
  assert.equal(readWorkspaceSourceSnapshot(root,baseSha,countBoundary).files.length,100);
});

test('source snapshot rejects malformed UTF8 and NUL without changing fingerprint-only behavior',()=>{
  const root=fixture();for(const bytes of [Buffer.from([0xff]),Buffer.from([0xc0,0xaf]),Buffer.from([0xe2,0x82]),Buffer.from('const x="\0";')]){
    fs.writeFileSync(join(root,'source.ts'),bytes);assert.match(fingerprintWorkspace(root,baseSha,[entry('source.ts')]),/^[a-f0-9]{64}$/);
    assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,[entry('source.ts')]),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);
  }
  const bom=Buffer.from('\uFEFFexport const text="안녕";\n','utf8');fs.writeFileSync(join(root,'source.ts'),bom);
  assert.ok(Buffer.from(readWorkspaceSourceSnapshot(root,baseSha,[entry('source.ts')]).files[0].content,'utf8').equals(bom));
});

test('source snapshot preserves whole-manifest sensitive-path and hardlink or junction rejection',t=>{
  const root=fixture(),outside=fixture();fs.writeFileSync(join(root,'safe.ts'),'export {};');fs.writeFileSync(join(outside,'outside.ts'),'SYNTHETIC_OUTSIDE_VALUE');
  let opened=0;const open=fs.openSync.bind(fs);t.mock.method(fs,'openSync',((...args:unknown[])=>{opened++;return (open as (...values:unknown[])=>number)(...args);}) as typeof fs.openSync);
  assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,[entry('safe.ts'),entry('auth.json')]),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);assert.equal(opened,0);
  fs.linkSync(join(outside,'outside.ts'),join(root,'hard.ts'));assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,[entry('safe.ts'),entry('hard.ts')]),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);assert.equal(opened,0);
  fs.symlinkSync(outside,join(root,'redirect'),'junction');assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,[entry('safe.ts'),entry('redirect/outside.ts')]),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);assert.equal(opened,0);
});

test('source snapshot rejects changes during its shared read before exposing content or digest',t=>{
  const root=fixture();fs.writeFileSync(join(root,'source.ts'),'export const original = true;');const read=fs.readSync.bind(fs);let changed=false;
  t.mock.method(fs,'readSync',((...args:unknown[])=>{const count=(read as (...values:unknown[])=>number)(...args);if(!changed){changed=true;fs.writeFileSync(join(root,'source.ts'),'SYNTHETIC_CHANGED_PRIVATE_VALUE');}return count;}) as typeof fs.readSync);
  assert.throws(()=>readWorkspaceSourceSnapshot(root,baseSha,[entry('source.ts')]),/^Error: SOURCE_SNAPSHOT_UNAVAILABLE$/);
});
