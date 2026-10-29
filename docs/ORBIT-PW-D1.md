# PW-D1 — Parallel Workers 설계 (2026-10-29)

작성: Codex read-only run `PW-D1` (session `01a1853c-e4c6-7732-8479-f484940a1fc6`). 검토: Claude Code 오케스트레이터.

**잠정 기본값 (보수적, 사용자 확인 전):** 전체 Worker 상한 2, native Codex 1(다중 채널은 별도 검증 후), 격리된 Claude 2. 종속 노드는 CQG 완료 증거 전까지 해제하지 않음(실행 완료만으로 해제 금지). quota unknown에서 자동 병렬 확대·소진 후 자동 재개 금지. **통합 큐의 적용은 후보별 사용자 승인 필요(자동 적용 없음), 대상은 개발 브랜치 `codex/orbit-mac-handoff-2026-10-26`, main 제외** — 자동 적용 권한은 사용자 결정 전까지 부여하지 않는다.

**1. 현재 중첩 실행을 막는 조건과 빈틈**

| 경로 | 현재 동작·근거 |
|---|---|
| Codex 실행 | `start()`가 `assertExecutionAvailable()`, `extensionIdle()`, Model Hub·세션 busy, `active()`를 검사합니다. [controller.ts:525](../server/controller.ts) |
| Codex 전역 직렬화 | `active()`는 workspace 구분 없이 모든 비-Claude 비종료 Run을 찾습니다. 다른 worktree여도 두 번째 Codex 실행은 `RUN_ACTIVE`입니다. [controller.ts:291](../server/controller.ts) |
| 복구·품질 게이트 | `soloRecoveryRequired()`는 미해결 native 연결과 비-Claude `lost`를 차단합니다. `qualityBusy()`는 품질 실행·복구를 보호합니다. [controller.ts:84](../server/controller.ts) |
| 다른 작업과 상호 배제 | verification/merge/workflow/review/planning에 전역 busy callback을 전달합니다. workspace 생성·선택도 `idle()`을 통과해야 합니다. [controller.ts:111](../server/controller.ts), [163](../server/controller.ts) |
| Claude solo | 같은 task 또는 같은 general project의 비종료 Claude Run을 거부합니다. 다른 프로젝트 전체를 직렬화하지는 않습니다. [claude-task-service.ts:53](../server/claude-task-service.ts) |
| 공통 게이트의 비대칭 | general task 분기는 `qualityAvailable()` 이후 Claude로 직접 갑니다. Codex `active()`·`soloRecoveryRequired()`를 공통 검사하지 않습니다. **모든 task run이 전역 직렬화된다는 설명은 틀립니다.** [controller.ts:494](../server/controller.ts) |
| Claude lost 빈틈 | `lost`는 terminal이며, Claude 복구 차단은 같은 task만 검사합니다. 다른 task는 같은 폴더에서 시작할 수 있습니다. 기존 테스트도 이를 명시합니다. [claude-task-service.test.ts:227](../tests/claude-task-service.test.ts) |
| quota | 관측·진행 표시와 dispatch 차단은 별개입니다. 위 실행 진입점에는 quota admission 검사가 없습니다. Claude 소진은 현재 `failed/QUOTA_EXHAUSTED`로 기록됩니다. [claude-task.ts:40](../server/runtimes/claude-task.ts) |

Claude lost 빈틈의 영향: 종료 미확인 프로세스가 계속 쓰면 후속 task와 충돌할 수 있습니다. 코드·기존 테스트로 확인했으며 이번에 실행 재현하지 않았습니다.

**2. 반드시 보존할 불변식**

- task/attempt의 실행 소유자는 하나입니다. request ID 재전송은 기존 결과를 반환하고, 다른 입력이면 충돌입니다.
- dispatch 전에 의도·승인 baseline·자원 소유권을 저장합니다. 저장 실패 시 실행하지 않습니다.
- `interrupt_requested`, transport 종료, process 종료 확인을 구분합니다. `lost/unknown`은 자원을 계속 점유합니다.
- timeout·heartbeat 만료·재시작만으로 잠금을 해제하거나 실행을 재전송하지 않습니다.
- 기존 Codex 단일 실행 채널에는 active turn이 하나뿐입니다. 채널 확장 전까지 native Codex 동시 실행 상한은 1입니다.
- Claude는 task별 단일 소유자를 유지합니다. 같은 폴더의 solo 제한은 **독립 실행 폴더와 충돌 검사 확보 후에만** 좁힙니다.
- quota unknown은 무제한이 아닙니다. 확인된 공유 pool은 중복 계산하지 않으며, 소진 후 자동 유료 전환·무단 재개를 금지합니다.
- 실행 종료·검증 통과·통합 성공·사용자 승인은 별도 사실입니다. 같은 모델 Worker 둘은 독립 교차 모델 리뷰가 아닙니다.

**3. 최소 구조와 실행 순서**

