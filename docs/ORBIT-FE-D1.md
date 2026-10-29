# FE-D1 — Failure Intelligence (X05) 설계 (2026-10-29)

작성: Claude worker (Plan, model opus via model-routing ledger `FE-D1`)가 read-only로 작성했다. 기준 HEAD는 `2c4e3db`다. 검토는 Claude Code 오케스트레이터가 했다.

**잠정 기본값 (사용자 결정 전, 보수적):**
1. 재현 fixture에는 digest만 저장한다. 입력 본문은 저장하지 않는다.
2. "독립 실패 사례"는 runId·requestId가 서로 다르고, 같은 quality loop의 round가 아닌 경우로 정의한다. 반복 기준은 최소 2회다.
3. Codex 이벤트에 원문이 남는 문제는 FE-5에서 신규 기록만 중단한다. 기존 DB 정리는 하지 않는다. 파괴적 작업이므로 별도 승인이 필요하다.
4. case는 사용자가 수동으로 생성할 때만 만든다. 자동 생성하지 않는다.
5. case 보존 기간은 무기한이다. 삭제는 사용자 명시 요청이 있을 때만 한다.
6. 근본 원인 가설은 규칙 기반으로만 만든다. 모델이 작성하는 가설은 X05 범위 밖이다.

## 1. 이미 기록되는 실패 데이터

| 출처 | 필드 | 위치 |
|---|---|---|
| Run | `execution` (`failed`, `lost`, `interrupted`). 사유 필드 없음 | `shared/types.ts:1-10`, `server/store.ts:29` |
| events | `run.failed`, `run.lost`의 `{reason}`: `RUNTIME_NOT_STARTED`, `EXIT_NOT_OBSERVED`, `SERVER_RESTART` | `server/claude-task-service.ts:96,136`, `server/store.ts:33,46,132` |
| Claude 사유 매핑 | `LOGIN_REQUIRED`, `QUOTA_EXHAUSTED`, `RESULT_NOT_OBSERVED`, `RUNTIME_ERROR` | `server/runtimes/claude-task.ts:40-53` |
| runtime 출처 | `native`, `mock`, `unknown` | `server/provider-evidence.ts:7-19` |
| verification_checks | `commandId`, `verdict`, `exitCode`, digest, `output` (safeText 적용) | `shared/verification.ts:5-14`, `server/verification.ts:70` |
| quality_loops | step `failed`·`issue`, `QualityFailure` | `shared/quality-loop-record.ts:23-33`, `server/quality-loop.ts:69` |
| integration_queue | `refused`/`blocked`와 reason | `server/integration-queue.ts:26-33` 외 |
| worker | `lost_unknown`, `worker_integration_refusals` | `shared/parallel-workers.ts:34`, `server/controller.ts:170` |
| capability execution | `issue` 코드 | `server/capability-execution.ts` |
| 완료 판정 | `TaskCompletion.reasonCodes` | `shared/task-completion.ts:32` |

**없는 것:**
- 공통 실패 분류
- Codex `run.failed`/`run.lost`의 reason. 출처는 `server/controller.ts:837`이다.
- 검사 실패 유형을 구분하는 정보
- 상관 키, fingerprint, 반복 횟수, 재현 사례, 가설 연결

**노출 금지:**
- Run의 `prompt`와 `response` 원문
- `CheckRecord.output`
- `QualityFailure.evidence`, review·artifact 본문, 파일 경로 원문
- 인증정보

`safeText`는 보조 방어일 뿐이다(`server/privacy.ts:6`). 따라서 redaction 후 노출하는 방식을 쓰지 않는다. 허용한 필드만 복사한다.

**보안 메모:** Codex Run 이벤트 data에 prompt·response 원문이 포함된 Run 전체가 저장된다(`server/store.ts:14-17`). Failure index는 이 이벤트에서 `reason` 필드만 읽어야 한다.

## 2. 최소 설계

- **(a) 읽기 전용 Failure Index** (`server/failure-index.ts`)
  - `SELECT`만 사용한다. 실행, 재시도, append, migration은 없다.
  - 출력 필드: `{id, source, recordId, projectId, taskId?, runId?, code, category, evidenceSource, at, bindingDigest}`
  - `^[A-Z_]+$`에 맞지 않는 코드는 `UNCLASSIFIED`로 바꾼다.
- **(b) 분류** (`shared/failure-intelligence.ts`, 순수 함수)
  - category는 정적 표로 정한다: `tool_environment`, `policy_refusal`, `quota_capacity`, `auth`, `output_rejected`, `unknown`
  - `model_mistake`는 사실 분류로 쓰지 않는다. 가설에서만 쓴다.
  - 실패 하나에는 category 하나만 붙인다.
  - `familyId = sha256(category, code, source, commandId|gate, runtime)`
  - mock 실패는 별도로 집계한다.
- **(c) 재현 사례** (`server/failure-cases.ts`, `failure_cases` 테이블)
  - 허용 필드 manifest만 저장한다. 내용은 digest로만 담는다.
  - 모든 문자열에 `containsCredential`을 적용하고, 걸리면 저장을 거부한다.
  - provenance는 `{sourceTable, recordId, recordBodySha256, indexerVersion, createdAt}`다.
- **(d) 가설**
  - 결정적 규칙으로 만든다.
  - 형식: `{kind:'hypothesis', statement, confidence:'rule', evidence:[ids], counterEvidence}`
  - UI에는 "가설"이라는 라벨을 붙인다.
- **(e) HE 연결**
  - FE는 read port(`listFamilies`, `listCases`, `getCase`)만 제공한다.
  - FE는 검증 설정·권한·Scheduler·목표의 쓰기 API를 import하지 않는다. 정적 import 검사로 확인한다.
  - GET 실행 전후로 `db.total_changes`가 변하지 않아야 한다.
  - 승격 권한은 FE에도 HE에도 없다.

## 3. 작업 단위

| 단위 | 파일 | 순서 |
|---|---|---|
| FE-1 계약·분류 | `shared/failure-intelligence.ts`, `tests/failure-intelligence.test.ts` | 1 |
| FE-2 Index | `server/failure-index.ts`, `tests/failure-index.test.ts` | 2 (FE-3과 병렬) |
| FE-3 Case 저장 | `server/failure-cases.ts`, `tests/failure-cases.test.ts` | 2 |
| FE-4 HTTP·UI | `server/http.ts`, `server/controller.ts`, `web/failure-index.tsx` | CQG 병합 후 |
| FE-5 Codex 실패 reason·원문 기록 중단 | `server/controller.ts` 외 | CQG 병합 후 |
