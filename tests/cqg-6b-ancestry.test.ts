import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from './temp.ts';
import {trustedGit} from '../server/git-process.ts';
import {inspectIntegrationTarget,prepareIntegrationCandidate,applyMergeCandidate,observeMergeApplication,isAncestor} from '../server/merge-git.ts';

test('CQG-6b precondition: applied candidate is an ancestor of the target history',()=>{
 const root=mkdtempSync(join(tmpdir(),'cqg-6b-ancestry-')),repo=join(root,'repo'),scratch=join(root,'scratch');
 mkdirSync(repo);mkdirSync(scratch);
 const git=(...args:string[])=>trustedGit(repo,args,{identity:true}).toString().trim();
 try{
  git('init','-b','dev');writeFileSync(join(repo,'a.txt'),'base');git('add','.');git('commit','-m','base');
  const base=git('rev-parse','HEAD'),target=inspectIntegrationTarget(repo,'dev','main');
  const {candidate}=prepareIntegrationCandidate(repo,base,{sourceDigest:'a'.repeat(64),files:[{path:'a.txt',mode:'100644',presence:'present',bytes:Buffer.from('predecessor')}]},target,randomUUID(),scratch);
  applyMergeCandidate(repo,target,candidate);
  assert.equal(observeMergeApplication(repo,target,candidate),'applied');
  assert.equal(git('rev-parse','refs/heads/dev'),candidate.commitSha);
  git('merge-base','--is-ancestor',candidate.commitSha,'refs/heads/dev');
  git('commit','--allow-empty','-m','later');
  git('merge-base','--is-ancestor',candidate.commitSha,'refs/heads/dev');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('CQG-6b linear apply: single parent, fast-forward, and merge candidates refused',()=>{
 const root=mkdtempSync(join(tmpdir(),'cqg-6b-linear-')),repo=join(root,'repo'),scratch=join(root,'scratch');
 mkdirSync(repo);mkdirSync(scratch);
 const git=(...args:string[])=>trustedGit(repo,args,{identity:true}).toString().trim();
 try{
  git('init','-b','dev');writeFileSync(join(repo,'a.txt'),'base');git('add','.');git('commit','-m','base');
  const base=git('rev-parse','HEAD'),target=inspectIntegrationTarget(repo,'dev','main');
  const {candidate}=prepareIntegrationCandidate(repo,base,{sourceDigest:'a'.repeat(64),files:[{path:'a.txt',mode:'100644',presence:'present',bytes:Buffer.from('predecessor')}]},target,randomUUID(),scratch);
  assert.equal(git('rev-list','--parents','-n','1',candidate.commitSha),`${candidate.commitSha} ${base}`);
  const mergeSha=trustedGit(repo,['commit-tree',candidate.treeSha,'-p',base,'-p',candidate.commitSha],{identity:true,input:Buffer.from('two-parent candidate')}).toString().trim();
  git('update-ref','refs/heads/'+candidate.branch,mergeSha,candidate.commitSha);
  assert.throws(()=>applyMergeCandidate(repo,target,{...candidate,commitSha:mergeSha}),/MERGE_GIT_UNAVAILABLE/);
  assert.equal(git('rev-parse','refs/heads/dev'),base);
  git('update-ref','refs/heads/'+candidate.branch,candidate.commitSha,mergeSha);
  applyMergeCandidate(repo,target,candidate);
  assert.equal(observeMergeApplication(repo,target,candidate),'applied');
  assert.equal(git('rev-parse','refs/heads/dev'),candidate.commitSha);
  assert.equal(git('rev-list','--min-parents=2',base+'..refs/heads/dev'),'');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('CQG-6b isAncestor: related, equal, reversed, unrelated, unknown and malformed inputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'cqg-6b-is-ancestor-')),repo=join(root,'repo');
 mkdirSync(repo);
 const git=(...args:string[])=>trustedGit(repo,args,{identity:true}).toString().trim();
 try{
  git('init','-b','dev');writeFileSync(join(repo,'a.txt'),'base');git('add','.');git('commit','-m','base');
  const a=git('rev-parse','HEAD');git('commit','--allow-empty','-m','next');const b=git('rev-parse','HEAD');
  const unrelated=trustedGit(repo,['commit-tree',git('rev-parse','HEAD^{tree}')],{identity:true,input:Buffer.from('orphan')}).toString().trim();
  assert.equal(isAncestor(repo,a,b),true);
  assert.equal(isAncestor(repo,a,a),true);
  assert.equal(isAncestor(repo,b,a),false);
  assert.equal(isAncestor(repo,a,unrelated),false);
  assert.throws(()=>isAncestor(repo,'f'.repeat(40),b));
  assert.throws(()=>isAncestor(repo,'HEAD',b),/MERGE_GIT_UNAVAILABLE/);
  assert.throws(()=>isAncestor(repo,a,'dev'),/MERGE_GIT_UNAVAILABLE/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
