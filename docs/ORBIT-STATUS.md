# 릴리스 문서 정합 재개 상태 (2026-10-30 · Claude Code 문서 정합 작업 RELEASE-DOCS)

- 기준: 개발 브랜치 `codex/orbit-mac-handoff-2026-10-26` HEAD `ea59619`(배치 1~19 fast-forward 반영, Push·main 병합·배포 없음). 오케스트레이터 기록 `.local/orchestrator/STATE.md`(gitignored)의 배치별 기록을 근거로 한다. 이 갱신은 문서 정합만 하며 코드·테스트를 실행하지 않았다.
- 마지막 전체 검증(STATE.md 기록): Node24 `npm run verify` exit0 **2086 tests / 2084 pass / 0 fail / 2 skip**(배치 19). 이 수치는 mock/fake 테스트 기준이다. 실제 모델·Provider 성공을 뜻하지 않는다.
- 배치 요약(커밋은 STATE.md): 1 TOOLS T3~T6·PRODUCT P1~P3 / 2 CQG-6a·6c·5, FE-1~3, HE-1 / 3 CQG-6b·PLAN-DEPTH(`38c1d08`)·ORCH-REGSEL / 4 GENERAL-ACCEPT-A·HE-2·HE-3·P7(`c0c6ab9`) / 5 HE-4·HE-6·TOOLS-T7(`c9b6eb9`) / 6 HE-5a / 7~9 PII 오탐 수정(`9b2f3f2`, `2cbff45`)·P4~P6(`f0cc85e`) / 10 P8 fake E2E(`f55fdf5`) / 11 RECOVERY-UX(`ce66c15`, `787e093`) / 12 CODE-RUN-PROJECT(`1cfe368`) / 13 CODE-SOURCE-DIGEST(`3fcbe19`) / 14 HANDOFF-RECEIPT(`726bb48`)·T7-FOLLOWUP(`be88ce8`) / 15 ORCH-REGSEL-WEB / 16 F02-REG(`c455fae`, `3e38aad`, `b7ec6b9`) / 17 FE-4(`27352d8`) / 19 HE-5b(`9fdf007`)·HE-7(`d42c213`, `93be2f9`)·SAVEPOINT 수정(`ea59619`). 배치 18은 HE-5b NESTED_TRANSACTION으로 중단되어 19로 대체했다.
- 근거 구분(엄격):
  - **live 검증됨**: LIVE-CLI 2026-10-29(HEAD `fecf6ff`)의 Codex CLI 0.165.0 `execute.code` 1회, Claude Code 2.1.312 `execute.general` 1회([결과](ORBIT-LIVE-CLI-2026-10-29.md)). Claude 모델 `claude-opus-5-5` native_observed, Codex actual model unknown. 두 실행 모두 "실행 완료"이며 독립 품질 통과가 아니다. 이후 HEAD(`ea59619`)에서 live 재실행은 하지 않았다. 과거 FF1(Claude Chrome E2E)·Phase3~5 live 기록은 해당 시점 HEAD 기준이다.
  - **fake/mock 테스트만 검증됨**(live 미검증): Task Graph·Parallel Workers(PW-1~5)·CQG-1~6c·Registry R1~R5(실제 연결 진단 미실행)·Usage U1~U4(실제 quota 조회 0회)·Tools T1~T7(실제 도구 호출 0회)·Failure Intelligence FE-1~4·Harness HE-1~7·P1~P8(`tests/product-e2e.test.ts` fake)·RECOVERY-UX·HANDOFF-RECEIPT·F02-REG·PLAN-DEPTH.
  - **사용자 승인 대기로 차단**: 아래 "남은 차단·승인 필요".
  - **deferred(삭제 아님)**: ChatGPT 웹 연동(F04 웹 부분·A06)과 GPT-G1/G2/G3(브랜치 `claude/gpt-g1`, `claude/gpt-g3`, `codex/gpt-g2` `73471e1` 보존, 통합 큐 제외). [결정](ORBIT-DECISION-2026-10-29-GPT-DEFERRED.md).
- 알려진 이슈: 부하 시 간헐 실패하는 테스트(`tests/quality-loop-controller.test.ts`, `tests/codex-planning.test.ts:158`)는 각각 `982a42e`, `856c86d`로 시간 예산·PII 오탐을 보정했다. 배치 10·14 verify #1 실패(부하 flake, handoff view TypeError)는 재실행/수정 후 통과했다. 새 flake는 별도 조사한다.

## 남은 차단·승인 필요 (2026-10-30, `.local/orchestrator/BACKLOG-DAG.md` 기준)

사용자 결정·승인이 필요한 항목이다. 승인 전에는 구현·실호출을 하지 않으며 완료로 보고하지 않는다.

| 항목 | 내용 | 필요한 것 |
|---|---|---|
| CQG-6B-CTL | `server/controller.ts:801` 배치 입력 해시와 인계 입력 불일치(`WORKER_INPUTS_CHANGED`). 업로드 자료·상속 입력 의존 작업이 막힘 | 게이트·controller 변경 승인(사용자 결정 6에서 금지) |
| GENERAL-ACCEPT-B | 일반 후보 근거 생산기 없음. 후보 `semantic_review`를 검토 바이트 동일성으로 충족해도 되는지. 호스트 `requiredChecks` 없는 일반 프로젝트는 막힘(`server/verification-service.ts:149`). 기본값: 실패 기록 → 일반 worker 자동 적용 차단 유지 | 사용자 결정 |
| RECOVERY-UX 결정 | (1) 재시작·종료 미관측은 pid 증거 없이 사용자 확인으로 해제(고아 claude 프로세스 위험), (2) 해제 단위가 run이라 같은 프로젝트의 다른 작업도 풀림, (5) quota 정보가 메모리에만 있어 재시작 시 소실, QUOTA_EXHAUSTED 실패 run이 `quota_wait`가 아닌 error로 표시 | 사용자 결정 |
| F02-REG 결정 | (1) 등록 폴더 AI 쓰기 기본값(현재 fail-closed: 격리 공간 전까지 비격리 AI 실행 금지, `3e38aad`), (2) 기획 미리보기 digest가 자료 내용을 제외해 교체해도 비worker 계획·run이 stale되지 않음, (3) 일반 폴더가 코드 저장소와 `ORBIT_ALLOWED_PROJECTS` 공유, (4) `/Volumes` 차단, (5) 기존 inputs/output 거절·"그대로 사용" 없음, (6) 보관된 자료 버전 복원 없음, (7) 경로 수동 입력(서버 선택기 없음) | 사용자 결정 |
| REG-ISOLATED-PLANNING | 등록 폴더용 격리 기획 공간이 없어 등록 폴더 AI 기획 불가. 레거시 일반 프로젝트가 생성 영수증이 없으면 등록 폴더로 취급됨(fail closed) | 설계 + 사용자 결정 |
| FE-5 | `run.failed` 이벤트 사유 변경, Codex 원문 실패 텍스트 노출 중지(controller) | 이벤트 변경 승인 |
| Harness live runner | production 평가 runner·suite가 없어 모든 실제 평가가 `RUNNER_UNAVAILABLE` → 승격 불가. 보호/일반 suite 등록 기능 없음, 근거 없는 사용자 제안은 통과 불가 | live 호출 승인 + 설계 |
| LIVE-* 묶음 | 현재 HEAD 재실행(A01·A04·A05·A09·A12·A13·A16·AX07), A07 Codex↔Claude 인계, A08 다른 모델 Reviewer 호출, A10 라이브 실행 중 HTTP 재시작, AX01~AX03 두 Worker 동시 live(LIVE-PAR), A14 실제 quota 관측, A15 TOOLS-T8 실제 도구 호출, Registry 실제 연결 진단, CORE-LIVE 잔여 | 추가 실호출 승인(사용량·권한 범위 명시) |
| Graphify 결정 | 제품 내 자체 TS-AST 소스 그래프(`server/source-graph-service.ts`)를 "Graphify 또는 검증된 대안"으로 인정할지, 또는 Graphify CLI 설치·subprocess 연동 | 사용자 결정·설치 승인 |
| 도구 정책 확장 | Skills, Claude MCP, Plugins 호출 허용 범위 확장(현재 Subagent/Slash/Skill/MCP/Hook 호출은 차단, metadata discovery만) | 사용자 승인 |
| 외부 한계: Codex 모델 관측 불가 | `codex.app_server`가 실제 모델을 노출하지 않아 Codex 산출물은 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 독립 교차 검토 차단(A08·AX04). Orbit 코드로 해결 불가, 대체 관측 경로는 미승인 추론 | 외부(Codex) 변경 또는 새 승인 |

그 밖의 미해결(승인 대기 아님): T7-FOLLOWUP 설계 질문(`server/project-progress.ts:155` requiredTools는 완료 결속 run이 tool-invocation run일 때만 충족), P8 관찰 사항(통합 결과물 버전의 runId/taskId null로 goal 참조 제외, 코드 자료 업로드·결과물 다운로드의 `GENERAL_PROJECT_REQUIRED`), `web/project-work.tsx:97` 진행판 `projectKind="general"` 하드코딩(의도 여부 미확인), HANDOFF-RECEIPT의 Codex 기록 경로 전용 테스트 없음, 작업 분해 기준(제약을 작업으로 쪼개지 않기) 미확인.

# 우선순위 변경 — ChatGPT 웹 연동 보류 (2026-10-29 · Claude Code 오케스트레이터)

- 사용자 결정: ChatGPT 웹 연동(F04 웹 부분·A06)은 1차 실사용에서 **deferred**(삭제 아님). 1차 완료 기준은 A06 제외, 전체 제품 완료 기준은 A06 포함. [결정 문서](ORBIT-DECISION-2026-10-29-GPT-DEFERRED.md).
- GPT-G1/G2/G3 브랜치 보존·통합 큐 제외. dev 동작 변화 없음.
- 진행: Claude Code+Codex 중심 Parallel-First — CQG 완성, 실제 병렬 E2E, 첫 실사용 흐름, Registry, Usage, Skills/MCP/Plugins, Harness Evolution. 정책 유지: Adaptive Model Routing, CQG, 단일 통합 큐 자동 적용, 권한·보안. Push·main 병합·배포·신규 유료 API 금지.
- 운영 상태·Worker pool: `.local/orchestrator/BACKLOG-DAG.md` (gitignored).

# USAGE 재개 상태 (2026-10-29 · Claude Code 오케스트레이터)

