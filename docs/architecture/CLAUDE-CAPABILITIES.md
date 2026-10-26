# Claude Code 공식 capability 근거

checkedAt: **2026-10-25**. 공식 문서 조사이며 CLI·SDK 실서비스 검증 결과가 아니다.

현재 머신의 `Get-Command claude,claude.exe,claude.cmd`에서는 항목을 찾지 못했다. 이는 **현재 PATH에서 미발견**이라는 뜻이며, 설치 여부·설치 버전·인증·구독·사용 가능한 모델은 모두 **unknown**이다. 설치, 로그인, 자격증명 열람, 추론 실행은 하지 않았다.

## 문서상 지원과 인터페이스

아래 yes는 공식 문서에 인터페이스가 있다는 뜻이다. conditional은 버전·설정·플랫폼·인증 등의 조건이 있으며, 모든 항목의 이 머신 실행 가능 여부는 unknown이다.

| Capability | 문서상 지원 | 근거와 한계 |
| --- | --- | --- |
| CLI/Agent SDK streaming | yes | CLI `-p --output-format stream-json --verbose --include-partial-messages`, SDK `query()`/`includePartialMessages`. NDJSON/result와 partial events를 구분한다. [CLI](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless), [SDK stream](https://code.claude.com/docs/en/agent-sdk/streaming-output) |
| Plan/permission | conditional | `--permission-mode plan`, allow/ask/deny, SDK `canUseTool`. 자동 승인된 도구는 callback을 거치지 않으므로 callback 하나를 전 도구 정책 gate로 삼지 않는다. [permissions](https://code.claude.com/docs/en/permissions), [SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input) |
| Skills | yes | `SKILL.md`, `.claude/skills/`, 사용자/자동 호출, fork. SDK는 `settingSources`/`skills`로 연결한다. `disable-model-invocation: true`는 수동 호출 제어이며 OS 보안 경계가 아니다. [Skills](https://code.claude.com/docs/en/skills) |
| MCP | conditional | SDK `mcpServers`, CLI 명시적 MCP 설정 지원. 서버별 신뢰·인증·권한과 managed policy를 따로 확인한다. `--strict-mcp-config`만으로 SDK/`--agents`가 명시한 inline 서버까지 제거된다고 가정하지 않는다. [MCP](https://code.claude.com/docs/en/mcp), [subagent MCP](https://code.claude.com/docs/en/sub-agents) |
| Hooks | conditional | PreToolUse/PostToolUse/Stop 등과 command/HTTP/prompt/agent 및 SDK callback 지원. 이벤트마다 block 의미가 다르고 hook 실패가 기본적으로 작업을 통과시키는 경우가 있다. 보안 gate는 지원 버전의 `onFailure: "block"` 및 실패 검증이 필요하다. [Hooks](https://code.claude.com/docs/en/hooks) |
| Subagents | yes | SDK `agents`와 Agent 도구, 파일 기반 정의, 컨텍스트 분리·도구 제한·resume 지원. 깊이·동시 실행·모델 제한은 설치 버전별로 확인한다. [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents) |
| Agent Teams | conditional | CLI 실험 기능, 기본 비활성. SDK 옵션으로 직접 구성하는 기능은 아니다. in-process teammate resume와 중첩 팀에 제한이 있고 Windows Terminal split pane은 미지원이다. [Teams](https://code.claude.com/docs/en/agent-teams), [SDK feature 구분](https://code.claude.com/docs/en/agent-sdk/claude-code-features) |
| Session/resume/fork | yes | CLI `--resume`/`--continue`/`--fork-session`, SDK `resume`/`continue`/`forkSession`. 최신 버전은 다른 프로젝트 디렉터리까지 ID를 검색할 수 있으므로 Orbit는 project/workspace/session ID를 직접 묶어야 한다. [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) |
| Native Goal | conditional | 공식 `/goal` 및 `claude -p "/goal …"` 지원. session-scoped prompt Stop hook의 별도 모델이 계속/달성/불가능을 판단한다. evaluator는 도구 없이 대화 근거만 보며 비용이 발생하고 권한모드는 바꾸지 않는다. active goal은 resume될 수 있으나 turn/time/token 기준은 초기화된다. 별도 typed SDK goal API는 이번 조사에서 unknown이다. [Goal](https://code.claude.com/docs/en/goal) |
| Verification workflow | conditional | 공식 bundled `/run`, `/verify`, `/run-skill-generator` 존재. workflow 제공과 Orbit의 실제 command/exit/SHA 검증 증거는 별개다. [Run and verify](https://code.claude.com/docs/en/skills#run-and-verify-your-app) |
| Usage/cost | conditional | `total_cost_usd`는 실제 청구서와 다를 수 있는 클라이언트 추정치다. `usage`는 subagents를 제외할 수 있고 `modelUsage`는 포함한다. resume 결과에는 과거 비용이 포함될 수 있어 단순 합산하지 않는다. 누락·crash 결과는 unknown을 보존한다. [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) |

## 인증·구독·API 과금의 미확정 경계

- [CLI authentication](https://code.claude.com/docs/en/authentication)은 subscription OAuth, Console/API key와 지원 cloud provider 인증을 구분한다. 특히 `-p`는 API key 환경변수가 있으면 그 키를 사용하므로 구독 보유만으로 구독 한도 사용이라고 표시하지 않는다.
- [공식 Help의 2026-10-07 안내](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)는 SDK·`claude -p`·third-party apps가 구독 한도를 계속 사용할 수 있으며 Max/Team에 월 API credits도 있다고 설명한다.
- 동시에 [SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)는 사전 승인 없이 제3자 개발자가 제품에 claude.ai login/rate limits를 제공하지 말고 API 인증을 사용하라고 명시한다.

이 조사는 위 문구들의 최종 적용 범위를 확정하지 않았다. 개인 로컬 CLI 이용 가능성을 Orbit 배포 제품의 구독 로그인 제공 허용으로 확대 해석하지 않는다. **Orbit 배포 형태에 대한 허용 여부는 unknown**, auth/billing은 별도 profile로 기록하고 사용자가 승인하지 않은 과금 경로로 전환하지 않는다.

## Orbit effective policy

공식 문서의 yes는 Orbit에서 enabled/verified라는 뜻이 아니며 이 문서는 실행 권한을 부여하지 않는다. 설치 버전·adapter 계약·허용된 인증/비용·프로젝트 경계·실행 정책 검증을 통과한 capability만 활성화한다. 기존 fail-closed, MCP 격리, loopback, worktree 분리 및 사용자 승인 경계를 유지한다. 최신 SDK는 설정을 자동 발견할 수 있으므로 로드할 Skills/hooks/MCP와 설정 출처를 명시적으로 통제한다. [SDK 설정 로드와 격리 한계](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

`result.subtype: success`만으로 실행 완료를 판정하지 않는다. 공식 defer 흐름은 success result에도 `stop_reason: tool_deferred`/`deferred_tool_use`를 담아 사용자 입력을 기다릴 수 있다. native Goal의 achieved, `/verify` 보고, 실제 검증 성공과 최종 사용자 승인도 각각 별도로 기록한다. [Deferred tool interaction](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)

Solo/Cross Review/Debate/Race/Cooperate는 Orbit의 제공자 중립 orchestration 모드다. native subagents/Teams는 가능한 실행 backend이며 타 제공자 협업을 자동 보장하지 않는다. Goal은 native 기능을 재사용할 수 있지만 Orbit의 중단·예산·재시작·검증·승인 정책을 대체하지 않는다. 이 매핑은 제품 설계 해석이며 실제 adapter 구현/검증 완료 주장이 아니다.
