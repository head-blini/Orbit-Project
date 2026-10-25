# Implementation Backlog — AI Coding Control Center v0.3

## 수행 규칙
- Phase별 게이트를 통과해야 다음 Phase 진행. 기능 목록 전체를 한 번에 생성하지 않는다.
- 세부 작업은 독립 PR/커밋 단위. 위험한 작업은 기존 소스 보존과 사용자 승인 필수.
- 각 작업에 **자동 테스트 + 실제 CLI 검증 가능 여부** 표시. 미검증 항목을 통과 처리하지 않는다.
- 초기 개발 목표는 **공급자 중립 개인 로컬 사용**이다. ChatGPT 계정·Codex 설치·외부 API 키 발급/별도 과금은 필수 조건 아님. 코딩 실행에는 지원되는 최소 1개 에이전트가 필요.

## Phase 0 — 환경·연결 검증 (반드시 먼저)
수동 기획·외부 AI 기획 경로는 **공통 Markdown/JSON fixtures**로 검증한다. V1은 ChatGPT 계정도 별도 API 키도 필요하지 않다.
| ID | 작업 | 완료 조건 | 비고 |
|---|---|---|---|
| S0-01 | 사용 OS, Node, Git, 지원 CLI 탐지와 `PATH` 점검 (개별 CLI 선택사항) | 실제 환경 표와 missing/capability 상태 표시 | 공식 로그인 완료 여부만 판단, 토큰 내용 수집 금지 |
| S0-02 | Claude Code JSONL 스파이크 | 메시지/도구/최종 결과·실패를 실시간 파싱, session ID 저장, resume 시도 | 실패 시 CLI/PTY 대안 설계 |
| S0-03 | Codex App Server stdio 스파이크 | initialize, thread, turn, item 이벤트 및 interrupt/approval 관찰 | 미지원 API는 capability=false |
| S0-04 | 사용량 스파이크 | Codex rateLimits/usage, Claude statusLine 지원 조건 확인; 불가능하면 unknown | 샘플값과 실제값 구분 |
| S0-05 | worktree 및 리뷰 격리 스파이크 | 코드가 main에 쓰이지 않음; 리뷰는 파일 변경 차단 | OS별 경로/권한 차이 점검 |
| S0-06 | UI 기반 재사용 평가 | CloudCLI 플러그인/포크와 Claude Deck을 설치 없이 소스/라이선스 수준으로 평가; 실제 설치 테스트 가능할 때 별도 수행 | 핵심 오케스트레이터는 독립 유지 |
| S0-07 | 제공자 중립 planning schema/수동 작성·외부 import POC | Markdown/JSON/붙여넣기 → 검증·미리보기·승인 → Task 변환 → 피드백 내보내기 계약 테스트 설계 | ChatGPT 계정 없이 통과해야 함; 사용자 승인 기반 |
| S0-08 | **GPT 없는 단일 제공자 E2E 스파이크** | Claude-only 환경: 수동 기획→코드 실행→체크→사람 승인. 미설치 Codex가 흐름을 막지 않음 | 임시 저장소와 모의 이벤트로 먼저 검증 |
| S0-09 | Provider Registry/capability 계약 시험 | `not_installed`, `auth_required`, `ready`, `unsupported`가 UX에 반영 | 자격증명 내용 접근 금지 |

**Gate 0:** 기획 파일과 내장 편집 초안이 동일한 스키마를 통과하고, 실제 연결 가능한 제공자 **1개**로 프롬프트→출력→중단/완료를 보여주며, 저장소가 훼손되지 않음. ChatGPT·Codex 계정이 없어도 Gate 0을 통과할 수 있어야 함.

