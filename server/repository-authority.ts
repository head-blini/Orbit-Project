import {DatabaseSync} from 'node:sqlite';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {DirectoryIdentity,RepositoryIdentity,RepositoryResource} from '../shared/repository-authority.ts';
import {repositoryIdentity} from './repository-resource.ts';
import {canonical} from './projects.ts';
import {trustedGit} from './git-process.ts';

const applicationId=0x4f524254;
const directoryName='.orbit-authority-v1',databaseName='authority.sqlite';
class AuthorityError extends Error {}
function fail(code:string):never {throw new AuthorityError(code);}
const text=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0;
const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function fields(v:unknown,keys:string[]):v is Record<string,unknown>{
  if(!v||typeof v!=='object'||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length)return false;
  const descriptors=Object.getOwnPropertyDescriptors(v);return keys.every(key=>descriptors[key]&&'value' in descriptors[key]);
}
const dirIdentity=(path:string):DirectoryIdentity=>{const s=lstatSync(path,{bigint:true});return {device:String(s.dev),inode:String(s.ino),birthtimeNs:String(s.birthtimeNs)};};
const sameDirectory=(a:DirectoryIdentity,b:DirectoryIdentity)=>a.device===b.device&&a.inode===b.inode&&a.birthtimeNs===b.birthtimeNs;
const sameResource=(a:RepositoryResource,b:RepositoryResource)=>a.repositoryId===b.repositoryId&&a.commonGitDir===b.commonGitDir&&sameDirectory(a.directory,b.directory)&&a.worktreePath===b.worktreePath&&a.targetBranch===b.targetBranch&&a.baseRevision===b.baseRevision;
function resourceShape(value:unknown):value is RepositoryResource{
  if(!fields(value,['repositoryId','commonGitDir','directory','worktreePath','targetBranch','baseRevision'])||!fields(value.directory,['device','inode','birthtimeNs']))return false;
  return typeof value.repositoryId==='string'&&/^[a-f0-9]{64}$/.test(value.repositoryId)
    &&[value.commonGitDir,value.worktreePath,value.targetBranch].every(v=>typeof v==='string'&&v.length>0&&v.length<=2000&&!/[\x00-\x1f\x7f]/.test(v))
    &&typeof value.baseRevision==='string'&&/^[a-f0-9]{40,64}$/.test(value.baseRevision)
    &&Object.values(value.directory).every(v=>typeof v==='string'&&/^\d+$/.test(v));
}
export interface RepositoryClaimToken {repositoryId:string;claimId:string;ownerIncarnation:string;fencingGeneration:number}
interface Claim extends RepositoryClaimToken {state:'held'|'released';createdAt:string;updatedAt:string}
export interface RepositoryOperationInput {operationId:string;requestId:string;kind:string;resource:RepositoryResource}
export interface RepositoryOperation extends RepositoryOperationInput {fencingGeneration:number;revision:number;state:'intent'|'dispatched'|'quarantined'|'cancelled';createdAt:string;updatedAt:string}
interface Marker {format:'orbit-repository-authority';schemaVersion:1;authorityId:string;repositoryId:string}
export interface RepositoryAuthoritySnapshot {repositoryId:string;claim:Claim|null;operations:RepositoryOperation[];lastSequence:number}

/** Internal cooperative repository authority. Not an OS sandbox, account lock or
 * recovery collector. No dispatched-operation release exists until qualification
 * and trusted recovery evidence are integrated. Closing a handle never releases. */
