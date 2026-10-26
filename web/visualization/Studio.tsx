import { useEffect,useId,useRef,useState } from 'react';
import type { Snapshot,WorkspaceDiff } from '../../shared/types.ts';
import type { ArtifactRecord } from '../../shared/parallel.ts';
import { generateArchitectureMermaid,parseMermaid,validateArchitecture,validateMermaid } from './mermaid.ts';
import { toPresentationDocument,validatePresentationDocument } from './presentation.ts';
import { buildTimeline,startTimelineReload } from './timeline.ts';
import { ArtifactSourceStatus } from './ArtifactSourceStatus.tsx';

type Graph=Parameters<typeof generateArchitectureMermaid>[0];
type Artifact=ArtifactRecord;
type StudioProps={
  projectId:string;
  artifacts:readonly Artifact[];
  onSave?:(input:{id?:string;expectedRevision?:number;kind:Artifact['kind'];source:string;metadata:Record<string,string>})=>Promise<Artifact>;
  onHistory?:(id:string)=>Promise<Artifact[]>;
  onExportPresentation?:(document:ReturnType<typeof toPresentationDocument>)=>Promise<void>;
  onExportArtifact?:(artifact:Artifact,format:'pptx'|'markdown')=>Promise<void>;
};
const sample='flowchart TD\n  browser["Browser"]\n  server["Local server"]\n  browser -->|HTTP| server';

