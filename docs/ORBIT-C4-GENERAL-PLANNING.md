# C4 — general planning and project AI preferences

Specification: user C4 request, ORBIT-VISION, ORBIT-SCOPE F01/F10/F11 and A01/A12/A14.
Working tree: `codex/core-general-planning`, base `b695576`. No commit/push or other worktree changes.

## Design and implementation plan

Reuse PlanningAgentService's preview, durable intent, explicit save, quarantine and recovery.
Add a small Claude planning runner over the existing read-only ClaudeCodeRun library.
Keep Codex's existing runner and parser contract intact. General projects use the exact
server-owned folder receipt; code projects retain selected-workspace validation.
Preferences live in an additive table, with virtual revision 0 / updatedAt null until a
changed value is saved. Compare revision before treating an update as a no-op.
Preview binds the runtime and preference revision; an already-started suggestion keeps
its selected runtime even if preferences subsequently change.

- [x] Preferences: shared contract, table/service, defaults, CAS, validation, inert reads/writes.
- [x] Claude runner: read mode, bounded single invocation, parser, login/quota, exit-confirmed cancellation.
- [x] Planning integration: nullable workspace for general projects, runtime attribution, old records as Codex, lifecycle and ownership tests.
- [x] HTTP/controller: preferences routes, nullable planning routes, CSRF, selected workspace and execution exclusion.
- [x] Focused tests/typecheck, review, exact API handoff and limits (socket HTTP blocked as recorded below).

Tests use injected RPC/Claude runners and disposable local directories only. No real
Claude/Codex process or paid API. Preserve all existing tests and Claude-owned files.
Node observed: 26.12.1 (package engines require >=24 <25). HTTP listen may be denied
by the sandbox; report actual results separately from unit tests.

## Review focus

Preference changes between preview/start and after durable launch; general workspace
spoofing or symlink replacement; cancellation without observed exit; restart and
idempotent retries; invalid/sensitive output and prompt-free audit events.

## Progress and decisions

Initial inspection: clean worktree. Existing general-project tests require GIT_REQUIRED
only for workspace-bound planning; preserve that contract. UI and runtimes remain unchanged.

Implementation decisions (optional questions sent; no answer received):
- General projects may save `planning:'codex'`, but always use Claude planning because
  this task adds no Codex non-Git runner. Preview/view disclose the effective runtime.
- `execution` is a persisted selection contract only in C4. Existing task dispatch remains
  code→Codex / general→Claude. Code-project Claude task execution needs a later server change;
  UI must not present that execution choice as working dispatch yet.
- Runtime and preference revision are part of the preview digest. A preference change
  invalidates an unstarted preview, even when only execution changed. Once start has
  persisted a suggestion, subsequent preference changes cannot retarget it.
- Runtime is optional in the shared legacy-compatible interfaces; new server responses
  always include it, and historical records without runtime read as `codex`.
- Analytics formerly required a workspace and hardcoded Codex attribution. C4 now projects
  general Claude planning and attributes code-project Claude suggestions correctly, while
  retaining project/workspace ownership checks and unknown usage/cost values.
- Independent read-only review found two issues, both reproduced with failing tests and
  fixed: a lost Claude task now blocks planning in its own project; a bounded stdout
  observer detects native response masking/truncation before the unchanged runtime
  sanitizes it. The observer keeps only an issue code, never emits raw text. The actual
  ClaudeCodeRun library with injected fake spawn verifies this boundary. No real AI binary
  was run. Literal `[REDACTED]` output is conservatively rejected too.

## Claude UI handoff — exact contracts

All routes require the existing session. POST uses the existing Origin/CSRF headers.
Responses are direct objects (no `{preferences: ...}` / `{preview: ...}` wrapper).

`GET /api/projects/:id/ai-preferences` →
`{planning:'codex'|'claude-code',execution:'codex'|'claude-code',revision:number,updatedAt:string|null}`.
Absent row: code defaults to Codex/Codex, general to Claude/Claude, revision 0, updatedAt null.