- HEAD `25ca69b`. 설계 [ORBIT-USAGE-D1](ORBIT-USAGE-D1.md) `b5eb9c3`(보수적 기본값). U1 계약·정규화 `0b6fe1e`(Codex), U2 관측·저장 `66476f8`(Codex), U3 HTTP·진행 신호 `764e88f`, U4 화면 `25ca69b`(Claude).
- 동작: 공식 경로 관측값만 표시. Claude 잔여율은 유효 utilization일 때만 계산값으로 표시. 60초·연결 끊김·재시작·창 초기화 경과 시 마지막 관측(stale). 계정 미식별·공유 미확인·ChatGPT 웹은 unknown. 진행판의 `available`은 최신 관측일 때만, 관측된 거부(`exhausted`)는 오래돼도 유지(보수적).
- 검증: Node24 `npm run verify` exit0 **1497 tests /1495 pass /0 fail /2 skip**. 실제 quota 조회·모델 호출 0회(mock-tested).
- 후속: 읽기 시점 freshness가 창 초기화 경과를 재검사하지 않음(60초 정책이 먼저 적용). 다중 계정·로그인 전환·계정 별칭은 별도 승인.

# Task Graph · Registry 재개 상태 (2026-10-29 · Claude Code 오케스트레이터)

- 기준 브랜치 `codex/orbit-mac-handoff-2026-10-26` HEAD `fc0afd1`. Codex 작업은 `/codex` Skill로 위임, 오케스트레이터가 코드 검토·전체 verify 후 커밋·병합.
- CORE-LIVE 일부: 일반 작업 프롬프트가 승인 기준의 파일 지정을 우선하도록 수정 `a8601d7`. Codex actual model unknown(app-server 미제공)은 차단 유지.
- TG(X01): 승인 기획 결속 Task DAG `b6a98e8`(Codex TG-01) + HTTP `4c506d2`. `done`은 CQG가 정의되기 전까지 표시하지 않음. 검증 1419/0 fail.
- REGISTRY(X08): 설계 [ORBIT-REGISTRY-D1](ORBIT-REGISTRY-D1.md) `622cafe`(보수적 기본값), R1 계약·저장 `96eff58`, R2 서비스 `f230799`, R3 Model Hub·Controller 연결 `bc061a6`(Codex), R4 UI·R5 HTTP `fc0afd1`(Claude). 인증 값 미저장·참조 이름만, 사용자 항목 기본 비활성, 연결 진단은 명시 확인 + 서버가 projectId를 경로로 매핑.
- 검증: 최종 Node24 `npm run verify` exit0 **1471 tests /1469 pass /0 fail /2 skip**. Registry 화면 Mock headless Chrome 확인. 실제 외부 연결 진단·실모델 호출 0회(mock-tested 상태).
- 알려진 이슈: `tests/quality-loop-controller.test.ts`가 부하 시 간헐 실패(`'failed' !== 'passed'`, 26회 중 2회). 이번 변경 이전에도 같은 파일에서 관측. 별도 원인 조사 필요.
- 다음: USAGE(잔여 한도, 기존 usageSnapshot/claudeQuota 재사용 확인), PW, CQG, FE, HE, TOOLS, PRODUCT. GPT-EXCHANGE 실연결·추가 실호출은 별도 승인.

# QG 통합 · LIVE-CLI 재개 상태 (2026-10-29 · Claude Code 오케스트레이터)

- 승인: `ORBIT-SCOPE-EXTENSION-2026-10-29.md`, `ORBIT-UNIFIED-BACKLOG-2026-10-29.md`. 오케스트레이션 체크포인트: `.local/orchestrator/STATE.md` (gitignored), Codex 위임 Skill `.claude/skills/codex/`.
- INT-QG: `claude/qg-integration`을 `codex/orbit-mac-handoff-2026-10-26`에 fast-forward (`9dda330..fecf6ff`). QG-UI-01 `b5cf0bc`, QG-01 `e5d6454`, merge `57b58c1`, 서버 품질 차원 하향 전용 연결 `fecf6ff`. 사용자 미커밋 `AGENTS.md`/`CLAUDE.md` 보존.
- 검증(현재 브랜치, 이 세션 실행): Node24.22.1 `npm run verify` exit0, **1411 tests /1409 pass /0 fail /2 skip**, 타입·빌드 통과. 병합 코드 Mock headless Chrome 화면 검사 통과(정상·차단·Mock·unknown·stale·기록 없음·코드 프로젝트).
- LIVE-CLI: Codex `execute.code` 1회, Claude `execute.general` 1회 실제 Orbit Runtime E2E 성공. [결과](ORBIT-LIVE-CLI-2026-10-29.md). Codex actual model unknown 유지, Claude `claude-opus-5-5` native_observed. Reviewer 호출 0회. 품질 통과로 승격하지 않음.
- 다음: CORE-LIVE (일반 작업 프롬프트의 `task-<id>.md` 지시와 승인 요구사항 충돌, Codex 모델 관측, 전체 HTTP 재시작 증명). 추가 실호출은 별도 승인. Push·main 병합·배포 없음.

# Phase 5 재개 상태 (2026-10-28)

- 기준 `0433529512fce809ecf213ece2471b785df63194`. [Phase5 구현·검증](ORBIT-CAPABILITY-PHASE5-2026-10-28.md), [공식 기능 행렬](ORBIT-CAPABILITY-PHASE5-CONTRACTS.md), [실제 증거](evidence/phase5-provider-validation-2026-10-28.json).
- 공통 Runtime observe/interrupt: 정확한 Provider/project/run 소유권, 완료된 응답만 수집, lost 정지 미확인 유지. 자연어 상태·결과·중단→명시 대상→digest 승인→영속 invocation→진행판 연결. 중복·재시작·통신 불명확은 자동 재전송하지 않음.
- Capability 표에 discovery/invocation/verification/정책/과거 native·mock·unknown 근거 분리. Subagent/Slash/Skill/MCP/Hook 호출은 차단, 기존 metadata discovery 유지.
- 승인된 최소 Codex 실환경 회귀1건 성공: Native8,857ms/전체10,472ms, result.txt 정확, run1/재시도0/reviewer0. 서버 설정값을 실제 모델로 승격하지 않음. actual unknown / QUALITY_PRODUCER_MODEL_UNKNOWN / livePipelineVerified=false.
- 보존된 Phase4 nativeDB 복사본으로 자연어 상태/결과 조회→기록 회귀 pass, 신규 model0/원본DB불변. Claude CLI32후보 미발견+URL handler broken link, 실인증unknown·실E2E blocked. 설치·인증변경·Claude 호출0.
- 최종 Node24 `npm run verify` exit0: **1381 tests /1379 pass /0 fail /2 Windows-only skip**, 타입·빌드·diff pass. 모의 UI browser+독립 코드 리뷰 완료. `/tmp/orbit-phase5-verify.log`.
- 다음: Claude 실행파일 확보/설치 및 실호출은 별도 승인. 이미 완료된 Codex 작업을 임의 반복하지 않는다. 외부 확장 실행·독립성 기준 변경·Push·배포·main 병합 없음.

# Phase 4 재개 상태 (2026-10-28)

- 기준 `c5400c28972a69e9907eb3ccff36b900a9bcef3f`. 이번 사용자 승인으로 Codex App Server0.165.0 실제 작업 **1건**, Orbit 재시도0, reviewer0 실행. [실제 검증 보고서](ORBIT-CAPABILITY-PHASE4-2026-10-28.md), [보존 증거](evidence/phase4-native-e2e-2026-10-28.json).
- 격리 worktree result.txt 내용/digest 확인, 원본 clean, 변경파일 result.txt만. 실제 실행7,703ms/전체10,034ms. HTTP·DB·진행판·동일요청 멱등성 확인. 저장된 native 증거로 UI 렌더링 확인.
- 서버 설정 모델 gpt-6-astra는 실제 관측 모델이 아니다. actual unknown 유지. Quality Loop `QUALITY_PRODUCER_MODEL_UNKNOWN`, steps0, livePipelineVerified=false. 전체 독립 품질 검증 통과로 보고하지 않는다.
- 실제 DB 복사 재시작에서 terminal Run을 불필요 복구 대상으로 분류하는 결함 발견. dispatch/baseline/acceptance가 일치하는 terminal만 reconcile하도록 좁게 수정. full Controller/HTTP 재시작 proof: recoveryRequired=false, run1, provider0, original DB unchanged.
- Claude 실행파일32후보 미발견. URL Handler는 누락된 ~/.local/bin/claude 대상의 broken link. 인증 문제로 단정하지 않음. 설치/인증변경 없음.
- 원본 상세 증거 `/private/tmp/orbit-phase4-X9bcYu` 보존. 이미 완료된 모델 작업을 재실행하지 말고 DB 복사본으로 재검증한다. 실제 장애/한도/강제중단 경로는 추가로 유도하지 않았으며 Mock 회귀와 분리한다.

- 최종 Node24 `npm run verify` exit0: **1361 tests /1359 pass /0 fail /2 Windows-only skip**, 타입·빌드·diff 통과. 수동 harness 별도 strict 타입·승인 flag 가드 확인. 실제 기록 Chrome 렌더링 pass.

# Phase 3 재개 상태 (2026-10-28)

- 기준: Phase 2 `1651cd55f0b1371a5dfbdc751f4073a7c007d77d`. [Phase 3 구현·검증·승인 절차](ORBIT-CAPABILITY-PHASE3-2026-10-28.md). 기존 실행/승인/Quality Loop 재사용, 실제 모델 unknown·독립 리뷰 차단 유지.
- 구현: Claude 구독 auth preflight, PID 오류 격리, quota 정제; 실제/Mock 출처 journal과 진행판; 명시적 준비 상태 API/UI; Codex0.165.0 오프라인 계약 확인 및 exact 버전 호환 추가.
- 실제 모델 호출 0회. Claude PATH 미발견. Codex Node24 PATH0.165.0 / Homebrew0.162.1. 설치/version/schema/flags 확인만 수행. 실제 전체 E2E 수락 조건은 승인 대기이며 완료로 보고하지 않는다.
- 최종 검증: Node24.22.1 `npm run verify` exit0, **1358 tests /1356 pass /0 fail /2 Windows-only skip**, 타입·빌드·diff 검사 통과. 준비 상태/실행 승인 모의 Chrome 검사 통과. `/tmp/orbit-phase3-release.log`. 최종 리뷰의 auth await 경합·기획 wrapper 인증 우회·출력 초과 회귀는 재현 후 수정·재검증했다.
- 이후 작업: 사용자가 실모델 최소 범위를 승인하면 문서 절차로 실행한다. 자동 설치·로그인 변경·외부 전송·Push·배포·main 병합 없음. `.DS_Store` 두 파일 보존/커밋 제외.

# 현재 재개 요약 (2026-10-28 · Codex · Capability Orchestration Phase 2 로컬 구현·검증 완료)