export class RepositoryAuthority {
  private readonly db:DatabaseSync;
  private readonly identity:RepositoryIdentity;
  private readonly directory:string;private readonly path:string;
  private readonly markerText:string;private readonly directoryPin:DirectoryIdentity;private readonly filePin:DirectoryIdentity;
  private closed=false;
  private constructor(commonGitDir:string,readOnly=false){
    this.identity=repositoryIdentity(commonGitDir);this.directory=join(this.identity.commonGitDir,directoryName);this.path=join(this.directory,databaseName);
    this.checkFiles();this.markerText=readFileSync(join(this.directory,'identity.json'),'utf8');
    let marker:unknown;try{marker=JSON.parse(this.markerText);}catch{fail('AUTHORITY_INTEGRITY');}
    if(!fields(marker,['format','schemaVersion','authorityId','repositoryId'])||marker.format!=='orbit-repository-authority'||marker.schemaVersion!==1||!text(marker.authorityId)||marker.repositoryId!==this.identity.repositoryId)fail('AUTHORITY_INTEGRITY');
    this.directoryPin=dirIdentity(this.directory);this.filePin=dirIdentity(this.path);
    let db:DatabaseSync;try{db=new DatabaseSync(this.path,{readOnly});}catch{fail('AUTHORITY_UNAVAILABLE');}
    this.db=db;
    try{
      if(Number(db.prepare('PRAGMA application_id').get()?.application_id)!==applicationId||Number(db.prepare('PRAGMA user_version').get()?.user_version)!==1
        ||db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='delete'||db.prepare('SELECT body FROM authority_metadata WHERE id=1').get()?.body!==this.markerText)fail('AUTHORITY_INTEGRITY');
      db.exec('PRAGMA busy_timeout=0;');if(!readOnly)db.exec('PRAGMA synchronous=FULL;');this.checkPins();
    }catch(error){db.close();if(error instanceof AuthorityError)throw error;fail('AUTHORITY_INTEGRITY');}
  }
  static create(commonGitDir:string):RepositoryAuthority {
    const identity=repositoryIdentity(commonGitDir),directory=join(identity.commonGitDir,directoryName);
    if(existsSync(directory))return RepositoryAuthority.open(commonGitDir);
    try{mkdirSync(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return RepositoryAuthority.open(commonGitDir);return fail('AUTHORITY_UNAVAILABLE');}
    const marker:Marker={format:'orbit-repository-authority',schemaVersion:1,authorityId:randomUUID(),repositoryId:identity.repositoryId};
    const body=JSON.stringify(marker),path=join(directory,databaseName);let db:DatabaseSync|undefined;
    try{
      const fd=openSync(join(directory,'identity.json'),'wx',0o600);try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}
      closeSync(openSync(path,'wx',0o600));db=new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
        PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
        CREATE TABLE authority_metadata(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
        CREATE TABLE authority_claims(generation INTEGER PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE authority_operations(operation_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,generation INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE authority_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,generation INTEGER NOT NULL,operation_id TEXT,kind TEXT NOT NULL,at TEXT NOT NULL);`);
      db.prepare('INSERT INTO authority_metadata VALUES(1,?)').run(body);db.exec('COMMIT');db.close();db=undefined;
      return RepositoryAuthority.open(commonGitDir);
    }catch(error){if(db){try{db.exec('ROLLBACK');}catch{}db.close();}if(error instanceof AuthorityError)throw error;return fail('AUTHORITY_WRITE_FAILED');}
  }
  static open(commonGitDir:string){return new RepositoryAuthority(commonGitDir);}
  static inspect(commonGitDir:string):RepositoryAuthoritySnapshot|null {
    const identity=repositoryIdentity(commonGitDir);if(!existsSync(join(identity.commonGitDir,directoryName)))return null;
    const authority=new RepositoryAuthority(commonGitDir,true);try{return authority.snapshot();}finally{authority.close();}
  }
  private checkFiles(){
    try{
      if(canonical(this.directory)!==this.directory||!lstatSync(this.directory).isDirectory())throw new Error();
      const names=readdirSync(this.directory);
      if(!names.includes('identity.json')||!names.includes(databaseName)||names.some(name=>!['identity.json',databaseName,databaseName+'-journal'].includes(name)))throw new Error();
      for(const name of names){const s=lstatSync(join(this.directory,name));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error();}
      if(lstatSync(join(this.directory,'identity.json')).size>4096)throw new Error();
    }catch{return fail('AUTHORITY_INTEGRITY');}
  }
  private checkPins(){
    if(this.closed)fail('AUTHORITY_CLOSED');this.checkFiles();
    try{if(repositoryIdentity(this.identity.commonGitDir).repositoryId!==this.identity.repositoryId||!sameDirectory(this.directoryPin,dirIdentity(this.directory))||!sameDirectory(this.filePin,dirIdentity(this.path))||readFileSync(join(this.directory,'identity.json'),'utf8')!==this.markerText)fail('AUTHORITY_PATH_CHANGED');}
    catch(error){if(error instanceof AuthorityError)throw error;fail('AUTHORITY_PATH_CHANGED');}
  }
  private transaction<T>(write:boolean,action:()=>T):T {
    this.checkPins();let begun=false;
    try{this.db.exec(write?'BEGIN IMMEDIATE':'BEGIN');begun=true;const result=action();if(write)this.active();this.checkPins();this.db.exec('COMMIT');begun=false;this.checkPins();return result;}
    catch(error){if(begun)try{this.db.exec('ROLLBACK');}catch{}if(error instanceof AuthorityError)throw error;
      if((error as Error)?.message?.includes('locked'))return fail('AUTHORITY_BUSY');return fail(write?'AUTHORITY_WRITE_FAILED':'AUTHORITY_INTEGRITY');}
  }
  private claims():Claim[]{
    const rows=this.db.prepare('SELECT generation,body FROM authority_claims ORDER BY generation').all(),generations=new Set(rows.map(row=>row.generation));
    if(this.db.prepare('SELECT DISTINCT generation FROM authority_events WHERE operation_id IS NULL').all().some(row=>!generations.has(row.generation)))fail('AUTHORITY_INTEGRITY');
    return rows.map((row,index)=>{
      let c:unknown;try{c=JSON.parse(String(row.body));}catch{return fail('AUTHORITY_INTEGRITY');}
      if(!fields(c,['repositoryId','claimId','ownerIncarnation','fencingGeneration','state','createdAt','updatedAt'])||c.repositoryId!==this.identity.repositoryId||!text(c.claimId)||!text(c.ownerIncarnation)||!integer(c.fencingGeneration)||c.fencingGeneration!==row.generation||!['held','released'].includes(String(c.state))||!date(c.createdAt)||!date(c.updatedAt))fail('AUTHORITY_INTEGRITY');
      if(c.fencingGeneration!==index+1)fail('AUTHORITY_INTEGRITY');
      const event=this.db.prepare('SELECT kind FROM authority_events WHERE generation=? AND operation_id IS NULL ORDER BY seq DESC LIMIT 1').get(row.generation);
      if(event?.kind!==(c.state==='held'?'claim.acquired':'claim.released_before_dispatch'))fail('AUTHORITY_INTEGRITY');
      return c as unknown as Claim;
    });
  }
  private active(){const claims=this.claims(),held=claims.filter(c=>c.state==='held');if(held.length>1||(held.length===1&&held[0]!==claims.at(-1)))fail('AUTHORITY_INTEGRITY');this.operations(0);return held[0]??null;}
  private operations(generation:number):RepositoryOperation[]{
    const claims=new Map(this.claims().map(claim=>[claim.fencingGeneration,claim]));
    const rows=this.db.prepare('SELECT operation_id,request_id,generation,body FROM authority_operations ORDER BY rowid').all();
    const operationIds=new Set(rows.map(row=>row.operation_id));
    if(this.db.prepare('SELECT DISTINCT operation_id FROM authority_events WHERE operation_id IS NOT NULL').all().some(row=>!operationIds.has(row.operation_id)))fail('AUTHORITY_INTEGRITY');
    return rows.map(row=>{
      let o:unknown;try{o=JSON.parse(String(row.body));}catch{return fail('AUTHORITY_INTEGRITY');}
      if(!fields(o,['operationId','requestId','kind','resource','fencingGeneration','revision','state','createdAt','updatedAt'])||!text(o.operationId)||!text(o.requestId)||!text(o.kind)||!resourceShape(o.resource)||o.resource.repositoryId!==this.identity.repositoryId||o.operationId!==row.operation_id||o.requestId!==row.request_id||o.fencingGeneration!==row.generation||!integer(o.revision)||!['intent','dispatched','quarantined','cancelled'].includes(String(o.state))||!date(o.createdAt)||!date(o.updatedAt))fail('AUTHORITY_INTEGRITY');
      const claim=claims.get(Number(row.generation)),event=this.db.prepare('SELECT generation,kind FROM authority_events WHERE operation_id=? ORDER BY seq DESC LIMIT 1').get(row.operation_id);
      if(!claim||(claim.state==='released'&&o.state!=='cancelled')||event?.generation!==row.generation||event?.kind!=='operation.'+o.state
        ||o.resource.commonGitDir!==this.identity.commonGitDir||!sameDirectory(o.resource.directory,this.identity.directory))fail('AUTHORITY_INTEGRITY');
      return o as unknown as RepositoryOperation;
    }).filter(operation=>operation.fencingGeneration===generation);
  }
  private token(claim:Claim):RepositoryClaimToken {return {repositoryId:claim.repositoryId,claimId:claim.claimId,ownerIncarnation:claim.ownerIncarnation,fencingGeneration:claim.fencingGeneration};}
  private owned(token:RepositoryClaimToken){
    if(!fields(token,['repositoryId','claimId','ownerIncarnation','fencingGeneration'])||!text(token.repositoryId)||!text(token.claimId)||!text(token.ownerIncarnation)||!integer(token.fencingGeneration))fail('OWNERSHIP_STALE');
    const claim=this.active();if(!claim||Object.entries(this.token(claim)).some(([key,value])=>token[key as keyof RepositoryClaimToken]!==value))fail('OWNERSHIP_STALE');return claim;
  }
  private bodyWrite(sql:string,values:Array<string|number>,select:string,key:string|number,body:string){
    const verify=()=>{if(this.db.prepare(select).get(key)?.body!==body)fail('AUTHORITY_WRITE_FAILED');};
    if(Number(this.db.prepare(sql).run(...values).changes)!==1)fail('AUTHORITY_WRITE_FAILED');verify();return verify;
  }
  private audit(generation:number,operationId:string|null,kind:string){
    const at=new Date().toISOString(),result=this.db.prepare('INSERT INTO authority_events(generation,operation_id,kind,at) VALUES(?,?,?,?)').run(generation,operationId,kind,at);
    const saved=this.db.prepare('SELECT generation,operation_id,kind,at FROM authority_events WHERE seq=?').get(result.lastInsertRowid);
    if(Number(result.changes)!==1||saved?.generation!==generation||saved?.operation_id!==operationId||saved?.kind!==kind||saved?.at!==at)fail('AUTHORITY_WRITE_FAILED');
  }
  snapshot():RepositoryAuthoritySnapshot {return this.transaction(false,()=>{const claim=this.active();return {repositoryId:this.identity.repositoryId,claim,operations:claim?this.operations(claim.fencingGeneration):[],lastSequence:Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM authority_events').get()?.seq)};});}
  acquire(ownerIncarnation:string):RepositoryClaimToken {
    if(!text(ownerIncarnation))fail('INVALID_OWNER');return this.transaction(true,()=>{
      const existing=this.active();if(existing){if(existing.ownerIncarnation!==ownerIncarnation)fail('REPOSITORY_OWNED');return this.token(existing);}
      const generation=Number(this.db.prepare('SELECT COALESCE(MAX(generation),0) AS generation FROM authority_claims').get()?.generation)+1;if(!integer(generation))fail('AUTHORITY_INTEGRITY');
      const now=new Date().toISOString(),claim:Claim={repositoryId:this.identity.repositoryId,claimId:randomUUID(),ownerIncarnation,fencingGeneration:generation,state:'held',createdAt:now,updatedAt:now};
      const body=JSON.stringify(claim),verify=this.bodyWrite('INSERT INTO authority_claims VALUES(?,?)',[generation,body],'SELECT body FROM authority_claims WHERE generation=?',generation,body);this.audit(generation,null,'claim.acquired');verify();return this.token(claim);
    });
  }
  private validateResource(resource:RepositoryResource){
    if(!resourceShape(resource)||resource.repositoryId!==this.identity.repositoryId||resource.commonGitDir!==this.identity.commonGitDir||!sameDirectory(resource.directory,this.identity.directory))fail('RESOURCE_MISMATCH');
    try{
      if(canonical(resource.worktreePath)!==resource.worktreePath)throw new Error();
      const common=trustedGit(resource.worktreePath,['rev-parse','--path-format=absolute','--git-common-dir']).toString('utf8').trim();
      if(repositoryIdentity(common).repositoryId!==this.identity.repositoryId||trustedGit(resource.worktreePath,['branch','--show-current']).toString('utf8').trim()!==resource.targetBranch||trustedGit(resource.worktreePath,['rev-parse','HEAD']).toString('utf8').trim()!==resource.baseRevision)throw new Error();
    }catch{return fail('RESOURCE_MISMATCH');}
  }
  begin(token:RepositoryClaimToken,input:RepositoryOperationInput):RepositoryOperation {
    if(!fields(input,['operationId','requestId','kind','resource'])||!text(input.operationId)||!text(input.requestId)||!text(input.kind)||!resourceShape(input.resource))fail('INVALID_OPERATION');
    return this.transaction(true,()=>{
      const claim=this.owned(token);this.validateResource(input.resource);const operations=this.operations(claim.fencingGeneration),prior=operations.find(o=>o.operationId===input.operationId||o.requestId===input.requestId);
      if(prior){if(prior.operationId!==input.operationId||prior.requestId!==input.requestId||prior.kind!==input.kind||!sameResource(prior.resource,input.resource))fail('REQUEST_CONFLICT');return prior;}
      if(operations.some(o=>o.state!=='cancelled'))fail('OPERATIONS_UNRESOLVED');
      if(this.db.prepare('SELECT 1 FROM authority_operations WHERE operation_id=? OR request_id=?').get(input.operationId,input.requestId))fail('REQUEST_CONFLICT');
      const now=new Date().toISOString(),operation:RepositoryOperation={...structuredClone(input),fencingGeneration:claim.fencingGeneration,revision:1,state:'intent',createdAt:now,updatedAt:now};
      const body=JSON.stringify(operation),verify=this.bodyWrite('INSERT INTO authority_operations VALUES(?,?,?,?)',[operation.operationId,operation.requestId,claim.fencingGeneration,body],'SELECT body FROM authority_operations WHERE operation_id=?',operation.operationId,body);this.audit(claim.fencingGeneration,operation.operationId,'operation.intent');verify();return operation;
    });
  }
  private transition(token:RepositoryClaimToken,id:string,revision:number,state:'dispatched'|'quarantined'|'cancelled'){
    if(!text(id)||!integer(revision))fail('INVALID_OPERATION');return this.transaction(true,()=>{
      const claim=this.owned(token),operation=this.operations(claim.fencingGeneration).find(o=>o.operationId===id);if(!operation)fail('OPERATION_NOT_FOUND');if(operation.revision!==revision)fail('REVISION_MISMATCH');
      if(state==='cancelled'&&operation.state!=='intent')fail('ALREADY_DISPATCHED');
      if(state==='dispatched'){if(operation.state!=='intent')fail('INVALID_TRANSITION');this.validateResource(operation.resource);}
      if(state==='quarantined'&&operation.state!=='dispatched'&&operation.state!=='intent')fail('INVALID_TRANSITION');
      if(!integer(revision+1))fail('AUTHORITY_INTEGRITY');const next={...operation,state,revision:revision+1,updatedAt:new Date().toISOString()};
      const body=JSON.stringify(next),verify=this.bodyWrite('UPDATE authority_operations SET body=? WHERE operation_id=?',[body,id],'SELECT body FROM authority_operations WHERE operation_id=?',id,body);this.audit(claim.fencingGeneration,id,'operation.'+state);verify();return next;
    });
  }
  dispatch(token:RepositoryClaimToken,id:string,revision:number){return this.transition(token,id,revision,'dispatched');}
  quarantine(token:RepositoryClaimToken,id:string,revision:number){return this.transition(token,id,revision,'quarantined');}
  cancelIntent(token:RepositoryClaimToken,id:string,revision:number){return this.transition(token,id,revision,'cancelled');}
  relinquishUnstarted(token:RepositoryClaimToken):void {
    this.transaction(true,()=>{const claim=this.owned(token);if(this.operations(claim.fencingGeneration).some(o=>o.state!=='cancelled'))fail('OPERATIONS_UNRESOLVED');
      const body=JSON.stringify({...claim,state:'released',updatedAt:new Date().toISOString()}),verify=this.bodyWrite('UPDATE authority_claims SET body=? WHERE generation=?',[body,claim.fencingGeneration],'SELECT body FROM authority_claims WHERE generation=?',claim.fencingGeneration,body);this.audit(claim.fencingGeneration,null,'claim.released_before_dispatch');verify();});
  }
  close(){if(this.closed)return;this.closed=true;this.db.close();}
}
