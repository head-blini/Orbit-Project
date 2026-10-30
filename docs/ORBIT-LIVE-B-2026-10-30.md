# LIVE-B — 수용 기준 B 코드 프로젝트 실제 E2E (2026-10-30)

근거: `ORBIT-DECISION-2026-10-30-APPROVALS.md` #1, #2, #5, `ORBIT-VISION.md` §6.
기준 HEAD `3700c8e` (`claude/live-b`). Node 24.22.1, Claude Code 2.1.312, codex-cli 0.165.0.
실행: 2026-10-30 11:03:55–11:04:49 KST, 54.2초, 실호출 1회차(재실행 없음).

## 결론

**수용 기준 B 코드 경로는 실제로 완료되지 않았다.** 자연어 요청, Claude 기획, 재사용 웹 탐색, 기획 승인, 작업 생성까지는 실제 구독 CLI로 통과했다. 그다음 Codex 실행 직전에 Orbit 제품이 `EXECUTION_BRIEF_TOO_LARGE`(422)로 막았다. Claude가 만든 승인 기획의 실행 지시문이 4,395자로 상한 4,000자를 넘었다. 지시대로 이 단계에서 멈췄고, 기획 수정이나 우회 실행은 하지 않았다. 그래서 Codex 실행, 검증 명령, 결과 화면, 앱 미리보기, Codex 리뷰는 실제로 검증되지 않았다.

## 실호출 수 (예산 대비)

| 제공자 | 목적 | 실제 실행 프로세스 | 예산 |
|---|---|---|---|
| Claude 구독 | 기획 (`planning`) | 1 (완료, exit observed, 35.4초) | 1 |
| Claude 구독 | 재사용 웹 탐색 (`research`) | 1 (완료, exit observed, 15.4초) | 1 |
| Claude 구독 | 수정 / 리뷰 | 0 | ≤1 / 1 |
| Claude 합계 | | **2** | ≤6 |
| Codex 구독 | 실행 / 수정 / 리뷰 | **0 / 0 / 0** | 1 / ≤1 / 1 |

- 재시도 0회. 유료 API, 설치, 로그인 변경, Push 없음.
- 관측 모델: 두 Claude 호출 모두 `claude-opus-5-5`, 인증 `subscription`(session 이벤트 기준).
- Codex 프로세스는 한 번도 실행되지 않았다(`codexProcesses: []`). 다만 실호출 당시 harness는 Codex 실행 예산을 연결 전에 먼저 차감했다. 그래서 증거 `calls.codex.execution`과 누적 장부(`/private/tmp/orbit-live-b-ledger.json`)에는 1로 남아 있다. 실제 Codex 사용은 0회다. 이후 harness를 고쳐 실행 지시문 사전 확인 뒤, 실행 직전에만 차감하도록 했다(재실행은 하지 않음).

## 단계별 결과

| 단계 | 결과 | 근거·코드 |
|---|---|---|
| 일회용 Git 데모 저장소 + Orbit 코드 프로젝트 등록, 격리 worktree 생성·선택 | 통과 | HTTP `/api/projects`, `/api/workspaces`, `/api/workspaces/select` |
| AI 선택 (기획 Claude Code, 실행 Codex) | 통과 | `ai-preferences` revision 1 |
| 검증 명령 설정 (`node --test -- date-format.test.mjs`, 테스트 파일 보호) | 통과 | `verification-setup` 영수증 revision 1 |
| 자연어 요청 → Claude 기획 제안 | 통과 | suggestion `37eba4c0-…`, `completed`, 요구사항 1개, 열린 질문 0개, 51.98초(탐색 포함) |
| 공개 재사용 탐색 (Claude research 모드, WebSearch/WebFetch) | 통과 | `searched`, 후보 2개(date-fns 4.4.0, dayjs 1.11.23) 모두 **미채택**, 결정 3개가 기획에 병합됨 |
| 기획 저장·승인·작업 생성 | 통과 | 버전 `b130bdfc-…` revision 1 승인, 작업 1개. 사용자 수정 불필요 |
| 재사용 vendor (jsDelivr 고정 버전) | 건너뜀(정상) | 채택 결정 없음 → `NO_ADOPT_DECISION_WITH_EXACT_SEMVER`, 외부 다운로드 0회 |
| Codex 실행 | **차단** | `EXECUTION_BRIEF_TOO_LARGE` (작업 검증 미리보기 단계, Codex 연결 전) |
| 검증 명령 실행 / 수정 / 개발 결과 화면 / 앱 미리보기 / Codex 리뷰 | 미실행 | 실행 차단으로 선행 Run 없음 |
| Claude 교차 리뷰 | 미실행(실 run 없음) | 정책상 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 차단되는 경로. 이번 실호출에서는 Run이 없어 도달하지 못함 |
| 진행판 읽기 (`/progress`) | 통과 | GET이 이벤트를 쓰지 않음(`readOnly: true`), 원본 저장소 clean |

외부로 나간 내용은 데모 요청 문장(Claude 기획)과 기획 제목·목표·요구사항(재사용 탐색 질의)뿐이다. 기획 세션은 읽기 전용 Claude Code이며 harness가 만든 데모 저장소(README, 테스트 파일)만 볼 수 있었다.

## 비전 §6 항목별 실증 여부

