import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {AppPreview,AppPreviewCatalog} from '../shared/app-preview.ts';

type PanelProps={workspaceId:string;online:boolean;locked:boolean;refreshKey:string;post:(path:string,body:object)=>Promise<unknown>};
type Element={type:unknown;props:{children?:unknown;[key:string]:any}};
type Effect={deps:readonly unknown[];cleanup?:()=>void};
const origin='http://127.0.0.1:50000',digest='b'.repeat(64),changedDigest='c'.repeat(64);
const firstId='1'.repeat(64),secondId='2'.repeat(64);
const require=createRequire(import.meta.url);

function descendants(value:unknown):Element[]{
  if(Array.isArray(value))return value.flatMap(descendants);
  if(!value||typeof value!=='object'||!('props' in value))return [];
  const element=value as Element;return [element,...descendants(element.props.children)];
}
function text(value:unknown):string{
  if(Array.isArray(value))return value.map(text).join('');
  if(value&&typeof value==='object'&&'props' in value)return text((value as Element).props.children);
  return typeof value==='string'||typeof value==='number'?String(value):'';
}

// No DOM dependency is installed. Drive only the generic hooks here; all request,
// cancellation, stale-state and rendering decisions execute the production TSX.
function fixture(){
  const slots:unknown[]=[],effects=new Map<number,Effect>();
  let cursor=0,dirty=true,disposed=false,tree:ReactNode;
  let pendingEffects:{index:number;deps:readonly unknown[];run:()=>void|(()=>void)}[]=[];
  let catalog:AppPreviewCatalog={workspaceId:'w',sourceDigest:digest,entries:['index.html']};
  const pendingPosts:((preview:AppPreview)=>void)[]=[];
  const hooks={
    useState(initial:unknown){
      const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],(next:unknown)=>{
        if(disposed)return;
        const value=typeof next==='function'?next(slots[index]):next;
        if(!Object.is(value,slots[index])){slots[index]=value;dirty=true;}
      }];
    },
    useRef(initial:unknown){const index=cursor++;return slots[index]??=( {current:initial});},
    useEffect(run:()=>void|(()=>void),deps:readonly unknown[]){
      const index=cursor++,previous=effects.get(index)?.deps;
      if(!previous||previous.length!==deps.length||deps.some((value,i)=>!Object.is(value,previous[i])))pendingEffects.push({index,deps,run});
    },
  };
  let props:PanelProps={workspaceId:'w',online:true,locked:false,refreshKey:'5',post:async(path,body)=>{
    assert.equal(path,'/api/workspaces/w/app-preview');
    assert.equal((body as {entryPath:string}).entryPath,'index.html');
    return new Promise<AppPreview>(resolve=>pendingPosts.push(resolve));
  }};
  const source=ts.transpileModule(readFileSync(new URL('../web/app-preview.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{} as {AppPreviewPanel:(props:PanelProps)=>ReactNode}};
  new Function('require','module','exports','document','fetch','setTimeout','clearTimeout',source)(
    (id:string)=>id==='react'?hooks:require(id),module,module.exports,
    {querySelector:()=>({getAttribute:()=>origin})},
    async(path:string)=>{assert.equal(path,'/api/workspaces/w/app-preview');const value=structuredClone(catalog);return {ok:true,json:async()=>value};},
    (callback:()=>void,delay:number)=>setTimeout(callback,delay).unref(),clearTimeout,
  );
  async function settle(){
    for(let attempt=0;attempt<30;attempt++){
      if(dirty){
        dirty=false;cursor=0;tree=module.exports.AppPreviewPanel(props);
        const next=pendingEffects;pendingEffects=[];
        for(const effect of next)effects.get(effect.index)?.cleanup?.();
        for(const effect of next){const cleanup=effect.run();effects.set(effect.index,{deps:effect.deps,cleanup:typeof cleanup==='function'?cleanup:undefined});}
      }
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(!dirty&&!pendingEffects.length)return;
    }
    throw new Error('Preview component did not settle');
  }
  return {
    settle,
    html:()=>renderToStaticMarkup(tree),
    async click(label:string){
      const button=descendants(tree).find(element=>element.type==='button'&&text(element.props.children)===label);
      assert.ok(button,'Expected visible button: '+label);assert.ok(!button.props.disabled,'Button must be enabled: '+label);
      button.props.onClick();await settle();
    },
    async event(next:{refreshKey:string;locked?:boolean;sourceDigest?:string}){
      if(next.sourceDigest)catalog={...catalog,sourceDigest:next.sourceDigest};
      props={...props,refreshKey:next.refreshKey,locked:next.locked??props.locked};dirty=true;await settle();
    },
    async complete(id:string,sourceDigest=digest){
      const resolve=pendingPosts.shift();assert.ok(resolve,'Expected a pending preview creation request');
      resolve({id,workspaceId:'w',sourceDigest,entryPath:'index.html',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),url:origin+'/'+id+'/index.html',fileCount:1});await settle();
    },
    dispose(){disposed=true;for(const effect of effects.values())effect.cleanup?.();},
  };
}

test('an unrelated observed event does not discard a successfully refreshed preview',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();
  await panel.click('미리보기 열기');await panel.complete(firstId);
  assert.ok(panel.html().includes('src="'+origin+'/'+firstId+'/index.html"'));
  await panel.click('최신 파일로 다시 열기');
  await panel.event({refreshKey:'6'});
  await panel.complete(secondId);
  const html=panel.html();
  assert.ok(html.includes('src="'+origin+'/'+secondId+'/index.html"'),'A successful refresh must display the new preview even if lastSeq changed during POST');
  assert.ok(!html.includes('src="'+origin+'/'+firstId+'/index.html"'),'The server has revoked the previous preview token');
  assert.doesNotMatch(html,/role="alert"/);
});

test('a source change during preview creation hides the returned stale snapshot',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();
  await panel.click('미리보기 열기');await panel.complete(firstId);
  await panel.click('최신 파일로 다시 열기');
  await panel.event({refreshKey:'6',sourceDigest:changedDigest});
  await panel.complete(secondId);
  assert.doesNotMatch(panel.html(),/<iframe/);
  assert.match(panel.html(),/소스가 변경됐거나 현재 상태를 확인할 수 없습니다/);
});

test('a locked transition discards an in-flight preview response even after returning idle',async t=>{
  const panel=fixture();t.after(()=>panel.dispose());await panel.settle();
  await panel.click('미리보기 열기');
  await panel.event({refreshKey:'6',locked:true});
  await panel.complete(secondId);
  assert.doesNotMatch(panel.html(),/<iframe/);
  await panel.event({refreshKey:'7',locked:false});
  assert.doesNotMatch(panel.html(),/<iframe/,'Unlocking must not resurrect a response from the previous locked generation');
  await panel.click('미리보기 열기');await panel.complete(firstId);
  assert.ok(panel.html().includes('src="'+origin+'/'+firstId+'/index.html"'),'A new explicit request must still work after unlocking');
});
