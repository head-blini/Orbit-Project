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

| ID | 수준 | 증거 / 공백 |
|---|---|---|
| A01 | integ (구 HEAD `8132244`) | STATUS FF1 Chrome. 실제 Claude로 기획→승인→실행→후속→재시작 |
| A02 | mock | `tests/planning-baseline.test.ts` |
| A03 | mock + 브라우저 일부 | 진행 중 기준 변경 화면은 미완 |
| A04 | native | `docs/ORBIT-LIVE-CLI-2026-10-29.md`, `docs/evidence/live-cli-codex-2026-10-29.json`. 실제 모델 unknown. UI 경유 E2E 없음 |
| A05 | native (+구 integ) | LIVE-CLI Claude `execute.general`, `scripts/verify-claude-runtime.mjs` |
| A06 | blocked | `docs/ORBIT-GPT-D1.md` |
| A07 | mock | Codex↔Claude 인계 실행 없음 |
| A08 | mock / blocked | Reviewer 호출 0회. Codex 쪽은 `QUALITY_PRODUCER_MODEL_UNKNOWN` |
| A09 | integ (구 HEAD) | 진행판 Chrome 라이브 |
| A10 | native 일부 | FF1 재시작. HTTP 전체 재시작 라이브 증명 없음. fake: `tests/worker-http.test.ts` |
| A11 | mock | 영향·재검증 화면 미완 |
| A12 | integ (구 HEAD `4e52d99`) | 진행판·기획 내부 간편 표현 미완 |
| A13 | integ 일부 | 일반 결과물 버전·다운로드 없음 (`server/deliverables.ts:61-108`) |
| A14 | mock | 실제 quota 조회 0회 |
| A15 | blocked | `docs/ORBIT-TOOLS-D1.md` |
| A16 | 부분 | 비코드는 FF1 integ, 코드는 UI 경유 E2E 없음 |
| AX01 | mock | `tests/worker-scheduler.test.ts` barrier |
| AX02 | mock | `tests/worker-resources.test.ts`, `tests/integration-queue.test.ts` |
| AX03 | mock | `tests/worker-scheduler.test.ts`, `tests/worker-http.test.ts` |
| AX04 | impl (계약) + mock | `tests/task-completion.test.ts`. 서버 연결은 CQG-4 |
| AX05 | unverified | FE/HE 미구현 |
| AX06 | unverified | FE/HE 미구현 |
| AX07 | unverified | TaskGraph·worker·queue UI 없음 (HTTP만 있음) |

## 남은 작업 (PRODUCT)

| 단위 | 시점 | 파일 |
|---|---|---|
| P1 일반 프로젝트 Goal 실행 포함 (버그 의심: `server/goal-service.ts:119`가 `workspaceId` 없는 run 제외) | 지금 | `server/goal-service.ts`, `tests/goals.test.ts` |
| P2 결과물 바이트 읽기 (순수) | 지금 | `server/deliverables.ts`, `tests/deliverables.test.ts` |
| P3 작업 그래프·queue 읽기 패널 (실행 버튼 없음) | 지금 (마운트는 CQG-5 이후) | `web/task-graph-panel.tsx`, `tests/task-graph-ui.test.ts` |
| P4 다운로드 경로·버튼 | CQG-4 이후 | `server/http.ts`, `server/controller.ts`, `web/deliverables.tsx` |
| P5 결과물 버전 기록 | CQG-4 이후 | `server/deliverable-versions.ts` 등 |
| P6 Goal에 결과물·완료 증거 참조 | CQG-4 이후 | `shared/goals.ts`, `server/goal-service.ts`, `web/goals.tsx` |
| P7 진행판 간편 표현·X07 표시 | CQG-5 이후 | `web/project-progress.tsx`, `web/project-work-model.ts` |
| P8 fake 종단 테스트 (AX07·A16) | CQG-4/5 이후 | `tests/product-e2e.test.ts` |

Graphify: 제품 안에는 자체 TS-AST 소스 그래프가 있다(`server/source-graph-service.ts`). 이것을 "Graphify 또는 검증된 대안"으로 인정할지는 사용자 결정이다. Graphify CLI 연동은 설치와 subprocess 실행이 필요하므로 별도 승인 사항이다.

## 실제 E2E가 필요한 항목 (실호출 승인 필요)

- 현재 HEAD 재실행: A01·A09·A12·A13 비코드 흐름, A04·A05
- A07 Codex↔Claude 인계
- A08 다른 모델 Reviewer 호출
- A10 라이브 실행 중 HTTP 재시작
- A16·AX07 코드 1건 + 비코드 1건 UI 경유
- A14 실제 quota 관측
- AX01~AX03 두 Worker 동시 라이브 실행
- A06·A15는 실연결 경로 승인이 먼저 필요하다
