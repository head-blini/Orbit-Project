# Orbit Scope Lock & Progress — Implementation Plan

> **For agentic workers:** Claude Code·Codex가 `docs/ORBIT-COLLABORATION.md`의 분담으로 구현한다(2026-10-28 정정). 환경에 설치되어 있다면 `superpowers:executing-plans` 또는 `superpowers:subagent-driven-development`를 사용한다. 별도 설치를 강제하지 않는다.

**Goal:** 고정 범위 F01~F11을 기존 Orbit 위에 통합하고 A01~A16의 실제 증거로 개인 실사용을 검증한다.

**Architecture:** 기존 로컬 서버·저장소·UI·Codex 실행·이벤트·검증을 재사용한다. 승인본과 공통 작업/실행/증거를 연결하고, 진행 화면을 동일 상태의 읽기 모델로 제공한다. Claude Code와 ChatGPT 웹은 어댑터로 연결하며 독자 AI 실행 루프를 만들지 않는다.

**Tech Stack:** 현재 로컬의 TypeScript/React/Node/SQLite 및 기존 테스트·빌드 도구를 우선한다. 원격 package.json의 Node >=24 <25와 로컬이 같은지 먼저 확인한다.

**Spec:** `docs/ORBIT-SCOPE-2026-10-27.md` — 기준 ID `ORBIT-SCOPE-2026-10-27-v1.0` (v1.1: 개발 담당 정정만)

## Global Constraints

- 개발 담당: **Claude Code·Codex 공동 개발**(2026-10-28 정정). Orbit 제품의 연동 대상인 Codex·Claude Code·ChatGPT 웹과 구분한다.
- 목적: 개인 실사용이 우선. 충분히 검증한 뒤 사내 공유를 검토한다.
- 승인 없는 원격 push·배포·운영 변경, reset --hard/clean/강제 덮어쓰기를 하지 않는다.
- A04~A06은 모의 테스트만으로 통과 처리할 수 없다.
- 원격보다 로컬이 앞설 수 있다. 과거 SHA를 현재 작업 기준으로 강제하지 않는다.
- 단계별 구현 완료는 전체 목표 완료가 아니다. 세 도구와 코드/비코드 실사용 게이트를 보존한다.
- 진행판은 초기 통합부터 만든다. 전체 엔진 완성 뒤로 미루지 않는다.

## Review Focus

1. 로컬 선행 커밋/dirty 변경/과거 지침 충돌: 새 기준 적용이 최신 코드·안전 규칙을 잃지 않아야 한다(T0).
2. 진행 중 기준 수정/지연 승인/기존 증거: 승인 불변성과 영향 범위·재검증이 맞아야 한다(T1,T2,T6).
3. 재시작/중복 이벤트/순서 역전/중단 응답 유실: 완료나 재실행을 임의로 만들지 않아야 한다(T2,T7).
4. 브라우저 대상 대화 오류/늦은 응답/부모-자식 실행: 잘못된 작업 결속과 중복 실행을 막아야 한다(T4,T5).
5. 미지원 기능·관측 불가 quota·공유 한도·민감 도구 출력: 허위 지원·이중 집계·비밀 노출이 없어야 한다(T6,T7,T8).

## 계획의 적용 한계와 파일 매핑

이 계획은 원격 파일과 사용자가 제공한 과거 로컬 감사 기록에 근거한 재개 계획이다. 현재 로컬 파일 전체를 직접 검사한 라인 단위 patch 계획은 아니다. **T0에서 대응 경로/이미 구현된 단위를 한 번 확정하고 중복 생성하지 않는다.** 제품 범위와 완료 조건은 그대로 유지한다.

| 관심사 | 확인할 기존 경로 | 새 경로가 필요할 때의 후보 |
|---|---|---|
| 기준·기획·인계 | `server/studio.ts`, `server/planning/`, `server/planning-handoff-service.ts`, `shared/planning-handoff.ts` | `server/project-baseline.ts`, `shared/project-baseline.ts` |
| 실행·상태·복구 | `server/controller.ts`, `server/store.ts`, `server/http.ts`, `server/codex.ts`, `server/rpc.ts`, `shared/types.ts` | `server/project-progress.ts`, `shared/project-progress.ts` |
| 화면 | `web/pages.tsx`, `web/shell.tsx`, `web/navigation.ts`, `web/agent-center.tsx`, `web/planning/` | `web/project-progress.tsx` |
| 범용 프로젝트 | `server/projects.ts`, `server/workspace.ts`, `shared/types.ts` | 기존 구조 확장 우선 |
| 결과·검증 | `server/visualization/`, `server/verification-service.ts`, `server/review-service.ts` | 기존 기능별 검증 확장 우선 |
| 사용량·도구 | `server/usage.ts`, `server/extensions.ts`, `server/capabilities.ts`, `web/usage.tsx` | 기존 기록에 프로젝트·실행 연결 |

