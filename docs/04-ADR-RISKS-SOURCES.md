# ADR + 위험관리 + 근거 — 2026-10-25

## ADR-001: 단일 CloudCLI 포크를 기본 구조로 채택하지 않음
**결정:** 자체 Control Server + 독립 웹 UI를 기본 설계로 한다. CloudCLI는 실용적인 UX/기능 참조 및 선택적 연동 대상으로 본다.

**근거:** CloudCLI는 Claude/Codex 채팅, 세션, Git, 파일, 플러그인을 제공하므로 이미 구현된 기능이 많다. 그러나 공식 플러그인 문서는 (1) 기존 Chat/Shell/Git 탭을 수정할 수 없고 (2) 플러그인이 에이전트에게 메시지를 보내는 API가 없다고 명시한다. 핵심 오케스트레이터를 플러그인만으로 구현하면 통합 명령/승인/상태 관리에서 한계가 생긴다. 전체 포크는 upstream 동기화와 AGPL 조건을 관리해야 한다.

**대안:**
1. CloudCLI 포크: 빠른 UI 출발, 그러나 강한 결합·upstream 업데이트·AGPL 의무 검토.
2. CloudCLI 플러그인: 부가 그래프/사용량 탭에 적합하나 통합 제어에는 부적합.
3. Claude Deck: MIT, Agent Mail/Teams/Config 강점. 현재 GitHub issue→PR 운영 중심이고 일부 공급자 상태/기능은 비대칭. 소스 구성 재사용 가능성은 실제 의존성과 OS 조건을 검토해야 함.
4. 독립 관제 엔진: 초기 구현량은 늘지만 명확한 데이터·권한·실행 경계 유지.

**판단 변경 조건:** 소스 POC에서 CloudCLI의 공개 안정적 API로 필요한 run/approval/event 조작이 모두 가능해지거나, Claude Deck이 개인용 로컬 모든 흐름을 검증 가능한 방식으로 제공할 때 재평가.

## ADR-002: 제공자 인증은 공식 CLI에 위임
**결정:** 사용자가 선택한 공식 CLI/모델 제공자에서 직접 인증한다. **ChatGPT·OpenAI 계정은 필수 아님.** 관제센터가 원본 OAuth 토큰을 수집/중계하지 않는다. Codex는 ChatGPT 로그인 또는 API 키 인증이 가능하나, 키 사용은 별도 과금 경로다.

**이유:** Claude 공식 법률 문서는 타사 제품이 사용자 Claude.ai 자격증명을 수집·중계하거나 타사 로그인 기능을 제공하는 것을 제한한다. 반면 수정되지 않은 공식 Claude Code 바이너리에서 최종 사용자가 자신의 구독으로 로그인하는 경우를 별도로 설명한다. 배포/상업화 여부에 따라 법률·라이선스 재검토 필요. Codex App Server는 로컬 오픈소스 앱에서 다룰 수 있으나 hosted/commercial 재배포와 실험 상태 제약이 있으므로 별도 경로를 고려해야 한다.

**판단 변경 조건:** 공급자 공식 인증 프로그램을 통해 독립 앱용 인증과 비용·권한이 명시적으로 제공될 때.

## ADR-003: V1의 '자동 AI 배정'은 규칙 추천으로 축소
**결정:** 사용자가 **설치·인증된 제공자만** 선택하고, 보조 UI는 capability/사용률/작업 성격으로 추천 이유를 제시한다. 추가 LLM 호출로 라우팅하지 않는다.

**이유:** 복잡한 라우팅의 비용·성능 이점을 입증할 데이터가 없고, 자동화가 오류를 확대할 수 있다.

## ADR-004: 상태는 수다스러운 로그가 아닌 증거 기반
**결정:** Task/Run/Check/Review/Approval/Commit을 분리. 'Done'은 지정된 검증과 승인 모두 충족할 때만 기록.

**이유:** 모델의 종료 메시지와 실제 빌드/테스트/merge 성공은 서로 독립.

## ADR-005: Worktree를 충돌 방지의 기본 단위로
**결정:** 쓰기 가능한 에이전트 작업은 가급적 별도 worktree, 리뷰는 read-only 정책과 파일쓰기 차단. Git SHA 기준으로 비교.

**주의:** Worktree만으로 OS 차원의 프로세스 격리가 되지 않는다. 리뷰 모드는 공급자의 실제 쓰기 금지/샌드박스 설정을 확인해야 하며, 실패 시 별도 read-only 복제본 또는 제한된 diff 입력으로 대체.

## ADR-006: 알림·사용량은 출처를 동반
**결정:** 사용률 %, 토큰, 비용 추정은 섞어 합산하지 않는다. unavailable/stale 상태를 명시한다.

