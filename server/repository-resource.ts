import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {basename} from 'node:path';
import {canonical} from './projects.ts';
import {AppError} from './errors.ts';
import type {RepositoryIdentity} from '../shared/repository-authority.ts';

/** Filesystem identity for a primary repository's common Git directory. Does not create an authority. */
export function repositoryIdentity(commonGitDir:string):RepositoryIdentity {
  const path=canonical(commonGitDir),stat=lstatSync(path,{bigint:true});
  if(basename(path)!=='.git'||!stat.isDirectory())throw new AppError('INVALID_REPOSITORY_RESOURCE',409);
  const directory={device:String(stat.dev),inode:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};
  const normalized=process.platform==='win32'?path.toLowerCase():path;
  const repositoryId=createHash('sha256').update(JSON.stringify({commonGitDir:normalized,directory})).digest('hex');
  return {repositoryId,commonGitDir:path,directory};
}
