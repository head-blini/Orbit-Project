# Orbit 공동 개발 운영 — Claude Code · Codex

- 작성: 2026-10-28 (KST), 사용자 지시로 ‘Codex 단독 개발’을 공동 개발로 정정
- 상위 기준: `docs/ORBIT-VISION.md` → `docs/ORBIT-SCOPE-2026-10-27.md`(v1.1) → `docs/ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`
- 진행 기록: `docs/ORBIT-STATUS.md`

이 문서는 **Orbit을 개발하는 도구**의 분담이다. Orbit 제품이 연동하는 실행기(Codex·Claude Code·ChatGPT 웹 등)와 혼동하지 않는다.

## 1. 확인한 개발 환경 (2026-10-28)

| 항목 | 값 | 사용 방식 |
|---|---|---|
| Claude Code | 2.1.312 | 메인 세션, 독립 모듈 구현, 통합 커밋 |
| Codex CLI | 0.163.0, ChatGPT 로그인 | `codex exec -C <worktree> -s workspace-write` 비대화 실행. 구독 인증만 사용, API 키 과금 경로 없음 |
| `codex-plugin-cc` | 미설치 | 설치는 사용자 승인 대상. 미설치 상태에서는 위 공식 `codex exec`를 사용 |
| Node / Git | 24.22.1 / 2.50.1 | 각 worktree에서 `npm ci` 후 `npm run verify` |

Codex 비대화 실행은 sandbox(`workspace-write`)에서 해당 worktree만 쓴다. Codex는 커밋하지 않고, Claude Code 메인 세션이 diff 검토·전체 검증 후 로컬 커밋한다.

## 2. 브랜치와 worktree

| 역할 | 브랜치 | 경로 |
|---|---|---|
| 통합 기준 | `codex/orbit-mac-handoff-2026-10-26` | 저장소 루트 |
| Codex — 공통 계약·서버·DB | `codex/core-*` | `.worktrees/codex-core` |
| Claude Code — 독립 UI·브라우저·Claude 연결 | `claude/*` | `.worktrees/claude-ui` |

- 같은 브랜치를 두 worktree에서 checkout하지 않는다. reset --hard/clean/force push/main 병합 금지.
- 통합은 순차 병합(`git merge --no-ff`)으로 하며 충돌을 강제로 해결하지 않는다. 원격 Push는 사용자 승인 후에만.

## 3. 파일 소유권

| 소유 | 쓰기 가능 |
|---|---|
| **Codex** | `shared/types.ts`, `shared/parallel.ts`, 기존 `shared/*.ts` 계약, `server/controller.ts`, `server/http.ts`, `server/store.ts`, `server/main.ts`, `server/rpc.ts`, `server/projects.ts`, `server/project-creation.ts`, `server/workspace.ts`, `server/studio.ts`, `server/planning/**`, DB 스키마·migration, `package*.json`, 해당 테스트 |
| **Claude Code** | `web/**`(UI 셸 포함), 신규 `shared/project-progress.ts`, 신규 `server/project-progress.ts`, 신규 `server/runtimes/**`(Claude Code 어댑터), 신규 `server/browser/**`(BrowserAdapter), `scripts/**` 중 E2E, 해당 테스트, `docs/ORBIT-STATUS.md`, 이 문서 |
| 공동(순차) | 라우트 등록 1~2줄처럼 상대 소유 파일에 대한 최소 연결은 상대 작업이 병합된 뒤 통합 단계에서만 적용하고 STATUS에 기록 |

새 공통 타입이 필요하면 소유자에게 제안(계약 diff + 실패 테스트)하고 소유자가 적용한다.

## 4. 인계 형식

각 작업 단위 종료 시 STATUS의 해당 F 행과 아래 항목을 갱신한다.

`base SHA / head SHA / 변경 파일 / 실행 명령과 exit code / 단위·HTTP·브라우저·실연동 구분 / 남은 문제 / 다음 행동`

## 5. 브라우저 자동화 결정

- `BrowserAdapter` 계층을 두고 특정 Chrome 확장에 종속하지 않는다. 후보: `agent-browser`(AI의 일반 브라우저 작업), Playwright(제품 UI/E2E). 둘 다 이 Mac에 **미설치**이며 설치는 사용자 승인 후 진행한다.
- 어댑터는 설치·실행 가능·지원 기능을 probe로 확인하고 미확인은 `unknown`/`not_installed`로 표시한다. 세션 진행·오류·중단은 Orbit 이벤트로 기록한다.
- 쿠키·토큰·브라우저 프로필 경로는 Git·로그·결과물·이벤트에 저장하지 않는다.
- **ChatGPT 웹 자동 입력·응답 추출은 실행하지 않는다.** 이용 조건과 공식 지원 경로를 확인하기 전에는 ‘차단: 정책 확인 필요’로 유지하고, 기존 수동 Planning Handoff(Markdown 내보내기/가져오기)를 사용자 인계 경로로 유지한다. 유료 API 자동 전환으로 대체하지 않는다.
