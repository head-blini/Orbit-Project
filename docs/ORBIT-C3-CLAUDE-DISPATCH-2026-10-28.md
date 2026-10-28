# C3 — 일반 프로젝트 Claude Task 실행

## 구현 계획과 경계

- 기준: 사용자가 제공한 C3 명세, VISION, SCOPE §5/F04/F07/F09 및 A05/A08/A10. 현재 HEAD `97a31bd498b95cf997c51728070fb72e6fb34bd2`, 브랜치 `codex/core-claude-dispatch`.
- 현재 worktree만 수정한다. commit/push, 런타임 플래그 변경, Claude 소유 UI/진행판/runtime/browser 수정은 하지 않는다.
- 기존 Controller/Store 흐름을 전면 일반화하지 않고, 일반 프로젝트용 `ClaudeTaskService`를 추가한다. Studio.execution 및 C2 HandoffService의 승인 기준 데이터를 재사용한다.
- Run JSON에 선택적 runtime/projectId만 추가한다. 기존 Run body/event 형식은 유지하고 Claude 이벤트만 명시적으로 투영한다. 종료 reason은 terminal 이벤트에 보존한다.
- cwd는 `ManagedProjectCreation.owns()`로 생성 영수증과 실제 디렉터리 신원이 일치하는 프로젝트만 허용한다. 사용자 경로 입력이나 일반 write allowlist로 대체하지 않는다.
- 동일 task의 active/lost 실행은 각각 RUN_ACTIVE/SOLO_RECOVERY_REQUIRED로 차단한다. requestId 재조회는 새 실행 없이 원본을 반환한다. 자동 재개/제공자 전환은 없다.
- Controller의 Codex 이벤트 처리기가 Claude Run을 소유하지 않도록 runtime으로 분리한다. 중단 요청과 프로세스 종료를 구분한다.
- 기존 일반 프로젝트 + workspaceId 호출의 GIT_REQUIRED 거부를 유지한다. HTTP 일반 실행 body는 requestId만 허용한다.

## 순서 및 검증

- [x] fake runner factory를 주입한 서비스/Controller 테스트: 영속화 선행, 기준 결속, 멱등성/단일 소유자, stale/unapproved, 경로 교체, 개인정보 투영, 중단, unknown/lost, quota, 재시작, Codex 경로 분리.
- [x] `shared/types.ts`, `server/store.ts`, `server/projects.ts`, 신규 `server/claude-task-service.ts`, `server/controller.ts` 최소 구현.
- [x] 기존 HTTP 형식으로 일반 프로젝트 실행/중단/세션/CSRF/필드 검증 및 코드 프로젝트의 workspace 필수 조건 테스트 추가. `server/http.ts` 분기 추가.
- [x] typecheck 및 집중 테스트 실행. listen EPERM은 assertion 통과로 간주하지 않는다. 기존 테스트 삭제/약화 없이 결과를 기록한다.
- [x] 최종 diff/소유권 검토, 실제 명령·종료 코드·잔여 한계 기록. 진행판의 projectId 필터는 Claude에 인계한다.

## 검토 초점

요청 재사용이 다른 task로 넘어가지 않는지, Store 이벤트에 prompt/response/도구 입력이 유출되지 않는지, 시작 직후 중단 및 늦은 이벤트가 상태를 되돌리지 않는지, 종료 관측 없는 실행이 재실행을 허용하지 않는지, 디렉터리 교체 및 저장 실패가 spawn을 막는지 검사한다.

## 관찰 환경

Darwin, Node v26.12.1, npm 11.20.0, Git 2.50.1, TypeScript 5.9.3. Node는 package.json의 지원 범위 `>=24 <25` 밖이다. 설치/런타임 교체 없이 현재 환경에서 검증한다. 실제 claude/codex 바이너리는 호출하지 않는다.


## 구현 결과와 계약 diff

```ts
interface Run {
  runtime?: 'codex' | 'claude-code';
  projectId?: string;
  // 기존 필드 유지
}
```

기존 Run에 값을 채우지 않고 기존 JSON 저장을 사용한다. SQL migration은 필요하지 않다. 기존 Codex Run과 이벤트 body 형식을 보존했다.