- 기준: `AGENTS.md`, `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`, `ORBIT-CAPABILITY-PHASE2-2026-10-28.md`, `ORBIT-CAPABILITY-PROVIDER-CONTRACTS-2026-10-28.md`.
- 기존 미커밋 Registry/Router 변경은 읽기 전용 리뷰·영향33/타입/빌드 후 **e9c8425** 로컬 커밋. 기존 전체 1294 / pass1292 / fail0 / skip2 확인. 초기 sandbox loopback 제한 실패 후 승인된 로컬 테스트 환경에서 재검증.
- Phase2: 실행 계획·digest 승인·최신 기준/선택/버전 검사·durable dispatch intent·중복 방지·중단/관측 복구·기존 Controller/Quality Loop·진행판 연결 구현. 자연어는 승인된 작업 실행 방식 선택에 사용하고 작업 본문을 무음 변경하지 않음. 코드 실행은 기존 선택 workspace/acceptance 캡처.
- 모델: Codex actual unknown 유지. Claude system init 설정 모델을 실제 assistant 관측과 별도 event에 기록. 선택/요청 미지정은 null이며 실제값으로 복사하지 않음.
- 최종 검증: Node24.22.1 `npm run verify` exit0, **1324 tests / pass1322 / fail0 / Windows-only skip2**, 타입/빌드 pass (`/tmp/orbit-capability-phase2-release.log`). 모의 Chrome 승인/중복/상태 테스트 exit0 (`tests/capability-execution.browser.cjs`). 리뷰 지적과 200개 기록 경계 결함은 실패 테스트로 재현·수정·전체 재검증했다.
- Phase2 완료 단위는 이 문서를 포함한 로컬 커밋으로 보존한다(`git log -1` 참조). 동적 trusted Adapter 구현 교체/지원 기능 갱신과 HTTP 서버 주입을 구현했다. 새 제3자 runtime ID나 외부 코드 자동 설치를 지원한다는 뜻은 아님.
- 실제 Provider 모델 호출 0회. Codex 0.162.1 version/help 확인만; Claude 미발견. 공식 flags 최소 Claude2.1.259. managed hooks 및 실인증/중단/복구 미검증. 실제 검증과 mock은 분리. unknown 모델 독립 리뷰 차단 유지.
- 알려진 복구 제한: adapter 진입 이후 실패에서 원래 실행 종료 증거가 없으면 격리하며 자동 재실행하지 않음. 신뢰된 서버 코드 외 등록/외부 설치/실모델/전송은 추가 승인 필요. Push·배포·main 병합 없음. .DS_Store 두 파일 제외.

# 이전 재개 요약 (2026-10-28 · 담당 Codex · Capability Orchestration 시작)

- **현재 완료 단위:** 모델 식별 변경 보안/회귀 리뷰 후 로컬 커밋, Capability Registry→Discovery 투영→Provider Adapter→자연어 추천→DB/HTTP/진행판의 초기 연결. 자동 실행 전체 계층 완료를 뜻하지 않는다.
- **기준 원문:** `AGENTS.md`, `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`, `ORBIT-COLLABORATION.md`, [모델 식별 계약](ORBIT-CODEX-MODEL-IDENTITY-2026-10-28.md), [Capability 설계·구현 기록](ORBIT-CAPABILITY-ORCHESTRATION-2026-10-28.md). code/general 지원과 provider-neutral 범용 비전 유지.
- **Git:** `codex/orbit-mac-handoff-2026-10-26`, 루트 worktree 하나. 모델 식별 24개 파일은 사용자 승인대로 `261c363cb2051a903d07c018729981a2e144c42f`에 로컬 커밋했다. 커밋 직전 49개 영향 테스트/타입 검사/빌드/diff 검사 exit 0 및 이전 전체 1276개 증거를 확인했다. 새 Capability 변경은 미커밋이다. `.DS_Store`, `docs/.DS_Store` 보존·커밋 제외. Push/main 병합 없음.
- **구현 사실:** 기존 NativeProbeService/ExtensionInventory와 실행 경로를 읽는 두 metadata Provider Adapter. CLI 버전은 설치만, Codex ready는 연결/인증만 확인한다. core capability 관측은 별도 실행 증거 없으면 unknown. 설정된 Skill/Hook/MCP와 Slash Command를 지원·허용으로 승격하지 않는다.
- **추천:** 승인된 저장 작업에 대해 제한적인 한/영 규칙으로 execution/planning/review intent를 분류한다. 프로젝트 AI 선택·버전 기준을 보존한다. 추천은 실행 승인·설정 변경이 아니다. 불명확 요청은 needs_clarification, 미지원 확장/이미지 생성/API 요청은 blocked. review는 기존 Quality Loop 모델 근거 확인이 필요하므로 blocked. Codex actual unknown/독립 검증 차단 정책 그대로다.
- **영속·조회:** `capability_routes`, `capability_discoveries`에 원문 없는 추천/Registry 근거를 저장한다. 동일 요청은 같은 기록, 충돌은 거절, 재시작·GET은 실행하지 않는다. 새 HTTP 경로는 기존 session/Origin/CSRF 적용. 진행판 간편 최신 요약/고급 기준·근거 링크 및 늦은 응답·최신 추천 병합 연결.
- **검증:** Node24.22.1 `node --test tests/*.test.ts spikes/phase0/*.test.mjs`: **1294개 / 1292 pass / 0 fail / 2 Windows-only skip**, exit 0 (`/tmp/orbit-capability-final-tests.log`). planning 선택 단언 추가 후 영향 테스트 6/6 pass. `tsc --noEmit`, `node scripts/build.mjs`, `git diff --check` exit 0. 모의 Chrome `tests/capability-routing.browser.mjs` exit 0. 실제 모델 호출·유료 API 전환·인증정보 조회 없음.
- **리뷰/실패 기록:** ready text 세션을 execute.code confirmed로 표시하던 문제, 오래된 local 추천이 서버 최신 기록을 가리던 문제를 수정·회귀 검사했다. 잘못된 버전/관측 시각은 unknown. 최초 새 라우팅 테스트는 미구현 module 오류, 미지원 이미지 요청은 추천 오분류 실패를 재현한 뒤 수정했다. 브라우저는 제한 환경 SIGABRT 이후 허용된 임시 프로필 검사로 통과. 최종 리뷰 blocker 없음.
- **다음 작업:** 자연어 규칙은 범용 의미 이해가 아니며 자동 dispatch·동적 외부 Adapter 등록·확장별 실행 capability probe/허용 절차·실제 Quality Loop dispatch 결합은 후속 구현이다. 실제 Claude/Codex discovery 응답·로그인/연결·실모델은 별도 승인/검증 전 미확인. 기존 종료 미확인 실행을 자동 재시도하거나 unknown 모델을 독립 검증 성공으로 변경하지 않는다.

### 단계별 변경 파일·검증

| 단계 | 변경 파일 | 검증 결과 | 남은 제한 |
|---|---|---|---|
| Registry/Discovery/Adapter | `shared/capability-orchestration.ts`, `server/capability-adapters.ts`, `tests/capability-adapters.test.ts` | 8개 모의 검사 pass, read-only 연결·invalid metadata·확장 신뢰 오인 방지 | 실제 기능 실행 discovery 및 외부 Adapter 등록 미연결 |
| 자연어 추천/DB | `shared/capability-routing.ts`, `server/capability-routing.ts`, `tests/capability-routing.test.ts`, `tests/capability-fixtures.ts` | 6개 pass: code/general, 수동 선택·기획 선택, 불명확/미지원·Quality 차단, 기준 변경·재시작·멱등성 | 로컬 제한 규칙·추천만 구현 |
| HTTP | `server/http.ts`, `tests/capability-routing-http.test.ts` | session/CSRF·위조 필드·조회 부작용·증거 조회 검사 pass, 전체 스위트 회귀 pass | 새로운 실행/인증/과금 경로 없음 |
| 진행판 | `server/project-progress.ts`, `shared/project-progress.ts`, `web/project-progress.tsx`, `web/capability-routing.tsx`, 기존 progress 테스트 2개, `tests/capability-routing.browser.mjs` | project/task scope·최신20·간편/고급·늦은 응답·최신 기록 병합, 모의 Chrome pass | 실모델 전체 앱 E2E 미실행 |

# 이전 재개 요약 (2026-10-28 · 담당 Codex · CLI 모델 식별 계약 연결)

- **현재 작업:** 사용자 요청에 따라 기존 Quality Loop 커밋 `f987fd9935111419284400a04c7af5d144e8a529`를 재사용하여 Codex 모델 식별 계약을 조사하고 실행기·DB·HTTP·진행판에 연결했다. 실제 모델 식별 성공을 선언하지 않는다. 아래 이전 요약의 `bbc2736`/미커밋 상태는 이전 시점 기록이다.
- **기준 원문:** `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`, `ORBIT-COLLABORATION.md`, `AGENTS.md`. 이번 계약 조사 원문과 재현 방법은 [ORBIT-CODEX-MODEL-IDENTITY-2026-10-28.md](ORBIT-CODEX-MODEL-IDENTITY-2026-10-28.md).
- **현재 Git:** 브랜치 `codex/orbit-mac-handoff-2026-10-26`, 시작 HEAD `f987fd9`, 루트 worktree 하나. 시작 시 `.DS_Store`, `docs/.DS_Store` 외 변경 없음. 두 파일 보존. 이번 수정은 미커밋이며 Push/main 병합 없음. 인증정보·사용자 DB/로그를 열거나 변경하지 않았다.
- **확인 사실:** 설치된 CLI는 `codex-cli 0.162.1`. `--version`, help, 오프라인 `app-server generate-ts`(stable/experimental), `generate-json-schema`만 실행. `Thread.model`은 현재/최근 저장된 설정이며 명시적으로 per-turn telemetry가 아니다. `Turn`에는 실제 model 필드가 없다. `model/verification`은 cyber 접근 검증으로 모델 신원 증거가 아니다.
- **구현:** 선택값·요청값·서버 설정값·출처·시점·thread/session/turn ID를 구분한다. 실제 모델은 `unknown/unavailable` 고정. 현재 기존 실행 요청은 모델 override가 없으므로 선택/요청은 null이며 서버 기본값을 복사하지 않는다. 설정 변경·reroute·재개·응답 이전 이벤트·누락·중단을 관측한다. 저장된 Codex 근거가 있으면 Quality Loop는 이전 모델 주장도 승격하지 않고 `modelId:null/source:unknown`을 반환한다.
- **영속/복구:** `run_model_attributions` 테이블과 최소 이벤트 기록, 저장 실패 시 불완전 overlay, 재시작 시 진행 중/완료 저장 간극의 관측 불완전 처리. 실행 자동 재호출 없음. 기존 승인·격리·계정·사용량·idempotency·보호 검사 정책 유지. code/general 경로 모두 기존 구조 보존.
- **화면/API:** 인증된 `GET /api/runs/:runId/model-identity`는 조회만 한다. 진행판 고급 모드에서 선택/요청/서버 설정/실제 unknown과 thread/native session/turn 근거를 표시한다. 간편 모드 상세 근거 숨김 유지. `model/list`/`thread/read`는 오프라인 계약·모의 테스트만 수행했으며 새 실서버 요청을 추가하지 않았다.
- **검증:** Node24.22.1 전체 `node --test tests/*.test.ts spikes/phase0/*.test.mjs` 1276개 / 1274 pass / 0 fail / 2 Windows-only skip, exit 0 (`/tmp/orbit-codex-model-final-tests.log`). `tsc --noEmit`, `node scripts/build.mjs`, `git diff --check` exit 0. `node tests/quality-loop.browser.mjs` 모의 Chrome 검사 exit 0. 모든 테스트는 모의/임시 저장소/로컬 검증이다. 실제 모델 호출 0회.
- **남은 제한/다음 행동:** 실제 서버에서 설정 응답·이벤트 전달·재개·중단을 확인하려면 별도 실모델 사용 승인이 필요하다. 그러나 0.162.1의 공식 계약에는 실제 실행 모델 증명이 없으므로 승인만으로 독립 검증 차단을 해제할 수 없다. 공식 per-turn/response 모델 귀속 계약이 제공되어야 재평가할 수 있다. 비공식 인증 데이터나 유료 API 전환은 하지 않는다. collector의 프로세스 내 실행 관측 map은 기존 telemetry처럼 실행 수에 따라 누적되며 장수 프로세스의 보존 한도는 이번 범위에서 변경하지 않았다.

