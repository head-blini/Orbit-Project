import { useEffect,useId,useRef,useState } from 'react';
import type { Snapshot,WorkspaceDiff } from '../../shared/types.ts';
import type { ArtifactRepository } from '../../server/visualization/artifacts.ts';
import { generateArchitectureMermaid,parseMermaid,validateArchitecture,validateMermaid } from './mermaid.ts';
import { toPresentationDocument,validatePresentationDocument } from './presentation.ts';
import { buildTimeline,startTimelineReload } from './timeline.ts';

type Graph=Parameters<typeof generateArchitectureMermaid>[0];
type Artifact=ReturnType<ArtifactRepository['create']>;
type StudioProps={
  projectId:string;
  artifacts:readonly Artifact[];
  onSave?:(input:{id?:string;expectedRevision?:number;kind:Artifact['kind'];source:string;metadata:Record<string,string>})=>Promise<Artifact>;
  onHistory?:(id:string)=>Promise<Artifact[]>;
  onExportPresentation?:(document:ReturnType<typeof toPresentationDocument>)=>Promise<void>;
};
const sample='flowchart TD\n  browser["Browser"]\n  server["Local server"]\n  browser -->|HTTP| server';

/** Render known primitives only. No Mermaid engine, raw markup, URLs, or remote renderer. */
export function ArchitecturePreview({graph}:{graph:Graph}) {
  const marker=useId();
  if(!validateArchitecture(graph).ok) return <p role="alert">Invalid architecture.</p>;
  const slide=toPresentationDocument(graph).slides[0];
  const shapes=slide.elements.filter(e=>e.type==='shape');
  const positions=new Map(shapes.map(s=>[s.id,s]));
  return <div className="viz-canvas"><svg role="img" aria-label="Architecture diagram" viewBox={`0 0 ${slide.width} ${slide.height}`} width={slide.width} height={slide.height}>
    <title>Architecture diagram</title>
    <defs><marker id={marker} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="currentColor"/></marker></defs>
    {graph.edges.map((edge,i)=>{
      const a=positions.get(edge.from)!,b=positions.get(edge.to)!;
      const dx=b.x-a.x,dy=b.y-a.y;
      const scale=Math.min(dx===0?Infinity:110/Math.abs(dx),dy===0?Infinity:50/Math.abs(dy));
      const path=edge.from===edge.to?`M ${a.x+220} ${a.y+30} C ${a.x+265} ${a.y-20}, ${a.x+265} ${a.y+120}, ${a.x+220} ${a.y+70}`:`M ${a.x+110+dx*scale} ${a.y+50+dy*scale} L ${b.x+110-dx*scale} ${b.y+50-dy*scale}`;
      return <g key={i}><path d={path} fill="none" stroke="currentColor" markerEnd={`url(#${marker})`}/><title>{edge.label??`${edge.from} to ${edge.to}`}</title></g>;
    })}
    {shapes.map(shape=><g key={shape.id}><rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx="12" fill="#edf5ff" stroke="#355c86"/><title>{graph.nodes.find(n=>n.id===shape.id)!.label}</title></g>)}
    {slide.elements.filter(e=>e.type==='text').map(element=>{
      const chunks=Array.from(element.text).join('').match(/.{1,25}/gu)??[];
      return <text key={element.id} x={element.x+5} y={element.y+18} fill="#182c45" fontSize="13"><title>{element.text}</title>{chunks.slice(0,4).map((chunk,i)=><tspan key={i} x={element.x+5} dy={i?17:0}>{i===3&&chunks.length>4?chunk.slice(0,22)+'…':chunk}</tspan>)}</text>;
    })}
  </svg></div>;
}

/** Keying isolates editor state and pending callbacks when the host switches project. */
export function VisualizationStudio(props:StudioProps) {return <StudioEditor key={props.projectId} {...props}/>;}

