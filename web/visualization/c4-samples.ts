import type {C4Diagram} from '../../shared/c4.ts';

const user={id:'user',kind:'person' as const,name:'사용자',description:'기획과 개발 결과를 검토합니다.',parentId:null,technology:null};
const orbit={id:'orbit',kind:'system' as const,name:'Orbit',description:'로컬 개발 작업과 결과를 관리합니다.',parentId:null,technology:null};
const codex={id:'codex',kind:'system' as const,name:'Codex CLI',description:'승인된 코딩 작업을 수행합니다.',parentId:null,technology:null};
const api={id:'api',kind:'container' as const,name:'로컬 서버',description:'프로젝트 요청과 실행 상태를 관리합니다.',parentId:'orbit',technology:'Node.js + TypeScript'};
const db={id:'db',kind:'container' as const,name:'프로젝트 저장소',description:'기획, 실행, 결과물의 버전을 보존합니다.',parentId:'orbit',technology:'SQLite'};

/** Local editable examples only. They neither inspect a repository nor contact an agent. */
export const c4Samples:Record<C4Diagram['view'],C4Diagram>={
  context:{format:'c4-v1',title:'Orbit 시스템 컨텍스트',view:'context',scope:'orbit',elements:[user,orbit,codex],relationships:[
    {id:'request',from:'user',to:'orbit',description:'기획과 개발 작업 요청',technology:null},
    {id:'execute',from:'orbit',to:'codex',description:'승인된 코딩 작업 전달',technology:null},
  ]},
  container:{format:'c4-v1',title:'Orbit 컨테이너',view:'container',scope:'orbit',elements:[user,orbit,
    {id:'web',kind:'container',name:'웹 UI',description:'기획, 실행, 검토 화면을 제공합니다.',parentId:'orbit',technology:'React'},api,db,codex],relationships:[
    {id:'review',from:'user',to:'web',description:'기획과 결과 검토',technology:null},
    {id:'request',from:'web',to:'api',description:'프로젝트 요청',technology:'HTTP'},
    {id:'persist',from:'api',to:'db',description:'기획과 실행 이력 보존',technology:'SQLite'},
    {id:'execute',from:'api',to:'codex',description:'작업 실행 요청',technology:'stdio JSON-RPC'},
  ]},
  component:{format:'c4-v1',title:'Orbit 로컬 서버 컴포넌트',view:'component',scope:'api',elements:[orbit,api,
    {id:'studio',kind:'component',name:'Studio 서비스',description:'기획과 결과물의 버전을 관리합니다.',parentId:'api',technology:'TypeScript'},
    {id:'runner',kind:'component',name:'실행 제어',description:'승인된 작업의 실행 상태를 관리합니다.',parentId:'api',technology:'TypeScript'},
    {id:'policy',kind:'component',name:'정책 검사',description:'실행 전 작업 범위와 권한을 검사합니다.',parentId:'api',technology:'TypeScript'},db,codex],relationships:[
    {id:'persist',from:'studio',to:'db',description:'결과물 버전 보존',technology:'SQLite'},
    {id:'handoff',from:'studio',to:'runner',description:'승인된 작업 전달',technology:null},
    {id:'authorize',from:'runner',to:'policy',description:'실행 범위 확인',technology:null},
    {id:'execute',from:'runner',to:'codex',description:'검사한 작업 실행',technology:'stdio JSON-RPC'},
  ]},
};