## Phase 1 — 독립 로컬 백엔드
| ID | 선행 | 구현 내용 | 완료 조건 |
|---|---|---|---|
| S1-01 | Gate 0 | mono-repo 또는 `apps/web`, `apps/server`, `packages/shared` 구조 | 타입 검사·단위 테스트가 실행됨 |
| S1-02 | S1-01 | SQLite 마이그레이션과 task/run/event/approval/workspace 스키마 | 마이그레이션 재실행/롤백 검증 |
| S1-03 | S1-02 | 로컬 루트 경로 등록, Git 상태 검증, path allowlist | 미등록/상위경로/symlink escape 거절 |
| S1-04 | S1-02 | Task FSM / Run FSM + idempotency key | 유효하지 않은 상태 전이/중복 실행 거절 |
| S1-05 | S1-04 | 이벤트 저장/스트리밍 SSE/재연결 | 새로고침 후 누락 이벤트 순서대로 재수신 |
| S1-06 | S1-03 | Git worktree 생성/반납, 충돌/dirty 확인 | main 브랜치의 수동 수정 보호 |
| S1-07 | S1-04 | ClaudeAdapter 연결, 과정/오류/권한 이벤트 정규화 | CLI 파서 fixture 테스트 및 가능하면 실제 단발 턴 |
| S1-08 | S1-04 | **선택적** CodexAdapter 연결, app-server 프로토콜/버전 판별 | App Server 테스트 fixture 및 실제 턴/이벤트 |
| S1-09 | S1-07 또는 S1-08 | 설치된 제공자의 승인 브리지, 프로세스 실행 정책, cancel | 승인 거절·중단이 기록되고 권한 우회 없음 |
| S1-10 | S1-05 | 서버 재시작 reconciliation | 재기동 뒤 lost run 자동 중복 실행 없음 |
| S1-11 | S1-02 | 중립 planning_sources / planning_versions / planning_requirements / task_plan_links 스키마 | 불변 버전, import provenance, Task 승인 버전 추적 |
| S1-12 | S1-11 | Planning importer + 내장 에디터 + schema validation | Markdown/JSON/붙여넣기·직접 작성 저장·미리보기, 스크립트 실행·자동 fetch 없음 |
| S1-13 | S1-12 | 기획 승인·diff·Task 초안 전환 + 피드백 exporter | 승인 전 자동 실행 금지, 이전 버전과 비교·감사 기록 |
| S1-14 | S1-01 | Provider Registry + 역할 선택 정책 + capability 캐시 | 제공자 0개/1개/2개 상태를 분리, 존재하지 않는 모델/기능 선택 금지 |

**Gate 1:** **제공자 1개만 연결해도** 실제 작업 하나가 실행되고 UI 새로고침 후 증거가 보존됨. 제공자 0개일 때 기획 기능은 동작함.

## Phase 2 — 웹 관제와 검증
| ID | 선행 | 구현 내용 | 완료 조건 |
|---|---|---|---|
| S2-01 | Gate 1 | Dashboard / Project selector / Work board | 대기·실행·승인·실패/미검증 별도 표시 |
| S2-02 | S2-01 | Command center / model picker / run stream / cancel | 프롬프트 중복 제출 방지, 모델 동적 조회 |
| S2-03 | S1-06 | Git diff/files/branch/commit view | 리뷰 기준 SHA/dirty 상태 정확히 표시 |
| S2-04 | S1-09 | Approval inbox | 대상 명령/파일/위험·승인 범위, 명시적 결정/감사 로그 |
| S2-05 | S1-03 | Verification runner | 사전 등록된 테스트 명령만 실행; exit code/SHA/log 저장 |
| S2-06 | S2-05 | 선택적 read-only review / 사람 검토 | 다른 제공자 없으면 새 격리 세션/사람 검토로 대체, 출처 유형 기록 |
| S2-07 | S2-02 | 연결된 제공자의 Usage dashboard | 근거/수집 시각/unknown과 expired 상태 표시 |
| S2-08 | S2-04,S2-05,S2-06 | Task 완료 게이트와 승인 버튼 | 미검증/거절 상태에서 Done 전이 불가 |
| S2-09 | 전부 | E2E: 기능 요청→구현→테스트→리뷰→승인 | 실제 저장소 1개에서 녹화 가능한 재현 시나리오 |
| S2-10 | S1-13 | **Ideas & Planning 화면** | 내장 편집/연결 AI 계획 모드/외부 도구 import·미리보기·승인·Task 전환, 버전 diff |
| S2-11 | S2-09,S2-10 | **E2E 2경로:** Claude-only 내장 기획→Claude 구현→테스트/사람 승인, ChatGPT+Claude+Codex 외부 기획→교차 리뷰 | 어느 경로도 다른 계정을 강제하지 않으며 버전·증거 연결, feedback roundtrip 검증 |
| S2-12 | S1-14,S2-01 | 선택적 온보딩·Provider Settings | AI 0개/1개/2개 상태를 보여주고 개별 로그인 연결만 안내, 강제 가입 없음 |

