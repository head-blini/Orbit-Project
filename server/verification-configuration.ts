import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import type {VerificationCommandPreview} from '../shared/verification.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {validateVerificationCommand,type VerificationCommand} from './verification.ts';
import {protectedFilePaths} from './acceptance.ts';

export interface VerificationConfiguration extends VerificationCommand {projectPath:string;protectedFiles?:string[]}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Credential-bearing CLI options must be rejected as a pair, even when the
// value alone has no recognizable secret format. This is finite pattern defense.
const credentialArguments=(args:readonly string[])=>args.some(arg=>containsCredential(arg)
  ||/^(?:--?|\/)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|token|password|passwd|client[-_]?secret|secret|credentials?|authorization|cookie|private[-_]?key|aws[-_]secret[-_]access[-_]key)(?:$|[=:])/i.test(arg)
  ||/^(?:proxy-)?authorization\s*:|^set-cookie\s*:/i.test(arg));
const pathKey=(value:string)=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
export function verificationCommandPreviews(configuration:readonly VerificationConfiguration[],projectPath:string):VerificationCommandPreview[]{
  return configuration.filter(command=>pathKey(command.projectPath)===pathKey(projectPath)).map(({projectPath:_,...command})=>{
    if(credentialArguments(command.args))throw new AppError('INVALID_VERIFICATION_CONFIGURATION',503);
    return {...command,args:[...command.args],...(command.protectedFiles?{protectedFiles:[...command.protectedFiles]}:{}),configDigest:hash({policy:'orbit-local-check-v1',projectPath:pathKey(projectPath),...command})};
  });
}
function exact(value:object,keys:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new AppError('INVALID_FIELDS',400);
}
export function readVerificationConfiguration(raw:string|undefined):VerificationConfiguration[]{
  if(raw===undefined)return [];
  try{
    if(raw.length>64000)throw new Error();
    const values:unknown=JSON.parse(raw);if(!Array.isArray(values)||values.length>32)throw new Error();
    const seen=new Set<string>();
    return Object.freeze(values.map(value=>{
      exact(value,['projectPath','id','label','executable','args','timeoutMs',...(value&&Object.hasOwn(value,'protectedFiles')?['protectedFiles']:[])]);
      if(typeof value.projectPath!=='string'||value.projectPath.length>2000||!isAbsolute(value.projectPath)||containsCredential(value.projectPath)||/[\x00-\x1f]/.test(value.projectPath))throw new Error();
      const {projectPath,protectedFiles,...input}=value,command=validateVerificationCommand(input);
      const files=protectedFiles===undefined?undefined:protectedFilePaths(protectedFiles);
      if(containsCredential(command.executable)||credentialArguments(command.args))throw new Error();
      const key=pathKey(projectPath)+'\0'+command.id;if(seen.has(key))throw new Error();seen.add(key);
      return Object.freeze({...command,projectPath:resolve(projectPath),...(files?{protectedFiles:Object.freeze(files) as unknown as string[]}: {})});
    })) as unknown as VerificationConfiguration[];
  }catch{throw new Error('INVALID_VERIFICATION_CONFIGURATION');}
}

export type VerificationCommandResolver=(projectPath:string)=>VerificationCommandPreview[];
export type VerificationConfigurationSource=readonly VerificationConfiguration[]|VerificationCommandResolver;
/** Server-owned resolvers only; HTTP never accepts a function or raw command. */
export function resolveVerificationCommands(source:VerificationConfigurationSource):VerificationCommandResolver {
  if(typeof source==='function')return source;
  const configuration=readVerificationConfiguration(JSON.stringify(source));
  return path=>verificationCommandPreviews(configuration,path);
}
