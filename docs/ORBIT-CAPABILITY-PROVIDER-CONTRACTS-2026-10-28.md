# Capability Provider Runtime 계약 — 2026-10-28

## Phase 3 추가 확인

Node24 PATH의 Codex는 **0.165.0**, `/opt/homebrew/bin/codex`는 **0.162.1**이다. 서로 다른 바이너리를 동일 설치로 간주하지 않는다. 0.165.0의 오프라인 JSON schema·핵심 요청·제한 flag를 확인해 정확한 두 버전만 허용한다. `tests/fixtures/codex-0.165.0-contract.json`은 원본 SHA-256과 schema/flag 투영이며 실제 모델 실행 증거가 아니다. 모델 식별 관련 19개 projection은 0.162.1과 동일하고 actual unknown 유지.

Claude `auth status` 공식 JSON은 `loggedIn`, `authMethod`를 제공한다. Orbit은 구독 `claude.ai`만 허용하며 API key/helper·third-party·OAuth token만으로 구독을 추정하지 않는다. 현재 Claude는 PATH 미발견으로 **실제 auth status 검증도 미수행**이다. 인증 preflight·오류·한도·중단 처리는 Mock으로 검증했다. 자세한 구현과 승인 절차는 [Phase 3](ORBIT-CAPABILITY-PHASE3-2026-10-28.md)에 기록한다.

## Phase 2 확인 범위

공식 문서 조회와 로컬 `codex --version`만 수행했다. `/opt/homebrew/bin/codex`의 결과는 `codex-cli 0.162.1`이었다. Claude는 PATH 및 `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.local/bin/claude`에서 발견되지 않았다. 인증파일, 실모델, 설치, 유료 API, 사용자 MCP/Hook은 호출하지 않았다. 아래 문서 지원과 Orbit 구현 지원 및 실제 실행 검증은 서로 다르다.

