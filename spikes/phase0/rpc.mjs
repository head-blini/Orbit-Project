import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { denyRequest } from './contracts.ts';

// Private stdio only; raw data and stderr never enter a log.
export class RpcClient extends EventEmitter {
  pending = new Map(); nextId = 1; requestCount = 0; buffer = ''; events = [];
  constructor(command,args,options={}) {
    super();
    this.child=spawn(command,args,{...options,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.closed=new Promise(resolve=>{
      const finish=(code,signal)=>{
        if (this.exit) return;
        this.exit={code,signal};
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('transport closed')); }
        this.pending.clear(); this.emit('closed'); resolve(this.exit);
      };
      this.child.on('error',()=>finish(null,'spawn-error'));
      this.child.on('close',finish);
    });
    this.child.stdin.on('error',()=>{});
    this.child.stderr.on('data',()=>{});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      if (this.buffer.length>8*1024*1024) { this.child.kill(); return; }
      let i;
      while ((i=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,i); this.buffer=this.buffer.slice(i+1);
        if (!line.trim()) continue;
        let e; try { e=JSON.parse(line); } catch { this.emit('protocolError'); this.child.kill(); return; }
        if (e.method && e.id!==undefined) { this.requestCount++; this.send(denyRequest(e)); this.emit('serverRequest',e.method); }
        else if (e.id!==undefined) {
          const p=this.pending.get(e.id); if (!p) continue;
          clearTimeout(p.timer); this.pending.delete(e.id);
          if (e.error) p.reject(Object.assign(new Error('RPC error'),{rpcCode:e.error.code})); else p.resolve(e.result);
        } else if (e.method) { this.events.push(e); this.emit('notification',e); }
      }
    });
  }
  send(e) { if (!this.exit) this.child.stdin.write(JSON.stringify(e)+'\n'); }
  request(method,params,timeout=20000) {
    if (this.exit) return Promise.reject(new Error('transport closed'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC timeout'));},timeout);
      this.pending.set(id,{resolve,reject,timer}); this.send({id,method,params});
    });
  }
  waitFor(predicate,timeout=30000) {
    const found=this.events.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.off('notification',onEvent);this.off('closed',onClose);};
      const onEvent=e=>{if(predicate(e)){cleanup();resolve(e);}};
      const onClose=()=>{cleanup();reject(new Error('transport closed'));};
      const timer=setTimeout(()=>{cleanup();reject(new Error('event timeout'));},timeout);
      this.on('notification',onEvent); this.on('closed',onClose);
      if(this.exit) onClose();
    });
  }
  async initialize() {
    const result=await this.request('initialize',{clientInfo:{name:'phase0_local_spike',version:'0.1.0'},capabilities:{experimentalApi:false}});
    this.send({method:'initialized',params:{}}); return result;
  }
  async close() {
    if (!this.exit) this.child.stdin.end();
    const timer=setTimeout(()=>this.child.kill(),2500);
    const result=await this.closed; clearTimeout(timer); return result;
  }
}
