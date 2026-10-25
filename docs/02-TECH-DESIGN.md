# Technical Design — AI Coding Control Center v0.3

> 본 문서는 **권장 설계안**이며 구현/실기기 테스트를 수행한 결과가 아니다. CLI가 설치된 개발 머신에서 API·권한·세션 기능을 POC로 확인한 다음 확정한다.

## 1. 아키텍처 선택
- 프런트엔드: **React + TypeScript + Vite**, UI 컴포넌트와 데이터 패칭은 안정적인 기존 라이브러리 사용.
- 백엔드: **Node.js 22+ + TypeScript + Fastify** (후보, POC 후 변경 가능). 단일 로컬 프로세스가 API, 이벤트, Agent runner를 제공.
- 통신: REST(작업/설정 변경) + **SSE**(작업 이벤트 스트리밍 및 Last-Event-ID로 재연결). 인터랙티브 터미널이 필요한 경우 별도 WebSocket/PTY 채널.
- 저장: **SQLite WAL**(구조화된 상태/감사 기록) + 앱 데이터 디렉터리 파일(검증 로그·그래프 아티팩트). 외부 DB 불필요.
- 실행: **Provider Registry**에 등록된 공식 CLI/허용된 실행기를 OS 자식 프로세스 또는 공식 로컬 RPC로 제어. V1 Claude Code·Codex(각자 선택적), P1 Gemini CLI·OpenCode/로컬 모델 검토. 인증은 각 공급자의 공식 로그인/키 관리에 위임.
- Git: 로컬 Git 명령(`spawn`, shell=false) + `git worktree` + Git SHA 기준 불변 스냅샷.
- 그래프: **Graphify CLI**로 JSON/HTML/보고서 생성(2차). 인덱스 결과에는 분석 시점 HEAD SHA·도구 버전·schema_version 기록.
- 모델/도구 추가: ProviderAdapter만 확장. 새 모델은 서버가 미리 하드코딩하지 않고 공식 목록·명령 진단 사용.

## 2. 책임 경계
```text
React Web
  ├── **Ideas & Planning (in-app manual/AI planner, external import, versions, approve, feedback)**
  ├── Project selector / Task board / Command center
  ├── Live run timeline / Approvals / File diff / Checks
  └── Usage / Graph / Extensions
           │ authenticated loopback HTTP + SSE
           ▼
Local Server
  ├── **Planning Service: manual/AI/external artifact → validate → version → approve → tasks → feedback**
  ├── Task Service: intent → plan → execution → evidence → verdict
  ├── Run Service: queues, process supervision, cancellation, recovery
  ├── Provider Registry + Adapters (capability-aware; exactly one ready provider sufficient)
  │      ├── ClaudeAdapter: claude CLI stream-json / resume / approval bridge
  │      ├── CodexAdapter: app-server stdio JSON-RPC, CLI fallback
  │      ├── GeminiAdapter: Gemini CLI JSONL (P1)
  │      └── OpenCodeAdapter / local runner (P1, interface POC)
  ├── Workspace Manager: root allowlist, status, branch/worktree lifecycle
  ├── Verification Runner: configured commands, exit code, artifacts
  ├── Review Handoff: immutable base/head SHA, read-only scope
  ├── Usage Collector: upstream current quota / CLI statusline
  ├── Graph Indexer: Graphify subprocess and metadata
  ├── Extension Inventory & Config Transaction manager
  └── Policy & Approval Gateway
           │
           ├── SQLite: state and append-only event ledger
           └── Data dir: logs / reports / graphs / snapshots
```

