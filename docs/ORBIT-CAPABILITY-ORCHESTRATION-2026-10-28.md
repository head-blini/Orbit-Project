# Capability Orchestration 초기 구현 계획

**목표:** 기존 승인된 작업에 대해 실제 Orbit 어댑터 구현과 관측된 기능을 구분하고 자연어 요청의 추천·차단 근거를 보존한다.
**기준:** ORBIT-VISION.md, ORBIT-SCOPE-2026-10-27.md, 기존 모델 식별 계약 및 2026-10-28 사용자 우선순위.
**구조:** TypeScript/React/SQLite. 기존 capabilities/probe/extensions, ProjectAiPreferences, Studio.execution, Quality Loop, 진행판을 재사용한다. 기존 실행기를 교체하지 않는다.

## 설계 판단

- 기존 기능 설명 Registry를 실행 허가로 재사용하면 문서상 지원과 실제 실행 가능성을 혼동한다. 기존 설명 화면은 보존하고 명시 등록한 Provider Adapter가 구현/관측/정책을 분리한 공통 Registry를 만든다.
- 새 LLM 라우터는 추가 모델 호출과 새 전송 경계를 요구한다. 이번에는 서버의 제한적인 한국어/영어 규칙으로 intent를 분류하고, 모호함은 needs_clarification으로 남긴다. 이는 모델 기반 범용 의미 이해를 구현했다는 주장이 아니다.
- 자동 추천은 실행·설정 변경 권한이 아니다. 기존 프로젝트 AI 선택을 존중하고 무음 대체하지 않는다. 실행은 기존 Controller/승인 경로가 맡는다. 유료 API 후보는 추가하지 않는다.
- 설치/버전, 인증, 연결, 어댑터 구현, 기능 관측을 분리한다. CLI --version은 설치 근거만 제공한다. Codex 확장 메타데이터는 기존 명시 refresh 결과만 재사용하며 목록 존재를 실행 권한으로 승격하지 않는다.
- Codex 실제 모델 unknown 및 Quality Loop production 교차 검증 사전 차단은 유지한다. 이번 라우팅의 review 요청은 별도 Quality Loop 모델 근거 확인이 필요하다는 차단 결과를 남긴다.

## 구현 순서와 파일

- [x] `shared/capability-orchestration.ts`, `server/capability-adapters.ts`: NativeProbeReport와 ExtensionInventory를 투영하는 명시적 Adapter Registry. 설치·auth 오인, 알려지지 않은 기능, 민감 메타데이터를 모의 테스트한다.
- [x] `shared/capability-routing.ts`, `server/capability-routing.ts`: 승인 기준/선택 revision과 Registry digest에 결속한 idempotent 추천 저장. 텍스트는 hash만 보존하고 외부 전송은 하지 않는다. 코드/비코드, 모호함, 수동 선택, Quality Loop 차단, 재시작·충돌·기준 변경을 검사한다.
- [x] `server/http.ts`: 인증/Origin/CSRF 아래 Registry GET, 명시 버전 refresh POST, 프로젝트 추천 POST/이력 GET. GET은 탐색·실행·재시도를 하지 않는다.
- [x] `server/project-progress.ts`, `shared/project-progress.ts`, `web/project-progress.tsx`: 작업별 추천과 고급 근거, 자연어 추천 입력. 실행 시작 버튼과 추천을 구분한다. 늦은 응답·프로젝트 전환을 검사한다.
- [x] 각 단계 단위/통합 검사 후 전체 테스트·타입 검사·빌드, 상태 문서 갱신. 실제 모델 호출은 하지 않는다.

## 남은 범위

이번 요청의 “구현 시작” 단계는 추천까지의 연결이다. 자동 dispatch, 동적 외부 실행기 등록, 확장 설치·호출, 비용 기반/LLM 기반 라우팅은 별도 후속 구현이다. Slash/Skill/Hook/MCP의 실행 지원은 확인 전 unknown/blocked로 유지한다. live 인증/연결·실모델 검증 및 OS별 실동작은 별도 승인과 근거가 필요하다. 기존 문서의 기능 설명을 실제 설치 버전의 검증으로 해석하지 않는다.

## 구현 결과와 사용 경로

