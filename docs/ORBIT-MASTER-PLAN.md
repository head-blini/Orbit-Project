# Orbit 전체 구현·검증 계획

**Goal:** 확정된 A–K 기능과 웹의 기획 → Task → AI 실행 → 코드 변경 → 실제 검증 → 승인 → 결과물 경로를 완성한다. 일부 단계 통과를 전체 완료로 표시하지 않는다.

**Architecture:** 현재 로컬 통합 worktree의 TypeScript/React/Node 24/SQLite 구현을 확장한다. 기존 Codex App Server, Studio, 프로젝트 격리, Runner를 재사용한다. 공통 Controller/HTTP/Store/shared 타입 연결은 메인 에이전트 한 명이 맡고 독립 모듈·테스트만 서브에이전트에 배분한다.

**Spec:** 사용자가 지정한 `goal-objective.md`(2026-10-25), AGENTS.md, PRD/TECH-DESIGN/BACKLOG, Provider-Neutral Core, Planning Bridge, 세 모듈 통합 계약. 최신 전체 요구가 이전 Phase 범위를 확장하되 기존 보안 경계는 유지한다.

## 전역 제약과 결정

- 사용자 DB/WAL/SHM, 인증정보, 기존 dirty 변경과 원본 worktree 보존. 임시 DB/Git fixture에서만 검증한다.
- 원격 push, 배포, 외부 서비스 활성화, 결제, 인증정보 발급·열람 없음. 제공자 실서비스 검증은 모의 계약 테스트와 구분한다.
- loopback, Origin/CSRF/session, MCP 격리, sandbox, 쓰기 allowlist, fail-closed 정책 유지.
- 확인할 수 없는 사용량/비용은 unknown. agent completed와 verification passed는 별도 상태.
- 기존 설계와 재사용 모듈을 선택했다. 전체 재작성·중복 오케스트레이터·새 UI 프레임워크는 요구와 불일치하므로 채택하지 않는다.
- 이미 존재하는 `integration/orbit-20261025104804486-08592a18` 브랜치/worktree에서 계속한다. 기존 미커밋 통합 변경은 이 작업의 신규 변경으로 오인하지 않는다.
- 일반 사용자 실행 승인을 받은 빌드는 사용할 수 있다. 권한·보안 설정 변경이나 샌드박스 우회 코드는 넣지 않는다.
- 2026-10-25 추가 사용자 지시: 기존 전체 설계 완성이 최우선이며 현재 개발 범위의 빌드/테스트/브라우저 검증을 먼저 끝낸다. 그 후 Codex/Claude Code 공식 기능을 Capability Registry에 반영하고 Solo/Cross Review/Debate/Race/Cooperate/Goal 실행 모드를 설계·연결한다.
- 경쟁 실행은 서로 다른 worktree, 동일한 승인 요구사항 버전·base SHA·명령·E2E 시나리오를 사용한다. 결과 비교는 agent 자기평가가 아닌 실제 검증 증거에 따른다. 구독 인증과 API 과금·권한·사용량 상한을 분리하고, 미지원/미설치/미검증을 ready로 표시하지 않는다.
- Skills/MCP/Hooks/subagents/Goal/plan/verification 인터페이스는 공식 API/CLI 재사용이 우선. 서드파티는 출처 검토·격리 실험을 거치기 전 설치하거나 활성화하지 않는다. 추가 프레임워크 의존성 도입 없음.
- 2026-10-26 Mac 재개: 인계 branch `codex/orbit-mac-handoff-2026-10-26`, HEAD `23a9296`의 깨끗한 clone에서 계속한다. Node 24.22.1을 공식 SHA-256 검증 후 ignored `.local/toolchains`에 준비했다. Mac native resolver/진단, canonical 임시 fixture, Bedrock 기본 임시 root, 프로세스 종료 관찰, Extensions 실패 unlock 수정 후 기본 병렬 `npm run verify` 479 pass/1 Windows-only skip/0 fail·type/build0. Task17 전용 Chrome 검증은 완료했으며 전체 Goal과 Windows 최종 gate는 진행 중이다.

## 요구사항 상태 (2026-10-26 갱신)

