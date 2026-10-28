import {useSyncExternalStore} from 'react';

/**
 * Simple/advanced presentation mode. It only changes how much is shown: every page,
 * project, run, approval and security policy is the same in both modes.
 */
export type UiMode='simple'|'advanced';
export const advancedMenuKey='orbit.nav.advanced';
const listeners=new Set<()=>void>();
let memory:UiMode|null=null;
export function getUiMode():UiMode{
  try{const stored=globalThis.localStorage?.getItem(advancedMenuKey);if(stored==='1')return 'advanced';if(stored==='0')return 'simple';}catch{/* Fall back to memory. */}
  return memory??'simple';
}
export function setUiMode(mode:UiMode){
  memory=mode;try{globalThis.localStorage?.setItem(advancedMenuKey,mode==='advanced'?'1':'0');}catch{/* In-memory only. */}
  for(const listener of listeners)listener();
}
export function subscribeUiMode(listener:()=>void){
  listeners.add(listener);
  const storage=(event:StorageEvent)=>{if(event.key===advancedMenuKey)listener();};
  globalThis.addEventListener?.('storage',storage);
  return()=>{listeners.delete(listener);globalThis.removeEventListener?.('storage',storage);};
}
export function useUiMode():UiMode{return useSyncExternalStore(subscribeUiMode,getUiMode,getUiMode);}
