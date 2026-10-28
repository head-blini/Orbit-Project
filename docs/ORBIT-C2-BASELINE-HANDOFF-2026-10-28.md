# C2 — T1 기준 결속과 F05 구조화 인계

- 작업 경로: `.worktrees/codex-core`, 브랜치 `codex/core-baseline-handoff`.
- base/head SHA: `fdce439e29b7479d9775fd797cecf12aa5999ae1` (커밋하지 않음).
- 관찰 환경: Darwin 25.6.0 arm64, Node v26.12.1, npm 11.20.0, Git 2.50.1, TypeScript 5.9.3.
- Node는 package.json의 `>=24.0.0 <25` 밖이다. 설치·런타임 교체 없이 현재 환경에서 검사했다.
- `web/**`, 진행판 계약·서비스, runtimes/browser, 다른 worktree 및 Claude 소유 STATUS 문서는 수정하지 않았다.

## 구현과 계약

| 계약 | 추가 내용 |
|---|---|
| `PlanningDraft` | `nonGoals?: string[]`; JSON `non_goals`, Markdown `Non-goals` / `Non goals` / `하지 않을 것` |
| `Run` | `planningContentHash?: string`; 기존 JSON body 저장을 재사용하며 과거 Run의 필드를 채우거나 migration하지 않음 |
| `ExecutionBrief` | 필수 `planningContentHash: string`; 서버가 검증한 승인본의 해시를 Controller → Store에 전달 |
| `PlanningComparisonData` | `nonGoalsChange?: {before: string[]; after: string[]}`; 변경 시 기존 `plan_context_changed` 영향 사유 사용 |
| `HandoffPackage` | projectId/taskId/sourceRunId, baseline(version/revision/hash/current), goal/constraints/nonGoals, decisions(decision/rationale), requirements(label/acceptanceCriteria), artifacts(id/title), verification(execution/checks), openQuestions/nextAction/allowedTools/markdown |

`nonGoals`는 공백 항목을 제거한 뒤 비어 있지 않을 때만 정규화된 초안에 추가한다. 기존 필드 순서를 유지하고, 신규 필드는 마지막에 둔다. legacy fixture의 JSON 바이트 및 고정 SHA-256 `1f5ba4bad1320531ad224edb1285b104e9b6fd492ee858e55a4afb1849e1b6cf`를 검증했다. JSON/Markdown 내보내기, 저장 내용 검증, 실행 지시문에 제외 범위를 반영한다.

기존 버전 생명주기를 유지한다: revision 저장이 새 ID/리비전을 만들고, 명시적 approve가 그 새 버전을 승인한다. 어느 승인본이 현재인지는 lineage head(`planning_heads`)가 결정하며 이전 승인 기록은 바꾸지 않는다.

새 draft가 head가 된 시점부터 기존 `PLANNING_VERSION_STALE` 실행 거부를 유지한다. 새 승인 뒤에도 이전 작업으로 새 Run을 만들 수 없다. 기존 requestId의 재조회는 같은 Run을 반환하고 다시 실행하지 않는다. Fake RPC를 사용해 실제 Controller 경로에서 native dispatch 이전의 해시 저장, 이벤트, 재시작 후 보존을 검사했다. 기존 해시 없는 Task Run의 body도 재시작 전후 동일하다.

**통합 단계 결정(Claude Code, 2026-10-28):** Codex 초안은 승인 시 같은 lineage의 이전 승인본을 `superseded`로 바꿨으나, 과거 승인 기록을 다시 쓰고 기존 Start 흐름(`web/start-flow.ts`)과 `planning-revisions` 테스트를 깨뜨려 되돌렸다. `planning-revisions.test.ts` 변경도 원복했다. 현재성은 head 기준으로 판정하며 오래된 기준의 실행은 기존 `PLANNING_VERSION_STALE`로 거부된다.

## 읽기 전용 인계

`GET /api/projects/:projectId/tasks/:taskId/handoff`

- 기존 세션 인증 필요. query는 400, 알 수 없거나 다른 프로젝트의 task는 404.
- `HandoffService.build`는 저장된 Task, PlanningVersion, 최신 Task Run, Check, 프로젝트 Artifact만 읽는다. 실행·이벤트 추가·검증 재실행·파일시스템 조회를 하지 않는다.
- `general` 및 `code` 프로젝트 모두 workspace 없이 계획/작업 인계 가능. Run이 workspace를 참조하면 프로젝트 소유권을 검사한다.
- 최신 Run은 기존 Store의 생성/삽입 순서 기준. Run에 해시가 있으면 기준 계획과 일치해야 하며 기존 해시 없는 Run도 읽을 수 있다.
- baseline.current는 해당 계획이 approved 상태이면서 현재 lineage head인 경우에만 true다. 과거 기준의 goal·결정·제외 범위를 새 기준으로 교체하지 않는다.
- checks에는 같은 프로젝트/Run/workspace의 `verdict`, `execution`만 담는다. 과거 검증 결과이며 현재 소스 검증·사용자 승인으로 해석하지 않는다.
- artifacts는 프로젝트의 최신 Artifact ID/title 참조다. 이 Task/Run의 생성물이라고 단정하지 않는다.
- 선택한 텍스트에 `safeText`를 적용하고 경로 형태 토큰은 프로젝트 내부 경로까지 보수적으로 제거한다. prompts/responses, 명령, tool output, artifact source, 프로젝트/workspace 경로는 투영하지 않는다. Markdown fence는 기존 수동 handoff의 renderer를 재사용한다.
- `allowedTools: []`는 unknown placeholder이며 권한을 부여하지 않는다. 자동 전송이나 인계 이력 이벤트는 만들지 않는다.

