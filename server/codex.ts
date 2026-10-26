import { realpathSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { Rpc } from './rpc.ts';
import { resolveNativeExecutable } from './native-executable.ts';

export function findCodex(options:{env?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;arch?:string}={}):string {
  const env=options.env??process.env,platform=options.platform??process.platform,arch=options.arch??process.arch;
  const fail=():never=>{throw new Error('CODEX_NOT_INSTALLED');};
  if(!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))return fail();
  if(env.AICC_CODEX_BIN!==undefined)return resolveNativeExecutable(env.AICC_CODEX_BIN,platform)??fail();
  const triple=(arch==='arm64'?'aarch64':'x86_64')+(platform==='win32'?'-pc-windows-msvc':platform==='darwin'?'-apple-darwin':'-unknown-linux-musl');
  const name=platform==='win32'?'codex.exe':'codex',packageName=`codex-${platform}-${arch}`;
  for(const directory of (env.PATH??'').split(platform==='win32'?';':':').filter(isAbsolute)){
    const entry=join(directory,name),native=resolveNativeExecutable(entry,platform);if(native)return native;
    const roots=new Set([join(directory,'node_modules','@openai','codex'),join(dirname(directory),'lib','node_modules','@openai','codex')]);
    // npm's POSIX entrypoint is a symlink to @openai/codex/bin/codex.js.
    // Inspect only the link's location; do not evaluate the wrapper or package metadata.
    try{
      const target=realpathSync(entry),root=dirname(dirname(target));
      if(basename(target)==='codex.js'&&basename(dirname(target))==='bin'&&basename(root)==='codex'&&basename(dirname(root))==='@openai')roots.add(root);
    }catch{/* Not a resolvable npm entrypoint. */}
    for(const root of roots){
      const packages=[join(root,'node_modules','@openai',packageName),join(dirname(root),packageName),root];
      for(const pkg of packages){const found=resolveNativeExecutable(join(pkg,'vendor',triple,'bin',name),platform);if(found)return found;}
    }
  }
  return fail();
}
export const restrictedArgs=['app-server','--listen','stdio://','-c','web_search="disabled"','-c','model_provider="openai"',
  ...['apps','plugins','hooks','goals','browser_use','browser_use_external','computer_use','multi_agent','image_generation','shell_tool','shell_snapshot','view_image','code_mode','code_mode_host','skill_search','skill_mcp_dependency_install'].flatMap(f=>['--disable',f])];
export function codexArgs(write=false){return write?restrictedArgs.flatMap((arg,i)=>arg==='--disable'&&restrictedArgs[i+1]==='code_mode_host'?['--enable']:[arg]):[...restrictedArgs];}
export function codexFactory(workspace:string,write=false){return ()=>new Rpc(findCodex(),codexArgs(write),workspace);}