**Gate 2 = MVP:** **ChatGPT 없이 단일 에이전트**로 내장 기획→구현→테스트→승인이 완결되고, ChatGPT를 사용하는 경우 외부 기획 인계와 재기획 피드백도 동작함. 교차 리뷰는 복수 AI 구성에서만 요구.

## Phase 3 — 프로젝트 지능화
| ID | 구현 내용 | 완료 조건 |
|---|---|---|
| S3-01 | Graphify 오프라인 인덱스 생성/노드 검색 | 분석 SHA·도구/schema 버전 표시 |
| S3-02 | 코드 그래프 + Git Diff 연결 | 변경 영역 하이라이트, stale 판별 |
| S3-03 | 프로젝트 장기 메모리(결정·실패·해결) | 인계에 필요한 최소 맥락만 포함 |
| S3-04 | 각 제공자별 MCP·스킬·플러그인 inventory | 범위·설치 상태·버전·프로바이더별 차이 표시 |
| S3-05 | 확장 설정 diff/백업/원자적 적용/복구 | 적용 실패 시 기존 구성이 보존됨 |
| S3-06 | 승인과 변경 기록에서 audit export | 토큰/비밀정보는 제거된 JSON/Markdown 내보내기 |
| S3-07 | (선택·opt-in) ChatGPT 커스텀 MCP Planning Bridge | 사용자 접근 확인, HTTPS 터널·인증·도구 범위·철회, 외부에서 실행/코드 쓰기 권한 없음 |
| S3-08 | Gemini CLI Adapter (Google 계정/키, 스트리밍 이벤트) 검증 | 자체 인증·모델 조회·승인·사용량 capability를 통과한 기능만 표시 |
| S3-09 | OpenCode / local model Adapter 타당성 검증 | 모델·인증 방식과 제공자별 금지사항 확인, 최소 기능 계약 테스트 |

## Phase 4 — AI 협업 자동화
| ID | 구현 내용 | 완료 조건 |
|---|---|---|
| S4-01 | 규칙 기반 담당 추천 | 위험/한도/기능 미지원시 추천 이유 표시 |
| S4-02 | 한 작업에 다수 worktree 분업 | 독립 파일 작업 시 충돌/경합을 감지 |
| S4-03 | 정형 handoff 패키지 | 목표·SHA·변경·테스트·미해결 질문 인계 |
| S4-04 | review→fix→retest 제한 반복 | 최대 반복/사용량/승인 정책 준수 |
| S4-05 | 성능 비교·품질 대시보드 | 모델별 결과는 작업 난이도/지원 차이와 함께 해석 |

## 개발 도구·테스트 권고
- TypeScript 타입 체크, formatter, lint, Vitest(계약 테스트), REST/SSE E2E, Git 기반 통합 테스트.
- 공급자 실제 로그인 검증은 사용자 머신에서 수행. CI에서는 **사전에 저장한 익명 이벤트 fixture**와 가짜 ProviderAdapter 사용.
- 명령 실행 테스트는 격리된 임시 Git 저장소에서 수행하고, 실제 사용자의 프로젝트에는 무단 테스트 커밋 금지.
- 리뷰 자동화에는 테스트 실패/버전 불일치/CLI 승인 대기/서버 crash/중복 click/로그 비밀정보 사례를 포함.

## 첫 구현 착수 세트
가장 먼저 **S0-01, S0-02 또는 S0-03(설치된 1개), S0-05, S0-07~S0-09**를 착수하고 결과 표를 만든다. 이 스파이크가 불가능하면 UI부터 개발하지 말고 제공자 연결 전략을 수정한다.
