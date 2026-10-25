# Phase 1 첫 번째 웹 슬라이스 — 복구 및 검증 결과

검증일: 2026-10-25, Windows / Asia-Seoul. 기준점 `06ae30f`, 작업 브랜치 `phase1/codex-web-slice`.

범위는 기존 구현의 복구·마무리다. 처음부터 재구현하거나 Phase 2 기능을 추가하지 않았다. 아래 결과는 전체 제품 백로그 완료를 의미하지 않는다.

## 실제 구현 완료

- Node 24 + TypeScript HTTP 서버, React UI, esbuild, 내장 SQLite WAL.
- 서버 소유의 임시 Git 저장소, 읽기 전용 Codex stdio 연결, 기존 ChatGPT 로그인 확인. 임의 프로젝트·CLI 인자는 브라우저에서 받지 않는다.
- 프롬프트 전송·응답 스트리밍·실행 중단·명시적 세션 이어받기.
- Run/event 보존, request ID와 본문 digest에 따른 중복 방지, 진행 중 실행의 LOST 복구, 완료 상태 역행 방지. 검증 상태는 항상 `not_run`이며 모델 응답 완료와 별개다.
- 정확한 loopback Host/Origin, 세션 쿠키·CSRF, 요청 크기 제한, CSP, SSE cursor 재전송과 backpressure 처리.
- 별도 SQLite 단일 인스턴스 잠금으로 데이터 복구 전 소유권 확인. 늦은 interrupt 실패가 다음 Run을 종료하지 않도록 범위 제한.
- MCP 설정 사전 조회 → 각 서버를 thread 시작/복구 시 `enabled=false`로 지정 → 해당 thread의 비활성 상태 확인. 기존 사용자 MCP 설정을 쓰거나 삭제하지 않는다.
- 반환된 샌드박스·네트워크·승인 정책 검증. 격리 또는 정책이 확인되지 않으면 연결을 차단한다. 승인 요청은 거절하고 원문 명령·계정 정보·설정 응답은 앱 로그나 DB에 기록하지 않는다.
- Windows 설치·시작·종료·복구·차단 상황 안내를 README에 보완.

## 실제 테스트 성공

환경: Node `24.22.1`, npm `11.19.1`, Git `2.56.0.windows.3`, Codex CLI `0.164.0`, Chrome.

| 검사 | 관찰 결과 | 종료 코드/판정 |
|---|---|---|
| 복구 시작 시 `npm.cmd run typecheck`, `npm.cmd test` | 기존 32개 테스트 통과 | 각각 0 |
| MCP·정책 회귀 수정 후 타입 검사와 전체 테스트 | 36개 통과. 실제 stdio framing/TRANSPORT_CLOSED/timeout, 중복 제출, LOST, interrupt 지연, SSE backlog, HTTP 보안, instance lock 포함 | 각각 0 |
| `node scripts/verify-mcp-isolation.mjs` | 자격증명 없는 임시 CODEX_HOME. config/read는 MCP를 시작하지 않음. disabled override에서는 시작 marker 없음. enabled 대조군에서는 marker 생성 | 0 |
| `npm.cmd run build` (일반 사용자 환경) | JS/CSS/HTML 생성 | 0 |
| 최종 `npm.cmd run verify` (일반 사용자 환경) | 타입 검사 → 전체 36/36 테스트 → 빌드 연속 통과 | 0 |
| 실제 Chrome 로컬 웹 | 소스 서버를 별도 임시 작업 디렉터리, 별도 DB, 별도 생성 Git 저장소와 loopback 4327에서 실행 | 성공 |
| 첫 웹 요청 | 테스트 문자열 실제 응답 완료 | completed |
| 두 번째 웹 요청 | 숫자가 실제로 증가하며 표시됨. 실행 중 새로고침해도 Run 수 2 유지 | 성공 |
| 실제 실행 중단 | interrupt 요청/수락 및 최종 interrupted 이벤트 확인 | interrupted |
| 서버 종료·재시작 | 종료 시 연결 끊김 안내. 같은 테스트 DB로 재시작 후 기존 2개 Run 복원, 자동 새 요청 없음 | 성공 |
| 세션 복구 | 같은 thread를 명시적으로 이어받고 세 번째 웹 요청 정상 완료 | completed |
| 최종 테스트 데이터 | Run 3개 = completed / interrupted / completed, 서로 다른 request ID 3개, 모두 verification=not_run. session.created 1개, session.resumed 1개 | 성공 |
| SQLite/작업공간 | 테스트 DB quick_check=ok. 생성 저장소의 marker·파일 구성이 그대로 유지됨 | 성공 |
| 기존 DB 보존 | 기존 `.local/control-center.sqlite`, `-wal`, `-shm`의 전후 SHA-256 동일 | 성공 |

웹 시험은 기존 ChatGPT 구독으로 새 프롬프트 3개를 보냈다. 별도 API 키·유료 API를 사용하지 않았다. 새 라이브 시험 서버는 검증 후 종료했다. 원문 RPC·인증 파일·사용자 MCP 명령이나 환경값은 결과물에 포함하지 않았다. 로컬 검증 집계만 Git에서 제외된 `.local/phase1-verification.json`에 보존한다.

기존 `.local/phase0-supplement.json`에는 정상 완료, 실제 승인 요청 1건의 기본 거절, 실행 중 App Server 종료, 같은 thread 복구(프롬프트 재전송 없음), 작업공간 불변 결과가 있다. 이는 **이전 보완 시험의 증거**이며 아래의 현재 제한 모드와 동일한 시험으로 취급하지 않는다.

