import {createHash,randomBytes} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,type Stats} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import type {PlanningVersion} from '../shared/parallel.ts';
import type {ReuseEvidence,ReuseEvidenceEntry,ReuseVendorDecision,ReuseVendorFile,ReuseVendorResult} from '../shared/reuse-vendor.ts';
import {AppError} from './errors.ts';
import {kstIso} from './reuse-discovery.ts';

const NAME=/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,SEMVER=/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ADOPT=/^재사용 채택: (\S+) (\S+) \((.+)\) · (https:\/\/\S+) · 확인 (\S+)$/;
const ENTRY=/^(?:\.\/)?([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.(m?js|css))$/;
const TYPES={json:/^application\/json\b/i,js:/^(?:application|text)\/(?:javascript|ecmascript)\b/i,mjs:/^(?:application|text)\/(?:javascript|ecmascript)\b/i,css:/^text\/css\b/i,license:/^text\/(?:plain|markdown)\b/i};
export const REUSE_VENDOR_LIMITS={fileBytes:2*1024*1024,totalBytes:4*1024*1024,timeoutMs:15000};
const fail=(code:string,status:number):never=>{throw new AppError(code,status);};
const lstat=(path:string):Stats|null=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
const evidencePath=(root:string)=>join(root,'vendor','REUSE-EVIDENCE.json');
// '@' and '/' would not survive the app preview's exact path encoding; scoped names never start with '_' unscoped.
const dirName=(name:string,version:string)=>name.replace(/^@/,'_').replace('/','__')+'-'+version;

/** Only adopt decisions inside a project's current approved planning heads; the browser never supplies name/version/url. */
export function approvedReuseDecisions(versions:readonly PlanningVersion[],head:(lineageId:string)=>string|undefined):ReuseVendorDecision[]{
  return versions.filter(v=>v.state==='approved'&&head(v.lineageId??v.id)===v.id)
    .flatMap(v=>(v.draft.decisions??[]).filter(d=>d.decision.startsWith('재사용 채택: ')).map(d=>({planningVersionId:v.id,topic:d.topic,decision:d.decision})));
}

export function readReuseEvidence(workspacePath:string):ReuseEvidence{
  const path=evidencePath(realpathSync(workspacePath)),dir=lstat(join(realpathSync(workspacePath),'vendor')),stat=lstat(path);
  if(!stat&&(!dir||dir.isDirectory()))return {entries:[]};
  if(!dir?.isDirectory()||!stat?.isFile()||stat.nlink!==1||stat.size>1024*1024)return fail('REUSE_VENDOR_EVIDENCE_INVALID',409);
  try{const value=JSON.parse(readFileSync(path,'utf8'));if(!value||!Array.isArray(value.entries))throw new Error();return value as ReuseEvidence;}
  catch{return fail('REUSE_VENDOR_EVIDENCE_INVALID',409);}
}

async function capped(response:Response,max:number):Promise<Buffer>{
  if(Number(response.headers.get('content-length')??0)>max){await response.body?.cancel().catch(()=>{});fail('REUSE_VENDOR_TOO_LARGE',413);}
  const chunks:Buffer[]=[];let size=0;const reader=response.body?.getReader();
  if(!reader)return Buffer.alloc(0);
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel().catch(()=>{});fail('REUSE_VENDOR_TOO_LARGE',413);}chunks.push(Buffer.from(value));}
  return Buffer.concat(chunks);
}

/**
 * Copies one approved adopt decision's npm entry file (+LICENSE) from jsDelivr into <workspace>/vendor.
 * The caller guards workspace identity/idle; beforeWrite re-runs those guards right before the synchronous writes.
 */
