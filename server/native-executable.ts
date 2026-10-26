import {accessSync,closeSync,constants,fstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';

/** Resolve symlinks used by package managers, but never launch a script wrapper.
 * A native header identifies a file format, not publisher trust or feature support.
 */
export function resolveNativeExecutable(path:string,platform:NodeJS.Platform=process.platform):string|null {
  if(!isAbsolute(path)||!['win32','darwin','linux'].includes(platform))return null;
  if(platform==='win32'&&!path.toLowerCase().endsWith('.exe'))return null;
  let fd:number|undefined;
  try{
    const canonical=realpathSync(path);
    if(platform!=='win32')accessSync(canonical,constants.X_OK);
    fd=openSync(canonical,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW|constants.O_NONBLOCK));
    if(!fstatSync(fd).isFile())return null;
    const header=Buffer.alloc(4);if(readSync(fd,header,0,4,0)!==4)return null;
    const magic=header.toString('hex');
    const native=platform==='win32'?magic.startsWith('4d5a'):platform==='linux'?magic==='7f454c46':
      ['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic);
    return native?canonical:null;
  }catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
}
