# Orbit 개발 현황 (F01~F11)

- 기준: `ORBIT-SCOPE-2026-10-27` v1.1, 분담 `docs/ORBIT-COLLABORATION.md`
- 이 표는 개발 진행 기록이며 제품의 실시간 진행판을 대신하지 않는다.
- 표기: **구현** = 코드+자동 테스트 / **부분** / **미구현** / **실연동 미검증** / **차단**. 단위 테스트(fake/fixture)·브라우저 E2E·실제 AI 연동 증거를 구분한다.

## 기준선 (2026-10-28, macOS 26.6.2 arm64, Node 24.22.1, Codex 0.163.0, Claude Code 2.1.312)

HEAD `d39679e`: `npm ci` → `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` 1048 tests / 1046 pass / 0 fail / 2 Windows-only skip (exit 0, 121s). 브라우저 E2E 미실행(`agent-browser`·Playwright 미설치). 실제 AI 연동 미실행.

## 요구사항별 상태

| ID | 구현 상태 | 단위/통합 | 브라우저 | 실연동 | 관련 A | 증거 참조/시각 | 차단 이유 | 다음 행동 |
|---|---|---|---|---|---|---|---|---|
| F01 입력·AI 기획 | 부분: Codex 1턴 기획 제안·초안 저장 | 있음(FakeRpc) | 과거 Mac Task33 | Codex 0.162.1 과거 1회, 0.163.0 미검증 | A01 | `server/codex-planning.ts`, `planning-agent-service.ts` | — | 프로젝트별 기획 AI 선택(F10 연계), 간소/상세 명세 |
| F02 범용 프로젝트 | **미구현**: 등록·생성 모두 Git 필수 | — | — | — | A01,A16 | `server/projects.ts:34`, `project-creation.ts:101` | — | Codex C1: `kind: general` 프로젝트(폴더만), Git/worktree는 code에서만 |
| F03 기준·변경 관리 | 부분: 버전·승인·CAS·stale 거부·decisions | 있음 | 과거 | — | A02,A03 | `server/studio.ts`, `planning/execution.ts` | — | Codex C2: nonGoals, Run에 기준 contentHash 결속 |
| F04 세 도구 연동 | Codex: 기존 구현. **Claude Code: 실행 어댑터 구현**(`server/runtimes/claude-code.ts`, Controller/Run 미연결). ChatGPT 웹: 없음 | Claude 11/11(합성 stream-json) | — | **Claude Code 2.1.312 live: 완료·중단 확인**(`scripts/verify-claude-runtime.mjs`, 2026-10-28). Codex 0.163.0 미검증 | A04~A06 | `tests/claude-runtime.test.ts` | ChatGPT 웹: 이용 조건·공식 경로 미확인으로 자동화 **차단**(BrowserAdapter 정책 `POLICY_REVIEW_REQUIRED`) | Codex: Run에 runtime 필드·Controller dispatch 연결(C3) |
| F05 AI 간 인계 | 부분(수동 Markdown) | 있음 | — | — | A07 | `planning-handoff-service.ts` | — | 기준 결속 후 구조화 인계 패키지 |
| F06 진행 상태 | **부분 구현**: 3단계 읽기 모델·수집기·진행판 화면(`shared/project-progress.ts`, `server/project-progress.ts`, `web/project-progress.tsx`). HTTP 라우트 미연결 | 22/22(모델16·수집기3·UI3) | 미실행 | — | A09,A10,A11 | `tests/project-progress*.test.ts` | 라우트는 `server/http.ts`(Codex 소유) | 통합 단계에서 `GET /api/projects/:id/progress` 연결 후 브라우저 확인 |
| F07 실행·검토 | 부분: Solo + 같은 Codex 리뷰 | 있음 | 과거 | — | A08 | `shared/execution-modes.ts` | — | 다른 실행기 교차 검토는 F04 이후 |
| F08 결과물·검증 | 구현(코드 작업 중심) | 있음 | 과거 | 로컬 명령 | A13 | `verification-service.ts`, `visualization/pptx.ts` | — | Git 없는 프로젝트의 Artifact 연결 |
| F09 중단·복구 | 부분: lost/quarantine/interrupt/중복 방지. 한도 대기 없음 | 있음 | 과거 | — | A10 | `shared/recovery.ts`, `controller.ts` | — | 한도 대기 상태를 진행판에 표시 |
| F10 모델·사용량·도구 | 부분: Model Hub(env 등록만), Codex 사용량 | 있음(fixture) | — | 외부 미검증 | A14,A15 | `model-hub-service.ts`, `usage.ts` | — | 사용자 등록 Registry(DB), 프로젝트별 AI 선택 |
| F11 간편·고급 | 부분: Start/Studio 표현만 | 있음 | — | — | A12 | `shared/execution-modes.ts` | — | 진행판의 요약/상세 펼침부터 |

## 작업 기록

| 시각(KST) | 담당 | 작업 | 결과 |
|---|---|---|---|
| 2026-10-28 | Claude Code | T0 문서 정리: SCOPE v1.1 공동 개발 정정, 경로 수정, COLLABORATION·STATUS 작성 | 문서만 변경, `615fc72` |
| 2026-10-28 | Codex (`codex exec`) | C1 F02 일반 프로젝트 — `codex/core-general-projects` | 진행 중 |
| 2026-10-28 | Claude Code | 진행판 읽기 모델·수집기·화면 (`claude/progress-board`) | 단위 27/27(내비게이션 포함), typecheck·build 0, `0756149` |
| 2026-10-28 | Claude Code | Claude Code 어댑터 + live 검증 | 단위 11/11, live 완료·중단 exit 0, `60cf685` |
| 2026-10-28 | Claude Code | BrowserAdapter 경계(probe·대상 정책·세션 이벤트 정제) | 단위 6/6, 설치 없음, `598eb63`. agent-browser·Playwright 미설치로 실제 드라이버 미연결 |

## 실연동 관찰 기록

- Claude Code 2.1.312: 최소 환경에서는 `authentication_failed`. macOS 키체인 조회에 `USER`가 필요해 어댑터 전용 환경에만 `USER`/`LOGNAME`을 추가했다(Codex 자식 환경은 그대로). `apiKeySource: none` → 구독 인증, API 키 과금 경로 아님.
- `result.subtype`이 `success`여도 `is_error: true`일 수 있다. 어댑터는 `is_error`와 오류 코드로 판정한다.
- `rate_limit_event`가 5시간/7일 창의 사용률·초기화 시각·상태를 제공한다. 한도 대기 표시에 사용 가능(아직 진행판 신호에 미연결).
