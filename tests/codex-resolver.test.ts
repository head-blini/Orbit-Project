import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,delimiter} from 'node:path';
import {tmpdir} from './temp.ts';
import {findCodex} from '../server/codex.ts';

const missing={message:'CODEX_NOT_INSTALLED'};
function fixture(t:test.TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'orbit-codex-resolver-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  function file(path:string,kind='darwin',mode=0o755){
    mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,kind==='darwin'?Buffer.from('cffaedfe00000000','hex'):kind==='win32'?Buffer.from('4d5a0000','hex'):'#!/bin/sh\nexit 0\n');
    chmodSync(path,mode);return path;
  }
  return {root,file};
}
test('macOS resolves executable native PATH files and Homebrew-style symlinks',{skip:process.platform==='win32'},t=>{
  const {root,file}=fixture(t),bin=join(root,'bin'),native=file(join(root,'Cellar','codex','codex'));
  mkdirSync(bin);symlinkSync(native,join(bin,'codex'));
  assert.equal(findCodex({platform:'darwin',arch:'arm64',env:{PATH:bin}}),native);
  assert.equal(findCodex({platform:'darwin',arch:'x64',env:{AICC_CODEX_BIN:native,PATH:''}}),native);
});
test('macOS resolves the official npm native package behind a PATH JavaScript symlink without executing it',{skip:process.platform==='win32'},t=>{
  const {root,file}=fixture(t),bin=join(root,'bin'),pkg=join(root,'lib','node_modules','@openai','codex');
  const wrapper=file(join(pkg,'bin','codex.js'),'script');
  const native=file(join(pkg,'node_modules','@openai','codex-darwin-arm64','vendor','aarch64-apple-darwin','bin','codex'));
  mkdirSync(bin);symlinkSync(wrapper,join(bin,'codex'));
  assert.equal(findCodex({platform:'darwin',arch:'arm64',env:{PATH:bin}}),native);
});
test('Windows direct executable and both npm package layouts retain discovery',t=>{
  const {root,file}=fixture(t);
  for(const arch of ['arm64','x64'])for(const layout of ['nested','sibling','bundled']){
    const bin=join(root,arch,layout),pkg=join(bin,'node_modules','@openai','codex');
    const base=layout==='nested'?join(pkg,'node_modules','@openai',`codex-win32-${arch}`):layout==='sibling'?join(dirname(pkg),`codex-win32-${arch}`):pkg;
    const native=file(join(base,'vendor',arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc','bin','codex.exe'),'win32');
    assert.equal(findCodex({platform:'win32',arch,env:{PATH:bin}}),native);
  }
  const native=file(join(root,'direct','codex.exe'),'win32');
  assert.equal(findCodex({platform:'win32',arch:'x64',env:{PATH:dirname(native)}}),native);
});
test('explicit overrides reject scripts, nonexecutables, directories, missing and relative paths without fallback',{skip:process.platform==='win32'},t=>{
  const {root,file}=fixture(t),native=file(join(root,'good','codex')),script=file(join(root,'script','codex'),'script');
  const nonexec=file(join(root,'nonexec','codex'),'darwin',0o644);
  for(const candidate of [script,nonexec,root,join(root,'missing'),'codex','']){
    assert.throws(()=>findCodex({platform:'darwin',arch:'arm64',env:{PATH:dirname(native),AICC_CODEX_BIN:candidate}}),missing);
  }
});
test('PATH ignores empty and relative directories, rejects scripts and unsupported architectures',t=>{
  const {root,file}=fixture(t);file(join(root,'codex'),'script');
  for(const arch of ['arm64','ia32'])assert.throws(()=>findCodex({platform:'darwin',arch,env:{PATH:['','.','relative',root].join(delimiter)}}),missing);
});
