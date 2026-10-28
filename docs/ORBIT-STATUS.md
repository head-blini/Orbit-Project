# Orbit 개발 현황 (F01~F11)

- 기준: `ORBIT-SCOPE-2026-10-27` v1.1, 분담 `docs/ORBIT-COLLABORATION.md`
- 이 표는 개발 진행 기록이며 제품의 실시간 진행판을 대신하지 않는다.
- 표기: **구현** = 코드+자동 테스트 / **부분** / **미구현** / **실연동 미검증** / **차단**. 단위 테스트(fake/fixture)·브라우저 E2E·실제 AI 연동 증거를 구분한다.

## 기준선 (2026-10-28, macOS 26.6.2 arm64, Node 24.22.1, Codex 0.163.0, Claude Code 2.1.312)

HEAD `d39679e`: `npm ci` → `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` 1048 tests / 1046 pass / 0 fail / 2 Windows-only skip (exit 0, 121s). 브라우저 E2E 미실행(`agent-browser`·Playwright 미설치). 실제 AI 연동 미실행.

## 최신 검증 (2026-10-28, 통합 브랜치 `4eef10c`)

`npm run typecheck` 0 · `npm run build` 0 · `npm test`(기본 병렬) **1186 tests / 1184 pass / 0 fail / 2 Windows-only skip** — keep-alive 수정(`3c4aff4`) 이후 전체 스위트 연속 4회 실패 0. 브라우저 E2E는 Claude in Chrome으로 일회용 서버(`.worktrees/verify`, 포트 4399)에서 수동 수행했으며 자동 E2E 스크립트(`agent-browser`·Playwright)는 미설치로 실행하지 않았다.

## 요구사항별 상태

| ID | 구현 상태 | 단위/통합 | 브라우저 | 실연동 | 관련 A | 증거 | 차단 이유 | 다음 행동 |
|---|---|---|---|---|---|---|---|---|
| F01 입력·AI 기획 | **구현(일반 프로젝트)**: 자연어 → Claude 기획 제안(읽기 전용, 미리보기·별도 동의·명시 저장=새 초안). 코드 프로젝트는 Codex/Claude 선택. 간소/상세 명세 구분은 미구현 | general-planning·claude-planning·planning-agent-ui | **Chrome: 일반 프로젝트에서 실제 Claude 기획 제안 → 결정 6개(이유 포함) 초안 저장, 승인본 불변** | Claude Code live 1회. Codex 기획 0.163.0 미검증 | A01 | `fbb7cf5`, `05c98e6` | — | 간소/상세 명세, Start 화면의 일반 프로젝트 흐름 |
| F02 범용 프로젝트 | **구현**: `kind: general`(폴더만), Git 전용 기능 `GIT_REQUIRED`, 생성 UI 작업 종류 선택 | project-general·creation-ui | Chrome: 생성→기획→승인→Task→재시작 보존 | — | A01,A16 | `977a564`, `2c4f3b3` | — | 기존 폴더를 일반 프로젝트로 등록(현재는 Orbit 생성만) |
| F03 기준·변경 관리 | **대부분 구현**: 버전·승인·CAS·stale 거부·결정 이유, `nonGoals`(기존 해시 불변, Claude 기획이 제안 가능), Run에 기준 해시 결속, 현재성은 lineage head | planning-baseline·general-planning(전환 후 유지) | 수동 승인 | — | A02,A03 | `4cc977b`, `4eef10c` | Codex 기획 스키마의 `non_goals`는 live 검증 전까지 미추가 | 진행 중 실행의 기준 변경 표시(A03 화면), 영향 작업 재검증 표시 |
| F04 세 도구 연동 | Codex: 기존. **Claude Code: 어댑터·일반 프로젝트 실행·기획**. ChatGPT 웹: 없음 | 어댑터·task·service·HTTP | Chrome: Claude 실행 2회·기획 1회 | **Claude Code 2.1.312 live**(완료·중단·쓰기·Task·기획). **Codex 0.163.0 미검증** | A04~A06 | `scripts/verify-claude-runtime.mjs` | ChatGPT 웹 자동화 **차단**(이용 조건·공식 경로 미확인) | Codex 0.163.0 smoke(사용량 승인 필요), 코드 프로젝트 Claude 실행 |
| F05 AI 간 인계 | **부분**: 구조화 인계 패키지·Markdown·진행판 보기, Claude 실행 지시문에 기준·결정·nonGoals 포함, 같은 프로젝트 Claude 순차 작업 | handoff·general-planning(전환 후 brief·handoff 동일) | 인계 자료 표시 | Claude→Claude 순차 확인. **Codex↔Claude 인계 미구현·미검증** | A07 | `4cc977b` | — | 인계 수신 기록(목적지·시각·확인), 다른 실행기로 인계 실행 |
| F06 진행 상태 | **구현(일반 프로젝트)**: 3단계 진행판, 실행별 마지막 이벤트·최근 도구, 실행/중단/다시 실행(요청 ID 고정, lost 재시도 금지), 실행기별 신호(일반=Claude 한도, Codex 로그인 미반영) | 진행판 30+·HTTP | Chrome: 실시간 실행·도구·완료, 재시작 보존 | Claude live | A09,A10,A11 | `cca18d7`, `3c4aff4` | — | 코드 프로젝트 실행의 실시간 확인, 브라우저 세션 이벤트 연결 |
| F07 실행·검토 | **부분**: Codex Solo + 같은 Codex 리뷰, 일반 프로젝트 Claude 단일·순차 실행 | 있음 | Claude 순차 | — | A08 | — | — | 교차 검토(Codex↔Claude), 결과물 기반 수정 작업 |
| F08 결과물·검증 | 코드: 구현. **일반 프로젝트: 결과물 목록·작업 출처·크기·digest·형식 검사·안전 미리보기 구현**. 내용 적합성은 `unverified`로 표시 | deliverables 4·UI 3·HTTP 1 | **Chrome: 결과물 3개 목록·미리보기** | Claude 결과물 | A13 | `f542633`, `3c4aff4` | — | 결과물 버전 이력, 완료 조건별 문서 검사(필수 항목), 내보내기 |
| F09 중단·복구 | **부분**: lost/quarantine/interrupt/중복 방지, Claude 실행은 해당 작업만 격리, Claude 한도 이벤트→진행판 `quota_wait`, keep-alive 연결 끊김 수정 | 있음 | — | Claude live 중단(스크립트) | A10 | `afd7747`, `3c4aff4` | — | 명시적 복구 API(Claude 작업), 한도 초기화 후 재개 안내 |
| F10 모델·사용량·도구 | **부분**: 프로젝트별 기획/실행 AI 선택(실행 가능한 조합만 저장, 실행 시 재확인), Model Hub(env 등록만), Codex·Claude 사용량 관측. **사용자 정의 모델·제공자 등록 미구현** | ai-preferences·UI | AI 선택 화면 표시 | 외부 모델 미검증 | A14,A15 | `fbb7cf5`, `05c98e6` | — | **사용자 정의 Registry(DB·UI)**, 프로젝트 도구 프로필 |
| F11 간편·고급 | **부분**: 진행판 요약/펼침, Start/Studio 표현 | 있음 | — | — | A12 | — | — | 같은 데이터로 모드 전환 검증(A12) |

