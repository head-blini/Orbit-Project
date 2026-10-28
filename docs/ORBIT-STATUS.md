# Orbit 개발 현황 (F01~F11)

## 재개 요약 (새 세션은 여기부터 · 갱신 2026-10-28 16:10 KST, 담당 Claude Code)

**기준 문서(원문을 직접 읽을 것, 이 요약은 기준이 아님)**
- 최상위 비전: `docs/ORBIT-VISION.md` (상태: 사용자 확정, 기준일 2026-10-28). 원문 §1: “Orbit은 누구나 자연어로 목표를 입력하면 다양한 AI 모델·에이전트·Skills·MCP·외부 도구를 활용해 기획, 실행, 협업, 검증, 결과물 생성까지 수행하고, 프로젝트 방향성과 진행 상태를 일관되게 관리하는 범용 AI 작업 자동화 플랫폼이다.”
- 승인 범위: `docs/ORBIT-SCOPE-2026-10-27.md` v1.1(F01~F11, A01~A16, 2026-10-28 공동 개발 정정). 구현 순서: `docs/ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`. 분담: `docs/ORBIT-COLLABORATION.md`.

**저장소 상태(관측)**
- 통합 브랜치 `codex/orbit-mac-handoff-2026-10-26` HEAD `59dcc7c`(병합) ← `8132244`. 원격 대비 로컬이 앞섬(작업 시작 시 ahead 38, 이번 2커밋 추가). **원격은 이번에 조회하지 않음.** Push 안 함.
- worktree: `.worktrees/claude-ui`(`claude/first-flow` = `8132244`, 깨끗함), `.worktrees/codex-core`(`codex/core-model-registry` `ddb74d8`, 변경 없음), `.worktrees/verify`(detached `c14df45`, 이전 데이터는 `.local-c4-1eba7d3`로 보존). 루트에 미추적 `.DS_Store`만 있음.
- Codex: 크레딧 소진으로 **차단**(아래 ‘현재 차단’). 그동안 Claude Code가 단일 담당으로 Codex 소유 파일(`server/controller.ts`·`http.ts`·`planning-agent-service.ts`·`planning/agent-input.ts`·`shared/deliverables.ts`)도 순차 수정했다. Codex 재개 시 이 변경을 기준으로 이어갈 것.

**현재 작업** `FF1 첫 비코드 흐름` · 담당 Claude Code
- 목표: “첨부한 자료를 비교해서 표와 요약 보고서를 만들어 줘.” 새 작업→기획 AI→명세 검토·승인→Git 없는 프로젝트→실행 AI→실행·진행→결과물 열기→후속 수정→재시작 확인.
- 허용 범위: 홈·일반 프로젝트 Start·진행판 결과물 표시, 자료 저장(inputs/), Claude 기획 입력·파서, 간편 메뉴. 하지 않을 것: 전체 UI 확산, 새 의존성, 모델 Registry(C5), ChatGPT 웹 자동화, 원격 Push.
- 완료 조건: 사용자 수용 조건 1~7(아래 FF1 검증). 상태: **구현·실연동 1회 통과, 사용자 화면 확인 대기.**
- 다음 행동 하나: 사용자가 홈·프로젝트 화면 미리보기를 확인하면, 일반 작업의 근거 대조 결과를 작업 검증 기록(CheckRecord)에 연결해 진행판 ‘검증 통과’ 집계에 반영한다(현재는 결과물 목록에만 표시).

**FF1 검증 (대상 `8132244`, 2026-10-28 KST)**
| 구분 | 명령/방법 | 결과 | 증거 |
|---|---|---|---|
| 구현 | `npm run typecheck` / `npm run build` | 0 / 0 | — |
| 단위·통합 | `npm test` | 1201 / 1199 pass / 0 fail / 2 Windows-only skip, exit 0. 최초 실행은 12 fail(아래 ‘테스트 변경’) 후 수정·재실행 | `tests/first-flow.test.ts`(10) |
| 실연동 | Chrome(Claude in Chrome)으로 일회용 서버 `.worktrees/claude-ui` 포트 4399, 샘플 CSV 2개 | 기획 2회(1회 `PLANNING_PROPOSAL_INVALID` → 원인 수정 후 성공), 후속 기획 1회, Claude Code 실행 4회 모두 completed | DB `.worktrees/claude-ui/.local/`(gitignore, 이 PC에만 있음) |
| 사실 확인 | 결과물 4개 표 수치를 입력 CSV·계산값과 스크립트로 대조 | 설명 불가 수치 0개 | 이 문서 FF1 기록 |
| 재시작 | 서버 종료→재시작 전후 runs 3·events seq 46 동일, 화면 상태 동일 | 자동 재실행 없음 | — |
| 사용자 확인 | — | **미확인** | — |

