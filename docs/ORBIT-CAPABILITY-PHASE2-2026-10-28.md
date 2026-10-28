# Capability Orchestration Phase 2 구현 계획

**목표:** 기존 추천을 승인된 작업 실행 계약에 연결하고 실행 증거와 기존 Quality Loop 결과를 진행판에 보존한다.
**구조:** TypeScript/React/SQLite; Registry/Discovery/Router, Controller.submitTask/interrupt, QualityLoopService를 재사용한다. 자연어는 승인 작업의 실행 방식 선택용이며 승인 작업 내용을 몰래 변경하지 않는다.
**기준:** 사용자 2026-10-28 Phase 2 요청 및 ORBIT-VISION.md / ORBIT-SCOPE-2026-10-27.md. 로컬 구현·검증 자율 수행 요청에 따라 설계 재승인 없이 진행한다.

## 설계와 완료 조건

- 저장된 추천의 baseline/preferences/현재 registry 및 Adapter revision/version을 실행 직전에 재검사한다. preview digest에 정책 승인 결속. 코드 작업은 기존 workspace/acceptance preview를 사용한다.
- 승인 → durable dispatch intent → 기존 runtime → Run/model evidence의 순서. 동일 요청과 동일 plan은 한 번만 실행한다. 실패·종료 미확인·재시작은 원래 요청만 관측하며 자동 재실행하지 않는다.
- 실행 완료와 품질 통과를 분리한다. 결과 생성 후 사용자가 실제 artifact에 결속한 기존 Quality preview를 승인하면 같은 QualityLoopService로 진입한다. 임의 모델명으로 독립 검증을 통과시키지 않는다.
- Runtime Adapter는 신뢰된 프로세스 내 구현 등록/교체/비활성화를 지원한다. 외부 임의 JS/CLI 다운로드나 코드 로드는 구현하지 않는다. 지원되지 않는 slash/skill/hook/MCP 호출은 차단한다.
- UI 간편 모드는 계획·승인·실행 상태, 고급 모드는 버전/정책/모델/증거를 노출한다. GET은 실행·재시작·품질 실행을 하지 않는다.
- 실 Provider 실행은 별도 승인 전 하지 않는다. 실제 설치/오프라인 계약 관측, mock, 실제 모델 결과를 구분한다.

## 작업 순서

- [x] 초기 변경 읽기 전용 리뷰, 영향 33개/타입/빌드 검증 후 e9c8425 로컬 커밋. 전체 회귀 1292 pass/0 fail/2 skip 확인.
- [x] 공식 프로그램 실행 계약·기능별 discovery/invocation/verification, 호환 버전과 동적 Adapter lifecycle 구현 및 테스트.
- [x] 실행 계획/승인/멱등성/중단/관측 복구/Quality 연결 계약과 SQLite 서비스 구현 및 테스트.
- [x] 인증된 HTTP, 진행판·간편/고급 모드 수직 연결 및 모의 E2E.
- [x] 전체 타입/테스트/빌드, 최종 diff·보안 리뷰, 상태 기록과 로컬 커밋.

## 반드시 검증할 경계

중복 요청 충돌, 다른 plan으로 같은 작업 동시 실행, dispatch 중 재시작, dispatch 실패의 불명확성, 중단 요청과 실제 종료 구분, 실행 전 기준/공급자/버전 변경, 민감값 저장 차단, unknown 실제 모델 유지, Quality Loop 독립성 차단, GET 부작용 없음.

## 진행 기록

- 시작 HEAD 261c363; 실제 단일 worktree. .DS_Store 두 파일 보존·제외.
- 최초 전체 테스트는 샌드박스 loopback 제한으로 HTTP 검사 실패. 허용된 로컬 환경에서 재실행 중. 신규 모델 호출·외부 설치 없음.

## 구현 결과와 API

`GET /api/capability-orchestration`은 기존 discovery와 현재 `runtimeAdapters` 계약을 조회한다. 기존 명시 refresh는 native version probe를 재사용한다. 신뢰된 서버 코드가 `register/disable/unregister`로 실행 구현·지원 기능·호환 정책을 갱신하며 등록 세대/버전/기능 목록 변경은 기존 승인 계획을 무효화한다. 신규 제3자 Provider ID, 외부 JS/CLI 자동 로드는 미지원이다.

`/api/projects/:projectId/capability-executions` 아래 API는 기존 세션·Origin·CSRF 검사를 따른다.

