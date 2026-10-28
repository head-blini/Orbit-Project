import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { buildChildEnv } from './child-env.ts';
import type {NativeProcessObservation} from '../shared/native-process.ts';
export interface RpcPort extends EventEmitter {evidenceSource?:'native'|'mock';request(method:string,params:unknown):Promise<any>;initialize():Promise<void>;close():Promise<unknown>;processObservation?():NativeProcessObservation}
export function denyRequest(e:any):object {
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(e.method))return {id:e.id,result:{decision:'decline'}};
  if(e.method==='item/permissions/requestApproval')return {id:e.id,result:{permissions:{},scope:'turn'}};
  if(e.method==='mcpServer/elicitation/request')return {id:e.id,result:{action:'decline',content:null}};
  return {id:e.id,error:{code:-32601,message:'Request unsupported; no permission granted'}};
}
export class Rpc extends EventEmitter implements RpcPort {
  evidenceSource?:'native'|'mock';
  child:ChildProcessWithoutNullStreams;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private nextId=1;private buffer='';private ended=false;private stopped=false;private closed:Promise<void>;
  private observation:NativeProcessObservation={handleId:randomUUID(),pid:null,createdAt:new Date().toISOString(),state:'spawn_pending',closedAt:null,exitCode:null,signal:null};
  constructor(command:string,args:string[],cwd:string,privateTimeout=20000){
    super();this.timeout=privateTimeout;
    const env=buildChildEnv();
    this.child=spawn(command,args,{cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.on('spawn',()=>{
      if(this.stopped||this.child.pid===undefined)return;
      this.observation={...this.observation,pid:this.child.pid,state:'running'};this.emit('process.observed',this.processObservation());
    });
    this.closed=new Promise(resolve=>{
      const endTransport=()=>{if(this.ended)return;this.ended=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('TRANSPORT_CLOSED'));}this.pending.clear();};
      const finish=(state:'closed'|'spawn_failed',exitCode:number|null,signal:string|null)=>{
        if(this.stopped)return;this.stopped=true;endTransport();
        this.observation={...this.observation,pid:this.child.pid??null,state,closedAt:new Date().toISOString(),exitCode,signal};
        this.emit('process.observed',this.processObservation());this.emit('closed');resolve();
      };
      // A failed signal can emit error while the child is still alive. Only
      // actual close, or a spawn failure with no assigned PID, proves it stopped.
      this.child.on('error',()=>{endTransport();if(this.child.pid===undefined)finish('spawn_failed',null,null);});
      this.child.on('close',(code,signal)=>{if(this.child.pid===undefined)finish('spawn_failed',null,null);else finish('closed',code,signal);});
    });
    this.child.stdin.on('error',()=>{});this.child.stderr.on('data',()=>{});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      if(this.ended)return;
      this.buffer+=chunk;if(this.buffer.length>2*1024*1024){this.child.kill();return;}
      let i;while((i=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);if(!line.trim())continue;
        let e:any;try{e=JSON.parse(line);if(!e||typeof e!=='object')throw new Error();}catch{this.child.kill();return;}
        if(typeof e.method==='string' && e.id!==undefined){this.send(denyRequest(e));this.emit('approval', {method:['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(e.method)?e.method:'unknown',threadId:e.params?.threadId,turnId:e.params?.turnId});}
        else if(e.id!==undefined){const p=this.pending.get(e.id);if(!p)continue;this.pending.delete(e.id);clearTimeout(p.timer);e.error?p.reject(new Error('RPC_REJECTED')):p.resolve(e.result);}
        else if(typeof e.method==='string')this.emit('notification',e);
      }
    });
  }
  processObservation():NativeProcessObservation{return {...this.observation};}
  private timeout:number;
  private send(value:object){if(!this.ended)this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method:string,params:unknown):Promise<any>{
    if(this.ended)return Promise.reject(new Error('TRANSPORT_CLOSED'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC_TIMEOUT'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }
  async initialize(){await this.request('initialize',{clientInfo:{name:'ai_coding_control_center',version:'0.1.0'},capabilities:{experimentalApi:false}});this.send({method:'initialized',params:{}});}
  async close(){
    if(this.stopped)return this.closed;
    if(!this.child.stdin.writableEnded)this.child.stdin.end();
    const timer=setTimeout(()=>{if(!this.stopped)this.child.kill();},1500);
    try{await this.closed;}finally{clearTimeout(timer);}
  }
}