**최소 읽기 목록:** `AGENTS.md` → `docs/ORBIT-VISION.md` → `docs/ORBIT-SCOPE-2026-10-27.md` → 이 문서 → `docs/ORBIT-COLLABORATION.md`. 코드 진입점: `web/start.tsx`, `web/new-task.tsx`, `server/materials.ts`, `server/deliverables.ts`, `server/planning/agent-input.ts`.

**재개 규칙(강제 아님):** 새 세션은 위 기준 원문과 이 요약을 대조하고, `git status`/`git worktree list`로 실제 상태를 확인한 뒤 진행한다. 이 요약과 실제가 다르면 실제를 기록하고, 미확인 실행은 재실행하지 않는다. 이 규칙과 테스트는 에이전트가 수정할 수 있으므로 자동 강제가 아니다. 통합 담당의 독립 diff·검증 검토가 최종 관문이다.

## 기준선 (2026-10-28, macOS 26.6.2 arm64, Node 24.22.1, Codex 0.163.0, Claude Code 2.1.312)

HEAD `d39679e`: `npm ci` → `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` 1048 tests / 1046 pass / 0 fail / 2 Windows-only skip (exit 0, 121s). 브라우저 E2E 미실행(`agent-browser`·Playwright 미설치). 실제 AI 연동 미실행.

## 최신 검증 (2026-10-28, 통합 브랜치 `4eef10c`)

`npm run typecheck` 0 · `npm run build` 0 · `npm test`(기본 병렬) **1186 tests / 1184 pass / 0 fail / 2 Windows-only skip** — keep-alive 수정(`3c4aff4`) 이후 전체 스위트 연속 4회 실패 0. 브라우저 E2E는 Claude in Chrome으로 일회용 서버(`.worktrees/verify`, 포트 4399)에서 수동 수행했으며 자동 E2E 스크립트(`agent-browser`·Playwright)는 미설치로 실행하지 않았다.

## FF1 첫 비코드 흐름 — 수용 조건별 결과 (대상 `8132244`)

| # | 조건 | 결과 | 근거 | 관련 F/A |
|---|---|---|---|---|
| 1 | 첫 화면 중심=자연어 입력·기획 AI·시작, Git/기존 프로젝트가 막지 않음, 미구현 기능 가장 금지 | **통과(브라우저)** | 홈 `NewTaskPanel`: 요청·텍스트 자료 첨부(.csv/.md/.txt/.json, 128 KB, 10개; 실제 동작)·기획 AI(Claude Code, Codex는 사유와 함께 비활성)·시작. 자동 선택은 표시하지 않음. 프로젝트가 선택돼 있어도 ‘+ 새 작업’. 코드 프로젝트 생성은 접힌 영역 | F01,F02,F11 · A01 |
| 2 | 간편 모드는 필요한 정보만, 기존 기능·고급 경로 보존 | **통과(부분)** | 사이드바 기본 4개(시작하기·진행 현황·프로젝트·기획 스튜디오)+현재 페이지, ‘고급 메뉴 보기’로 14개 전부. 진행판·기획 스튜디오 내부는 아직 상세 정보가 많음 | F11 · A12 |
| 3 | 승인 전후·실행 기준 버전 구분, 선택 AI가 실제 실행에 반영, 미지원 이유 표시 | **통과** | 카드에 ‘버전 n · 초안(미승인)/승인됨 · 기준 해시’. 실행 기록 담당 Claude Code, 진행판 ‘승인 버전 r2 · 6196ccb964af’. Codex는 ‘Git 작업 공간이 필요’로 비활성 | F03,F10 · A03 |
| 4 | 프로젝트·작업·실행별 담당·마지막 관측·대기/오류·결과물·검증, 응답 종료≠검증, 근거 있는 진행률 | **통과** | 작업별 ‘AI 응답 완료 · 검증 전’, 최근 도구(Read/Write/Edit), 관측 시각, ‘작업 n개 중 0개 검증 통과(작업 수 기준)’·‘완료 조건 n개 중 0개’. 기획 실패는 진단 코드로 표시 | F06 · A09,A11 |
| 5 | 결과물이 실제 생성·목록·미리보기, 사실·비교표 확인, 검증 실패를 완료로 표시 안 함 | **통과(검증 연결은 부분)** | 결과물 4개 목록·미리보기, 입력 자료 분리. 근거 대조: 계산값은 ‘자료에 없음 · 확인 필요’, 원본만 쓴 표는 ‘모두 자료에 있음’. 독립 스크립트 대조 설명 불가 수치 0. **진행판 검증 집계에는 아직 연결 안 됨**(0/n 유지) | F08 · A13 |
| 6 | 후속 수정·새로고침/재시작에서 기준·파일·관측 유지, 중복 실행 없음 | **통과** | 후속 요청→새 기획 v1→질문 6개 답변→v2 승인→실행. 기존 결과물 mtime 불변, 이전 실행·증거 보존. 재시작 전후 runs/events 동일 | F02,F09 · A01,A10 |
| 7 | 기존 코드 프로젝트 흐름 회귀 | **단위·UI 통과, 실연동 미검증** | start-page(코드 Start 흐름) 포함 전체 1199 통과. Codex 실행은 크레딧 차단으로 live 미실행 | A16 |