function StudioEditor({projectId,artifacts,onSave,onHistory,onExportPresentation}:StudioProps) {
  const [kind,setKind]=useState<Artifact['kind']>('mermaid');
  const [source,setSource]=useState(sample),[title,setTitle]=useState('Architecture');
  const [selected,setSelected]=useState<Artifact|null>(null),[history,setHistory]=useState<Artifact[]>([]);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const editorId=useId(),kindId=useId(),titleId=useId();
  let graph:Graph|null=null,valid=false,issues:{code:string;line?:number}[]=[];
  if(kind==='mermaid') {
    const result=validateMermaid(source);valid=result.ok;issues=result.issues;
    if(valid) {const parsed=parseMermaid(source);graph={nodes:parsed.nodes,edges:parsed.edges};}
  } else if(kind==='architecture') {
    try {const parsed:unknown=JSON.parse(source);const result=validateArchitecture(parsed);valid=result.ok;issues=result.issues;if(valid)graph=parsed as Graph;}
    catch {issues=[{code:'INVALID_JSON'}];}
  } else {
    try {valid=validatePresentationDocument(JSON.parse(source));} catch {valid=false;}
    if(!valid)issues=[{code:'INVALID_PRESENTATION'}];
  }
  function load(artifact:Artifact) {
    if(artifact.projectId!==projectId) return;
    setSelected(artifact);setKind(artifact.kind);setSource(artifact.source);setTitle(artifact.metadata.title??'Untitled');setMessage('');
  }
  async function action(work:()=>Promise<void>) {
    if(busy)return;setBusy(true);setMessage('');
    try {await work();} catch {setMessage('Operation failed. Reload the latest Artifact before retrying.');} finally {setBusy(false);}
  }
  async function save() {
    if(!onSave||!valid)return;
    await action(async()=>{
      const saved=await onSave({...(selected?{id:selected.id,expectedRevision:selected.revision}:{}),kind,source,metadata:{...(selected?.metadata??{}),title}});
      if(saved.projectId!==projectId) throw new Error('PROJECT_MISMATCH');
      load(saved);setHistory([]);setMessage(`Saved revision ${saved.revision}.`);
    });
  }
  return <section className="viz-studio" aria-label="Visualization Studio" aria-busy={busy}>
    <header><p className="viz-eyebrow">LOCAL DESIGN WORKSPACE</p><h2>Visualization Studio</h2><p>Describe an architecture, inspect its diagram, and preserve the source as a versioned Artifact.</p></header>
    <div className="viz-layout"><div className="viz-editor">
      <label htmlFor={titleId}>Artifact title</label><input id={titleId} value={title} maxLength={160} disabled={busy} onChange={e=>setTitle(e.target.value)}/>
      <label htmlFor={kindId}>Source format</label><select id={kindId} value={kind} disabled={busy||!!selected} onChange={e=>{setKind(e.target.value as Artifact['kind']);setMessage('');}}><option value="mermaid">Mermaid flowchart</option><option value="architecture">Architecture JSON</option><option value="presentation">Presentation document JSON</option></select>
      <label htmlFor={editorId}>Source</label><textarea id={editorId} rows={16} spellCheck={false} value={source} disabled={busy} maxLength={262144} onChange={e=>setSource(e.target.value)}/>
      <p className="viz-hint">Supported Mermaid: flowchart TD or LR, quoted rectangular nodes, and directed edges. Preview uses a fixed grid. No directives, HTML, links, styles, or click actions.</p>
      {issues.length>0?<ul className="viz-issues" aria-live="polite">{issues.slice(0,8).map((issue,i)=><li key={i}>{issue.code}{issue.line?` · line ${issue.line}`:''}</li>)}</ul>:<p className="viz-valid">Source validated for the supported subset.</p>}
      <div className="viz-actions"><button disabled={busy||!valid||!onSave} onClick={()=>void save()}>{selected?`Save revision after ${selected.revision}`:'Save Artifact'}</button><button disabled={busy} onClick={()=>{setSelected(null);setHistory([]);setMessage('Editing a new Artifact.');}}>New Artifact from source</button></div>
      {!onSave&&<p>Artifact saving is not connected.</p>}
      {message&&<p role="status">{message}</p>}
    </div><div className="viz-preview"><h3>Diagram preview</h3>{graph?<ArchitecturePreview graph={graph}/>:<p>{valid?'Presentation source is ready for an exporter.':'Enter valid source to preview the architecture.'}</p>}
      {graph&&<details><summary>Generated Mermaid source</summary><pre>{generateArchitectureMermaid(graph)}</pre></details>}
      <button disabled={busy||!valid||!onExportPresentation} onClick={()=>void action(async()=>{
        if(!onExportPresentation)return;
        const doc=graph?toPresentationDocument(graph):JSON.parse(source) as ReturnType<typeof toPresentationDocument>;
        await onExportPresentation(doc);setMessage('Export completed by the connected exporter.');
      })}>Export PPTX</button>
      <p>{onExportPresentation?'PPTX export is supplied by the host application.':'PPTX generation foundation only — serializer and download are not connected.'}</p>
    </div></div>
    <section aria-label="Saved Artifacts"><h3>Saved Artifacts</h3>
      <ul>{artifacts.filter(a=>a.projectId===projectId).map(a=><li key={a.id}><button disabled={busy} onClick={()=>{load(a);setHistory([]);}}>{a.metadata.title??'Untitled'} · {a.kind} · revision {a.revision}</button></li>)}</ul>
      {!artifacts.some(a=>a.projectId===projectId)&&<p>No saved Artifacts in this project.</p>}
      {selected&&<><p>Selected revision {selected.revision} · <code>{selected.contentHash}</code></p><button disabled={busy||!onHistory} onClick={()=>void action(async()=>{
        if(!onHistory)return;const versions=await onHistory(selected.id);
        if(versions.some(a=>a.projectId!==projectId||a.id!==selected.id))throw new Error('HISTORY_MISMATCH');
        setHistory(versions);
      })}>Load revision history</button><ul>{history.map(a=><li key={a.revision}><button disabled={busy} onClick={()=>load(a)}>Revision {a.revision} · {a.createdAt}</button></li>)}</ul></>}
    </section>
  </section>;
}