## 검증 결과

최종 변경 코드에 실행:

| 명령 | exit | 결과 |
|---|---:|---|
| `npm run typecheck` | 0 | 오류 0 |
| `node --test tests/planning*.test.ts tests/studio*.test.ts tests/task-runs.test.ts tests/handoff*.test.ts tests/controller.test.ts` | 1 | 203 tests: 168 pass, 35 fail, 0 skip, 0 cancelled; 실패 35개 모두 `listen EPERM: operation not permitted 127.0.0.1` |
| `git diff --check` | 0 | 공백 오류 없음 |

구현 중 실행한 회귀/실패 검사:

- 최초 `node --test tests/planning-baseline.test.ts`: exit 1, 4/4 fail — 미지원 non_goals와 이전 승인 supersession 누락 재현.
- 최초 `node --test tests/handoff.test.ts`: exit 1, 1 file fail — 구현 파일 부재 확인.
- `node --test tests/planning-baseline.test.ts tests/planning-execution.test.ts tests/planning.test.ts tests/planning-metadata-parser.test.ts`: exit 0, 47/47 pass.
- `node --test tests/planning-baseline.test.ts tests/planning-agent-service.test.ts tests/handoff.test.ts`: 첫 실행 exit 1, 16 pass/1 fail(테스트 Mermaid fixture 누락 노드); fixture 수정 후 exit 0, 17/17 pass.
- `node --test --test-name-pattern='stale_approval_rejected' tests/task-runs.test.ts`: exit 0, 1/1 pass (HTTP 없는 실제 Controller + Fake RPC).
- `node --test tests/planning-revisions.test.ts tests/planning-baseline.test.ts tests/planning-execution.test.ts tests/handoff.test.ts tests/planning-handoff.test.ts`: exit 0, 28/28 pass. 이후 추가한 승인 rollback 검사도 최종 집중 실행에서 통과.
- 초기 typecheck: exit 2 — 비교 필드 enum 확장이 Claude 소유 UI의 닫힌 label map과 충돌. 기존 enum을 유지하고 선택적 `nonGoalsChange`로 변경한 뒤 exit 0.
- 전체 집중 테스트 최초 실행: exit 1, 202 tests / 166 pass / 36 fail. 35개 EPERM와 superseded predecessor fixture 1개를 분리해 확인했고, 위 최종 결과에서는 EPERM만 남았다.

HTTP 검증 차단 내역:

| 파일 | listen 단계에서 실패한 테스트 수 |
|---|---:|
| `tests/handoff-http.test.ts` | 2 (신규 general/code route 검사) |
| `tests/planning-agent-http.test.ts` | 7 |
| `tests/planning-handoff-http.test.ts` | 2 |
| `tests/planning-revisions-http.test.ts` | 1 |
| `tests/studio-integration.test.ts` | 16 |
| `tests/task-runs.test.ts` | 7 |

HTTP assertions는 이 환경에서 도달하지 못했다. 테스트 삭제/skip 처리나 권한 우회는 하지 않았다. loopback listen이 허용되는 지원 Node 24 환경에서 같은 명령을 다시 실행해야 한다. 브라우저·실제 AI 호출·다른 AI로 실제 전달은 미검증이며 A07 전체 통과를 주장하지 않는다. 기존 UI에는 nonGoals 편집 전용 UI 및 nonGoalsChange 표시를 추가하지 않았으며 Claude 통합 시 연결할 수 있다.

## 변경 파일

- 계약: `shared/parallel.ts`, `shared/types.ts`, `shared/planning-revisions.ts`, 신규 `shared/handoff.ts`.
- 서버: `server/controller.ts`, `server/store.ts`, `server/http.ts`, `server/planning/parser.ts`, `server/planning/export.ts`, `server/planning/execution.ts`, `server/planning/repository.ts`, `server/planning/comparison.ts`, `server/planning-handoff-service.ts`, 신규 `server/handoff-service.ts`.
- 테스트: `tests/planning-agent-service.test.ts`, `tests/planning-execution.test.ts`, `tests/planning-revisions.test.ts`, `tests/task-runs.test.ts`, 신규 `tests/planning-baseline.test.ts`, `tests/handoff.test.ts`, `tests/handoff-http.test.ts`.
- 기록: 이 문서. 소유권을 지키기 위해 `docs/ORBIT-STATUS.md`는 변경하지 않았다.
