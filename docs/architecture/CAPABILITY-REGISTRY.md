# Capability Registry

확인일: 2026-10-25. 공식 제품 지원, 설치된 CLI, 현재 연결, Orbit 정책 허용, 테스트 증거를 서로 다른 필드로 관리한다. Registry는 설명 데이터이며 실행·권한 변경·설치의 승인 근거가 아니다.

## 제품 연결

- `shared/capabilities.ts`는 계약, `server/capabilities.ts`는 공식 근거와 현재 Controller 상태를 결합한다.
- `GET /api/capabilities`는 캐시와 정적 정의만 읽는다. 프로세스나 모델 요청을 시작하지 않는다.
- `POST /api/capabilities/probe`는 기존 세션·Origin·CSRF 및 빈 body를 요구한다. native CLI의 고정 `--version`만 실행하며 60초 캐시와 진행 중 요청을 공유한다. 경로·원시 stdout/stderr·환경·인증정보는 응답하지 않는다.
- 웹 모델 제공자와 확장 기능 화면에서 같은 Registry를 사용한다. 현재 연결된 core 세션 외 runtime 지원은 unknown이다. CLI 버전 확인만으로 모든 API 지원이나 인증 성공을 표시하지 않는다.
- 현재 Solo Codex 경로는 기존 Controller다. Claude 어댑터 및 나머지 모드 executor는 미연결이다. native HTTP transport·verification 모듈도 별도로 연결해야 한다.

## Codex 공식 인터페이스와 로컬 증거

공식 [App Server](https://learn.chatgpt.com/docs/app-server)의 stdio JSON-RPC를 재사용한다. 세션 start/resume, turn start/interrupt, review/start, Skills·Hooks 목록, MCP 상태, Goal set/get/clear, quota/usage 조회가 조사 대상이다. collaborationMode/list는 실험 API이며 plugin/list/read/install은 문서상 개발 중으로 production 호출을 권하지 않는다.

이 머신의 `codex 0.164.0-alpha.11.1`에서 `app-server generate-json-schema`와 `--experimental` 변형이 각각 exit0이었다. worktree의 `.local/capability-schema*`에 저장했다. 안정 schema에 Goal·Skills·Hooks·Review·MCP·usage method가 있고, 실험 schema에 collaborationMode/list와 Bedrock 계정 설정 method가 있다. **schema에 존재하는 것은 활성화·인증·호출 성공 증거가 아니다.** 계정 설정 method를 호출하지 않았다.

현재 `server/codex.ts`는 hooks/plugins/multi_agent/shell 등을 비활성화하고, Controller는 승인 기본 거절·MCP 격리·sandbox 검사를 유지한다. Registry 반영을 위해 이 정책을 변경하지 않는다. Skills 문서와 목록 지원은 프로젝트별 프로필·설치·수정 기능 연결을 뜻하지 않는다.

[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)는 내장 협업을 우선 재사용한다. 지시문만의 읽기 전용 역할은 OS/worktree 격리가 아니다. [Hooks](https://learn.chatgpt.com/docs/hooks)는 신뢰·권한·실패 동작 확인이 필요하며 sandbox 대체 수단이 아니다. [Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)는 native 지속 목표와 예산을 재사용하되 목표 달성 판단을 실제 검증·사용자 승인과 분리한다.

## Claude Code와 인증·과금

세부 공식 출처와 제한은 [CLAUDE-CAPABILITIES.md](CLAUDE-CAPABILITIES.md). 현재 PATH에서 Claude를 발견하지 못했으며 설치 전체·로그인·quota는 unknown이다. `claude -p`와 stream-json, SDK, Skills/MCP/Hooks/subagents/Goal은 공식 기능이지만 Orbit 어댑터는 미연결이다.

개인 로컬 구독 사용 안내와 제3자 배포 제품의 인증 제공 제한은 적용 범위가 다르다. Orbit에서 구독을 재판매하거나 API 과금을 자동 전환하지 않는다. API key 우선순위, provider OAuth/cloud profile, model별 비용·토큰 계측, 남은 quota/갱신 시각의 출처를 설정 때 분리해야 한다. 누락값은 0이나 무제한이 아닌 unknown이다.

## 확장 및 다음 연결 gate

서드파티 MCP/Skill/Plugin 도입에는 출처·고정 버전·실행 권한 검토, disposable 저장소에서의 격리 실험, 설정 변경 preview·backup·복구가 필요하다. 현재 Registry에는 install/enable API가 없다. native CLI 자체 반출과 Orbit HTTP gateway의 반출 통제도 구분한다.

현재 검증 evidence/리뷰승인 UI와 Codex 계정 사용량 명시 조회를 연결했다. 다음 단계는 [실행 모드 계약](EXECUTION-MODES.md)의 executor와 선택형 native adapter다. 버전 진단 자체는 비용이 발생하는 모델 호출이나 외부 설정 활성화를 포함하지 않는다.

2026-10-26 Native Review 구현: 별도 `thread/start`(read-only, ephemeral)와 `review/start`(inline/custom)를 사용한다. 승인된 bounded 정제 Diff만 프롬프트로 전달하고 같은 thread/turn의 `exitedReviewMode.review`와 완료 이벤트를 함께 요구한다. auth/policy/MCP, 1 turn·60초, 초과 응답 거절, 중단·종료 확인·source stale·재시작 quarantine을 구현했다. Registry의 review는 contract_tests이고 runtime은 unknown으로 유지한다. 기본 세션이 연결돼 있어도 새 리뷰 세션의 권한을 매번 재검사한다. 실제 native 리뷰 응답·사용량은 미검증이며 Cross Review 전체 executor 연결을 뜻하지 않는다.
