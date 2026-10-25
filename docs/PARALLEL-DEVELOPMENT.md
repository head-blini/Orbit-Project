# Orbit 병렬 개발 준비

작성일: 2026-10-25. 상태: 보안 기준점과 작업 공간 준비. 아래 기능은 **계획이며 미구현**이다. 작업 그룹의 구현 에이전트/서버는 시작하지 않는다. 자동 병합·Push·외부 API 과금은 승인 전 금지한다.

## 기준과 작업 공간

기존 `phase1/codex-web-slice`와 Phase 0/1/2-A 이력을 보존한다. 이 문서와 환경변수 격리 수정을 함께 담은 로컬 커밋을 기준점으로 사용하며, 최종 보고의 전체 SHA로 고정한다. 모든 그룹은 그 SHA에서 분기한다. 원격 기준은 아직 `030f07a`이며 이번 커밋은 Push하지 않는다.

`using-git-worktrees` 절차에 따라 `.worktrees/`를 Git에서 제외한 기준 커밋을 먼저 만들고 다음 worktree를 생성한다. 기존 이름/경로가 있으면 재사용하거나 덮어쓰지 않고 상태를 확인한다.

| 그룹 | 브랜치 | 저장소 루트 기준 경로 | 역할 |
|---|---|---|---|
| 통합 담당 | `phase1/codex-web-slice` 유지 | 현재 체크아웃 | 공통 계약, HTTP/Controller/DB 연결, 최종 검증 |
| Planning | `parallel/planning` | `.worktrees/planning` | 수동 기획·import·검증·미리보기·Task 초안의 독립 모듈 |
| Visualization | `parallel/visualization` | `.worktrees/visualization` | 기존 실행/이벤트/변경 파일을 표시하는 읽기 전용 뷰 |
| Provider/Guardrail | `parallel/provider-guardrail` | `.worktrees/provider-guardrail` | Codex 상태/능력 계약, 실행 전 정책 검사와 거절 증거 |

worktree는 서로 다른 디렉터리·인덱스·브랜치를 사용하지만 Git object/config는 공유한다. 다른 그룹의 경로·공용 Git 설정·refs를 수정하지 않는다. 같은 브랜치 checkout, reset/clean/force, 자동 병합/정리 금지. 별도 worktree는 OS 보안 경계가 아니므로 파일 소유권 위반을 리뷰에서 차단한다.

## 파일 소유권

| 소유자 | 쓰기 가능한 파일 | 읽기만 가능한 의존성 |
|---|---|---|
| Planning | `server/planning/**`, `web/planning/**`, `tests/planning.test.ts`, `tests/fixtures/planning/**`, `docs/planning/**` | `shared/**`, 기존 Phase 0 planning fixture/설계 |
| Visualization | `web/visualization/**`, `tests/visualization.test.ts`, `tests/fixtures/visualization/**`, `docs/visualization/**` | `shared/**`, 기존 Snapshot/AppEvent/WorkspaceDiff |
| Provider/Guardrail | `server/providers/**`, `server/guardrails/**`, `tests/provider-guardrail.test.ts`, `tests/fixtures/provider-guardrail/**`, `docs/provider-guardrail/**` | `shared/**`, 기존 Rpc/Codex/Projects 정책 |
| 통합 담당 전용 | **모든 `shared/**`**, `server/controller.ts`, `server/http.ts`, `server/store.ts`, `server/main.ts`, `server/rpc.ts`, `server/child-env.ts`, `server/codex.ts`, `server/projects.ts`, 기존 보안/공통 파일·테스트, `web/main.tsx`, `web/workspaces.tsx`, `web/style.css`, `package*.json`, `tsconfig.json`, `scripts/**`, `.gitignore`, 루트 문서와 본 문서 | 각 그룹 산출물 |

목록 밖 파일은 임의 수정하지 않는다. 공통 수정이 필요하면 그룹 소유 문서에 변경 이유·계약 diff·실패 테스트를 제안하고 통합 담당이 적용한다. 각 그룹 CSS는 그룹 폴더의 별도 파일/클래스 접두사를 사용한다. 패키지 추가와 lockfile 변경도 통합 담당만 수행한다.

현재 npm test는 `tests/*.test.ts`만 검색하므로 그룹 실행 진입 테스트는 표의 최상위 파일에 둔다. fixture는 인증정보 없는 합성 데이터만 사용한다. 별도 worktree에 기존 node_modules, DB, WAL/SHM, .env, .local, 인증 파일을 복사/링크하지 않는다. 준비 단계는 checkout만 수행한다. 실제 착수 시 각 worktree에서 `npm.cmd ci`로 잠금 파일 기준 의존성을 설치하고 `npm.cmd run verify`를 통과시킨다.

## 공통 인터페이스 v1 — 통합 담당이 먼저 고정할 계약

