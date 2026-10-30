# LIVE-B — 수용 기준 B 코드 프로젝트 실제 E2E (2026-10-30)

근거: `ORBIT-DECISION-2026-10-30-APPROVALS.md` #1, #2, #5, `ORBIT-VISION.md` §6.
Node 24.22.1, Claude Code 2.1.312, codex-cli 0.165.0. 데이터 폴더 `/private/tmp/orbit-live-b-9bZygJ` 하나를 두 번에 나눠 진행했다.

| 회차 | 시각 (KST) | 기준 | 결과 |
|---|---|---|---|
| 1회차 (`--approved-live`) | 11:03:55–11:04:49 | `3700c8e` | 기획·탐색·승인까지 통과, Codex 실행 전 `EXECUTION_BRIEF_TOO_LARGE`로 차단 |
| 제품 수정 | — | `81c214d` | 미채택 재사용 결정을 실행 지시문에서 제외, npm `name@version`을 e-mail로 보지 않음 |
| 재개 (`--approved-live --resume`) | 11:36:22–11:38:02 | `81c214d` 위 `claude/live-b` | 같은 승인 기획·작업으로 Codex 실행부터 진행, 전 단계 통과 |

재개에서는 기획과 재사용 탐색을 다시 하지 않았다. 재개 harness는 Claude 기획·탐색 실행기를 아예 금지하고 시작한다.

## 결론

**코드 프로젝트 경로의 수용 기준 B 흐름은 실제 구독 CLI로 끝까지 통과했다.** 순서는 자연어 요청 → Claude 기획 + 공개 재사용 탐색 → 사용자 승인 → 작업 생성 → Codex 실행 → Orbit 검증 명령 통과 → 개발 결과 화면 → 앱 미리보기 → Codex 리뷰 → 진행판 한곳 확인이다. 다만 아래가 남았다.
- Claude 교차 리뷰는 정책대로 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 차단됐다.
- 재사용 탐색이 채택 후보를 내지 않아 vendor 단계는 실제로 실행되지 않았다.
- Codex 리뷰가 P2 지적 1건을 남겼고 수정하지 않았다(아래 발견 4).
- 사용자 결과 승인은 하지 않았다(`QUALITY_APPROVAL_MISSING`).

## 실호출 수 (누적, 실제 실행 프로세스 기준)

| 제공자 | 목적 | 1회차 | 재개 | 누적 | 예산 |
|---|---|---|---|---|---|
| Claude 구독 | 기획 | 1 | 0 | 1 | 1 |
| Claude 구독 | 재사용 웹 탐색 | 1 | 0 | 1 | 1 |
| Claude 구독 | 수정 / 리뷰 | 0 | 0 | 0 | ≤1 / 1 |
| Codex 구독 | 실행 | 0 | 1 | 1 | 1 |
| Codex 구독 | 수정 | 0 | 0 | 0 | ≤1 |
| Codex 구독 | 리뷰 | 0 | 1 | 1 | 1 |

- 합계: Claude 2회(예산 6회), Codex 2회(예산 3회). 재시도 0회. 유료 API, 설치, 로그인 변경, Push 없음.
- **장부 보정:** 1회차 harness는 Codex 실행 예산을 연결 전에 먼저 차감했다. 그래서 장부(`/private/tmp/orbit-live-b-ledger.json`)에 `codex.execution=1`이 남았다. 1회차 증거 `codexProcesses: []`가 보여 주듯 실제로 실행된 Codex 프로세스는 없었다. 재개 harness는 1회차 증거의 실제 프로세스 수로 장부를 1 → 0으로 한 번 보정했다. 보정 사유는 장부 `corrections`에 남겼다. 이후 차감은 실행 지시문 확인 뒤, 실행 직전에만 한다.
- 관측 모델:
  - Claude 두 호출: `claude-opus-5-5`, 인증 `subscription`.
  - Codex 실행: 서버 설정 `gpt-6-astra`(thread/start). 실제 모델은 `unknown`(`actualModelEvidence: unavailable`)이며 실제 모델로 승격하지 않았다.

## 단계별 결과