**실연동 중 발견·수정한 문제**
- Claude 기획 결과가 ```` ```json ```` 펜스로 감싸져 `PLANNING_PROPOSAL_INVALID`(원인: 형식 판정이 markdown). 전체를 감싼 펜스 하나만 벗기도록 수정(앞뒤 설명문은 여전히 거부).
- 기획 지시문이 “프로젝트 파일을 읽지 말라”여서 첨부 자료를 못 보고 질문만 생성. 서버가 나열한 `inputs/` 자료만 Read하도록 예외를 지시문에 넣었고 미리보기에 그대로 보인다(목록이 바뀌면 입력 digest도 바뀜).
- 새 프로젝트가 SSE로 먼저 선택돼 요청 문구 전달이 사라짐 → 구독 방식으로 수정.
- 근거 대조가 CSV `1200000,7`을 한 숫자로 읽음 → 천 단위 쉼표는 정확히 3자리 앞에서만 인정.
- 간편 메뉴에서 관리 그룹 페이지가 현재 페이지일 때 숨겨짐(테스트가 발견) → 표시.

**테스트 변경(별도 검토 대상)**
- `tests/studio-ui.test.ts`: 원래 계약 “사이드바는 항상 14개 메뉴”. 수용 조건 2에 따라 간편 모드 단언(기본 4개+현재 페이지, ‘고급 메뉴 보기’)을 추가하고, 원래 14개·순서 단언은 고급 메뉴 상태에서 그대로 유지.
- `tests/start-page.test.ts`: 단언 변경 없음. 하네스 모듈 stub에 `./new-task.tsx` 한 줄 추가(`.tsx`를 직접 require할 수 없음).
- `tests/deliverables-ui.test.ts`: fixture에 새 필수 필드 `role:'output'`만 추가.
- `tests/deliverables.test.ts`: 변경 없음. 자료 없는 프로젝트는 `evidence`를 붙이지 않게 코드를 맞춰 기존 계약을 유지.

**아직 남은 문제(FF1 범위)**
- 후속 기획이 제약(“통화는 KRW”)까지 별도 작업으로 쪼개 작업 6개가 생김(후속 R1만 실행). 기획 지시문의 작업 분해 기준 개선 필요(F01).
- 기획 지시문의 코드 앱 미리보기 제약(`staticAppPreviewCapability`)이 비코드 기획에도 들어감(기존 발견, 미해결).
- 요청 원문은 브라우저 메모리로만 전달(저장하지 않음). 새로고침하면 입력칸이 비고 첨부 자료 목록만 남는다.
- 기획 패널의 ‘기획 상태 새로고침’ 버튼이 입력 라벨과 겹쳐 보임(표시 문제).
- 재빌드 직후 첫 접속에 이전 `app.js`가 보인 현상 재발(`Cache-Control: no-store`는 이미 설정됨, 원인 미확인).

## 요구사항별 상태

| ID | 구현 상태 | 단위/통합 | 브라우저 | 실연동 | 관련 A | 증거 | 차단 이유 | 다음 행동 |
|---|---|---|---|---|---|---|---|---|
| F01 입력·AI 기획 | **구현(일반 프로젝트)**: 홈에서 자연어 요청·텍스트 자료 첨부·기획 AI 선택 → 기획 미리보기·별도 동의 → Claude 기획(첨부 자료만 읽기) → 초안 저장 → **열린 질문 답변=결정 기록·새 버전** → 승인·작업 준비. 코드 프로젝트는 Codex/Claude 선택. 간소/상세 명세 구분은 미구현 | general-planning·claude-planning·first-flow | **Chrome FF1: 실제 Claude 기획 2회+후속 1회, 질문 답변 v2 승인** | Claude Code live. Codex 기획 0.163.0 미검증 | A01 | `8132244` | — | 작업 분해 기준(제약을 작업으로 쪼개지 않기), 간소/상세 명세 |
| F02 범용 프로젝트 | **구현**: `kind: general`(폴더만), Git 전용 기능 `GIT_REQUIRED`, 홈 새 작업이 일반 프로젝트를 만들고 자료를 `inputs/`에 1회 저장(덮어쓰기 금지·인증정보/개인정보 차단) | project-general·creation-ui·first-flow | Chrome FF1: 생성→자료→기획→승인→실행→후속→재시작 보존 | Claude live | A01,A16 | `977a564`, `8132244` | — | 기존 폴더를 일반 프로젝트로 등록, 자료 추가/교체 UI |
| F03 기준·변경 관리 | **대부분 구현**: 버전·승인·CAS·stale 거부·결정 이유, `nonGoals`(기존 해시 불변, Claude 기획이 제안 가능), Run에 기준 해시 결속, 현재성은 lineage head | planning-baseline·general-planning(전환 후 유지) | 수동 승인 | — | A02,A03 | `4cc977b`, `4eef10c` | Codex 기획 스키마의 `non_goals`는 live 검증 전까지 미추가 | 진행 중 실행의 기준 변경 표시(A03 화면), 영향 작업 재검증 표시 |
| F04 세 도구 연동 | Codex: 기존. **Claude Code: 어댑터·일반 프로젝트 실행·기획**. ChatGPT 웹: 없음 | 어댑터·task·service·HTTP | Chrome: Claude 실행 2회·기획 1회 | **Claude Code 2.1.312 live**(완료·중단·쓰기·Task·기획). **Codex 0.163.0 미검증** | A04~A06 | `scripts/verify-claude-runtime.mjs` | ChatGPT 웹 자동화 **차단**(이용 조건·공식 경로 미확인) | Codex 0.163.0 smoke(사용량 승인 필요), 코드 프로젝트 Claude 실행 |
| F05 AI 간 인계 | **부분**: 구조화 인계 패키지·Markdown·진행판 보기, Claude 실행 지시문에 기준·결정·nonGoals 포함, 같은 프로젝트 Claude 순차 작업, **교차 모델 검토 지시문·엄격 파서(`claude-review.ts`, 연결 대기)** | handoff·general-planning(전환 후 brief·handoff 동일) | 인계 자료 표시 | Claude→Claude 순차 확인. **Codex↔Claude 인계 미구현·미검증** | A07 | `4cc977b` | — | 인계 수신 기록(목적지·시각·확인), 다른 실행기로 인계 실행 |
| F06 진행 상태 | **구현(일반 프로젝트)**: 3단계 진행판, 실행별 마지막 이벤트·최근 도구, 실행/중단/다시 실행(요청 ID 고정, lost 재시도 금지), 실행기별 신호(일반=Claude 한도, Codex 로그인 미반영) | 진행판 30+·HTTP | Chrome: 실시간 실행·도구·완료, 재시작 보존 | Claude live | A09,A10,A11 | `cca18d7`, `3c4aff4` | — | 코드 프로젝트 실행의 실시간 확인, 브라우저 세션 이벤트 연결 |
| F07 실행·검토 | **부분**: Codex Solo + 같은 Codex 리뷰, 일반 프로젝트 Claude 단일·순차 실행 | 있음 | Claude 순차 | — | A08 | — | — | 교차 검토(Codex↔Claude), 결과물 기반 수정 작업 |
| F08 결과물·검증 | 코드: 구현. **일반 프로젝트: 입력 자료/결과물 분리, 작업 출처·크기·digest·형식 검사·미리보기, 표 수치 근거 대조(passed/needs_review/unverified)**. 내용 적합성은 `unverified`. **근거 대조는 진행판 검증 집계에 미연결** | deliverables·first-flow | **Chrome FF1: 결과물 4개·근거 대조·미리보기** | Claude 결과물, 독립 대조 0 불일치 | A13 | `8132244` | — | 근거 대조→작업 CheckRecord 연결, 결과물 버전 이력, 내보내기 |
| F09 중단·복구 | **부분**: lost/quarantine/interrupt/중복 방지, Claude 실행은 해당 작업만 격리, Claude 한도 이벤트→진행판 `quota_wait`, keep-alive 연결 끊김 수정 | 있음 | — | Claude live 중단(스크립트) | A10 | `afd7747`, `3c4aff4` | — | 명시적 복구 API(Claude 작업), 한도 초기화 후 재개 안내 |
| F10 모델·사용량·도구 | **부분**: 프로젝트별 기획/실행 AI 선택(실행 가능한 조합만 저장, 실행 시 재확인), Model Hub(env 등록만), Codex·Claude 사용량 관측. **사용자 정의 모델·제공자 등록 미구현** | ai-preferences·UI | AI 선택 화면 표시 | 외부 모델 미검증 | A14,A15 | `fbb7cf5`, `05c98e6` | — | **사용자 정의 Registry(DB·UI)**, 프로젝트 도구 프로필 |
| F11 간편·고급 | **부분**: 사이드바 간편(4개+현재)/고급 메뉴 전환(브라우저 저장), 진행판 요약/펼침, Start/Studio 표현. 페이지 내부 간편/고급 구분은 부분 | studio-ui·first-flow | Chrome: 간편 메뉴 | — | A12 | `8132244` | — | 같은 데이터로 모드 전환 검증(A12), 진행판·기획 스튜디오 간편 표현 |

## 현재 차단 (2026-10-28)

- **Codex 사용 불가:** C5(사용자 정의 모델 Registry, F10) 실행 직후 Codex CLI가 `Your workspace is out of credits`로 종료됐다. Codex worktree(`codex/core-model-registry`)에 변경 없음. 지시에 따라 Codex 소유 공유 파일(서버·DB·공통 계약)은 수정하지 않고 독립 작업만 진행 중. 재개 지점: 크레딧 충전 후 `scratchpad/codex-c5-brief.md` 지시문으로 C5 재실행, 또는 사용자 승인 시 Claude Code가 C5를 순차 수행.
- 교차 검토 모듈(`server/runtimes/claude-review.ts`)은 구현·테스트됐으나 Controller/HTTP 연결은 위 사유로 대기.

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
| 2026-10-28 | Claude Code | **FF1 첫 비코드 흐름**(Codex 차단 중 단일 담당, Codex 소유 파일 포함): 홈 새 작업·자료 저장·Claude 기획 펜스/자료 읽기·질문 답변 버전·일반 프로젝트 승인 카드·근거 대조·간편 메뉴 | typecheck·build 0, 전체 1201/1199/0/2 skip(최초 12 fail→수정), Chrome 실연동 기획 3·실행 4, `8132244`→병합 `59dcc7c` |
| 2026-10-28 | Claude Code | 일반 프로젝트 Start를 자연어 기획 요청으로 시작, 저장 버튼 이름 정리 | `c14df45` |
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
- (해결) 기획 AI 제안은 일반 프로젝트에서 Claude Code로 사용 가능(`fbb7cf5`), 첨부 자료 읽기(`8132244`).

## 실연동 관찰 기록

- Claude Code 2.1.312: 최소 환경에서는 `authentication_failed`. macOS 키체인 조회에 `USER`가 필요해 어댑터 전용 환경에만 `USER`/`LOGNAME`을 추가했다(Codex 자식 환경은 그대로). `apiKeySource: none` → 구독 인증, API 키 과금 경로 아님.
- `result.subtype`이 `success`여도 `is_error: true`일 수 있다. 어댑터는 `is_error`와 오류 코드로 판정한다.
- `rate_limit_event`가 5시간/7일 창의 사용률·초기화 시각·상태를 제공한다. C3에서 `claude.quota` 이벤트로 기록(진행판 quota 신호에는 아직 Codex 사용량만 사용).
- 2026-10-28 일반 프로젝트 E2E: R1(Glob→Read→Write, 약 44초)·R2(Read→Write, 약 42초) 완료. Claude는 웹 도구가 없음을 결과물에 밝히고 수치를 지어내지 않았으며 승인 기준을 바꾸지 않았다고 기록했다.