**선택안:** 단일 Scheduler가 기존 `CapabilityExecutionService`와 runtime adapter를 호출합니다. 별도 에이전트 실행 루프는 만들지 않습니다.
Controller 인스턴스 복제는 선택 workspace·서비스 생성자 복구·전역 상태가 겹칩니다. 전역 gate 삭제도 소유권을 증명하지 못합니다.

1. **승인된 실행 묶음:** graph revision, planning hash, task, 계약 digest, 입력 artifact hash, runtime 선택, 병렬 상한을 고정합니다.
2. **Admission:** DAG 선행 증거·현재 baseline·권한·quota·runtime 슬롯·자원 충돌을 검사합니다.
3. **원자적 예약:** `Store.transaction`에서 attempt와 모든 자원 claim을 함께 확보합니다. 경쟁 요청 중 하나만 성공합니다.
4. **기존 dispatch 재사용:** 기존 `dispatchRequestId`와 Run receipt에 예약 ID를 결속합니다. 새 request journal을 중복 구현하지 않습니다.
5. **출발 직전 재검사:** 예약 소유 세대·baseline·정책을 확인합니다. 예약 이후 변경되면 실행을 거부합니다.
6. **관측:** run별 workspace, session/turn, process identity, output, deadline, telemetry를 분리합니다. UI 선택 workspace는 실행 소유권이 아닙니다.
7. **종료·검증:** 종료 확인 후 산출물을 고정하고 검증합니다. 통합 대기 중 산출물과 충돌 소유권을 보존합니다.

기존 의도 선기록·재시작 reconcile은 [capability-execution.ts:107](../server/capability-execution.ts), [39](../server/capability-execution.ts)을 확장합니다.

**Task Graph 연결:** 현재 HTTP는 의도적으로 `verifiedDoneIds:[]`를 전달합니다. 선행 실행 종료만으로 종속 노드를 해제할 수 없습니다. [http.ts:466](../server/http.ts)
PW에는 revision·baseline·계약·artifact에 결속된 서버 증거 adapter가 필요합니다. CQG 완료 계약 확정 전에는 종속 실행을 차단합니다.

**4. 자원 소유권과 통합**

| 자원 | 최소 계약 |
|---|---|
| 코드 파일 | Run마다 `Projects` worktree를 사용합니다. 충돌 key는 worktree 경로가 아닌 **repository identity + 논리적 파일 경로**입니다. |
| 비코드 파일 | 서버 소유 프로젝트 아래 Run별 격리 폴더·입력 snapshot·산출물 manifest를 둡니다. Git을 강제하지 않습니다. |
| 파일 충돌 | write/write 및 변경 가능한 입력의 read/write 충돌을 거부합니다. glob 중첩을 증명하지 못하면 보수적으로 차단합니다. |
| 선언 검증 | TG `impactScope`는 선언일 뿐 권한이 아닙니다. 경로 정규화·링크/alias 검사·실제 변경 manifest 검사를 추가합니다. 범위 밖 변경은 통합 거부입니다. |
| DB | Worker용 DB는 Run별 disposable 경로로 분리합니다. 공유 DB는 DB/WAL/SHM 전체를 같은 배타 자원으로 취급합니다. Orbit DB는 서버만 씁니다. |
| 포트 | host/protocol/address/port로 예약합니다. 기본 loopback이며, 외부 프로세스의 선점은 bind 실패로 처리합니다. |
| 외부 자원 | 계정·endpoint·문서/객체 ID 등 실제 대상 key로 예약합니다. 식별·권한·격리를 확인할 수 없으면 병렬 dispatch를 거부합니다. |
| Git 메타데이터 | worktree 생성·삭제, refs/index 변경, 통합은 단일 소유자가 직렬 처리합니다. Worker에 임의 Git 메타데이터 변경 권한을 추가하지 않습니다. |

Worktree와 로컬 claim은 OS/네트워크 보안 sandbox가 아닙니다. 기존 runtime 권한 제한을 유지합니다.
`RepositoryAuthority`의 identity·fencing·journal을 재사용하되, 현재는 미해결 operation 하나만 허용하고 dispatch 후 release가 없습니다. 완성된 병렬 잠금으로 취급하면 안 됩니다. [repository-authority.ts:163](../server/repository-authority.ts)

**통합 큐는 서버 전체에서 하나만 활성화합니다.**