| 영역 | 실제 구현 | 남은 구현/검증 |
|---|---|---|
| A Dashboard/Projects | 프로젝트 등록/전환, 격리 worktree, Task/run 연결·SSE·복구·검증 승인·병합 이력 | 프로젝트 관리 확장 |
| B Planning | Markdown/JSON 무손실 import/export, SQLite 버전·승인, Task→실제 Codex brief, 개발 증거 수동 피드백, 버전 diff·영향 Task·선택 후속 Task 생성 | decisions/provenance 확장, 선택적 AI 기획 |
| C Agent Center | Codex App Server prompt/stream/interrupt/reconnect | Task 역할·handoff, 선택형 CLI 진단/adapter, 내장 병렬 기능 연결 |
| D Development | 격리 patch worktree·diff, 실제검증·중단·복구·리뷰승인; source 보존·별도 승인 ff 병합; JS/TS 소스 graph/잠재영향·탐색·재시작 검증 | 별도 읽기 전용 native 리뷰 연결·로컬 계약 검증 완료; 실제 AI 리뷰/다른 언어 분석 미검증 |
| E Visualization | 제한 Mermaid flowchart/SVG, architecture, Artifact 이력·source staleness, 실제 editable PPTX/MD·브라우저 저장 검증 | PDF, sequence/C4/UML |
| F Automation | 로컬 고정 명령 workflow/template 버전·DAG·명시 실행·실패 중단·재시도·lost 복구, 실제 Node·Windows browser 검증 | 예약·외부 서비스 단계 미연결 |
| G Model Hub | 5종 HTTP 호환 + 공식 AWS CLI 2 Bedrock text adapter·명시 진단/전송·중단·unknown usage/cost·복구; 7종 상태, mock/미설치 E2E | 실제 AWS/외부 실서비스 인증·호환 검증, 고급 라우팅/비용 집계 |
| H Extensions | 공식 Codex 읽기 전용 metadata inventory·캐시·UI·fake RPC/HTTP 계약, Mac Chrome 2시나리오·독립 리뷰 | Windows 37단계 통합 재검증, profile/source·권한 preview/backup/restore·실제 native 조회 |
| I Privacy/Security | loopback/session/Origin/CSRF/MCP·sandbox, 입력 검사·출력 redaction·source fingerprint | 프로젝트별 정책·fallback 재검사·감사 확장 |
| J Usage | Codex 공식 계정 quota/token 조회·출처/시각·unknown 처리, live available 확인 | 작업별 token/time/retry·API 비용·다른 제공자 집계 |
| K Runner | 기존 Runner 명령 검증·중단·재시작 quarantine, native Git 후보/ff 반영·관찰 복구 연결 | 다중 worker 결과의 순차 통합 |
| 추가 Capability/실행 모드 | 공식 Codex/Claude Registry·native 진단·6모드 설계·Race 동일증거/격리·예산 순수계약 | Solo 외 5 executor, 새 gate Controller 연결 |

## 실행 순서와 소유권