## 3. 프로바이더별 통합 방식
### 3.1 Claude Code — 권장 로컬 경로
- 사용자가 **공식 `claude auth login`**으로 Claude Code 바이너리에 직접 로그인. 관제센터는 OAuth 코드나 토큰을 받지 않는다.
- 읽기 전용 계획/검토 또는 허용된 작업은 `claude -p ... --output-format stream-json`으로 시작하고 JSONL 이벤트를 파싱한다.
- 이미 시작한 세션은 Claude 문서의 `--resume`으로 재개하며, 무조건 같은 CLI TUI와 동일한 실시간 대화 공유를 주장하지 않는다.
- **승인 처리:** 비대화형 CLI에서 미승인 요청은 거절될 수 있다. V1은 먼저 plan/read-only + 작업별 `acceptEdits` 등 명시적 권한 프로필을 제공하고, 명령 승인은 CLI의 문서화된 `--permission-prompt-tool`을 통해 로컬 MCP 승인 브리지로 연결하는 방향을 검증한다. 이 기능이 성숙하기 전에는 PTY 터미널로 전환시키고 자동 승인을 금지한다.
- `bypassPermissions`, `--dangerously-skip-permissions`는 기본적으로 금지. 승인 대기/거절을 추적할 수 없으면 안전한 중단 상태로 처리.
- `claude -p` JSON의 `total_cost_usd`는 **클라이언트 추정치**이므로 구독 청구액으로 표시하지 않는다.
- 참고: https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/cli-reference , https://code.claude.com/docs/en/legal-and-compliance

### 3.2 Codex — 권장 로컬 경로
- Codex는 **ChatGPT 계정 로그인 또는 OpenAI API 키 기반 로그인**을 공식 지원한다. ChatGPT 구독은 필수가 아니지만 API 키 사용 시 별도 종량 과금. Codex 자체도 선택적 제공자이다. 실제 인증 성공/기능 차이 확인.
- 관제 UI에는 **Codex App Server의 기본 stdio 프로토콜**을 우선 사용한다. `initialize` → `initialized` → `thread/start` 또는 `thread/resume` → `turn/start` → 이벤트 구독 → `turn/completed`/`turn/interrupt` 흐름.
- 브라우저는 App Server에 직접 접속하지 않고 로컬 서버가 JSON-RPC 이벤트를 정규화해 전달한다. 실험적인 원격 WebSocket 리스너는 V1에서 사용하지 않는다.
- App Server와 CLI 버전의 프로토콜 변화에 대비해 **서버 시작 시 TS/JSON 스키마와 지원 기능을 판별**하고, 이벤트/승인 기능에 대한 계약 테스트를 만든다.
- 기본 App Server 연결에 문제가 있을 때 단발성 `codex exec`를 대체 경로로 고려하되, 실시간 승인/사용량/세션 기능의 동등성을 전제하지 않는다.
- **`codex mcp-server`를 에이전트 제어 인터페이스로 사용하지 않는다.** 최신 문서에서 제거된 기능. Codex 자체에 연결하는 외부 MCP 서버와는 별개.
- 참고: https://learn.chatgpt.com/docs/app-server , https://developers.openai.com/blog/codex-as-a-platform , https://developers.openai.com/ko-KR/docs/mcp-server

### 3.3 제공자 중립 Planning Service — V1 필수
- **기획 소스 3개 동등 지원:** (A) 관제센터 내 수동 PRD 편집 (B) 연결된 에이전트의 `planning` 모드로 기획 생성 (C) 외부 ChatGPT/Claude/Gemini 웹 또는 기타 도구의 Markdown/JSON/본문 가져오기.
- 내부 AI 기획은 실제로 연결된 코딩 에이전트의 안전한 읽기 전용 모드/도구로 실행한다. 별도 제공자 로그인이나 API 호출을 자동 만들지 않는다. AI 생성물도 **초안**이며 사용자 승인 전 Task 실행 금지.
- 사용자별 역할 설정 `planning_provider_id` / `coding_provider_id` / `review_provider_id`는 선택사항. 리뷰 제공자가 없으면 별도 새 격리 세션·사람 검토·명시적 스킵 정책 중 선택; 리뷰 출처 `cross_provider|same_provider_new_session|human|skipped` 보존.
- 모든 소스가 같은 **표준 기획 스키마**(목표·범위·제약·결정·요구사항·완료 기준·참고 링크)를 거친다. 출처 이름이 실행 정책을 바꾸지 않는다.
- 개발 중 발견한 질문, diff/test/review 근거를 묶은 `planning-feedback.md`를 **일반 Markdown으로 내보내고**, 수정본을 버전 비교·사용자 승인 후 선택한 Task에 적용.
- **ChatGPT 웹 통합은 선택적 플래너 커넥터**다. 사용자가 원할 때 ChatGPT 열기·프롬프트 복사·Markdown/JSON import/export를 제공하며 계정·대화·기억은 자동 크롤링하지 않음. 다른 외부 기획 도구에도 같은 링크/복사/파일 경로 제공.
- 추가 opt-in 직접 연결은 각 서비스가 지원하는 공식 연동/API를 따르며, 외부 클라우드에서 로컬 `127.0.0.1`로 바로 접속할 수 있다고 가정하지 않는다. HTTPS 중계는 최소 권한·강한 인증·명시적 승인·기본 OFF.

