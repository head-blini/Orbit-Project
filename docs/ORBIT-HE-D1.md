# HE-D1 — Harness Evolution (X06) 설계 (2026-10-29)

작성: Claude worker (Plan, model opus via model-routing ledger `HE-D1`), read-only, 기준 HEAD `3f1d16c`.
검토: Claude Code 오케스트레이터.
HE는 FE-1~3(read-only failure port)에 의존한다.

**잠정 기본값 (보수적, 사용자 결정 전):**
1. 자동 승격은 어떤 class에도 허용하지 않는다. `execution_guidance`도 사용자 승인으로만 승격한다.
2. 컨텍스트 순서 변경은 v1 범위에서 제외한다.
3. 후보 초안을 만들 때 모델을 호출하지 않는다. 결정적 규칙표와 사용자 제안만 사용한다.
4. 보호 평가 A/B 실행에는 평가마다 실호출 승인이 필요하다(경계 7). 실행 runtime은 Claude로 한정한다. Codex는 관측 모델이 unknown이라 CQG 통과 판정이 불가능하다. 승인이 없으면 fake 평가까지만 진행한다.
5. 효과가 악화되어도 자동으로 롤백하지 않는다. 롤백은 제안만 한다.
6. 정상 case는 사용자가 수동으로 등록한다(통과 Run의 digest manifest).
7. `checks` 제안은 HE 화면에 기록만 한다. 기존 검증 설정 경로로 넘기는 것은 범위 밖이다.

## 1. 진화 가능 산출물과 보호 산출물

### 진화 가능 (v1 class `execution_guidance`, 덧붙이기 전용)

| target | 위치 |
|---|---|
| `claude_task` | `claudeTaskPrompt`의 서술 지침 (`server/runtimes/claude-task.ts:31-34`) |
| `codex_brief` | Codex 실행 brief 머리말 (`server/planning/execution.ts:39`) |
| `repair` | repair 지침 (`server/claude-task-service.ts:77`, `server/controller.ts:662`) |

### 보호 대상 (자동 변경 금지)

| 영역 | 위치 |
|---|---|
| 목표·승인 기준·수용 조건 | `server/goal-service.ts`, `server/acceptance.ts`, `server/planning/execution.ts:21-38`, `shared/task-completion.ts` `CompletionPolicy` |
| 프롬프트의 보호 문장·기준 블록 | `claude-task.ts:24-30, 35-37` |
| 검증 정책 | `server/task-completion.ts`, `server/verification-configuration.ts`, `server/quality-loop.ts` |
| 리뷰어 프롬프트 | `server/runtimes/claude-review.ts:22-38`, `server/quality-loop-native.ts:177-181` |
| 권한 | `server/tool-permissions.ts` |
| 격리·Scheduler | `server/worker-scheduler.ts`, `server/worker-spaces.ts` |
| 인증·외부 전송 | `server/providers/policy.ts`, `server/privacy.ts`, `server/providers/outbound.ts` |
| 입력 gate | `controller.ts:751-753`, `claude-task-service.ts:72-74` |

## 2. 최소 설계

### (a) 버전 산출물
- 형식: `{versionId, class, target, lines[], parentId, digest}`
- 문장 수·길이에 상한을 둔다. Codex 입력 상한 4000자 안에 들어가야 한다.
- v0은 빈 overlay다. 현재 동작과 같고, 최종 롤백 지점이다.
- overlay는 "추가 실행 지침(Orbit 하네스 vN)" 섹션으로 보호 문장 앞에 덧붙인다. 기존 줄은 교체·삭제하지 않는다.

### (b) 후보 생성
- 입력: FE read port, 결정적 규칙표(`category+code → 지침 템플릿`), 사용자 제안
- 각 후보에 근거 familyId·caseIds와 FE `indexerVersion`을 결속한다.

### (c) AX06 거부 (`classifyHarnessCandidate`, 순수 함수)

| 조건 | 결과 코드 |
|---|---|
| 허용표에 없는 class·target | `HARNESS_CLASS_PROTECTED` |
| 자격증명·외부 전송이 포함됨 | `HARNESS_UNSAFE_TEXT` |
| 금지 의도 패턴(한/영): 기준·목표 변경, 검사 skip, `--no-verify`, 권한·sandbox·인증·네트워크·유료 API | `HARNESS_POLICY_OVERRIDE` |
| 상한 초과 | `HARNESS_TOO_LARGE` |

- 차단된 후보는 평가하지 않는다.
- 주 방어선은 구조 제한(허용표 + 덧붙이기 전용)이다. 패턴 검사는 보조다.

### (d) 보호 평가
- suite는 서버가 소유하고, 시작 시 digest를 고정한다. 구성은 failingCases, normalCases, protectedSuite다.
- A(현재 버전)와 B(후보)를 PW 격리 공간에서 기존 runtime으로 실행한다.
- 판정은 기존 `evaluateTaskCompletion`과 검증 경로만 사용한다.
- 통과 조건: 실패 case 통과 수가 늘고, 정상·보호 suite 회귀가 0이어야 한다.
- mock·unknown·stale 결과는 `unverified`로 처리하고 승격하지 않는다.
- 새 lint·test 추가만으로는 개선으로 세지 않는다.

### (e) 승격·롤백·효과
- 승격은 사용자 승인 기록 `{requestId, candidateDigest, evaluationDigest}`가 현재 값과 일치할 때만 한다.
- 버전 pointer는 프로젝트 단위다. pointer 이력은 append-only이고, 롤백은 pointer를 이동하는 방식이다.
- 효과 추적: `harness.applied` 이벤트를 남기고, 버전별 FE family 재발과 gate 실패율을 read-only로 비교한다. 악화가 보이면 롤백을 제안한다.

## 3. 작업 단위

| 단위 | 파일 | 순서 |
|---|---|---|
| HE-1 계약·AX06 거부 | `shared/harness.ts`, `tests/harness-policy.test.ts` | 1 |
| HE-2 버전 저장 | `server/harness-store.ts`, `tests/harness-store.test.ts` | 2 |
| HE-3 후보 생성 | `server/harness-candidates.ts` | 2 (FE-2/3 이후) |
| HE-4 보호 평가 | `server/harness-evaluation.ts` | 3 |
| HE-5a Claude 주입 (v0 byte 동일) | `server/runtimes/claude-task.ts`, `server/claude-task-service.ts` | 3 |
| HE-5b Codex 주입 | `server/planning/execution.ts`, `server/studio.ts`, `server/controller.ts` | CQG 병합 후 |
| HE-6 효과 read model | `server/harness-effects.ts` | 4 |
| HE-7 HTTP·UI | `server/http.ts`, `server/controller.ts`, `server/main.ts`, `web/harness.tsx` | CQG 병합 후 |
