import type { Project, Snapshot } from '../shared/types.ts';

export const pages = [
  {id:'start', label:'새 작업', name:'New task', icon:'bolt', group:'main', description:'하고 싶은 일을 자연어로 요청하면 기획부터 결과물까지 이어갑니다.'},
  {id:'dashboard', label:'대시보드', name:'Dashboard', icon:'dashboard', group:'main', description:'프로젝트와 현재 작업 상태를 한눈에 확인하세요.'},
  {id:'progress', label:'진행 현황', name:'Progress', icon:'chart', group:'main', description:'프로젝트·작업·실행의 현재 단계, 담당 AI, 대기 이유와 검증 결과를 확인하세요.'},
  {id:'projects', label:'프로젝트', name:'Projects', icon:'folder', group:'main', description:'프로젝트의 목표·기획·실행·결과물을 한 화면에서 이어가세요.'},
  {id:'results', label:'결과물', name:'Results', icon:'plan', group:'main', description:'프로젝트에서 만든 파일과 확인 결과를 열어 보세요.'},
  {id:'planning', label:'기획 스튜디오', name:'Planning Studio', icon:'plan', group:'main', description:'기획안을 작성하고 저장·승인한 뒤 Task 초안으로 연결하세요.'},
  {id:'agents', label:'에이전트 센터', name:'Agent Center', icon:'agent', group:'main', description:'Codex 대화와 실행 상태를 관리하세요.'},
  {id:'development', label:'개발', name:'Development', icon:'code', group:'main', description:'작업 공간의 브랜치와 변경 파일, Git Diff를 검토하세요.'},
  {id:'visualization', label:'시각화 스튜디오', name:'Visualization Studio', icon:'diagram', group:'main', description:'Mermaid와 구조 문서를 미리 보고 Artifact로 보존하세요.'},
  {id:'automation', label:'자동화', name:'Automation', icon:'bolt', group:'main', description:'반복 작업과 실행 흐름을 위한 공간입니다.'},
  {id:'providers', label:'모델 제공자', name:'Model Providers', icon:'provider', group:'manage', description:'Codex와 설정된 HTTP 모델 목적지의 지원 범위·전송 조건을 확인하세요.'},
  {id:'extensions', label:'확장 기능', name:'Extensions', icon:'extension', group:'manage', description:'MCP · Skills · Plugins'},
  {id:'security', label:'개인정보 및 보안', name:'Privacy & Security', icon:'shield', group:'manage', description:'현재 적용된 반출 제한과 실행 보호 정책을 확인하세요.'},
  {id:'usage', label:'사용량 및 분석', name:'Usage & Analytics', icon:'chart', group:'manage', description:'프로젝트 실행·토큰 관측·검증 기록과 Codex 계정 전체 사용량을 구분해 확인하세요.'},
  {id:'settings', label:'설정', name:'Settings', icon:'settings', group:'manage', description:'간편·고급 모드와 현재 인터페이스 설정을 확인하세요.'},
] as const;
export type PageId = typeof pages[number]['id'];
export function parsePage(hash:string):PageId {
  const value=hash.replace(/^#\/?/,'');
  return pages.find(page=>page.id===value)?.id??'start';
}
export const projectPreferenceKey='orbit.ui.project';
export const readOnlyPreference='__readonly__';
export function readPreference(storage:Pick<Storage,'getItem'>|undefined,key:string):string {
  try{return storage?.getItem(key)??'';}catch{return '';}
}
export function writePreference(storage:Pick<Storage,'setItem'>|undefined,key:string,value:string):void {
  try{storage?.setItem(key,value);}catch{/* Navigation still works when browser storage is disabled. */}
}
export function resolveProject(projects:readonly Project[],preferred:string,state:Snapshot|null):string {
  if(preferred===readOnlyPreference&&!state?.selectedWorkspaceId)return '';
  if(projects.some(project=>project.id===preferred))return preferred;
  const workspace=state?.workspaces?.find(workspace=>workspace.id===state.selectedWorkspaceId);
  return projects.find(project=>project.id===workspace?.projectId)?.id??projects[0]?.id??'';
}
export function workspaceMatchesProject(state:Snapshot|null,projectId:string):boolean {
  if(!state)return false;
  if(!projectId)return !state.selectedWorkspaceId;
  return state.workspaces?.some(workspace=>workspace.id===state.selectedWorkspaceId&&workspace.projectId===projectId&&workspace.status==='ready')??false;
}
export const executionLabels:Record<string,string>={starting:'시작 중',running:'응답 중',interrupting:'중단 요청 중',completed:'응답 완료',interrupted:'중단됨',failed:'실패',lost:'연결 유실 · 결과 미확인'};
export const providerLabels:Record<string,string>={disconnected:'연결 안 됨',connecting:'연결 중',ready:'Codex 연결됨',auth_required:'ChatGPT 로그인 필요',not_installed:'Codex 설치 필요',error:'연결 오류'};
