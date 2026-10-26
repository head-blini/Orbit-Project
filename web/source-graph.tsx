import { useEffect,useMemo,useRef,useState } from 'react';
import type { SourceFileView,SourceGraphView } from '../shared/source-graph-view.ts';
import { ArchitecturePreview } from './visualization/Studio.tsx';
import { createStudioMutator } from './studio-client.ts';
const freshness={missing:'아직 분석하지 않음',current:'조회 당시 소스와 일치',stale:'소스 변경 · 다시 분석 필요',unavailable:'현재 소스 확인 불가'};
const kinds={file:'파일',function:'함수',class:'클래스',method:'메서드'};
const reasons={external_import:'외부 의존성',unresolved_import:'찾지 못한 import',dynamic_import:'동적 import',unresolved_call:'대상을 찾지 못한 호출',dynamic_call:'동적 호출',unresolved_extends:'확인할 수 없는 상속',unsupported_declaration:'지원하지 않는 선언'};
export function SourceGraphPanel({workspaceId,online,locked,post,onVisualize}:{workspaceId:string;online:boolean;locked:boolean;post:(path:string,body:object)=>Promise<unknown>;onVisualize:()=>void}){
  const [view,setView]=useState<SourceGraphView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [selected,setSelected]=useState(''),[source,setSource]=useState<SourceFileView|null>(null);
  const generation=useRef(0),sourceGeneration=useRef(0),mounted=useRef(true),sending=useRef(false);
  const postRef=useRef(post);postRef.current=post;
  const mutate=useMemo(()=>{let storage:Storage|undefined;try{storage=typeof window==='undefined'?undefined:window.sessionStorage;}catch{}return createStudioMutator((path,data)=>postRef.current(path,data),storage);},[]);
  const base='/api/workspaces/'+workspaceId+'/source-graph';
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;sourceGeneration.current++;};},[]);
  async function load(){
    const ticket=++generation.current;setError('');
    try{const response=await fetch(base);if(!response.ok)throw new Error();const value=await response.json() as SourceGraphView;
      if(mounted.current&&ticket===generation.current){setView(value);if(value.freshness!=='current'){sourceGeneration.current++;setSource(null);}}
    }catch{if(mounted.current&&ticket===generation.current)setError('소스 상태를 확인하지 못했습니다. 작업 공간과 서버 연결을 확인하세요.');}
  }
  useEffect(()=>{if(online)void load();return()=>{generation.current++;};},[workspaceId,online]);
  async function act(artifact=false){
    if(sending.current||locked||!online||(artifact&&(!view?.record||view.freshness!=='current')))return;
    sending.current=true;setBusy(true);setError('');setMessage('');const ticket=++generation.current;
    try{
      if(artifact){await mutate(base+'/artifact',{recordId:view!.record!.id,expectedSourceDigest:view!.record!.graph.sourceDigest});if(mounted.current)setMessage('소스 기준이 기록된 Artifact를 저장했습니다. 시각화 스튜디오의 저장 기록을 다시 불러와 PPTX·Markdown으로 내보낼 수 있습니다.');}
      else{const value=await post(base,{}) as SourceGraphView;if(mounted.current&&ticket===generation.current){sourceGeneration.current++;setSource(null);setSelected('');setView(value);}}
    }catch{if(mounted.current){setError('요청 결과를 확인하지 못했습니다. 민감 경로·파일 제한·소스 변경·실행 상태를 확인한 뒤 새로고침하세요.');await load();}}
    finally{sending.current=false;if(mounted.current)setBusy(false);}
  }
  async function readFile(id:string){
    setSelected(id);setSource(null);setError('');const ticket=++sourceGeneration.current;if(!id||!view?.record)return;
    try{const response=await fetch(base+'/files/'+encodeURIComponent(id)+'?recordId='+view.record.id);if(!response.ok)throw new Error();const value=await response.json() as SourceFileView;
      if(mounted.current&&ticket===sourceGeneration.current)setSource(value);
    }catch{if(mounted.current&&ticket===sourceGeneration.current)setError('파일을 열 수 없습니다. 소스가 바뀌었다면 먼저 다시 분석하세요.');}
  }
  const record=view?.record,graph=record?.graph,files=graph?.nodes.filter(node=>node.kind==='file')??[],symbols=graph?.nodes.filter(node=>node.fileId===selected&&node.kind!=='file')??[];
  return <section className="surface source-graph-panel" aria-busy={busy}>
    <div className="section-heading"><h2>소스 그래프와 변경 영향</h2><div className="actions"><button disabled={!online||busy} onClick={()=>void load()}>그래프 상태 새로고침</button><button disabled={!online||locked||busy} onClick={()=>void act()}>현재 소스 분석</button></div></div>
    <p>로컬 TypeScript 분석기로 JS·TS 파일, 함수·클래스, import·호출·상속 관계를 읽습니다. 외부 패키지와 동적 실행은 추적하지 않습니다. 영향 목록은 잠재적인 정적 의존 관계이며 테스트 성공을 뜻하지 않습니다.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message} <button onClick={onVisualize}>시각화 스튜디오 열기</button></p>}
    <p className="badge">{view?freshness[view.freshness]:online?'소스 상태 확인 중…':'서버 연결 필요'}</p>
    {graph&&record&&<>
      <p className="subtle">TypeScript {graph.analyzer.version} · {new Date(record.createdAt).toLocaleString('ko-KR')} · 소스 {graph.sourceDigest.slice(0,12)}</p>
      <div className="metric-grid"><article><span>분석 파일</span><strong>{graph.coverage.files}</strong><small>비지원·삭제 파일 {record.excludedFileCount}개 제외</small></article><article><span>변경 파일</span><strong>{graph.changedFileIds.length}</strong><small>기준 커밋 대비</small></article><article><span>잠재 영향 파일</span><strong>{graph.impact.fileIds.length}</strong><small>변경 파일 포함</small></article><article><span>미확인 관계</span><strong>{graph.unresolved.total}</strong><small>전체 관계를 보장하지 않음</small></article></div>
      <details><summary>분석 한계와 미확인 관계</summary><p>최대 100개 JS·TS 파일, 파일당 256 KiB, 합계 4 MiB. 저장소 설정·빌드·플러그인을 실행하지 않습니다. Git ignored 의존성은 소스 해시에 포함하지 않습니다.</p><ul>{Object.entries(graph.unresolved.byReason).filter(([,count])=>count>0).map(([reason,count])=><li key={reason}>{reasons[reason as keyof typeof reasons]}: {count}</li>)}</ul></details>
      {record.diagram?<details open={files.length<=12}><summary>파일 의존 다이어그램</summary><ArchitecturePreview graph={record.diagram}/></details>:<p>다이어그램은 1~100개 파일과 최대 300개 import 관계에서 제공합니다. 아래 분석 결과는 별도로 유지됩니다.</p>}
      <button disabled={!online||locked||busy||view?.freshness!=='current'||!record.diagram} onClick={()=>void act(true)}>소스 다이어그램을 Artifact로 저장</button>
      <label className="source-file-select">소스 파일 탐색<select aria-label="소스 파일 탐색" value={selected} disabled={view?.freshness!=='current'||busy} onChange={event=>void readFile(event.target.value)}><option value="">파일 선택</option>{files.map(file=><option key={file.id} value={file.id}>{file.path}{file.changed?' · 변경':''}{graph.impact.fileIds.includes(file.id)?' · 잠재 영향':''}</option>)}</select></label>
      {selected&&<><ul className="record-list">{symbols.map(node=><li key={node.id}><div><b>{node.label}</b><p>{kinds[node.kind]} · {node.line}행 · 연결 {graph.edges.filter(edge=>edge.kind!=='contains'&&(edge.from===node.id||edge.to===node.id)).length}개</p></div></li>)}</ul>
        {source&&<details className="source-preview" open><summary>{source.path} 원문 미리보기</summary>{source.redacted&&<p>일부 인증정보 패턴이 가려졌거나 표시 길이가 제한됐습니다. 모든 비밀정보 탐지를 보장하지 않습니다.</p>}{source.truncated&&<p>64,000자까지 표시합니다.</p>}<pre><code>{source.text}</code></pre></details>}
      </>}
    </>}
  </section>;
}
