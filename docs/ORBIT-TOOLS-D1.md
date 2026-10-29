# TOOLS-D1 — Skills/MCP/Plugins/Hooks/Subagents 검증된 선택·호출 설계 (2026-10-29)

작성: Claude worker (Plan, model opus via model-routing ledger `TOOLS-D1`), read-only. 검토: Claude Code 오케스트레이터.
정정: 보고서의 "Claude CLI 미설치(PHASE5 문서)"는 과거 기록이다. 현재 `claude` 2.1.312가 설치되어 있고 2026-10-29 LIVE-CLI E2E로 확인했다([ORBIT-LIVE-CLI-2026-10-29](ORBIT-LIVE-CLI-2026-10-29.md)).

**잠정 기본값 (보수적, 범위 축소 방향, 사용자 결정 전):**
1. 실호출은 일회용 fixture MCP 서버로 Codex tool call 1회만 한다. 승인 후에만 실행하며, 사용자 실제 MCP 서버는 제외한다.
2. fixture 검증은 "fixture 항목 verified"로만 표시한다. 실제 사용자 항목은 미검증으로 표시한다.
3. Orbit은 skill·MCP·plugin을 설치하거나 업데이트하지 않는다.
4. Hooks·Subagents는 discovery 전용이다. Orbit 호출 대상이 아니다.
5. grant는 task 단위 일회성이다.
6. Claude MCP config 생성과 항목 단위 Claude skills 호출은 차단을 유지한다.
7. Codex skill 지정 호출은 공식 경로가 확인될 때까지 unsupported로 둔다.

## 1. 현재 상태

### Discovery
- **Codex:** `server/extensions.ts:87-99`가 `mcpServerStatus/list`, `skills/list`, `hooks/list`를 metadata로만 수집한다.
  - effective 상태: MCP·hooks는 `blocked_policy`, skills는 `unknown`이다.
  - MCP는 `runtimeStatus!=='disabled'`이면 응답을 거부한다(`:53`).
- **Plugins:** 두 runtime 모두 `not_connected`이다(`extensions.ts:38`, `:97`).
- **Claude Code:** extension discovery가 없다. skills·hooks·mcp·subagents는 `unknown`이다(`capability-adapters.ts:57`, `:70`).
- **Subagents:** inventory가 없다(`capability-adapters.ts:69`).
- **Registry:** `declaredCapabilities`(`shared/model-registry.ts:25`)는 사용자 선언일 뿐이다.

### Selection
- `capability-adapters.ts:30-33` implementations에 skills·hooks·mcp·slash·subagents가 없다.
  - 그래서 `policy:'blocked'`이다(`:57-60`).
  - `orbit.extension.activation_not_authorized`가 붙는다(`:67`).
- 자연어 라우팅은 `EXTENSION_NOT_AUTHORIZED`로 차단한다(`capability-routing.ts:16`, `:72`, `:88`).

### Invocation
- `server/capability-invocation.ts:32`는 `status|result|interrupt`만 허용한다.
- 승인 digest·requestId 멱등·intent 선기록 패턴(`:24-37`)은 재사용한다.

### 격리
- Codex는 `--disable plugins, hooks, multi_agent, skill_search, skill_mcp_dependency_install`로 실행한다(`server/codex.ts:31`).
- thread `mcp_servers`는 `{enabled:false}`로 강제하고 그 결과를 확인한다(`controller.ts:556-584`, `codex-planning.ts:166`, `codex-review.ts:114`, `scripts/verify-mcp-isolation.mjs`).
- Claude는 `--restricted --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --tools …`로 실행한다(`server/runtimes/claude-code.ts:34`, `:39-41`).

### 집계
- `capability-validation.ts:6-19`는 `execute.*`·`model.actual`만 집계한다. 도구별 집계는 없다.

## 2. 최소 설계