| 단계 | 결과 | 근거·코드 |
|---|---|---|
| 일회용 Git 데모 저장소 + 코드 프로젝트 등록, 격리 worktree 생성·선택 | 통과 (1회차) | HTTP `/api/projects`, `/api/workspaces`, `/api/workspaces/select` |
| AI 선택 (기획 Claude Code, 실행 Codex) | 통과 (1회차) | `ai-preferences` revision 1 |
| 검증 명령 설정 (`node --test -- date-format.test.mjs`, 테스트 파일 보호) | 통과 (1회차) | `verification-setup` revision 1 |
| 자연어 요청 → Claude 기획 | 통과 (1회차) | suggestion `37eba4c0-…` `completed`, 요구사항 1개, 열린 질문 0개 |
| 공개 재사용 탐색 (Claude research 모드) | 통과 (1회차) | `searched`, date-fns 4.4.0과 dayjs 1.11.23 모두 미채택 |
| 기획 저장·승인·작업 생성 | 통과 (1회차) | 버전 `b130bdfc-…` revision 1, 작업 `0757ddaa-…` 1개. 사용자 수정 없음 |
| Codex 실행 (1회차) | **차단** | `EXECUTION_BRIEF_TOO_LARGE` (4,395자 > 4,000). Codex 연결 전, 프로세스 0개 |
| 재개: 저장된 상태 재로드 | 통과 | 같은 프로젝트·worktree·승인 기획·작업. 이전 Run 0개 |
| Codex 실행 | 통과 | run `8624b2ee-…` `completed`, 63.3초. 새 파일 `index.html`, `src/date-format.mjs`만 생성(untracked). 테스트 파일 sha256 변화 없음. 원본 저장소 clean |
| Orbit 검증 명령 | 통과 | check `7d42e6f9-…` verdict `passed`, exit 0, 5.5초. 수용 기준 `current`, `canApprove: true` |
| Codex 수정 | 불필요 | 검증 통과로 실행 안 함 |
| 개발 결과 화면 (`/api/workspaces/:id/result`) | 통과 | run·작업·승인 기획(`current: true`)·검증 check `passed`가 한 화면 데이터에 연결됨, `linkIssue: null` |
| 앱 미리보기 | 통과 | 진입점 `index.html`, 파일 3개 호스팅. HTTP 200, 제공 바이트가 worktree 파일과 동일. 격리 CSP(`sandbox allow-scripts`, `connect-src 'none'`) |
| 재사용 vendor | 건너뜀(정상) | 승인 기획에 채택 결정 없음 → `NO_ADOPT_DECISION_WITH_EXACT_SEMVER`. 외부 다운로드 0회. 순서는 요청대로 미리보기 → vendor → 리뷰로 되돌림 |
| Codex 리뷰 | 통과 | 읽기 전용 text-only 리뷰 `completed`, 25.0초, 프로세스 종료 확인. 지적 1건(P2, 발견 4) |
| Claude 교차 리뷰 | 차단(정책) | 품질 루프 `QUALITY_PRODUCER_MODEL_UNKNOWN`, calls 0, steps 0. Claude 프로세스 0개 |
| 진행판 한곳 확인 (`/progress`) | 통과 | 작업 `stage: verified`, 담당 `codex`, `verification: passed`, 기준 8/8 verified, 마지막 관측 시각 표시. 품질 항목 semantic/independentReview `blocked: QUALITY_PRODUCER_MODEL_UNKNOWN`, userApproval `QUALITY_APPROVAL_MISSING`. GET은 이벤트를 쓰지 않음 |

외부로 나간 내용은 다음뿐이다.
- 데모 요청 문장: Claude 기획.
- 기획 제목·목표·요구사항: 재사용 탐색 질의.
- 승인 기획과 일회용 데모 저장소: Codex 실행.
- 데모 저장소 diff: Codex 리뷰.

## 비전 §6 항목별 실증 여부 (코드 작업)

| §6 항목 | 실호출로 증명 | 비고 |
|---|---|---|
| 자연어로 프로젝트 생성 | 부분 | 코드 프로젝트는 데모 Git 경로 등록으로 생성했다. 자연어 요청은 기획 단계 입력이다 |
| 기획 명세 승인 | 예 | Claude 실제 기획 → 저장 → 승인 → 작업 생성 |
| 선택한 AI로 실행 | 예 | 프로젝트 설정의 실행 AI(Codex)로 승인 작업 실행, 검증 통과 |
| 다른 AI 인계 시 확정 기준·결정 이유 유지 | 부분 | Claude 기획 → Codex 실행에서 승인 기준·결정이 실행 지시문으로 넘어갔고 검증까지 이어졌다. 다만 미채택 재사용 결정은 이제 지시문에서 빠진다(기획 본문에는 남음). Codex → Claude 리뷰 인계는 모델 미관측으로 차단됐다 |
| 진행 상태·막힌 이유·검증 결과·산출물 한곳 확인 | 예 (성공 경로) | `/progress`와 개발 결과 화면에서 확인. 단 실행 전 차단 사유는 진행판에 안 보인다(발견 2) |
| 실제 연결 미검증 기능을 완료로 표시하지 않음 | 예 | Codex 실제 모델 `unknown` 유지. 교차 리뷰·사용자 승인 미완료를 blocked/not_run으로 표시 |