### 이번 단계 변경·검증 기록

| 단계 | 변경 파일 | 검증 | 미검증/제한 |
|---|---|---|---|
| 설치 계약 확인 | `docs/ORBIT-CODEX-MODEL-IDENTITY-2026-10-28.md`, `tests/fixtures/codex-0.162.1-model-schema.json`, `tests/codex-model-schema.test.ts` | 실제 생성 스키마 19개 정의 투영/원본 SHA-256 대조, 계약 4개 통과 | 실제 서버 응답 수집 없음 |
| 모델 근거 수집 | `shared/codex-model-attribution.ts`, `server/codex-model-attribution.ts`, `tests/codex-model-attribution.test.ts` | 변경/재개/라우팅/누락/중단/혼선/민감값/저장 실패 13개 통과 | actual model unknown |
| 실행·품질 연결 | `server/controller.ts`, `server/codex-review.ts`, `server/runtimes/model-identity.ts`, `server/quality-loop-native.ts`, `shared/quality-loop-record.ts`, 관련 controller/native tests | native 29개 통과, Controller/HTTP 검사는 전체 스위트 포함 | production Codex 독립 검증 사전 차단 유지 |
| DB/HTTP/진행판 | `server/store.ts`, `server/http.ts`, `server/project-progress.ts`, `shared/project-progress.ts`, `web/project-progress.tsx`, `tests/codex-model-store.test.ts`, `tests/project-progress-service.test.ts`, `tests/project-progress-ui.test.ts`, `tests/quality-loop.browser.mjs` | 재시작·완료 저장 간극/DB 실패 및 진행판 9개 통과, 모의 Chrome 간편→고급→펼침→간편 exit 0 | 실제 모델 포함 전체 앱 E2E 미실행 |

검증 과정의 실패/수정: HTTP 초기 제한 환경 실행은 `listen EPERM`으로 실패하여 허용된 loopback 환경에서 전체 검사했다. 읽기 전용 리뷰로 완료 Run과 attribution 저장 간극을 발견하고 회귀 테스트 실패를 확인한 후 복구를 수정했다. 수정 직후 타입 검사에서 기존 `terminal()`의 boolean 반환이 union을 좁히지 못해 exit 2; 명시적 terminal 상태 조건으로 고치고 타입 검사 exit 0을 확인했다. 최초 전체 검사 1274개/1272 pass/0 fail/2 Windows-only skip, exit 0. 복구 보완·회귀 2개 추가 후 최종 전체 검사는 1276개/1274 pass/0 fail/2 Windows-only skip, exit 0이었다. 최종 타입 검사·빌드·diff 검사도 exit 0. 기존 테스트 삭제/완화 없음.

# Orbit 개발 현황 (F01~F11)

## 재개 요약 (2026-10-28 · 담당 Codex · Quality Loop 연결)

### 로컬 커밋 직전 검토 (사용자 승인, 2026-10-28)

- 현재 브랜치에서 Quality Loop 관련 27개 파일만 로컬 커밋 대상으로 확정했다. 기존 초기 정책 구현·진행 기록의 내용은 유지한다. `.DS_Store`, `docs/.DS_Store`는 미추적 상태로 보존하고 인증 설정·DB/WAL/SHM·로그·빌드 산출물은 포함하지 않는다.
- 전체 diff 및 독립 읽기 검토: 커밋 차단 수준의 보안·정확성 결함 발견 없음. 승인 기준/모델 unknown/정지 미확인 격리/중복 실행 방지/Origin·CSRF/외부 전송·과금 경계 유지 확인. 자격증명 패턴 검사의 일치 항목은 차단·마스킹 검사용 합성 문자열 4곳뿐이며 실제 인증정보가 아니다.
- 커밋 대상 최신 코드로 Node24 전체 테스트 재실행: **1247 tests / 1245 pass / 0 fail / 2 Windows-only skip, exit 0** (`/tmp/orbit-quality-commit-tests.log`). `tsc --noEmit`, `node scripts/build.mjs`, `git diff --check` exit 0. `node tests/quality-loop.browser.mjs` 임시 Chrome 모의 검사 exit 0.
- 사용자 승인 범위는 로컬 커밋뿐이다. 원격 Push·main 병합·실모델 호출은 수행하지 않는다. Codex 실제 모델 관측 및 실제 CLI 통합의 미검증 제한은 아래와 같이 유지한다.

- 개발 시작 HEAD `bbc2736`, 브랜치 `codex/orbit-mac-handoff-2026-10-26`, worktree는 루트 하나. 기존 미커밋 정책 모듈 3개/STATUS와 `.DS_Store` 2개를 보존했다. 커밋·Push·설치·실모델 호출 없음. 기준 원문은 `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`, `ORBIT-COLLABORATION.md`이며 아래 과거 worktree/차단 기록과 현재 관측을 혼동하지 않는다.
- **구현:** 기존 Quality Loop 정책을 유지하면서 Controller/native 실행기/SQLite/Event/HTTP/진행판에 연결했다. 코드·Git 없는 텍스트 결과물의 모의 통합을 확인했다. 실제 모델 성공을 검증한 것은 아니다.
- 승인된 source Run의 task/version/contentHash와 완료 조건을 실행 기준으로 고정한다. 공급자 ID·실제 모델 ID·세션 ID·Orbit 실행 ID·네이티브 실행 ID를 분리하고 요청 모델명은 증거로 사용하지 않는다. 실제 모델 미관측은 unknown, 독립 검증 성공 불가.
- SQLite `quality_loops`의 회차·문제·수정 요청·step intent/result와 native/controller receipts, `quality_artifact_checks`에 근거를 보존한다. idempotent 요청은 같은 기록을 반환한다. 재시작/시간초과/종료 미확인은 격리하며 GET은 실행하지 않는다. 복구는 원래 실행의 저장된 영수증만 재생하고, 종료 확인됐으나 snapshot을 잃은 수정은 안전한 실패로 끝낸다. 성공으로 추정하거나 자동 재호출하지 않는다.
- 실패 항목만 수정 지시로 넘긴다. 매 회차 모든 승인 완료 조건을 재검토하고 코드에는 기존 Verification의 승인 명령 전체, 일반 텍스트 결과물에는 기존 파일/형식/입력 수치 대조 검사를 다시 실행한다. 보호 검사 파일 변경은 자동 재승인하지 않는다. AI 의견 일치, 로컬 검사 통과, 사용자 승인은 별개다.
- 진행판 간편 모드는 품질 검증 중/수정 중/재검증 중/한도·권한·모델 확인 상태와 회차·문제 수를 표시한다. 고급 모드는 기준 hash·모델/세션/실행 ID·회차별 문제·검사 증거를 펼친다. 단계/검사 실패를 기존 작업 완료율에 임의 합산하지 않는다.
- **검증:** Node24.22.1 전체 `node --test tests/*.test.ts spikes/phase0/*.test.mjs`: 1247개 / 1245 pass / 0 fail / 2 Windows-only skip, exit 0 (`/tmp/orbit-quality-final-tests.log`). 이후 최종 소규모 보완은 영향 검사 60/60 및 27/27 pass, exit 0으로 재검증했다. `tsc --noEmit`, `node scripts/build.mjs`, `git diff --check` exit 0. 임시 Chrome 프로필 모의 화면 간편→고급→증거 펼침→간편 복귀 exit 0. 실제 제품 세션 전체 브라우저 E2E·실모델은 수행하지 않았다.
- **남은 실제 제한:** Codex source/review의 실제 모델을 현재 native 프로토콜 관측으로 입증하지 못하므로 production 교차 검증은 호출 전 차단된다. 이는 사용자 승인만으로 해소되는 테스트 대기와 다르다. 추후 실제 모델 관측 수단을 입증하기 전 성공 표시 금지. 현재 native 품질 검토는 제한 크기 안의 텍스트 스냅샷 대상이며 바이너리/큰 결과물은 unsupported로 차단한다. 범용 비전/승인 범위는 축소하지 않았다.
- **다음 행동:** 최종 로컬 변경 검토 후, 실모델 사용은 사용자 별도 승인 시에만 진행. 먼저 실제 모델 ID가 관측되는 Claude 텍스트 작업에서 검증·수정·재검증/중단을 확인한다. Codex는 실제 모델 증거 지원을 먼저 확인해야 한다. 종료 미확인 실행은 저장된 관측 없이 잠금 해제하지 않는다. 로컬 커밋은 이번 사용자 요청으로 승인되었으며 Push는 여전히 별도 승인 대기.

### Quality Loop 단계별 변경·검증 기록

