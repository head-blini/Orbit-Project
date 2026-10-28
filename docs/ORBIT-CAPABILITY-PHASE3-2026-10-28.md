# Capability Orchestration Phase 3 — 실제 Provider 연결 및 증거

## 범위와 재개 기준

기준 커밋 `1651cd55f0b1371a5dfbdc751f4073a7c007d77d`. 기존 Registry, Discovery, Router, Planner, 승인 digest, Controller/ClaudeTaskService, Quality Loop, DB, HTTP, 간편·고급 진행판을 재사용한다. 실행 엔진을 추가하지 않는다. 분석 → 계약 확인 → 구현 → 영향 테스트 → 회귀 검증 → 로컬 커밋 순서다.

**실제 모델 실행 승인 대기.** 이 작업은 모델 호출, 외부 설치, 인증 변경, Push, 배포, main 병합을 승인하지 않는다. 실제 작업 하나가 전체 파이프라인을 통과해야 하는 최종 수락 조건은 미충족이다. Mock 통과를 이 조건의 증거로 사용할 수 없다.

## 구현

- Codex 공식 App Server `thread/start`·`turn/start`·`turn/interrupt`는 기존 Controller/Runtime Adapter를 통해 실행한다. Claude 공식 `-p --output-format stream-json` 경로는 기존 ClaudeTaskService에 연결되어 있다.
- Claude 실제 task/review runner는 프롬프트 전송 전에 `claude auth status`를 확인한다. `claude.ai` 구독 인증만 허용한다. API key/helper, third party, OAuth token만으로는 구독 인증을 확정하지 않는다. 실패/unknown은 실행 전 차단한다. 조회 중 중단도 task spawn을 막는다.
- 인증 조회는 분리된 임시 디렉터리, 제한 환경, 출력 크기/시간 제한으로 실행한다. JSON allowlist만 반환하며 이메일·조직·인증 경로·원시 stderr는 저장하지 않는다. 진단 캐시는 실행 승인이 아니며 실행 시 별도로 재확인한다.
- `GET /api/capability-orchestration/readiness`는 캐시 조회만 한다. 명시적 `POST .../readiness/refresh`는 기존 session/CSRF 및 실행 가드를 적용해 버전과 호환되는 Claude 인증을 조회한다. Provider 연결이나 모델 호출을 자동 시작하지 않는다.
- 실제 factory와 주입된 mock의 출처를 `run.runtime_source`에 저장한다. Claude는 종료/dispatch 관측도 별도로 저장한다. 기존 기록의 출처는 unknown이다. 정제된 응답 SHA-256, 종료 관측, Quality Loop 상태를 읽기 projection으로 진행판에 연결한다.
- 모델의 `source=native_observed`와 실행의 `evidenceSource=native/mock/unknown`은 다른 근거다. mock으로 주입한 리뷰가 실제 Provider 검증으로 승격되지 않는다. live 전체 통과는 실제 producer, 실제 review/repair, 완료된 실행, 기존 독립 리뷰와 로컬 검증 통과가 모두 필요하다.
- 사용자 선택·요청·서버 설정 모델은 실제 모델로 복사하지 않는다. Codex actual unknown 및 독립성 차단은 그대로다.
- PID가 있는 Claude process error는 spawn 실패로 단정하지 않고 종료 미확인으로 격리한다. 기존 중복 방지·재시작 recovery를 유지한다. quota event의 비정상 날짜·이름·상태·개수도 정제한다. 사용률 관측은 비용이 아니며 관측되지 않은 비용/잔여량은 null이다.

## 지원·미지원 구분

[Provider 계약과 유형별 matrix](ORBIT-CAPABILITY-PROVIDER-CONTRACTS-2026-10-28.md)를 따른다. discovery / invocation / verification은 서로 대체할 수 없다.

| 기능 | 연결된 실행 경로 | 실제 실행 검증 |
|---|---|---|
| Codex 저장 작업 | App Server → Controller → 기존 승인/DB/Quality Loop | 미실행, 승인 대기 |
| Claude 저장 작업 | print/stream-json → 구독 auth preflight → 기존 승인/DB/Quality Loop | CLI 미발견, 승인 대기 |
| 실제 slash command | 임의 문자열을 명령 실행으로 간주하지 않음 | 미지원 |
| Skill | 기존 metadata discovery, 호출 정책 차단 | 미검증·자동 호출 미지원 |
| MCP | 기존 discovery, strict/격리 정책 유지 | 외부 호출 미지원 |
| Hook | lifecycle 설정 발견과 실행을 분리 | 직접 호출 미지원; managed hook 안전성 미검증 |

## 실제 검증 절차 — 승인 전 실행 금지

1. 사용자가 **Provider, 격리된 작업 폴더, 전송할 고정 프롬프트/파일, 최대 실행 횟수와 중단 시간**을 승인한다. 외부 설치와 로그인 변경은 별도 승인이다. 설치되지 않은 Claude는 자동 설치하지 않는다.
2. 준비 상태에서 설치 버전/호환성과 구독 인증을 확인한다. 인증파일을 열거나 출력하지 않는다. managed hooks/MCP/helper 등 조직 설정의 영향이 배제되지 않으면 작업을 실행하지 않는다.
3. 민감정보 없는 테스트 프로젝트에 저장 작업 하나를 준비한다. 예: `result.md에 ORBIT_NATIVE_SMOKE 한 줄을 작성한다`. 승인된 경로 이외 파일 접근/설치/네트워크 작업을 요청하지 않는다.
4. 자연어 요청 → 기존 기능 추천 → 계획 생성 → 정확한 digest에 대한 승인 → Provider 작업 1회 실행. Codex의 기존 120초 timeout과 중단 경로를 사용한다. Claude 일반 작업은 자동 실행시간 제한이 없으므로 승인된 시간 안에 감독자가 중단해야 하며, Quality Loop/기획의 별도 timeout과 혼동하지 않는다. 응답이 불확실하면 새 요청 ID로 재시도하지 말고 기존 기록을 복구한다.
5. 실행 ID, Provider 인터페이스, native 출처, turn/exit 근거, 결과 digest, 모델의 네 가지 근거를 DB/진행판에서 확인한다. 재시작 후 GET은 재실행하지 않아야 한다. 원시 인증·개인정보는 보고서에 포함하지 않는다.
6. 별도 승인된 독립 reviewer가 **실제 관측 모델**로 입증될 때 기존 Quality Loop를 시작한다. Codex actual unknown이면 차단이 정상이며 전체 통과로 보고하지 않는다. reviewer/repair 횟수는 승인 범위에 포함해야 한다.
7. 기존 acceptance 검증과 Quality Loop 모두 통과하고 `providerEvidence.livePipelineVerified=true`인 기록만 실제 전체 파이프라인 통과 증거다. Mock 기록은 따로 보고한다.