- `POST /api/projects/:id/tasks/:taskId/run`: general 프로젝트는 `{requestId}`만 받는다. code 프로젝트의 workspaceId/acceptance digest 검사는 기존 코드를 유지한다. session/CSRF 경계는 변경하지 않았다.
- `ClaudeTaskService`가 Studio.execution의 기준 검증 후 C2 HandoffService 데이터와 Task 제목으로 `claudeTaskPrompt`를 생성한다. `task-<taskId 앞 8자>.md`를 지정하고 `starting` Run을 저장한 뒤 runner를 시작한다.
- `Projects.generalProject`는 생성 영수증의 경로/루트/디렉터리 신원을 확인한다. 일반 write allowlist만으로 쓰기를 허용하지 않는다.
- Claude 이벤트는 prompt/response를 포함하지 않는다. run.started는 sessionId, claude.tool은 name, claude.quota는 status/windows만 저장한다. terminal 이벤트에 reason을 저장한다. Run.response는 adapter가 정제한 마지막 message를 64,000자로 제한한다.
- `controller.claudeQuota()`는 가장 최근 관측 quota의 복사본 또는 null을 반환한다. accessor는 메모리 상태이며 재시작하면 null이다. quota 이벤트 자체는 DB에 남는다. `quotaFromClaudeWindows(controller.claudeQuota())`로 진행판 신호에 연결할 수 있다.
- 중단 요청은 run.interrupting으로 기록한다. 실제 outcome만 completed/failed/interrupted/lost를 결정한다. 종료 관측이 없거나 재시작 시 lost가 된 Task는 새 requestId로도 실행하지 않는다. 동일 requestId 조회는 기존 Run만 반환한다.
- 복구 차단은 Claude Task 단위이고 기존 Codex 전역 복구 차단과 분리한다. Claude 실행이 Codex 이벤트 처리기의 active Run으로 선택되지 않는다.
- 종료 상태 저장 실패 시 nonterminal intent가 남아 중복 실행을 막는다. 서버 종료 시 중단 요청 기록이 실패해도 소유한 runner에 중단을 시도하며, 관측 없이 interrupted라고 기록하지 않는다.

## 변경 파일

- `shared/types.ts`: Run 선택적 runtime/projectId.
- `server/claude-task-service.ts` (신규): 기준 검증, 실행/이벤트/중단/복구/한도, fake runner factory 주입.
- `server/controller.ts`: general dispatch, Claude interrupt/close/quota, Codex active/recovery 분리.
- `server/http.ts`: 일반 프로젝트의 requestId-only body 분기.
- `server/projects.ts`: 서버 생성 영수증 기반 일반 폴더 검증.
- `server/store.ts`: 새 필드 저장, Claude 이벤트 투영 및 재시작 reason.
- `tests/claude-task-fixture.ts`, `tests/claude-task-service.test.ts`, `tests/claude-task-http.test.ts` (신규): fake 실행기와 서비스/HTTP 검증.
- 이 문서. 기존 테스트, Claude 소유 STATUS 및 금지 경로는 변경하지 않았다.

## 검증 명령과 결과

최종 집중 명령:

```sh
node --test tests/claude-task-service.test.ts tests/claude-task.test.ts tests/claude-runtime.test.ts tests/project-general.test.ts tests/project-creation.test.ts tests/controller.test.ts tests/workspace-controller.test.ts tests/solo-operation-store.test.ts tests/native-connection-store.test.ts tests/native-connection-controller.test.ts tests/handoff.test.ts tests/planning-execution.test.ts
```

exit 0: 122 tests, 121 pass, 0 fail, 1 Windows-only skip, 0 cancelled. 신규 서비스 18개를 포함한다. 승인 기준 결속, 멱등성, 단일 소유자, stale/unapproved, 영수증/경로 교체, credential-like Task의 이벤트 비노출, 마지막 응답 제한, 중단/늦은 이벤트, unknown/exit 미관측, quota/auth/spawn 오류, 재시작, 저장 실패, shutdown 실패를 검사한다. 기존 Codex Controller/워크스페이스/저널/기획/인계 테스트도 포함된다.

| 명령 | exit | 관찰 결과 |
|---|---:|---|
| `npm run typecheck` | 0 | 마지막 종료 보완 후 오류 없음 |
| `node --test tests/claude-task-service.test.ts` | 0 | 최종 서비스 18/18 pass |
| `node --test --test-name-pattern='stale_approval_rejected' tests/task-runs.test.ts` | 0 | 1/1 pass; 실제 Controller + Fake RPC로 기존 code Task 승인 해시/실행/재시작 경로 검사 |
| `node --test tests/claude-task-http.test.ts` | 1 | 4/4 listen EPERM; 네트워크 assertion에 도달하지 못함 |
| `git diff --check` | 0 | 공백 오류 없음 |

### 구현 중 RED 및 회귀 기록