## C4 통합 검토 결과 (사용자 요청 6항목)

1. **일반 프로젝트에서 기획·실행 AI를 실제로 선택할 수 있는가** — 아니다(정직한 현재 상태). 일반 프로젝트는 Codex가 Git 작업 공간을 요구해 기획·실행 모두 Claude Code만 가능하다. 선택 화면은 Codex를 사유와 함께 비활성 표시한다. 코드 프로젝트는 기획 AI를 Codex/Claude 중 실제로 고를 수 있고, 실행은 Codex만 가능하다.
2. **선택이 실행에 실제 반영되는가** — Codex 초안은 실행 불가 조합(일반+Codex 기획, 코드+Claude 실행)을 저장할 수 있어 저장값과 실제 실행기가 어긋났다. 통합에서 실행 불가 조합 저장을 거절하고(`GIT_REQUIRED`/`RUNTIME_NOT_SUPPORTED`), 작업 실행 시 저장값과 실행기 일치를 서버에서 재확인하도록 고쳤다. 기획은 미리보기 digest에 실행기·설정 revision이 들어가 설정 변경 시 이전 미리보기로 시작할 수 없다.
3. **모델 전환 후 기준·결정 이유·목표 유지** — 회귀 테스트로 확인: 코드 프로젝트에서 기획 AI를 Codex→Claude로 바꾸고 새 초안을 저장해도 승인본·실행 brief·인계 자료(결정 이유·nonGoals·목표)가 동일하다. 브라우저에서도 Claude 초안 저장 후 승인본 r1 불변을 확인했다.
4. **보안·승인 정책 동일성** — 기획 경로는 두 실행기가 같은 입력 검사를 공유한다. 작업 실행 경로는 Claude가 마스킹만 하고 개인정보 차단이 없어 불일치였다. 통합에서 Codex와 같은 원문 brief에 같은 차단(`CREDENTIAL_LIKE_INPUT`/`PERSONAL_DATA_BLOCKED`, `guardrail.denied` 기록)을 적용했다. 격리: Codex는 `--disable` 기능 목록·sandbox(네트워크 없음)·승인 정책, Claude는 `--restricted`·빈 MCP·`--permission-prompts none`·도구 허용 목록·작업 폴더 한정. 두 CLI 모두 각 제공자 API로의 전송은 Orbit 통제 밖이다(문서화된 한계).
5. **ECONNRESET 원인** — 같은 프로세스의 동기 Git 작업이 이벤트 루프를 서버 keep-alive(기본 5초)보다 오래 막아, 서버가 유휴 연결을 닫는 순간 클라이언트가 재사용해 발생. 근거: 최소 재현(6초 정지 시 재사용 리셋, 65초 설정 시 0회), 전체 스위트 측정(실패 파일 merge-http 정지 7.3~11.4초). 테스트는 수정하지 않고 서버 `keepAliveTimeout=60s`로 고쳤으며 회귀 테스트를 추가했다. 수정 후 연속 4회 실패 0. 같은 경쟁은 제품(브라우저 POST)에서도 가능했다.
6. **STATUS 정확성** — 이 문서를 위 기준으로 갱신했다.

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
| 2026-10-28 | Codex (`codex exec`) | C4 일반 프로젝트 기획(Claude)·프로젝트별 AI 선택 | sandbox EPERM으로 HTTP 미실행. Claude 통합 검토: 실행 불가 조합 저장 거절·실행 시 재확인, Claude 작업 입력 차단 Codex와 동일화, 전환 후 기준 유지 테스트 추가. 전체 1173/1171/0, `fbb7cf5` |
| 2026-10-28 | Claude Code | keep-alive 수정, 결과물 라우트, 실행기별 진행 신호, 일반 프로젝트 기획 UI, AI 선택 UI, Claude 기획 non_goals | 전체 1186/1184/0(연속 4회 0), Chrome: 실제 Claude 기획·결과물 미리보기, `3c4aff4`~`4eef10c` |
| 2026-10-28 | Claude Code | 진행판 읽기 모델·수집기·화면 (`claude/progress-board`) | 단위 27/27(내비게이션 포함), typecheck·build 0, `0756149` |
| 2026-10-28 | Claude Code | Claude Code 어댑터 + live 검증 | 단위 11/11, live 완료·중단 exit 0, `60cf685` |
| 2026-10-28 | Claude Code | BrowserAdapter 경계(probe·대상 정책·세션 이벤트 정제) | 단위 6/6, 설치 없음, `598eb63`. agent-browser·Playwright 미설치로 실제 드라이버 미연결 |