### 공통 구현 사이클

각 T1~T8에서 명시된 회귀 사례를 먼저 실패시키고 최소 변경으로 통과시킨다. `node --test <해당 테스트>` 및 현재 로컬의 typecheck/build 명령으로 확인한다. 기존 실패는 숨기지 말고 기준선과 비교한다. 검증한 자기 변경만 분리해 로컬 commit할 수 있으며 사용자 변경을 포괄 stage하거나 원격 push하지 않는다.

## T0. 승인 범위 적용과 로컬 기준선

**Files:** `AGENTS.md`, `docs/ORBIT-SCOPE-2026-10-27.md`, `docs/ORBIT-GOAL.md`, `docs/ORBIT-STATUS.md`, `docs/ORBIT-MASTER-PLAN.md`, `docs/ORBIT-MASTER-RESULTS.md`, 이 계획.

**Input:** 첨부 고정 범위, 실제 로컬 Git/지침/실행 상태. **Output:** 적용 기준 ID, 경로 매핑, 실제 검사 기준선, 재사용/보완/차단 목록.

- [ ] `git status --short --branch`, `git log -1 --oneline`, `git branch -vv`, `git worktree list`를 확인한다. upstream이 있을 때만 ahead/behind를 계산한다. 인증정보가 포함된 원격 URL을 로그에 노출하지 않는다.
- [ ] 실행 중 기존 Goal/작업과 dirty 변경을 보존한다. 전역/상위/하위 지침의 충돌은 찾아 보고하되 전역 파일은 무단 수정하지 않는다.
- [ ] 새 범위를 저장소에 반영하고 기존 Goal·AGENTS의 제품 목표 참조를 수정한다. 과거 원문 이력은 보존한다. 미지정 새 요구사항을 추가하지 않는다.
- [ ] 현재 package scripts에 따라 typecheck/test/build 기준선을 기록한다. 과거 숫자를 복사해 통과로 보고하지 않는다. 운영 DB를 검사 fixture로 사용하지 않는다.
- [ ] F01~F11별 현재 상태와 필요한 변경만 짧게 기록하고 T1/T2로 진행한다. 안전한 구현을 다시 승인받기 위해 멈추지 않는다.

## T1. 승인 기준·결정·작업 결속

**Files:** 기존 기획/인계/Controller/Store 경로; `tests/project-baseline.test.ts`(동등 테스트가 없을 때).

**Input:** 승인 기획과 작업. **Output:** 불변 기준 참조 `{id, version, hash}`, 결정/이유, 변경 제안과 승인 기록. 기존 타입에 맞춰 이름을 매핑한다.

- [ ] 실패 테스트: `proposal_does_not_mutate_approved_baseline` — 제안 전후 승인 hash 동일. `stale_approval_rejected` — 새 버전 승인 뒤 이전 승인을 새 쓰기 실행에 사용하면 거절. `decision_reason_survives_handoff` — 인계에 승인 결정 ID/이유가 존재.
- [ ] 집중 테스트를 실행해 필요한 실패를 확인한다. 실행 기록·승인 경계·결정 인계의 최소 변경을 구현한다. 자유 입력 경로도 공통 승인 결속을 우회하지 못하게 한다.
- [ ] 같은 테스트와 기존 planning/handoff/controller 회귀를 통과시킨다. 기존 기획 ID·승인·해시·이력 보존을 확인한다.

## T2. 공통 진행 기록과 Codex 세로 흐름

**Files:** Store/Controller/HTTP/기존 이벤트, `web/project-progress.tsx` 또는 대응 화면, `tests/project-progress.test.ts`, `tests/project-progress-ui.test.ts`.

**Input:** T1 기준 참조, 기존 Task/Run/event/evidence. **Output:** 프로젝트·작업별 진행 snapshot과 마지막 이벤트 위치. 공급자 원문은 허용 필드만 투영.