| 경로/방법 | 계약 |
|---|---|
| GET collection / GET `/:id` | 저장된 계획과 기존 Run/Quality 증거 투영만 수행 |
| POST collection | `{requestId,routeId,workspaceId?,expectedAcceptanceDigest?}`; 승인 작업 기준으로 계획 생성. code에서 workspace 생략 시 기존 선택 workspace와 현재 acceptance preview를 캡처 |
| POST `/:id/start` | `{confirmed:true,expectedPlanDigest}`; 최신 binding 검사, 호출 의도 저장 후 등록 Adapter 실행 |
| POST `/:id/interrupt` | `{}`; 기존 Controller 또는 Quality Loop AbortSignal 경로. 요청 수락을 실제 종료로 표시하지 않음 |
| POST `/:id/recover` | `{}`; 원래 request의 terminal Run만 관측해 격리 해제. 재호출하지 않음 |
| POST `/:id/quality-preview` | `{reviewers,limits}`; 기존 Quality preview 사용. terminal blocked/failed도 새 계획 가능 |
| POST `/:id/quality-start` | `{requestId,reviewers,limits,expectedPreviewDigest,confirmed:true}`; 기존 QualityLoopService.start 사용 |
| POST `/:id/quality-resume` | `{}`; 기존 QualityLoopService.resume 사용. 원래 실행 증거가 없으면 차단 유지 |

계획/승인/호출 의도는 `capability_executions`에 저장한다. Run/model/Quality 증거는 기존 테이블과 event를 참조하며 새 완료 엔진은 만들지 않는다. 실제 실행 결과가 계획의 dispatch request/task/baseline과 연결된 영속 Run인지 검사한다. 조회용 최근200 제한은 안전 게이트에는 적용하지 않는다. 호출 전에 정책 변경을 확인한 실패는 재계획할 수 있지만, Adapter 진입 뒤 종료 여부를 알 수 없는 실패는 격리한다.

## 최종 리뷰와 실패 수정

- HTTP POST body 중복 소비를 실제 HTTP 모의 E2E에서 발견·수정.
- 동기 Store observer에 의한 실행 직전 정책 변경을 재현. 실제 호출 전 실패는 확정 실패로 저장하여 영구 격리 방지.
- 품질 차단/실패 뒤 새 preview가 불가능한 문제를 HTTP 실패 테스트로 재현·수정. 기존 품질 기록 유지.
- 반환 Run이 영속 request와 연결되지 않은 가짜 완료인 경우 격리하는 실패 테스트 추가.
- 201개 최신 기록 뒤로 숨은 미확인 실행이 안전 게이트에서 제외되는 문제를 재현·수정.
- Claude init 설정은 정제한 `run.model_configuration` event에 저장하며 실제 assistant model 증명으로 승격하지 않음.

## 지원/증거의 범위

- 구현: 승인된 code/general 작업의 Planner·실행 계약·신뢰된 Adapter 교체·버전/기능 갱신·HTTP·SQLite·Quality Loop·간편/고급 진행판.
- Mock 검증: 실제 Controller/Store/Studio/QualityLoop/HTTP를 거친 수직 E2E, unknown 차단 및 모의 독립 모델 통과, 중단/중복/실패/DB reopen/선택 변경/비밀값/동적 등록 검사, Chrome 버튼 E2E.
- 실제 Provider 실행 검증: 없음. Codex0.162.1 version/help의 로컬 관측과 공식 문서 조사는 실행 성공 증거가 아니다. Claude 실행 파일은 확인 경로에서 미발견.
- 미지원/차단: 임의 slash 전달, skill/hook/MCP 자동 실행 및 설치, 새 제3자 runtime ID, 승인 없는 공급자/유료 API 전환. Codex actual unknown 독립 리뷰 차단 유지.
- 남은 위험: managed hooks는 실환경 정책 확인 필요. 실제 인증·모델 호출·종료·네트워크 복구·OS별 동작은 별도 승인 후 검증해야 한다. 원래 호출 증거가 없는 격리는 자동 재시도로 해제하지 않는다. 동적 등록은 신뢰된 서버 구현 전용이며 등록 구현의 Controller 정책 준수는 코드 검토 경계다.

## 최종 검증 결과

- Node24.22.1 `npm run verify`: exit0, **1324 tests / 1322 pass / 0 fail / 2 Windows-only skip**. 타입 검사와 build 포함. `/tmp/orbit-capability-phase2-release.log`.
- `node tests/capability-execution.browser.cjs`: exit0, 모의 Chrome의 승인·digest·중복 클릭·종료/품질 구분·unknown·서버 최신 상태 우선 검사.
- `git diff --check`: exit0. 변경은 이 계획과 관련된 코드·테스트·문서만 포함. 사용자 .DS_Store 두 파일 보존·커밋 제외.
- 실 Provider 모델 검증 없음. 신규 외부 설치·원격 Push·배포·main 병합 없음.