/** Render known primitives only. No Mermaid engine, raw markup, URLs, or remote renderer. */
export function ArchitecturePreview({graph}:{graph:Graph}) {
  const marker=useId();
  if(!validateArchitecture(graph).ok) return <p role="alert">유효하지 않은 구조입니다.</p>;
  const slide=toPresentationDocument(graph).slides[0];
  const shapes=slide.elements.filter(e=>e.type==='shape');
  const positions=new Map(shapes.map(s=>[s.id,s]));
  return <div className="viz-canvas"><svg role="img" aria-label="구조 다이어그램" viewBox={`0 0 ${slide.width} ${slide.height}`} width={slide.width} height={slide.height}>
    <title>구조 다이어그램</title>
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

function StudioEditor({projectId,artifacts,onSave,onHistory,onExportPresentation,onExportArtifact}:StudioProps) {
  const [kind,setKind]=useState<Artifact['kind']>('mermaid');
  const [source,setSource]=useState(sample),[title,setTitle]=useState('구조 다이어그램');
  const [selected,setSelected]=useState<Artifact|null>(null),[history,setHistory]=useState<Artifact[]>([]);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const editorId=useId(),kindId=useId(),titleId=useId();
  const savedMatches=!!selected&&selected.kind===kind&&selected.source===source&&(selected.metadata.title??'제목 없음')===title;
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
    setSelected(artifact);setKind(artifact.kind);setSource(artifact.source);setTitle(artifact.metadata.title??'제목 없음');setMessage('');
  }
  async function action(work:()=>Promise<void>) {
    if(busy)return;setBusy(true);setMessage('');
    try {await work();} catch {setMessage('처리 결과를 확인하지 못했습니다. 최신 Artifact를 다시 불러와 확인하세요.');} finally {setBusy(false);}
  }
  async function save() {
    if(!onSave||!valid)return;
    await action(async()=>{
      const saved=await onSave({...(selected?{id:selected.id,expectedRevision:selected.revision}:{}),kind,source,metadata:{...(selected?.metadata??{}),title}});
      if(saved.projectId!==projectId) throw new Error('PROJECT_MISMATCH');
      load(saved);setHistory([]);setMessage(`버전 ${saved.revision} 저장 완료.`);
    });
  }
  return <section className="viz-studio" aria-label="Visualization Studio" aria-busy={busy}>
    <header><h2>Artifact 편집기</h2><p>{selected?`저장된 버전 ${selected.revision} 편집 중`:'새 Artifact · 기본 원문은 저장 전 예제입니다.'}</p></header>
    <div className="viz-layout"><div className="viz-editor">
      <label htmlFor={titleId}>Artifact 제목</label><input id={titleId} value={title} maxLength={160} disabled={busy} onChange={e=>setTitle(e.target.value)}/>
      <label htmlFor={kindId}>원문 형식</label><select id={kindId} value={kind} disabled={busy||!!selected} onChange={e=>{setKind(e.target.value as Artifact['kind']);setMessage('');}}><option value="mermaid">Mermaid 흐름도</option><option value="architecture">구조 JSON</option><option value="presentation">프레젠테이션 문서 JSON</option></select>
      <label htmlFor={editorId}>원문</label><textarea id={editorId} rows={16} spellCheck={false} value={source} disabled={busy} maxLength={262144} onChange={e=>setSource(e.target.value)}/>
      <p className="viz-hint">Mermaid 지원: flowchart TD/LR, 따옴표로 감싼 사각형 노드, 방향 간선. 미리보기는 고정 격자이며 HTML·링크·스타일·클릭 동작은 허용하지 않습니다.</p>
      {issues.length>0?<ul className="viz-issues" aria-live="polite">{issues.slice(0,8).map((issue,i)=><li key={i}>{issue.code}{issue.line?` · ${issue.line}행`:''}</li>)}</ul>:<p className="viz-valid">지원하는 문법의 검증을 통과했습니다.</p>}
      <div className="viz-actions"><button disabled={busy||!valid||!onSave} onClick={()=>void save()}>{selected?`버전 ${selected.revision} 이후 새 버전 저장`:'Artifact 저장'}</button><button disabled={busy} onClick={()=>{setSelected(null);setHistory([]);setMessage('새 Artifact를 편집하고 있습니다.');}}>원문으로 새 Artifact 작성</button></div>
      {!onSave&&<p>Artifact 저장 기능이 연결되지 않았습니다.</p>}
      {message&&<p role="status">{message}</p>}
    </div><div className="viz-preview"><h3>다이어그램 미리보기</h3>{graph?<ArchitecturePreview graph={graph}/>:<p>{valid?'프레젠테이션 원문이 준비됐습니다. 저장 후 내보낼 수 있습니다.':'유효한 원문을 입력하면 구조를 미리 볼 수 있습니다.'}</p>}
      {graph&&<details><summary>생성된 Mermaid 원문</summary><pre>{generateArchitectureMermaid(graph)}</pre></details>}
      <button disabled={busy||!valid||(!onExportPresentation&&!(onExportArtifact&&savedMatches))} onClick={()=>void action(async()=>{
        if(onExportArtifact&&selected&&savedMatches){await onExportArtifact(selected,'pptx');setMessage('저장된 버전의 PPTX 파일을 다운로드했습니다.');return;}
        if(!onExportPresentation)return;
        const doc=graph?toPresentationDocument(graph):JSON.parse(source) as ReturnType<typeof toPresentationDocument>;
        await onExportPresentation(doc);setMessage('연결된 내보내기 도구가 작업을 완료했습니다.');
      })}>PPTX 내보내기</button>
      {onExportArtifact&&<button disabled={busy||!savedMatches} onClick={()=>void action(async()=>{if(selected&&savedMatches){await onExportArtifact(selected,'markdown');setMessage('저장된 버전의 Markdown 파일을 다운로드했습니다.');}})}>Markdown 내보내기</button>}
      <p>{onExportArtifact?'저장된 버전의 텍스트·도형·연결선을 편집 가능한 PPTX로 내보냅니다. 수정한 원문은 먼저 저장하세요.':onExportPresentation?'호스트 앱의 PPTX 내보내기 기능을 사용합니다.':'PPTX 문서 구조만 지원합니다. 파일 생성·다운로드는 준비 중입니다.'}</p>
    </div></div>
    <section aria-label="저장된 Artifact"><h3>저장된 Artifact</h3>
      <ul>{artifacts.filter(a=>a.projectId===projectId).map(a=><li key={a.id}><button disabled={busy} onClick={()=>{load(a);setHistory([]);}}>{a.metadata.title??'제목 없음'} · {a.kind} · 버전 {a.revision}</button></li>)}</ul>
      {!artifacts.some(a=>a.projectId===projectId)&&<p>이 프로젝트에 저장된 Artifact가 없습니다.</p>}
      {selected&&<><p>선택 버전 {selected.revision} · <code>{selected.contentHash}</code></p><ArtifactSourceStatus artifact={selected}/><button disabled={busy||!onHistory} onClick={()=>void action(async()=>{
        if(!onHistory)return;const versions=await onHistory(selected.id);
        if(versions.some(a=>a.projectId!==projectId||a.id!==selected.id))throw new Error('HISTORY_MISMATCH');
        setHistory(versions);
      })}>버전 이력 불러오기</button><ul>{history.map(a=><li key={a.revision}><button disabled={busy} onClick={()=>load(a)}>버전 {a.revision} · {a.createdAt}</button></li>)}</ul></>}
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
  return <section className="viz-timeline" aria-label="실행 타임라인"><h2>실행 타임라인</h2>
    {view.reload&&<p role="status">서버 상태 재조회 필요: {view.reload.reason}.</p>}
    {error&&<p role="alert">재조회에 실패했습니다. <button onClick={()=>setRetry(value=>value+1)}>다시 불러오기</button></p>}
    <ul>{snapshot.runs.filter(r=>(r.workspaceId??null)===(snapshot.selectedWorkspaceId??null)).map(run=><li key={run.id}><code>{run.id}</code> · {run.execution} · 검증: 개발 화면에서 확인</li>)}</ul>
    <ol>{view.items.map(item=><li key={item.seq}><code>#{item.seq}</code> {item.label} <time>{item.at}</time></li>)}</ol>
    {!view.items.length&&<p>현재 연결 이후의 실행 이벤트가 없습니다.</p>}
    {diff&&diff.workspaceId===snapshot.selectedWorkspaceId&&<section aria-label="작업 공간 변경"><h3>작업 공간 변경</h3><p>Base: <code>{diff.baseSha}</code></p>{diff.files.map((file,i)=><details key={i}><summary>{file.status} {file.path}</summary><pre>{file.patch??file.omitted??'표시할 변경 내용이 없습니다.'}</pre></details>)}</section>}
  </section>;
}
