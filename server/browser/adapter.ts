import {safeText} from '../privacy.ts';

/**
 * BrowserAdapter boundary. Orbit does not depend on a specific Chrome extension:
 * agent-browser is the candidate for AI browsing tasks, Playwright for product UI/E2E.
 * Nothing here installs, downloads or launches a browser; drivers attach later
 * only after a probe and an explicit per-project allowance.
 */
export type BrowserAdapterId='agent-browser'|'playwright';
export type Capability='unknown'|'supported'|'unsupported';
export interface BrowserProbe {
  id:BrowserAdapterId;purpose:'ai_browsing'|'ui_e2e';status:'not_installed'|'installed'|'error';
  version:string|null;verified:false;
  capabilities:{navigate:Capability;snapshot:Capability;input:Capability;interrupt:Capability;isolatedProfile:Capability};
}
export interface BrowserAdapter {
  readonly id:BrowserAdapterId;
  probe():Promise<BrowserProbe>;
}

// Automated input or reply extraction on these services stays blocked until their
// terms and an official integration path are confirmed. Manual handoff remains available.
const reviewRequired=['chatgpt.com','chat.openai.com'];
const loopback=new Set(['127.0.0.1','localhost','[::1]']);

export type TargetDecision={allowed:true}|{allowed:false;code:'POLICY_REVIEW_REQUIRED'|'ORIGIN_APPROVAL_REQUIRED'|'UNSUPPORTED_URL'};
export function browserTargetPolicy(raw:string,options:{allowedOrigins?:readonly string[]}):TargetDecision{
  let url:URL;try{url=new URL(raw);}catch{return {allowed:false,code:'UNSUPPORTED_URL'};}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return {allowed:false,code:'UNSUPPORTED_URL'};
  const host=url.hostname.toLowerCase();
  if(reviewRequired.some(domain=>host===domain||host.endsWith('.'+domain)))return {allowed:false,code:'POLICY_REVIEW_REQUIRED'};
  if(loopback.has(host))return {allowed:true};
  return (options.allowedOrigins??[]).some(origin=>{try{return new URL(origin).origin===url.origin;}catch{return false;}})?{allowed:true}:{allowed:false,code:'ORIGIN_APPROVAL_REQUIRED'};
}

export type BrowserEvent=
  |{kind:'started'}|{kind:'navigated';origin:string;path:string}|{kind:'action';action:'click'|'type'|'snapshot'|'wait'}
  |{kind:'error';code:string}|{kind:'interrupt_requested'}|{kind:'closed';observed:boolean};

/** Projects a driver event to fields safe for events, logs and artifacts. Unknown kinds are dropped. */
export function sanitizeBrowserEvent(raw:Record<string,unknown>):BrowserEvent|null{
  switch(raw.kind){
    case 'started':case 'interrupt_requested':return {kind:raw.kind};
    case 'closed':return {kind:'closed',observed:raw.observed===true};
    case 'navigated':{
      try{const url=new URL(String(raw.url));if(!['http:','https:'].includes(url.protocol))return null;
        return {kind:'navigated',origin:url.origin,path:safeText(url.pathname).slice(0,200)};}catch{return null;}
    }
    case 'action':return ['click','type','snapshot','wait'].includes(String(raw.action))?{kind:'action',action:raw.action as 'click'}:null;
    case 'error':return {kind:'error',code:typeof raw.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(raw.code)?raw.code:'UNKNOWN'};
  }
  return null;
}

export interface BrowserSessionView {
  id:string;adapter:BrowserAdapterId;state:'running'|'interrupt_requested'|'closed'|'error';
  error:string|null;lastObservedAt:string|null;lastLocation:{origin:string;path:string}|null;events:number;
}
/** Per-session state for the progress board. Only observed events move the state. */
export class BrowserSessionLog {
  private state:BrowserSessionView;
  constructor(id:string,adapter:BrowserAdapterId){this.state={id,adapter,state:'running',error:null,lastObservedAt:null,lastLocation:null,events:0};}
  record(raw:Record<string,unknown>,at=new Date().toISOString()){
    const event=sanitizeBrowserEvent(raw);if(!event)return;
    const s=this.state;s.events++;s.lastObservedAt=at;
    if(s.state==='closed'||s.state==='error')return;
    if(event.kind==='navigated')s.lastLocation={origin:event.origin,path:event.path};
    if(event.kind==='error'){s.state='error';s.error=event.code;}
    if(event.kind==='interrupt_requested')s.state='interrupt_requested';
    if(event.kind==='closed'&&event.observed)s.state='closed';
  }
  view():BrowserSessionView{return structuredClone(this.state);}
}

export interface ProbeDependencies {
  findExecutable(name:string):string|null;
  run(path:string,args:string[]):Promise<{code:number|null;stdout:string}>;
  resolvePackage(name:string):string|null;
  readVersion?(packageJson:string):string|null;
}
const unknownCapabilities=()=>({navigate:'unknown',snapshot:'unknown',input:'unknown',interrupt:'unknown',isolatedProfile:'unknown'} as const);
const version=(text:string)=>/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text)?.[1]??null;

export async function probeBrowserAdapters(deps:ProbeDependencies):Promise<BrowserProbe[]>{
  const base=(id:BrowserAdapterId,purpose:BrowserProbe['purpose']):BrowserProbe=>({id,purpose,status:'not_installed',version:null,verified:false,capabilities:{...unknownCapabilities()}});
  const agent=base('agent-browser','ai_browsing'),playwright=base('playwright','ui_e2e');
  const path=deps.findExecutable('agent-browser');
  if(path){
    try{const out=await deps.run(path,['--version']);const v=out.code===0?version(out.stdout):null;agent.status=v?'installed':'error';agent.version=v;}
    catch{agent.status='error';}
  }
  const pkg=deps.resolvePackage('playwright');
  if(pkg){const v=deps.readVersion?.(pkg)??null;playwright.status=v?'installed':'error';playwright.version=v;}
  return [agent,playwright];
}
