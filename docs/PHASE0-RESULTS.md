# Phase 0 — Codex-only 검증 결과

검증일: 2026-10-25 (Asia/Seoul). 실제 프롬프트 실행 시작: 2026-10-25T05:17:39.469Z.
범위: `AGENTS.md`, `prompts/PHASE0-CODEX-ONLY.md`의 로컬 연결 스파이크. Phase 1 미착수.

## 결론과 게이트

**기존 ChatGPT 로그인으로 인증된 Codex CLI를 Node 자식 프로세스의 공식 App Server stdio JSON-RPC로 제어할 수 있음을 확인했다.** 세션 생성 → 프롬프트 1회 → 델타 수신 → 실행 중단 → 서버 재시작 → 같은 thread 로드가 성공했다. 별도 API 키나 서비스 설치는 없었다.

이는 로컬 웹 관제센터의 서버 측 통합 경로가 가능하다는 근거다. 브라우저·HTTP/SSE·SQLite·제품 서버는 만들지 않았고 웹 E2E 성공을 주장하지 않는다. 로컬 제어에는 TCP 포트 자체를 열지 않았다. 모델 추론과 사용량 조회에는 기존 Codex가 OpenAI 서비스에 아웃바운드 연결한다. 완전 오프라인 추론이나 모든 네트워크 패킷의 loopback 한정을 검증한 것은 아니다.

**핵심 Codex 연결 스파이크는 성공, 전체 Gate 0은 조건부/부분 충족으로 기록한다.** 기획 envelope와 제공자 계약은 테스트했으나 실제 Markdown importer·승인/Task 변환·피드백 roundtrip, 실제 승인 요청, 쓰기 권한 차단 실험 등은 미검증이다. 이 결과만으로 백로그 전체 완료나 Phase 1 자동 착수를 승인하지 않는다.

## 실제 환경

| 항목 | 관찰 결과 |
|---|---|
| OS | Windows NT 10.0.19045.0, PowerShell |
| Node | v24.22.1 |
| npm | 11.19.1 (`npm.cmd`) |
| Git | 2.56.0.windows.3 |
| Codex | codex-cli 0.164.0 (`codex.cmd`) |
| 설치 진입점 | `C:/Users/lclk1/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js` |
| 로그인 | `codex.cmd login status`: `Logged in using ChatGPT`, exit 0 |
| 공식 account/read | `authType=chatgpt`; 후속 무추론 조회에서 `planType=prolite` |
| Git 시작 상태 | master, 커밋 없음. AGENTS.md·README-START.md·docs/·prompts/ 모두 미추적 |
| 작업 브랜치 | `phase0/codex-only` (orphan). 기존 파일 보존, 커밋/병합/푸시 없음 |
| 추가 의존성 | 없음. 내장 child_process, node:test, TypeScript stripping 사용 |
| 다른 제공자 | Claude/Gemini 설치·연결·실행 안 함. 설치 여부 자체도 조사하지 않아 unknown |

사용자 설명의 GPT Pro와 별개로 CLI가 반환한 구독 식별자는 **`prolite`**다. 이를 임의로 `pro`로 바꾸거나 마케팅 구독 등급과 동일시하지 않았다. 첫 live 실행의 좁은 plan allowlist가 `prolite`를 unknown으로 표시한 사실은 원본 evidence에 남겼고, 설치된 스키마 enum을 확인한 뒤 **프롬프트 없이** account/read만 재조회했다. 모든 Pro 변형에서 동일하게 된다는 보장은 하지 않는다.

현재 샌드박스에서는 Codex가 홈을 찾지 못했다. 정상 사용자 환경에서 허용받아 실행하자 로그인/추론이 성공했다. 제품 프로세스도 공식 CLI가 사용하는 정상 사용자 홈·실행 환경을 유지해야 한다. 인증 경로를 새로 만들거나 인증 파일을 복사하는 해결책은 사용하지 않았다.

## 실제 기능 검증

