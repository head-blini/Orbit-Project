# Phase 5 — Multi-Provider Runtime 및 Capability 연결

기준 커밋 `0433529512fce809ecf213ece2471b785df63194`. 기존 Registry/Discovery/Router, Controller/ClaudeTaskService, 승인 digest, Quality Loop와 DB·HTTP·진행판을 재사용한다. 설치·인증 변경·외부 확장 실행을 수행하지 않는다.

## 구현 범위

- 공통 `RuntimeOperationObservation`: runtime/project/run/task, 실행 상태, journal상 terminal과 작업 정지 확인, 완료된 정제 응답, 실제/Mock Provider 증거. 새 실행기나 Provider polling engine을 만들지 않는다. `lost`는 journal상 종결이지만 정지 확인은 false다.
- `CapabilityRuntimeAdapters.observe`와 `interrupt`가 runtime·project 소유권을 확인한다. Adapter 비활성화·버전 변경 후에도 기존 실행을 조회·중단할 수 있다. 실행 중·미확인 상태에는 완료 응답을 공개하지 않는다.
- 자연어 `실행 상태 조회`, `결과 수집`, `실행 중단`을 각각 status/result/interrupt로 분류한다. UI에서 대상 Run을 명시 선택해야 하며, 대상 실행의 원래 Provider·baseline을 저장한다. 현재 프로젝트 설정을 바꿔도 다른 Provider로 조용히 전환하지 않는다. 모호한 대상은 확인 필요, 지원하지 않는 extension/subagent 명령은 차단한다.
- `capability_invocations`에 명시 승인·대상·digest·원래 요청 ID·결과 snapshot을 저장한다. 중단 전 intent를 영속화하며 중복 요청·재시작이 중단 신호를 다시 전송하지 않는다. 중단 요청 접수는 정지 확인과 구분한다. 응답 불명확 시 unknown을 유지하며 자동 재시도하지 않는다.
- HTTP `GET/POST /api/projects/:id/capability-invocations`는 기존 session/CSRF/exact fields 경계를 사용한다. GET은 저장된 snapshot을 읽기만 한다. 최신 상태가 필요하면 상태 조회 추천을 새로 만들며 과거 기록을 현재 관측으로 바꾸지 않는다.
- 진행판에 대상 선택·기능 승인·결과 조회·중단 기록을 연결했다. 기능 표는 discovery/invocation/verification/정책/과거 native·mock·unknown 증거를 각각 표시한다. 지원 여부를 실제 검증 성공으로 승격하지 않는다.
- 역사적 실행 증거 집계는 완료된 task만 execute.code/general에 집계한다. 상태·결과 읽기는 새로운 Provider 모델 실행 건수로 집계하지 않는다. 모델 식별은 별도 assistant 관측 조건을 유지한다.

## 공식 계약과 Claude 차단 상태

[공식 계약·유형별 지원 행렬](ORBIT-CAPABILITY-PHASE5-CONTRACTS.md). Claude의 공식 print/stream-json 경로는 기존 Runtime Adapter에 이미 연결되어 있으며 인증 사전 확인·실행 직전 경로 확인·종료 관측을 재사용한다. PATH·일반 설치 위치·실행 권한·fnm/nvm 환경 후보32개 조사에서 CLI를 찾지 못했다. URL Handler의 링크 대상 `~/.local/bin/claude`도 존재하지 않는다. 설치가 확인되지 않아 인증 상태는 unknown이며 인증 명령이나 Claude 모델을 호출하지 않았다.

Slash/Skill/MCP/Hook/Subagent의 공식 프로그램 계약 존재 여부와 Orbit 권한은 별개다. 현재 외부 호출은 연결하지 않으며 임의 slash 문자열을 CLI task로 보내지 않는다. Codex extension metadata discovery와 기존 안전 설정을 유지한다. Claude 실제 E2E는 CLI 확보와 별도 모델 승인 전까지 blocked다.

## 검증 구분

1. **보존된 실제 증거의 회귀:** Phase4 실제 SQLite 복사본을 실제 Controller/HTTP로 열고 모델 factory를 금지했다. 자연어 상태·결과 추천→digest 승인→조회→기록 통과. native1/mock0, actual unknown, quality_blocked, GET 무부작용, Provider 호출0, 원본 DB 불변. `/private/tmp/orbit-phase5-history-z5q72E/evidence.json`.
2. **새 실제 Codex 회귀:** 승인된 최소 파일 생성 범위에서 기존 수동 E2E 스크립트 1회 실행. 결과 파일 내용/digest와 변경 파일 result.txt만 확인했다. Native 실행 8,857ms, 전체 10,472ms, Run 1개, 재시도0. `/private/tmp/orbit-phase4-h9Hmlk/evidence.json`에 실제 기록을 보존했다. Claude·추가 reviewer 호출 없음.
3. **Mock:** 두 Provider 공통 조회·결과·중단, 소유권·권한, 대상 불명확/미지원 요청, 중복·재시작·통신 불명확, Provider 설정 변경, 기존 인증/한도/복구 테스트를 구분한다. 새 기능 UI 브라우저 검증은 Mock HTTP다.

## 남은 제한

- Codex actual model unknown 및 `QUALITY_PRODUCER_MODEL_UNKNOWN` 차단 유지. 다른 독립성 기준으로 대체하지 않았다.
- 상태/result는 현재 Orbit journal을 관측하며 제공자에게 새 상태 API나 모델 호출을 보내지 않는다. 기록된 요청 결과는 그 시점의 snapshot이다.
- Claude가 설치되어 있다는 근거가 없으므로 실인증·실모델·실중단 검증은 미완료다. 설치/인증 변경 및 Claude 모델 호출은 별도 승인이다.
- 실제 Provider 장애/한도 소진/강제 중단은 이번 최소 호출에서 유도하지 않는다. 해당 경로의 검증은 Mock과 기존 계약 테스트다.
- 자연어 선택은 제한적인 로컬 분류이며 범용 의미 이해 모델이 아니다. 자동 Provider fallback·외부 확장 설치·호출을 하지 않는다.

## 최종 검증·파일 범위

- Node24.22.1 `npm run verify` exit0: **1381 tests / 1379 pass / 0 fail / 2 Windows-only skip**, TypeScript·build 통과 (`/tmp/orbit-phase5-verify.log`).
- 기능 영향70개, 신규 HTTP4개, UI24개 영향 검사 및 모의 Chrome 흐름 통과. 후속 UI 종결 표시·scope 격리·저장 requestId 재사용 회귀도 전체 검사에 포함했다.
- 독립 코드 검토에서 추가 주요 결함 없음. `git diff --check` 통과.
- [실제 실행/보존 증거 회귀 결과](evidence/phase5-provider-validation-2026-10-28.json)는 Mock 테스트와 구분한다. 실제 Codex 새 호출1, Claude0, reviewer0이다.
- 주요 파일: `server/capability-runtime-adapters.ts`, `capability-routing.ts`, `capability-invocation.ts`, `capability-validation.ts`, `capability-adapters.ts`, `http.ts`; 공통 shared 계약; `web/capability-routing.tsx`, `capability-invocation.tsx`, `capability-matrix.tsx`, `capabilities.tsx`; 해당 계약·HTTP·UI·보안 테스트. 기존 실행 엔진·Quality Loop의 독립성 정책을 바꾸지 않았다.
- 외부 설치·인증 변경·Push·배포·main 병합 없음. 사용자 .DS_Store 두 파일 보존·제외.
