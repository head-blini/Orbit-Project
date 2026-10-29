import {EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Studio} from '../server/studio.ts';
import {Controller} from '../server/controller.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

export async function toolFixture(source:'native'|'mock'|'unknown'='native'){
  const directory=mkdtempSync(join(tmpdir(),'orbit-t7-')),root=join(directory,'repo');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(join(root,'file.txt'),'fixture');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(':memory:'),projects=new Projects(store,join(directory,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id),studio=new Studio(store);
  store.setMeta('selectedWorkspace',workspace.id);
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Tool fixture',goal:'Use approved fixture',requirements:[{id:'R1',description:'Produce result',acceptance_criteria:['Result exists']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
  const [task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  class Fake extends EventEmitter {
    evidenceSource=source==='unknown'?undefined:source;sent:{method:string;params:any}[]=[];enabled=false;starts=0;closed=false;complete=true;
    async initialize(){}
    async close(){this.closed=true;this.emit('closed');}
    async request(method:string,params:any):Promise<any>{
      this.sent.push({method,params});
      if(method==='account/read')return {account:{type:'chatgpt'}};
      if(method==='config/read')return {config:{mcp_servers:{fixture:{},other:{}}}};
      if(method==='thread/start'||method==='thread/resume'){
        this.enabled=params.config.mcp_servers.fixture.enabled;
        return {thread:{id:'thread-fixture',status:{type:'idle'}},sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true},approvalPolicy:'on-request',approvalsReviewer:'user'};
      }
      if(method==='mcpServerStatus/list')return {data:['fixture','other'].map(name=>({name,runtimeStatus:this.enabled&&name==='fixture'?'ready':'disabled',tools:this.enabled&&name==='fixture'?{echo:{}}:{},pluginId:null})),nextCursor:null};
      if(method==='skills/list')return {data:[{cwd:workspace.path,skills:[],errors:[]}]};
      if(method==='hooks/list')return {data:[{cwd:workspace.path,hooks:[],errors:[],warnings:[]}]};
      if(method==='turn/start'){
        this.starts++;
        setImmediate(()=>{
          this.emit('notification',{method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{id:'call1',type:'mcpToolCall',status:'completed',server:'fixture',tool:'echo',arguments:{private:'never stored'},result:'never stored'}}});
          if(this.complete)this.emit('notification',{method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
          else this.emit('closed');
        });
        return {turn:{id:'turn-fixture'}};
      }
      return {};
    }
  }
  const rpc=new Fake(),controller=new Controller(store,workspace.path,()=>rpc,projects);
  await controller.connect();await controller.refreshExtensions({workspaceId:workspace.id});
  const selection={projectId:project.id,taskId:task.id,runtimeId:'codex',kind:'mcp',itemId:createHash('sha256').update(JSON.stringify(['mcp','fixture'])).digest('hex')};
  return {store,controller,rpc,selection,project,task,workspace,close:async()=>{await controller.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}