| 단계 | 주요 파일 | 검증·실제 결과 | 미검증/제한 |
|---|---|---|---|
| 정책 보강 | `shared/quality-loop.ts`, `server/quality-loop.ts`, `tests/quality-loop.test.ts` | 기존 9개 유지 + unknown/중단 사유/필수 회귀 실패→수정 검사, 12/12 통과 | 호출 횟수는 토큰·비용 상한 아님 |
| native 증거·수정 경로 | `server/runtimes/model-identity.ts`, `server/runtimes/claude-code.ts`, `server/claude-task-service.ts`, `server/codex-review.ts`, 관련 기존 tests/fixture | 실제 assistant model/session 메타데이터만 관측; 모델 혼재/누락·quota+success·nonzero exit·수정 기준 보존 테스트 통과 | 실제 CLI 호출 0; Claude textOnly 옵션은 공식 CLI 문서 확인, 실동작 미검증 |
| 영속·복구 | `shared/quality-loop-record.ts`, `server/quality-loop-service.ts`, `tests/quality-loop-service.test.ts` | 13/13 통과: DB 재개·중복 방지·late result·close abort·재진입·관측된 종료와 unknown 구분 | 원실행 종료/결과 증거 없는 경우 격리 유지 |
| 실행기·기존 검사 통합 | `server/quality-loop-native.ts`, `server/runtimes/claude-review.ts`, `server/controller.ts`, `tests/quality-loop-native.test.ts`, `tests/quality-loop-controller.test.ts` | native 10/10; controller 코드/비코드 통합 2/2; 보호 검사 변경 stale; 600자·다중공백·줄바꿈·24개 원문 조건 전달; snapshot 영수증 유실 안전 실패 복구 | Codex actual model 관측 미지원, 바이너리 snapshot 미지원 |
| HTTP·진행판 | `server/http.ts`, `server/project-progress.ts`, `shared/project-progress.ts`, `web/project-progress.tsx`, `tests/quality-loop-http.test.ts`, `tests/project-progress-ui.test.ts`, `tests/quality-loop.browser.mjs` | 인증/CSRF·프로젝트 범위·GET 부작용 없음; 실제 Store→진행판 기록 대조; UI 8/8; 임시 Chrome 모드/증거 동작 통과 | 실제 모델을 쓰는 전체 앱 브라우저 E2E 미실행 |

HTTP 경로: `GET /api/projects/:projectId/quality-loops`, `POST .../preview`, `POST .../start`, `POST .../:loopId/resume`. preview body는 `sourceRunId, reviewers[{id,providerId,modelId}], limits{maxRepairs,maxCalls,timeoutMs}`; start는 여기에 `requestId, expectedPreviewDigest, confirmed:true`를 더한다. 모델 증거나 기준은 브라우저가 지정할 수 없다. 모든 POST는 기존 session/Origin/CSRF 정책을 사용한다. resume은 빈 body이며 원래 관측을 조회할 뿐 재호출 권한을 뜻하지 않는다.

검증 과정의 실패도 보존한다. 기본 Node25 대신 설치된 fnm Node24를 사용했고 pnpm은 없었다(npm 프로젝트). 초기 HTTP는 sandbox loopback EPERM, Chrome은 SIGABRT로 실행 전 실패했으나 승인된 sandbox 밖 로컬 테스트로 통과했다. 신규 UI prop 전달 오타로 기존 UI 테스트 4개 실패 후 코드 수정으로 전부 통과했다. 첫 전체 검사는 1239/1237 pass/0 fail/2 skip이었다. 이후 코드 통합 테스트의 3초 deadline이 병렬 부하 약5.5초에서 초과해 1개 실패했고, 기능 테스트 대기를 30초로 조정했다(정책 timeout 단언은 유지). 수정 후 최종 전체 1247/1245 pass/0 fail/2 skip. 독립 리뷰의 완료조건 잘림·종료 writer 영수증 유실 문제는 수정·재검증했다. 최종 추가 검토에서 승인된 600자 조건도 기존 리뷰 파서의 고정 400자 제한 때문에 거절됨을 재현했다. 파서 상한을 승인 원문 최대 길이에 맞추되 원문 exact-match 검증은 유지했고 관련 27개 검사가 통과했다. Claude Run 생성 전 실행파일/입력 거절도 no-dispatch 증거가 있을 때만 실패 종료로 풀도록 보강했으며 영향 검사 60개가 통과했다. 이 마지막 서버 보완 뒤 전체 스위트를 불필요하게 반복하지 않고 관련 검사를 재실행했다.

## 이전 재개 요약 (2026-10-28 · 담당 Codex · Q1 부분 구현)

- 현재 우선 작업은 사용자 요청 **멀티모델 독립 교차 검증과 자동 품질 개선 루프**. 기존 UI1 기록은 아래 보존한다. 기준 원문: `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`, `ORBIT-COLLABORATION.md`.
- 실제 관측: 브랜치 `codex/orbit-mac-handoff-2026-10-26`, HEAD `bbc2736`. worktree는 현재 루트 하나뿐이며 아래 과거 Mac 기록과 다름. 초기 미추적 `.DS_Store`, `docs/.DS_Store` 보존, 커밋 안 함. 기본 Node 25.8.2 대신 설치된 fnm Node 24.22.1 사용.
- 구현: `shared/quality-loop.ts` 계약, `server/quality-loop.ts` 내부 정책 모듈, `tests/quality-loop.test.ts`. 승인 기준/결과물 digest 고정, 다른 canonical model 및 새 세션 요구, 평가 기준 전수 확인, 의견별 문제·근거 보존, 실패 전달→수정→전체 기준 회귀, 회차·호출·시간 한도. 검토 회차 종료 전 의견 비공개. 프로세스 중단 미확인은 별도 이유로 반환.
- **미완료:** 이 모듈은 HTTP/Controller/native 실행기/DB/진행판에 연결되지 않았다. `passed`는 주어진 모의/신뢰 포트의 AI 의견 합의이며 Verification 통과나 사용자 승인 아님. canonical model 식별은 아직 서버 연결부의 전제이며 문자열 입력 자체로 입증되지 않는다. 호출 횟수는 토큰·비용 한도가 아니다.
- 구조 차이: 기존 Review는 Codex Diff 전용, Verification/Workflow는 승인된 로컬 명령 중심. Claude review 프롬프트·파서는 기존 것을 재사용할 수 있으나 Codex review 결과에 실제 model ID가 없어 독립 모델 증거 확장이 선행되어야 한다. 새 프로세스 실행 엔진은 추가하지 않았다.
- 검증: Node24 기존 Git 추적 테스트 1205개 / 1203 pass / 0 fail / 2 skip, exit 0 (`/tmp/orbit-baseline-tests.log`). sandbox 첫 실행은 loopback EPERM 실패, 승인받은 sandbox 밖 재실행 결과다. 새 quality-loop 모의 테스트 9/9 exit 0. `npm run typecheck`, `npm run build` exit 0. 병렬 작성 도중 verify 한 번은 아직 없는 계약 파일 때문에 타입 검사 실패했고, 작성 후 재검증했다.
- UI 검토: `4e52d99` 테스트 diff에서 페이지 14→15는 results 추가, 메뉴 개수는 pages.length와 대조하며 모든 URL·현재 페이지·순서 검증 유지. 이번 브라우저 실검증은 하지 않았다. 기존 UI의 미연결 표시는 유지한다.
- 실제 모델 호출 0회. 민감정보 없는 일회용 샘플을 기존 구독으로 전송하는 승인 질문은 답변 대기. 미확인 과거 Codex 크레딧 상태는 재확인하지 않았으며 현재 차단으로 단정하지 않는다.
- 다음 순서: (1) 기존 native runner의 실제 모델·새 세션 증거 및 신뢰 Registry 매핑 (2) 기존 승인/개인정보/작업 잠금 아래 Controller 연결, SQLite 이벤트·중복 방지·중단 복구 (3) 결과물 스냅샷과 기준 hash 검증 및 수정 모델 연결 (4) 진행판 모델별 결과·회차·대기 사유 표시 (5) 승인된 실제 코드/비코드 샘플 실패→수정→독립 재검증. 사용자 데이터, MCP 격리, 기존 CheckRecord 검증을 약화하지 않는다.

## 이전 재개 요약 (2026-10-28 16:55 KST, 담당 Claude Code)


**기준 문서(원문을 직접 읽을 것, 이 요약은 기준이 아님)**
- 최상위 비전: `docs/ORBIT-VISION.md` (상태: 사용자 확정, 기준일 2026-10-28). 원문 §1: “Orbit은 누구나 자연어로 목표를 입력하면 다양한 AI 모델·에이전트·Skills·MCP·외부 도구를 활용해 기획, 실행, 협업, 검증, 결과물 생성까지 수행하고, 프로젝트 방향성과 진행 상태를 일관되게 관리하는 범용 AI 작업 자동화 플랫폼이다.”
- 승인 범위: `docs/ORBIT-SCOPE-2026-10-27.md` v1.1(F01~F11, A01~A16). 구현 순서: `docs/ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`. 분담: `docs/ORBIT-COLLABORATION.md`.

**저장소 상태(관측)**
- 통합 브랜치 `codex/orbit-mac-handoff-2026-10-26`: 코드 HEAD `440b8da`(병합) ← `4e52d99`(UI), 그 위에 이 문서 커밋. 원격은 이번에도 조회하지 않음, Push 안 함.
- worktree: `.worktrees/claude-ui`(`claude/ui-home-project` = `4e52d99`, 깨끗함, 일회용 서버 포트 4399 실행 중·DB는 `.local/`), `.worktrees/codex-core`(`ddb74d8`, 변경 없음), `.worktrees/verify`(detached `c14df45`).
- Codex: 크레딧 소진으로 **차단** 지속. Claude Code가 단일 담당.

**현재 작업** `UI1 홈·프로젝트 화면 정리` · 담당 Claude Code
- 목표: 초보자가 자연어 입력부터 결과물까지 한 흐름으로 쓰도록 홈·프로젝트 화면과 간편/고급 모드를 정리. 기능 삭제·비전 변경 없음.
- 허용 범위: `web/**` 홈·프로젝트·결과물·설정 화면, 내비게이션, 기획 패널 표시. 하지 않을 것: 나머지 화면 대규모 개편(사용자 확인 전), 서버·DB·실행기 변경, 미구현 기능(교차 검증·자동 수정·자동 추천·이미지)을 동작처럼 표시.
- 상태: **구현·브라우저 실연동 확인, 사용자 화면 확인 대기.**
- 다음 행동 하나: 사용자 화면 확인 후, 피드백 반영 → 같은 방식으로 진행 현황·기획 스튜디오 화면 정리 여부 결정. (FF1의 다음 행동 ‘근거 대조→CheckRecord 연결’은 그 다음 순서로 유지)

**UI1 검증 (대상 `4e52d99`, 2026-10-28 KST)**
| 구분 | 명령/방법 | 결과 |
|---|---|---|
| 구현 | `npm run typecheck` / `npm run build` | 0 / 0 |
| 단위·통합 | `npm test` | 1205 / 1203 pass / 0 fail / 2 Windows-only skip, exit 0. 중간 실행 8 fail → 코드·하네스 조정 후 재실행(아래 테스트 변경) |
| 브라우저(Chrome 확장, 1470px) | 홈 새 작업(첨부·예시) → 프로젝트 화면 이동·요청 채움 → 실제 Claude 기획 → 질문 6개 답변 v2 → 승인·작업 준비 → 실제 Claude 실행 1회 completed → 결과물 미리보기 → 고급 모드 전환(15개 메뉴·AI 명령·저장소 관리) → 간편 복귀 | 모두 동작, 데이터 동일 |
| 반응형 | headless Chrome + CDP 뷰포트 390/820/1280px, 가로 넘침 측정 | `scrollWidth==clientWidth`, 넘침 요소 0 |
| 사실 확인 | 새 결과물 표 수치 22개를 입력 CSV·계산값과 대조 | 설명 불가 0 |
| 사용자 확인 | — | **미확인** |