type TimelineProps={view:ReturnType<typeof buildTimeline>;snapshot:Readonly<Snapshot>;diff?:Readonly<WorkspaceDiff>;onReload:(request:{workspaceKey:string;after:number;reason:string})=>Promise<void>};

export function RunTimeline(props:TimelineProps) {return <TimelineContent key={props.view.workspaceKey} {...props}/>;}
function TimelineContent({view,snapshot,diff,onReload}:TimelineProps) {
  const [error,setError]=useState(false),[retry,setRetry]=useState(0);
  const callback=useRef(onReload);callback.current=onReload;
  const reloadKey=view.reload?JSON.stringify([view.workspaceKey,view.reload.after,view.reload.reason]):null;
  useEffect(()=>{
    setError(false);
    if(!reloadKey)return;
    const [workspaceKey,after,reason]=JSON.parse(reloadKey) as [string,number,string];
    return startTimelineReload({workspaceKey,after,reason},request=>callback.current(request),()=>setError(true));
  },[reloadKey,retry]);
  return <section className="viz-timeline" aria-label="Run timeline"><h2>Run timeline</h2>
    {view.reload&&<p role="status">Authoritative reload required: {view.reload.reason}.</p>}
    {error&&<p role="alert">Reload failed. <button onClick={()=>setRetry(value=>value+1)}>Retry reload</button></p>}
    <ul>{snapshot.runs.filter(r=>(r.workspaceId??null)===(snapshot.selectedWorkspaceId??null)).map(run=><li key={run.id}><code>{run.id}</code> · {run.execution} · Verification: {run.verification}</li>)}</ul>
    <ol>{view.items.map(item=><li key={item.seq}><code>#{item.seq}</code> {item.label} <time>{item.at}</time></li>)}</ol>
    {!view.items.length&&<p>No replay events after the snapshot cursor.</p>}
    {diff&&diff.workspaceId===snapshot.selectedWorkspaceId&&<section aria-label="Workspace changes"><h3>Workspace changes</h3><p>Base: <code>{diff.baseSha}</code></p>{diff.files.map((file,i)=><details key={i}><summary>{file.status} {file.path}</summary><pre>{file.patch??file.omitted??'No patch available.'}</pre></details>)}</section>}
  </section>;
}
