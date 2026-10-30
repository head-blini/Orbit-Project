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

**2026-10-30 갱신(RELEASE-GATE-DOCS)**: 개발 HEAD `1716a1a`(배치 23), 마지막 전체 verify 2137 tests / 2135 pass / 0 fail / 0 cancelled / 2 skip(오케스트레이터 기록, `.local/orchestrator/int-batch-23-verify.log`). 항목별 상태·증거·증명 HEAD·차단 코드는 [릴리스 게이트 매핑](ORBIT-RELEASE-GATE-2026-10-30.md)에 표로 모았다. 이 문서의 행에는 LIVE-B(코드 프로젝트 수용 기준 B, `78d2b91`·`8255815`)와 배치 20~23 변경만 추가했다. LIVE-B는 Orbit HTTP API를 구동했고 브라우저 UI는 구동하지 않았다. 비전 §6에 따라 실제 연결 증거가 없는 기능은 완료로 쓰지 않는다.

**2026-10-30 이전 갱신(RELEASE-DOCS)**: 개발 브랜치 HEAD `ea59619`(배치 1~19), 마지막 전체 verify 2086 tests / 2084 pass / 0 fail / 2 skip(`.local/orchestrator/STATE.md` 기록). 아래 갱신된 mock 행은 fake/mock 테스트 증거이며 live 검증이 아니다. mock 성공은 Provider 성공이 아니다. `native`·`integ` live 증거는 표기된 구 HEAD 기준이고 `ea59619`에서 재실행하지 않았다. 열린 승인·결정 항목은 [STATUS의 "남은 차단·승인 필요"](ORBIT-STATUS.md)에 모았다.