## 발견한 문제

- 재빌드 후 브라우저가 이전 `app.js`를 계속 사용해 새 화면이 보이지 않았다(쿼리 문자열로 우회). 정적 자산 캐시 헤더/파일명 해시 검토 필요.
- (해결) 전체 스위트의 간헐 `ECONNRESET` — 원인과 근거는 위 C4 검토 5번. 서버 `keepAliveTimeout=60s`(`3c4aff4`).
- 브라우저 검증 중 수동 편집기의 "초안 저장"과 기획 제안의 "제안을 새 기획 초안으로 저장"을 혼동해 빈 템플릿 초안이 일회용 DB에 저장됐다. 두 버튼 이름이 비슷해 사용자도 혼동할 수 있다(UI 개선 후보).
- 기획 지시문이 코드 앱 미리보기 제약을 언급해 비코드 기획에도 "HTML preview로 바꾸지 않는다" 같은 제약이 생겼다(F01 개선 후보).

- Codex sandbox(`workspace-write`)에서는 loopback listen이 막혀 HTTP 테스트를 실행하지 못한다. Codex 작업은 항상 sandbox 밖(Node 24)에서 Claude가 전체 재검증한 뒤 통합한다. Codex sandbox는 Node 26으로 실행됐다.
- 상단 표시줄의 "연결 안 됨"은 Codex 연결 상태만 뜻한다. Claude 실행 중에도 그대로라 혼동될 수 있다(실행기별 상태 표시 필요).
- 기획 AI 제안은 여전히 작업 공간(Git)이 필요해 일반 프로젝트에서 사용할 수 없다(F01).

## 실연동 관찰 기록

- Claude Code 2.1.312: 최소 환경에서는 `authentication_failed`. macOS 키체인 조회에 `USER`가 필요해 어댑터 전용 환경에만 `USER`/`LOGNAME`을 추가했다(Codex 자식 환경은 그대로). `apiKeySource: none` → 구독 인증, API 키 과금 경로 아님.
- `result.subtype`이 `success`여도 `is_error: true`일 수 있다. 어댑터는 `is_error`와 오류 코드로 판정한다.
- `rate_limit_event`가 5시간/7일 창의 사용률·초기화 시각·상태를 제공한다. C3에서 `claude.quota` 이벤트로 기록(진행판 quota 신호에는 아직 Codex 사용량만 사용).
- 2026-10-28 일반 프로젝트 E2E: R1(Glob→Read→Write, 약 44초)·R2(Read→Write, 약 42초) 완료. Claude는 웹 도구가 없음을 결과물에 밝히고 수치를 지어내지 않았으며 승인 기준을 바꾸지 않았다고 기록했다.