## 공식 근거

- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server): 프로그램 실행, 계정/usage/rate limit 계약. 설치 버전의 오프라인 schema와 별도로 확인한다.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): print mode, auth status JSON, restricted/permission flags.
- [Claude headless](https://code.claude.com/docs/en/headless): 프로그램 실행 및 bare 제한. bare로 구독 인증을 무음 변경하지 않는다.
- [Claude hooks](https://code.claude.com/docs/en/hooks): managed hook은 일반 설정 비활성화만으로 격리를 증명할 수 없다.

## 검증 및 남은 작업

영향 테스트와 전체 검증의 최종 수치는 아래 완료 기록에 갱신한다. 실제 모델 호출은 0회이며 실제 전체 E2E 완료를 주장하지 않는다. 로컬 `--version` 탐색에서 2026-10-28 Node24 PATH의 Codex `0.165.0`, Homebrew Codex `0.162.1`, Claude `not_found_on_path`를 관측했다. 실행 환경 PATH에 따라 선택되는 바이너리가 다르므로 이전 0.162.1 기록을 다른 설치 경로에 재사용하지 않는다.

### 검증 진행 기록

- 1차 전체 `npm run verify`: 1347 tests / 1345 pass / 0 fail / 2 Windows-only skip, 타입·빌드 통과 (`/tmp/orbit-phase3-verify.log`).
- Codex0.165.0 추가 후 전체: 1350 tests / 1348 pass / 0 fail / 2 skip, 타입·빌드 통과 (`/tmp/orbit-phase3-final.log`).
- 모의 Chrome 준비 상태 검사: 자동 POST 없음, 명시 진단, 연속 클릭 방지, 연결 상태 변경 후 cached GET, 실제 모델 unknown 확인. 재현 파일 `tests/native-readiness.browser.cjs`.
- 최종 리뷰에서 Claude auth await 이후 경로 교체 경합을 찾아 수정했다. 작업·기획·리뷰 모두 실행 직전 기존 경로/승인 기준을 재검증한다. 정상 경로 통과, 인증 대기 중 디렉터리 및 심볼릭 링크 교체 차단을 재현·검증했다. 기획의 기존 spawn wrapper가 auth를 mock으로 오인하는 연결 문제는 bounded output observer로 수정했으며, oversized 출력에 따른 이전 기획 채택 회귀를 실패 테스트로 재현한 뒤 차단했다. 실행 전 차단과 종료 미확인, timeout 원인을 구분한다.

### 변경 파일 범위

- 실행·인증: `server/runtimes/claude-code.ts`, `server/runtimes/claude-task.ts`, `server/claude-task-service.ts`, `server/claude-planning.ts`, `server/planning-agent-service.ts`, `server/native-readiness.ts`.
- 기존 엔진·증거 연결: `server/codex.ts`, `server/rpc.ts`, `server/controller.ts`, `server/quality-loop-native.ts`, `server/capability-execution.ts`, `server/provider-evidence.ts`, `server/capability-runtime-adapters.ts`, `server/http.ts`.
- 계약·진행판: `shared/native-readiness.ts`, `shared/provider-evidence.ts`, `shared/capability-execution.ts`, `shared/quality-loop-record.ts`, `web/native-readiness.tsx`, `web/capabilities.tsx`, `web/capability-execution.tsx`.
- 증거: 신규 auth/readiness HTTP/provider evidence/UI/Codex schema 테스트와 fixture, 기존 Controller/Claude/기획/Quality Loop/HTTP 테스트 보강, 모의 Chrome 스크립트. 전체 파일 목록은 이 문서를 포함하는 로컬 커밋의 `git show --stat`으로 재현한다.

### 최종 완료 기록

Node24.22.1 `npm run verify` **exit 0: 1358 tests / 1356 pass / 0 fail / 2 Windows-only skip**, TypeScript·build 통과 (`/tmp/orbit-phase3-release.log`). `git diff --check` 통과. 새 준비 상태 모의 Chrome 검사와 기존 `tests/capability-execution.browser.cjs` 회귀 검사 모두 exit0. 실행 중단·중복·재시작·Provider 장애/전환·인증 실패·quota·비밀정보 정제는 모의 Provider 검사이며 실제 환경 성공 증거가 아니다.

실제 검증은 Codex 두 경로의 version, 0.165.0의 schema 및 제한 flag 수락까지다. Claude auth/작업과 Codex 모델 작업은 호출하지 않았다. 실제 전체 파이프라인 1건 통과는 **미완료/승인 대기**. 설치·로그인 변경·외부 확장 실행·Push·배포·main 병합 없음. 관리 설정과 실제 인증/한도/중단 동작은 실환경에서 아직 확인되지 않았다.