| ID | 수준 | 증거 / 공백 |
|---|---|---|
| A01 | integ (구 HEAD `8132244`) | STATUS FF1 Chrome. 실제 Claude로 기획→승인→실행→후속→재시작 |
| A02 | mock | `tests/planning-baseline.test.ts` |
| A03 | mock + 브라우저 일부 | P7 `c0c6ab9`가 기준 변경·영향 stale 화면 추가(UI 테스트, mock). 현재 HEAD 브라우저·live 확인 없음 |
| A04 | native (+ LIVE-B 코드 프로젝트 native) | `docs/ORBIT-LIVE-CLI-2026-10-29.md`(`fecf6ff`), `docs/evidence/live-cli-codex-2026-10-29.json`. LIVE-B Codex 0.165.0 코드 실행 1회·리뷰 1회 completed(`81c214d`, `docs/evidence/live-b-2026-10-30.json`). 실제 모델 unknown. UI 경유 E2E 없음 |
| A05 | native (+구 integ) | LIVE-CLI Claude `execute.general`(`fecf6ff`), `scripts/verify-claude-runtime.mjs`. LIVE-B Claude 기획·재사용 탐색 각 1회(`3700c8e`, `claude-opus-5-5`). 비코드 live는 `fecf6ff` 이후 없음 |
| A06 | blocked → **deferred** (2026-10-29 사용자 결정) | `docs/ORBIT-GPT-D1.md`, `docs/ORBIT-DECISION-2026-10-29-GPT-DEFERRED.md`. 1차 완료 기준 제외, 전체 제품 완료 기준 포함. GPT-G1/G2/G3 브랜치 보존·통합 제외 |
| A07 | mock | HANDOFF-RECEIPT `726bb48`(append-only 인계 이력·수신 기록, mock), UI 수정 `6a121ad`. Codex 기록 경로 전용 테스트 없음. Codex↔Claude 인계 live 실행 없음 |
| A08 | mock / blocked | CQG-1~6c 병합(mock). 다른 모델 Reviewer live 호출 0회(승인 필요). LIVE-B에서 Codex 자기 리뷰만 live(`81c214d`, P2 1건 미수정). Claude 교차 리뷰는 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 차단(calls 0, app_server가 모델 미노출, 외부 한계) |
| A09 | integ (구 HEAD) | 진행판 Chrome 라이브 |
| A10 | native 일부 + mock | FF1 재시작. HTTP 전체 재시작 라이브 증명 없음. fake: `tests/worker-http.test.ts`. RECOVERY-UX `ce66c15`·`787e093`(Claude lost run 명시 복구, mock). 복구 live 없음 |
| A11 | mock | P7 `c0c6ab9` 영향·stale 화면(UI 테스트). 현재 HEAD 브라우저·live 확인 없음 |
| A12 | integ (구 HEAD `4e52d99`) + mock | 진행판 간편 표현은 P7 `c0c6ab9`(UI 테스트)로 반영. 기획 스튜디오 내부 간편 표현은 미확인 |
| A13 | integ 일부 (구 HEAD) + mock + LIVE-B 코드 결과·앱 미리보기(HTTP 200, `81c214d`, 렌더링 확인 아님) | 결과물 바이트 읽기·다운로드·버전 이력·Goal 증거 참조는 P2/P4/P5/P6 `f0cc85e`(fake/mock). 통합 결과물 버전의 runId/taskId null(goal 참조 제외). 현재 HEAD live 없음 |
| A14 | mock | Usage U1~U4(`0b6fe1e`, `66476f8`, `764e88f`, `25ca69b`). 실제 quota 조회 0회 |
| A15 | mock + blocked | `docs/ORBIT-TOOLS-D1.md`. T1 `52e8fbe`·T2 `2c4e3db` ·T3~T6(배치 1)·T7 `c9b6eb9`(승인된 도구 호출 Codex·CQG 연결, T7-FOLLOWUP `be88ce8`)는 mock 테스트. 실제 도구 호출(TOOLS-T8)은 승인 대기. Skills/Claude MCP/Plugins 정책 확장도 승인 대기. 비허용 호출 차단은 mock으로만 확인 |
| A16 | 부분 + mock | 비코드는 FF1 integ(구 HEAD), 코드는 LIVE-B로 HTTP 경유 live 1건(`81c214d`, 기획→승인→Codex 실행→검증 passed→미리보기→Codex 리뷰, vendor·Claude 교차 리뷰·사용자 결과 승인 미완), UI 경유 E2E 없음. 비코드 회귀·실패·재개는 `1716a1a` verify mock(일반 여정 5건, `general` 72·`recover` 46·`interrupt` 58·`lost` 49·`resume` 8 pass, live 실패·재개 없음). P8 `f55fdf5` fake 종단 테스트(일반·코드). CODE-RUN-PROJECT `1cfe368`·CODE-SOURCE-DIGEST `3fcbe19`로 코드 auto-apply 결함 수정(mock) |
| AX01 | mock | `tests/worker-scheduler.test.ts` barrier. PW-1~5 병합(`e0c26f0`…`0d09e11`), live 병렬 실행 없음 |
| AX02 | mock | `tests/worker-resources.test.ts`, `tests/integration-queue.test.ts` |
| AX03 | mock | `tests/worker-scheduler.test.ts`, `tests/worker-http.test.ts`. FLAKE-P8-RESTART `1267fdb`: dispatch 거절 시 온전한 space를 격리하지 않음(probe 캐시 60초 TTL 만료가 원인, mock) |
| AX04 | impl + mock | `tests/task-completion.test.ts`. 서버 연결은 CQG-4(`5aee43a`), 후보 완료 계약 CQG-6a/6c. Codex 모델 unknown은 차단 유지(LIVE-B에서도 `QUALITY_PRODUCER_MODEL_UNKNOWN`) |
| AX05 | mock | FE-1~4(`ee6c22e`…`27352d8`), HE-3 `52a90fe`·HE-4 `b3877b1`(보호 A/B 평가, mock). production runner·suite 없어 실제 평가는 `RUNNER_UNAVAILABLE`, 승격 불가. live 평가는 승인 필요 |
| AX06 | mock | HE-1 `6db691c` 검증 무력화 후보 거절 정책, HE-2·HE-5a/5b·HE-6·HE-7(mock). live 없음 |
| AX07 | mock | TaskGraph HTTP `4c506d2`, 패널 P3, P7 `c0c6ab9`가 패널 마운트. P8 fake 종단 테스트. LIVE-B 코드 1건은 HTTP 경유 live(UI 아님), 비코드는 구 HEAD FF1만. 코드 1건+비코드 1건 UI 경유 live 증거 없음 |
| B (코드 프로젝트 E2E, 2026-10-30) | native 부분 (HTTP 경유) | `docs/ORBIT-LIVE-B-2026-10-30.md`, `docs/evidence/live-b-2026-10-30.json`. `3700c8e`(기획·탐색·승인)·`81c214d`(Codex 실행~진행판). Claude 2 / Codex 2 실호출, 재시도 0. 차단: `EXECUTION_BRIEF_TOO_LARGE`(1회차, `81c214d`로 수정), Claude 교차 리뷰 `QUALITY_PRODUCER_MODEL_UNKNOWN`, `QUALITY_APPROVAL_MISSING`. vendor 실호출 없음(`NO_ADOPT_DECISION_WITH_EXACT_SEMVER`). 브라우저 UI 경유 아님 |
| C (비코드 회귀·실패·재개, 2026-10-30) | mock | `1716a1a` verify 필터별 0 fail(`general` 72, `recover` 46, `interrupt` 58, `lost` 49, `resume` 8). P8 일반 여정 5건. `tests/general-acceptance.test.ts`, `tests/project-general.test.ts`, `tests/general-planning.test.ts`, `tests/product-e2e.test.ts`, `tests/claude-recovery.test.ts`, `tests/claude-task-service.test.ts`. 현재 HEAD live 없음, live 실패·재개 없음(A10 미승인). 비코드 live는 `fecf6ff` LIVE-CLI뿐 |
| REUSE-DISCOVERY·VENDOR | mock + 탐색만 live | `e431413`·`d553e37`·`3700c8e`. 탐색 1회 live(LIVE-B, 미채택), vendor는 live 없음 |
| BRIEF-SIZE-GATE | mock | `6841667`, `tests/brief-size-gate.test.ts`. 승인 시점 `EXECUTION_BRIEF_TOO_LARGE`, `/progress` 차단 사유. live 재현 없음 |
| FE-5 / CQG-6B-CTL | mock | `8f92059`. 정규화 실패 사유 `RUNTIME_ERROR`, `WORKER_INPUTS_CHANGED` 오거절 수정. live 없음 |
| FE-5-REDACT | **진행 중(not done)** | 실패 Codex run의 `message.updated` 본문 가림(사용자 결정 2026-10-30). 구현·검증 기록 없음 |

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

