import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from './temp.ts';
import {trustedGit} from '../server/git-process.ts';
import {inspectIntegrationTarget,prepareIntegrationCandidate,applyMergeCandidate,observeMergeApplication} from '../server/merge-git.ts';

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
