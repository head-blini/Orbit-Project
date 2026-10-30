# 릴리스 게이트 증거 매핑 (RELEASE-GATE-DOCS, 2026-10-30 KST)

작성: Claude worker `RELEASE-GATE-DOCS`(문서 전용). 기준 개발 HEAD `1716a1a`(batch 23). 코드·테스트는 바꾸지 않았다. 근거는 저장소 문서·커밋·증거 JSON과 오케스트레이터 기록(`.local/orchestrator/STATE.md`, gitignored)이다.

- 마지막 전체 검증(오케스트레이터 기록, `1716a1a`): Node24 `npm run verify` exit 0, **2137 tests / 2135 pass / 0 fail / 0 cancelled / 2 skip**. 로그 `.local/orchestrator/int-batch-23-verify.log`(gitignored). 이 수치는 mock/fake 테스트이며 실제 Provider 성공이 아니다.
- 개발 브랜치 `codex/orbit-mac-handoff-2026-10-26`: `8255815`까지 사용자가 origin에 push했다. `1716a1a`는 로컬 fast-forward만 했고 아직 push하지 않았다. main 병합·배포 없음.
- 비전 §6 규칙: 실제 연결을 검증하지 않은 기능은 완료로 표시하지 않는다. 아래 "상태"는 live-verified / mock-tested / blocked / not done 네 가지만 쓴다. "live-verified"는 증명 HEAD에서 실제 구독 CLI를 호출해 본 것만이다.
- **LIVE-B는 Orbit HTTP API를 구동했다. 브라우저 UI를 구동하지 않았다.** "개발 결과 화면"은 `/api/workspaces/:id/result` 데이터 연결 확인이고 렌더링된 화면 확인이 아니다.

## 1. 수용 기준 B·C·D (이번 게이트)

| 기준 | 상태 | 증거 | 증명 HEAD | 차단 코드 / 필요한 승인 |
|---|---|---|---|---|
| B 코드 프로젝트 E2E | **live-verified (부분, HTTP 경로)** | `docs/ORBIT-LIVE-B-2026-10-30.md`, `docs/evidence/live-b-2026-10-30.json`(실호출), `docs/evidence/live-b-dryrun-2026-10-30.json`(mock 리허설, 증명 아님). 요청→Claude 기획·재사용 탐색→승인→작업→Codex 실행→Orbit 검증 `passed`→결과 데이터·앱 미리보기(HTTP 200)→Codex 리뷰→`/progress` 한곳 확인 | 1회차(기획·탐색·승인) `3700c8e`, 재개(Codex 실행~진행판) `81c214d` 위 브랜치. 병합 `78d2b91`·`8255815` | 실호출 Claude 2 / Codex 2(예산 6 / 3), 재시도 0. 미완: Claude 교차 리뷰 `QUALITY_PRODUCER_MODEL_UNKNOWN`(외부 한계), vendor 실호출 없음(`NO_ADOPT_DECISION_WITH_EXACT_SEMVER`), 사용자 결과 승인 미실행(`QUALITY_APPROVAL_MISSING`), Codex 리뷰 P2 1건 미수정, 브라우저 UI 경유 아님 |
| C 비코드 회귀 + 실패·재개 | **mock-tested** (현재 HEAD live 없음) | 오케스트레이터가 기록한 `1716a1a` verify에서 테스트명 필터별 0 fail: `general` 72 pass, `recover` 46, `interrupt` 58, `lost` 49, `resume` 8. P8 일반 여정 5건(fake Claude 병렬 루트는 unverified 유지, native 모양 리뷰 fixture의 후보 semantic gate 유/무, 업로드 자료 읽기 전용 worker 복사본, 업로드 자료+고정 선행 입력 의존 작업이 Controller 승인 통과). 파일: `tests/general-acceptance.test.ts`, `tests/project-general.test.ts`, `tests/general-planning.test.ts`, `tests/product-e2e.test.ts`, `tests/claude-recovery.test.ts`, `tests/claude-task-service.test.ts` | `1716a1a` (mock) | 비코드 live는 LIVE-CLI 2026-10-29 `execute.general` 1회뿐(`docs/evidence/live-cli-claude-2026-10-29.json`, 구 HEAD `fecf6ff`)이고 FF1 Chrome(구 HEAD `8132244`)이다. 현재 HEAD live 실행 없음, live 실패·재개 없음. A10 라이브 실행 중 HTTP 재시작은 미승인. 필터별 개수는 오케스트레이터 보고이며 이 문서 작성자가 다시 실행하지 않았다 |
| D 릴리스 게이트 증거 매핑 | 이 문서 + `docs/ORBIT-PRODUCT-ACCEPTANCE.md` + `docs/ORBIT-STATUS.md` 갱신 | 아래 §2·§3 | `1716a1a` | 문서 정합만 했다. 문서 작성 자체는 기능 증명이 아니다 |