### 3.4 추가 에이전트 — V1 계약 검사, V2 실제 지원 여부 결정
- **Gemini CLI:** 공식 문서에 Google 계정 로그인과 API 키 인증, headless JSON/stream-json 이벤트가 명시돼 있어 제3 ProviderAdapter 후보로 현실적이다. 설치·정책·권한·세션·사용량의 정확한 지원 수준은 실제 머신에서 POC한다. https://geminicli.com/docs/get-started/authentication/ , https://geminicli.com/docs/cli/headless/
- **OpenCode / local model:** 공식 문서에 여러 모델 제공자와 로컬 모델 연결이 안내되어 있다. 다만 일부 타사 구독 자격증명 재사용은 제공자가 금지하므로 우회 플러그인을 사용하지 않는다. 구체적인 제어 API/권한/사용량 기능은 POC 후 지원 등급을 지정한다. https://docs.opencode.ai/docs/providers/
- 지원 마케팅 문구보다 실제로 테스트한 capability를 우선한다. `not_installed`, `auth_required`, `ready`, `error`, `unsupported`를 구분한다.

### 3.5 공통 ProviderAdapter 계약 (개념)
```ts
type ProviderId = string; // registry key; 'claude_code', 'codex', 'gemini_cli', ...
type Role = 'planning' | 'coding' | 'review';
type Availability = 'ready' | 'not_installed' | 'auth_required' | 'error' | 'unsupported';
type Capability = 'planning' | 'chat' | 'resume' | 'stream' | 'interrupt' |
  'interactive_approvals' | 'read_only_mode' | 'usage_quota' | 'usage_tokens' |
  'model_catalog' | 'mcp_inventory' | 'skills_inventory';
interface ProviderAdapter {
  id: ProviderId;
  probe(): Promise<{ status: Availability; version?: string; capabilities: Capability[]; issues?: string[] }>;
  listModels?(): Promise<Array<{ id: string; available?: boolean }>>;
  start(request: { role: Role; projectRoot: string; worktreePath?: string; prompt: string; policy: string }): Promise<{ sessionId: string; runId: string }>;
  resume?(sessionId: string, prompt: string): Promise<{ runId: string }>;
  interrupt?(runId: string): Promise<void>;
  subscribe?(runId: string): AsyncIterable<AgentEvent>;
  getUsage?(): Promise<UsageSnapshot>;
}
```
- 필수 계약은 `probe`와 `start`이며, 기능은 런타임에 광고한 capability와 **계약 테스트 통과 결과**에 맞춰 활성화한다. 사용 불가 기능을 가짜 이벤트로 채우지 않음.
- 최초 사용자는 **0개 provider라도 앱을 열어 기획 편집/프로젝트 조회**, 1개 `ready` provider면 계획→실행→검증, 2개 이상이면 가능한 범위의 교차 협업을 수행.
- 모델 내부 대화 상태는 서로 이전 불가. 인계 시 승인된 PRD 버전 + 코드 SHA + diff + 테스트 증거 + 결정 사항 + 미해결 질문만 전달.

