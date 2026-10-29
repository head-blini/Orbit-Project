import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {Run} from '../shared/types.ts';
import type {DevelopmentResultView} from '../shared/development-results.ts';

type PanelProps={projectId:string;workspaceId:string;runs:Run[];selectedRun:Run|null;onSelectRun:(id:string)=>void;online:boolean;locked:boolean;refreshKey:string;post:(path:string,body:object)=>Promise<unknown>};
type Element={type:unknown;props:{children?:unknown;[key:string]:any}};
type Effect={deps:readonly unknown[];cleanup?:()=>void};
const observedAt='2026-10-27T00:00:00Z',sourceDigest='a'.repeat(64),configDigest='b'.repeat(64);
const run=(id:string,workspaceId='workspace-a'):Run=>({id,workspaceId,requestId:'request-'+id,turnId:null,prompt:'fixture',response:'',execution:'completed',verification:'recorded',createdAt:observedAt,updatedAt:observedAt});
const alpha=run('run-alpha'),beta=run('run-beta'),gamma=run('run-gamma','workspace-b');
function result(selected:Run,title:string,projectId='project-a'):DevelopmentResultView{
  const workspaceId=selected.workspaceId!;
  return {projectId,workspaceId,observedAt,sourceDigest,sourceIssue:null,
    run:{id:selected.id,execution:selected.execution,createdAt:selected.createdAt,updatedAt:selected.updatedAt},
    task:{id:'task-'+selected.id,title,requirementLabels:['TODO']},
    planning:{id:'plan-'+selected.id,title:'Planning '+title,revision:1,contentHash:'c'.repeat(64),state:'approved',current:true},linkIssue:null,
    verification:{available:true,canApprove:true,approvalCurrent:false,quarantined:false,scope:'Selected run and current source',
      commands:[{id:'test',label:'Tests',configDigest}],
      checks:[{id:'check-'+selected.id,runId:selected.id,projectId,workspaceId,commandId:'test',configDigest,baseSha:'d'.repeat(40),sourceDigest,finishedDigest:sourceDigest,createdAt:observedAt,completedAt:observedAt,execution:'completed',verdict:'passed',exitCode:0,durationMs:10,recoveredAt:null}],
    },
  };
}
function descendants(value:unknown):Element[]{
  if(Array.isArray(value))return value.flatMap(descendants);
  if(!value||typeof value!=='object'||!('props' in value))return [];
  const element=value as Element;return [element,...descendants(element.props.children)];
}

// Execute the real panel and summary. Only generic hooks, the HTTP boundary and
// the clock are driven here; the nested preview is inspected without its requests.
function fixture(){
  const slots:unknown[]=[],effects=new Map<number,Effect>();
  let cursor=0,dirty=true,unmounted=false,tree:ReactNode;
  let pendingEffects:{index:number;deps:readonly unknown[];run:()=>void|(()=>void)}[]=[];
  const requests:{path:string;resolve:(value:{ok:boolean;json:()=>Promise<DevelopmentResultView>})=>void}[]=[];
  const timers=new Map<number,{at:number;run:()=>void}>();let now=0,nextTimer=1;
  const hooks={
    useState(initial:unknown){
      const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],(next:unknown)=>{if(unmounted)return;const value=typeof next==='function'?next(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true;}}];
    },
    useEffect(run:()=>void|(()=>void),deps:readonly unknown[]){
      const index=cursor++,previous=effects.get(index)?.deps;
      if(!previous||previous.length!==deps.length||deps.some((value,i)=>!Object.is(value,previous[i])))pendingEffects.push({index,deps,run});
    },
  };
  const PreviewStub=()=>null;
  let props:PanelProps={projectId:'project-a',workspaceId:'workspace-a',runs:[alpha,beta],selectedRun:alpha,online:true,locked:false,refreshKey:'1',
    onSelectRun(id){props={...props,selectedRun:props.runs.find(item=>item.id===id)??null};dirty=true;},
    post:async()=>{throw new Error('Result reads must not dispatch a POST');},
  };
  const url=new URL('../web/development-results.tsx',import.meta.url),require=createRequire(url);
  const source=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{} as {DevelopmentResultPanel:(props:PanelProps)=>ReactNode}};
  new Function('require','module','exports','fetch','setTimeout','clearTimeout',source)(
    (id:string)=>id==='react'?hooks:id==='./app-preview.tsx'?{AppPreviewPanel:PreviewStub}:id==='./reuse-vendor.tsx'?{ReuseVendorPanel:()=>null}:require(id),module,module.exports,
    (path:string)=>new Promise(resolve=>requests.push({path,resolve})),
    (callback:()=>void,delay:number)=>{const id=nextTimer++;timers.set(id,{at:now+delay,run:callback});return id;},
    (id:number)=>{timers.delete(id);},
  );
  function render(){dirty=false;cursor=0;tree=module.exports.DevelopmentResultPanel(props);}
  async function settle(){
    for(let attempt=0;attempt<30;attempt++){
      if(!unmounted){
        if(dirty)render();const next=pendingEffects;pendingEffects=[];
        for(const effect of next)effects.get(effect.index)?.cleanup?.();
        for(const effect of next){const cleanup=effect.run();effects.set(effect.index,{deps:effect.deps,cleanup:typeof cleanup==='function'?cleanup:undefined});}
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(unmounted||!dirty&&!pendingEffects.length)return;
    }
    throw new Error('Result panel did not settle');
  }
  return {
    settle,html:()=>renderToStaticMarkup(tree),paths:()=>requests.map(request=>request.path),
    evidence:()=>descendants(tree).find(element=>element.type===PreviewStub)?.props.evidence as DevelopmentResultView|null,
    renderOnly(next:Partial<PanelProps>){props={...props,...next};render();},
    async select(id:string){
      const select=descendants(tree).find(element=>element.type==='select'&&element.props['aria-label']==='확인할 실행');
      assert.ok(select);select.props.onChange({target:{value:id}});await settle();
    },
    async respond(index:number,view:DevelopmentResultView){assert.ok(requests[index],'Expected pending result request');requests[index].resolve({ok:true,json:async()=>structuredClone(view)});await settle();},
    async advance(milliseconds:number){
      const end=now+milliseconds;
      for(let count=0;count<100;count++){
        const next=[...timers].sort((a,b)=>a[1].at-b[1].at).find(([,timer])=>timer.at<=end);
        if(!next){now=end;return;}const [id,timer]=next;now=timer.at;timers.delete(id);timer.run();await settle();
      }
      throw new Error('Polling timer did not settle');
    },
    unmount(){if(unmounted)return;unmounted=true;for(const effect of effects.values())effect.cleanup?.();effects.clear();pendingEffects=[];},
  };
}