- [x] Task 0: 실제 통합 worktree, OS/도구, 기존 결과 및 baseline 확인. 타입/전체 테스트/빌드 결과는 RESULTS에 기록.
- [x] Task 1: 출력 비밀정보 보존 결함을 합성값으로 재현하고 수정. raw item 전체 좌표에서 credential와 미완성 tail을 함께 처리; 독립 리뷰에서 발견한 cross-item PEM/assignment도 수정. 관련 검사 통과. 최종 전체/E2E는 Task 8에 남음.
- [x] Task 2: 실제 editable PPTX ZIP/XML·MD export 연결. ZIP/XML/shape/text/connector·악성 입력·Python 재편집 확인. 명시 browser download folder+제품 버튼으로 실제 파일 저장·bytes 일치 검증. CLI download 명령 취소는 별도 도구 한계.
- [x] Task 3: 승인된 Planning에서 constraints를 포함한 실행 brief 생성, 미결정 사항 gate, Task→Run 연결. 서버 current head·workspace·프로젝트 gate, 원자적 Task/Run metadata, uncertain response 리플레이·재시작 회귀 통과. 웹 실행 버튼 연결; 실제 Codex/브라우저 실행 검증은 Task 8에 남음.
- [x] Task 4 수직기능: 명령 설정·preview·승인·실제 Check·중단·lost복구·변경 무효화·리뷰승인 UI. 기존 Runner 재사용. 실제 Codex 승인Task→패치→Node검증→승인서비스→PPTX/MD 단일 smoke exit0. 안전한 merge는 남음.
- [ ] Task 5: 실제 모델 transport/진단과 전송 정책·stream/usage. 외부 활성화 없이 local mock server 계약 테스트; 미보유 계정은 미검증.
- [ ] Task 6: source graph·다이어그램·staleness·문서/PDF export. 실제 파일 출력 및 재편집 검증.
- [ ] Task 7: Automation/Extensions/Analytics를 기존 상태·실행기로 연결. 각 기능마다 실행 가능한 계약과 복구 테스트를 먼저 확정.
- [ ] Task 8: Windows browser E2E, refresh/restart, 전체 회귀/typecheck/build, 실제 운영 문서 정합성, 독립 리뷰. 불충족 요구는 남겨 전체 Goal 미완료로 유지.
- [x] 초기 통합 검증: 196 테스트·타입·build·browser18단계를 통과했다. 이후 실제 HTTP/verification을 연결했고 다운로드도 명시 폴더+제품 버튼으로 검증했다. 과거 실패와 후속 gate는 RESULTS에 별도 보존한다.
- [x] Task 9: 공식 Codex/Claude capability 조사 및 Registry·안전한 native 버전 진단·웹 표시. 문서/설치/runtime/policy/test·auth/billing을 분리함. 전체221/type/build/browser18 통과. 실서비스 미검증·미연결 기능은 그대로 표시.
- [ ] Task 10: 6모드 설계·순수 gate·Race 비교 계약·UI 설명 완료(12 focused+독립리뷰). Solo 기존 실행기 외 5 executor 및 새 gate의 Controller 연결은 미구현. 역할·인계·종료/예산·승인 통합을 다음 수직기능과 연결한다.
- [x] Task 11: TypeScript 5.9.3 map-only source graph 수직기능. Git 목록·같은 bytes의 fingerprint·민감 경로/links/크기 제한, source-bound 그래프·코드 탐색·잠재 변경 영향·Artifact 현재성. 독립 리뷰 P2 2건 수정. 전체278/278·type/build0·Windows22/22·30PNG·재시작 복구 확인. 다른 언어/runtime정확성은 범위 밖. 새 프레임워크·Graphify 설치 없음.
- [x] Task 5 HTTP 수직기능: 기본 registry 빈 목록, 7종 상태와 5종 HTTP 호환 adapter 분리. 서버 destination/모델 allowlist/정책·승인, inert GET·명시 models/chat POST, bounded stream·중단·사용량 unknown·재시작 uncertain 구현. 전체303/303·type/build0·Windows24/24·32JPEG 통과. 실제 AI/외부 HTTP 0회. Bedrock과 외부 실서비스 검증은 남음.
- [x] Task 12: 기획 저장 버전 MD/JSON 무손실 내보내기·Task/Run 개발 증거 피드백. sourceIssue 수집실패 P2 회귀 수정. 전체322/322·type/build0·Windows26/26·34PNG, 실제 다운로드 MD/JSON 재가져오기·피드백 bytes·기존 승인/Task 보존 확인. 계획: docs/superpowers/plans/2026-10-26-planning-handoff.md.
- [x] Task 13: 승인 raw snapshot→독립 후보 commit→별도 승인→clean 동일 base primary ff 병합. 전체358/358·type/build0·Windows29/29·37PNG. 원 source HEAD/index/bytes·기존 두 fixture 보존과 실제 ff·refresh/restart/no replay 검증. durable intent·멱등성·미확정 관찰 복구, native Goal 명시 차단/Registry 정합성 포함. 계획: docs/superpowers/plans/2026-10-26-approved-merge.md.
- [x] Task 14: 로컬 명령 워크플로 저장 버전·DAG·preview/별도 승인·실제 Runner·실패 중단·명시 재시도·lost 격리/복구. 전체382/382·type/build0·Windows32/32·40PNG. 실제 exit7/종속 skip·attempt2·실제 중단·restart/no replay·source 보존 확인. 계획: docs/superpowers/plans/2026-10-26-local-workflows.md.
- [x] Task 15: 선택형 공식 AWS CLI 2 Bedrock catalog/Converse adapter. 전체405/405·type/build0·Windows33/33·41PNG. strict 서버 설정·명시 동의·소유 임시 입력 정리·restart root 보존·unknown 과금, 실제 로컬 Node/mock 계약·미설치 browser 진단/재시작/no replay 검증. 실제 AWS 인증/모델/청구는 미검증. 계획: docs/superpowers/plans/2026-10-26-bedrock-cli.md.
- [x] Task 16: 공식 Codex 별도 읽기 전용 Native Review. bounded 정제 Diff preview/동의·source/input 결합·단일 review/start·중단·lost 복구·독립 이력 구현. 전체445/445·type/build0·Windows35/35·43PNG 통과. 실제 AI 리뷰와 전체 Cross Review executor는 별도 미검증/미구현. 계획: docs/superpowers/plans/2026-10-26-native-review.md.