아래는 제안된 계약이며 이번 기준 커밋에 제품 코드로 추가하지 않는다. 착수 전에 통합 담당이 `shared/parallel.ts`와 `tests/parallel-contracts.test.ts`를 단일 커밋으로 제공한다. 그룹이 독자적인 동명 타입을 만들거나 기존 타입을 바꾸지 않는다. 이 공통 계약 커밋을 각 그룹에 적용하는 작업도 통합 승인 뒤 진행한다.

기존 `shared/types.ts`의 `Snapshot`, `Run`, `AppEvent`, `WorkspaceDiff`는 그대로 사용한다. `Run.verification = 'not_run'`을 완료·성공으로 바꾸지 않는다. 이벤트는 현재 `seq/kind/at/runId/data` 구조를 유지하고 namespace를 `planning.*`, `provider.*`, `guardrail.*`로 예약한다. 원문 환경변수·계정 응답·도구 로그는 payload에 포함하지 않는다.

```ts
// shared/parallel.ts 예정 계약 (아직 미구현)
type PlanningSource = 'manual' | 'import';
interface PlanningDraft {
  schemaVersion: '1.0'; title: string; goal: string;
  requirements: {label: string; description: string; acceptanceCriteria: string[]}[];
  constraints: string[]; openQuestions: string[];
  source: PlanningSource;
}
type PlanningParseResult =
  | {ok: true; draft: PlanningDraft}
  | {ok: false; issues: {field: string; code: string}[]};
interface TaskDraft {
  title: string; description: string; acceptanceCriteria: string[];
  planningVersionId: string; requirementLabels: string[];
}
interface PlanningVersion {
  id: string; projectId: string; revision: number; contentHash: string;
  state: 'draft' | 'approved' | 'superseded'; draft: PlanningDraft;
}
interface TimelineView {
  lastSeq: number;
  items: {seq: number; at: string; runId: string | null; kind: string; label: string}[];
}
interface ProviderDescriptor {
  id: 'codex';
  status: 'ready' | 'auth_required' | 'not_installed' | 'unsupported' | 'error';
  capabilities: {patch: boolean; shell: false; approvals: 'deny'; mcp: 'disabled'};
}
interface LaunchContext {
  provider: ProviderDescriptor; expectedWorkspaceId: string | null;
  selectedWorkspaceId: string | null; workspaceValidated: boolean;
  writeEnabled: boolean; policyValidated: boolean; mcpIsolated: boolean;
}
type GuardrailDecision = {allowed: true} | {allowed: false; code: string};
```

- Planning exports `parsePlanningDraft(input: {format:'markdown'|'json'; text:string; source:PlanningSource}): PlanningParseResult` and `toTaskDrafts(version: PlanningVersion): TaskDraft[]`. Only an **approved** version can produce task drafts; this never starts a run. Server-generated ID/hash/revision/state cannot come from imported content. A pure parser cannot approve a document. Markdown is inert text, no raw HTML execution, scripts, URL fetch or embedded commands. Input cap 256 KiB UTF-8; unsupported schema versions fail explicitly. Canonical v1 follows `07-PROVIDER-NEUTRAL-CORE.md`; older 0.2 bridge examples need explicit mapping, not silent acceptance.
- Visualization exports `buildTimeline(snapshot: Readonly<Snapshot>, events: readonly AppEvent[]): TimelineView` and a `RunTimeline` React component taking that view. Workspace identity changes reset the view, duplicate sequence numbers do not duplicate rows, gaps request authoritative reload through a callback owned by integration. Unknown event kinds get a neutral label. No inference that completed means verified, no raw HTML/SQL/file access, no extra provider calls.
- Provider/Guardrail exports `evaluateLaunch(context: Readonly<LaunchContext>): GuardrailDecision`. Workspace mismatch, unvalidated path/policy/MCP or missing write gate denies. This is only a preflight decision: **it never grants an RPC approval**. The existing Controller, exact sandbox check and `denyRequest` remain authoritative. Probe adapters return sanitized descriptors; `ready` must have observed evidence. No new Claude/Gemini/cloud adapters or credential handling.
- 통합 담당은 서버에서 입력을 검증하고 project/workspace/version ID를 결합한다. HTTP route, CSRF, SQLite migration, optimistic revision check, SSE 영속화는 그룹이 직접 구현하지 않는다. 새 migration은 메모리/임시 DB에서만 검증하고 기존 DB에 적용하지 않는다.

## 착수 순서와 인수 기준

