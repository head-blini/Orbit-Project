# Orbit 개발 현황 (F01~F11)

- 기준: `ORBIT-SCOPE-2026-10-27` v1.1, 분담 `docs/ORBIT-COLLABORATION.md`
- 이 표는 개발 진행 기록이며 제품의 실시간 진행판을 대신하지 않는다.
- 표기: **구현** = 코드+자동 테스트 / **부분** / **미구현** / **실연동 미검증** / **차단**. 단위 테스트(fake/fixture)·브라우저 E2E·실제 AI 연동 증거를 구분한다.

## 기준선 (2026-10-28, macOS 26.6.2 arm64, Node 24.22.1, Codex 0.163.0, Claude Code 2.1.312)

HEAD `d39679e`: `npm ci` → `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` 1048 tests / 1046 pass / 0 fail / 2 Windows-only skip (exit 0, 121s). 브라우저 E2E 미실행(`agent-browser`·Playwright 미설치). 실제 AI 연동 미실행.

## 요구사항별 상태

| ID | 구현 상태 | 단위/통합 | 브라우저 | 실연동 | 관련 A | 증거 참조/시각 | 차단 이유 | 다음 행동 |
|---|---|---|---|---|---|---|---|---|
| F01 입력·AI 기획 | 부분: Codex 1턴 기획 제안·초안 저장. 수동 기획 작성·승인은 일반 프로젝트에서도 동작. **AI 기획 제안은 작업 공간(Git) 필요 → 일반 프로젝트에서 `GIT_REQUIRED`** | 있음(FakeRpc) | 2026-10-28 수동 기획→승인→Task (일반 프로젝트) | Codex 0.162.1 과거 1회, 0.163.0 미검증 | A01 | `server/codex-planning.ts`, `planning-agent-service.ts` | — | 기획 AI를 작업 공간 없이 읽기 전용으로 실행(Claude 어댑터 read 모드 또는 Codex 비작업공간 세션), 프로젝트별 기획 AI 선택 |
| F02 범용 프로젝트 | **구현**: `kind: general` 생성(폴더만, Git·worktree 없음), Git 전용 API `GIT_REQUIRED`, 브라우저 작업 종류 선택 | 일반 9 + UI 15 | **2026-10-28 Chrome: 생성→선택→기획 이동→수동 기획 저장·승인→Task 2개→진행판→서버 재시작 후 보존** | — | A01,A16 | `977a564`, `2c4f3b3` | — | 일반 프로젝트의 작업 실행(비코드 실행기 연결), 결과물 파일 저장 |
| F03 기준·변경 관리 | **대부분 구현**: 버전·승인·CAS·stale 거부·decisions, `nonGoals`(기존 해시 불변), Run에 승인 `planningContentHash` 결속. 현재성은 lineage head로 판정(이전 승인 기록은 다시 쓰지 않음) | 있음(planning-baseline 등) | 2026-10-28 수동 기획 승인 | — | A02,A03 | `4cc977b` | — | 진행 중 실행의 기준 변경 표시(A03 화면), 영향 작업 재검증 표시 |
| F04 세 도구 연동 | Codex: 기존 구현. **Claude Code: 어댑터 + Controller dispatch(일반 프로젝트 Task)**, 프로젝트당 활성 writer 1개. ChatGPT 웹: 없음 | 어댑터 11 + task 4 + service 19 + HTTP | **2026-10-28 Chrome: 일반 프로젝트 R1·R2를 실제 Claude Code 2.1.312로 실행 → 실행 중·도구 활동·완료가 진행판에 실시간 반영, 결과물 `task-*.md` 생성** | Claude Code live(완료·중단·쓰기·Task 실행). Codex 0.163.0 미검증 | A04~A06 | `afd7747`, `b1ceb8f` | ChatGPT 웹: 이용 조건·공식 경로 미확인 → 자동화 **차단**(`POLICY_REVIEW_REQUIRED`) | Codex 0.163.0 실연동 smoke, 코드 프로젝트에서 Claude 실행 선택, Claude 중단 브라우저 확인 |
| F05 AI 간 인계 | **부분 구현**: 구조화 인계 패키지 `GET /api/projects/:id/tasks/:taskId/handoff`(기준·목표·제약·nonGoals·결정 이유·완료 조건·결과물 참조·최근 검증·미해결·다음 조치) + Markdown, 진행판 "인계 자료 보기". Claude 실행 지시문에 기준·결정·nonGoals 포함 | handoff 단위·HTTP | 2026-10-28 Chrome: 인계 자료 표시, R2가 R1 결과물을 이어 사용 | 같은 프로젝트 내 Claude→Claude 순차 작업 확인. Codex↔Claude 인계 미검증 | A07 | `4cc977b` | — | 인계 수신 기록(목적지·시각), 다른 실행기로 인계 실행 |
| F06 진행 상태 | **구현(일반 프로젝트 기준)**: 3단계 읽기 모델·수집기·화면·읽기 전용 라우트, 실행별 마지막 이벤트·최근 도구, 일반 프로젝트 실행/중단/다시 실행(요청 ID 고정, lost 재시도 금지) | 30+ | **2026-10-28 Chrome: 실제 Claude 실행 중 상태·도구 활동·완료가 새로고침 없이 반영**, 재시작 보존 | Claude live | A09,A10,A11 | `cca18d7` | — | 브라우저 세션 이벤트 연결, 코드 프로젝트 실행 실시간 확인 |
| F07 실행·검토 | 부분: Solo(Codex) + 같은 Codex 리뷰, 일반 프로젝트 Claude 단일 실행·순차 작업 | 있음 | Claude 순차 작업 확인 | — | A08 | `shared/execution-modes.ts` | — | 교차 검토(Codex↔Claude), 결과물 기반 수정 작업 |
| F08 결과물·검증 | 코드 작업: 구현. 일반 프로젝트: Claude 결과물 파일 생성(프로젝트 폴더 내). **결과물 목록·미리보기·완료 조건 검증 미연결** | 있음 | — | Claude 결과물 2개 생성 | A13 | `.local/projects/<id>/task-*.md` | — | 일반 프로젝트 결과물 목록/열기, 문서 완료 조건 검사(존재·형식·필수 항목) |
| F09 중단·복구 | 부분: lost/quarantine/interrupt/중복 방지, Claude 실행은 해당 작업만 격리(자동 재시도 없음), Claude 한도 이벤트 기록·`QUOTA_EXHAUSTED` 분류 | 있음 | — | Claude live 중단 확인(스크립트) | A10 | `afd7747` | — | 진행판 quota 신호에 Claude 한도 연결, 명시적 복구 API |
| F10 모델·사용량·도구 | 부분: Model Hub(env 등록만), Codex 사용량 | 있음(fixture) | — | 외부 미검증 | A14,A15 | `model-hub-service.ts`, `usage.ts` | — | 사용자 등록 Registry(DB), 프로젝트별 AI 선택 |
| F11 간편·고급 | 부분: Start/Studio 표현만 | 있음 | — | — | A12 | `shared/execution-modes.ts` | — | 진행판의 요약/상세 펼침부터 |