- [ ] 실패 테스트: `model_done_is_not_verified` — 모델 종료 후 필수 증거 없으면 완료 false. `duplicate_event_counted_once` — 같은 수신 이벤트 반복으로 완료 수 증가 없음. `late_event_cannot_regress_final_state` — 과거 이벤트로 현재 상태를 덮지 않음.
- [ ] 실패 테스트: `stale_connection_is_visible` — 마지막 관측 시각과 확인 불가 표시. `new_baseline_marks_only_affected_checks_stale` — 영향 없는 증거는 유지. `get_progress_never_starts_run` — 조회의 실행 호출 수 0.
- [ ] 기존 Codex 실행 하나에 기준·작업·현재 단계·활동·완료 조건·대기 이유·결과 참조를 결속한다. 프로젝트 진행판을 요약/상세 형태로 구현한다.
- [ ] Codex 모의 이벤트의 HTTP/화면 연결, 새로고침 복구, 승인 대기를 검증한다. 허용된 테스트 프로젝트에서 live 관측을 별도 기록한다. 실제 Codex 연결이 없으면 모의와 live 상태를 분리한다.

## T3. 범용 프로젝트·입력·기획·간편/고급 연결

**Files:** projects/workspace/planning/shared 타입, 홈·프로젝트 화면, 기존 DB migration; `tests/project-general.test.ts`, 기존 planning UI/E2E.

**Input:** T1/T2 계약. **Output:** Git 선택적인 프로젝트, 작업 생성/승인/후속 작업, 동일 데이터의 모드 전환.

- [ ] 실패 테스트: `non_git_project_roundtrip` — Git 없는 프로젝트 저장/재조회/후속 작업 성공. `code_workspace_is_opt_in` — 비코드 작업에 worktree 요구 없음. `mode_switch_preserves_grants` — 모드 변경 전후 권한·기준·작업 ID 동일.
- [ ] 기존 데이터 복사본으로 추가형 migration·실패 복원 검사를 만든다. 원본 DB/WAL/SHM을 실행 중 단순 복사해 일관된 백업이라고 가정하지 않는다.
- [ ] 홈 입력→기획 AI 선택→명세 확인→저장→프로젝트 이동→실행 준비를 구현한다. 단순 작업의 불필요한 질문·다중 모델 호출은 줄인다.
- [ ] 테스트와 코드/비코드 프로젝트의 브라우저 흐름을 확인한다. 기존 등록 프로젝트·worktree·승인 기록이 보존되는지 검증한다.

## T4. Claude Code 실제 연결과 인계·검토

**Files:** 기존 runtime/provider 경계, T1 handoff, T2 이벤트; `tests/claude-runtime.test.ts`, `tests/runtime-handoff.test.ts` 또는 로컬 대응 테스트.

**Input:** 사용자 공식 인증 상태, 승인된 실행 범위, handoff. **Output:** Claude 실행/세션/중단/오류/관측 상태와 부모-자식 Run 관계.

- [ ] 실제 설치·버전·계정·지원 인터페이스를 확인한다. 구독 인증을 API 인증으로 전용하거나 과금 전환하지 않는다.
- [ ] 실패 테스트: `handoff_has_current_baseline_and_decisions`, `parent_child_run_has_single_owner`, `interrupt_request_not_exit_confirmation`, `unsupported_resume_becomes_handoff_not_fake_resume`.
- [ ] 검증된 네이티브 실행·위임을 어댑터로 연결한다. 관측 불가능한 자식 실행은 그 한계를 표시한다. Orbit과 플러그인이 같은 작업을 중복 실행하지 않게 한다.
- [ ] 승인된 테스트 프로젝트에서 실제 Claude 작업과 Codex↔Claude 인계/검토를 검증한다. fixture 통과와 live 통과를 따로 기록한다.

## T5. 기존 ChatGPT 웹 연결의 작업 결속

**Files:** 사용자의 기존 브라우저 연계 경로(T0에서 발견한 위치), 연결 어댑터, handoff/진행 기록; `tests/chatgpt-web-bridge.test.ts`.

**Input:** 허용된 기존 브라우저 세션·대상 대화, 요청 식별과 기준 참조. **Output:** 요청에 대응하는 응답·수집 상태·결과 참조·실패 이유.

- [ ] 기존 연결을 찾아 지원 조건·접근 권한·관측 가능 필드를 확인한다. 없으면 설치했다고 가정하지 말고 필요한 연결만 요청한다.
- [ ] 실패 테스트: `wrong_conversation_does_not_complete_task`, `late_reply_matches_original_request`, `timeout_after_submit_does_not_auto_resubmit`, `login_required_is_blocked_not_success`.
- [ ] 기존 방식을 재사용해 계획 요청과 답변을 특정 프로젝트/작업에 결속한다. 모델 선택을 확인할 수 없으면 unknown으로 남긴다. 쿠키·토큰 추출·인증 우회는 하지 않는다.
- [ ] 허용된 실제 대화에서 요청→응답→초안 등록을 확인한다. 답변이 승인본을 자동 덮지 않는지 확인한다. 수동 가져오기만으로 A06 통과를 기록하지 않는다.

