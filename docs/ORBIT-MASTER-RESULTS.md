# Orbit 전체 구현·검증 증거

## 2026-10-25 시작 기준

- 목표 파일을 전체 읽고 기존 로컬 통합 worktree를 우선 확인했다. 기준 HEAD `73ec364`, 브랜치 `integration/orbit-20261025104804486-08592a18`. 기존 통합/UI 변경이 미커밋으로 존재하며 보존한다.
- Windows 10.0.19045, 실행 runtime Node v24.19.0, Git 2.53.0.windows.3, Codex 0.164.0-alpha.11.1. 이 세션 PATH에는 npm이 없으며 기존 설치 의존성의 CLI를 Node로 직접 실행했다. 패키지 설치 없음.
- 실제 사용자 DB/인증정보를 읽거나 앱의 기존 서버를 시작하지 않았다. 테스트의 임시 DB/Git fixture만 사용했다.
- 기존 보고서의 134 테스트와 이번 재실행 결과를 구분한다.

| 명령 (통합 worktree) | exit | 실제 결과 |
|---|---:|---|
| `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 | baseline 타입 검사 통과 |
| `node --test tests/*.test.ts spikes/phase0/*.test.mjs` | 0 | 134/134, fail/skip 0; `orbit-master-baseline-tests.log` |
| `node scripts/build.mjs` (sandbox) | 1 | 기존 esbuild 상위 디렉터리 access denied 재현 |
| `node scripts/build.mjs` (승인된 일반 사용자 실행) | 0 | app.js 296.3kb, app.css 24.3kb 생성; 제품 코드 변경 없이 빌드 통과 |

전체 Goal은 **미완료**다. 실제 browser E2E, 실제 Codex 연결과 코드 생성, 제공자 실서비스, PPTX 등은 이번 시작 기준에서 아직 검증하지 않았다.

## 진행 기록

- 독립 읽기 전용 감사 3개를 실행했다: Planning/Development/Runner, Provider/Security/Extensions/Usage, Visualization/Automation. 공통 수정 소유자는 메인 에이전트다.
- 중요한 발견: 입력 credential detector가 거절하는 합성 credential 형식 일부가 출력 `safeText`에서 가려지지 않는다. 실제 비밀을 읽지 않고 합성값으로 확인했으며 우선 수정 대상으로 지정했다.

## 첫 통합 묶음: 비밀정보 출력 / 승인 Task 실행 / PPTX

- `safeTextItems`는 누적 원문을 메모리에서만 검사하고 credential·PEM span과 각 item 미완성 tail을 같은 좌표계에서 합친다. Controller가 정제 snapshot만 DB/event에 저장한다. 독립 리뷰에서 확인한 cross-item assignment/PEM 문맥 소실은 추가 RED→GREEN으로 수정했다. 유한 패턴 검사이며 모든 비밀값 탐지를 보장하지 않는다.
- 승인 Task 실행은 저장된 current head의 프로젝트·버전·해시·승인 evidence·요구사항 snapshot·미결정 질문을 확인한다. 목표/인수조건/제약을 포함한 4,000자 이하 brief를 서버에서 생성한다. 넘치는 내용은 잘라 보내지 않고 거절한다. Run 생성과 Task/버전 연결을 원자적으로 저장한 다음 기존 Codex submit을 사용한다. uncertain response 후 같은 request는 이미 존재하는 Run을 반환한다. 실행 완료는 여전히 검증 성공이 아니다.
- PPTX는 실제 ZIP/OpenXML 12개 part와 native text/shape/connector를 생성한다. 선택한 저장 Artifact의 project/id/revision/hash를 확인한 보호된 다운로드 경로와 Markdown 다운로드를 연결했다. 수정한 원문은 먼저 저장해야 한다.

| 실제 실행 | exit | 결과 |
|---|---:|---|
| Task HTTP 신규 회귀 최초 실행 | 1 | 3/3 실패, 실행 endpoint 부재(404) 확인 |
| Task HTTP + Controller 집중 실행 | 0 | 16/16; uncertainty·멱등성·현재 head·미결정·CSRF·프로젝트 gate |
| interleaved incomplete AKIA Controller 회귀 | 1 → 0 | 원문 prefix 저장 재현 후 각 item boundary 처리로 수정 |
| 출력 모듈 집중 회귀(독립 담당 최종) | 0 | privacy/core/controller/task-runs/provider 44/44 |
| Artifact export HTTP 최초/수정 후 | 1 → 0 | endpoint 부재 및 Mermaid direction extra field 연결 오류 수정; 고정 버전 bytes·ownership/hash 검증 |
| `node --test tests/studio-ui.test.ts tests/studio-integration.test.ts tests/task-runs.test.ts tests/controller.test.ts tests/pptx.test.ts` | 0 | 32/32; `orbit-master-slices.log` |
| `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 | 위 통합 이후 타입 검사 |
| PPTX 독립 Python zipfile/XML/python-pptx | 0 | ZIP CRC·12 XML/관계, 한글 text 수정·도형 이동·저장·재열기·connector endpoint 보존 |
| Windows E2E 첫 실행 | 1 | 기존 agent-browser 설치가 PATH에 없어 CLI 발견 실패. `.local/ui-e2e/run-2026-10-25T13-13-53-871Z-ok8erJ/` |
| Windows E2E 설치경로만 PATH 추가 후 | 1 | CLI/정적/타입 통과; 병행 개발 중이던 provider transport 신규 RED 테스트로 전체 검사 실패. 브라우저 단계 미도달. `.local/ui-e2e/run-2026-10-25T13-14-42-080Z-r7vpap/` |

독립 PPTX 산출물: `C:/Users/lclk1/AppData/Local/Temp/orbit-pptx-evidence/editable-korean.pptx`, `C:/Users/lclk1/AppData/Local/Temp/orbit-pptx-evidence/edited-roundtrip.pptx`. 실제 PowerPoint GUI와 full OOXML XSD 검증은 아직 실행하지 않았다. 독립 담당의 병행 전체검사 161/161 기록은 최종 통합 기준의 전체검사를 대신하지 않는다.

다음 진행: transport/verification 모듈 구현과 통합, PPTX 저장 validator 정합성 리뷰 보완, 안정된 소스에서 전체 검사와 E2E 재실행. 전체 Goal 미완료.

## 중간 통합 검사와 사용자 추가 요구

- `.local/ui-e2e/run-2026-10-25T13-20-18-395Z-YX4C99/`: 타입 exit0, 전체 **194/194 exit0**, build exit0. 임시 Git fixture가 긴 Windows 경로에서 `Filename too long` exit128로 실패해 browser 단계에 도달하지 못했다. 전역 longpaths 설정을 바꾸지 않고, 소유 marker가 있는 짧은 OS temp evidence root를 쓰도록 E2E harness를 수정 중이다.
- HTTP transport는 native Node HTTP(S)로 models/text SSE, 정책 callback, endpoint/DNS pinning, redirect 거절, unknown usage와 취소/제한을 구현한 **미연결 모듈**이다. 기존 mock UI를 실제 연결 성공으로 바꾸지 않았다. 독립 리뷰에서 final text yield 뒤 취소가 done으로 이어지는 결함을 찾아 보완 중이다. 실서비스·실제 외부 DNS/TLS·Bedrock는 미검증/미구현이다.
- verification도 기존 Runner process/policy의 해시 동일 복사본을 재사용하는 **미연결 모듈**이다. 실제 Node 명령 fixture 9/9에서 exit/timeout/interrupt/stale/마스킹을 검증했다. 사용자 승인 config·DB evidence·HTTP/UI 연결은 아직 없다. Codex sandbox와 별도인 로컬 OS 실행 권한을 가진다.
- PPTX 저장/UI validator와 exporter의 geometry/XML 제한 차이를 수정했고, Visualization+PPTX **27/27 exit0**으로 확인했다.
- 최신 사용자 지시에 따라 지금 범위의 전체 검증을 우선하고, 이후 공식 Capability Registry와 Solo/Cross Review/Debate/Race/Cooperate/Goal 모드로 확장한다. 전체 설계 완성 목표를 대체하지 않는다. 현재 공식 문서 조사는 읽기 전용으로 진행한다.

## 현재 개발 범위 검증 종료 (Capability 작업 전)

- 최종 전체 검사 `node --test tests/*.test.ts spikes/phase0/*.test.mjs`: **196/196, exit0**, fail/skip 0. 증거 `orbit-master-final-tests.log`. HTTP transport 취소/deadline 회귀 2개 포함. 타입 검사에서 테스트 generator.return 인자 누락을 수정한 뒤 `tsc --noEmit` exit0, transport 20/20 exit0.
- Windows browser E2E: **18단계 exit0**, 12개 메뉴 × 2해상도 **24 PNG**, refresh/restart 후 기획·Task·Artifact 복구, 원본 Git fixture 보존. 해당 E2E snapshot의 typecheck/전체194/build 모두 exit0. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-qGLnOx`; 세부는 ORBIT-E2E-RESULTS.md. 메인 에이전트가 planning 1366×768과 visualization 1744×864 PNG를 직접 확인했다.
- 같은 fixture 저장 Artifact의 HTTP export: PPTX **12713 bytes**, Markdown **213 bytes**, 모두 HTTP200/attachment. ZIP 필수 entry와 Markdown 원문/버전 확인 exit0; `http-export-check.json`, `http-exports/`에 보존.
- **실제 브라우저 파일 저장은 실패/미검증**: 공식 agent-browser download가 제품 blob 버튼과 직접 HTTP attachment 모두 `Download was canceled`로 종료했다. console/errors는 비었으며 blob만의 제품 오류라는 근거는 없다. 보안 flags·HOME·권한 변경이나 추측 제품 수정 없이 진단을 종료했다. 서버 export 성공으로 브라우저 저장 성공을 주장하지 않는다.
- E2E 전용 서버·Chrome 종료와 cleanup 오류 0 확인. native Codex 실제 추론/코드 생성, PowerPoint GUI, 외부 모델 실서비스, 실제 비용/usage는 이번 범위에서 검증하지 않았다.
- 현재 범위의 검증 실행·실패 분류를 마쳤다. 브라우저 파일 저장 문제는 남겨두고 독립적인 Capability/모드 작업을 진행한다. HTTP transport와 verification은 계속 제품 미연결이며 전체 Goal은 미완료다.

## Capability Registry / 6개 실행 모드

- 공식 문서와 로컬 Codex stable/experimental JSON schema를 확인해 세션·stream·resume·interrupt·계획·review·Skills·MCP·Hooks·plugins·subagents·Goal·usage를 Registry에 반영했다. Claude는 공식 CLI/SDK·Goal·Teams와 인증/과금 조건을 별도 정리했다. 출처·확인일은 `docs/architecture/`에 보존했다.
- Registry GET은 실행 없는 조회이며 명시 POST 진단만 고정 native `--version`을 호출한다. CSRF·Origin·빈 body·safe env·3초·4KiB·60초 캐시·pending 공유를 검증했다. 실제 sanitized probe exit0: 2026-10-25T13:40:11.937Z Codex found `0.164.0-alpha.11.1`, Claude not_found_on_path. 설치 전체·인증·비용·quota까지 확인한 것은 아니다.
- Solo/Cross Review/Debate/Race/Cooperate/Goal을 native 재사용 전제로 설계하고 순수 예산·격리·비교 계약과 UI 설명을 연결했다. Race는 같은 승인 계획/요구/base/test/E2E, 독립 worktree, 후보별 source에 묶인 실제 증거를 요구한다. unknown·미강제 예산은 차단하며 속도나 agent 자기평가로 승자를 정하지 않는다.
- 기존 Solo 실행기는 유지되며 새 모드 gate는 아직 Controller 미연결이다. 나머지 5개 모드 executor는 미구현이다. UI에서 실행 선택/성공으로 표시하지 않는다. hooks/plugins/multi_agent/MCP 비활성 정책과 승인 거절은 그대로다.
- 독립 리뷰에서 probe가 await 이전의 ready 상태를 응답하는 P2를 재현하고 회귀 RED→GREEN으로 수정했다. 6모드 계약 리뷰의 중요 finding은 없었다.

| 검증 | exit | 결과 |
|---|---:|---|
| Registry 최초 / HTTP 최초 | 1 → 0 | module 없음 / route404에서 구현 후 통과 |
| Registry+native probe+mode+HTTP+SSR 집중 | 0 | 31/31; 뒤이어 stale connection 회귀 2/2 |
| 최종 E2E 내부 타입검사 | 0 | `tsc --noEmit` |
| 최종 E2E 내부 전체 테스트 | 0 | **221/221**, fail/skip0 |
| 최종 E2E 내부 build | 0 | 승인된 일반 사용자 동일 build |
| Windows 실제 브라우저 | 0 | **18단계**, 24 PNG, refresh/restart, Registry·확장 정책·6모드 설명 확인 |

증거 root: `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-HDdQCK` (2026-10-25T13:43:00.861Z~13:43:55.753Z). 메인 에이전트가 providers 1366×768, agents 1744×864 화면을 직접 검토했다. 전용 서버/Chrome 종료, cleanupErrors0. browser에서 native probe/모드/실제 AI 실행은 하지 않았다. 과거 download canceled 실패는 해결되지 않았고 이번 범위에 포함하지 않았다. 전체 Goal은 미완료이며 다음은 실제 verification evidence·승인 경로의 제품 통합이다.

## 실제 검증·리뷰 승인 수직기능

- 서버의 프로젝트별 고정 명령 설정 `ORBIT_VERIFICATION_COMMANDS`(기본 빈 목록), 명령/config/source preview, 명시 실행 승인, 실제 Runner 실행·중단, SQLite Check·이벤트, 소스·설정·최신 결과에 결합한 리뷰 승인을 Development에 연결했다. 실행 중 agent/check/workspace 전환을 상호 배제한다.
- 체크 기록이 있는 Run은 `verification:recorded`이며 통과를 뜻하지 않는다. 실제 exit/verdict는 별도 Check에 있다. 소스·설정 변경, 최신 실패 재시도, 중단/timeout/lost는 승인 근거로 사용하지 않는다. 자동 merge는 없다.
- source fingerprint는 Git stage0 tracked/nonignored 목록, 삭제·mode·내용 digest와 base/정책을 결합한다. 민감 경로는 내용을 열기 전에 거절하고 link/hardlink/경계/관찰된 파일교체/파일 수·용량 초과를 fail-closed 처리한다. ignored 의존성과 중간 변경 후 원복은 증명하지 않는다.
- 재시작 중이던 check는 lost로 보존하고 같은 workspace를 격리한다. 사용자가 이전 로컬 프로세스 종료를 확인한 뒤 다시 검증해야 한다. 서버가 PID만으로 기존 프로세스를 kill하거나 자동 재실행하지 않는다.
- 명령은 Codex sandbox 밖의 로컬 OS 권한이다. preview/UI/README에 이를 표시한다. 독립 리뷰에서 `--api-key value` 분리 인자의 preview 노출 P1을 재현하고 구성/preview 양쪽에 알려진 credential 옵션 거절을 추가했다(RED→GREEN). 유한 패턴이며 임의 비밀값 탐지의 완전성을 주장하지 않는다.

| 검증 | exit | 결과 |
|---|---:|---|
| source fingerprint focused | 0 | 10/10; 최초stub RED3 fail→GREEN |
| verification service focused | 0 | 7/7; 실행전 source race·최신재시도·설정·lost복구·분리credential |
| 실제 임시 Git + HTTP | 0 | 2/2; 실제Node exit/approval/stale·CSRF·override·민감파일·중단·동시실행 |
| 독립 review 재실행 | 0 | service+HTTP 9/9, 추가 P1/P2 없음 |
| 첫 전체 E2E 선행검사 | 1 | 239/240; 의도적으로 바뀐 timeline 문구의 기존 assertion 불일치. build/browser 미도달. `orbit-e2e-A7Q2BM` |
| 문구 회귀 수정 | 0 | 새 안내 확인과 임의 검증통과 표시 금지 유지; focused1/1 |
| 최종 전체/type/build | 0 | **240/240**, 타입·빌드 통과 |
| Windows 브라우저 | 0 | **20/20 단계**, 26 PNG, 실제Node검증→승인→변경후무효→refresh/restart복구 |

최종 증거: `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-hze7tz` (2026-10-25T14:06:49.239Z~14:08:05.473Z). 사용자 DB/원본 Git 보존, 전용 서버 종료, cleanupErrors0. 메인 에이전트가 `25-verification-approved.png`, `26-verification-stale-after-restart.png`를 직접 확인했다.

이 브라우저 검사의 terminal Run은 fixture 전용 IPC로 만든 **합성 실행 기록**이고 검증 명령은 실제 Node 프로세스다. 실제 Codex 코드 생성과 구분한다. 과거 브라우저 다운로드 취소는 계속 미해결이다. 전체 Goal 미완료; 다음은 실제 Codex 승인Task→코드→검증→승인→산출물 단일 smoke와 남은 제공자/그래프/자동화/확장/사용량 연결이다.

## Codex 사용량 조회와 실제 승인 Task workflow

- 공식 `account/rateLimits/read`(`excludeResetCreditDetails:true`)와 `account/usage/read`만 사용한다. ready ChatGPT 연결·CSRF empty POST·60초 cache/pending 공유·연결 generation 폐기를 적용했다. GET은 캐시만 읽는다. quota 초기화·credits 소비·email·과금 전환 기능은 없다.
- 허용한 숫자·날짜·ID만 반환하고 null/오류는 unknown으로 유지한다. 계정 전체 quota/토큰과 작업별 usage/API 비용을 구분한다. 원시 account fields·credits·오류를 UI/DB/로그에 보존하지 않는다.
- 파서/collector 12 및 Controller/HTTP 3개 focused 통과. 검토 중 초기 GET이 최신 수동 refresh를 덮는 UI 경합을 확인해 요청 epoch를 분리했다(Capability 진단에도 동일 수정). 해당 지연 UI 경합은 코드 검토로 확인·수정했으며 브라우저 지연 재현은 별도로 실행하지 않았다.
- 최종 Usage gate: **타입검사·전체255/255·build exit0**, Windows **20/20**, 26 PNG, cleanupErrors0. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-0PJj0y` (2026-10-25T14:26:47.871Z~14:28:01.633Z). UI의 disconnected unknown·계정 전체·비활성 조회 버튼을 확인했으며 이 E2E에서는 실제 계정 RPC/모델 요청이 0회다. 메인이 usage 1366×768 PNG를 확인했다.
- 이후 `node scripts/verify-approved-workflow.mjs`를 검토하고 승인된 일반 사용자 경로에서 **1회** 실행했다. **exit0 / passed**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-approved-live-CyWYy0/summary.json`.
- 실제 공식 Codex 연결 → 승인 Planning/Task → **native process1 / turn1 / completed fileChange1** → 정확한 greeting.ts diff1파일 → 원본 Git/테스트 파일 보존 → 실제 Node check exit0 → source/checkset-bound 리뷰 승인 서비스 → 실제 PPTX/Markdown 파일·ZIP CRC·native text/shape/connector·Markdown exact bytes 확인. cleanupComplete=true, approvalDenials0.
- 같은 연결의 실제 공식 사용량 조회도 수행했고 summary에는 `usageReadAttempted:true, usageStatus:available`만 기록했다. 계정 수치·인증정보·원문 RPC는 출력하지 않았다. 기존 ChatGPT 구독으로 실행했으며 새 API 키·과금 경로·계정 설정을 만들지 않았다.
- 이 live smoke의 리뷰 승인은 고정 fixture diff에 대한 **script attestation**이다. 실제 사용자 브라우저 클릭, PowerPoint GUI, 전체 플랫폼/모든 제공자의 성공을 뜻하지 않는다. 하나의 native turn은 내부 model request 수나 token 비용 상한 1회를 의미하지 않는다. Controller 120초 deadline과 1turn gate를 사용했고 추가 모델 실행은 하지 않았다.

전체 Goal은 계속 미완료다. browser file download 취소, 안전 merge, 소스 graph·확장 다이어그램/PDF, 실제 provider 연결 구성, 5개 모드 executor, automation, extensions profile/설정복구, 작업별 비용/usage가 남아 있다.

## 브라우저 Artifact 저장 재검증

- `node scripts/verify-artifact-download.mjs` 최종 exit0. 새 disposable fixture `C:/Users/lclk1/AppData/Local/Temp/orbit-download-8NErjl`에서 명시 plain `--download-path`와 제품 PPTX/Markdown 버튼의 일반 click으로 실제 디스크 파일을 생성했다.
- PPTX 12,721 bytes / Markdown 221 bytes가 서버의 같은 immutable Artifact 출력과 완전히 일치했다. ZIP CRC/12 XML parts/internal relations/한글/native shape5+connector1을 script와 별도 Python 검사로 확인(exit0). 전용 서버·브라우저 종료, 원본 Git 보존, cleanupErrors0.
- 같은 세션·같은 버튼에서 CLI `download <ref> <path>`만 사용하면 취소가 재현된다. 제품 버튼 저장 성공과 도구 명령 실패를 구분한다. Windows extended canonical path 원인은 아직 가설이다. 보안 옵션·HOME·allowlist 변경이나 제품 패치 없이 성공 경로를 검증했다.
- 사전 2회는 CLI PATH 탐색/대기식 오류로 다운로드 비교 전에 실패했으며 성공으로 집계하지 않았다. 자세한 증거·공식 동일버전 소스는 `docs/visualization/DOWNLOAD-RESULTS.md`. PowerPoint GUI 미검증, 모델 추론/새 API 호출 없음.

## 소스 그래프 수직기능 진행

- 설치된 TypeScript 5.9.3을 runtime dependency로 재분류했다. lock 버전·integrity는 동일하고 새 패키지 설치/프레임워크/Graphify 플러그인 도입은 없다.
- 기존 fingerprint 단일 read의 같은 bytes에서 bounded JS/TS source snapshot을 얻는다. fingerprint 정책·field 순서/기존 동작은 보존, source 제한/UTF8/BOM/민감경로/no-open 검사를 추가했다. focused17/17 exit0.
- map-only TypeScript CompilerHost는 tsconfig·패키지·라이브러리·원격/추가 fs resolution을 하지 않는다. file/function/class/method 및 import/call/extends의 정적 근거와 unresolved를 기록한다. 분석·지원 범위는 제한되어 있으며 runtime 호출과 실제 검증 통과를 뜻하지 않는다.
- 서버의 권위 manifest에서 계산한 file ID로만 코드 미리보기를 찾는다. redacted display path는 파일 접근 권한으로 쓰지 않는다. 원문 source/diagnostic은 DB/events에 저장하지 않는다.
- graph SQLite 이력·source-current/stale·파일탐색·기존 Artifact/PPTX 연계·Artifact 원문 exact 비교를 구현했다. 소스가 바뀌면 stale, 수동으로 바꾼 Artifact는 metadata가 남아 있어도 unverified다. 첫 HTTP회귀 RED(미구현route)→GREEN2/2, 실제 disposable Git·재시작·원본 보존 포함. 새 브라우저/전체 gate는 아직 대기 중이다.
- 독립 리뷰 P2: redaction 팽창 후 64,000자 절단을 truncated:false로 표시하던 문제를 실제 합성 입력으로 확인하고 cap-sized output도 보수적으로 표시하도록 수정했다. 회귀 API 검사 통과. 구조분해 함수 재할당을 놓친 parser P2는 담당자가 회귀 수정 중이다.
- parser 구조분해 P2는 배열·객체·nested/rest/default/shorthand 6가지 write를 unresolved로 처리하는 회귀로 수정됐다. 최초 RED(단순LHS검사), shorthand 추가 RED 후 최종 focused14/14 exit0. typecheck도 exit0. 런타임 dispatch 정확성을 주장하지 않는다.
- 첫 source graph 전체 gate는 `orbit-e2e-QZasQp`: type0, 전체278중276pass/2fail(exit1), build/browser 미도달. 원인은 기존 visualization SSR helper가 Studio 한 파일만 TSX 변환해 새 ArtifactSourceStatus.tsx import를 읽지 못한 것이다. 같은 저장소의 scoped registerHooks/TypeScript transpile 방식으로 component dependency tree를 로드하도록 수정했고 기존 assertions는 모두 유지했다. visualization focused21/21 및 typecheck exit0 확인 후 전체 gate 재실행 중이다.
- 최종 source graph gate: **타입검사·전체278/278·build exit0**, Windows browser **22/22**, 30PNG, cleanupErrors0. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-cBONNn` (2026-10-25T14:56:33.371Z~14:58:06.723Z). 메인이 27-source-graph-current와30-source-artifact-stale-after-restart PNG를 직접 확인했다.
- 새 disposable worktree의 JS/TS3파일에서 main→greet import/call·잠재영향·원문preview 확인, 소스 Artifact 생성, source현재성, 변경 후 graph/Artifact stale 및새로고침·서버재시작 복구를 검증했다. 원본fixture clean, 전용서버 모두 종료. 이 E2E의 실제AI/계정조회0회; 앞서 실제Codex1turn smoke와 구분한다.
- source graph 수직기능 검증을 마쳤으며 전체 Goal은 미완료다. 다음은 실제 Model Provider Hub 구성·진단·text stream 연결. 기본off, 명시승인·목적지/PII검사·출력한도·중단·unknown비용 경계와 로컬mock HTTP 검증부터 진행한다.

## Model Provider Hub 통합 진행 (2026-10-26)

- 기존 native HTTP transport에 maxOutputTokens(default1024, explicit1..8192) 및 항상 max_tokens 전달을 추가했다. localhost실제body/5종ID/경계·mutation/상한초과usage회귀 RED20pass4fail→GREEN24/24(exit0). 공급자가상한을준수했다는보장이나hardcostcap/환불의미가아니다. 초과completionTokens 보고는 done없이 PROVIDER_OUTPUT_LIMIT 실패, 누락usage는unknown.
- default[] 서버 ORBIT_MODEL_HUB 설정파서와 exact project/destination/model/digest/confirmed gate를구현했다. deepfreeze·WeakSet trusted config, credential값없는env참조, constructor조회무통신, 모든메시지PII/credential검사focused13/13+type0. Bedrock/future실행은거절하고 registry만정직표시한다.
- SQLite요청/진단서비스, explicitCSRF POST, inertGET, allowlist교집합models, textstream·중단·재시작lost·동일request중복전송방지를연결했다. 원문prompt는별도DB필드에저장하지않고 response는safeText만보존하며 audit에는ID/status만남긴다. 응답DB갱신은200ms로제한한다.
- ModelHub처음단위검사는missingmodule로RED, HTTP처음은미구현route로RED. 구현후service4/HTTP1통과. Controller/HTTP/SSR관련합계27/27 및전체type exit0 확인. 실제외부서비스나인증정보를사용하지않았다.
- 독립리뷰P2: 기존128000byte예약이64000자CJK/JSONescape출력을수용하지못하는storagequota초과를재현했다. UTF16unit당최대6 JSONbytes+metadata를전송전에예약하도록수정,실제SQLite에bounded CJK이력을채운후추가network0으로거절하는회귀통과. 다른확정P1/P2는현재읽은service/config/HTTP범위에서없었다.
- 최종 Model Hub gate 1회: **전체303/303·타입·빌드 exit0, Windows24/24·32JPEG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-11B9Ee` (2026-10-25T15:31:19.661Z 시작). 초기·동의 전 mock통신0, models1·chat2, 개인정보 차단 시 증가0, hang interrupt 후 socket abort, refresh/restart 후 재전송0·동일 설정/이력 복구를 확인했다. 실제 AI·계정 조회·외부 HTTP0회.
- cleanupErrors0, 브라우저와 서버5개 종료·앱/mock 포트 닫힘·원본 fixture 보존. 메인 에이전트가31-model-hub-current PNG를 직접 확인했다. UI의 “요청 출력 상한”은 공급자 준수 여부 미확인을 명시한다. Bedrock·외부 서비스 인증은 미구현/미검증이며 전체 Goal은 미완료다.

## Planning 내보내기·피드백 진행 (2026-10-26)

- 저장 기획 id/revision/hash를 검증하는 MD/JSON export와 명시 CSRF POST 피드백을 연결했다. 피드백은 project→plan→Task→Run→workspace→Check를 검증하고 구조화된 상태/해시/시각/exit와 현재 변경 파일 목록만 포함한다. 모델 prompt/response, Check.output, 패치·명령·절대경로와 원시 예외는 제외한다. 질문·문서를 DB/이벤트에 새로 저장하거나 외부에 전송하지 않는다.
- 최초 service 테스트는 미구현 module로 exit1, HTTP 2개는 미구현 route404로 exit1. 독립 리뷰에서 fingerprint 실패가 예외 대신 sourceIssue로 돌아오는 경우 available=true가 되는 P2를 추가 회귀로 재현(5pass/1fail exit1), unavailable 처리로 수정해 service4+HTTP2 **6/6 exit0**, 타입검사 exit0를 확인했다.
- Markdown/JSON 내보내기는 알려진 개인정보/credential을 변조 없이 차단하며 사용자가 수동 인계 전에 검토해야 한다. 검출은 휴리스틱이고 승인 권한은 export로 전달되지 않는다. 일반 Markdown으로 무손실 표현이 불가능하면 exact canonical JSON envelope를 사용한다. 64k 초과 정상 문서·경계 credential·최종256KiB 회귀를 포함해 parser/serializer25개 통과.
- 최종 Planning gate 첫1회 **전체322/322·type/build exit0, Windows26/26·34PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-YvKUvq` (2026-10-25T15:56:33.043Z~15:58:18.034Z). 실제 Chrome 저장 MD346B/JSON602B는 서버 bytes와 같고 재파싱도 정확했다. 두 형식 UI 업로드·source=import 별도 draft 저장, 기존 승인/Task 보존, dirty export 비활성, refresh 복구를 확인했다.
- 실제 피드백 MD3813B는 화면 pre의 UTF-8 bytes와 같다. 과거 Check passed/exit0와 현재 canApprove=false/approvalCurrent=false를 구분하고, 질문 변경 시 이전 preview 폐기와 refresh 후 질문/preview 미복원을 확인했다. 질문 원문을 서버에 저장하지 않는다. 메인이33/34 PNG를 직접 확인했다.
- cleanupErrors0, 브라우저·서버5개 종료·제품/mock 포트 닫힘, 원본 fixture 보존. 실제 AI/계정조회/외부HTTP0, 로컬 mock만 models1·chat2. 전체 Goal은 미완료이며 다음은 D/K 승인 기반 안전 병합이다.

## 승인 기반 안전 병합 진행 (2026-10-26)

- 승인 source/checkset/approval와 현재 primary branch/base를 고정하고 같은 raw bytes로 별도 index·tree·단일 parent commit을 만든다. 후보 생성과 실제 반영은 서로 다른 사용자 승인이다. 반영은 native Git ff-only이며 완료 전 전체 bytes/index/HEAD를 확인한다. 원 source HEAD/index/files는 변경하지 않고 실패 후보와 durable intent는 보존한다.
- snapshot focused27/27, Git 최종14/14, service5/5, UI5/5와 실제 HTTP1/1 모두 exit0. 통합 중 Projects/Controller/HTTP/verification/sourcegraph/merge 관련41/41 exit0, 이후 발견한 P2는 해당 focused 검사로 다시 확인했다. 최신 타입검사 exit0. 실제 쓰기는 임시 Git fixture에서만 실행했다. 전체 suite/build/Windows browser는 아직 이번 변경에 대해 미실행이다.
- 독립 리뷰는 `merge.autoStash=true`가 검사 뒤 생긴 사용자 변경을 이동시키는 상황과 외부 `core.excludesFile`이 untracked를 숨기는 상황을 재현했다. autostash 이중 비활성화 및 외부 ignore 고정/설정 거절 후 두 회귀를 통과했다. 추가로 source ref lock, 후보 검증 뒤 변경, 현재 Run 필터로 과거 unknown을 숨기는 문제, UI 응답 유실 후 수동 재확인 경계를 회귀로 검증했다.
- 실제 HTTP 검사는 Node 검증 명령·리뷰 승인·후보 생성 때 primary 불변·명시 반영·ff 후 primary bytes와 ignored 파일 보존·source HEAD/index/bytes 보존·요청 재전송 무동작·미확정 격리와 관찰 복구를 확인했다. 합성 terminal Run을 사용했으며 AI 실행은 0회다.
- `.gitattributes`/filter/sparse/외부 ignore 등 지원하지 않는 Git 상태와 dirty·ignored 충돌은 거절한다. 외부 편집기/Git과 완전한 원자성, POSIX 실제 executable mode, 실제 사용자 저장소 병합은 미검증이다. 자동 stash/reset/rollback/retry/push는 수행하지 않는다. 전체 Goal은 미완료다.
- 후속 공식 native 검토에서 설치 CLI 0.164.0-alpha.11.1의 깨끗한 임시 설정은 `goals stable true`, `--disable goals`는 false로 확인됐다(각 exit0). 실제 restricted Solo의 Goal tool 노출/자동 후속 turn은 재현하지 않았다. 제품의 Goal 미연결 선언에 맞춰 readonly/write 시작 옵션에 명시 차단을 추가하고 Registry도 blocked_policy로 맞췄다. 정책 회귀 RED3pass/2fail→GREEN17/17 exit0. 현재 연결의 Goal을 실행하거나 계정/모델을 호출하지 않았다.
- 최종 동결 gate 첫1회 **전체358/358·type/build exit0·Windows29/29·37PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-MuuaOA` (2026-10-25T16:43:20~16:46:40Z). 후보 생성 당시 primary/source 불변, 별도 UI checkbox·버튼 승인 뒤 실제 primary ff 및 승인 raw bytes 일치, 원 source HEAD/index/bytes와 기존 두 primary fixture 보존, refresh/restart 후 같은 applied 기록·반복 반영0을 확인했다. root가 result/cleanup와 PNG35/37을 직접 확인했다.
- cleanupErrors0, 서버6개와 브라우저 종료, 앱50942/mock50941 포트 닫힘. 실제 AI/계정/외부 HTTP0. 기존 Planning 다운로드·재가져오기와 source graph/Model Hub 회귀도 통과했다. 전체 Goal은 미완료이며 다음은 F Automation의 저장 워크플로·명시 실행·중단/복구다.

## 로컬 워크플로 진행 (2026-10-26)

- 기존 server verification 설정·명령 preview·runVerification/Runner를 재사용한다. 최대12단계의 DAG를 고정 순서로 실행하며 첫 실패 뒤 후속 실행을 중단한다. 새 프레임워크나 AI 분배 엔진은 추가하지 않는다. immutable version·source/config-bound preview·별도 동의·SQLite intent/receipt·저장 quota·정제된8k/step 출력·lost 격리/관찰 후 해제를 구현했다.
- definition10개 RED→GREEN, service 최초 missingmodule RED→실제 Node4/4, HTTP 미구현404 RED→실제 Git/Node1/1. 추가 실제 프로세스 중단·source 변경·출력/저장한도 검사 후 service6+HTTP1 **7/7 exit0**. Controller/HTTP/verification 관련 묶음28/28 exit0(추가2개 전). source HEAD/index/파일과 primary 보존, AI Run0·실제 모델0을 확인했다.
- retry chain 분기와 recovered lost를 실패로 취급하던 경계를 각각 RED→GREEN으로 수정했다. lost의 종료 확인은 실패 증거가 아니므로 retryOf로 재시도하지 않는다. 이 RED 과정에서 새로 생성된 복구 서비스의 test teardown 누락으로 DB close 뒤 비동기 오류도 발생했으며, 해당 서비스도 종료하도록 fixture를 고쳐 최종7/7에서 재발하지 않았다.
- 서비스/HTTP/Controller 독립 리뷰에서 추가 확정 P1/P2는 없었다. UI 개발 중 1회 전역 타입 검사에서 아직 없는 component import 오류가 확인됐으며 전체 성공으로 집계하지 않는다. UI focused/type와 최종 전체/build/Windows browser는 별도 취합 중이다.
- UI 완성 후 root 전역 타입검사 exit0, Workflow UI/Studio/navigation12/12 exit0를 확인했다. 네 번째 fixture는 명시 exact CLI 경로에서만 허용하고 기존 세 fixture의 설정은 보존한다. 전용 서버 회귀3/3·nodecheck exit0. 최종 전체/build/Windows gate는 대기 중이다.
- 최종 동결 gate 첫1회 **전체382/382·type/build exit0·Windows32/32·40PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-VT6CNR` (2026-10-25T17:18:10.207Z~17:22:00.547Z). 실제 Node DAG 통과·exit7 실패/종속 skip·명시 retry attempt2·actual-start 확인 후 exit130 중단·3개 정의 버전 보존·refresh/restart 후 실행0을 확인했다. 기존2 primary/merge source 및 반영된 merge primary, 네 번째 primary/source HEAD·index·digest를 보존했다. root가 result/cleanup 및 PNG38/40을 직접 확인했다.
- 소유 서버7개는 각각 exit0 관측 후 종료됐다. 독립 PID 확인은 6개 ESRCH, 나머지 PID30784는 Windows SearchFilterHost로 재사용돼 EPERM이었으며 해당 다른 프로세스는 수정·종료하지 않았다. 앱55169/mock55168 ECONNREFUSED, 브라우저 closed=true/launched=false, cleanupErrors0. 실제 AI/계정조회/외부서비스0이며 Model Hub의 로컬 mock만 사용했다.
- 현재 로컬 workflow 수직기능은 검증 완료다. 예약 실행·외부 서비스 단계는 계속 미연결이며 전체 Goal은 미완료다. 다음은 G의 남은 Bedrock 선택형 adapter를 공식 인터페이스로 구현·진단하는 작업이다.

## 선택형 Bedrock CLI 진행 (2026-10-26)

- 공식 AWS CLI 2의 ListFoundationModels/Converse를 선택했다. CLI 미설치 환경에서 설치·SDK/프레임워크 추가·실제 AWS 호출·키 발급 없이 구현한다. 비스트리밍 텍스트, 고정 standard region/direct foundation ID, 프로젝트/model allowlist, 명시 동의, 단일 시도와 기존 privacy gate를 재사용한다. 교차 리전 profile·SSO/profile/metadata 인증·자동 전환은 미지원이다.
- Bedrock 설정 RED1pass/2fail→GREEN3/3, 기존 HTTP 설정 포함16/16·focused type exit0. 기존 HTTP 설정 canonical 순서를 유지해 digest가 바뀌지 않는 회귀도 확인했다. 미설치 서비스 RED→GREEN, 기존 Model Hub 포함 service/HTTP7/7. 통합 중 transport 모듈 작성 대기와 chat options의 union excess-property 타입 오류가 발생했으며 완료 주장에 포함하지 않았다.
- CLI 입력은 승인 후 소유 temp JSON을 이용하며 argv/SQLite/events에 원문을 넣지 않는다. 종료 후 제거·중단·lost/cleanup_required·명시 stopped attestation·정리 후 결과 불확실성 유지와 재실행 방지를 연결했다. old unresolved가 최근20개 뒤에 숨겨지는 P2를 RED2/3→GREEN으로 수정하고 복구 대상 우선 표시·전역 복구 metadata와 새 Bedrock 전송 차단을 추가했다. 실제 temp 파일+모의 CLI 응답 서비스5/5, HTTP cleanup1/1, UI6/6이 통과했다.
- 전용 네 번째 테스트 fixture grant에만 없는 CLI 목적지를 추가했다. 정상 RED→GREEN, fixture4/4 및 nodecheck exit0. missing runtime 진단은 BEDROCK_CLI_NOT_FOUND, chat은 MODEL_CATALOG_REQUIRED로 차단되며 요청 기록0·로컬 HTTP mock호출0·CLI 파일/디렉터리 미생성을 확인했다. 최종 전체/type/build/Windows browser 및 독립 리뷰는 진행 중이다.
- 독립 서비스/HTTP 및 native/process/temp 리뷰에서 추가 확정 P1/P2는 없었다. 자체 경계 검토에서 model accessor/deps root 변경과 겹치는 credential의 부분 suffix 노출을 각각 RED→GREEN으로 보강했다. root가 재시작 TEMP 변경 뒤 old input 잔존/removed 오표시를 RED4pass1fail로 재현하고, 승인 start transaction에 temp base를 저장해 chat/cleanup에서 재사용하도록 수정했다. 후속 서비스5+HTTP1 **6/6 exit0**, 전체 Bedrock 집중19/19·type exit0. 저장 root에 대한 별도 재리뷰도 추가 확정 P1/P2 없음.
- 타입 검사와 일반 사용자 로컬 build는 exit0. 실AWS CLI/인증/Converse/청구·원격 중단은 미검증이며 marker 누락/손상, 예상 외 파일·link는 자동 삭제하지 않는다. 전체 테스트와 Windows gate는 진행 중이다.
- 최종 동결 gate 첫1회 **전체405/405·type/build exit0·Windows33/33·41PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-esVqPJ` (2026-10-25T17:48:40.826Z~17:52:36.772Z). 명시 승인 뒤 실제 missing CLI 진단 실패, 모델 목록 empty·추가 동의 후에도 chat 비활성·request0, refresh/restart 후 같은 진단/자동 재시도0을 확인했다. root가 result/cleanup과 PNG41을 직접 확인했다.
- 이전 HTTP models1/chat2/중단1, Planning MD346B/JSON602B/feedback3813B, source graph/검증/승인/실제 ff 병합/Workflow의 실패·재시도·중단 회귀도 통과했다. 기존2 primary·merge source 및 승인된 primary·fourth HEAD/index/digest/ignored markers를 보존했다. 소유 서버8PID 모두 ESRCH, 앱60158/mock60157 ECONNREFUSED, 브라우저 closed=true/launched=false, cleanupErrors0. 실제 AI/AWSCLI/계정/외부 서비스0. `git diff --check` exit0.
- Bedrock 수직기능의 로컬 구현·검증을 완료했으며 전체 Goal은 미완료다. 다음은 공식 Codex review/start를 이용하는 별도 읽기 전용 AI 리뷰와 source-bound 검토 이력이다. 현재 Solo 외 모드 executor, Claude/Gemini adapter, PDF/추가 다이어그램, Extensions/보안등급/분석/예약 실행은 남아 있다.

## 공식 Native Review 진행 (2026-10-26)

- 로컬 설치 CLI의 stable JSON schema를 기준으로 fresh thread/start(read-only, ephemeral)→review/start(inline/custom)를 사용한다. detached delivery는 사용하지 않는다. 기존 Rpc/CLI 제한·denyRequest를 재사용하며 별도 새 SDK/오케스트레이션 의존성을 도입하지 않았다. 실제 native AI 호출 없이 fake RPC, 실제 임시 Git, 순수 입력 계약으로 구현한다.
- 입력 builder RED10→GREEN10, native protocol 최종15/15, UI4/4와 관련10/10 exit0. native 작성 중 Node strip-only에서 parameter property 문법 오류가 발생했고 explicit field로 수정했다. builder unknown/null narrowing 오류도 function declaration으로 수정한 뒤 type0을 확인했다. 성공한 테스트로 오류를 숨기지 않는다.
- service 최초 missingmodule RED→GREEN4/4, HTTP 최초404 RED→실제 Git/fakeRPC1/1. source 변경·응답 정제·완료 없음·중단·receipt·재시작 quarantine·복구·모델 재호출0과 Check/승인 미생성을 확인했다. 이후 durable intent 직후 변경/old unresolved history/quota 회귀 포함 service6/6. Registry contract 상태 회귀 RED→GREEN, 타입0.
- 독립 리뷰의 P2 두 건: (1) raw Diff가64k로 잘린 뒤 credential masking으로 짧아져 builder가 누락을 인지하지 못함, (2) 동일 요청의 JSON key 순서만 달라도 receipt 충돌. 실제 Git와 서비스에서 함께 RED6pass/2fail을 확인하고 rawpatch 크기를 마스킹 전에 제외 및 canonical receipt 해시로 수정했다. Projects/Controller/HTTP/review 관련 **39/39 exit0**.
- Native 자기검토는 null MCP configuration, 정상 결과 뒤 close 대기 중 abort, early queue/closure/persistence callback, 과도한 raw final review를 RED→GREEN으로 보강했다. 실제 초과 응답을 잘라 성공 처리하지 않는다. main Controller의 동일 null MCP 경계도 별도 RED→GREEN1/1로 맞췄다. 도구 실행이나 승인을 새로 허용하지 않았다.
- 브라우저용 exact6th grant에서만 네 번째 worktree의 readonly fake RPC를 허용한다. default/다른 프로젝트/write 경로는 계속 거절한다. fixture5/5·harness8/8·구문/type exit0, 예정 browser35/PNG43. 실제 native CLI/AI/계정/외부 요청0. 전체 테스트와 최종 Windows gate는 진행 중이며 전체 Goal은 미완료다.
- 최종 Native Review gate 첫1회 **전체445/445·type/build exit0·Windows35/35·43PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-pRQaWi` (2026-10-25T18:20:03.545Z~18:24:43.047Z). exact preview/별도 동의·fake review 완료1·실제 mock start 확인 후 중단1, 새로고침/재시작 동일 이력·자동 연결/재실행0·Check/승인/Run 생성0을 확인했다. root가 result/cleanup 및 PNG42/43을 직접 확인했다.
- source HEAD/index/digest와 기존 fixture/승인 merge primary 보존, HTTP/Planning 다운로드/그래프/검증/병합/Workflow/Bedrock 회귀 통과. 소유 서버10PID 모두 ESRCH, app65276/mock65275 ECONNREFUSED, Chrome closed=true/launched=false, cleanupErrors0. 실제 native CLI/AI/AWS/계정/외부요청0. `git diff --check` exit0. 실제 native AI 리뷰 및 전체 Cross Review executor는 계속 미검증/미구현이다.
- Task17은 공식 읽기 전용 Extensions inventory부터 연결한다. 글로벌 설정 직접 탐색/쓰기, 플러그인 catalog 조회/설치, 권한 활성화 없이 기존 isolated session과 official list schema를 재사용한다. 프로젝트 profile preview/backup/restore는 이후 독립 수직기능이며 전체 Goal은 미완료다.

## Mac 인계 및 Extensions 진행 (2026-10-26)

- 사용자가 현재 작업을 Git에 보존하고 Mac에서 이어가도록 요청했다. 목표 원문은 docs/ORBIT-GOAL.md, 인계 절차·Windows 전용 Codex resolver·남은 구현·검증은 docs/HANDOFF-MAC-2026-10-26.md에 보존한다. 자동 후속 기능 개발 대신 현재 변경의 인계 검사를 수행한다.
- collector9/9·UI8/8·root Controller/HTTP6/6·Registry5/5를 구현했고 관련 통합53/53/type0을 확인했다. 독립 리뷰 도중 하위 에이전트들이 사용량 한도로 종료됐다. Task17 전용 browser37/45 계획은 미구현/미실행이다.
- root가 null workspace 읽기 전용 세션의 UI 조회 차단을 RED8pass1fail→GREEN9/9로 수정했다. Hooks handlerType 누락이라는 리뷰 주장은 설치 stable/experimental HookMetadata.oneOf 네 variant의 required 필드에서 반증했으며 검증을 약화하지 않았다.
- 중단된 exact7th inventory fixture를 완료했다. 신규 회귀의 초기 INVALID_REVIEW_FIXTURE_GRANT 실패 후 explicitconnect/metadata/cache/foreignscope/restart/DB 원문 미노출을 실제HTTP+fakeRPC로 확인해1/1 exit0. 기존 test 기대값의 Skills effective와 Hook 이름을 실제 DTO 계약(unknown/preToolUse)에 맞췄고 나머지 검사를 유지했다.
- 인계 시 실제 도구: Node v24.22.1, Git2.56.0.windows.3. 타입/build exit0. 첫 전체 실행은471중470pass/1fail(exit1): 기존merge-http의fetch ECONNRESET. 원인 확정 없이 성공 처리하지 않으며 해당 집중검사 및 동일 전체검사를 재실행한다.
- 인계 전체 재검사도471중470pass/1fail(exit1), 동일merge-http ECONNRESET. 집중merge-http1/1 exit0(25.2초). 원인은 미확정이며 테스트 삭제/완화/재시도 코드는 추가하지 않았다. 같은 전체검사를 concurrency4로 확인 중이다.
- 최종 인계 bounded 전체검사 `node --test --test-concurrency=4 tests/*.test.ts spikes/phase0/*.test.mjs`: **471/471·fail/skip0·exit0**(86.8초). 타입·build0, staged diff 공백 검사0. 기본 병렬 전체검사의 ECONNRESET은 미해결로 기록하며 Task17 전용 browser/Mac native 검증은 미실행이다. 추가 기능 구현 없이 인계 브랜치에 보존한다.

## Mac 재개: 런타임·회귀 (2026-10-26)

- 시작 branch `codex/orbit-mac-handoff-2026-10-26`, HEAD `23a9296b80c09f7b226478e8c2bc03dd4f7400ad`, dirty 없음. macOS 26.2 arm64, Git 2.50.1 (Apple Git-155), 기본 Node25.8.2는 engine 범위 밖이었다. 공식 Node24.22.1 darwin-arm64 배포본 SHA-256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` 확인 후 `.local/toolchains`에 설치했다. 시스템 Node는 변경하지 않았다.
- 최초 `npm ci`는 Node25 engine 경고 후 제한된 네트워크의 registry ENOTFOUND로 exit1. Node24와 허용된 registry 접근으로 `npm ci --cache .local/npm-cache --no-audit --no-fund` exit0(11 packages). esbuild postinstall 승인 미설정 경고는 있었지만 설치된 플랫폼 패키지로 아래 실제 build가 통과했다. lockfile 변경 없음.
- Mac PATH의 codex는 npm JS symlink였다. native 파일 검증(regular/executable/header), absolute PATH, npm nested/sibling/bundled vendor, native symlink와 명시 override를 구현했다. shell wrapper를 실행하지 않는다. Windows 파일/패키지 회귀와 격리 옵션은 유지한다. resolver RED3fail→GREEN5/5, native probe Mac RED→GREEN, 관련21/21·type0. 독립 리뷰의 Windows-host POSIX fixture 지적을 반영해 해당 OS 전용 케이스를 구분했다. 실제 Windows/Linux runtime은 이번에 실행하지 않았다.
- 설치 native `codex-cli 0.162.1`의 `--version`, readonly/write의 모든 restricted flag를 `features list`로 확인(exit0). 공식 `app-server generate-json-schema` exit0, `.local/capability-schema-mac`의 Skills/Hooks/thread-scoped MCP/Review schema를 확인했다. 모델·account RPC·인증 파일 접근은 하지 않았다. 실제 native 세션/리뷰/inventory 성공을 뜻하지 않는다.
- 첫 기본 `npm run verify`: type0, **477중415pass/61fail/1skip**, build 미도달. `.local/verification/mac-first-verify.log`. Mac `/var` OS temp alias를 no-link 정책이 거절한 실패가 다수였다. 같은 기본 병렬 전체검사를 canonical TMPDIR에서 진단: **471pass/5fail/1skip**, `.local/verification/mac-canonical-temp-diagnostic.log`. merge-http는 통과했고 ECONNRESET은 재현되지 않았다.
- 테스트 fixture의 OS temp root만 정규화하는 `tests/temp.ts`를 도입하고 생산 경로 보호는 유지했다. 실제 Bedrock 기본 temp root도 canonical OS 경로로 저장하도록 RED→GREEN 보완했다. 명시한 linked temp root는 계속 거절한다. E2E fixture의 `aws.exe`를 플랫폼별 이름으로 수정하고, kill 요청 후 소유 child exit/close 관찰 전에 완료를 반환하던 경합을 수정했다. 관련18/18 exit0.
- Task17 독립 리뷰에서 MCP 실패/transport 종료 뒤 server busy는 false지만 UI busy가 true로 남는 경로를 실제 Controller/reducer/AgentCenter로2/2 재현했다. `clearExtensions`의 unlock 이벤트 누락 회귀 RED→GREEN으로 수정했다. 이전 session의 지연 finally가 새 request를 해제하지 않는 기존 경계는 유지했다.
- 최종 기본 환경 `npm run verify` **exit0: type0, 전체480중479pass/1 Windows-only skip/0fail, build0**(tests22.6초). `.local/verification/mac-second-verify.log`. concurrency 변경·재시도·assertion 완화 없음. 기본 병렬 merge-http가 통과했지만 과거 Windows ECONNRESET의 원인이 해결됐다고 주장하지 않는다.
- Task17 전용 Chrome 수집/캐시·재시작 검증은 진행 중이다. agent-browser CLI는 이 Mac PATH에 없으므로 연결된 Chrome 도구와 동일 exact-grant fixture로 검증한다. 전체35/37단계 gate와 구분해 기록한다. 전체 Goal 미완료.

### Task17 Mac 브라우저·독립 검토 완료

- 연결된 Chrome CUA로 **전용 2시나리오·2JPEG**를 확인했다. 증거 `.local/ui-e2e/mac-task17-tMEmcL/result.json` 및 `screenshots/01-extensions-collected.jpg`, `02-extensions-restarted.jpg`. 실제 제품 Controller/HTTP/SQLite/UI와 exact seventh-grant fake RPC를 사용했다. 제품 연결은 created1/MCP1/Skills0/Hooks0, 명시 조회 뒤 MCP2/Skills1/Hooks1이었다. 연속 조회·캐시 새로고침·브라우저 reload 후 같은 계수와 목록을 유지했다.
- Skills 버전·실행은 unknown, Hook configured enabled와 blocked execution·native trust 별도, MCP disabled override·Plugins 미연결을 화면에서 확인했다. 합성 금지 원문 marker와 로컬 경로는 화면/cache에 없었다. 실제 AI/CLI/외부 요청0, 금지 RPC0이다.
- 서버 재시작 후 모든 RPC 계수0, disconnected·목록 unknown·조회 버튼 비활성으로 복원했다. primary/source HEAD·index·digest는 baseline과 동일하며 DB/WAL/SHM에 합성 금지 marker가 없었다. 소유 서버2개 exit0 관찰·loopback 포트 종료·브라우저 탭 종료, cleanupErrors0. 서버를 분리하려던 `/app.css` 이동은 Chrome client가 차단하여 `about:blank`로 전환했다. 제품 화면에서 수집한 console 경고/오류는0이었다.
- `scripts/verify-orbit-ui.mjs`에 같은2단계 및 seventh grant·IPC counters·DB 원문 부재·기존 fixture 보존 검사를 추가했다. 총37단계/예정45PNG이며 구문·diff 공백 검사 exit0, 관련 **39/39 exit0** (`.local/verification/task17-final-focused.log`). 독립 최종 리뷰 추가 지적 없음, 리뷰어 focused3/3·구문0. **전체37단계 자동 브라우저·Windows 재검증·실제 native inventory는 미실행**이다. Mac 전용2시나리오를 전체 통합 pass로 집계하지 않는다.
- 전체 Goal은 미완료다. 다음 수직기능은 기존 Planning 버전의 차이·영향 Task를 표시하고 명시 승인 후 후속 Task를 만드는 재계획 경로이다.
- 보존 직전 기본 `npm run verify` 재실행도 **type0·479pass/1skip/0fail·build0**, exit0(22.3초)이었다. 로그 `.local/verification/mac-task17-final-verify.log`. CUA screenshot은 실제 JPEG bytes여서 최초 PNG signature assertion이 실패했으며 파일명을 `.jpg`로 정정하고 증거 hash를 기록했다. 픽셀 변환은 하지 않았다.
