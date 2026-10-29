# CQG-6b — Direct predecessor output handoff

- 기준: `dc988c4` (`codex/cqg-6c`), `ORBIT-PW-D1.md`, `ORBIT-CQG-D1.md`, 2026-10-29 사용자 추가 결정.
- 범위: Scheduler, WorkerSpaces, 읽기 전용 Git ancestry helper 및 관련 테스트. Controller, HTTP, main, task-completion, integration-queue의 기존 gate는 변경하지 않는다.
- 상태: 명시적 Scheduler 제출을 위한 handoff 구현. Controller를 통한 일반 종속 실행은 아래 open item으로 차단되어 있다. 자동 종속 dispatch는 구현하지 않았다.

## Gap

기존 코드 Worker는 실행 계획의 workspace base SHA를 사용하고 이를 batch별로 고정했다. 같은 batch 또는 선행 통합 이전에 생성된 계획의 dependent는 선행 산출물이 없는 worktree를 받았다. 기존 byte 검사는 이를 `WORKER_DEPENDENCY_OUTPUT_CHANGED`로 거부했지만 이미 예약된 attempt/request는 소모되어 자동 재사용할 수 없었다.

일반 Worker는 `project/inputs`만 복사했다. 선행 통합은 `project/output`에 적용되므로 dependent가 검사하는 `space/inputs/output/<file>`로 산출물을 전달할 경로가 없었다.

## Implemented handoff contract

`WorkerHandoff`는 신뢰된 서버의 현재 완료 판정과 적용 기록에서만 생성한다. HTTP 요청의 완료 주장이나 파일 목록을 handoff로 받아들이지 않는다.

```ts
interface WorkerHandoff {
  predecessors: {
    taskId: string;
    integrationId: string;
    commitSha: string | null;
    files: { path: string; sha256: string }[];
  }[];
}
```

- 범위는 현재 graph의 **직접 선행 작업만**이다. 전이 선행 관계를 재귀적으로 수집하지 않는다.
- `taskId`는 직접 선행 작업, `integrationId`는 해당 산출물에 대응하는 단 하나의 applied 기록이다.
- `commitSha`는 적용된 코드 candidate의 immutable SHA이며 일반 작업은 `null`이다.
- `files.path`는 프로젝트 기준 manifest 경로이다. 일반 작업의 `output/report.txt`는 dependent의 `inputs/output/report.txt`로 전달된다.
- 파일 SHA-256과 manifest digest는 현재 선행 완료 증거에 결속되어야 한다. 선행 작업은 `verifiedDone`이어야 하며, 적용 기록은 `status: 'applied'`와 `released: true`를 모두 만족해야 한다. mock/unknown/stale 판정을 통과로 승격하지 않는다.
- graph revision, planning hash, dependency contract digest, 실행 선택과 승인 계획 검사를 그대로 유지한다. 예약 전, 예약 후, 실행 직전에 새 증거와 byte hash를 다시 검사한다.

### Code base and Git evidence

기본 `approvedWorkerBase` 호출은 기존 plan workspace base를 반환한다. Controller의 batch claim 생성 호출은 변경하지 않았다. Scheduler가 handoff를 전달한 경우에만 다음을 도출한다.

1. 직접 선행 candidate 중 다른 모든 직접 선행 candidate를 ancestor로 포함하는 SHA를 선택한다. 순서를 만족하지 못하면 `WORKER_BASELINE_CHANGED`이다.
2. plan workspace base 역시 선택된 candidate의 ancestor여야 한다. 기존 workspace/resource base 일치 검사도 유지한다.
3. 선택된 candidate가 현재 `refs/heads/<target>`의 ancestor여야 한다. 그렇지 않으면 `WORKER_DEPENDENCY_OUTPUT_CHANGED`이다. 기존 보호 branch 검사를 유지한다.
4. base는 적용 기록의 candidate SHA에서만 얻는다. 움직이는 target HEAD를 base로 대입하지 않는다. 재검사 시 base와 handoff의 JSON identity가 달라지면 차단한다.

**Ancestry와 linear history는 별개의 사실이다.**