**근거:** Claude statusLine `rate_limits`는 Pro/Max 구독이더라도 첫 API 응답 후에만 존재할 수 있으며 특정 창은 없을 수 있다. Codex App Server rateLimits 및 usage는 지원하는 인증과 버전에 따라 다르다.

## ADR-007: ChatGPT 기획은 핵심 선택 시나리오이지만 제품의 필수 전제는 아님
**결정:** ChatGPT 웹 기획→import→승인→실행→피드백 export는 유지하되, 같은 기능을 **관제센터 내부 수동 기획 / 연결된 에이전트의 기획 모드 / Claude·Gemini 등 외부 기획 웹**에도 동등 제공한다. 특정 서비스의 계정이나 챗 기록 접근을 강제하지 않는다.

**이유:** 사용자별 구독·모델 선호도가 다르며, 하나의 서비스에 제품 생명주기를 종속시키면 채택을 가로막는다. 기획 산출물과 승인 정책을 공통 포맷으로 관리하는 것이 핵심 가치다.

**후속 선택:** ChatGPT 공식 플러그인/HTTPS MCP 연결은 지원하는 계정에서 opt-in을 검토하되, 기본 로컬 서버를 공개하지 않음. 다른 기획 서비스도 공식 지원 인터페이스가 있는 경우에만 직접 연결한다.

## ADR-008: 공급자 중립 코어, 최소 1개 에이전트로 개발 완료
**결정:** 특정 코딩 AI를 필수로 지정하지 않는다. `ProviderRegistry`와 capability-aware adapter로 역할을 선택한다. **0개 연결 시 기획/프로젝트 조회, 1개 연결 시 구현/테스트/사람 승인, 2개 이상이면 선택적 독립 리뷰**를 지원한다.

**근거:** Gemini CLI는 Google 계정/API 키 인증 및 스트리밍 JSON 출력 지원을 문서화했고, OpenCode는 다수 제공자·로컬 모델 연결을 제공한다. Codex는 ChatGPT 로그인 외에 API 키 인증도 지원한다. 그러나 CLI마다 승인/세션/한도 API는 달라 실제 검증 전 동등 기능으로 홍보하지 않는다.

**리뷰 결정:** 타 모델이 없을 때 `same_provider_new_session` / `human` / `skipped` 상태를 정확히 표기하며, 서로 다른 모델의 독립 리뷰처럼 포장하지 않는다.

**범위 통제:** Gemini/OpenCode 추가는 P1 검증, 기본 V1은 Claude Code 또는 Codex 중 1개로 완결되는 구조부터 시험.

## 리스크 레지스터
| ID | 위험 | 현실적인 실패 조건 | 대응/검증 |
|---|---|---|---|
| R-01 | Claude 인증·구독 약관 | 타사 OAuth 재사용·중계, 상용 배포 | 바이너리 무변경, 공식 로그인, 자격증명 미수집, 재배포 전 최신 정책 검토 |
| R-02 | Codex 프로토콜 변경 | App Server 메서드/이벤트 변경 | 버전 감지, schema generate, fixture 계약 테스트, CLI fallback |
| R-03 | 복잡도 증가 | 기능 많이 붙여 V1 지연 | Gate별 P0 기능 동작 후 P1 진행 |
| R-04 | 코드 손상 | 동일 worktree 동시 수정/dirty 덮어쓰기 | 분리 worktree, 병합 승인, SHA 기반 변경 추적 |
| R-05 | 명령 실행 위험 | shell, untrusted scripts, `rm`, push, deploy | 서버 정책 게이트, 분리된 권한, 승인, 로그, 백업 |
| R-06 | localhost 보안 착시 | 0.0.0.0 바인딩, 악성 웹페이지의 localhost 요청 | loopback bind, CSRF/Origin 검사, 로컬 앱 인증, 원격 별도 보안 |
| R-07 | 사용량 오표시 | 토큰/쿼터/금액 혼용, 오래된 샘플 | 단위, 수집 시각, 품질 및 출처 의무화 |
| R-08 | 코드 그래프 오분석 | 오래된 HEAD, 동적 호출 누락 | 분석 SHA/버전 표시, stale 경고, 재인덱스, 테스트 결과 우선 |
| R-09 | 외부 플러그인 공급망 | npm install 후크, MCP 서버 임의 실행 | 격리 설치, 권한 미리보기, 버전 고정, 출처 검증, 승인 |
| R-10 | 복구 중 중복 실행 | 앱 재시작 후 상태를 모르고 같은 커맨드 재호출 | 런 ID/idempotency, 프로세스 재조회, 사용자 재시작 확인 |
| R-11 | OS별 동작 차이 | PTY/tmux, 경로 처리, WSL 통합 | 최초 OS 기준 POC, capability detection, 미지원 배지 |
| R-12 | ChatGPT 웹 데이터 비연결 | 로컬에서 웹 채팅/메모리/플러그인 전체 동기화를 전제 | V1 명시적 아티팩트 가져오기/피드백 내보내기, 자동 스크래핑 금지, UI에 직접 동기화 아님 표시 |
| R-13 | 기획안과 코드 상태 괴리 | 외부/내부 기획 도구에서 변경한 기획안이 실행 중 작업에 자동 덮어써짐 | 버전 고정, diff, Task 영향 표시, 수동 승인·선택적 적용 |
| R-14 | 외부 MCP 게이트웨이 권한 과다 | HTTPS 터널을 통해 로컬 소스/CLI 접근 가능 | 제한된 기획 API, 강한 인증, 최소 권한, 만료·철회, 감사 로그, 기본 OFF |
| R-15 | 기획 문서 프롬프트 인젝션 | 문서가 원하지 않는 실행 명령 또는 탈취 지시 포함 | import를 데이터로 파싱, 승인 전 실행 금지, 외부 링크 자동 요청·명령 실행 금지 |

