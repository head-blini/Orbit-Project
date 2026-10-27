# Beginner Start Flow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, TDD, and one independent final review. Independent coordinator and compact planning UI files are delegated; root owns page/navigation integration.

**Goal:** 기본 시작 화면에서 자연어 기획, 기획 검토와 작업 준비, 기존 Task 실행, 검증 설정/실행, 결과 미리보기를 이어서 사용한다.

**Architecture:** 기존 PlanningAgent coordinator, Studio endpoints, Task acceptance dialog, VerificationPanel, DevelopmentResultPanel을 재사용한다. 새 실행 엔진이나 저장 포맷을 만들지 않는다. `#/start`가 기본이며 기존 고급 URL을 유지한다.

**Tech Stack:** 기존 React/TypeScript/Node24/SQLite, 새 의존성 없음.

**Spec:** 사용자 goal-objective.md §6/9/11 Phase1, MASTER PLAN Task34c. 전체 A–K 및 원클릭 자동화는 계속 목표이며 이 화면 연결을 자동 실행 엔진 완료로 표시하지 않는다.

## Design and rulings

- 기존 대시보드에 링크만 추가하는 안은 요구 입력/실행을 계속 여러 화면에 분산시킨다. 별도 엔진을 만드는 안은 승인·복구 정책을 중복한다. 기존 동작을 기본 시작 화면에 직접 배치하고 필요한 고급 화면은 유지한다.
- 화면 단계는 기획/개발/검증/결과다. 단계 선택은 자동 실행이 아니다. 기획 완료·Task 응답 완료를 검사 성공이나 제품 완료로 바꾸지 않는다. 프로젝트별 현재 lineage head와 정확한 workspace/Task/Run 연결만 사용한다.
- 기획 승인과 Task 준비는 명시 버튼 한 번으로 기존 두 API를 순서대로 호출한다. 각 경계에서 scope/온라인/차단 상태를 확인한다. 불확실한 결과는 수동 조회로 확인하며 자동 재전송하지 않는다. Task 실행은 기존 preview/CAS·pending receipt·서버 gate를 거친다.
- 프로젝트가 없으면 기존 ProjectCreatePanel을 직접 제공한다. 기존 프로젝트의 workspace 불일치·쓰기 금지는 관리 화면으로 안내한다. 입력 원문을 새 browser storage/서버 기록에 저장하지 않는다.
- 기획의 간단한 표시 방식은 동일한 coordinator와 동의 경계를 사용한다. 원문·전송 범위는 확인 가능하게 유지하되 평상시 고급 설명은 접는다. 비용/권한 승인을 생략하지 않는다.
- 사용자 §13이 내부 판단과 병렬 구현을 위임했다. 추가 승인 질문 없이 진행하며 plan 한 곳에 진행을 기록한다. 기존 전용 branch HEAD062d2aa/clean 단일 worktree를 유지한다.

## Interfaces and tasks

- [x] `web/start-flow.ts`, `tests/start-flow.test.ts`: `StartFlowScope {projectId,workspaceId,online,blocked,refreshKey}`, `StartFlowState {scope,plans,tasks,selectedPlanId,loading,fresh,action,uncertain,error}`. `currentStartPlans(plans,projectId)` returns current lineage heads. `createStartFlowCoordinator(scope,{get,post,storage?})` provides activate/dispose/configure/refresh(manual=false)/selectPlan/prepareTasks():Promise<boolean>/getSnapshot/subscribe. Existing plans/tasks GETs; prepare uses selected current plan revision approval then task-drafts. No native execution. RED→GREEN for exact body, partial/uncertain outcomes, fresh/manual reload, duplicate submit, stale scopes, multi-lineage and older approvals.
- [x] `shared/planning-agent.ts`, `web/planning/PlanningAgent.tsx`, related new compact UI test: add `presentation?:'advanced'|'simple'`, default advanced. Simple title/input and concise disclosure layout; same coordinator/consent/history/mutations. RED→GREEN preserves existing advanced output and tests simple behavior/limits.
- [x] Root `web/start.tsx`, `web/start.css`, `web/main.tsx`, navigation/shell and tests: default start route, existing advanced routes preserved. Start page uses coordinator and existing components. Explicit plan selector/review, one prepare button, Task buttons call existing parent runTask; starter executions stay on start page. Current active Run shows response/interrupt; verification and preview are directly reachable. No native launch on mount/reload. Scope changes suppress previous data immediately.
- [ ] Full Node24 verify, independent review, actual Chrome new-project→starter planning/prepare plus real local Check/preview/restart evidence. Synthetic runtime fixtures must remain clearly labelled; actual AI only if explicitly recorded. README/MASTER records and local checkpoint commit.

## Review focus

- Newer revision with an older approved ancestor must not run that ancestor silently.
- Project/workspace/offline/blocked transitions during approve must not create Tasks in the old scope.
- Server SSE for the same approval must not invalidate its own continuation or replay it.
- Unknown request results/reload must not automatically send a new native request.
- Basic UI must preserve explicit native/OS execution consent and source-bound verification evidence.

## Progress

- Previous turn Task34b is progress: commit062d2aa,1022total/1020pass/2Windows skips, actual Chrome/Node/restart evidence. Full goal active; no live test fixture remains.

- 구현/리뷰: coordinator16개, compact UI2개, Start UI8개 신규 회귀. partial replan의 누락 Task, 자체 planningBusy에 의한 응답 무효화, gate 전환 패널 교체, 저장/조회 경합을 RED→GREEN으로 수정했다. 독립 재검토 추가 actionable finding 없음.
- 전체 `.local/verification/start-flow-final-verify.log`:1048total/1046pass/2Windows skips/0fail, type0/build0/exit0. 최초 전체는 navigation 고정 개수12→13 assertion1개 실패 후 기대값을 새 라우트 수에 맞췄다. 실제 Chrome/native Codex 흐름 검증 중.