- [x] Task 17 로컬 수직기능: 공식 Skills/Hooks/thread-scoped MCP inventory·실행 상호 배제·60초 캐시·세션 폐기·원문 비노출·null 읽기 전용 세션 UI. Mac 기본 전체479pass/1skip·type/build0, focused39/39, 독립 리뷰의 실패 unlock 수정 후 추가 지적 없음. exact7th fixture와 Chrome CUA 2시나리오·2JPEG에서 명시 수집/캐시/restart unknown·자동 조회0·source 보존 확인. 통합 스크립트는37단계/45PNG로 확장했으나 전체 실행 및 Windows 재검증은 남아 있다. 실제 native 목록 조회도 미검증. 계획: docs/superpowers/plans/2026-10-26-extension-inventory.md.
- [x] Task 18 로컬 수직기능: 저장 기획 버전 비교·영향 Task·명시 승인 후 선택한 후속 Task 생성. 기존 이력 보존, head/preview digest·receipt·부분 생성 후 전체 생성 경계 구현. 독립 리뷰의 저장 문서 크기 재검증·이전 Task 없는 요구사항 표시 오류를 수정했다. 최종 전체515pass/1 Windows-only skip/0fail·type/build0. 전용 Chrome CUA 비교→승인→R1 선택 생성→전체 생성→reload/restart 검증,3JPEG·console0·AI/CLI/외부요청0·source 보존·cleanup 완료. Windows/전체 통합 E2E는 별도 미검증. 계획: docs/superpowers/plans/2026-10-26-planning-revisions.md.

## 검토 초점

### 검증·승인 공통 기준

1. 서버의 프로젝트별 고정 명령 목록(기본 빈 목록)을 읽고 인자 비밀값·shell·설정 변경을 차단한다. 브라우저에는 명령 preview와 config/source digest를 제공하고 승인 클릭 시 같은 digest인지 재확인한다.
2. 기존 Projects의 hardened Git·worktree 검증과 별도 bounded source fingerprint를 사용한다. Git-visible tracked/nonignored 파일만 포함하고 민감 경로는 읽기 전에 거절한다. ignored 의존성과 중간 수정 후 원복은 증명 범위 밖임을 표시한다.
3. 기존 Runner process/verification을 재사용해 별도 Check를 SQLite/event에 보존한다. terminal Run과 workspace에 결합하고 agent/check/전환 동시 실행을 막는다. stdout 원문·명령 인자는 로그에 저장하지 않는다.
4. 정상 종료 abort, 재시작 미완료 check→lost. 이전 OS 프로세스 종료를 확인하지 못하는 workspace는 새 실행 차단하고 명시적인 사용자 확인 경로를 제공한다. PID만으로 다른 프로세스를 kill하지 않는다.
5. Development에서 preview→실행→중단→결과·stale를 제공하고, 검증 결과를 사용자 리뷰 승인과 분리한다. 자동 merge는 하지 않는다. 설정 없는 planning-only 흐름을 유지한다.
6. 임시 DB/worktree/고정 Node fixture로 권한·멱등성·stale·실패·복구·중단을 검사한 뒤 타입/전체/build/browser 실행한다.

1. 스트리밍 조각에 걸친 비밀정보: 최종 응답뿐 아니라 이벤트·DB에도 원문 미노출.
2. 승인 이후 수정된 계획/HEAD: 낡은 승인으로 실행·merge하지 못함.
3. 응답 유실과 재시작: 같은 요청이 중복 모델 실행·Task 생성으로 이어지지 않음.
4. 제공자 전환/redirect/timeout/잘못된 정책: 목적지 재검증, 기본 차단, 민감 오류 미기록.
5. 결과물: 실제 ZIP/XML/PDF/다이어그램 파일을 검사하고 mock bytes나 중간 JSON을 완료로 보지 않음.

각 task는 실패 재현 → 최소 구현 → 관련 검사 → 리뷰·통합 → 상태 갱신 순서로 실행한다. 새로운 사용자의 명시적 중단이나 실제 차단이 없으면 다음 미완료 항목으로 계속한다.