- `GET /api/capability-orchestration`: 기존 캐시·연결·확장 관측을 조회한다. CLI/모델 호출 없음.
- `POST /api/capability-orchestration/refresh` + 빈 JSON: 기존 NativeProbeService의 `--version`만 명시적으로 요청하고 정제된 발견 기록을 보존한다. 인증·지원 기능·실행 확인으로 승격하지 않는다. 확장 목록은 기존 `/api/extensions/refresh`에서 별도로 명시 조회한 결과만 사용한다.
- `POST /api/projects/:projectId/capability-routes`: `{requestId,taskId,text,runtimeId?}`. 현재 승인된 작업만 추천하며 text 상한 4000자. 선택 실행기와 충돌하는 override는 차단한다. 자연어에 명시한 실행기도 무음 대체하지 않는다.
- `GET /api/projects/:projectId/capability-routes`: 프로젝트별 최근 추천 최대 200개. 진행판은 작업별 최근 20개를 읽는다.
- `GET /api/capability-orchestration/evidence/:digest`: 추천 당시 DB에 보존한 Registry를 조회한다. 과거 발견을 현재 실행 허가로 사용하지 않는다.
- `capability_routes`에는 원문 대신 text digest, 승인 기준 version/hash, preferences revision, registry digest와 상태·이유를 저장한다. `capability_discoveries`에는 해당 정제 Registry 스냅샷을 저장한다. 원문 자료·인증정보·로컬 경로·확장 handler는 저장하지 않는다.
- 기존 프로젝트 진행판의 작업을 펼쳐 원하는 작업을 설명하고 ‘실행 방식 추천’을 누른다. 간편 모드는 최신 결과 요약, 고급 모드는 이유·기준·근거 링크를 보여준다. 추천 후 실행은 여전히 기존 명시 실행 버튼·서버 사전 검사를 거친다. 추천이 기준/AI 선택을 수정하지 않는다.

## 지원 상태

| 범위 | 현재 구현/관측 |
|---|---|
| Provider Adapter Registry | Codex/Claude Code 두 기존 실행기에 대한 명시 등록된 메타데이터 어댑터. 임의 실행 경로/유료 API 추가 없음 |
| Codex discovery | 기존 버전 probe·연결 상태·정제된 확장 목록 관측 재사용. 연결 확인은 provider 필드에만 기록, 코드 실행 관측은 unknown |
| Claude discovery | 기존 버전 probe 재사용. 설치가 발견되어도 인증/연결/기능 관측 unknown. 설정·Skills·Hooks·MCP 디렉터리/인증파일 탐색 없음 |
| 실행 추천 | 기존 코드 프로젝트 Codex/일반 프로젝트 Claude 경로와 저장된 사용자 선택 보존. 코드 프로젝트의 문서 작업도 배제하지 않음 |
| 기획 추천 | 기존 planning 선택 별도 사용. 제안·승인 경로 재사용, 실행 안 함 |
| Quality Loop | review intent는 모델 증거 필요로 차단. 기존 실제 모델 unknown·독립 검증 사전 차단 변경 없음. 자동 검토 dispatch 연결 전 단계 |
| Slash/Skill/Hook/MCP | unknown/blocked. 목록 존재·configuredEnabled·nativeTrust는 호출 권한이 아님 |
| 자연어 해석 | 제한적인 로컬 한/영 규칙. 불명확/부정/혼합 요청은 확인 필요, 명시 미지원 이미지 생성/API/확장 요청은 차단. 모든 자연어 기능의 이해·적합성을 보증하지 않음 |

## 검증

Node24.22.1 전체 검사 `node --test tests/*.test.ts spikes/phase0/*.test.mjs`: 1294개 / 1292 pass / 0 fail / 2 Windows-only skip, exit 0. `/tmp/orbit-capability-final-tests.log`. Registry 모의 8개, 라우팅 6개, HTTP 1개 및 진행판 회귀 포함. 추가 planning 선택 revision 단언은 관련 6개 테스트 재실행으로 확인했다. `tsc --noEmit`, `node scripts/build.mjs`, `git diff --check` exit 0. 임시 Chrome 프로필의 모의 POST/프로젝트 전환/최신 서버 추천 병합/간편·고급 근거 표시 통과. 실제 CLI discovery·실제 App Server·모델 호출은 이번 구현 검증에서 하지 않았다.

리뷰에서 읽기 전용 연결의 코드 실행 관측 승격 및 오래된 local 추천 우선 표시를 발견해 수정했다. invalid version/관측 시각도 unknown으로 정제한다. 새 테스트의 미구현 오류와 미지원 이미지 생성 추천 회귀 실패를 확인한 뒤 구현·재검증했다. Chrome 첫 제한 환경 실행은 SIGABRT로 시작하지 못했고, 허용된 임시 프로필 실행에서 통과했다.
