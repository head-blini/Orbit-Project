import type {Snapshot} from '../shared/types.ts';
import {NewTaskPanel} from './new-task.tsx';
import {ProjectCreatePanel} from './project-create.tsx';

type Props={state:Snapshot|null;projectId:string;online:boolean;locked:boolean;post:(path:string,body:object)=>Promise<any>;
  onOpenProject:(id:string)=>void;onProject:(id:string)=>void;workspaceAction:(fn:()=>Promise<void>)=>Promise<void>};
const kindLabel={general:'일반 작업',code:'코드 작업'} as const;
const date=(value:string)=>{const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';};

/** Home: always a new natural-language task first, regardless of the selected project. */
export function HomePage(props:Props){
  const {state,online,locked}=props;
  const projects=[...(state?.projects??[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return <div className="home">
    <section className="home-hero" aria-labelledby="home-title">
      <span className="eyebrow">NEW TASK</span>
      <h2 id="home-title">무엇을 만들거나 해 보고 싶으세요?</h2>
      <p>자연어로 요청하면 기획을 함께 확인하고, 승인한 기준대로 AI가 실행해 결과물을 만듭니다. Git이나 개발 지식은 필요하지 않습니다.</p>
      {!state?<p className="home-empty">서버에 연결하는 중입니다…</p>
        :state.projectCreationAvailable?<NewTaskPanel online={online} locked={locked} post={props.post} onProject={props.onOpenProject}/>
        :<p className="notice" role="alert">현재 서버에서 새 프로젝트를 준비할 수 없습니다. 서버 설정을 확인하세요.</p>}
    </section>
    <section className="home-recent" aria-labelledby="recent-title">
      <div className="home-section-head"><h3 id="recent-title">최근 프로젝트</h3>{projects.length>6&&<span>{projects.length}개 중 최근 6개</span>}</div>
      {!state?<p className="home-empty">불러오는 중…</p>:projects.length?<ul className="recent-list">{projects.slice(0,6).map(project=><li key={project.id}>
        <button className={'recent-item'+(project.id===props.projectId?' current':'')} onClick={()=>props.onOpenProject(project.id)} title={project.name}>
          <span className="recent-name">{project.name}</span>
          <span className="recent-meta"><span className={'kind kind-'+project.kind}>{kindLabel[project.kind]}</span>{date(project.createdAt)}{project.id===props.projectId?' · 현재 선택':''}</span>
        </button></li>)}</ul>
        :<p className="home-empty">아직 프로젝트가 없습니다. 위에서 첫 작업을 시작하세요.</p>}
    </section>
    {state?.projectCreationAvailable&&<details className="home-code">
      <summary>코드 작업(Git 저장소) 프로젝트 만들기</summary>
      <p>프로그램 코드를 실제로 실행·테스트하려면 Git 저장소와 격리 작업 공간이 있는 코드 프로젝트를 사용합니다.</p>
      <ProjectCreatePanel projectId={props.projectId} projectCount={state.projects?.length??0} selectedWorkspaceId={state.selectedWorkspaceId??null} online={online} locked={locked} onProject={props.onProject} action={props.workspaceAction} post={props.post}/>
    </details>}
  </div>;
}
