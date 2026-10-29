import {isIP} from 'node:net';
import type {WorkerPath,WorkerResourceClaim} from '../shared/parallel-workers.ts';
import {AppError} from './errors.ts';

function fail(code='WORKER_RESOURCE_INVALID'):never {throw new AppError(code,400);}
function fields(value:unknown,keys:string[]):boolean {
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=1024&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const host=(value:unknown)=>text(value)&&/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);

/** Pure lexical validation. Identity/alias evidence is a trusted caller obligation;
 * no realpath, DNS, Git, or filesystem access occurs here. */
function normalizePath(value:WorkerPath,absolute:boolean,glob:boolean):WorkerPath {
  if(!fields(value,['path','canonicalPath','aliasStatus'])||!text(value.path)
    ||value.aliasStatus!=='verified_no_alias'||value.path!==value.canonicalPath
    ||value.path!==value.path.normalize('NFC'))fail('WORKER_PATH_UNVERIFIED');
  const path=value.path;
  if(path.startsWith('/')!==absolute||/[\\:%\x00-\x1f\x7f\[\]{}!()+|]/.test(path))fail('WORKER_PATH_INVALID');
  const parts=(absolute?path.slice(1):path).split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[.\s]$/.test(p)||/^\s/.test(p)
    ||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
    ||(!glob&&/[*?]/.test(p))||(p.includes('**')&&p!=='**')))fail('WORKER_PATH_INVALID');
  return {path,canonicalPath:path,aliasStatus:'verified_no_alias'};
}
export function normalizeWorkerClaim(claim:WorkerResourceClaim):WorkerResourceClaim {
  if(!claim||typeof claim!=='object')fail();
  switch(claim.kind){
    case 'repository_file':
      if(!fields(claim,['kind','repositoryId','path','mode'])||typeof claim.repositoryId!=='string'
        ||!/^[a-f0-9]{64}$/.test(claim.repositoryId)||!['read','write'].includes(claim.mode))fail();
      return {kind:claim.kind,repositoryId:claim.repositoryId,path:normalizePath(claim.path,false,true),mode:claim.mode};
    case 'isolated_folder':case 'db_file_group':{
      if(!fields(claim,['kind','host','path'])||!host(claim.host))fail();
      const path=normalizePath(claim.path,true,false);
      return {kind:claim.kind,host:claim.host,path};
    }
    case 'port':{
      if(!fields(claim,['kind','host','protocol','address','port'])||!host(claim.host)
        ||!['tcp','udp'].includes(claim.protocol)||!Number.isSafeInteger(claim.port)||claim.port<1||claim.port>65535
        ||typeof claim.address!=='string'||!isIP(claim.address)||claim.address.includes('%'))fail();
      // Reject alternate IPv6 spellings and mapped IPv4 aliases rather than inventing identity.
      if(isIP(claim.address)===6&&(claim.address.startsWith('::ffff:')
        ||new URL(`http://[${claim.address}]/`).hostname!==`[${claim.address}]`))fail();
      return {kind:claim.kind,host:claim.host,protocol:claim.protocol,address:claim.address,port:claim.port};
    }
    case 'external_target':
      if(!fields(claim,['kind','targetKey'])||!text(claim.targetKey))fail();
      return {kind:claim.kind,targetKey:claim.targetKey};
    default:return fail();
  }
}
const folded=(path:string)=>path.normalize('NFC').toLowerCase();
function overlaps(a:string,b:string):boolean {
  const left=folded(a).split('/'),right=folded(b).split('/');
  for(let i=0;i<Math.min(left.length,right.length);i++){
    // Only unequal literal components prove disjointness. Never guess glob disjointness.
    if(/[*?]/.test(left[i])||/[*?]/.test(right[i]))return true;
    if(left[i]!==right[i])return false;
  }
  return true;
}
export function workerClaimsConflict(left:WorkerResourceClaim,right:WorkerResourceClaim):boolean {
  const a=normalizeWorkerClaim(left),b=normalizeWorkerClaim(right);
  if(a.kind==='external_target'||b.kind==='external_target')return a.kind==='external_target'&&b.kind==='external_target'&&a.targetKey===b.targetKey;
  if(a.kind==='port'||b.kind==='port')return a.kind==='port'&&b.kind==='port'&&a.host===b.host&&a.protocol===b.protocol&&a.port===b.port
    &&(a.address===b.address||['0.0.0.0','::'].includes(a.address)||['0.0.0.0','::'].includes(b.address));
  if(a.kind==='repository_file'&&b.kind==='repository_file')return a.repositoryId===b.repositoryId
    &&(a.mode==='write'||b.mode==='write')&&overlaps(a.path.path,b.path.path);
  // Without a repository-to-physical-path mapping, cross-kind disjointness is unproven.
  if(a.kind==='repository_file'||b.kind==='repository_file')return true;
  if(a.host!==b.host)return false;
  const paths=(c:typeof a)=>{
    if(c.kind!=='db_file_group')return [c.path.path];
    const base=c.path.path.replace(/-(wal|shm)$/i,'');
    // A suffix can itself belong to a DB filename; cover that interpretation too.
    return [base,base+'-wal',base+'-shm',c.path.path+'-wal',c.path.path+'-shm'];
  };
  return paths(a).some(x=>paths(b).some(y=>overlaps(x,y)));
}