- Ancestry: `server/worker-scheduler.ts:63`가 선택된 SHA와 검사한 target HEAD의 ancestry를 확인한다. `server/merge-git.ts:230`의 `isAncestor`는 `trustedGit`의 merge-base 결과가 ancestor SHA와 같은지 비교한다. `tests/cqg-6b-ancestry.test.ts`는 별도로 `git merge-base --is-ancestor <candidate> refs/heads/dev`를 적용 직후와 후속 commit 이후에 실행한다. target rewrite의 음성 사례도 별도 테스트한다.
- Linear apply: `server/merge-git.ts:213`의 candidate 생성은 현재 target을 유일한 parent로 지정한다. `server/merge-git.ts:104`는 candidate의 parent header가 정확히 하나이며 예상 base와 같은지 검사한다. `applyMergeCandidate`는 `server/merge-git.ts:158`에서 `merge --ff-only`를 실행한다. `observeMergeApplication`은 `server/merge-git.ts:165`에서 target HEAD가 candidate SHA인지 확인하고 같은 parent 검사를 다시 수행한다.
- 따라서 이 apply 경로가 추가하는 각 integration commit은 single-parent이며 별도 merge commit을 만들지 않는다. 테스트는 실제 parent 목록, fast-forward 후 target SHA, two-parent candidate 거부를 ancestry 테스트와 분리하여 확인한다.
- 저장소의 과거 전체 이력이 선형이라고 주장하지 않는다. 외부 작성자의 commit도 모두 선형이라고 가정하지 않는다. base 도출은 직접 선행 candidate의 실제 ancestry 관계를 매번 검사하므로, 서로 비교 불가능한 선행 기록을 시간순/row 순서로 추정하지 않는다. 현재 apply 경로의 선형 전제는 성립하며, 이를 우회하는 대체 base 출처는 추가하지 않았다.

### Pinning and restart

`worker_space_handoffs(attempt_id PRIMARY KEY, body)`에 `{base, handoff}`를 저장한다. WorkerSpace의 `creating` intent와 같은 Store transaction에서 고정한다. 이후 base/handoff 변경 또는 handoff 생략은 `WORKER_SPACE_HANDOFF_CONFLICT`이다. 파일 작업 실패 후에도 이미 저장된 intent/pin은 남으며 재생성하지 않는다.

선행 작업이 없는 코드 task는 기존 `worker_space_bases` batch pin을 그대로 사용한다. dependent의 derived base는 해당 batch row를 덮어쓰지 않는다.

재시작은 기존 예약의 owner/fence를 이전하고 미확인 실행을 `lost_unknown`으로 둔다. pin은 유지되며 읽기·재시작·동일 요청 재제출로 실행을 replay하지 않는다.

### General transfer and digest validity

`WorkerSpaces.create(token, base?, handoff?)`는 직접 선행 manifest에 명시된 파일만 프로젝트에서 읽는다. path/alias 검증과 기존 fingerprint snapshot helper를 사용한다. 복사 전 SHA-256을 확인하고 `wx`, mode `0444`로 `space/inputs/<path>`에 기록한다. 복사 후 source와 destination을 다시 hash한다.

- source/destination bytes가 기록된 SHA-256과 다르거나 읽을 수 없으면 `WORKER_SPACE_INPUT_CHANGED`이다.
- 기존 `project/inputs`에서 복사된 경로와 충돌하면, 내용이 같아도 `WORKER_SPACE_INPUT_CONFLICT`이다.
- 인계 파일은 `inputManifest`와 전체 `inputDigest`에 포함된다. CQG의 `inputSnapshotDigest`가 해당 bytes에 결속된다.
- `inputs/`는 Worker 산출물 manifest와 integration apply 대상에서 계속 제외된다. 입력 hash에서 인계 파일을 숨기지는 않는다.

후속 integration이 같은 경로를 건드렸다는 사실만으로 무효화하지 않는다. 현재 프로젝트 bytes와 frozen worker input을 handoff의 SHA-256과 비교하고, 계약 및 단일 applied/released 기록을 다시 확인한다. 같은 bytes는 계속 유효하며 다른 bytes는 차단한다. 무관 파일의 변경은 handoff를 무효화하지 않는다. 단, 전체 코드 target의 기존 clean/protected-branch 검사 등 다른 gate는 그대로 적용된다.

