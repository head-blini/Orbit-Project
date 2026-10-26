import { EXECUTION_MODES,type ExecutionMode } from '../shared/execution-modes.ts';

const descriptions:Record<ExecutionMode,string>={
  solo:'선택한 worktree의 단일 Codex 세션으로 실행합니다. 현재 프롬프트·Task 실행 경로를 사용하며 모드별 예산·검증 gate 통합은 남아 있습니다.',
  cross_review:'구현 후 별도 읽기 전용 세션에서 검토합니다. 다른 AI가 없으면 같은 제공자의 독립 세션임을 표시합니다.',
  debate:'읽기 전용 참가자들이 정해진 회수 안에서 근거와 반론을 비교합니다. 합의되지 않은 질문은 남기고 사용자가 계획을 승인합니다.',
  race:'독립 worktree에서 같은 승인 요구사항·기준 커밋·테스트·E2E로 경쟁합니다. 증거가 부족하면 비교 불가, 모두 통과하면 동률입니다.',
  cooperate:'내장 서브에이전트로 역할과 파일 소유권을 나눕니다. 공유 Controller·DB·타입은 한 명이 맡고 순서대로 통합·검증합니다.',
  goal:'공식 native Goal과 예산·중단 조건을 재사용합니다. 모델의 달성 판단과 실제 검증·사용자 승인을 따로 기록합니다.',
};
export function ExecutionModes(){
  return <details className="surface capability-panel">
    <summary><b>실행 모드</b> · Solo 실행 경로 연결 · 나머지 모드 미연결</summary>
    <p className="subtle">미연결 모드는 실행하지 않습니다. 모든 모드에서 비용·사용량 상한과 권한을 확인하고, 실행 완료와 검증 성공을 구분합니다.</p>
    <ul className="capability-list">{EXECUTION_MODES.map(mode=><li key={mode.id}><div><b>{mode.name}</b><span className="badge">{mode.connection==='existing_codex_runner'?'기존 Codex 경로':'미연결'}</span></div><p>{descriptions[mode.id]}</p></li>)}</ul>
    <p className="subtle">경쟁 결과는 속도나 AI의 자기평가로 선정하지 않습니다. 검증된 변경의 통합에도 사용자 승인이 필요합니다.</p>
  </details>;
}