## T6. 결과물·완료 조건·후속 수정

**Files:** 기존 artifact/visualization/verification/review 서비스와 프로젝트 UI; `tests/project-deliverables.test.ts` 및 기존 테스트.

**Input:** TaskSpec 산출물/완료 조건, 실제 파일과 검증 기록. **Output:** 결과물 버전·출처·검증·현재성, 다음 수정 작업.

- [ ] 실패 테스트: `missing_file_is_not_delivered`, `artifact_belongs_to_origin_run`, `changed_output_invalidates_affected_checks`, `untrusted_preview_is_sanitized`.
- [ ] 기존 파일 생성·검증·미리보기·export를 프로젝트 결과물에 연결한다. 코드/분석/문서/이미지는 지원하는 실제 도구 범위를 검사한다.
- [ ] 결과→검토→수정 작업이 기준과 관련 결과를 유지하도록 연결한다. 검증 실패를 ‘완료’로 포장하지 않는다.
- [ ] 실제 파일의 존재·열기·형식과 각 완료 조건을 확인한다. 미지원 도구는 미지원으로 표시하고 허위 파일 경로를 만들지 않는다.

## T7. 복구·사용량·도구 권한 통합

**Files:** 기존 recovery/instance/store/usage/extensions/capabilities; `tests/project-recovery.test.ts`, `tests/project-usage-tools.test.ts`.

**Input:** 실행 의도·세션·관측·권한·계정 상태. **Output:** 안전한 재개/인계, 격리, 출처 있는 quota와 검증된 도구 프로필.

- [ ] 실패 테스트: `restart_after_submit_quarantines_unknown_run`, `lost_run_blocks_conflicting_writer`, `read_does_not_retry`, `provider_switch_preserves_budget_and_scope`.
- [ ] 실패 테스트: `unknown_quota_stays_null`, `shared_quota_not_double_counted`, `tool_installation_not_execution_grant`, `secret_output_is_not_persisted`.
- [ ] 기존 서비스의 격리·잠금·검사를 공통 실행 경로에 연결한다. 실행 중단/재개 가능 여부를 capability 근거와 함께 표시한다.
- [ ] 복구 fault injection과 한도 대기/미관측/도구 차단을 검증한다. 앱 종료 후 자동 계속 또는 정확히 한 번 실행을 보장한다고 말하지 않는다.

## T8. 회귀·세 연동·종단간 출시 게이트

**Files:** 기존 E2E runner/fixture, 실제 실행 증거 위치, `docs/ORBIT-STATUS.md`와 기존 결과 기록.

**Input:** F01~F11 구현과 증거. **Output:** A01~A16 판정과 사용자가 실제 시작할 경로.

- [ ] 코드 작업 하나와 Git 없는 분석/문서 작업 하나의 종단간 시나리오를 실행한다. 각 시나리오에 승인·실행·진행판·결과·검증·후속 요청을 포함한다.
- [ ] 세 도구 live 결과, AI 간 인계, 기준 변경, 한도/승인 대기, 끊김·재시작·중복 방지를 확인한다. 외부 자격증명이 없는 부분은 차단 사유를 남긴다.
- [ ] 현재 로컬의 전체 typecheck/test/build와 브라우저 회귀를 실행한다. skip/실패/모의/live를 분리한다. OS별 미검증을 통과로 일반화하지 않는다.
- [ ] F/A 요구사항별 근거를 대조한다. 필수 항목에 미검증/차단이 남으면 전체 완료로 선언하지 않는다.
- [ ] 최종 branch/HEAD·변경·검사·결과·남은 차단·정확한 사용 절차를 보고한다. 예산·권한에 막히면 안전한 재개 지점을 저장한다.

## 개발 현황 기록 형식

`docs/ORBIT-STATUS.md`의 각 F 항목에 다음 열을 사용한다.

`요구사항 ID | 구현 상태 | 단위/통합 | 브라우저 | 실연동 | 관련 A 항목 | 증거 참조/시각 | 차단 이유 | 다음 행동`

초기 상태는 로컬 검사 전까지 ‘미확인’이다. 이 계획에 체크박스가 있다는 이유로 진행률이나 완료도를 미리 계산하지 않는다.