## 실제 E2E가 필요한 항목 (실호출 승인 필요, 아래는 2026-10-30 LIVE-B 이후에도 미실행)

- 현재 HEAD(`1716a1a`) 재실행: A01·A09·A12·A13 비코드 흐름, A04·A05. 코드 프로젝트는 LIVE-B(`81c214d`)로 1회 완료
- A07 Codex↔Claude 인계
- A08 다른 모델 Reviewer 호출
- A10 라이브 실행 중 HTTP 재시작
- A16·AX07 코드 1건 + 비코드 1건 UI 경유(LIVE-B는 HTTP 경유라 대체하지 않는다)
- 재사용 vendor 실호출(채택 후보가 있는 계획), 사용자 결과 승인 포함 흐름
- A14 실제 quota 관측
- AX01~AX03 두 Worker 동시 라이브 실행
- A06(deferred)·A15(TOOLS-T8)는 실연결 경로 승인이 먼저 필요하다
- 2026-10-30 결정: CQG-6B-CTL·FE-5 구현 승인(`8f92059` 반영, FE-5-REDACT 진행 중), GENERAL-ACCEPT-B·RECOVERY-UX·F02-REG·Graphify·도구 정책은 현재 보수적 기본값으로 확정(개선은 후속). 남은 열린 항목(REG-ISOLATED-PLANNING, Harness live runner 등)은 [STATUS](ORBIT-STATUS.md)와 [릴리스 게이트 매핑](ORBIT-RELEASE-GATE-2026-10-30.md) 참조