`POST /api/projects/:id/ai-preferences` body:
`{expectedRevision:number,planning:'codex'|'claude-code',execution:'codex'|'claude-code'}`.
Returns the same shape. Revision increments only on a changed value. Stale revision →
409 `{error:'AI_PREFERENCES_STALE'}` (including a stale no-op); unsupported values/extra fields →
400 `{error:'INVALID_FIELDS'}`; general `execution:'codex'` → 409 `{error:'GIT_REQUIRED'}`.
GET/POST never creates a Run or suggestion or changes an active run.

Let `P=/api/projects/:id/planning-suggestions` and `W` be a workspace UUID for code projects,
or null/omitted for general projects. Code projects require the currently selected workspace.

| Method/path | Request | Response |
|---|---|---|
| GET P | Code: `?workspaceId=UUID`; general: no query | PlanningAgentView, including effective `runtime`, `workspaceId:null` for general |
| POST P/preview | `{workspaceId:W,text}` | PlanningAgentPreview: instructions, inputDigest, previewDigest, runtime, preferencesRevision, timeoutMs:60000, turnLimit:1, scope |
| POST P/start | `{requestId,workspaceId:W,text,expectedPreviewDigest,confirmed:true}` | PlanningSuggestion; starts one separate read-only request |
| POST P/:suggestionId/interrupt | `{workspaceId:W}` (general may send `{}`) | PlanningSuggestion; remains running until exit is observed |
| POST P/recover | `{workspaceId:W,suggestionId,confirmedStopped:true}` | Lost suggestion with recoveredAt; no retry |
| POST P/:suggestionId/save | `{workspaceId:W,expectedOutputDigest}` | NEW PlanningVersion with state draft; same receipt retry returns that version |

Suggestions contain `runtime`, nullable workspaceId, execution/proposal/outputDigest/issue,
processStopped/recoveredAt, timestamps, savedPlanningVersionId; Claude's session ID uses
threadId and turnId stays null. JSON v1/Markdown output is parsed with the existing parser;
provenance is assigned by the server as `{kind:'in_app_agent',providerId:'claude-code',externalUrl:null}`.
Typical issue codes: LOGIN_REQUIRED, QUOTA_EXHAUSTED, PLANNING_PROPOSAL_INVALID,
PLANNING_PROPOSAL_BLOCKED, PLANNING_TIMEOUT, PLANNING_PROCESS_STOP_UNCONFIRMED,
PLANNING_INTERRUPTED_BY_RESTART. Service quarantine may normalize unconfirmed exit to
PLANNING_PROCESS_UNCERTAIN. Prompt text is never included in activity events.

Update `web/planning/PlanningAgent.tsx` and its parent flow: enable general projects without
a workspace, omit GET query for general, allow null response scope, remove hardcoded Codex
labels, render preview.runtime/scope and per-record runtime, refetch preferences and preview
after a CAS conflict or preference update. Keep explicit consent, save and recovery controls;
do not treat completion as approval. Wire simple and advanced views to the same preference
object/revision. No UI or runtime files were edited in this worktree.

## Verification and changed files (2026-10-28)

Changed existing files: `server/controller.ts`, `server/http.ts`,
`server/planning-agent-service.ts`, `server/planning/agent-input.ts`,
`server/project-analytics.ts`, `shared/planning-agent.ts`.
Added: `server/claude-planning.ts`, `server/project-ai-preferences.ts`,
`shared/project-ai-preferences.ts`, this document, and
`tests/claude-planning.test.ts`, `tests/general-planning-fixture.ts`,
`tests/general-planning.test.ts`, `tests/general-planning-routes.test.ts`,
`tests/general-planning-http.test.ts`, `tests/project-ai-preferences.test.ts`.
No existing tests were modified or removed. No commit, push, reset, clean, deployment,
installation, other-worktree write, or real AI execution was performed.

Final checks:

| Command | Exit | Observed result |
|---|---:|---|
| `npm run typecheck` | 0 | TypeScript check passed |
| Focused command below | 0 | 212 tests, 212 passed, 0 failed, 0 skipped |
| `node --test tests/claude-planning.test.ts` | 0 | 7 passed after simplifying the boundary test to exercise the default runner factory |
| `node --test tests/planning-agent-http.test.ts tests/general-planning-http.test.ts` | 1 | 9 failed at socket setup, all `listen EPERM 127.0.0.1`; route assertions not reached |
| `git diff --check` | 0 | No whitespace errors |

Focused command (zsh brace expansion; output captured at `/tmp/orbit-c4-focused.log`):

```sh
node --test tests/project-ai-preferences.test.ts tests/claude-planning.test.ts tests/general-planning.test.ts tests/general-planning-routes.test.ts tests/planning-agent-{service,input,ui,simple-ui,integration-ui}.test.ts tests/codex-planning.test.ts tests/project-general.test.ts tests/claude-{runtime,task,task-service}.test.ts tests/planning{,-baseline,-metadata,-metadata-parser,-export,-revisions,-handoff,-execution}.test.ts tests/controller.test.ts tests/project-analytics.test.ts
```

Earlier failing-first runs: preferences 0/3 and Claude runner 0/6 before implementation;
general planning 0/5 (`GIT_REQUIRED`/missing preferences); analytics assertions 4/6 before
projection fix; review regressions 12/14 before fixes. An intermediate typecheck exited 2
for an overly broad string type in the new preference test fixture; fixed with `as const`.
These failures were not hidden by changing existing tests.

The two in-process route tests run real session/CSRF/handler logic over synthetic transport;
they are included in 212 and are not socket integration evidence. Full `npm test`, build,
browser E2E, and real provider integration were not run. Claude must rerun socket HTTP and
full integration outside this sandbox on supported Node 24 (observed here: 26.12.1).
The changed `execution` setting still requires follow-up dispatch/UI integration as described
above; general `planning:'codex'` uses the explicitly disclosed Claude fallback. Existing
lost Claude task recovery remains a follow-up: same-project planning now stays busy until
that unresolved task ownership is resolved. Planning suggestion recovery itself is implemented.

## 통합 검토 결정 (Claude Code, 2026-10-28)

독립 검토에서 다음을 바로잡았다.

1. **선택값과 실제 실행기 불일치 제거.** 초안은 일반 프로젝트에 `planning:'codex'`, 코드 프로젝트에 `execution:'claude-code'` 저장을 허용했지만 실제로는 각각 Claude, Codex가 실행됐다. 이제 실행할 수 없는 조합은 저장 단계에서 거절한다(일반: Codex 기획·실행 → `GIT_REQUIRED`, 코드: Claude 실행 → `RUNTIME_NOT_SUPPORTED`). 작업 실행 시 Controller가 저장된 실행 설정과 실제 실행기의 일치를 다시 확인한다.
2. **보안 기준 일치.** Codex 실행은 실행 지시문에 인증정보·개인정보 패턴이 있으면 차단(`CREDENTIAL_LIKE_INPUT`/`PERSONAL_DATA_BLOCKED`, `guardrail.denied` 기록)하지만 Claude 작업 실행은 마스킹만 했다. 같은 원문 brief에 같은 검사를 적용하도록 맞췄다. 기획 경로는 두 실행기가 이미 같은 입력 검사를 공유한다.
3. **모델 전환 후 기준 유지 회귀 테스트 추가.** 코드 프로젝트에서 기획 AI를 Codex→Claude로 바꾸고 새 초안을 저장해도 승인본·실행 brief·인계 자료(결정 이유·하지 않을 것·목표)가 바뀌지 않음을 확인한다.
4. 위 정책에 맞춰 C3/C4가 새로 만든 테스트 일부를 조정했다(실행 불가 조합 저장을 성공으로 기대하던 사례 → 거절 확인, CAS는 실제 전환이 가능한 코드 프로젝트에서 확인). 기존(C3 이전) 테스트는 바꾸지 않았다.

현재 실제 선택 가능 범위: 일반 프로젝트 = 기획·실행 모두 Claude Code만. 코드 프로젝트 = 기획 Codex/Claude Code 선택, 실행 Codex만.