## 4. Task 상태와 Run 상태를 분리
### Task (업무 수준)
`DRAFT → READY → QUEUED → IMPLEMENTING → VERIFYING → REVIEWING → WAITING_USER → DONE`
보조 상태: `BLOCKED`, `FAILED`, `CANCELLED`; 재시도는 기존 Task 아래에 **새 Run**을 생성한다.
- `DONE` 전제: 요구사항별 완료 조건, 필수 검증, 승인 정책의 증거 충족.
- 에이전트 응답만으로 `DONE` 전이 불가.
- `REVIEWING`에서 검증된 문제 발생 → `IMPLEMENTING`으로 돌아가되, 새 Run ID와 리뷰 기준 SHA 유지.

### Run (개별 실행 수준)
`CREATED → STARTING → RUNNING ↔ AWAITING_APPROVAL → (SUCCEEDED | FAILED | INTERRUPTED | LOST)`
- 서버 종료 후 죽은 실행을 '성공'으로 변경하지 않고 `LOST`로 조정; 자식 프로세스 생존은 검증 후 `RUNNING` 복원.
- `SUCCEEDED`는 CLI 실행 성공이지 업무 완료가 아님.
- 사용자 취소에 따른 인터럽트와 프로세스 강제 종료를 구분 기록.

## 5. 이벤트 프로토콜 (정규화)
```json
{
  "event_id": "evt_...",
  "seq": 105,
  "project_id": "prj_...",
  "task_id": "tsk_...",
  "run_id": "run_...",
  "provider": "codex",
  "kind": "command.finished",
  "ts": "2026-10-25T13:00:00+09:00",
  "payload": {"command_display": "npm test", "exit_code": 0},
  "source": {"protocol": "codex_app_server", "original_type": "item/completed"}
}
```
- `seq`는 DB가 발급하는 순서값이며, 재연결 시 `Last-Event-ID`로 누락분을 보낸다.
- 공통 이벤트 종류: `run.started`, `message.delta`, `tool.started`, `tool.completed`, `command.finished`, `file.changed`, `approval.requested`, `approval.resolved`, `run.interrupted`, `run.finished`, `check.finished`, `graph.indexed`, `usage.updated`.
- 원본 이벤트는 파일에 저장 가능하되 인증·비밀정보 필터링 후 최소 보존; 브라우저에는 정규화·필터링한 이벤트만 전달.
- 모델의 자연어 진행 설명은 `message.delta`로, 실제 실행 근거는 별개 이벤트/증거로 취급.

## 6. 데이터 모델 (SQLite: 최소 집합)
**기획 데이터와 코드 실행 데이터는 구분**하되, Task가 승인된 기획 버전과 요구사항을 참조하게 한다. 소스 URL은 원본을 확인하기 위한 메타데이터일 뿐 자동 접근·인증 경로가 아니다.