| 기능 | 결과 | 근거·한계 |
|---|---|---|
| App Server 실행 | 성공 | Node spawn, shell=false, windowsHide=true, `app-server --listen stdio://` |
| 초기화 | 성공 | initialize 응답 후 initialized 통지; experimentalApi=false |
| thread/start | 성공 | OS 임시 Git 저장소, read-only, on-request, user reviewer |
| turn/start | 성공 | 안전한 짧은 메시지 1회. 도구·파일 읽기·변경 금지 및 숫자 응답 요청 |
| 이벤트 스트리밍 | 성공 | item/agentMessage/delta 3개; turn/started·item 이벤트 관찰 |
| 실행 중단 | 성공 | 첫 델타 시 turn/interrupt, 응답 성공 후 turn/completed.status=interrupted |
| 상태/검증 분리 | 성공 | 실제 execution=interrupted, verification=not_run. 모델 응답을 테스트 성공으로 변환 안 함 |
| 프로세스 종료 | 성공 | 최초·재개 App Server 모두 exit 0, signal=null |
| 세션 재개 | 성공(범위 제한) | 새 App Server initialize → thread/resume(excludeTurns=true), 같은 thread ID |
| 재개 후 대화 생성 | 미실행 | 단일 프롬프트 제한 준수. resume는 저장된 thread 로드이며 중단된 생성 재가동이 아님 |
| 정상 완료(completed) | fixture만 통과 | 실제 turn은 interrupted. 정상 완료라고 보고하지 않음 |
| 모델/API 오류 종료 | fixture만 통과 | 실제 오류 유발·재시도 안 함 |
| 강제 crash/실행 중 재연결 | fixture 일부만 통과 | 자식 프로세스 exit 7, pending RPC 거절 검증. 실제 Codex는 정상 종료 후 재개만 검증 |
| 승인 요청 | 인터페이스 확인, 실서비스 미검증 | 실제 서버 요청 0건. 명령/파일 변경 decline 및 권한 미부여 fixture 통과 |
| 임시 저장소 보존 | 성공 | git init exit 0, 실행 전후 git status --porcelain 동일, 조회 exit 0 |
| OS 파일 쓰기 차단 | 미검증 | read-only를 요청했지만 쓰기 시도를 유발하지 않았으므로 강제 차단 실험은 아님 |
| 경로 검증 | 로컬 단위 테스트 성공 | 기존 하위 디렉터리 허용, 상위/형제/없는 경로/junction escape 거절. TOCTOU 방어는 미구현 |
| 웹 관제센터 HTTP/SSE | 미구현·미검증 | 다음 단계 후보이며 이번에 서버/브라우저를 만들지 않음 |

실제 thread/turn 식별자와 이벤트 종류별 개수는 `spikes/phase0/evidence.json`에 있다. 원문 이벤트, 이메일, 인증 응답 전체, stderr는 기록하지 않았다. 설치된 사용자 설정을 수정하지 않았으며 `mcpServer/startupStatus/updated` 알림 6개를 관찰했다. 이를 MCP 도구 실행 성공이나 별도 제공자 연결 검증으로 해석하지 않는다. 제품에서는 기존 확장의 자동 시작 범위를 따로 제한해야 한다.

## 승인·사용량 인터페이스

공식 [Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)와 **설치 버전에서 생성한 JSON Schema**를 함께 확인했다. 현재 CLI help는 App Server와 스키마 생성을 experimental로 표기한다. 최신 웹 문서와 설치 버전이 다를 수 있으므로 설치 스키마를 우선하는 호환성 시험이 필요하다.

- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`: 서버가 request ID를 가진 RPC를 전송하며 `decision: decline`으로 기본 거절. 세션 전체 승인·정책 확대 자동 수락 없음.
- `item/permissions/requestApproval`: `permissions: {}`, `scope: turn`으로 권한 미부여. 알려지지 않은 서버 요청은 JSON-RPC -32601 오류로 닫는다. 모든 서버 요청에 일괄 decision을 보내지 않는다.
- `account/read(refreshToken=false)`: 인증 방식과 구독 유형만 선택. 이메일·기타 계정 필드는 출력/저장하지 않는다. 로그인·로그아웃·토큰 전달 RPC는 실행하지 않았다.
- `account/rateLimits/read`: 실제 성공. 서버의 사용률·window·reset 값을 확인했다. 계정별 수치는 로컬 evidence에만 남기고 기준 커밋에서는 제외한다. 단일 시점 스냅샷이며 전체 잔여 토큰이나 무제한을 뜻하지 않는다.
- `account/usage/read`: 실제 성공. lifetimeTokens, peakDailyTokens, currentStreakDays, longestStreakDays, longestRunningTurnSec를 확인했다. 계정 집계값이며 이번 프롬프트의 토큰 수나 청구액이 아니다. 실제 수치는 기준 커밋에서 제외한다.
- `account/rateLimits/updated`: 실제 알림 1개 관찰. `thread/tokenUsage/updated`는 이번 실행에서 관찰하지 못했으므로 turn 토큰 사용량은 unknown.

미지원과 미검증은 다르다. 이번에 RPC가 unsupported로 거부된 기능은 없었다. 라이브 승인·turn 토큰·웹 연결 등은 **unknown/unverified**로 남겨야 하며 unsupported로 단정하면 안 된다. 정확한 비용, 구독 청구액, 모든 계정 유형 호환, 모델 카탈로그는 미검증이다.

## 실행 명령과 종료 코드

연속 PowerShell 명령의 래퍼 exit와 개별 명령 결과를 구분했다.

| 실행 | 결과·exit code |
|---|---|
| `[System.Environment]::OSVersion.VersionString`, `node --version`, `git --version` | 위 환경 값, 정상. 묶음 래퍼 exit 0 |
| `npm --version`, `codex --version`, `codex app-server --help`, `codex login status` | PowerShell .ps1 실행 정책 오류. native 프로세스 미실행; 묶음 래퍼는 0이어서 성공 근거로 사용 안 함 |
| `npm.cmd --version`, `codex.cmd --version`, `codex.cmd app-server --help` | 버전/help 확인, 묶음 exit 0. Codex는 샌드박스에서 home 경고 발생 |
| `codex.cmd login status` (샌드박스) | home 디렉터리 오류; 개별 native exit 미수집, 명시적 실패로 분류 |
| `codex.cmd login status` (정상 사용자 환경) | exit 0, ChatGPT 로그인 |
| `git log -1 --oneline` | 최초 커밋 없음 오류. 개별 native exit 미수집(묶음 래퍼 0), 실패로 분류 |
| `git switch --orphan phase0/codex-only` (샌드박스) | HEAD.lock permission denied; 후속 명령 포함 래퍼 exit 0. 실제 전환은 아래 재시도로 확인 |
| 같은 git switch (허용된 정상 환경) | exit 0, 전용 브랜치 전환 |
| `codex.cmd app-server generate-json-schema --help` | 사용법 확인, 묶음 exit 0 |
| `codex.cmd app-server generate-json-schema --out .phase0-schema` | exit 0, 설치 버전 스키마 생성. home 경고 있으나 생성 성공 |
| `node --test spikes/phase0/contracts.test.mjs` (구현 전) | exit 1, 모듈 미구현으로 실패. 기능 assertion까지 도달한 실패는 아님 |
| 같은 contracts 테스트 (구현 후) | exit 0, 8/8 통과 |
| `node --test spikes/phase0/rpc.test.mjs` (구현 전) | exit 1, 모듈 미구현으로 실패. 기능 assertion까지 도달한 실패는 아님 |
| `node --test spikes/phase0/*.test.mjs` | exit 0, 11/11 통과, 실패/스킵 0 |
| `node --check spikes/phase0/live.mjs` | exit 0, 문법 검사 |
| `node spikes/phase0/live.mjs --one-prompt --codex-entry C:/Users/lclk1/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js` | exit 0, 실제 프롬프트 정확히 1회, 두 App Server exit 0 |
| `node spikes/phase0/account.mjs C:/Users/lclk1/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js` | exit 0, 후속 account 조회, App Server exit 0, 추가 프롬프트 0회 |

단위 시험의 로컬 모의 자식 프로세스 exit 7은 의도된 실패 fixture이며 테스트 자체는 통과했다. CLI 실제 오류로 오인하지 않는다. 검사·문서 열람·스키마 필드 추출·git status/branch 확인 명령도 실행했으며, 인증 파일이나 환경변수 값 열람은 하지 않았다.

## 기존 설계에 필요한 변경

1. `02-TECH-DESIGN.md`의 stdio 우선 구조는 유지한다. Windows에서는 .ps1 정책 변경 없이 설치된 Node CLI 진입점을 shell=false로 실행할 방법과 정상 사용자 홈을 진단한다. 현재 검증 환경만 지원 근거가 있으며 macOS/Linux/WSL은 미검증이다.
2. threadId, turnId, 실행 상태, 검증 상태를 분리하고 **interrupt RPC 수락과 terminal interrupted 이벤트를 별도로 기록**한다. thread/resume는 로드 기능이며 새 turn 전송·이벤트 replay와 같은 의미가 아니다.
3. capability는 단순 boolean 배열 대신 verified/unsupported/unknown 및 근거·CLI 버전·검증 시각을 가진다. `Availability`에는 unknown을 포함하고 not_installed/auth_required와 혼동하지 않는다. 향후 Claude/Gemini 어댑터는 선택적으로 유지한다.
4. 승인 결과는 요청 종류에 따라 분기하고 기본 거절한다. 실제 승인 왕복 검증 전 interactive_approvals를 지원 완료로 표시하지 않는다. 승인 ID·turn·연결 세대·만료·중복 결정 방어를 제품 단계에서 추가한다.
5. quota window, 계정 token activity, turn token usage, 비용을 별도 지표로 저장한다. unknown/null은 0이 아니며, 현재 계정 값의 의미를 임의로 다른 구독에 일반화하지 않는다. `prolite` 같은 공식 enum을 지원한다.
6. 원문 로그 보관보다 메타데이터 allowlist를 기본값으로 한다. 브라우저 이벤트 변환은 별도 검토가 필요하다. 기존 사용자 설정의 MCP/확장 자동 시작을 사용자 승인 범위와 연결한다.
7. SSE replay ledger와 App Server 재개를 분리한다. 브라우저 새로고침은 새 turn을 시작하지 않으며, transport loss는 LOST로 조정한다. 실행 중 실제 crash/recovery 테스트를 추가해야 한다.
8. 기획 POC는 provenance·version·완료 조건을 갖춘 공통 envelope까지만 검증했다. 실제 Markdown/JSON parser·immutable 승인본·해시·Task 변환·feedback은 별도 구현과 검증이 필요하다.

Node+TypeScript는 설치 환경에 적합하다. Fastify/React/SQLite/SSE는 여전히 설계 후보이며 이번 조사로 해당 스택의 실제 동작까지 확인한 것은 아니다.

## 다음 한 개의 좁은 수직 슬라이스 (제안만)

사용자가 다음 단계를 명시적으로 요청하면 **127.0.0.1에만 바인딩한 서버와 최소 브라우저 화면에서, 허용된 임시 저장소의 한 Codex thread에 프롬프트를 보내고 델타·중단 상태를 표시**하는 슬라이스를 제안한다. 서버가 stdio를 소유하고 브라우저는 서버 엔드포인트만 사용한다. Origin/CSRF·실행 ID 중복 방지·SSE cursor·별도 검증 상태를 포함한다. 실제 승인 왕복과 재연결 누락 방지는 추가 Phase 0 검증 항목으로 먼저 보완한다. 이번 작업에서는 시작하지 않았다.

재현 및 파일 안내: [spikes/phase0/README.md](../spikes/phase0/README.md).
