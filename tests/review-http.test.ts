import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import type {RpcPort} from '../server/rpc.ts';
import type {ReviewRecord,ReviewPreview,ReviewView} from '../shared/reviews.ts';
import {buildReviewInput} from '../server/review-input.ts';

test('native review HTTP uses explicit source consent, a separate mock readonly session, interruption and restart recovery without verification or replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-review-http-')),root=join(dir,'project');mkdirSync(root);
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,stdio:'pipe',windowsHide:true});
  git(root,'init','-q','-b','main');git(root,'config','core.autocrlf','false');writeFileSync(join(root,'source.txt'),'before\n');git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(join(dir,'test.sqlite')),projects=new Projects(store,join(dir,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id);writeFileSync(join(workspace.path,'source.txt'),'after\n');
  let instances=0,reviewCalls=0,hang=false,restored:Controller|undefined;
  class ReviewRpc extends EventEmitter implements RpcPort {
    async initialize(){}
    async close(){this.emit('closed');}
    async request(method:string,params:any){
      if(method==='account/read')return {account:{type:'chatgpt'}};
      if(method==='config/read')return {config:{mcp_servers:{}}};
      if(method==='thread/start'){assert.equal(params.sandbox,'read-only');return {thread:{id:'review-thread',status:{type:'idle'}},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'};}
      if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
      if(method==='review/start'){
        reviewCalls++;assert.equal(params.delivery,'inline');assert.equal(params.target.type,'custom');assert.match(params.target.instructions,/source\.txt/);
        if(!hang)setImmediate(()=>{this.emit('notification',{method:'item/completed',params:{threadId:'review-thread',turnId:'review-turn',item:{id:'review-item',type:'exitedReviewMode',review:'Mock review: no concrete finding.'}}});this.emit('notification',{method:'turn/completed',params:{threadId:'review-thread',turn:{id:'review-turn',status:'completed',items:[]}}});});
        return {reviewThreadId:'review-thread',turn:{id:'review-turn',status:'inProgress',items:[]}};
      }
      if(method==='turn/interrupt')return {};
      throw new Error('UNEXPECTED_RPC');
    }
  }
  const factory=(path:string,write:boolean)=>{instances++;assert.equal(path,workspace.path);assert.equal(write,false);return new ReviewRpc();};
  const controller=new Controller(store,createWorkspace(dir),factory,projects);await controller.selectWorkspace(workspace.id);
  const server=createHttpServer(controller,dir);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken},post=(path:string,data:object,override:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(data)}),get=(path:string)=>fetch(origin+path,{headers:{Cookie:cookie}});
  const viewPath=`/api/workspaces/${workspace.id}/reviews`,previewPath=viewPath+'/preview';
  try{
    const initial=await get(viewPath);assert.equal(initial.status,200);assert.equal((await initial.json() as ReviewView).records.length,0);assert.equal(instances,0);
    assert.equal((await get(previewPath+'?runId='+randomUUID()+'&runId='+randomUUID())).status,400);
    const preview=await(await get(previewPath)).json() as ReviewPreview;assert.equal(instances,0);
    const input={requestId:randomUUID(),workspaceId:workspace.id,runId:null,expectedPreviewDigest:preview.previewDigest,confirmed:true};
    assert.equal((await post('/api/reviews/start',input,{'X-CSRF-Token':''})).status,403);assert.equal((await post('/api/reviews/start',{...input,prompt:'override'})).status,400);
    assert.equal((await post('/api/reviews/start',{...input,confirmed:false})).status,409);assert.equal(instances,0);
    const before=projects.fingerprint(workspace.id),head=git(workspace.path,'rev-parse','HEAD'),indexPath=resolve(workspace.path,git(workspace.path,'rev-parse','--git-path','index').toString().trim()),index=readFileSync(indexPath);
    const response=await post('/api/reviews/start',input);assert.equal(response.status,200);const record=await response.json() as ReviewRecord;await controller.reviews.settle();
    assert.equal(controller.reviews.record(record.id).execution,'completed');assert.equal(reviewCalls,1);assert.equal((await post('/api/reviews/start',input)).status,200);assert.equal(reviewCalls,1);
    assert.equal(store.runs().length,0);assert.equal(controller.verification.view(workspace.id,null).approval,null);assert.equal(projects.fingerprint(workspace.id),before);assert.deepEqual(git(workspace.path,'rev-parse','HEAD'),head);assert.deepEqual(readFileSync(indexPath),index);assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'before\n');
    hang=true;const next=await(await post('/api/reviews/start',{...input,requestId:randomUUID()})).json() as ReviewRecord;
    assert.equal(controller.snapshot().reviewBusy,true);assert.equal((await post('/api/connect',{})).status,409);assert.equal(instances,2);
    assert.equal((await post(`/api/reviews/${next.id}/interrupt`,{workspaceId:workspace.id})).status,200);await controller.reviews.settle();assert.equal(controller.reviews.record(next.id).execution,'interrupted');
    store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify({...controller.reviews.record(record.id),execution:'running',processStopped:false}),record.id);
    restored=new Controller(store,createWorkspace(dir),factory,projects);assert.equal(restored.reviews.record(record.id).execution,'lost');assert.equal(reviewCalls,2);assert.throws(()=>restored!.reviews.ensureAvailable(workspace.id),/REVIEW_RECOVERY_REQUIRED/);
    restored.recoverReview({reviewId:record.id,confirmedStopped:true});assert.equal(restored.reviews.record(record.id).execution,'lost');assert.equal(restored.reviews.view(workspace.id,null).recoveryRequired,false);assert.equal(reviewCalls,2);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await restored?.close();await controller.close();store.close();}
});

test('large raw Git patches remain explicitly omitted even when credential masking would shrink a truncated prefix',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-review-diff-limit-')),root=join(dir,'project');mkdirSync(root);
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,stdio:'pipe',windowsHide:true});
  git(root,'init','-q','-b','main');git(root,'config','core.autocrlf','false');writeFileSync(join(root,'source.txt'),'before\n');git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(':memory:');try{
    const projects=new Projects(store,join(dir,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id);
    writeFileSync(join(workspace.path,'source.txt'),'api_key='+ 'x'.repeat(4096)+'\n'+'y'.repeat(61000)+'\nREVIEW_TAIL_MUST_NOT_BE_SILENTLY_LOST\n');
    const raw=git(workspace.path,'diff','--no-ext-diff','--no-textconv',workspace.baseSha,'--','source.txt').toString('utf8');assert.ok(raw.length>64000&&raw.length<128000);
    const diff=projects.diff(workspace.id);assert.equal(diff.files[0].omitted,'too_large');assert.equal(diff.files[0].patch,null);
    assert.throws(()=>buildReviewInput(diff),/REVIEW_INCOMPLETE_DIFF/);assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'before\n');
  }finally{store.close();}
});