**테스트 변경(별도 검토 대상)**
- `tests/orbit-navigation.test.ts`: 페이지 수 14→15(새 `results` 페이지). 모든 페이지 URL 새로고침 유지 계약은 그대로.
- `tests/studio-ui.test.ts`: 고급 메뉴 개수 단언 14→`pages.length`(원 계약 “모든 페이지 표시” 유지), 간편 모드 문구 ‘고급 모드로 전환’.
- 기존 단언 유지를 위해 코드 쪽을 맞춘 것: 간편 기획 패널의 8,000자·32 KiB·원문 미저장 고지는 접힌 상세 안에 유지, `App`의 모드 구독은 `useState`/`useEffect`(가짜 훅 하네스 호환), `WorkspacePanel`은 프로젝트 화면의 children으로 전달.
- 신규 `tests/ui-home-project.test.ts`(4): 단계·다음 할 일·모드 저장.

**FF1 (직전 작업) 요약:** 첫 비코드 흐름 구현·실연동 통과(`8132244`), 근거 대조의 진행판 검증 집계 연결은 미완. 상세는 아래 ‘FF1 첫 비코드 흐름’ 절.

**최소 읽기 목록:** `AGENTS.md` → `docs/ORBIT-VISION.md` → `docs/ORBIT-SCOPE-2026-10-27.md` → 이 문서 → `docs/ORBIT-COLLABORATION.md`. 코드 진입점: `web/home.tsx`, `web/project-work.tsx`(+`project-work-model.ts`), `web/ui-mode.ts`, `web/start.tsx`(GeneralPlanCard·코드 흐름), `web/new-task.tsx`, `server/materials.ts`, `server/deliverables.ts`, `server/planning/agent-input.ts`.

**재개 규칙(강제 아님):** 새 세션은 위 기준 원문과 이 요약을 대조하고, `git status`/`git worktree list`로 실제 상태를 확인한 뒤 진행한다. 이 요약과 실제가 다르면 실제를 기록하고, 미확인 실행은 재실행하지 않는다. 이 규칙과 테스트는 에이전트가 수정할 수 있으므로 자동 강제가 아니다. 통합 담당의 독립 diff·검증 검토가 최종 관문이다.

## 기준선 (2026-10-28, macOS 26.6.2 arm64, Node 24.22.1, Codex 0.163.0, Claude Code 2.1.312)

HEAD `d39679e`: `npm ci` → `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` 1048 tests / 1046 pass / 0 fail / 2 Windows-only skip (exit 0, 121s). 브라우저 E2E 미실행(`agent-browser`·Playwright 미설치). 실제 AI 연동 미실행.

## 최신 검증 (2026-10-28, 통합 브랜치 `4eef10c`)

`npm run typecheck` 0 · `npm run build` 0 · `npm test`(기본 병렬) **1186 tests / 1184 pass / 0 fail / 2 Windows-only skip** — keep-alive 수정(`3c4aff4`) 이후 전체 스위트 연속 4회 실패 0. 브라우저 E2E는 Claude in Chrome으로 일회용 서버(`.worktrees/verify`, 포트 4399)에서 수동 수행했으며 자동 E2E 스크립트(`agent-browser`·Playwright)는 미설치로 실행하지 않았다.

## FF1 첫 비코드 흐름 — 수용 조건별 결과 (대상 `8132244`)

| # | 조건 | 결과 | 근거 | 관련 F/A |
|---|---|---|---|---|
| 1 | 첫 화면 중심=자연어 입력·기획 AI·시작, Git/기존 프로젝트가 막지 않음, 미구현 기능 가장 금지 | **통과(브라우저)** | 홈 `NewTaskPanel`: 요청·텍스트 자료 첨부(.csv/.md/.txt/.json, 128 KB, 10개; 실제 동작)·기획 AI(Claude Code, Codex는 사유와 함께 비활성)·시작. 자동 선택은 표시하지 않음. 프로젝트가 선택돼 있어도 ‘+ 새 작업’. 코드 프로젝트 생성은 접힌 영역 | F01,F02,F11 · A01 |
| 2 | 간편 모드는 필요한 정보만, 기존 기능·고급 경로 보존 | **통과(부분)** | 사이드바 기본 4개(시작하기·진행 현황·프로젝트·기획 스튜디오)+현재 페이지, ‘고급 메뉴 보기’로 14개 전부. 진행판·기획 스튜디오 내부는 아직 상세 정보가 많음 | F11 · A12 |
| 3 | 승인 전후·실행 기준 버전 구분, 선택 AI가 실제 실행에 반영, 미지원 이유 표시 | **통과** | 카드에 ‘버전 n · 초안(미승인)/승인됨 · 기준 해시’. 실행 기록 담당 Claude Code, 진행판 ‘승인 버전 r2 · 6196ccb964af’. Codex는 ‘Git 작업 공간이 필요’로 비활성 | F03,F10 · A03 |
| 4 | 프로젝트·작업·실행별 담당·마지막 관측·대기/오류·결과물·검증, 응답 종료≠검증, 근거 있는 진행률 | **통과** | 작업별 ‘AI 응답 완료 · 검증 전’, 최근 도구(Read/Write/Edit), 관측 시각, ‘작업 n개 중 0개 검증 통과(작업 수 기준)’·‘완료 조건 n개 중 0개’. 기획 실패는 진단 코드로 표시 | F06 · A09,A11 |
| 5 | 결과물이 실제 생성·목록·미리보기, 사실·비교표 확인, 검증 실패를 완료로 표시 안 함 | **통과(검증 연결은 부분)** | 결과물 4개 목록·미리보기, 입력 자료 분리. 근거 대조: 계산값은 ‘자료에 없음 · 확인 필요’, 원본만 쓴 표는 ‘모두 자료에 있음’. 독립 스크립트 대조 설명 불가 수치 0. **진행판 검증 집계에는 아직 연결 안 됨**(0/n 유지) | F08 · A13 |
| 6 | 후속 수정·새로고침/재시작에서 기준·파일·관측 유지, 중복 실행 없음 | **통과** | 후속 요청→새 기획 v1→질문 6개 답변→v2 승인→실행. 기존 결과물 mtime 불변, 이전 실행·증거 보존. 재시작 전후 runs/events 동일 | F02,F09 · A01,A10 |
| 7 | 기존 코드 프로젝트 흐름 회귀 | **단위·UI 통과, 실연동 미검증** | start-page(코드 Start 흐름) 포함 전체 1199 통과. Codex 실행은 크레딧 차단으로 live 미실행 | A16 |

