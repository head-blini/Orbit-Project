# Verification setup implementation plan

**Goal:** 환경변수·실행 파일 경로 입력 없이 프로젝트의 실제 Node 테스트를 검증 명령으로 준비하고 기존 Verification/Workflow에서 실행한다. 전체 Task34의 다음 수직기능이며 테스트 작성·전 요구사항 수용 판정·원클릭 AI 자동화를 대체하지 않는다.

**Spec:** goal-objective.md §6/9/11 Phase1, MASTER PLAN Task34b. 시작 HEAD7c563a2, clean 전용 branch, macOS arm64/Node24. 기존 사용자 설정·primary·AI 기록을 보존한다.

## Design and decisions

- 기존 raw command 환경변수는 호스트 고급 설정으로 유지한다. 웹 arbitrary executable/argv 편집은 기존 신뢰 경계를 넓힌다. 서버 내장 프리셋을 preview/CAS로 명시 등록하는 방식을 선택했다. 첫 프리셋은 Node24의 현재 실행 파일과 `--test --` 및 실제 `*.test.js/mjs/cjs` 파일 목록이다. npm·설치·shell은 추가하지 않는다.
- 현재 Git-visible snapshot에서 present 테스트 파일을 찾는다. 파일0개는 등록 불가이며 검증 성공을 만들지 않는다. 테스트 최대60개, 기존 protectedFiles 경로 정책과 스냅샷 경계를 재사용한다. 선택한 테스트 전부와 존재하는 root package.json/package-lock.json을 보호 목록으로 저장한다. 새 파일을 후속 실행에 조용히 추가하지 않고 새 preview/등록으로 갱신한다.
- 명령 준비는 파일 수정·프로세스 실행·Check 생성을 하지 않는다. 실제 실행은 기존 Verification 또는 Workflow의 명시 승인 경로다. 이 검사들은 코드 실행이며 OS sandbox가 없음을 표시한다. 테스트 통과를 테스트 품질·요구사항 전체 충족으로 표시하지 않는다.
- host command가 있으면 프리셋 등록을 막고 해당 설정을 우선한다. 저장 프리셋은 프로젝트 ID/정확한 path에 결합한 revision과 receipt로 SQLite에 보존한다. 손상된 저장 설정은 조용히 none으로 대체하지 않는다. 주어진 설정 배열 constructor API는 유지하고, 운영 Controller에서 두 서비스에 같은 동적 resolver를 전달한다.
- 등록 preview digest는 workspace/project/base/source/current revision/현재 설정과 생성할 명령에 결합한다. 같은 request는 같은 receipt, 다른 input은 conflict. 새 등록은 현재 선택 workspace·idle·프로젝트 내 pending/lost 검증/Workflow/merge/review/planning gate를 확인한다. revision/receipt/event는 원자 저장한다.
- 사용자는 내부 구현 판단을 위임했다. 기존 스택·분리 branch를 재사용하고 별도 승인 질문 없이 구현한다. 독립 UI와 registry 파일만 병렬 위임하며 root가 HTTP/Controller/resolver 통합을 맡는다.

## Contracts

- `shared/verification-setup.ts`가 UI/API 계약이다. GET `/api/workspaces/:id/verification-setup` returns view. POST same path accepts only ConfigureVerificationInput, returns receipt. query/extra fields rejected, existing session/Origin/CSRF preserved.
- `server/verification-configuration.ts`: 기존 configuration parser/preview/type를 이동하고 원 module re-export로 compatibility 유지. `VerificationCommandResolver=(projectPath:string)=>VerificationCommandPreview[]`, array 또는 resolver를 받는 service constructor.
- `VerificationSetupService(store,projects,hostConfig=[])`: `commands(projectPath)`, `view(workspaceId)`, `configure(workspaceId,input)`. Controller owns admission/selected workspace policy. Service independently revalidates writable workspace, input, source/config revision CAS and host priority.
- `VerificationSetupPanel({workspaceId,online,busy,post,onConfigured})`: candidate 표시/checkbox/명시 등록, persisted pending identity, explicit retry/reload, stale async scope discard. 기존 VerificationPanel에 연결하고 성공 후 view refresh. 파일 없는 상태를 구체적으로 설명한다.

## Tasks

- [x] Registry real Git RED→GREEN: no tests, detected bounded files, protection, stale source/revision, extra input/false consent, duplicate/conflict, host priority, cross-project separation, restart, DB rollback/corruption, no processes/files modified.
- [x] Root resolver integration RED→GREEN: Verification+Workflow+Acceptance use same current command; host arrays retain behavior; real Node pass/fail and existing approval staleness when profile revised.
- [x] UI RED→GREEN: explicit consent, no initial POST, stale/offline/unmount, duplicate click, uncertain outcome persisted, refresh reconciliation, no-test/host text. HTTP auth/CSRF/exact/CAS/quarantine tests.
- [x] Independent whole-change review, full Node24 verify, actual Chrome config→real Node Check and restart preservation, evidence and MASTER PLAN/RESULTS.
- [x] Final diff review; preserve this change set as a local checkpoint on the existing branch.

## Progress / rulings

- Previous turn progress: Task34a committed7c563a2, whole983/981pass/2Windows skips. No live test server from prior turn.
- Ruling: keep one plan/progress record here and normal ignored evidence; do not create redundant tracking documents. Existing objective explicitly delegates routine design choices and independent work.
- Registry15pass, resolver+legacy16pass, UI17+legacy9pass, HTTP5pass. Independent reviewer found a real nonUUID requestId response mismatch; a failing UI test preceded the server-compatible response validator fix. No additional actionable findings after re-review.
- Final `task34b-final-verify.log`:1022total/1020pass/0fail/2Windows skips, type0/build0/exit0. Actual Chrome registered without executing a Check, then actual Node pass0/fail1 and sameDB restart preserving all records, original repository and test bytes. Synthetic Run1, actualAI0, nativeCalls0. All owned servers/tabs stopped; ignored evidence folder `verification-setup-20261027` finalizer exit0.
- Full objective remains active. Task34c continues the beginner current-step/next-action flow and test preparation guidance; original A–K, real scenarios A–E, Windows and provider expansion remain mandatory.