| R-16 | 특정 AI 서비스 필수 의존 | GPT 미가입 상태에서 로그인 화면·기획 기능이 막힘 | GPT 없는 자동화 테스트, 기능 역할 선택, 출처 중립 기획 스키마 |
| R-17 | 단일 에이전트 리뷰 과대평가 | 자기 리뷰를 독립 교차 리뷰처럼 표시 | `cross_provider`, `same_provider_new_session`, `human`, `skipped` 출처 표시 |
| R-18 | 제공자별 API/약관·가격 변경 | 계정 기반 연결이 차단되거나 API 요금이 발생 | 개별 어댑터·인증 경계·POC·비용 동의, 대체 선택지 제공 |

## 참고한 1차 출처 (공식 문서/프로젝트)
1. CloudCLI README: https://github.com/siteboon/claudecodeui
2. CloudCLI 플러그인 기능·제약: https://cloudcli.ai/docs/plugins/plugin-overview
3. Claude Deck README: https://github.com/adrirubio/claude-deck
4. Claude Code CLI 옵션: https://code.claude.com/docs/en/cli-reference
5. Claude Code 비대화형 실행: https://code.claude.com/docs/en/headless
6. Claude Code 구독 사용량 표시: https://code.claude.com/docs/en/statusline
7. Claude Code 인증 및 법률: https://code.claude.com/docs/en/legal-and-compliance
8. Codex App Server: https://learn.chatgpt.com/docs/app-server
9. Codex 확장 프레임워크 소개: https://developers.openai.com/blog/codex-as-a-platform
10. Codex 구 MCP 서버 제거 공지: https://developers.openai.com/ko-KR/docs/mcp-server
11. Graphify 로컬 인덱스/출력/라이선스: https://github.com/Graphify-Labs/graphify
12. Sign in with ChatGPT(향후 확장 검토): https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
13. ChatGPT Projects: https://help.openai.com/ko-kr/articles/10169521-projects-in-chatgpt
14. OpenAI 커스텀 MCP 플러그인/로컬 서버 터널: https://developers.openai.com/plugins/build/app-quickstart
15. Codex 공식 인증 방식(ChatGPT/API 키): https://learn.chatgpt.com/docs/auth
16. Gemini CLI 공식 인증: https://geminicli.com/docs/get-started/authentication/
17. Gemini CLI headless/stream-json: https://geminicli.com/docs/cli/headless/
18. OpenCode 제공자·로컬 모델(인증 제약 포함): https://docs.opencode.ai/docs/providers/

## 미검증 사항
- **실제 개발 머신**의 운영체제, 설치된 공급자별 CLI 버전, 로그인 상태, 모델/권한 설정.
- ChatGPT 미가입 단일 제공자 경로와 Gemini/OpenCode 승인·세션·사용량 기능의 실제 지원 여부.
- 실제 CloudCLI 및 Claude Deck 로컬 실행/확장 코드 통합, 저장소 라이선스 의무의 구체적 해석.
- Claude `--permission-prompt-tool`과 Codex 승인 라우팅의 end-to-end 웹 UX.
- Graphify 최신 그래프 JSON의 대규모 저장소 성능, 특정 언어별 정확도.
- Claude/Codex 구독의 실제 현재 잔여 사용량과 reset 시각.
- 계정에서 ChatGPT 커스텀 MCP 플러그인 추가가 가능한지, 사용 중인 HTTPS 중계·인증이 목적에 맞게 작동하는지(선택 V2 PoC).
- ChatGPT 웹이 기획 문서 생산 과정에서 제공할 수 있는 다운로드 양식은 사용자/클라이언트 기능에 따라 다름. 따라서 Markdown 붙여넣기를 기본 경로로 둠.

위 항목은 Phase 0에서 검증한 뒤 ADR을 업데이트해야 한다.