### 네 가지 상태를 따로 센다
- 키: `(runtime, kind, itemId)`. itemId는 기존 sha256 id(`extensions.ts:29`)를 쓴다.
- **installed:** discovery metadata로만 판정한다.
- **permitted:** Orbit 허용목록 grant다. nativeTrust·configuredEnabled로 추론하지 않는다.
- **invoked:** native/mock/unknown 건수다.
- **verified:** native만 센다.
- 상태 간 자동 승격은 없다.

### 권한
- 사용자는 discovery itemId만 선택한다. 자유 텍스트·경로·command·URL은 받지 않는다.
- `itemDigest = hash(kind, id, scope, handlerType, nativeTrust, pluginOwned, runtimeVersion, adapterRevision)`
- metadata가 바뀌면 grant는 무효가 된다.
- Plugins는 Orbit이 로드하지 않는다.

### 호출 승인
- preview digest: `hash(projectId, taskId, runtimeId, kind, itemId, itemDigest, grantId, planningContentHash)`
- invoke 입력: `{requestId, previewId, expectedDigest, confirmed:true}`
  - invoke 시점에 digest를 재계산한다.
  - 불일치하면 `ROUTE_CHANGED`로 거부한다.
- requestId는 멱등이고 intent를 선기록한다. 결과가 unknown이면 자동 재시도하지 않는다.

### 실행 경계
- 새 실행기를 만들지 않는다. 기존 task Run의 launch profile에서 허용된 항목 1개만 켠다.
- **Codex MCP:** thread config에서 그 이름만 `enabled:true`로 바꾼다. 나머지 sandbox(`workspace-write`, `network_access:false`)와 `approvalPolicy`는 유지한다.
- **Claude MCP:** command 주입이 필요하다. 그래서 blocked다.
- **Claude skills:** 항목 단위 제어가 불가능하다. 그래서 blocked다.
- **Hooks:** 임의 command다. blocked다.

### verified 조건
아래 넷이 모두 성립해야 verified다.
1. native 실행이 관측됨
2. Run journal에 해당 항목의 tool-call 완료 이벤트가 있음
3. binding이 승인 digest와 일치함
4. mock/unknown이 아님

Codex MCP tool-call 이벤트 형식은 구현 전에 fixture로 확정한다.

### CQG 연결
- `CompletionPolicy.requiredTools`와 `CompletionEvidence.toolInvocations`를 추가한다.
- mock/unknown이면 `recorded`로 남기고 `CQG_TOOL_EVIDENCE_NOT_NATIVE`를 낸다.
- 비어 있으면 기존 동작과 같다.

## 3. 작업 단위 (fake 테스트)

| # | 단위 | 소유 파일 | 비고 |
|---|---|---|---|
| T1 | 계약·순수 집계 | `shared/tool-capabilities.ts`, `server/tool-capability-ledger.ts`, `tests/tool-capability-ledger.test.ts` | 신규 파일만 |
| T2 | 허용목록 저장소 | `server/tool-permissions.ts`, `tests/tool-permissions.test.ts` | 새 table |
| T3 | preview/approve/invoke | `server/tool-invocation.ts`, `shared/tool-invocation.ts`, tests | `ToolLaunchPort` 인터페이스 |
| T4 | native 증거 판독 | `server/tool-evidence.ts`, tests | journal fixture |
| T5 | Registry 반영 | `server/capability-adapters.ts`, `server/capability-validation.ts`, `shared/capability-orchestration.ts` | grant 없으면 blocked 유지 |
| T6 | UI | `web/capability-matrix.tsx`, `web/capabilities.tsx` | 네 상태 표시 |
| T7 | 연결 | `server/controller.ts`, `server/codex.ts`, `server/http.ts`, CQG 파일 | CQG-4 병합 후 |
| T8 | 실검증 | `scripts/verify-tool-invocation.mjs` | 사용자 승인 후 1회 |

순서는 T1 → (T2 ∥ T4) → T3 → (T5 ∥ T6) → T7(CQG-4 후) → T8(승인 후)이다.