## 공식 인터페이스와 버전

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): initialize/initialized, thread/start 또는 resume, turn/start, turn/interrupt와 item/turn 이벤트를 사용하는 프로그램 실행 계약. `generate-ts`/`generate-json-schema`는 실행한 CLI 버전의 스키마를 생성한다. 최신 웹 문서에 있는 메서드를 이전 설치 버전이 지원한다고 추론하지 않는다. Orbit은 기존 Controller와 0.162.1 계약을 재사용한다.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): `-p`, `stream-json`, `--resume`, `--model`은 프로그램 실행 인터페이스다. 현재 Orbit의 `--restricted`는 2.1.248 이상, `--permission-prompts none`은 2.1.259 이상 필요하다. 따라서 최소 버전은 2.1.259다. `--disable-slash-commands`는 skills와 commands 모두 비활성화한다. `--strict-mcp-config`는 명시 MCP 설정만 사용하는 옵션이다.
- [Claude 프로그램 실행](https://code.claude.com/docs/en/headless): `-p`는 일반 설정에서 hooks/MCP를 자동 로드할 수 있다. `--bare`는 자동화를 위한 옵션이지만 구독 OAuth를 사용하지 않으므로 기존 구독 경로를 이에 무음 전환하지 않는다.
- [Claude Hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks): `disableAllHooks`도 관리 정책 hooks를 무조건 끄지는 못한다. `--restricted`는 managed settings를 유지하므로 모든 hooks가 차단되었다는 증거가 아니다. 관리 설정의 안전성은 실환경 검증이 필요하며 이 구현은 이를 확인했다고 주장하지 않는다.

## 기능별 구분

Registry의 `discovery`, `invocation`, `verification`은 **현재 Orbit Adapter의 구현 상태**이며 실제 Provider 성공 관측이 아니다. 기존 `observation`, `policy`, `evidence`와 별도로 판단한다. 발견 가능한 기능도 호출 구현이 없거나 정책이 차단할 수 있다.

| 유형 | 공식 discovery/invocation | 현재 Orbit | 검증 조건 |
|---|---|---|---|
| Codex 작업 | App Server thread/turn API | 기존 Controller.submitTask 재사용 | turn/item 종료와 저장된 실행 증거; Quality Loop 별도 |
| Claude 작업 | print mode, stream-json | 기존 ClaudeTaskService 재사용 | 구조화 결과·프로세스 종료; Quality Loop 별도 |
| Codex skill | skills/list, turn/start의 skill input | 목록만, invocation 차단 | instruction 수락과 결과 정확성은 별개; 실제 실행 미검증 |
| Codex hook | hooks/list, lifecycle | 목록만, 임의 실행 없음 | 동기 hook/started·hook/completed는 문서상 제공; 비동기는 해당 알림 미보장 |
| Codex MCP | thread-scoped mcpServerStatus/list, tool/call 계약 | 목록만, 실행 차단 | 도구의 실제 결과와 권한·전송 범위 검증 필요 |
| Claude skill/slash | CLI skills/commands 계약과 설정 | disable-slash-commands로 비활성화, discovery unknown | 실환경 검증 없음 |
| Claude hook | 설정과 lifecycle | discovery unknown, 직접 호출 미구현 | managed hooks 예외 별도 확인 필요 |
| Claude MCP | mcp-config | 빈 strict 설정 유지, 실행 차단 | 관리 정책 영향 및 실환경 검증 없음 |
| 임의 slash | UI 명령 존재는 프로그램 호출 계약이 아님 | 임의 CLI 입력 전달 금지 | 모델 응답/종료를 명령 실행 성공으로 간주하지 않음 |

Codex 관련 세부 인터페이스 출처는 위 공식 App Server 문서다. Registry의 실행·기획·리뷰 verification 구현 표시는 기존 검증 수집 경로가 있다는 뜻이다. 실제 모델 증명이나 독립 교차 리뷰의 통과를 뜻하지 않는다. 실제 모델 unknown 및 기존 Quality Loop 차단을 유지한다.

## 등록·호환·갱신 계약

`CapabilityRuntimeAdapters`는 검토된 서버 코드가 `register(definition,{trusted:true})`로 지원 기능·호환 판정·실행 함수를 등록하는 in-process registry다. HTTP 등록, 파일 경로 로딩, 외부 코드 다운로드, 자동 설치는 제공하지 않는다. `trusted`는 원격 사용자 입력을 받아 신뢰로 승격하는 기능이 아니며, 서버 통합 코드의 명시적 신뢰 경계다. 기본 실행 함수는 기존 Controller.submitTask를 사용한다. 검토된 등록 구현도 Controller 실행 소유권·정책·journal을 유지해야 하며, Planner는 반환 Run이 원래 dispatch request와 승인 task/baseline의 영속 receipt인지 검사한다. 제3자 runtime ID는 현재 미지원이다.

기본 호환 정책:

- Codex는 검토한 정확한 버전 `0.162.1`만 허용.
- Claude는 `2.1.259` 이상 major 2 안정 버전만 허용. 이는 문서상 인자 호환 범위이며 해당 버전의 실제 실행 성공 증거가 아니다.
- 누락·잘못된 버전·prerelease·미등록·비활성·호환 판정 예외는 fail-closed.
- 새 버전 지원은 검토된 호환 계약 재등록과 검증을 요구하며 유료/다른 Provider fallback은 없다.

snapshot은 `{runtimeId,adapterId,revision,version,compatible,issue,capabilities}`를 반환한다. 조회가 revision을 늘리지 않는다. 등록·교체·비활성·삭제는 revision을 증가시키고, version 변경은 snapshot 자체를 바꾼다. 실행 Planner는 저장한 snapshot 전체와 현재 snapshot을 비교해야 한다. revision은 프로세스 내 값이므로 재시작은 기존 실행 복구/격리 정책을 거쳐야 하며 새 프로세스의 revision 일치만으로 실행 승인을 복원하지 않는다.

dispatch는 최근 정제한 버전이 호환될 때만 등록된 dispatch를 호출한다(기본 submitTask). Codex는 workspaceId를 요구하고 Claude는 workspaceId를 거부하여 기존 Controller 분기에 연결한다. Controller는 프로젝트 실행기 선택·승인·멱등성·정책을 재검사한다. 임의 prompt/slash 인자를 받지 않는다. interrupt는 등록 해제·호환성 변경 이후에도 기존 실행을 중단할 수 있게 Controller 경로를 유지한다.

## 검증 기록

신규 테스트를 먼저 작성해 미구현 모듈 및 새 discovery 필드 부재 실패를 관측한 뒤 구현했다. Node24.22.1에서 `tests/capability-runtime-adapters.test.ts`, `tests/capability-adapters.test.ts`, `tests/capability-routing.test.ts` 총 19개 pass, 0 fail. 이후 실제 구현 교체·기능 갱신·민감 ID 거절 검사도 추가했다. 전부 Mock/로컬 계약 검사이며 실제 Provider 통합 통과가 아니다. 전체 타입 검사는 동시 개발 중 아직 없는 execution service import 때문에 한 차례 실패했으며 최종 통합 담당자가 다시 수행한다.

미검증: Claude 설치·인증·현재 flags 실동작, managed hook/MCP 정책, 모델 실제 관측, 실모델 중단·복구, 독립 교차 검증. 해당 항목의 권한·증거가 없으면 성공으로 승격하지 않는다.

HTTP 서버 통합은 `createHttpServer(...,{runtimeAdapters})`로 신뢰된 인스턴스를 주입할 수 있다. `/api/capability-orchestration`의 `runtimeAdapters`가 현재 계약 snapshot을 노출하며 기존 명시 refresh가 버전 발견을 갱신한다. 원격 등록 엔드포인트는 없다.
