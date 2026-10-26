import {spawn as nativeSpawn,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {delimiter,isAbsolute,join} from 'node:path';
import {findCodex} from './codex.ts';
import {buildChildEnv} from './child-env.ts';
import type {NativeProbe,NativeProbeReport} from '../shared/capabilities.ts';
export type {NativeProbe,NativeProbeReport} from '../shared/capabilities.ts';

const numeric='(?:0|[1-9][0-9]*)',prerelease='(?:'+numeric+'|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION=numeric+'\\.'+numeric+'\\.'+numeric+'(?:-'+prerelease+'(?:\\.'+prerelease+')*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const versionOnly=new RegExp('^'+VERSION+'$');
const patterns={codex:new RegExp('^codex-cli ('+VERSION+')$'),claude:new RegExp('^(?:('+VERSION+') \\(Claude Code\\)|Claude Code ('+VERSION+'))$')};
const empty=(status:NativeProbe['status']):NativeProbe=>({status,version:null});
export interface NativeProbeDependencies {
  findCodex?:()=>string;path?:string;isFile?:(path:string)=>boolean;
  spawn?:(executable:string,args:string[],options:SpawnOptions)=>ChildProcess;
  env?:NodeJS.ProcessEnv;now?:()=>number;
}
function regularFile(path:string){try{return lstatSync(path).isFile();}catch{return false;}}

/** Dependency injection is for trusted server tests only. No lookup or execution
 * occurs until the returned function is explicitly called. Found versions do not
 * establish authentication, feature readiness, installation completeness or safety.
 */
export function createNativeVersionProbe(dependencies:NativeProbeDependencies={}){
  return async():Promise<NativeProbeReport>=>{
    const now=dependencies.now??Date.now,isFile=dependencies.isFile??regularFile;
    const checkedAt=new Date(now()).toISOString();
    let env:NodeJS.ProcessEnv;
    try{env=buildChildEnv(dependencies.env??process.env);}catch{return {checkedAt,codex:empty('failed'),claude:empty('failed')};}
    const launch=dependencies.spawn??((executable,args,options)=>nativeSpawn(executable,args,options));
    async function execute(kind:'codex'|'claude',path:string):Promise<NativeProbe>{
      try{if(!isAbsolute(path)||!path.toLowerCase().endsWith('.exe')||!isFile(path))return empty('failed');}catch{return empty('failed');}
      return await new Promise<NativeProbe>(resolve=>{
        let child:ChildProcess,done=false,timer:NodeJS.Timeout|undefined,total=0;
        const chunks:Buffer[]=[];
        const finish=(probe:NativeProbe)=>{if(done)return;done=true;if(timer)clearTimeout(timer);resolve(probe);};
        const stop=()=>{if(done)return;try{child.kill();}catch{/* No native error text is diagnostic data. */}finish(empty('failed'));};
        try{
          child=launch(path,['--version'],{env:{...env},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
          const collect=(chunk:Buffer,stdout:boolean)=>{
            if(done)return;
            try{const bytes=Buffer.from(chunk);total+=bytes.length;if(total>4096){stop();return;}if(stdout)chunks.push(bytes);}catch{stop();}
          };
          child.stdout?.on('data',chunk=>collect(chunk,true));child.stderr?.on('data',chunk=>collect(chunk,false));
          child.once('error',()=>finish(empty('failed')));
          child.once('close',code=>{
            if(code!==0){finish(empty('failed'));return;}
            const text=Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
            const match=patterns[kind].exec(text),version=match?.[1]??match?.[2];
            finish(version&&version.length<=80?{status:'found',version}:empty('unknown'));
          });
          timer=setTimeout(stop,3000);
        }catch{finish(empty('failed'));}
      });
    }
    async function codex():Promise<NativeProbe>{
      let path:string;
      try{path=(dependencies.findCodex??findCodex)();}
      catch(error){return empty(error instanceof Error&&error.message==='CODEX_NOT_INSTALLED'?'not_found_on_path':'failed');}
      return execute('codex',path);
    }
    async function claude():Promise<NativeProbe>{
      try{
        for(const directory of (dependencies.path??env.PATH??'').split(delimiter)){
          if(!isAbsolute(directory))continue;
          const path=join(directory,'claude.exe');if(isFile(path))return execute('claude',path);
        }
        return empty('not_found_on_path');
      }catch{return empty('failed');}
    }
    const [codexProbe,claudeProbe]=await Promise.all([codex(),claude()]);
    return {checkedAt,codex:codexProbe,claude:claudeProbe};
  };
}
export function probeNativeVersions():Promise<NativeProbeReport>{return createNativeVersionProbe()();}

/** GET is side-effect free; only an authorized explicit refresh may run a probe. */
export function createNativeProbeService(probe:()=>Promise<NativeProbeReport>=probeNativeVersions,now:()=>number=Date.now){
  let cached:NativeProbeReport|null=null,storedAt=0,pending:Promise<NativeProbeReport>|null=null;
  function snapshot(input:NativeProbeReport):NativeProbeReport{
    const clean=(value:NativeProbe):NativeProbe=>{
      if(value?.status==='found'&&typeof value.version==='string'&&value.version.length<=80&&versionOnly.test(value.version))return Object.freeze({status:'found',version:value.version});
      return Object.freeze(empty(['not_found_on_path','failed','unknown'].includes(value?.status)?value.status:'unknown'));
    };
    try{
      if(typeof input.checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.checkedAt)||!Number.isFinite(Date.parse(input.checkedAt)))throw new Error();
      return Object.freeze({checkedAt:input.checkedAt,codex:clean(input.codex),claude:clean(input.claude)});
    }catch{return Object.freeze({checkedAt:new Date(now()).toISOString(),codex:Object.freeze(empty('unknown')),claude:Object.freeze(empty('unknown'))});}
  }
  function get(){return cached&&now()-storedAt>=0&&now()-storedAt<60000?cached:null;}
  function refresh():Promise<NativeProbeReport>{
    if(pending)return pending;
    const existing=get();if(existing)return Promise.resolve(existing);
    let result:Promise<NativeProbeReport>;
    try{result=probe();}catch{result=Promise.reject(new Error('PROBE_FAILED'));}
    pending=result.catch(()=>({checkedAt:new Date(now()).toISOString(),codex:empty('unknown'),claude:empty('unknown')})).then(report=>{cached=snapshot(report);storedAt=now();return cached;}).finally(()=>{pending=null;});
    return pending;
  }
  return Object.freeze({get,refresh});
}