비코드 작업 쪽 §6 검증은 이 문서 범위 밖이다.

## 사전 리허설(dry-run)

두 회차 모두 실호출 전에 같은 harness를 `--dry-run`으로 돌렸다. 이 모드는 Orbit HTTP 흐름은 그대로 쓰고 제공자만 프로세스 내 가짜로 바꾼다. Claude·Codex 프로세스는 없고 jsDelivr 응답도 대체한다.
- 재개 경로는 `--dry-run --stop-after-approval`로 만든 별도 상태를 `--dry-run --resume`으로 이어서 확인했다. 이 리허설에서는 가짜 채택 결정 때문에 vendor 뒤 Codex 리뷰까지 통과했다. 수정 `81c214d`의 e-mail 오탐 해소를 mock으로 확인한 것이다.
- 증거: `docs/evidence/live-b-dryrun-2026-10-30.json`(mock, 실제 연동 증명 아님).

## 발견 사항 (후속 입력)

1. **[수정됨 `81c214d`] 승인 가능한 기획이 실행 불가** — 1회차 지시문은 4,395자였고 그중 미채택 재사용 결정 3개가 589자였다. 수정 후 같은 기획의 지시문은 3,778자다(조정자가 사본 DB로 측정). 재개에서 실제로 실행됐다.
   - **남은 일:** 승인·작업 생성 시점의 지시문 크기 검사가 여전히 없다. 상한 검사는 Run 직전(`server/planning/execution.ts`의 `EXECUTION_BRIEF_TOO_LARGE`)에만 있다. 상세 기획이 더 길면 같은 문제가 다시 생길 수 있다. 기획 프롬프트에도 상한 안내가 없다.
2. **[미해결] 실행 전 차단 사유가 진행판에 안 보임** — 1회차에서 `EXECUTION_BRIEF_TOO_LARGE`는 HTTP 오류로만 돌아왔다. 그때 `/progress`는 `blockers: []`, `nextAction: execute_task`였다. §6 "막힌 이유를 한곳에서 확인"에 어긋난다.
3. **[수정됨 `81c214d`, 실호출 미검증] vendor 증거 URL의 e-mail 오탐** — `dayjs@1.11.13` 같은 npm 표기가 e-mail로 판단돼 vendor 후 리뷰·품질 미리보기가 `REVIEW_OUTBOUND_DENIED` / `PERSONAL_DATA_BLOCKED`로 막혔다. 수정 후 mock 리허설에서는 vendor 뒤 리뷰가 통과했다. 실호출에서는 채택 결정이 없어 vendor 자체를 검증하지 못했다.
4. **[미해결, 데모 산출물] Codex 리뷰 P2 지적** — `index.html` 46–49행에 대한 지적이다. 브라우저 시간대에서 건너뛴 날짜(예: `Pacific/Apia`의 2011-12-30)를 고르면 `new Date`/`setFullYear` 보정 때문에 다른 날짜가 표시된다. 검증 명령(`formatDate` 단위 테스트)은 이 UI 경로를 다루지 않는다. 수정 호출(≤1)은 검증 실패 때만 쓰도록 harness를 짰기 때문에 사용하지 않았다. 리뷰 지적을 수정 대상으로 넘기는 흐름은 후속 결정이 필요하다.
5. **[기존] Codex 실제 모델 관측 불가** — 실행 Run의 actual model이 `unknown`이다. 그래서 Claude 교차 리뷰(semantic·independentReview)가 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 차단된다. 이번 E2E의 독립 리뷰는 Codex 자기 리뷰다.
6. **사용자 결과 승인 미실행** — 검증 `canApprove: true`지만 harness는 사용자 결과 승인(`review-approval`)을 대신하지 않았다. 진행판 userApproval은 `QUALITY_APPROVAL_MISSING`이다.

## 산출물

- Harness: `scripts/live-b-e2e.ts`
  - `--approved-live` 또는 `--dry-run`이 없으면 실행을 거부한다.
  - `--resume <dir>`로 저장된 상태에서 이어 갈 수 있다. `--stop-after-approval`은 dry-run 전용이다.
  - 테스트에서 import하지 않는다.
  - 제공자 경계에서 목적별·누적 예산을 차감한다.
- 실호출 증거: `docs/evidence/live-b-2026-10-30.json` (`firstRun`, `resumedRun`, `ledgerFinal`. 원본은 `/private/tmp/orbit-live-b-9bZygJ/evidence.json`, `evidence-resume.json`)
- 리허설 증거(mock): `docs/evidence/live-b-dryrun-2026-10-30.json`
