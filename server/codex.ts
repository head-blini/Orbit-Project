import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { Rpc } from './rpc.ts';

export function findCodex():string {
  if(process.env.AICC_CODEX_BIN){if(existsSync(process.env.AICC_CODEX_BIN)&&process.env.AICC_CODEX_BIN.endsWith('.exe'))return process.env.AICC_CODEX_BIN;throw new Error('CODEX_NOT_INSTALLED');}
  const paths=(process.env.PATH??'').split(delimiter);
  const triple=process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
  for(const p of paths){
    const native=join(p,'codex.exe');if(existsSync(native))return native;
    const root=join(p,'node_modules','@openai','codex');
    const nested=join(root,'node_modules','@openai',`codex-win32-${process.arch}`,'vendor',triple,'bin','codex.exe');
    const sibling=join(dirname(root),`codex-win32-${process.arch}`,'vendor',triple,'bin','codex.exe');
    for(const path of [nested,sibling])if(existsSync(path))return path;
  }
  throw new Error('CODEX_NOT_INSTALLED');
}
export const restrictedArgs=['app-server','--listen','stdio://','-c','web_search="disabled"','-c','model_provider="openai"',
  ...['apps','plugins','hooks','browser_use','browser_use_external','computer_use','multi_agent','image_generation','shell_tool','shell_snapshot','view_image','code_mode','code_mode_host','skill_search','skill_mcp_dependency_install'].flatMap(f=>['--disable',f])];
export function codexFactory(workspace:string){return ()=>new Rpc(findCodex(),restrictedArgs,workspace);}