## 2. 항목별 증거 (A01~A16, AX01~AX07)

증명 HEAD 열은 "그 상태를 만든 증거"의 기준이다. live 증거는 대부분 현재 HEAD(`1716a1a`)보다 이전이고 재실행하지 않았다.

| ID | 상태 | 증거 파일·테스트 | 증명 HEAD | 차단·필요한 승인 |
|---|---|---|---|---|
| A01 | live-verified (구 HEAD, 비코드·UI) | STATUS "FF1" Chrome, Claude 기획→승인→실행→후속→재시작 | `8132244` | 현재 HEAD 재실행(실호출 승인) |
| A02 | mock-tested (+ LIVE-B 코드 경로 기획 저장·승인 live) | `tests/planning-baseline.test.ts`, LIVE-B 단계표 | `1716a1a` verify / `3700c8e` | — |
| A03 | mock-tested | P7 `c0c6ab9` 기준 변경·stale 화면(UI 테스트) | `c0c6ab9`, verify `1716a1a` | 현재 HEAD 브라우저·live 없음 |
| A04 | live-verified (구 HEAD + 코드 프로젝트) | LIVE-CLI Codex `execute.code`(`docs/evidence/live-cli-codex-2026-10-29.json`), LIVE-B Codex 실행·리뷰 | `fecf6ff`, `81c214d` | Codex 실제 모델 `unknown`(외부 한계). 승인된 실호출은 완료됐으나 UI 경유 아님 |
| A05 | live-verified (구 HEAD) | LIVE-CLI Claude `execute.general`, `scripts/verify-claude-runtime.mjs`, LIVE-B Claude 기획·탐색 | `fecf6ff`, `3700c8e` | 현재 HEAD 재실행 승인 |
| A06 | deferred | `docs/ORBIT-DECISION-2026-10-29-GPT-DEFERRED.md` | — | 1차 기준 제외, 전체 제품 기준 포함. 실연결 경로 승인 먼저 |
| A07 | mock-tested | HANDOFF-RECEIPT `726bb48`, `6a121ad`. LIVE-B에서 Claude 기획→Codex 실행 인계는 live였으나 Codex→Claude 인계는 차단 | `1716a1a` verify | Codex↔Claude 인계 live 승인, Codex 기록 경로 전용 테스트 없음 |
| A08 | blocked (mock 구현 + Codex 자기 리뷰 live) | CQG-1~6c(mock). LIVE-B Codex 리뷰 `completed`(25.0초, P2 1건). Claude 교차 리뷰 `QUALITY_PRODUCER_MODEL_UNKNOWN`, calls 0 | `81c214d` | 다른 모델 Reviewer live 승인. Codex 쪽은 모델 미관측(외부 한계) |
| A09 | live-verified (구 HEAD) | 진행판 Chrome 라이브. 코드 프로젝트 `/progress`는 LIVE-B에서 HTTP로 확인 | 구 HEAD, `81c214d`(HTTP) | 현재 HEAD 브라우저 재확인 |
| A10 | mock-tested / blocked | `tests/worker-http.test.ts`, RECOVERY-UX `ce66c15`·`787e093`, `tests/claude-recovery.test.ts` | `1716a1a` verify | A10 라이브 실행 중 HTTP 재시작 미승인 |
| A11 | mock-tested | P7 `c0c6ab9` 영향·stale 화면 | `c0c6ab9` | 현재 HEAD 브라우저·live 없음 |
| A12 | live-verified (구 HEAD) + mock | FF1(`4e52d99`), P7 `c0c6ab9` | `4e52d99`, `c0c6ab9` | 기획 스튜디오 내부 간편 표현 미확인 |
| A13 | mock-tested (+ 구 HEAD 일부 live, LIVE-B 코드 결과·미리보기 HTTP) | P2/P4/P5/P6 `f0cc85e`, LIVE-B 앱 미리보기 HTTP 200·바이트 동일 | `f0cc85e`, `81c214d` | 통합 결과물 버전 runId/taskId null. 브라우저 렌더링 live 없음 |
| A14 | mock-tested | Usage U1~U4 | `25ca69b` | 실제 quota 관측 승인 |
| A15 | mock-tested / blocked | `docs/ORBIT-TOOLS-D1.md`, T1~T7(mock) | `c9b6eb9`, `be88ce8`, `14fa8f7` | TOOLS-T8 실제 도구 호출 승인, Skills/Claude MCP/Plugins 정책 확장 승인 |
| A16 | mock-tested + live 일부 | 비코드 FF1(구 HEAD), 코드 LIVE-B(HTTP), P8 fake 종단(`f55fdf5`), 일반 여정 5건(위 C) | `81c214d`, `1716a1a` | UI 경유 코드+비코드 live 각 1건 없음 |
| AX01 | mock-tested | `tests/worker-scheduler.test.ts` | PW-1~5 `0d09e11`, 안정화 `1267fdb` | LIVE-PAR 두 Worker live 승인 |
| AX02 | mock-tested | `tests/worker-resources.test.ts`, `tests/integration-queue.test.ts` | `1716a1a` verify | live 승인 |
| AX03 | mock-tested | `tests/worker-scheduler.test.ts`, `tests/worker-http.test.ts`. `1267fdb`: dispatch 거절 시 온전한 space를 격리하지 않음 | `1267fdb` | live 승인 |
| AX04 | mock-tested | `tests/task-completion.test.ts`, CQG-4/6a/6c | `5aee43a` 외 | Codex 모델 unknown 차단 유지 |
| AX05 | mock-tested | FE-1~4, HE-3·HE-4 | `27352d8` 외 | production runner·suite `RUNNER_UNAVAILABLE`(HE-SUITE `243e2c2`는 서버 소유 suite mock), live 평가 승인 |
| AX06 | mock-tested | HE-1·HE-2·HE-5a/5b·HE-6·HE-7 | `d42c213` 외 | live 없음 |
| AX07 | mock-tested | TaskGraph HTTP `4c506d2`, P3/P7, P8 fake | `c0c6ab9`, `f55fdf5` | 코드 1건은 LIVE-B로 HTTP live 있음(UI 아님), 비코드는 구 HEAD FF1만 |