## 테스트 실패와 처리

- 복구 전 RPC 시험은 2/3 통과, `TRANSPORT_CLOSED`로 실패한 뒤 이전 세션에서 fixture의 응답 프레임 interleaving을 수정했다. 현재 전체 테스트에 포함하여 통과를 확인했다.
- 추가한 사전 MCP 차단·설정 조회 실패·정책 불일치 회귀 3개는 기존 코드에서 실패한 것을 확인한 후 수정했다.
- native MCP 목록은 비활성 서버도 `runtimeStatus=disabled`로 반환한다. 처음의 무조건 빈 목록 조건은 실패했다. 알려진 서버의 명시적 비활성 상태와 빈 도구 목록만 허용하도록 회귀 테스트를 먼저 추가하고 수정했다.
- 자격증명 없는 native 시험에서 turn 없이 만든 thread의 resume은 `no rollout found`로 실패했다. 해당 시험에서는 미검증으로 남겼으며, 실제 turn이 있는 thread의 서버 재시작·resume은 웹 시험으로 별도 확인했다.
- 제한된 실행 샌드박스에서는 esbuild의 상위 경로 탐색이 Access denied로 실패했다. 동일 소스의 일반 사용자 환경 빌드는 통과했다. 보안 정책을 변경하지 않았다.
- 테스트 서버의 Ctrl+C 종료에서 실행 도구가 반환한 코드가 1이었다. 실제 연결 종료·동일 DB 재시작·복구는 확인했지만 **정상 종료 코드 0은 확인하지 못했다**.

## 미검증 및 안전 제한

- 최종 도구 제한 모드에서 실제 승인 요청을 새로 유발하지 않았다. 승인 허용 UI는 없고, 거절 응답은 production RPC와 fixture로 검증했다. 승인 요청을 만들기 위해 shell/MCP 권한을 다시 열지 않았다.
- 실행 중 앱 서버를 강제 종료하는 최신 웹 E2E는 미실행이다. 현재 오프라인 LOST 복구 테스트와 이전 native 프로세스 종료 증거를 구분한다.
- 연결 도중 다른 프로그램이 Codex 설정을 바꾸는 경우의 원자적 격리, 모든 관리 정책·플러그인 조합·Codex 버전은 미검증이다. 설정 변경과 앱 연결을 동시에 수행하지 않아야 한다. 알 수 없는 목록/정책은 연결 차단으로 처리한다.
- Windows OS 샌드박스의 모든 파일·네트워크 공격면이나 임의 비밀 문자열에 대한 완전한 탐지 보장은 하지 않는다. 이 버전은 생성된 읽기 전용 테스트 저장소와 텍스트 응답에만 사용한다.
- macOS/Linux/WSL, 실제 사용자 프로젝트 쓰기, 다른 제공자·인증 유형, 장시간/다수 사용자 부하는 미검증이다.

## Phase 2로 넘길 항목 — 이번에 구현하지 않음

- 기획안 import·승인·Task 변환, diff·테스트 실행기와 사용자 완료 승인.
- 사용자 프로젝트 등록·쓰기 권한, 승인 허용 UI, 다중 프로젝트·다중 제공자.
- 코드 그래프·MCP 관리 UI, 장시간 데이터 정리 정책, 광범위한 OS/버전 호환.
- 다른 탭에서 새 thread ID를 즉시 동기화하는 UI 개선(새로고침으로 현재 상태 확인 가능).

## Git 포함/제외

포함 후보: README, Phase 1 계획·결과, 패키지 manifest/lock, TypeScript 설정, `server/`, `shared/`, `web/`, `tests/`, 빌드·MCP 검증 스크립트, 보존된 Phase 0 supplement 소스.

제외: `.local/` 전체(DB/WAL/SHM/검증 집계/생성 schema), `.phase0-schema/`, `dist/`, `node_modules/`, 인증·환경 파일, 원본 evidence와 로그. 기존 기준 커밋은 유지한다. 최종 커밋 전 실제 인덱스 목록과 제외 규칙을 다시 확인한다.

커밋 전 소스 후보는 기존 24개와 README·native MCP 검사 스크립트·이 결과 문서를 합친 27개다. 알려진 키/JWT/개인키 패턴 검사에서 실제 비밀 의심 항목은 없었고, `tests/core.test.ts`의 명시적 가짜 키 fixture만 검출됐다. 이는 임의의 모든 민감정보가 없다는 보장은 아니며, 계정·원문 evidence·DB를 포함하지 않는 경로 제한과 함께 적용했다. 검증용 서버·Codex·MCP 프로세스가 남지 않은 것도 확인했다.

## 최종 읽기 전용 검토

독립 검토 결과 Critical/Important 지적 없음. 검토자가 Phase 1 테스트 25개와 타입 검사를 독립 실행하여 종료 코드 0을 확인했다(전체 36개에는 Phase 0 테스트 11개가 추가됨). 다른 탭의 thread ID 표시 갱신은 Minor로 후속 처리한다. 검토자는 실제 라이브 시험을 재실행하지 않았으며, native marker/Chrome 결과는 이 문서의 실행 증거를 근거로 한다. 최종 문서 문구 자체는 독립 검토 대상에 포함되지 않았다.

## 공식 인터페이스 근거

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): config/read, thread start/resume, thread-scoped MCP 목록, turn/interrupt.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): `mcp_servers.<id>.enabled`로 설정을 삭제하지 않고 비활성화. 실제 설치 버전에서의 적용은 별도 native marker 시험으로 검증했다.
