# Orbit 수용 증거 원장 (PRODUCT-D1, 2026-10-29 KST)

작성: Claude worker (Plan, model opus via model-routing ledger `PRODUCT-D1`), read-only, 기준 HEAD `0484c41`. 검토: Claude Code 오케스트레이터.

수준 표기:
- impl = 구현
- mock = mock 테스트
- native = 실제 CLI 호출
- integ = 통합 E2E
- blocked = 정책상 차단
- unverified = 미검증

라이브 증거 대부분은 현재 HEAD 이전에 수집했다. 이후 PW·CQG·USAGE·REGISTRY가 병합되었다. 그래서 출시 판정 전에 현재 HEAD에서 다시 실행해야 하고, 실호출에는 사용자 승인이 필요하다.

**2026-10-30 갱신(RELEASE-DOCS)**: 개발 브랜치 HEAD `ea59619`(배치 1~19), 마지막 전체 verify 2086 tests / 2084 pass / 0 fail / 2 skip(`.local/orchestrator/STATE.md` 기록). 아래 갱신된 mock 행은 fake/mock 테스트 증거이며 live 검증이 아니다. mock 성공은 Provider 성공이 아니다. `native`·`integ` live 증거는 표기된 구 HEAD 기준이고 `ea59619`에서 재실행하지 않았다. 열린 승인·결정 항목은 [STATUS의 "남은 차단·승인 필요"](ORBIT-STATUS.md)에 모았다.

| ID | 수준 | 증거 / 공백 |
|---|---|---|
| A01 | integ (구 HEAD `8132244`) | STATUS FF1 Chrome. 실제 Claude로 기획→승인→실행→후속→재시작 |
| A02 | mock | `tests/planning-baseline.test.ts` |
| A03 | mock + 브라우저 일부 | P7 `c0c6ab9`가 기준 변경·영향 stale 화면 추가(UI 테스트, mock). 현재 HEAD 브라우저·live 확인 없음 |
| A04 | native | `docs/ORBIT-LIVE-CLI-2026-10-29.md`, `docs/evidence/live-cli-codex-2026-10-29.json`. 실제 모델 unknown. UI 경유 E2E 없음 |
| A05 | native (+구 integ) | LIVE-CLI Claude `execute.general`, `scripts/verify-claude-runtime.mjs` |
| A06 | blocked → **deferred** (2026-10-29 사용자 결정) | `docs/ORBIT-GPT-D1.md`, `docs/ORBIT-DECISION-2026-10-29-GPT-DEFERRED.md`. 1차 완료 기준 제외, 전체 제품 완료 기준 포함. GPT-G1/G2/G3 브랜치 보존·통합 제외 |
| A07 | mock | HANDOFF-RECEIPT `726bb48`(append-only 인계 이력·수신 기록, mock), UI 수정 `6a121ad`. Codex 기록 경로 전용 테스트 없음. Codex↔Claude 인계 live 실행 없음 |
| A08 | mock / blocked | CQG-1~6c 병합(mock). Reviewer live 호출 0회(승인 필요). Codex 쪽은 `QUALITY_PRODUCER_MODEL_UNKNOWN`(app_server가 모델 미노출, 외부 한계) |
| A09 | integ (구 HEAD) | 진행판 Chrome 라이브 |
| A10 | native 일부 + mock | FF1 재시작. HTTP 전체 재시작 라이브 증명 없음. fake: `tests/worker-http.test.ts`. RECOVERY-UX `ce66c15`·`787e093`(Claude lost run 명시 복구, mock). 복구 live 없음 |
| A11 | mock | P7 `c0c6ab9` 영향·stale 화면(UI 테스트). 현재 HEAD 브라우저·live 확인 없음 |
| A12 | integ (구 HEAD `4e52d99`) + mock | 진행판 간편 표현은 P7 `c0c6ab9`(UI 테스트)로 반영. 기획 스튜디오 내부 간편 표현은 미확인 |
| A13 | integ 일부 (구 HEAD) + mock | 결과물 바이트 읽기·다운로드·버전 이력·Goal 증거 참조는 P2/P4/P5/P6 `f0cc85e`(fake/mock). 통합 결과물 버전의 runId/taskId null(goal 참조 제외). 현재 HEAD live 없음 |
| A14 | mock | Usage U1~U4(`0b6fe1e`, `66476f8`, `764e88f`, `25ca69b`). 실제 quota 조회 0회 |
| A15 | mock + blocked | `docs/ORBIT-TOOLS-D1.md`. T1 `52e8fbe`·T2 `2c4e3db` ·T3~T6(배치 1)·T7 `c9b6eb9`(승인된 도구 호출 Codex·CQG 연결, T7-FOLLOWUP `be88ce8`)는 mock 테스트. 실제 도구 호출(TOOLS-T8)은 승인 대기. Skills/Claude MCP/Plugins 정책 확장도 승인 대기. 비허용 호출 차단은 mock으로만 확인 |
| A16 | 부분 + mock | 비코드는 FF1 integ(구 HEAD), 코드는 UI 경유 E2E 없음. P8 `f55fdf5` fake 종단 테스트(일반·코드). CODE-RUN-PROJECT `1cfe368`·CODE-SOURCE-DIGEST `3fcbe19`로 코드 auto-apply 결함 수정(mock) |
| AX01 | mock | `tests/worker-scheduler.test.ts` barrier. PW-1~5 병합(`e0c26f0`…`0d09e11`), live 병렬 실행 없음 |
| AX02 | mock | `tests/worker-resources.test.ts`, `tests/integration-queue.test.ts` |
| AX03 | mock | `tests/worker-scheduler.test.ts`, `tests/worker-http.test.ts` |
| AX04 | impl + mock | `tests/task-completion.test.ts`. 서버 연결은 CQG-4(`5aee43a`), 후보 완료 계약 CQG-6a/6c. Codex 모델 unknown은 차단 유지 |
| AX05 | mock | FE-1~4(`ee6c22e`…`27352d8`), HE-3 `52a90fe`·HE-4 `b3877b1`(보호 A/B 평가, mock). production runner·suite 없어 실제 평가는 `RUNNER_UNAVAILABLE`, 승격 불가. live 평가는 승인 필요 |
| AX06 | mock | HE-1 `6db691c` 검증 무력화 후보 거절 정책, HE-2·HE-5a/5b·HE-6·HE-7(mock). live 없음 |
| AX07 | mock | TaskGraph HTTP `4c506d2`, 패널 P3, P7 `c0c6ab9`가 패널 마운트. P8 fake 종단 테스트. 코드 1건+비코드 1건 UI 경유 live 증거 없음 |