## 작업 기록

| 시각(KST) | 담당 | 작업 | 결과 |
|---|---|---|---|
| 2026-10-28 | Claude Code | T0 문서 정리: SCOPE v1.1 공동 개발 정정, 경로 수정, COLLABORATION·STATUS 작성 | 문서만 변경, `615fc72` |
| 2026-10-28 | Codex (`codex exec`) | C1 F02 일반 프로젝트 — `codex/core-general-projects` | Codex sandbox에서는 loopback listen EPERM으로 HTTP 테스트 실행 불가. Claude가 검토·UI fixture 보완 후 sandbox 밖 검증: 전체 1059/1057 pass/0 fail(동시 4). 기본 병렬은 2회 중 각 1건 ECONNRESET(기존 알려진 현상) |
| 2026-10-28 | Claude Code | 통합: C1+진행판+어댑터 병합, 진행판 라우트 연결 | typecheck·build 0, 전체 1099/1097 pass/0 fail/2 skip(동시 4, 기본 병렬 모두), `fdce439` |
| 2026-10-28 | Claude Code | 일반 프로젝트 생성 UI, 진행판 문구 수정 | UI 27/27, `29c03ff` 병합 |
| 2026-10-28 | Codex (`codex exec`) | C2 T1 기준 결속(nonGoals·Run contentHash) + F05 구조화 인계 | sandbox EPERM으로 HTTP 미실행. Claude 통합: 승인 시 이전 승인본을 superseded로 다시 쓰는 초안 동작과 이를 우회한 기존 테스트 수정을 되돌림(기존 Start 흐름 회귀). 전체 1111/1108/1 ECONNRESET, `4cc977b` |
| 2026-10-28 | Codex (`codex exec`) | C3 Claude Code dispatch(일반 프로젝트) | Claude 통합: 프로젝트당 활성 writer 1개 추가, workspace 지정 요청의 C1 `GIT_REQUIRED` 계약 복원. 전체 1142/1139/1 ECONNRESET, `afd7747` |
| 2026-10-28 | Claude Code | 진행판 실행·중단·인계 UI, 활동 기반 관측 | UI·모델 30+, 실제 Claude 2회 실행 브라우저 E2E, `cca18d7` |
| 2026-10-28 | Claude Code | 진행판 읽기 모델·수집기·화면 (`claude/progress-board`) | 단위 27/27(내비게이션 포함), typecheck·build 0, `0756149` |
| 2026-10-28 | Claude Code | Claude Code 어댑터 + live 검증 | 단위 11/11, live 완료·중단 exit 0, `60cf685` |
| 2026-10-28 | Claude Code | BrowserAdapter 경계(probe·대상 정책·세션 이벤트 정제) | 단위 6/6, 설치 없음, `598eb63`. agent-browser·Playwright 미설치로 실제 드라이버 미연결 |