- 항목에 source/base hash, 승인 baseline, 변경 manifest, 검증 설정 digest, target HEAD를 저장합니다.
- 최신 통합 HEAD에서 별도 후보를 구성합니다. 원 Worker worktree를 재작성하지 않습니다.
- 기존 merge는 `target HEAD === workspace.baseSha`만 허용합니다. 첫 병합 후 다른 Worker의 옛 전체 snapshot을 그대로 적용하면 안 됩니다. [merge-git.ts:122](../server/merge-git.ts)
- 원 base 대비 변경분만 최신 HEAD에 적용합니다. 충돌·범위 밖 변경은 거부하고 후보를 다시 검토합니다.
- 후보 전체에 승인된 lint/type/build/unit/contract/E2E 및 비코드 검사를 다시 실행합니다. 누락된 필수 검사는 blocked입니다.
- `VerificationService`의 source/config/acceptance digest 결속을 확장합니다. 기존 Worker의 통과 결과로 후보 검증을 대체하지 않습니다.
- 적용 직전 HEAD·후보 hash를 재확인합니다. 바뀌면 후보와 검증을 폐기하고 다시 구성합니다.
- 기존 MergeService의 승인·멱등성·불명확 적용 복구를 유지합니다. main 병합·Push·배포 권한은 추가하지 않습니다.

**5. 재시작·quota와 물리적 한계**

- 재시작 시 dispatching/running/interrupting을 기존 receipt·native journal과 대조합니다. 미확인은 quarantine, 자동 재전송은 0회입니다.
- claim은 종료 증거나 확실한 미출발 증거로만 해제합니다. 옛 owner의 늦은 이벤트는 새 attempt에 반영하지 않습니다.
- 자원 범위를 모르는 legacy lost는 기존 전역 차단을 유지합니다. 명확히 분리된 신규 자원만 독립 진행할 수 있습니다.
- quota 소진은 pool별 대기로 저장합니다. reset 시각 경과만으로 가용량을 복원하지 않습니다. 재개는 수동 또는 사전 승인 정책으로 제한합니다.

| 구분 | 판단 |
|---|---|
| 현재 구현의 구조적 한계 | Controller는 RPC·workspace·output·deadline·telemetry가 singleton입니다. [controller.ts:56](../server/controller.ts) |
| RPC 프로토콜 한계 | `Rpc.pending`은 여러 요청을 추적합니다. “RPC 요청은 물리적으로 하나뿐”이라는 주장은 근거가 없습니다. 다중 turn 지원은 미확인입니다. [rpc.ts:16](../server/rpc.ts) |
| 정책 한계 | 전역 busy, Claude 프로젝트 solo, Worker 상한, 검증 직렬화는 Orbit 정책입니다. 안전 증명 없이 완화하지 않습니다. |
| 자원 한계 | 동일 포트 bind, SQLite writer 경합, 공유 Git 상태, 실제 provider quota는 현실 제약입니다. 용량 수치는 이번에 측정하지 않았습니다. |

권장 초기 상한은 전체 2, Codex native 1, 격리된 Claude 2입니다. 코드 노드 둘의 중첩에는 별도 Codex 실행 채널 검증이 필요합니다.
그 확장은 기존 Codex 실행 상태만 채널별로 분리하고, **채널당 active turn 1**을 유지합니다. fake 검증만으로 native 지원을 선언하지 않습니다.

**6. 독립 작업 단위·파일 소유권·통합 순서**

아래 신규 경로는 제안입니다. 공통 타입·DB·Scheduler는 한 담당만 수정합니다.

| 단위 | 독점 파일 소유권 | 필수 fake 검증 |
|---|---|---|
| PW-1 계약·예약 | 신규 `shared/parallel-workers.ts`, `server/parallel-workers.ts`, `server/worker-resources.ts`; 기존 `store.ts`, `repository-authority.ts` | 원자 예약 경쟁, 충돌·세대 fencing, intent 저장 실패 |
| PW-2 실행 연결 | `controller.ts`, `capability-execution.ts`, `capability-runtime-adapters.ts`, `claude-task-service.ts`, 필요한 `runtimes/*` | AX01 barrier로 A/B 동시 실행 관측, C 의존 대기, 상한·이벤트 격리 |
| PW-3 격리 공간 | `projects.ts`, `project-creation.ts`, `workspace-fingerprint.ts` | AX02 파일 alias/glob·DB/WAL/SHM·포트·외부 key 충돌, 비코드 격리 |
| PW-4 통합·검증 | 신규 `server/integration-queue.ts`; 기존 `merge-service.ts`, `merge-git.ts`, `verification-service.ts` | AX02 큐 active≤1, HEAD 변경, 전체 회귀 실패 시 적용 거부 |
| PW-5 HTTP·통합 증거 | 통합 담당의 `http.ts`, `main.ts`; 승인된 진행판 연결·STATUS·graphify | AX03 crash 지점별 재시작, 중단 응답 유실, quota 소진, 동일 요청 dispatch≤1, GET dispatch=0 |

각 단위는 대응 테스트 파일도 독점 소유합니다. PW-1 계약 고정 후 PW-2/3/4를 별도 worktree에서 진행합니다.
통합 순서는 **PW-1, PW-3, PW-2, PW-4, PW-5**입니다. 마지막에 Node24 전체 `npm run verify`와 fake HTTP 회귀를 수행합니다.

