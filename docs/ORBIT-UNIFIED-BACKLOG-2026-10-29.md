# Orbit — 통합 개발 백로그 (2026-10-29)

## 기준과 증거 수준
- 원격 기준선 `9dda330`; 로컬 보고: QG-UI `b5cf0bc`, QG-01 `e5d6454`, 통합 `57b58c1`, 후속 UI 연결 `fecf6ff`.
- 사용자 보고에 따른 검증: `claude/qg-integration` Node 24.22.1 `npm run verify`: 1411 tests, 1409 pass, 0 fail, 2 skip. **이 채팅 세션에서 재검증한 결과는 아님.**
- `/codex` Skill: 로컬 `.claude/skills/codex/`에 존재한다는 사용자 보고. 실 신규 실행/resume 각각 exit 0. Git에서 미추적일 수 있으므로 명시적 보존/비밀정보 점검 필요.
- 상태 분류: implemented, mock-tested, native-tested, integrated-tested, blocked, unverified. 위계가 자동 완료로 이어지지 않음.

## 우선순위·의존 관계
| 순번 | ID | 작업 | 선행 | 완료 증거 |
|---|---|---|---|---|
| 0 | INT-QG | QG-01/QG-UI-01 로컬 통합 상태 재확인 후 `codex/orbit-mac-handoff-2026-10-26`에 안전 통합 | Worktree status, 차이·충돌 검사 | 병합 커밋 및 Node24 전체 verify, 기존 사용자의 변경 보존 |
| 1 | LIVE-CLI | 승인된 임시 fixture에서 Claude Code, Codex 구독 CLI 각 최소 1회 Orbit Runtime 경유 E2E | INT-QG, 공식 명령·CLI 준비 | 실행/세션/기준/결과/종료·모델관측·중복/권한 분리 증거 |
| 2 | CORE-LIVE | 독립 교차 리뷰, `modelId: null` 및 Codex 관측 제약, 인계/재시작 복구 보완 | LIVE-CLI | 실제 관측이 없는 항목은 blocked 유지, 검토 결과와 수정·재검증 증거 |
| 3 | REGISTRY | 사용자 모델/제공자/실행기 Registry 등록·검증·비활성화 | 기본 Core contracts | 타입별 인증·capability·비용 및 사용자 UI CRUD, 회귀 |
| 4 | GPT-EXCHANGE (**deferred** 2026-10-29: 1차 실사용 보류, 코드·설계 보존) | ChatGPT 웹 요청·응답의 허용된 구조화 인계 | 승인/기준/인계 | 실제 연결 증거, 불가 시 blocked; 무단 API 전환 금지 |
| 5 | USAGE | Codex/Claude/GPT 다중 계정의 잔여 구독 한도 | provider 관측 | 출처/시점/공유 pool/unknown, API 비용과 구분 |
| 6 | TG | 승인된 Task DAG 및 작업 계약·상태 | QG 및 기준 계약 | 순환/버전/차단·stale·작업 유형 테스트 |
| 7 | PW | 기능 중심 병렬 Worker, 자원 소유권, 통합 큐 | TG, runtime 격리 | 실제 중첩 실행·충돌/재시작/병합 검증 |
| 8 | CQG | lint/아키텍처/계약/통합/E2E 종합 게이트 | QG, TG, PW | 검증 증거 커밋/산출물 hash 결속, no bypass |
| 9 | FE | 실패 Trace·재현 Eval·근본 원인 | CQG | 독립 실패 사례, 실패군 근거·비밀정보 비노출 |
| 10 | HE | Harness Evolution 후보·보호 평가·제한 자동 승격·롤백 | FE | 문제 재현/정상 회귀/롤백/정책 보호 테스트 |
| 11 | TOOLS | Skills/MCP/Plugins/Hooks/Subagents 검증된 선택·호출 | Registry, sandbox | 설치/권한/실행과 실검증 별도 집계 |
| 12 | PRODUCT | Graphify, UI/간편·고급, 파일 결과·버전·내보내기, Goal 범용 증거 | 상관 계약 | 코드/비코드 사용자 E2E, A01~A16/AX01~AX07 증거 |

독립적인 UI·Registry·도구 메타데이터 작업은 계약을 먼저 고정하고 별도 Worktree에서 병렬화할 수 있다. 실행기 종류가 아니라 작업 독립성으로 병렬화한다.

## 즉시 실행: INT-QG
1. 모든 worktree와 root `git status --short --branch`, `git log`, 변경·미추적 파일 확인. 기존 작업 보존. 실패 시 임의 reset/clean 금지.
2. `claude/qg-integration`의 최종 변경을 현재 기준 브랜치와 비교. 이미 포함되면 중복 병합하지 않는다.
3. 로컬에서 안전한 fast-forward 또는 승인된 비파괴 merge. 새로 생긴 충돌은 계약/테스트 확인 후 해결. main 수정 금지.
4. Node24 `npm run verify` 및 브라우저/결과물 검사. 이전 숫자를 현재 통과라고 재사용하지 않는다.
5. 로컬 커밋, 상태 기록. Push 금지.

## 즉시 실행: LIVE-CLI (INT-QG 이후)
1. CLI 버전·현재 구독 인증 상태는 비밀정보를 읽지 않고 확인. 설치/로그인 변경 금지.
2. 별도 임시 프로젝트·허용된 쓰기 경로에서 **비민감한 텍스트 파일 생성과 정확한 문자열 검증**을 최소 E2E로 한다. 성공 판단에는 실제 제공자 호출·실제 산출물·실제 종료를 포함한다.
3. Claude `execute.general`과 Codex `execute.code`는 각각 Orbit Runtime Adapter 경로로 실행한다. Claude가 외부에서 `codex exec`를 호출한 성공은 Orbit Runtime E2E와 별도로 기록.
4. 각 기록: provider/runtime, runId, sessionId, requestId, 기준 digest, observed model (없으면 null), native/mock/unknown, artifact sha, exit status, interruptions, permission boundaries.
5. `quality_blocked` 또는 `model unknown`은 그대로 보존하고 Reviewer 통과로 승격하지 않는다. 각각 최소 1건을 넘어서는 호출은 필요성과 구독 한도를 검토.
6. 인증·정책·quota·환경으로 막히면 차단 원인과 재개 지점 보존. 유료 API fallback·외부 Push 금지.

## Claude Code 개발 운영
- Claude Code는 **개발 오케스트레이터**다. Orbit 제품 자체는 provider-neutral.
- `/codex` Skill 안전성·멱등성·증거를 확인하고, 사용자의 로컬 미추적 설정을 잃지 않게 보존한다.
- Task Graph/Scheduler 및 DB/공통 타입은 단일 소유자, UI 등 독립 파일은 별도 worker. 작업별 수용 조건을 고정한 뒤 실행.
- 각 Sprint 완료 후 현재 HEAD, 변경 파일, 테스트(개수/exit), native/mock, 남은 차단, 다음 실행 가능 Task, 실제 commit SHA를 기록. 정지·한도 소진 시 자동 재개를 약속하지 않는다.