| 테이블 | 최소 컬럼과 책임 |
|---|---|
| `planning_sources` | id, project_id, kind(`in_app_manual`/`in_app_agent`/`external_web`/`file`), source_label?, provider_id?, external_url?, title?, imported_at, raw_artifact_uri, content_hash, imported_by |
| `provider_installations` | id, provider_id, local_binary_version?, auth_status, probed_at, capabilities_json, last_error?, enabled |
| `project_roles` | id, project_id, role(`planning`/`coding`/`review`), provider_id?, mode, fallback_policy_json |
| `planning_versions` | id, project_id, source_id, version_number, state(`DRAFT/REVIEW_REQUIRED/APPROVED/SUPERSEDED`), normalized_artifact_uri, approved_at?, supersedes_version_id?, created_at |
| `planning_requirements` | id, planning_version_id, external_label?, title, description, acceptance_md, constraints_md, priority, decision_status |
| `planning_feedback` | id, project_id, from_task_id?, based_on_version_id, document_uri, created_at, exported_at?, feedback_digest |
| `task_plan_links` | task_id, planning_version_id, planning_requirement_id?, copied_snapshot_sha256, created_at |
| `projects` | id, name, canonical_root, git_remote?, default_branch, settings_json, created_at |
| `tasks` | id, project_id, title, brief_md, acceptance_md, priority, state, created_at, updated_at |
| `task_dependencies` | task_id, depends_on_task_id, relation |
| `agent_sessions` | id, project_id, provider, provider_session_id, workspace_id, last_event_seq |
| `runs` | id, task_id, agent_session_id, provider, model?, status, base_sha, head_sha, started_at, ended_at, exit_code, failure_reason |
| `events` | seq, event_id, task_id, run_id, provider, event_type, payload_json, source_ts, recorded_at |
| `approvals` | id, task_id, run_id, kind, request_json, decision, decided_at, target_digest, expires_at? |
| `workspaces` | id, project_id, path, branch, based_on_sha, owner_task_id, lifecycle_status |
| `checks` | id, task_id, run_id, workspace_id, command_id, executed_sha, exit_code, verdict, artifact_uri, started_at, ended_at |
| `reviews` | id, task_id, provider?, origin(`cross_provider`/`same_provider_new_session`/`human`/`skipped`), base_sha, head_sha, findings_json, completed_at |
| `usage_snapshots` | id, provider, metric_type, value, unit, window_name?, reset_at?, collected_at, provenance, quality |
| `graph_indexes` | id, project_id, analyzed_sha, graphify_version, schema_version, artifact_uri, created_at, status |
| `extension_inventory` | id, provider, scope, name, kind, version?, config_path, status, verified_at |
| `config_snapshots` | id, config_path, sha256_before, sha256_after?, backup_uri, approved_by, changed_at |
| `decisions` | id, task_id, text, rationale, evidence_uri?, created_at |
| `handoffs` | id, task_id, from_provider, to_provider, frozen_sha, brief_uri, receiving_run_id?, created_at |

보관 정책: 실행 로그 보존량을 기본 제한하고, 인증 토큰·.env·사용자 홈 전반은 기본 수집 금지. 삭제는 사용자 통제.

## 7. API 초안 (localhost-only; 변경 가능)
```text
GET    /api/health
GET    /api/capabilities
GET    /api/providers                         # installed/ready/auth_required/capabilities
PUT    /api/projects/:id/roles              # planning/coding/review choices; validate available capabilities
GET    /api/projects
GET    /api/projects/:id/plans                 # 최신 승인 기획안/전체 버전
POST   /api/projects/:id/plans/import          # neutral Markdown/JSON/paste → 미리보기/검증
POST   /api/projects/:id/plans/draft           # 내장 수동 에디터 → 동일 표준 스키마
POST   /api/projects/:id/plans/agent-draft     # configured provider planning-only, approval required
GET    /api/projects/:id/plans/:versionId/diff # 이전 버전 대비 차이/영향 작업
POST   /api/projects/:id/plans/:versionId/approve  # 사용자 승인 + 감사 기록
POST   /api/projects/:id/plans/:versionId/promote  # 승인 버전 → Task 초안 생성
POST   /api/projects/:id/planning-feedback     # 구현 근거 기반 Markdown 생성
POST   /api/projects                  # 루트 검증/등록
GET    /api/projects/:id/tasks
POST   /api/projects/:id/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/runs            # provider, worktree, permission policy, prompt
GET    /api/tasks/:id/events          # SSE + resume cursor
POST   /api/runs/:id/interrupt
POST   /api/approvals/:id/decision    # approve/reject + policy digest
GET    /api/tasks/:id/diff
POST   /api/tasks/:id/checks          # 사전 설정된 명령 ID만 허용
POST   /api/tasks/:id/reviews         # immutable base/head SHA; provider review optional
POST   /api/tasks/:id/handoff
GET    /api/usage
GET    /api/extensions
GET    /api/projects/:id/graph
POST   /api/projects/:id/graph/reindex  # V2
```
- 쓰기 엔드포인트는 CSRF 보호와 UI 세션/loopback 제약. path 및 command를 클라이언트가 임의 문자열로 실행하게 하지 않는다.
- API idempotency key(명령 시작/승인/병합), optimistic concurrency version으로 중복 클릭과 브라우저 재시도를 방지한다.
- 무기한 자동 워커보다 작업/재시도 한도와 실행 제한 시간을 명시한다.

