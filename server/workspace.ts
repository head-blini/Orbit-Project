import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const marker='AI Coding Control Center disposable read-only fixture v1\n';
export function createWorkspace(parent:string):string {
  mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'aicc-fixture-'));
  execFileSync('git',['init','--quiet',root],{windowsHide:true,stdio:'pipe'});
  writeFileSync(join(root,'README.md'),marker);
  return realpathSync(root);
}
export function assertWorkspace(root:string):void {
  if(lstatSync(root).isSymbolicLink() || resolve(root)!==realpathSync(root)) throw new Error('INVALID_WORKSPACE');
  for(const entry of readdirSync(root,{withFileTypes:true})) {
    if(entry.isSymbolicLink() || !['.git','README.md'].includes(entry.name)) throw new Error('WORKSPACE_CHANGED');
  }
  if(lstatSync(join(root,'README.md')).isSymbolicLink() || readFileSync(join(root,'README.md'),'utf8')!==marker) throw new Error('WORKSPACE_CHANGED');
  if(!lstatSync(join(root,'.git')).isDirectory() || lstatSync(join(root,'.git')).isSymbolicLink()) throw new Error('INVALID_WORKSPACE');
}