누락되거나 모호한 적용 기록, released가 아닌 기록은 `WORKER_DEPENDENCY_OUTPUT_NOT_INTEGRATED`이다. 읽기 실패, 현재 bytes 불일치, manifest digest 또는 고정 handoff 변경은 `WORKER_DEPENDENCY_OUTPUT_CHANGED`이다. 기존 삭제/범위 밖 manifest의 `WORKER_DEPENDENCY_OUTPUT_UNAVAILABLE` 거부도 유지한다. 기존 reservation 해제 regex를 넓히지 않는다.

## Explicit resubmission and approvals

선행 완료나 integration 적용만으로 dependent를 dispatch하지 않는다. 사용자가 명시적으로 제출해야 한다. 동일 request/attempt 재제출은 기존 예약 결과만 돌려준다. 소모된 계획을 복구하여 다시 실행하지 않는다.

새 실행에는 새 requestId, 새 execution plan과 그 계획에 필요한 승인이 필요하다. 기존 계획의 승인 digest를 새 계획에 재사용할 수 없다. 테스트는 bytes를 복구한 뒤에도 소모된 계획이 실행되지 않으며, 새 계획이 자신의 승인 digest로 제출될 때만 실행됨을 확인한다.

## Extension point: automatic dependent dispatch

**Not implemented.** 향후 auto-dispatcher는 별도 승인된 범위에서만 추가할 수 있다. 다음 계약을 모두 충족해야 한다.

1. 아직 유효한 approved plan/batch scope 안에서만 실행한다. task, runtime, graph revision, planning hash, dependency contract, 자원 claim과 기존 승인의 범위를 넓히지 않는다.
2. 각 새 dispatch에는 새로운 requestId를 사용한다. 전달 재시도는 같은 요청의 기존 결과 조회로 처리하며 중복 dispatch하지 않는다.
3. 소모된 execution plan은 재사용하지 않는다. 새 계획에 필요한 승인 요건을 충족해야 하며, auto-dispatch를 승인 면제로 해석하지 않는다.
4. 실제 dispatch 직전에 현재 `verifiedDone`, 단일 applied/released 기록, handoff digests, 현재 bytes, 코드 ancestry와 attempt pin을 다시 검증한다. 누락·불일치·미확인은 차단한다.
5. 기존 durable intent, reservation fencing, quota/자원 제한, restart의 lost_unknown 정책을 유지한다. GET 또는 서버 재시작만으로 실행하지 않는다.

## Open items and ownership

### general dependent dispatch through the controller is blocked by the batch input hash gate; needs a user-approved contract change

**2026-10-30 후속:** FE5-CQG6BCTL 승인 작업에서 이 차단을 수정했다. 아래는 수정 전 기록이다. 새 계약·검증 결과는 [FE5-CQG6BCTL 작업 기록](ORBIT-FE5-CQG6BCTL.md)을 참고한다.

정확한 위치는 `server/controller.ts:801`이다. 저장된 HTTP batch의 `beforeDispatch` wrapper는 프로젝트 입력과 Worker 공간 입력을 모두 원래 batch 입력 hash와 비교한다. 비교 구현은 `server/controller.ts:329`, 전체 inputs inventory는 `server/controller.ts:316`이다.

재현: 입력이 비어 있는 일반 프로젝트에서 batch/plan을 승인한다. 직접 선행 작업의 `output/report.txt`가 applied/released이고 서버 완료 reader가 verifiedDone을 반환한다. Scheduler가 dependent 공간의 `inputs/output/report.txt`를 생성한다. 이 추가 입력 때문에 Controller가 `WORKER_INPUTS_CHANGED`로 거부하고 runtime dispatch는 0회이다. 인계 파일은 inputManifest와 inputDigest에 그대로 남는다.

`tests/worker-scheduler.test.ts`의 `CQG-6b open item: controller batch input hash gate blocks general dependent dispatch`는 실제 Controller guard를 호출해 현재 fail-closed 동작을 고정한다. 완료/적용 증거는 fixture이며 실제 provider 검증을 뜻하지 않는다. Controller guard를 테스트용으로 우회하지 않는다.