| §6 항목 | 이번 실호출로 증명 | 비고 |
|---|---|---|
| 자연어로 프로젝트 생성 | 부분 | 코드 프로젝트는 데모 Git 경로 등록으로 생성. 자연어 요청은 기획 단계 입력 |
| 기획 명세 승인 | **예** | Claude 실제 기획 → 저장 → 승인 → 작업 생성 |
| 선택한 AI로 실행 | **아니오** | `EXECUTION_BRIEF_TOO_LARGE`로 Codex 실행 전 차단 |
| 다른 AI 인계 시 기준·결정 유지 | 아니오 | 인계 대상 실행이 없음 |
| 진행 상태·막힌 이유·검증 결과·산출물 한곳 확인 | 아니오 | 진행판은 읽혔지만 막힌 이유가 보이지 않음(발견 2) |
| 실제 연결 미검증 기능을 완료로 표시하지 않음 | 예 | 진행판 `verification: not_run`, `nextAction: execute_task`, 완료 표시 없음 |

## 사전 리허설(dry-run)

실호출 전에 같은 harness를 `--dry-run`으로 돌렸다. 이 모드는 Orbit HTTP 흐름은 그대로 쓰고, 제공자만 프로세스 내 가짜로 바꾼다(Claude·Codex 프로세스 없음, jsDelivr 응답 대체). 전 단계가 통과했다. 수정(fix) 경로는 첫 실행 결과를 일부러 틀리게 만든 임시 변형으로 한 번 더 확인했다(이 변형의 증거는 보관하지 않음). 증거: `docs/evidence/live-b-dryrun-2026-10-30.json` (`mode: dry_run`, mock). **이 결과는 실제 연동 증명이 아니다.** 다만 아래 발견 3은 리허설에서만 재현됐다.

## 발견 사항 (후속 입력)

1. **승인 가능한 기획이 실행 불가 (제품 결함)** — `server/planning/execution.ts:62`의 4,000자 상한은 Run 시작 시점에만 검사한다. 기획 저장·승인·작업 생성 단계는 이를 막지 않는다. Claude 기획 프롬프트도 이 상한을 알려 주지 않는다. 이번 기획은 상세(`detailed`) 모드였다. 수용 기준 8개, 결정 7개, 비목표 6개, 제약 5개로 4,395자가 됐다. 결정 중 재사용 탐색이 붙인 3개가 589자(JSON 기준)를 차지했다. 재사용 결정이 없었다면 상한 안이었을 가능성이 있지만 검증하지 않았다. `tests/reuse-discovery.test.ts:90`의 "max plan still fits the Codex brief" 테스트는 실제 Claude 기획 크기를 보장하지 못한다. 후보: 승인/작업 생성 단계에서 실행 가능 크기 검사, 기획 프롬프트에 상한 안내, 또는 실행 지시문 압축.
2. **막힌 이유가 진행판에 보이지 않음** — `EXECUTION_BRIEF_TOO_LARGE`는 HTTP 오류로만 돌아온다. `/progress`는 `blockers: []`, `nextAction: execute_task`를 보여 준다. 사용자는 다시 실행해도 같은 오류를 만난다. §6 "막힌 이유를 한곳에서 확인"에 어긋난다.
3. **vendor 증거 파일이 개인정보 차단에 걸림 (리허설에서 재현, 실호출 미검증)** — `server/reuse-vendor.ts:90`이 `vendor/REUSE-EVIDENCE.json`에 `https://cdn.jsdelivr.net/npm/dayjs@1.11.13/...` 같은 URL을 쓴다. `server/guardrails/outbound.ts:42`의 e-mail 패턴이 `dayjs@1.11.13`을 e-mail로 판단한다. 그 결과 vendor 후 워크스페이스는 Codex 리뷰 미리보기가 `REVIEW_OUTBOUND_DENIED`(`server/review-input.ts:73`), 품질 루프 미리보기가 `PERSONAL_DATA_BLOCKED`로 막힌다. 즉 승인 #2의 vendor 기능을 쓰면 리뷰 경로가 막힌다. 이 때문에 harness는 vendor를 리뷰 뒤에 두고, vendor 후 미리보기만으로(호출 없이) 이 차단을 기록하도록 바꿨다.
4. **Codex 실제 모델 관측 불가 (기존)** — 이번에는 Codex Run이 없어 새로 확인하지 못했다. Claude 교차 리뷰 차단(`QUALITY_PRODUCER_MODEL_UNKNOWN`)은 리허설에서만 확인했다.
5. **재실행 예산** — Claude 기획·탐색 예산을 모두 썼다. 같은 harness의 전체 재실행은 예산 밖이다. 남은 실행을 증명하려면 새 승인(기획 1회 이상 추가) 또는 결함 1 수정 후 새 실호출 승인이 필요하다.

## 산출물

- Harness: `scripts/live-b-e2e.ts` (`--approved-live` 또는 `--dry-run` 없으면 실행 거부, 테스트에서 import하지 않음, 제공자 경계에서 목적별·누적 예산 차감)
- 실호출 증거: `docs/evidence/live-b-2026-10-30.json` (원본 `/private/tmp/orbit-live-b-9bZygJ/evidence.json`)
- 리허설 증거(mock): `docs/evidence/live-b-dryrun-2026-10-30.json`
