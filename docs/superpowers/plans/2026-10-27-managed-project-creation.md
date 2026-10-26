# Managed Project Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 Git 명령이나 기존 폴더 허용 목록을 준비하지 않고 이름만 입력해 새 프로젝트와 격리 작업 공간을 만들고 기획을 시작한다.

**Architecture:** 기존 Projects/Store/trustedGit/Controller/HTTP/React를 확장한다. 서버가 설정한 새 프로젝트 전용 root 아래 UUID 폴더만 생성하며 요청 receipt와 생성 소유권을 SQLite에 보존한다. 기존 저장소 등록·허용 목록은 그대로 유지한다.

**Tech Stack:** TypeScript/React/Node24/SQLite/Git. 새 의존성 없음.

**Spec:** goal-objective.md §1/9/11 Phase1, docs/ORBIT-MASTER-PLAN.md Task34. 이 계획은 Task34의 프로젝트 준비 수직기능이며 검증 명령 준비·전체 자동화는 다음 기능이다.

## Design and approaches

- UI 안내만 추가하면 실제 Git 준비 부담이 남는다. 기존 폴더 전체를 쓰기 허용하면 권한 범위가 불필요하게 커진다. 서버가 새로 만든 정확한 프로젝트만 지속적으로 식별하는 방식을 선택했다.
- 기본 프로젝트는 README만 가진 일반 Git 저장소다. 정적 웹앱 유형을 강요하지 않는다. 초기 Git commit과 기존 worktree 생성은 제품 내부에서 수행한다. AI 연결/기획/명령 검증을 생성 작업에 숨겨 실행하지 않는다.
- 호스트 검증 명령은 두 서비스가 정적으로 보존하므로 같은 변경에 불완전한 동적 설정을 끼우지 않는다. 명령이 없는 새 프로젝트의 unbound/미검증 표시는 유지한다. 전체 사용자 목표는 축소하지 않는다.
- 요청에는 requestId와 name만 허용한다. 파일 경로·명령·Git 옵션은 받지 않는다. 이름은 출력용으로만 쓰고 경로는 서버 UUID로 정한다.

## Global Constraints

- 기존 사용자 저장소·허용 목록·인증·Git 사용자 설정을 수정하지 않는다. trustedGit의 고정 local identity와 빈 init template을 사용한다.
- main과 worktree는 별도 root. root/저장소 교체·링크·중간 실패는 권한 승격이나 자동 새 생성의 근거가 아니다.
- intent는 파일 생성 전에 저장. 같은 요청은 같은 결과, 다른 name은409. 중간 종료·실패는 기록과 파일 보존 후 명시 오류이며 자동 삭제·재시도하지 않는다.
- Controller 기존 idle/quarantine과 선택 변경 정책을 유지한다. receipt 재조회는 AI 실행이 아니다.
- 사용자 목표의 내부 판단 위임에 따라 별도 설계 승인 질문 없이 현재 전용 branch에서 구현한다.

## Review Focus

- 생성 후 응답 유실·재시작 시 두 번째 저장소/worktree를 만들지 않는가.
- 같은 관리 root의 임의 기존 저장소/다른 project ID가 쓰기 권한을 얻지 않는가.
- 이름에 경로·옵션·HTML·인증정보·제어문자를 넣어도 고정 파일/명령 경계가 유지되는가.
- 생성 중 Git/DB 실패와 root 링크·교체 이후 파일을 삭제하거나 성공으로 표시하지 않는가.
- UI 중복 클릭·오프라인·프로젝트 전환·저장소 금지 시 동작이 현재 범위에 묶이는가.

### Task 1: Durable project preparation

**Files:** server/projects.ts, optional server/project-creation.ts, shared/project-creation.ts, tests/project-creation.test.ts.
**Interfaces:** Projects constructor optional fourth `creationRoot?:string`; `creationAvailable:boolean`; `createProject(input:{requestId:string;name:string}):{project:Project;workspace:Workspace}`. Ready exact owned projects remain writable without external allowlist; unrelated projects remain locked. Reopening same Store/root restores completed requests. Incomplete requests throw `PROJECT_CREATION_INCOMPLETE`.

- [x] Write/run failing real Git tests for creation, duplicate request, conflicting input, restart, foreign path/project and root links/replacement, failed save/Git preservation.
- [x] Implement exact creation/ownership receipts and safe initial commit/worktree reuse.
- [x] Run focused tests, inspect filesystem/DB outcome and unchanged original repos.

### Task 2: Browser start path

**Files:** server/controller.ts, server/http.ts, server/main.ts, shared/types.ts, web/workspaces.tsx, web/main.tsx, tests/project-creation-http.test.ts, tests/project-creation-ui.test.ts.
**Interfaces:** Snapshot optional `projectCreationAvailable:boolean`; authenticated POST `/api/projects/create` accepts only `{requestId,name}` and returns Task1 result. Controller `createProject` uses idle gate. Selection is a separate existing POST; uncertain selection can be reconciled without recreating project. `WorkspacePanel` optional `onPlanning():void` for continuing after selection.

- [x] Write/run failing HTTP auth/CSRF/field/quarantine/idempotence tests and UI double-click/retry tests.
- [x] Expose optional root at main `.local/projects` and render name form when capability is available. Preserve old import form as existing-project advanced path.
- [x] Reuse/create request identity on uncertain response; do not clear pending identity before project result is known. After creating/selecting, offer planning navigation.
- [x] Verify generic new project has zero AI/Checks and no commands implied.

### Task 3: Whole change verification

- [x] Independent read-only review; fix material findings with regression tests.
- [x] Node24 `npm run verify`, `git diff --check`.
- [x] Actual Chrome name→ready project/worktree→planning, duplicate/reload/restart/no AI replay, old allowlist preserved; owned hosts close.
- [x] Update MASTER PLAN/RESULTS, preserve evidence, local commit only.

## Progress

- Start ca87694, clean dedicated branch, Darwin arm64, same single checkout. Prior Task33 is verified progress.
- Ruling: split project preparation from dynamic verification settings because both command consumers require a deliberate shared resolver and persistence contract; do not report Task34 overall complete until that follow-up is done.
- Backend real Git RED12 → creation/existing focused25pass/2Windows skip; HTTP missing route/capability RED5 →5pass. First HTTP GREEN run had one test-contract error expecting the display name in the intentionally fixed README; the assertion was corrected to the fixed README contract and the project name remains independently asserted.
- UI invalid name rejection and late unmounted response overwrite were reproduced RED2, then fixed. Initial whole verification981total/979pass/2Windows skip/0fail/type0/build0.
- Independent review identified first-project SSE fallback as a possible scope race. Default Chrome timing passed, while a deterministic actual resolveProject + deferred HTTP regression reproduced a missing selection POST. Permit only the single empty-catalog→returned-project transition; transient unrelated selection/connectivity changes remain blocked. Focused UI20/20; final review has no outstanding material findings.
- Final Node24 whole verification983total/981pass/2Windows-only skip/0fail/type0/build0/exit0. Actual Chrome creation from existing/empty catalog, planning navigation, reload, same-DB restart and original repository preservation confirmed. No AI execution or configured commands. Evidence and limitations are in MASTER-RESULTS Task34a and ignored `.local/ui-e2e/project-creation-20261027`; owned hosts stopped and tabs closed. Next Task34b remains incomplete.