## 3. 2026-10-30 작업 기록

| 작업 | 커밋 | 상태 | 한계 |
|---|---|---|---|
| REUSE-DISCOVERY | `e431413` | mock-tested. 기획 제안 검증 뒤 research 모드 Claude(WebSearch/WebFetch만, plan mode, 빈 임시 폴더)로 공개 재사용 후보 탐색. 기본 꺼짐(`ORBIT_REUSE_DISCOVERY=1`), 켜면 미리보기 범위·digest에 추가 호출 표시. LIVE-B 1회차에서 실제 탐색 1회(`searched`, date-fns 4.4.0·dayjs 1.11.23 모두 미채택) | 채택 후보가 나온 경우는 live 미검증 |
| REUSE-VENDOR | `d553e37` | mock-tested. `cdn.jsdelivr.net` 고정 버전만, 파일당 2MB·합계 4MB, `vendor/` 기록, sha256·라이선스 증거, HTTP·UI | **live 미실행**(LIVE-B에서 채택 결정 없음). 부모 디렉터리 symlink 경쟁은 낮은 위험으로 수용(Node `openat` 없음) |
| FE-5 / CQG-6B-CTL | `8f92059`(Codex run `2026-10-29T23-07-09-084Z-93e9a5ed`, 오케스트레이터 커밋) | mock-tested. Codex 실패는 `RUNTIME_ERROR` 정규화 사유 코드만 저장. 배치 입력 hash 게이트가 worker 입력을 별도로 검사해 `WORKER_INPUTS_CHANGED` 오거절 제거. 상세 `docs/ORBIT-FE5-CQG6BCTL.md` | 해당 문서의 sandbox 실행은 `listen EPERM` 1건 실패, 오케스트레이터가 sandbox 밖에서 재검증(223/223, 410/410) |
| 리뷰 수정 REVIEW-B22 | `3700c8e` | mock-tested. 승인 교체 중 vendor stale 쓰기 거절(`REUSE_VENDOR_DECISION_NOT_APPROVED`), 종료 미관측 research는 `lost`/`PLANNING_PROCESS_UNCERTAIN` | 리뷰는 병합 후 수행(프로세스 실수 기록) |
| LIVE-B 수정 | `81c214d` | mock-tested + LIVE-B 재개에서 실제 통과. Codex 지시문에서 미채택 재사용 감사 제외(4,395→3,778자), npm `name@version`을 e-mail로 보지 않음 | e-mail 오탐 수정은 vendor 실호출로 확인하지 못했다 |
| LIVE-B 코드 프로젝트 | `78d2b91`, `8255815` | live-verified(부분, §1 B) | §1 참조 |
| BRIEF-SIZE-GATE | `6841667` | mock-tested(`tests/brief-size-gate.test.ts`). 승인 시점 `EXECUTION_BRIEF_TOO_LARGE`, `/progress` 작업 차단 사유 표시·`execute_task` 제외, 기획 프롬프트에 상한 안내 | live 재현 없음. LIVE-B 발견 1 잔여·발견 2를 닫는 변경이나 실호출로 확인하지 않음 |
| FLAKE-P8-RESTART | `1267fdb` | mock-tested. 원인: native probe 캐시 60초 TTL 만료로 `RUNTIME_VERSION_UNKNOWN` 거절 → 거절 시 온전한 미dispatch space가 `lost_unknown`(`WORKER_RESTART_RECOVERY_REQUIRED`)으로 격리. 이제 격리는 fence·space 신원·claim으로만 결정, 거절은 `not_dispatched` 증거로 해제. P8 fixture는 고정 clock | TTL 만료는 단위 테스트로 유지 |
| FE-5-REDACT | `7d767aa` (batch 24) | **구현·mock 검증.** 사용자 결정 2026-10-30: Codex run이 `failed`로 끝나면 같은 트랜잭션에서 그 run 이벤트의 `data.run.response`(`message.updated`·`interrupt.requested`·`run.accepted`)를 사유 코드로 바꾼다. 스트리밍은 실행 중 그대로, seq·kind·개수 불변, 기존 DB 정리 없음. `tests/controller.test.ts` | `lost`(타임아웃·전송 끊김 포함)와 `interrupted`는 부분 원문이 남는다(별도 결정 필요). live 재현 없음 |

