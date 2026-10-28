# Phase 5 capability 계약과 검증 범위

확인일: 2026-10-28. 공식 문서, Orbit 구현, 설치 환경, 실제 실행 증거를 구분한다. 이 문서의 조사에서 모델·인증 명령을 호출하지 않았다.

## 공식 Claude 계약

[CLI reference](https://code.claude.com/docs/en/cli-reference)는 `-p`, `--output-format stream-json`, `--resume`, `--agents`를 문서화한다. `--restricted`는 2.1.248+, `--permission-prompts none`은 2.1.259+ 계약이다. `--disable-slash-commands`는 skills/commands를 끈다. 문서에 존재한다는 사실은 설치된 CLI의 지원이나 Orbit 호출 성공을 뜻하지 않는다.

[Programmatic execution](https://code.claude.com/docs/en/headless)은 print 실행을 설명한다. 일반 print 실행은 사용자·프로젝트 hooks/MCP를 자동 탐색할 수 있다. `--bare`는 구독 로그인을 사용하지 않으므로 Orbit 구독 경로의 대체 옵션으로 적용하지 않았다.

[Subagents](https://code.claude.com/docs/en/sub-agents)는 독립 문맥·권한과 추가 사용량을 설명한다. Orbit은 subagent 실행을 연결하지 않는다. Codex의 기존 `multi_agent` 비활성화 및 Claude의 제한된 tools 목록을 유지한다. 임의 slash 문자열을 실행 인수로 전달하지 않는다.

## 지원 행렬

D/I/V는 Orbit의 discovery / invocation / verification 차원이다. `implemented`는 코드 구현이며 실환경 검증 표시가 아니다.

| 기능 | Codex D/I/V | Claude D/I/V | 실행 정책·실제 근거 |
|---|---|---|---|
| execute.code | implemented / implemented / implemented | implemented / unsupported / unsupported | 기존 Codex task 경로. 개별 Run 증거로만 실제/Mock 구분 |
| execute.general | implemented / unsupported / unsupported | implemented / implemented / implemented | 기존 Claude task 경로. 현재 로컬 CLI 미발견 |
| status, result | implemented / implemented / implemented | implemented / implemented / implemented | 저장된 Orbit Run 조회. 조회 지원을 새 Provider 실행으로 집계하지 않음 |
| subagents | unknown / unsupported / unsupported | unknown / unsupported / unsupported | 공식 기능 설명만 확인. Orbit 호출 차단, 설치 inventory 미확인 |
| skills, hooks, MCP | implemented / unsupported / unsupported | unknown / unsupported / unsupported | Codex metadata discovery 재사용. 신뢰·권한 없이 활성화하지 않음 |
| slash_commands | unknown / unsupported / unsupported | unknown / unsupported / unsupported | 호출 차단 |
| model.actual | implemented / unsupported / unsupported | implemented / unsupported / implemented | Codex 실제 모델 unknown 유지. Claude는 assistant 관측만 증거 가능 |

plan/review/resume/interrupt는 기존 registry와 실행 경로를 유지한다. 특히 resume·interrupt의 상세 정책은 해당 Runtime Adapter가 판단하며, Quality Loop 독립성 차단을 우회하지 않는다.

## 역사적 검증 집계

`CapabilityEntry.validation`은 `nativeRuns`, `mockRuns`, `unknownRuns`, `lastRunId`만 제공한다. 완료된 task Run을 execute.code/general에 집계한다. native는 출처와 실제 실행 관측이 모두 있어야 한다. Mock과 불완전·과거 출처 기록은 별도 집계한다. model.actual은 실제 assistant 모델 귀속이 관측된 경우에만 집계하며 Mock 관측은 Mock으로 남는다.

집계는 DB 읽기 전용이며 registry 원본, observation, policy, authentication, actualModel, executionAuthorized를 변경하지 않는다. native Run 수는 Quality Loop 통과·모든 기능 검증·모델 신원 확인을 의미하지 않는다. 지원되지 않는 기능의 문서 또는 metadata는 실행 건수로 승격되지 않는다.

## 현재 Claude 설치 조사

PATH·일반 설치 위치·fnm/nvm bin 32개 후보를 읽기 전용으로 재확인했다. 실행파일은 없었고 `findClaude()`는 `CLAUDE_NOT_INSTALLED`였다. 사용자 Applications의 Claude Code URL Handler 실행 링크도 대상이 없어 실행 불가능했다. 조사 범위 밖의 설치 가능성은 배제하지 않는다. 인증파일·환경의 비밀 값·로그인·설치·모델 호출은 수행하지 않았다. 따라서 Claude 실제 실행과 현재 설치 버전의 flag 지원은 검증되지 않았다.