**실연동 중 발견·수정한 문제**
- Claude 기획 결과가 ```` ```json ```` 펜스로 감싸져 `PLANNING_PROPOSAL_INVALID`(원인: 형식 판정이 markdown). 전체를 감싼 펜스 하나만 벗기도록 수정(앞뒤 설명문은 여전히 거부).
- 기획 지시문이 “프로젝트 파일을 읽지 말라”여서 첨부 자료를 못 보고 질문만 생성. 서버가 나열한 `inputs/` 자료만 Read하도록 예외를 지시문에 넣었고 미리보기에 그대로 보인다(목록이 바뀌면 입력 digest도 바뀜).
- 새 프로젝트가 SSE로 먼저 선택돼 요청 문구 전달이 사라짐 → 구독 방식으로 수정.
- 근거 대조가 CSV `1200000,7`을 한 숫자로 읽음 → 천 단위 쉼표는 정확히 3자리 앞에서만 인정.
- 간편 메뉴에서 관리 그룹 페이지가 현재 페이지일 때 숨겨짐(테스트가 발견) → 표시.

**테스트 변경(별도 검토 대상)**
- `tests/studio-ui.test.ts`: 원래 계약 “사이드바는 항상 14개 메뉴”. 수용 조건 2에 따라 간편 모드 단언(기본 4개+현재 페이지, ‘고급 메뉴 보기’)을 추가하고, 원래 14개·순서 단언은 고급 메뉴 상태에서 그대로 유지.
- `tests/start-page.test.ts`: 단언 변경 없음. 하네스 모듈 stub에 `./new-task.tsx` 한 줄 추가(`.tsx`를 직접 require할 수 없음).
- `tests/deliverables-ui.test.ts`: fixture에 새 필수 필드 `role:'output'`만 추가.
- `tests/deliverables.test.ts`: 변경 없음. 자료 없는 프로젝트는 `evidence`를 붙이지 않게 코드를 맞춰 기존 계약을 유지.

**아직 남은 문제(FF1 범위)**
- 후속 기획이 제약(“통화는 KRW”)까지 별도 작업으로 쪼개 작업 6개가 생김(후속 R1만 실행). 기획 지시문의 작업 분해 기준 개선 필요(F01).
- 기획 지시문의 코드 앱 미리보기 제약(`staticAppPreviewCapability`)이 비코드 기획에도 들어감(기존 발견, 미해결).
- 요청 원문은 브라우저 메모리로만 전달(저장하지 않음). 새로고침하면 입력칸이 비고 첨부 자료 목록만 남는다.
- (해결 `4e52d99`) 기획 패널의 ‘기획 상태 새로고침’ 버튼이 입력 라벨과 겹쳐 보임.
- 기획이 “작업은 하나로” 요청에도 요구사항마다 작업을 만들어 작업 6개가 생김(UI1 재현). 기획 지시문의 작업 분해 기준 개선 필요(F01).
- 프로젝트 화면 실행 목록은 여러 기획 버전의 작업을 한 목록에 섞어 보여 줌(기획별 묶음 미구현).
- Chrome 확장 창 크기 조절이 뷰포트에 반영되지 않고, 서버 보안 헤더로 iframe 삽입도 막혀 반응형 확인은 headless Chrome+CDP로 수행.
- 재빌드 직후 첫 접속에 이전 `app.js`가 보인 현상 재발(`Cache-Control: no-store`는 이미 설정됨, 원인 미확인).

## 요구사항별 상태

| ID | 구현 상태 | 단위/통합 | 브라우저 | 실연동 | 관련 A | 증거 | 차단 이유 | 다음 행동 |
|---|---|---|---|---|---|---|---|---|
| F01 입력·AI 기획 | **구현(일반 프로젝트)**: 홈에서 자연어 요청·텍스트 자료 첨부·기획 AI 선택 → 기획 미리보기·별도 동의 → Claude 기획(첨부 자료만 읽기) → 초안 저장 → **열린 질문 답변=결정 기록·새 버전** → 승인·작업 준비. 코드 프로젝트는 Codex/Claude 선택. **간소/상세 명세 깊이 구현**(`38c1d08` PLAN-DEPTH: parser·`web/planning/PlanningStudio.tsx`, `tests/planning-depth.test.ts`; mock 테스트, live 미검증) | general-planning·claude-planning·first-flow | **Chrome FF1: 실제 Claude 기획 2회+후속 1회, 질문 답변 v2 승인** | Claude Code live(FF1, 구 HEAD). Codex 기획 경로 live 미검증(Codex 0.165.0 live는 `execute.code` 1회뿐). PLAN-DEPTH 이후 live 재실행 없음 | A01 | `8132244`, `38c1d08` | — | 작업 분해 기준(제약을 작업으로 쪼개지 않기) 개선 여부 미확인, 현재 HEAD live 재실행(승인 필요) |
| F02 범용 프로젝트 | **구현**: `kind: general`(폴더만), Git 전용 기능 `GIT_REQUIRED`, 홈 새 작업이 일반 프로젝트를 만들고 자료를 `inputs/`에 1회 저장(덮어쓰기 금지·인증정보/개인정보 차단). **F02-REG 구현(mock 테스트)**: 허용 목록의 기존 폴더를 일반 프로젝트로 등록, 자료 교체를 보존 버전으로 기록(`c455fae`), 등록 폴더는 격리 공간 전까지 비격리 AI 실행 거절(`3e38aad`, fail closed) | project-general·creation-ui·first-flow | Chrome FF1: 생성→자료→기획→승인→실행→후속→재시작 보존(구 HEAD). F02-REG는 브라우저·live 미확인 | Claude live(FF1) | A01,A16 | `977a564`, `8132244`, `c455fae`, `3e38aad`, `b7ec6b9` | 등록 폴더 AI 쓰기·기획 정책은 사용자 결정 대기(F02-REG 결정, REG-ISOLATED-PLANNING) | 위 "남은 차단·승인 필요" 결정, 보관된 자료 버전 복원 없음 |
| F03 기준·변경 관리 | **대부분 구현**: 버전·승인·CAS·stale 거부·결정 이유, `nonGoals`(기존 해시 불변, Claude 기획이 제안 가능), Run에 기준 해시 결속, 현재성은 lineage head | planning-baseline·general-planning(전환 후 유지) | 수동 승인 | — | A02,A03 | `4cc977b`, `4eef10c` | Codex 기획 스키마의 `non_goals`는 live 검증 전까지 미추가 | **P7(`c0c6ab9`)에서 A03/A11 기준 변경·영향 stale 화면 구현(UI 테스트, live 미확인)**. 남은 것: 현재 HEAD 브라우저·live 확인 |
| F04 세 도구 연동 | Codex: 기존. **Claude Code: 어댑터·일반 프로젝트 실행·기획**. ChatGPT 웹: 없음 | 어댑터·task·service·HTTP | Chrome: Claude 실행 2회·기획 1회 | **Claude Code 2.1.312 live**(완료·중단·쓰기·Task·기획, `claude-opus-5-5` native_observed). **Codex CLI 0.165.0 live 검증(2026-10-29, `execute.code` 1회, HEAD `fecf6ff`)**: 작업 성공이나 actual model unknown·`quality_blocked`. 0.163.0 미검증 기록은 폐기. 이후 HEAD 재실행 없음 | A04~A06 | `scripts/verify-claude-runtime.mjs`, `docs/ORBIT-LIVE-CLI-2026-10-29.md`, `docs/evidence/live-cli-*.json` | ChatGPT 웹 **deferred**(F04 웹 부분·A06, 이용 조건·공식 경로 미확인, [결정](ORBIT-DECISION-2026-10-29-GPT-DEFERRED.md)). Codex 실제 모델 관측 불가(외부 한계) | 현재 HEAD live 재실행·코드 프로젝트 Claude 실행(추가 실호출 승인 필요) |
| F05 AI 간 인계 | **부분**: 구조화 인계 패키지·Markdown·진행판 보기, Claude 실행 지시문에 기준·결정·nonGoals 포함, 같은 프로젝트 Claude 순차 작업, **교차 모델 검토 지시문·엄격 파서(`claude-review.ts`, 연결 대기)** | handoff·general-planning(전환 후 brief·handoff 동일) | 인계 자료 표시 | Claude→Claude 순차 확인. **Codex↔Claude 인계 live 미검증**. 인계 수신 기록은 구현(mock 테스트) | A07 | `4cc977b`, `726bb48`, `6a121ad` | — | **HANDOFF-RECEIPT(`726bb48`) 구현**: append-only 인계 이력, 실행기에서 도출한 수신 기록(목적지·시각·확인). Codex 기록 경로 전용 테스트 없음. 다른 실행기 인계 live는 승인 필요(A07) |
| F06 진행 상태 | **구현(일반 프로젝트)**: 3단계 진행판, 실행별 마지막 이벤트·최근 도구, 실행/중단/다시 실행(요청 ID 고정, lost 재시도 금지), 실행기별 신호(일반=Claude 한도, Codex 로그인 미반영) | 진행판 30+·HTTP | Chrome: 실시간 실행·도구·완료, 재시작 보존 | Claude live | A09,A10,A11 | `cca18d7`, `3c4aff4`, `c0c6ab9`, `1cfe368` | — | **P7(`c0c6ab9`) 진행판 쉬운 표현·작업 그래프 패널 마운트(X07), CODE-RUN-PROJECT(`1cfe368`) 코드 작업 run에 projectId 기록 구현(mock)**. 남은 것: 코드 프로젝트 실행의 실시간 live 확인, 브라우저 세션 이벤트 연결, 진행판 projectKind 하드코딩 확인 |
| F07 실행·검토 | **부분**: Codex Solo + 같은 Codex 리뷰, 일반 프로젝트 Claude 단일·순차 실행 | 있음. **CQG-1~6c·CQG-5, Parallel Workers PW-1~5(mock 테스트만, live 병렬 없음)** | Claude 순차 | Reviewer 호출 0회 | A08 | `5aee43a`, `dc988c4`, `35d5870` | Codex 산출물은 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 독립 검토 차단(외부 한계) | 교차 검토 live(승인 필요), 일반 후보 근거(GENERAL-ACCEPT-B 결정), 결과물 기반 수정 작업 |
| F08 결과물·검증 | 코드: 구현. **일반 프로젝트: 입력 자료/결과물 분리, 작업 출처·크기·digest·형식 검사·미리보기, 표 수치 근거 대조(passed/needs_review/unverified)**. 내용 적합성은 `unverified`. **근거 대조는 진행판 검증 집계에 미연결** | deliverables·first-flow | **Chrome FF1: 결과물 4개·근거 대조·미리보기** | Claude 결과물, 독립 대조 0 불일치 | A13 | `8132244`, `f0cc85e`, `3fcbe19` | 일반 후보 근거 생산기(GENERAL-ACCEPT-B) 결정 대기 | **P2/P4/P5/P6(`f0cc85e`) 결과물 바이트 읽기·다운로드·버전 이력·Goal 증거 참조 구현(mock/fake), CODE-SOURCE-DIGEST(`3fcbe19`)**. 남은 것: 근거 대조→작업 CheckRecord 연결 여부 미확인, 통합 결과물 버전 provenance(runId/taskId null), live 확인 |
| F09 중단·복구 | **부분**: lost/quarantine/interrupt/중복 방지, Claude 실행은 해당 작업만 격리, Claude 한도 이벤트→진행판 `quota_wait`, keep-alive 연결 끊김 수정 | 있음 | — | Claude live 중단(스크립트) | A10 | `afd7747`, `3c4aff4`, `ce66c15`, `787e093` | RECOVERY-UX 사용자 결정 대기 | **명시적 복구 API(Claude lost run)·한도 초기화 후 재개 안내 구현(`ce66c15`, `787e093`, mock 테스트, live 복구 없음)**. 남은 것: pid 증거 없는 해제·run 단위 해제·quota 메모리 한정 결정, A10 live HTTP 재시작 |
| F10 모델·사용량·도구 | **부분**: 프로젝트별 기획/실행 AI 선택(실행 가능한 조합만 저장, 실행 시 재확인), Model Hub(env 등록만), Codex·Claude 사용량 관측. **사용자 정의 Registry 병합됨**(R1 `96eff58`, R2 `f230799`, R3 `bc061a6`, R4 UI·R5 HTTP `fc0afd1`: 인증 값 미저장·참조 이름만, 사용자 항목 기본 비활성). **Usage U1~U4**(`0b6fe1e`, `66476f8`, `764e88f`, `25ca69b`). **Tools T1~T7**(T1 `52e8fbe`, T2 `2c4e3db`, T7 `c9b6eb9`; 승인된 호출·검증 원장, 비허용 호출 차단). 모두 mock/fake 테스트 | ai-preferences·UI·registry·usage·tools | AI 선택·Registry 화면 mock headless Chrome | 외부 모델·Registry 연결 진단·quota 조회·도구 실제 호출 live 0회 | A14,A15 | `fbb7cf5`, `05c98e6`, `fc0afd1`, `25ca69b`, `c9b6eb9` | TOOLS-T8(A15 실제 호출)·A14 실제 quota·Registry 실제 연결 진단은 승인 대기, 도구 정책 확장(Skills/Claude MCP/Plugins) 승인 대기 | 위 "남은 차단·승인 필요", 프로젝트 도구 프로필 |
| F11 간편·고급 | **부분**: 간편(새 작업·프로젝트·진행 현황·결과물·설정)/고급(기존 전 페이지·AI 명령·기술 상세) 전환을 설정·사이드바에서 제공, 같은 데이터 사용. 홈·프로젝트·결과물 화면 간편 표현. **진행판은 P7(`c0c6ab9`)에서 쉬운 표현 적용**, Registry·실패 색인(FE-4 `27352d8`)·Harness(HE-7 `d42c213`) 화면 추가(UI 테스트). 기획 스튜디오 내부는 기존 표현 | studio-ui·ui-home-project | **Chrome: 모드 전환 전후 데이터 동일, 390/820/1280px** | — | A12 | `4e52d99`, `c0c6ab9` | — | 현재 HEAD 브라우저 확인, 나머지 화면 정리 |

## 현재 차단 (2026-10-28)

- **Codex 사용 불가:** C5(사용자 정의 모델 Registry, F10) 실행 직후 Codex CLI가 `Your workspace is out of credits`로 종료됐다. Codex worktree(`codex/core-model-registry`)에 변경 없음. 지시에 따라 Codex 소유 공유 파일(서버·DB·공통 계약)은 수정하지 않고 독립 작업만 진행 중. 재개 지점: 크레딧 충전 후 `scratchpad/codex-c5-brief.md` 지시문으로 C5 재실행, 또는 사용자 승인 시 Claude Code가 C5를 순차 수행.
- 교차 검토 모듈(`server/runtimes/claude-review.ts`)은 구현·테스트됐으나 Controller/HTTP 연결은 위 사유로 대기.

## C4 통합 검토 결과 (사용자 요청 6항목)

1. **일반 프로젝트에서 기획·실행 AI를 실제로 선택할 수 있는가** — 아니다(정직한 현재 상태). 일반 프로젝트는 Codex가 Git 작업 공간을 요구해 기획·실행 모두 Claude Code만 가능하다. 선택 화면은 Codex를 사유와 함께 비활성 표시한다. 코드 프로젝트는 기획 AI를 Codex/Claude 중 실제로 고를 수 있고, 실행은 Codex만 가능하다.
2. **선택이 실행에 실제 반영되는가** — Codex 초안은 실행 불가 조합(일반+Codex 기획, 코드+Claude 실행)을 저장할 수 있어 저장값과 실제 실행기가 어긋났다. 통합에서 실행 불가 조합 저장을 거절하고(`GIT_REQUIRED`/`RUNTIME_NOT_SUPPORTED`), 작업 실행 시 저장값과 실행기 일치를 서버에서 재확인하도록 고쳤다. 기획은 미리보기 digest에 실행기·설정 revision이 들어가 설정 변경 시 이전 미리보기로 시작할 수 없다.
3. **모델 전환 후 기준·결정 이유·목표 유지** — 회귀 테스트로 확인: 코드 프로젝트에서 기획 AI를 Codex→Claude로 바꾸고 새 초안을 저장해도 승인본·실행 brief·인계 자료(결정 이유·nonGoals·목표)가 동일하다. 브라우저에서도 Claude 초안 저장 후 승인본 r1 불변을 확인했다.
4. **보안·승인 정책 동일성** — 기획 경로는 두 실행기가 같은 입력 검사를 공유한다. 작업 실행 경로는 Claude가 마스킹만 하고 개인정보 차단이 없어 불일치였다. 통합에서 Codex와 같은 원문 brief에 같은 차단(`CREDENTIAL_LIKE_INPUT`/`PERSONAL_DATA_BLOCKED`, `guardrail.denied` 기록)을 적용했다. 격리: Codex는 `--disable` 기능 목록·sandbox(네트워크 없음)·승인 정책, Claude는 `--restricted`·빈 MCP·`--permission-prompts none`·도구 허용 목록·작업 폴더 한정. 두 CLI 모두 각 제공자 API로의 전송은 Orbit 통제 밖이다(문서화된 한계).
5. **ECONNRESET 원인** — 같은 프로세스의 동기 Git 작업이 이벤트 루프를 서버 keep-alive(기본 5초)보다 오래 막아, 서버가 유휴 연결을 닫는 순간 클라이언트가 재사용해 발생. 근거: 최소 재현(6초 정지 시 재사용 리셋, 65초 설정 시 0회), 전체 스위트 측정(실패 파일 merge-http 정지 7.3~11.4초). 테스트는 수정하지 않고 서버 `keepAliveTimeout=60s`로 고쳤으며 회귀 테스트를 추가했다. 수정 후 연속 4회 실패 0. 같은 경쟁은 제품(브라우저 POST)에서도 가능했다.
6. **STATUS 정확성** — 이 문서를 위 기준으로 갱신했다.

## 작업 기록

| 시각(KST) | 담당 | 작업 | 결과 |
|---|---|---|---|
| 2026-10-28 | Claude Code | **UI1 홈·프로젝트 화면**: 홈 새 작업 우선·예시·최근 프로젝트, 프로젝트 작업 화면(6단계·다음 할 일·기획·실행·추가 지시·AI 선택·자료·결과물), 결과물 페이지, 설정 모드 전환, 간편/고급 메뉴 | typecheck·build 0, 전체 1205/1203/0/2 skip, Chrome 실연동 기획 1·실행 1, 반응형 3폭, `4e52d99`→병합 `440b8da` |
| 2026-10-28 | Claude Code | **FF1 첫 비코드 흐름**(Codex 차단 중 단일 담당, Codex 소유 파일 포함): 홈 새 작업·자료 저장·Claude 기획 펜스/자료 읽기·질문 답변 버전·일반 프로젝트 승인 카드·근거 대조·간편 메뉴 | typecheck·build 0, 전체 1201/1199/0/2 skip(최초 12 fail→수정), Chrome 실연동 기획 3·실행 4, `8132244`→병합 `59dcc7c` |
| 2026-10-28 | Claude Code | 일반 프로젝트 Start를 자연어 기획 요청으로 시작, 저장 버튼 이름 정리 | `c14df45` |
| 2026-10-28 | Claude Code | T0 문서 정리: SCOPE v1.1 공동 개발 정정, 경로 수정, COLLABORATION·STATUS 작성 | 문서만 변경, `615fc72` |
| 2026-10-28 | Codex (`codex exec`) | C1 F02 일반 프로젝트 — `codex/core-general-projects` | Codex sandbox에서는 loopback listen EPERM으로 HTTP 테스트 실행 불가. Claude가 검토·UI fixture 보완 후 sandbox 밖 검증: 전체 1059/1057 pass/0 fail(동시 4). 기본 병렬은 2회 중 각 1건 ECONNRESET(기존 알려진 현상) |
| 2026-10-28 | Claude Code | 통합: C1+진행판+어댑터 병합, 진행판 라우트 연결 | typecheck·build 0, 전체 1099/1097 pass/0 fail/2 skip(동시 4, 기본 병렬 모두), `fdce439` |
| 2026-10-28 | Claude Code | 일반 프로젝트 생성 UI, 진행판 문구 수정 | UI 27/27, `29c03ff` 병합 |
| 2026-10-28 | Codex (`codex exec`) | C2 T1 기준 결속(nonGoals·Run contentHash) + F05 구조화 인계 | sandbox EPERM으로 HTTP 미실행. Claude 통합: 승인 시 이전 승인본을 superseded로 다시 쓰는 초안 동작과 이를 우회한 기존 테스트 수정을 되돌림(기존 Start 흐름 회귀). 전체 1111/1108/1 ECONNRESET, `4cc977b` |
| 2026-10-28 | Codex (`codex exec`) | C3 Claude Code dispatch(일반 프로젝트) | Claude 통합: 프로젝트당 활성 writer 1개 추가, workspace 지정 요청의 C1 `GIT_REQUIRED` 계약 복원. 전체 1142/1139/1 ECONNRESET, `afd7747` |
| 2026-10-28 | Claude Code | 진행판 실행·중단·인계 UI, 활동 기반 관측 | UI·모델 30+, 실제 Claude 2회 실행 브라우저 E2E, `cca18d7` |
| 2026-10-28 | Codex (`codex exec`) | C4 일반 프로젝트 기획(Claude)·프로젝트별 AI 선택 | sandbox EPERM으로 HTTP 미실행. Claude 통합 검토: 실행 불가 조합 저장 거절·실행 시 재확인, Claude 작업 입력 차단 Codex와 동일화, 전환 후 기준 유지 테스트 추가. 전체 1173/1171/0, `fbb7cf5` |
| 2026-10-28 | Claude Code | keep-alive 수정, 결과물 라우트, 실행기별 진행 신호, 일반 프로젝트 기획 UI, AI 선택 UI, Claude 기획 non_goals | 전체 1186/1184/0(연속 4회 0), Chrome: 실제 Claude 기획·결과물 미리보기, `3c4aff4`~`4eef10c` |
| 2026-10-28 | Claude Code | 진행판 읽기 모델·수집기·화면 (`claude/progress-board`) | 단위 27/27(내비게이션 포함), typecheck·build 0, `0756149` |
| 2026-10-28 | Claude Code | Claude Code 어댑터 + live 검증 | 단위 11/11, live 완료·중단 exit 0, `60cf685` |
| 2026-10-28 | Claude Code | BrowserAdapter 경계(probe·대상 정책·세션 이벤트 정제) | 단위 6/6, 설치 없음, `598eb63`. agent-browser·Playwright 미설치로 실제 드라이버 미연결 |

## 발견한 문제

- 재빌드 후 브라우저가 이전 `app.js`를 계속 사용해 새 화면이 보이지 않았다(쿼리 문자열로 우회). 정적 자산 캐시 헤더/파일명 해시 검토 필요.
- (해결) 전체 스위트의 간헐 `ECONNRESET` — 원인과 근거는 위 C4 검토 5번. 서버 `keepAliveTimeout=60s`(`3c4aff4`).
- 브라우저 검증 중 수동 편집기의 "초안 저장"과 기획 제안의 "제안을 새 기획 초안으로 저장"을 혼동해 빈 템플릿 초안이 일회용 DB에 저장됐다. 두 버튼 이름이 비슷해 사용자도 혼동할 수 있다(UI 개선 후보).
- 기획 지시문이 코드 앱 미리보기 제약을 언급해 비코드 기획에도 "HTML preview로 바꾸지 않는다" 같은 제약이 생겼다(F01 개선 후보).

- Codex sandbox(`workspace-write`)에서는 loopback listen이 막혀 HTTP 테스트를 실행하지 못한다. Codex 작업은 항상 sandbox 밖(Node 24)에서 Claude가 전체 재검증한 뒤 통합한다. Codex sandbox는 Node 26으로 실행됐다.
- 상단 표시줄의 "연결 안 됨"은 Codex 연결 상태만 뜻한다. Claude 실행 중에도 그대로라 혼동될 수 있다(실행기별 상태 표시 필요).
- (해결) 기획 AI 제안은 일반 프로젝트에서 Claude Code로 사용 가능(`fbb7cf5`), 첨부 자료 읽기(`8132244`).

## 실연동 관찰 기록

- Claude Code 2.1.312: 최소 환경에서는 `authentication_failed`. macOS 키체인 조회에 `USER`가 필요해 어댑터 전용 환경에만 `USER`/`LOGNAME`을 추가했다(Codex 자식 환경은 그대로). `apiKeySource: none` → 구독 인증, API 키 과금 경로 아님.
- `result.subtype`이 `success`여도 `is_error: true`일 수 있다. 어댑터는 `is_error`와 오류 코드로 판정한다.
- `rate_limit_event`가 5시간/7일 창의 사용률·초기화 시각·상태를 제공한다. C3에서 `claude.quota` 이벤트로 기록(진행판 quota 신호에는 아직 Codex 사용량만 사용).
- 2026-10-28 일반 프로젝트 E2E: R1(Glob→Read→Write, 약 44초)·R2(Read→Write, 약 42초) 완료. Claude는 웹 도구가 없음을 결과물에 밝히고 수치를 지어내지 않았으며 승인 기준을 바꾸지 않았다고 기록했다.