이 계약 변경은 CQG-6b에서 구현하지 않는다. Controller/HTTP/main 및 기존 completion/integration gate 파일은 수정하지 않았다. 인계 파일을 hash에서 제외하는 우회도 하지 않았다.

기존 `tests/worker-http.test.ts`의 `terminal completion automatically queues full candidate verification: passed` 실패는 오케스트레이터가 지정한 CQG-6c 회귀이며 다른 branch의 수정 대상이다. 해당 테스트 및 assertion은 수정하지 않는다.

## Verification and assertion changes

Node 24.22.1, 임시 저장소 및 fake runtime만 사용한다. 실제 모델 호출, 네트워크, 설치, 저장소 commit, push, merge, 배포는 하지 않는다. 임시 Git fixture 내부 commit/apply는 ancestry와 integration 동작 검증에만 사용한다.

이번 추가 결정에서는 production 코드를 더 변경하지 않았다. 기존 구현의 digest 판정을 추가 테스트로 검증하고 이 문서를 추가했다.

기존 Scheduler 테스트는 일반 입력을 미리 `project/inputs/output`에 심던 fixture를 제거하고 실제 handoff 복사를 검증하도록 바꿨다. `input-missing` 음성 사례는 복사 이후 frozen 파일을 삭제해 동일한 차단·not_dispatched assertion을 유지한다. 적용 fixture에는 id/released를 명시하고 replay/restart assertions를 추가했다. 기존 assertions를 약화하거나 삭제하여 통과시키지 않았다. 기존 WorkerSpaces assertions와 worker-http assertions는 유지했다.

2026-10-29 추가 결정 반영 후 실제 실행 결과:

```sh
# 모든 Node 명령 앞에 이 Node 24 경로를 적용했다.
export PATH=/Users/DKLEE/.local/share/fnm/node-versions/v24.22.1/installation/bin:$PATH
npx tsc --noEmit
node --test --test-name-pattern='CQG-6b' tests/worker-scheduler.test.ts tests/worker-spaces.test.ts tests/cqg-6b-ancestry.test.ts tests/cqg-6b-code.test.ts
node --test tests/worker-scheduler.test.ts tests/worker-spaces.test.ts tests/integration-queue.test.ts tests/cqg-operational.test.ts tests/worker-http.test.ts tests/task-completion.test.ts tests/cqg-6b-ancestry.test.ts tests/cqg-6b-code.test.ts
git diff --check
```

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| CQG-6b 집중 테스트 | 18 tests, 18 pass, 0 fail, 0 skip; exit 0 |
| 지정 회귀 및 cqg-6b 테스트 | 223 tests, 221 pass, 2 fail, 0 skip; exit 1 |
| `git diff --check` | exit 0 |

실패한 두 테스트는 다음과 같다. 실패를 skip이나 통과로 처리하지 않았다.

1. `HTTP workers enforce session, Origin, CSRF and exact fields; GET never dispatches or appends` (`tests/worker-http.test.ts:62`): sandbox의 `listen EPERM: operation not permitted 127.0.0.1`. listener 검증은 완료하지 못했다.
2. `terminal completion automatically queues full candidate verification: passed` (`tests/worker-http.test.ts:112`, assertion `:122`): 실제 `refused`, 기대 `applied`. 오케스트레이터가 별도 branch에서 수정 중인 CQG-6c 회귀이다. 앞선 실행에서도 CQG-6b의 세 production 모듈을 `dc988c4` 원본으로 로드하여 같은 실패를 재현했다. 이번 변경에서 해당 테스트나 gate를 수정하지 않았다.

별도 open-item 테스트의 통과는 Controller가 안전하게 거부함을 확인한 결과다. 일반 dependent의 Controller 경유 실행 성공을 의미하지 않는다. 실제 provider/live 검증과 전체 suite는 실행하지 않았다.

최종 변경 파일: `server/worker-scheduler.ts`, `server/worker-spaces.ts`, `server/merge-git.ts`, `tests/worker-scheduler.test.ts`, `tests/worker-spaces.test.ts`, `tests/cqg-6b-ancestry.test.ts`, `tests/cqg-6b-code.test.ts`, 이 문서. `docs/ORBIT-STATUS.md`는 수정하지 않았다.