export async function vendorReuse(input:{workspacePath:string;approved:readonly ReuseVendorDecision[];planningVersionId:string;topic:string;fetch?:typeof fetch;now?:()=>Date;beforeWrite?:()=>void}):Promise<ReuseVendorResult>{
  const decision=input.approved.find(d=>d.planningVersionId===input.planningVersionId&&d.topic===input.topic);
  if(!decision)return fail('REUSE_VENDOR_DECISION_NOT_APPROVED',404);
  const match=ADOPT.exec(decision.decision);
  if(!match||match[1].length>214||!NAME.test(match[1])||!SEMVER.test(match[2])||decision.topic!==`재사용: ${match[1]}`)return fail('REUSE_VENDOR_UNSUPPORTED',422);
  const [,name,version,license,sourceUrl]=match,base=`https://cdn.jsdelivr.net/npm/${name}@${version}/`,get=input.fetch??fetch;
  let total=0;
  const download=async(path:string,type:RegExp,counted:boolean,optional=false)=>{
    const url=base+path;let response:Response;
    try{response=await get(url,{redirect:'error',signal:AbortSignal.timeout(REUSE_VENDOR_LIMITS.timeoutMs)});}catch{return fail('REUSE_VENDOR_FETCH_FAILED',502);}
    if(response.redirected||response.url&&response.url!==url){await response.body?.cancel().catch(()=>{});return fail('REUSE_VENDOR_REDIRECT',502);}
    if(optional&&response.status===404){await response.body?.cancel().catch(()=>{});return null;}
    if(response.status!==200){await response.body?.cancel().catch(()=>{});return fail('REUSE_VENDOR_FETCH_FAILED',502);}
    if(!type.test(response.headers.get('content-type')??'')){await response.body?.cancel().catch(()=>{});return fail('REUSE_VENDOR_CONTENT_TYPE',502);}
    let bytes:Buffer;
    try{bytes=await capped(response,counted?Math.min(REUSE_VENDOR_LIMITS.fileBytes,REUSE_VENDOR_LIMITS.totalBytes-total):REUSE_VENDOR_LIMITS.fileBytes);}
    catch(error){return error instanceof AppError?fail(error.message,error.status):fail('REUSE_VENDOR_FETCH_FAILED',502);}
    if(counted)total+=bytes.byteLength;return {url,bytes};
  };
  const manifest=(await download('package.json',TYPES.json,false))!;
  let pkg:Record<string,unknown>;
  try{pkg=JSON.parse(manifest.bytes.toString('utf8'));if(!pkg||typeof pkg!=='object'||Array.isArray(pkg))throw new Error();}catch{return fail('REUSE_VENDOR_PACKAGE_INVALID',502);}
  if(pkg.name!==name||pkg.version!==version)return fail('REUSE_VENDOR_PACKAGE_INVALID',502);
  const entry=['jsdelivr','browser','unpkg','style','main'].map(key=>pkg[key]).map(value=>typeof value==='string'?ENTRY.exec(value):null).find(Boolean);
  if(!entry)return fail('REUSE_VENDOR_NO_ENTRY',422);
  const main=(await download(entry[1],TYPES[entry[2] as 'js'|'mjs'|'css'],true))!;
  let licenseFile:{file:string;url:string;bytes:Buffer}|null=null;
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt']){const found=await download(file,TYPES.license,true,true);if(found){licenseFile={file,...found};break;}}
  const files=[{file:entry[1].split('/').at(-1)!,...main},...(licenseFile?[licenseFile]:[])];

  input.beforeWrite?.();
  const root=realpathSync(input.workspacePath),vendor=join(root,'vendor'),folder=dirName(name,version),dir=join(vendor,folder);
  const inside=(path:string)=>{const rel=relative(root,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('REUSE_VENDOR_PATH_REJECTED',409);return path;};
  for(const path of [vendor,dir]){const stat=lstat(inside(path));if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))fail('REUSE_VENDOR_PATH_REJECTED',409);}
  const evidence=readReuseEvidence(root);
  if(evidence.entries.some(e=>e.name!==name&&dirName(e.name,e.version)===folder))fail('REUSE_VENDOR_CONFLICT',409);
  const targets=files.map(f=>({...f,path:inside(join(dir,f.file)),stat:lstat(join(dir,f.file))}));
  for(const t of targets)if(t.stat&&(t.stat.isSymbolicLink()||!t.stat.isFile()||t.stat.nlink!==1||!readFileSync(t.path).equals(t.bytes)))fail(t.stat.isSymbolicLink()?'REUSE_VENDOR_PATH_REJECTED':'REUSE_VENDOR_CONFLICT',409);
  mkdirSync(vendor,{recursive:true});mkdirSync(dir,{recursive:true});let written=0;
  for(const t of targets)if(!t.stat){writeFileSync(t.path,t.bytes,{flag:'wx'});written++;}
  const relativePath=(file:string)=>`vendor/${folder}/${file}`;
  const record:ReuseEvidenceEntry={name,version,license:{decision:license,package:typeof pkg.license==='string'?pkg.license.replace(/[\x00-\x1f\x7f]/g,'').slice(0,100):null},
    sourceDecision:decision.topic,sourceUrl,files:targets.map(t=>({path:relativePath(t.file),url:t.url,sha256:createHash('sha256').update(t.bytes).digest('hex'),bytes:t.bytes.byteLength}) satisfies ReuseVendorFile),
    licenseFile:licenseFile?relativePath(licenseFile.file):'license_file:absent',checkedAt:kstIso((input.now??(()=>new Date()))()),planningVersionId:decision.planningVersionId};
  const next={...evidence,entries:[...evidence.entries.filter(e=>!(e.name===name&&e.version===version)),record]};
  // Replace via rename so an existing link at the evidence path is never followed.
  const temp=join(vendor,`.REUSE-EVIDENCE.${randomBytes(6).toString('hex')}.tmp`);
  try{writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx'});renameSync(temp,evidencePath(root));}finally{rmSync(temp,{force:true});}
  return {status:written?'vendored':'unchanged',entry:record};
}