test('a delayed response for an older selected run cannot replace the current provenance or preview evidence',async t=>{
  const panel=fixture();t.after(()=>panel.unmount());await panel.settle();
  assert.deepEqual(panel.paths(),['/api/workspaces/workspace-a/result?runId=run-alpha']);
  await panel.select('run-beta');
  assert.equal(panel.paths()[1],'/api/workspaces/workspace-a/result?runId=run-beta');
  await panel.respond(1,result(beta,'Task Beta'));
  assert.match(panel.html(),/Task Beta/);assert.equal(panel.evidence()?.run?.id,'run-beta');
  await panel.respond(0,result(alpha,'Task Alpha'));
  assert.match(panel.html(),/Task Beta/);assert.doesNotMatch(panel.html(),/Task Alpha/);
  assert.equal(panel.evidence()?.run?.id,'run-beta');assert.equal(panel.evidence()?.task?.title,'Task Beta');
});

test('going offline removes successful provenance and preview evidence in the render before effects run',async t=>{
  const panel=fixture();t.after(()=>panel.unmount());await panel.settle();await panel.respond(0,result(alpha,'Task Alpha'));
  assert.match(panel.html(),/현재 등록 명령 모두 통과/);assert.equal(panel.evidence()?.task?.title,'Task Alpha');
  panel.renderOnly({online:false});
  assert.doesNotMatch(panel.html(),/현재 등록 명령 모두 통과|Task Alpha/);
  assert.match(panel.html(),/서버 연결 후 실행 결과/);assert.equal(panel.evidence(),null);
  await panel.settle();await panel.advance(15000);
  assert.equal(panel.paths().length,1,'Offline cleanup must cancel polling');
});

test('changing workspace removes previous successful evidence before loading the new workspace',async t=>{
  const panel=fixture();t.after(()=>panel.unmount());await panel.settle();await panel.respond(0,result(alpha,'Task Alpha'));
  assert.match(panel.html(),/현재 등록 명령 모두 통과/);
  panel.renderOnly({projectId:'project-b',workspaceId:'workspace-b',runs:[gamma],selectedRun:gamma});
  assert.doesNotMatch(panel.html(),/현재 등록 명령 모두 통과|Task Alpha/);assert.equal(panel.evidence(),null);
  await panel.settle();assert.equal(panel.paths()[1],'/api/workspaces/workspace-b/result?runId=run-gamma');
  await panel.respond(1,result(gamma,'Task Gamma','project-b'));
  assert.match(panel.html(),/Task Gamma/);assert.doesNotMatch(panel.html(),/Task Alpha/);
  assert.equal(panel.evidence()?.workspaceId,'workspace-b');assert.equal(panel.evidence()?.run?.id,'run-gamma');
});

test('unmounting a loaded result cancels the scheduled poll',async t=>{
  const panel=fixture();t.after(()=>panel.unmount());await panel.settle();await panel.respond(0,result(alpha,'Task Alpha'));
  await panel.advance(15000);assert.equal(panel.paths().length,2,'A mounted result panel must poll');
  await panel.respond(1,result(alpha,'Task Alpha'));
  await panel.advance(14999);assert.equal(panel.paths().length,2);
  panel.unmount();await panel.advance(30001);
  assert.equal(panel.paths().length,2,'An unmounted result panel must not issue another HTTP request');
});

test('a response arriving after unmount cannot schedule another result poll',async t=>{
  const panel=fixture();t.after(()=>panel.unmount());await panel.settle();
  panel.unmount();await panel.respond(0,result(alpha,'Task Alpha'));await panel.advance(45000);
  assert.equal(panel.paths().length,1,'Completing an obsolete request must not restart polling');
});