## 발견한 문제

- 재빌드 후 브라우저가 이전 `app.js`를 계속 사용해 새 화면이 보이지 않았다(쿼리 문자열로 우회). 정적 자산 캐시 헤더/파일명 해시 검토 필요.
- 기본 병렬 `npm test`에서 무거운 HTTP 통합 테스트가 간헐적으로 `fetch failed / ECONNRESET`(merge-http, verification-setup-http). 동시 4에서는 재현 안 됨. 원인 미확정.

- Codex sandbox(`workspace-write`)에서는 loopback listen이 막혀 HTTP 테스트를 실행하지 못한다. Codex 작업은 항상 sandbox 밖(Node 24)에서 Claude가 전체 재검증한 뒤 통합한다. Codex sandbox는 Node 26으로 실행됐다.
- 상단 표시줄의 "연결 안 됨"은 Codex 연결 상태만 뜻한다. Claude 실행 중에도 그대로라 혼동될 수 있다(실행기별 상태 표시 필요).
- 기획 AI 제안은 여전히 작업 공간(Git)이 필요해 일반 프로젝트에서 사용할 수 없다(F01).

## 실연동 관찰 기록

- Claude Code 2.1.312: 최소 환경에서는 `authentication_failed`. macOS 키체인 조회에 `USER`가 필요해 어댑터 전용 환경에만 `USER`/`LOGNAME`을 추가했다(Codex 자식 환경은 그대로). `apiKeySource: none` → 구독 인증, API 키 과금 경로 아님.
- `result.subtype`이 `success`여도 `is_error: true`일 수 있다. 어댑터는 `is_error`와 오류 코드로 판정한다.
- `rate_limit_event`가 5시간/7일 창의 사용률·초기화 시각·상태를 제공한다. C3에서 `claude.quota` 이벤트로 기록(진행판 quota 신호에는 아직 Codex 사용량만 사용).
- 2026-10-28 일반 프로젝트 E2E: R1(Glob→Read→Write, 약 44초)·R2(Read→Write, 약 42초) 완료. Claude는 웹 도구가 없음을 결과물에 밝히고 수치를 지어내지 않았으며 승인 기준을 바꾸지 않았다고 기록했다.