## 8. 검증/리뷰 워크플로
1. 작업 시작 시 base SHA·기존 dirty 상태를 캡처. dirty 상태면 기본값은 새 worktree 또는 사용자 선택.
2. 파일 변경 후 Git diff의 변경 파일과 해시를 기록. 커밋 없이도 임시 스냅샷을 생성할 수 있으나 리뷰 기준 SHA 고정이 더 안전하다.
3. 빌드·테스트·린트 명령은 프로젝트 등록 시 저장하고 사용자 검토 후 실행. 결과는 stdout/stderr/exit code/실행 시간/commit SHA로 남긴다.
4. 리뷰 담당에는 같은 SHA의 **읽기 전용 worktree** 제공. 리뷰 중 파일 수정 명령 금지.
5. 결과에 `confirmed`, `needs_reproduction`, `false_positive`, `resolved` 등 분류.
6. 수정 후 테스트 재실행. 기존 리뷰의 기준 SHA가 바뀌면 '과거 리뷰'임을 명시.
7. 사용자에게 최종 Diff·테스트·리뷰·승인 이력을 보여주고 병합. 병합 후 필요 시 통합 테스트 재실행.

## 9. 사용량/비용의 의미
| 공급자 | 입력 데이터 | 표시 원칙 |
|---|---|---|
| Claude | 공식 statusLine JSON의 `rate_limits.five_hour`, `seven_day`(있을 경우) | 첫 API 응답 이후에만 존재할 수 있음. 수집 시각·원천 표시. 0으로 임의 보정 금지. |
| Codex | 공식 app-server `account/rateLimits/read`, `account/usage/read`(지원 인증일 때) | 사용률 창, 리셋 시각, 선택적 토큰 활동 통계. 서로 다른 할당량을 합산하지 않음. |
| Gemini 및 추가 제공자 | 공식 CLI/API가 제공하는 데이터가 있는 경우에 한정 | 할당량 API가 없으면 unsupported, 인증 안 되면 auth_required. 검증되지 않은 %를 추정하지 않음. |
| 각 실행 | 이벤트 내 토큰/시간/비용 추정 가능 범위 | 실제 청구액과 구독 한도를 분리. 공급자가 안 주는 지표는 `unknown`. |

UsageSnapshot에는 `status: available|stale|unknown|unsupported|auth_required`, `sampled_at`, `source`, `metric`, `unit`를 필수로 한다.

## 10. Graph & extension 설계 (V2)
- Graphify는 별도 프로세스로 실행 후 산출물 `graph.json`, `graph.html`, `GRAPH_REPORT.md`를 프로젝트별 앱 데이터 폴더에 보관한다.
- 그래프를 생성한 Git SHA와 현재 작업 브랜치 SHA를 항상 비교. 다른 경우 'stale' 및 재인덱스 안내.
- UI는 서버에서 필요한 노드/엣지를 부분 반환하고 파일 경로 클릭 시 Diff와 연결. `EXTRACTED/INFERRED` 정확도 태그를 유지.
- 읽기 전용 inventory부터: Claude `~/.claude`, 프로젝트 `.mcp.json` 등, Codex `$CODEX_HOME`의 provider-specific 구성. 계정별 설정 파일을 하나로 병합·덮어쓰지 않는다.
- 적용할 때는 백업/검증/원자적 파일 쓰기/롤백; 서드파티 플러그인 설치에는 임의 코드 실행 위험 경고와 승인.

