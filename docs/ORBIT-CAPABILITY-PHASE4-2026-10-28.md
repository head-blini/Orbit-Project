# Phase 4 — 실제 Codex E2E 검증

기준 `c5400c28972a69e9907eb3ccff36b900a9bcef3f`. 사용자가 이번 대화에서 Codex 최소 실제 작업과 제한적 재시도를 승인했다. 운영 DB 대신 격리 SQLite·임시 Git 저장소·Orbit managed worktree를 사용했다. 실제 실행 1건, Orbit 재시도 0건, reviewer 실행 0건이다. 공급자 내부 네트워크 요청/재시도 횟수는 관측하지 않았다.

## 실제 검증 결과

- Codex CLI `0.165.0`, 공식 App Server, 기존 구독 인증 확인과 sandbox/MCP 격리 검사를 통과했다. 인증파일·자격증명을 읽거나 출력하지 않았다.
- 수동 기획 → 승인 → Task → 자연어 기능 선택 → Planner → digest 승인 → 실제 Controller 실행 → DB → HTTP → 진행판 흐름을 통과했다. 추가 기획 모델은 호출하지 않았다.
- 결과: `result.txt`에 정확히 `ORBIT_NATIVE_SMOKE\n`. SHA-256 `29519dcfb3a2b7c87f49961d2cafdcc08935529695d58a90d759b12d4b0b691a`.
- managed worktree의 Git 변경은 `?? result.txt`뿐이다. 원본 저장소는 clean, source/worktree HEAD는 동일하다. 운영 프로젝트·원본 파일 변경과 커밋·병합은 모델에 허용하지 않았다.
- 전체 HTTP 검증 10,034ms, run.created→run.completed 7,703ms. 실제 종료 상태 completed. 별도 비용·잔여 할당량은 unknown이며 소요 시간으로 추정하지 않았다.
- 실행 전/후 같은 승인 요청을 반복해도 같은 Run을 반환하고 DB Run 수는 1개다. GET execution/progress는 journal을 변경하지 않았다.
- 진행판 API의 실행 증거가 실행 상세와 동일함을 확인했다. 저장된 **실제** 실행 기록을 기존 UI 컴포넌트로 Chrome 렌더링하여 native·actual unknown·독립 리뷰 차단·전체 품질 검증 대기 표시를 확인했다. 새 모델 호출은 없었다.

## 모델 식별과 Quality Loop

사용자 선택 모델 null, 요청 모델 null, 서버 설정 모델 `gpt-6-astra`, 실제 관측 모델 **unknown**. 서버 설정값을 실제 모델로 승격하지 않았다.

기존 Quality Loop가 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 차단되었고 steps는 0개다. 독립성이 확인되지 않은 리뷰는 실행·완료 처리하지 않았다. `providerEvidence.source=native`, `executionObserved=true`, `livePipelineVerified=false`. 실제 파일 실행과 전체 품질 승인 성공은 다른 결과다.

## 재시작 검증에서 발견한 결함

최초 검증 스크립트는 Store 재열기만 확인했다. 별도 실제 DB 복사본으로 Controller/HTTP 서버 재시작을 검사하자, raw planner 상태 running을 근거로 이미 completed인 Run도 recoveryRequired로 분류했다. 자동 재실행은 없었지만 완료 작업이 다음 실행을 불필요하게 차단할 수 있었다. 원래 dispatch의 ID·runtime·task·프로젝트/workspace·baseline·acceptance가 모두 일치하는 completed/failed/interrupted Run만 종료로 인정하도록 최소 수정했다. lost·실행 중·receipt 불일치는 계속 격리한다. 생성자와 명시적 복구가 이 검증을 공유한다.

최초 실패 증거: `/private/tmp/orbit-restart-copy-c5wUX6/restart-check.json`. 원본 DB는 수정하지 않았다. 수정 후 `/private/tmp/orbit-restart-copy-WiHGBf/restart-check.json`에서 full Controller/HTTP 재시작을 확인했다: quality_blocked, recoveryRequired=false, 실제 모델 unknown, Run 1개, Provider 실행 0회, GET 무부작용, 원본 DB SHA-256 불변. 실제 모델을 다시 호출하지 않았다.

## Claude Code 탐색

PATH·일반 설치 경로·fnm/nvm bin 등 32개 후보에서 실행파일을 찾지 못했다. `findClaude()`는 `CLAUDE_NOT_INSTALLED`다. 사용자 Applications의 Claude Code URL Handler 앱은 있으나 실행 링크가 존재하지 않는 `~/.local/bin/claude`를 가리킨다. Homebrew·/usr/local·Node24 npm 패키지 후보에도 CLI가 없었다.

확인 범위에서는 인증 문제가 아니라 CLI 대상 누락이다. 시스템 전체 미설치를 단정하지 않는다. 설치·로그인·인증 변경 및 Claude 모델 호출은 수행하지 않았다.

## 증거와 재현 경계

- [영속 증거 요약](evidence/phase4-native-e2e-2026-10-28.json): 실제 실행 식별자, 모델 근거, digest, event metadata, 품질 차단. Mock fixture가 아니다.
- `/private/tmp/orbit-phase4-X9bcYu`: 실제 SQLite와 worktree, 상세 evidence.json, UI HTML 보존. 임시 경로는 OS 정리에 의해 사라질 수 있다. 상세 Run에는 정제된 고정 프롬프트·응답이 포함되며 자격증명은 포함하지 않는다.
- `scripts/phase4-native-e2e.ts --approved-live`: 명시 승인용 수동 재현 스크립트. 자동 test/build에서 실행되지 않는다. **이번 승인 없이 후속 호출을 자동 반복하지 않는다.** 이미 실행된 증거를 검증할 때는 DB 복사본을 사용한다.
- 실제 Provider 장애·인증 실패·한도 소진·실행 중 강제 중단은 추가 호출을 피하기 위해 유도하지 않았다. 이 경로는 기존 Mock 회귀 검증 결과와 구분한다.

## 다음 단계

독립 모델 근거가 확보되기 전까지 Quality Loop 차단을 유지한다. Claude가 필요하면 정확한 실행파일 경로를 받거나 별도 설치 승인을 요청한 후 같은 제한된 실검증을 수행한다. 외부 MCP/Skill/Hook 실행, 설치, 인증 변경, Push·배포·main 병합은 이번 작업에 포함하지 않는다.

## 최종 검사와 변경 범위

- Node24.22.1 `npm run verify`: **1361 tests / 1359 pass / 0 fail / 2 Windows-only skip**, exit0. TypeScript·build 통과 (`/tmp/orbit-phase4-release.log`).
- 수동 실검증 스크립트 별도 strict TypeScript 검사 통과. 승인 flag 없는 실행은 Provider 호출 전에 거절됨을 확인. 실제 실행은 최초 1건이며 이후 스크립트의 후처리 assertion을 보강하고 저장된 파일·DB로 확인했다.
- 기존 UI의 실제 기록 Chrome 렌더링 통과. Mock 회귀 테스트 결과와 실제 증거를 별도 저장했다.
- 제품 코드 변경은 `server/capability-execution.ts`의 재시작 receipt 검증뿐이며 `tests/capability-execution.test.ts`에 회귀 3개를 추가했다. 나머지는 수동 검증 스크립트·상태 문서·실제 증거다.
- `git diff --check` 통과. 사용자 `.DS_Store` 두 파일 보존·제외. Push·배포·main 병합 없음.