## 4. 문서 불일치 점검 결과

| 항목 | 판정 | 근거 |
|---|---|---|
| STATUS F04 "Codex 0.163.0 미검증" | 이미 정정됨(`c012abe`). 이번에 LIVE-B Codex 실행 추가 | F04 행은 0.165.0 live(`fecf6ff`)를 쓰고 "0.163.0 미검증 기록은 폐기"라 적혀 있다. 헤더 "기준선 … Codex 0.163.0"은 2026-10-28 기준선의 역사 기록이라 유지 |
| STATUS F10 "Registry 없음" | 이미 정정됨(`c012abe`) | F10 행에 Registry R1~R5 병합 커밋(`96eff58`…`fc0afd1`)이 있다. 현재 "없음" 표현은 없다 |
| ACCEPTANCE A15/AX07이 TOOLS T1~T6·P1~P3 이전 | 이미 정정됨(`c012abe`). 이번에 T7-FOLLOWUP-CTL·LIVE-B 반영 | A15에 T1~T7, AX07에 P3·P7·P8이 있다. 이전 갱신 이후 변경분만 추가 |
| `web/project-work.tsx` `projectKind="general"` | **의도된 동작, 결함 아님** | 아래 §5 |

## 5. `projectKind="general"` 하드코딩 점검

- 위치: `web/project-work.tsx:97`(감사 메모의 95·STATUS의 97 중 현재는 97).
- 해당 코드는 `GeneralWork` 컴포넌트 안이다. `ProjectWorkPage`는 `project.kind==='general'`일 때만 `GeneralWork`를 렌더링하고(38행) 아니면 `CodeWork`를 렌더링한다. `CodeWork`는 `ProjectProgressPanel`을 마운트하지 않는다.
- 진행판 전체 페이지(`web/main.tsx:164`)는 `selectedProject?.kind`를 그대로 넘기므로 코드 프로젝트도 올바른 `projectKind`를 받는다. `web/project-progress.tsx:204-205`가 general=Claude 실행 버튼, code=Codex 읽기 전용으로 분기한다.
- 결론: 일반 프로젝트 전용 컴포넌트 안의 상수라 값이 항상 맞다. 결함 증거는 없다. 위험은 `GeneralWork`를 다른 종류에 재사용할 때뿐이다. 이 점검은 코드 읽기이고 이 건에 대한 전용 테스트는 찾지 않았다. 코드는 바꾸지 않았다.

## 6. 남은 차단·승인 요약

- 승인 필요(실호출): 현재 HEAD 재실행(A01·A04·A05·A09·A12·A13·A16·AX07), A07 Codex↔Claude 인계, A08 다른 모델 Reviewer, A10 라이브 중 HTTP 재시작, AX01~AX03 LIVE-PAR, A14 실제 quota, A15 TOOLS-T8, Registry 실제 연결 진단, vendor 실호출.
- 승인된 기본값 확정(2026-10-30 #3): RECOVERY-UX (1)(2)(5), F02-REG (1)~(7), GENERAL-ACCEPT-B 차단 유지, Graphify는 자체 TS-AST 유지, Skills/MCP/Plugins 차단 유지. 개선은 후속 범위이고 기능 완료가 아니다.
- 외부 한계: Codex 실제 모델 관측 불가 → `QUALITY_PRODUCER_MODEL_UNKNOWN`.
- 완료: FE-5-REDACT(`7d767aa`, mock). 미해결 후속: FE-5-REDACT의 `lost` 범위 결정, LIVE-B 발견 4(리뷰 지적을 수정 작업으로 넘기는 흐름 결정), 발견 6(사용자 결과 승인 미실행), REG-ISOLATED-PLANNING, Harness live runner.
