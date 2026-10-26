import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,realpathSync} from 'node:fs';
import {delimiter,dirname,isAbsolute,join,resolve} from 'node:path';
import {buildChildEnv} from './child-env.ts';
import {AppError} from './errors.ts';

// Resolve once from absolute server PATH entries; never search the project cwd.
const binary=(process.env.PATH??'').split(delimiter).filter(isAbsolute).map(path=>join(path,process.platform==='win32'?'git.exe':'git')).find(path=>existsSync(path)&&lstatSync(path).isFile());
export interface TrustedGitOptions {input?:Uint8Array;indexFile?:string;identity?:boolean;allowDiffExit?:boolean;maxBytes?:number}
const safePath=(path:string)=>typeof path==='string'&&isAbsolute(path)&&!/[\x00-\x1f\x7f]/.test(path)&&!path.split(/[\\/]/).some(part=>part==='.'||part==='..');
function indexPath(path:string){
  if(!safePath(path)||path.split(/[\\/]/).some(part=>part.toLowerCase()==='.git'))throw new Error();
  let start=path;try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;start=dirname(path);}
  for(let current=start;;current=dirname(current)){
    const stat=lstatSync(current);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||(stat.isFile()&&stat.nlink!==1))throw new Error();
    if(dirname(current)===current)break;
  }
  if(resolve(realpathSync(dirname(path)))!==resolve(dirname(path)))throw new Error();
}

/** Internal server commands only. Callers own the operation/path/ref allowlist.
 * Raw bytes never enter errors, logs or a recorder; no shell/global config/hooks.
 */
export function trustedGit(cwd:string,args:string[],options:TrustedGitOptions={}):Buffer {
  if(!binary)throw new AppError('GIT_NOT_INSTALLED',503);
  try{
    if(!safePath(cwd)||!Array.isArray(args)||!args.length||args.length>128||args.some(arg=>typeof arg!=='string'||arg.length>4096||arg.includes('\0'))||args.join('').length>64000||! /^[a-z][a-z-]+$/.test(args[0]))throw new Error();
    if(!options||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new Error();
    const fields=Object.getOwnPropertyDescriptors(options);
    if(Reflect.ownKeys(options).some(key=>typeof key!=='string'||!['input','indexFile','identity','allowDiffExit','maxBytes'].includes(key))||Object.values(fields).some(field=>!('value' in field)))throw new Error();
    const maxBytes=options.maxBytes===undefined?2*1024*1024:options.maxBytes;
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1024*1024||(maxBytes>2*1024*1024&&(args[0]!=='cat-file'||args[1]!=='blob'))
      ||(options.identity!==undefined&&typeof options.identity!=='boolean')||(options.allowDiffExit!==undefined&&typeof options.allowDiffExit!=='boolean'))throw new Error();
    let input:Buffer|undefined;
    if(options.input!==undefined){const bytes=Uint8Array.prototype.slice.call(options.input) as Uint8Array;if(bytes.byteLength>4*1024*1024)throw new Error();input=Buffer.from(bytes);}
    if(options.indexFile!==undefined)indexPath(options.indexFile);
    const env=buildChildEnv();for(const name of Object.keys(env))if(/^GIT_/i.test(name))delete env[name];
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_ATTR_NOSYSTEM:'1',
      GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ALLOW_PROTOCOL:''});
    if(options.indexFile)env.GIT_INDEX_FILE=options.indexFile;
    if(options.identity)Object.assign(env,{GIT_AUTHOR_NAME:'Orbit Local',GIT_AUTHOR_EMAIL:'orbit@localhost',GIT_COMMITTER_NAME:'Orbit Local',GIT_COMMITTER_EMAIL:'orbit@localhost'});
    const prefix=['--no-pager',...(args[0]==='check-ignore'?[]:['--literal-pathspecs']),'-c','protocol.allow=never','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
      '-c','submodule.recurse=false','-c','core.protectNTFS=true','-c','core.attributesFile=/dev/null','-c','core.excludesFile=/dev/null','-c','core.autocrlf=false','-c','core.untrackedCache=false','-c','core.splitIndex=false',
      '-c','gc.auto=0','-c','maintenance.auto=false','-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','merge.verifySignatures=false','-c','merge.autoStash=false'];
    try{return execFileSync(binary,[...prefix,...args],{cwd,env,input,encoding:'buffer',windowsHide:true,shell:false,timeout:15000,maxBuffer:maxBytes,stdio:['pipe','pipe','pipe']});}
    catch(error){const result=error as {status?:number;stdout?:Buffer;stderr?:Buffer;signal?:string;code?:string};
      if(options.allowDiffExit&&result.status===1&&!result.signal&&!result.code&&Buffer.isBuffer(result.stdout)&&result.stdout.length<=maxBytes&&Buffer.isBuffer(result.stderr)&&result.stderr.length<=maxBytes)return result.stdout;
      throw new Error();
    }
  }catch{throw new AppError('GIT_OPERATION_FAILED');}
}