## 11. 안전 모델
- **외부/AI 기획 인계 보안:** 원문은 제공자와 관계없이 비신뢰 데이터. 프롬프트 인젝션·마크다운 코드블록·실행 명령을 *데이터*로 취급; import만으로 MCP 호출/파일 수정/명령 실행/외부 링크 fetch 금지.
- **기획 문서 통제:** DRAFT와 APPROVED를 구분, Task는 승인된 버전의 불변 스냅샷에 연결. 재기획 시 변경 미리보기·명시적 승인·대상 Task 선택을 거침.
- **선택적 외부 기획 MCP 중계:** HTTPS/인증/요청별 권한 정책/감사 로그/레이트 리밋/철회 기능. 최소한의 기획 리소스만 공개, 토큰·소스 원문·광범위 로컬 경로·CLI 제어는 외부에 노출 금지.
- Listen: **127.0.0.1** 기본. LAN 접근은 V1 범위 밖. CloudCLI는 배포 설정에 따라 `0.0.0.0`일 수 있으므로 기존 설정을 그대로 따르지 않는다.
- **브라우저에 비밀정보 없음:** `.env`, `auth.json`, Claude OAuth 토큰, SSH 키 원문, 전체 프로세스 환경 변수 노출 금지.
- `spawn(command, args, {shell:false})`, 등록된 Git 루트 하위 canonical path만 접근. symlink 탈출 및 경로 재귀 검증.
- 검증/빌드 스크립트와 MCP·플러그인은 신뢰하지 않는 코드다. 작업별 격리 + 중요 명령 승인 + 설정 diff 제공.
- 보호 대상: main branch, `git push`, `rm -rf`, 대량 파일 삭제, DB 마이그레이션, 배포, 외부 통신, 비밀정보 출력. 사용자 승인 없이 실행하지 않도록 정책.
- worktree는 파일 충돌 억제 기능일 뿐 OS 샌드박스가 아님. 임의 셸 실행을 허용할 경우 컨테이너/VM 격리 정책은 별도 도입이 필요.
- AI의 지침 파일이나 외부 문서에 숨은 명령은 비신뢰 입력. 명령 실행 정책은 서버에서 판정, 프롬프트만으로 강제하지 않음.
- 개인정보/민감소스 및 회사 자산 연결 시 별도 정책 검토. 기본 앱은 로컬 폴더를 명시적으로 등록한 범위에서만 작동.

## 12. 장애 복구와 정확성
- 프로세스 생성 성공, 모델 응답 시작, 도구 실행 성공, 테스트 성공, PR/병합 성공을 **각기 다른 이벤트와 결과**로 기록한다.
- 죽은 실행에 재접속할 때 먼저 PID/세션/프로세스 상태와 실제 Git diff를 재조사. 불확실하면 `LOST`로 처리하고 사용자에게 재시도 선택을 요청.
- 업무 명령 시작, 승인 결정 및 설정 적용에 idempotency key를 사용하여 중복 실행 방지.
- 모든 기획 도구·코딩 에이전트 간 인계는 모델 내부 상태 이전이 아니라 **텍스트 명세 + 결정 사항 + base/head SHA + 검증 결과 + 남은 작업**을 패키지로 전달.
- 로그/알림이 끊겨도 SQLite 이벤트 시퀀스로 UI 재동기화. 연결이 끊긴 동안의 실행에 대해서는 CLI 동작 재조회 필요.

## 13. 구현 시 기술 검증 게이트
- **기획→작업 전환 POC:** 직접 작성, 외부 제공자별 예시 명세 Markdown/JSON import → 필드 확인·승인 → Task 초안 생성; 수정 버전 diff 및 피드백 export 확인. **ChatGPT 계정 없이 수행**.
- 같은 개발 머신에서 설치된 지원 CLI만 감지하고 누락/인증필요/지원기능을 구분. **에이전트 하나로 Gate를 통과해야 함.**
- Claude가 설치됐다면 `stream-json` 응답/세션 ID/권한 거절/재개/중지 확인.
- Codex가 설치됐다면 App Server stdio 기동/초기화/turn 이벤트/승인/인터럽트/usage 읽기 확인. 없는 사용자는 UI가 차단 없이 작동해야 함.
- 현재 OS에서 Git worktree 생성·복구·삭제와 프로젝트 빌드 명령 실행 확인.
- 서버 종료 중 남은 CLI 자식 프로세스를 수동/자동 구분하여 정리할 수 있는지 확인.
- CloudCLI 포크·플러그인 채택은 공식 제약으로 보아 핵심 경로용 기본 선택지에서 제외하되 UI 참조/별도 세션 화면은 POC 대상.