- 최초 신규 fixture 2회: 각 exit 1, 13 fail. planning JSON 외부 형식의 schema_version 및 decision topic 누락을 수정했다. 제품 parser/기존 테스트는 변경하지 않았다.
- fixture 수정 후 서비스 테스트: exit 1, 13 fail, 원인은 기존 general dispatch의 GIT_REQUIRED. 구현 후 exit 0, 13/13 pass.
- 초기 typecheck: exit 2, 테스트 fixture의 session union 타입 접근 오류 1건. fixture 타입 좁힘 후 exit 0.
- 초기 집중: exit 0, 117 tests / 116 pass / 1 skip. 저장 실패/close 테스트 추가 후 신규 서비스 16/16 pass.
- 독립 리뷰: Claude lost가 관계없는 Codex를 차단하는 경로를 발견했다. 회귀 테스트 1/1 fail을 먼저 확인하고 runtime별 차단으로 수정했다. 이후 Claude/Codex 집중 52/52 pass.
- 독립 리뷰: shutdown 중 interrupt 이벤트 저장 실패가 native interrupt도 생략하는 경로를 발견했다. 회귀 테스트 1/1 fail을 확인하고 best-effort interrupt를 추가했다. 최종 집중 122 tests 결과는 이 수정 이후다.
- 전체 검사 1차: `npm test` exit 1, 1,136 tests / 1,021 pass / 113 fail / 2 skip. runtime 복구 분리와 추가 테스트 전 결과다.
- 전체 검사 2차: `npm test` exit 1, 1,140 tests / 1,025 pass / 113 fail / 2 skip. shutdown 저장 실패 보완 전 시작한 검사다.

## 차단과 후속 작업

- 신규 HTTP 4개는 모두 sandbox의 `listen EPERM: operation not permitted 127.0.0.1`로 차단됐다. 테스트 삭제/skip/권한 우회는 하지 않았다. 지원 Node 24 및 loopback listen이 허용된 환경에서 같은 HTTP/전체 검사를 다시 실행해야 한다.
- 전체 검사 중 `tests/orbit-ui-server.test.ts`의 `E2E third merge fixture requires an exact CLI grant and exposes read-only source and primary evidence`는 `merge fixture exited 1`만 출력했다. 기존 테스트가 stderr를 버려 원인은 직접 확인하지 못했다. 주변 fixture의 EPERM과 같을 가능성은 있지만 확정하지 않는다.
- 실 CLI 호출, 실제 결과물 파일 생성/검증, 브라우저, A05/A08/A10의 live 통과는 주장하지 않는다. mock 실행 완료는 검증 통과나 사용자 승인이 아니다.
- 명시적 recovery API/재개 구현은 미래 작업이다. 현재 lost Task는 자동 재시도하지 않는다. quota 소진도 자동 API 키/타 제공자 전환 없이 failed/QUOTA_EXHAUSTED로 남긴다.
- **Claude 후속: ProjectProgressService의 Run 필터에 `run.projectId === projectId`를 포함한다.** 해당 Claude 소유 파일은 수정하지 않았다. quota accessor도 이후 progress route에서 연결할 수 있다.
- 저장소 commit/push/reset/clean, 다른 worktree 수정, 새 설치, 런타임 플래그 변경은 하지 않았다.


## 최종 전체 검사 (shutdown 보완 후)

`npm test > /private/tmp/orbit-c3-verified-test.log 2>&1` → exit 1.

```text
ℹ tests 1141
ℹ pass 1026
ℹ fail 113
ℹ cancelled 0
ℹ skipped 2
ℹ duration_ms 148577.567458
```

실패 113개 중 112개는 listen EPERM이 명시됐다. 나머지 1개는 위 E2E merge fixture의 원인 미확정 exited 1이다. 전체 통과로 간주하지 않는다. [원본 전체 로그](/private/tmp/orbit-c3-verified-test.log)에 실패 테스트 이름과 stack이 남아 있다.

| 실패 파일 | 개수 |
|---|---:|
| `tests/app-preview-http.test.ts` | 2 |
| `tests/app-preview.test.ts` | 3 |
| `tests/bedrock-http.test.ts` | 1 |
| `tests/claude-task-http.test.ts` | 4 |
| `tests/control-plane-http.test.ts` | 1 |
| `tests/development-results-http.test.ts` | 1 |
| `tests/extensions-controller.test.ts` | 1 |
| `tests/goals-http.test.ts` | 1 |
| `tests/handoff-http.test.ts` | 2 |
| `tests/http.test.ts` | 10 |
| `tests/merge-http.test.ts` | 1 |
| `tests/model-hub-http.test.ts` | 1 |
| `tests/model-hub.test.ts` | 6 |
| `tests/orbit-ui-server.test.ts` | 6 |
| `tests/planning-agent-http.test.ts` | 7 |
| `tests/planning-handoff-http.test.ts` | 2 |
| `tests/planning-revisions-http.test.ts` | 1 |
| `tests/project-analytics-http.test.ts` | 1 |
| `tests/project-creation-http.test.ts` | 7 |
| `tests/project-progress-http.test.ts` | 1 |
| `tests/provider-http-transport.test.ts` | 19 |
| `tests/review-http.test.ts` | 1 |
| `tests/source-graph-http.test.ts` | 2 |
| `tests/studio-integration.test.ts` | 16 |
| `tests/task-runs.test.ts` | 7 |
| `tests/usage-controller.test.ts` | 1 |
| `tests/verification-http.test.ts` | 2 |
| `tests/verification-setup-http.test.ts` | 5 |
| `tests/workflows-http.test.ts` | 1 |
