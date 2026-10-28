import type {Snapshot} from '../shared/types.ts';
import type {PageId} from './navigation.ts';
import {DeliverablesPanel} from './deliverables.tsx';
import {useUiMode} from './ui-mode.ts';

/** Files a project produced, with the same layered checks as the progress board. */
export function ResultsPage({state,projectId,online,onNavigate}:{state:Snapshot|null;projectId:string;online:boolean;onNavigate:(page:PageId)=>void}){
  const project=state?.projects?.find(item=>item.id===projectId),advanced=useUiMode()==='advanced';
  if(!state)return <section className="work-empty"><p>불러오는 중…</p></section>;
  if(!project)return <section className="work-empty"><h2>프로젝트를 먼저 고르세요</h2><p>결과물은 프로젝트별로 보관됩니다.</p><button className="primary" onClick={()=>onNavigate('projects')}>프로젝트 열기</button></section>;
  if(project.kind==='code')return <section className="work-empty"><h2>{project.name}</h2><p>코드 프로젝트의 결과는 작업 공간의 변경 파일과 앱 미리보기로 확인합니다.</p>
    {advanced?<button className="primary" onClick={()=>onNavigate('development')}>코드와 변경 보기</button>:<p className="work-muted">설정에서 고급 모드를 켜면 ‘개발’ 화면에서 변경 파일을 볼 수 있습니다.</p>}</section>;
  return <div className="results-page"><DeliverablesPanel key={projectId} projectId={projectId} online={online} lastSeq={state.lastSeq}/></div>;
}
