import {useEffect,useRef,useState} from 'react';
import type {ReuseVendorDecision,ReuseVendorView} from '../shared/reuse-vendor.ts';

export function ReuseVendorList({view,busy,disabled,error,onImport}:{view:ReuseVendorView;busy:boolean;disabled:boolean;error:string;onImport:(decision:ReuseVendorDecision)=>void}){
  return <section className="surface" aria-label="재사용 구성요소">
    <div className="section-heading"><h2>재사용 구성요소</h2></div>
    {error&&<p role="alert">{error}</p>}
    {!view.decisions.length?<p className="subtle">현재 승인된 기획에 채택된 재사용 구성요소가 없습니다.</p>:<ul className="record-list">{view.decisions.map(decision=>{
      const entry=view.evidence.entries.findLast(item=>item.sourceDecision===decision.topic&&item.planningVersionId===decision.planningVersionId);
      return <li key={decision.planningVersionId+decision.topic}><div><b>{decision.topic}</b><p>{decision.decision}</p>
        <button disabled={busy||disabled} aria-label={`${decision.topic} 재사용 구성요소 가져오기`} onClick={()=>onImport(decision)}>재사용 구성요소 가져오기</button>
        {entry&&<><ul aria-label={`${decision.topic} 가져온 파일`}>{entry.files.map(file=><li key={file.path}><code>{file.path}</code> · sha256 {file.sha256.slice(0,12)} · {file.bytes} bytes</li>)}</ul>
          <small>라이선스 {entry.license.decision} · package.json {entry.license.package??'라이선스 필드 없음'} · {entry.licenseFile==='license_file:absent'?'LICENSE 파일 없음 (license_file:absent)':entry.licenseFile} · 출처 {entry.sourceUrl} · 확인 {entry.checkedAt}</small></>}
      </div></li>;})}</ul>}
    <p className="subtle">승인된 기획의 채택 결정만 jsDelivr에서 고정 버전으로 가져와 작업 공간의 vendor/ 폴더에 저장합니다.</p>
  </section>;
}

export function ReuseVendorPanel({workspaceId,online,locked,refreshKey,post}:{workspaceId:string;online:boolean;locked:boolean;refreshKey:string;post:(path:string,body:object)=>Promise<unknown>}){
  const [view,setView]=useState<ReuseVendorView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),base='/api/workspaces/'+workspaceId+'/reuse-vendor';
  async function load(ticket:number){
    try{const response=await fetch(base);const value=await response.json();if(!response.ok)throw new Error(value.error);if(ticket===generation.current){setView(value as ReuseVendorView);setError('');}}
    catch(error){if(ticket===generation.current){setView(null);setError('재사용 구성요소 상태를 불러오지 못했습니다: '+((error as Error).message||'REQUEST_FAILED'));}}
  }
  useEffect(()=>{const ticket=++generation.current;setView(null);setError('');if(online&&!locked)void load(ticket);return()=>{generation.current++;};},[workspaceId,online,locked,refreshKey]);
  async function importDecision(decision:ReuseVendorDecision){
    const ticket=generation.current;setBusy(true);setError('');
    try{await post(base,{planningVersionId:decision.planningVersionId,topic:decision.topic});await load(ticket);}
    catch(error){if(ticket===generation.current)setError('재사용 구성요소를 가져오지 못했습니다: '+(error as Error).message);}
    finally{setBusy(false);}
  }
  if(!view)return error?<section className="surface" aria-label="재사용 구성요소"><p role="alert">{error}</p></section>:null;
  return <ReuseVendorList view={view} busy={busy} disabled={!online||locked} error={error} onImport={decision=>void importDecision(decision)}/>;
}