## 남은 작업 (PRODUCT)

| 단위 | 시점 | 파일 | 상태 (2026-10-30, `ea59619`) |
|---|---|---|---|
| P1 일반 프로젝트 Goal 실행 포함 (버그 의심: `server/goal-service.ts:119`가 `workspaceId` 없는 run 제외) | 지금 | `server/goal-service.ts`, `tests/goals.test.ts` | 병합(배치 1, mock 테스트) |
| P2 결과물 바이트 읽기 (순수) | 지금 | `server/deliverables.ts`, `tests/deliverables.test.ts` | 병합(배치 1, mock 테스트) |
| P3 작업 그래프·queue 읽기 패널 (실행 버튼 없음) | 지금 (마운트는 CQG-5 이후) | `web/task-graph-panel.tsx`, `tests/task-graph-ui.test.ts` | 병합(배치 1), 마운트는 P7 `c0c6ab9` |
| P4 다운로드 경로·버튼 | CQG-4 이후 | `server/http.ts`, `server/controller.ts`, `web/deliverables.tsx` | 병합 `f0cc85e`(mock) |
| P5 결과물 버전 기록 | CQG-4 이후 | `server/deliverable-versions.ts` 등 | 병합 `f0cc85e`(mock) |
| P6 Goal에 결과물·완료 증거 참조 | CQG-4 이후 | `shared/goals.ts`, `server/goal-service.ts`, `web/goals.tsx` | 병합 `f0cc85e`(mock) |
| P7 진행판 간편 표현·X07 표시 | CQG-5 이후 | `web/project-progress.tsx`, `web/project-work-model.ts` | 병합 `c0c6ab9`(UI 테스트) |
| P8 fake 종단 테스트 (AX07·A16) | CQG-4/5 이후 | `tests/product-e2e.test.ts` | 병합 `f55fdf5`(fake 종단, UI 경유 live 아님) |

Graphify(여전히 사용자 결정 대기): 제품 안에는 자체 TS-AST 소스 그래프가 있다(`server/source-graph-service.ts`). 이것을 "Graphify 또는 검증된 대안"으로 인정할지는 사용자 결정이다. Graphify CLI 연동은 설치와 subprocess 실행이 필요하므로 별도 승인 사항이다.

## 실제 E2E가 필요한 항목 (실호출 승인 필요, 2026-10-30에도 모두 미실행)

- 현재 HEAD 재실행: A01·A09·A12·A13 비코드 흐름, A04·A05
- A07 Codex↔Claude 인계
- A08 다른 모델 Reviewer 호출
- A10 라이브 실행 중 HTTP 재시작
- A16·AX07 코드 1건 + 비코드 1건 UI 경유
- A14 실제 quota 관측
- AX01~AX03 두 Worker 동시 라이브 실행
- A06(deferred)·A15(TOOLS-T8)는 실연결 경로 승인이 먼저 필요하다
- 이 외 열린 결정·승인(CQG-6B-CTL, GENERAL-ACCEPT-B, RECOVERY-UX, F02-REG, FE-5, REG-ISOLATED-PLANNING, Harness live runner, Graphify, 도구 정책 확장)은 [STATUS](ORBIT-STATUS.md) 참조