1. **현재 단계:** 환경변수 보안 수정 → 실제 회귀 실패/성공 → 전체 검증 → 로컬 기준 커밋 → 깨끗한 그룹 worktree 준비. 제품 기능 착수는 별도 지시를 기다린다.
2. **통합 계약 단계:** 위 타입과 런타임 검증/합성 fixture를 확정한다. `LaunchContext`의 값은 브라우저가 제공하지 않고 기존 서버 검사 결과로만 채운다. 승인/ID/버전의 권한은 서버에 둔다.
3. **독립 작업 단계:** Planning은 parser/미리보기/Task 초안만, Visualization은 fixture 기반 뷰만, Provider/Guardrail은 합성 probe/순수 정책 검사만 구현한다. 그룹별 범위를 승인받기 전 실행·배포 기능을 확장하지 않는다.
4. **검토 단계:** 그룹별 base SHA/head SHA, 변경 파일, 실행한 명령과 종료 코드, 실제 실행/단위 테스트/실패/미검증을 분리한 보고서를 제출한다. 통합 담당이 `git diff --name-only BASE..GROUP_HEAD`로 소유권 위반을 검사한다. 충돌을 강제 해결하지 않는다.
5. **통합 단계:** 승인된 변경만 통합 담당이 순차 적용한다. 자동 병합 금지. 전체 타입 검사·테스트·빌드 및 임시 저장소 브라우저 확인 후 별도 승인된 Push만 수행한다.

필수 회귀: 악성 Markdown/과대 입력/미승인 task 변환 거절, 이벤트 중복/역순/누락/작업 공간 변경, 준비되지 않은 provider/알 수 없는 정책/추가 쓰기 루트/MCP 미확인/승인 요청 기본 거절. 기존 TRANSPORT_CLOSED·재시도 중복 방지·worktree 원본 main 보존·민감 Diff 제외도 계속 통과해야 한다.

각 worktree 서버가 필요해지면 자체 `.local`과 서로 다른 loopback 포트를 사용한다. 현재 실행 서버의 DB나 원래 사용자 프로젝트를 등록하지 않는다. 실제 코드 쓰기 검증은 별도의 임시 Git 저장소만 사용하며 기본 쓰기 허용 목록은 비어 있다. 자격증명 복사·설정 수정·MCP 격리 완화·API 과금 전환은 금지한다.

## 보안 기준점 검증 기록

- RED: 기존 Rpc에서 합성 비밀/실행 옵션 17개가 실제 자식에게 전달되어 회귀 테스트 실패, exit 1. 값 대신 변수 이름만 보고했다.
- GREEN: 새 환경변수 회귀 5개와 기존 RPC 3개, 총 8/8 성공, exit 0.
- 전체: TypeScript 검사, 자동 테스트 **56/56**, 빌드 성공, exit 0. 기존 MCP/승인/Worktree/TRANSPORT_CLOSED 회귀 포함. 실제 임시 Git worktree 생성·Diff·원본 보존은 자동 통합 테스트에서 확인했다.
- Native: `node scripts/verify-auth-environment.mjs`에서 initialize와 기존 ChatGPT 인증 인식 성공, exit 0. 추론과 토큰 갱신을 요청하지 않았다. 검증 스크립트는 인증 파일을 직접 읽거나 내용을 출력하지 않으며, native Codex가 기존 인증을 정상 탐색한다.
- Native: `node scripts/verify-mcp-isolation.mjs` 및 `--coding` 모두 exit 0. 각각 임시 CODEX_HOME에서 preflight 무기동, disabled 무기동, enabled 양성 대조 기동을 확인했다. 실제 사용자 MCP 설정은 수정하지 않았다.
- 미검증: 이번 환경 변경 뒤 모델의 실제 코드 수정/브라우저 E2E/추론 후 재개는 재실행하지 않았다. no-turn MCP probe의 resume은 검증되지 않는다. 프록시/custom CA, 다른 OS/CLI 버전, 악의적 동일 OS 사용자/동시 파일 교체에 대한 완전한 방어도 미검증이다.
- 범위 한계: 이번 allowlist는 `Rpc` 자식 환경에 적용한다. 다른 프로세스 생성 경로(예: Git)의 환경 최소화는 별도 검토 대상이며, 모든 하위 프로세스의 비밀 격리를 완료했다고 주장하지 않는다.
- 기존 `.local` DB/WAL/SHM의 검증 전후 SHA-256이 일치했다. 인증 파일과 사용자 설정은 직접 읽거나 수정하지 않았다.
- 독립 읽기 전용 리뷰: Critical/Important 없음, 기준 커밋 준비 가능. 리뷰어가 RPC/환경 테스트 8/8을 별도로 재실행했다. Native 결과는 구현자의 실행 증거이며 리뷰어가 재실행하지 않았다.
- 경미한 후속 항목: auth probe의 `orbit-auth-env-*` 임시 디렉터리가 보존되어 반복 실행 시 누적된다. 정리 기능은 추가하지 않았다. 빈 `HOME`/`CODEX_HOME`의 직접 회귀 사례는 추가되지 않았으며, 현재 테스트는 빈 locale 보존과 누락/undefined 인증 위치를 다룬다. 다른 OS/프록시/파일 시스템 격리와 미래 그룹 기능은 완료로 간주하지 않는다.

보안 수정과 계획 문서 외 그룹 제품 기능은 미구현이다. 기준 커밋 SHA와 실제 생성된 worktree 상태는 최종 작업 보고에서 확인한다.
