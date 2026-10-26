# Orbit 6개 실행 모드 계약

조사·작성일: 2026-10-25. 구현 파일은 `shared/execution-modes.ts`, 계약 검증은 `tests/execution-modes.test.ts`다. 이 문서는 제공자 중립 제품 모드 설계이며 새로운 실행 엔진, 스케줄러, 프레임워크 또는 모드 실행 API를 추가하지 않는다.

## 현재 구현 경계

현재 **Solo의 Codex 단일 실행만 기존 Controller/App Server 경로에 연결**돼 있다. Cross Review, Debate, Race, Cooperate, Goal은 모두 `not_connected`이며 순수 launch 계약이 `MODE_NOT_CONNECTED`로 차단한다. 공식 제공자의 기능이 존재하거나 Registry에 문서상 지원이 표시돼도 이 상태는 바뀌지 않는다.

`EXECUTION_MODES`는 불변 설명 데이터다. `connection:existing_codex_runner`는 기존 Codex 프롬프트/패치 실행 경로가 있다는 뜻이며, 이 파일의 예산 gate가 Controller에 이미 연결됐거나 전체 개발·검증·승인 경로가 완성됐다는 뜻이 아니다. 이번 변경은 Controller/HTTP/DB/기존 shared 타입을 수정하지 않는다.

실제 `server/codex.ts`는 `hooks`, `multi_agent`, `goals` 등을 비활성화하고, Controller는 sandbox/MCP 정책을 확인하며 RPC 승인 요청을 거절한다. `ORBIT_NATIVE_EXECUTION_FEATURES`도 hooks/multiAgent/goal을 false로 선언한다. 여기서 제공하는 native 재사용 계획은 이 정책을 켜는 설정이나 권한이 아니다. 2026-10-26 설치 CLI의 `--disable goals` 지원을 확인해 명시 차단을 추가했다. 실제 restricted Solo에서 Goal 도구가 노출됐다는 검증은 아니다.

접근법은 **기존 실행기 + 공식 native 기능 + 순수 선행조건 계약**이다. 별도 멀티에이전트 엔진을 만드는 방안은 기존 구조와 범위를 벗어나므로 채택하지 않는다. 공식 subagents/Goal을 이름만으로 활성화하는 방안도 설치 버전·권한·격리·예산·복구 검증이 없으므로 채택하지 않는다.

## 모드별 목적·역할·종료 조건

| 모드 | 요구사항과 역할 | 권한 | 완료·중단 기준 |
|---|---|---|---|
| **Solo** | 현재 승인 기획과 인수조건을 구현자 한 명에게 인계. 현재는 ready Codex 한 개와 검증된 worktree 필요 | 구현자는 해당 격리 worktree만 쓰기. 사람은 검토/최종 승인 | 모델 응답 완료와 별도로 실제 등록 검증 결과, 사람 검토와 명시적 승인 필요. 실패/미검증/거절은 완료 아님 |
| **Cross Review** | 구현자 + 별도 검토 세션. 고정 base/head SHA와 변경·인수조건을 읽기 전용 검토자에게 전달 | 구현자 격리 쓰기, 검토자 읽기 전용, 사람 승인 | 지적에 위치/근거/확인·처리 상태 기록 → 필요한 수정 → 실제 재검증 → 사람 승인. 다른 제공자 검토는 선택이고 동일 제공자 새 세션은 해당 출처로 표시 |
| **Debate** | 승인된 논점을 제안자·비판자·종합자가 제한된 라운드에서 검토. 새 결정은 기획 초안으로 반환 | 모든 AI 역할 읽기 전용. 합의는 실행/쓰기 권한을 부여하지 않음 | 선택지·근거·반론·미결정 질문을 보존하고 사람이 결정. 코드 실행은 승인된 후속 Task/Solo 경로로 별도 요청. 합의 실패나 라운드 한도는 unresolved/보류 |
| **Race** | 같은 프로젝트·승인 요구 버전·base·테스트/E2E 정의를 두 독립 후보가 구현. 서버 비교자와 사람 최종 선택 | 후보별 서로 다른 격리 worktree 쓰기, 비교자는 읽기 전용 | 아래의 실제 증거 비교 계약을 만족할 때만 winner/tie/no_winner. 증거 부족은 incomparable. 승자가 있어도 사람 승인·검증된 통합 전 merge 금지 |
| **Cooperate** | 조정자 + 작업별 worker + integrator. 승인 Task 의존성·파일 소유권·통합 순서를 먼저 고정 | 조정자는 읽기 전용. worker는 자기 worktree만 쓰기. integrator는 별도 통합 worktree만 쓰기 | 각 인계와 충돌 처리 기록 → 기존 통합 Runner의 실제 통합 검사 → 사람 승인. worker 완료 수로 통합 완료를 추론하지 않음 |
| **Goal** | 승인 목적·인수조건·금지사항·중단조건을 native Goal에 인계하고 서버가 실제 검증 증거를 수집 | native worker에도 기존 sandbox/승인 경계 유지. 검증자는 등록된 서버 검증 경로만 사용 | native achieved는 참고 신호. 실제 목적 달성 검증과 사람 승인으로 완료. 예산/반복 한도·오류·사용자 중단은 명시적 종료·보류 상태. 재시작 자동 재실행 없음 |

모든 모드에서 네트워크/도구/파일 권한은 기존 승인 범위를 넘지 않는다. 역할 이름은 권한을 부여하지 않으며, 읽기 전용 프롬프트만으로 파일 변경이 차단됐다고 판단하지 않는다. 실제 provider sandbox와 서버 검증 증거가 필요하다. RPC 승인과 최종 결과 승인, 코드 검증 성공은 각각 별도 상태다.

## 제공자 native 기능 재사용

Codex 공식 App Server 문서는 thread/turn/interrupt, `review/start`, `thread/goal/set|get|clear`, subagent 계열 thread와 이벤트를 설명한다. 별도 review는 새로운 thread에서 실행하는 경로가 설명돼 있고, goal 목적 교체는 native 사용량 카운터를 초기화할 수 있다. 이 사실은 특정 설치 버전이나 현재 Orbit 정책에서 실행 가능하다는 증거가 아니다. [공식 Codex App Server](https://learn.chatgpt.com/docs/app-server)

Claude Code의 CLI/SDK subagents, 실험적 Teams, native Goal 및 인증/과금·복구 제한은 별도 [공식 capability 조사](CLAUDE-CAPABILITIES.md)를 따른다. 특히 문서상 기능과 머신의 설치/인증/실행 가능 상태를 구분하며, 구독 사용 권한과 배포 제품의 인증 허용 범위를 임의로 확대 해석하지 않는다.

향후 backend 선택 순서는 검증된 기존 단일 실행 → 지원되는 공식 새 검토 세션/subagents/Goal → 미지원으로 차단이다. 이 문서는 미지원 기능을 자체 무한 루프나 hook 설치로 흉내 내는 fallback을 제공하지 않는다. hooks/multi_agent/Goal을 활성화하려면 별도 capability·정책·작업공간·예산·중단/복구 회귀 gate가 필요하다.

## 유한 예산 계약

`validateExecutionBudget(budget)`는 측정기나 과금 차단기가 아니다. 신뢰된 서버가 산출한 **현재 한도·사용량·실제 강제 가능 여부**를 검사하는 순수 계약이다.

- turns/attempts/iterations/duration/tokens 각각 양의 safe integer 상한과 0 이상의 실제 사용량이 필요하다. null/누락은 unknown이며 Infinity·NaN·음수·소수·0 상한은 invalid다.
- 상한에 도달하거나 넘으면 exhausted. 재시도·검토·토론 라운드·subagent·Goal evaluator를 부모의 집계 한도 밖에서 무료 호출로 취급하지 않는다. 한도는 다음 호출 전에 검사하고 실행 중에도 검증된 native/server 경로로 강제해야 한다.
- `tokenLimitEnforced:true`는 구성값이 아닌 서버 검증 사실이다. 사후 토큰 표시만으로 강제 가능하다고 선언하면 안 된다. 토큰을 측정/제한할 수 없으면 `BUDGET_UNKNOWN` 또는 `BUDGET_UNENFORCEABLE`로 차단한다. 현재 일반 Solo 경로의 새 토큰 상한 기능이 구현됐다는 주장은 하지 않는다.
- **subscription**은 확인된 available quota와 호출/반복/시간/토큰 상한을 사용한다. API cost 항목은 null, API cost enforcement는 false다. 이는 API 비용 0원이나 무제한을 뜻하지 않는다. quota unknown은 available로 승격하지 않는다.
- **api**는 별도 유한 `maxCostMicros`, 실제 `costUsedMicros`, 검증된 cost enforcement가 추가로 필요하며 subscription quota로 API 비용을 대신 승인하지 않는다. 금액 단위는 서버의 동일 화폐 micros로 통일해야 한다. 추정 가격만 있을 때 실제 강제 예산으로 표시하지 않는다.
- 공급자 전환, 자식 agent, 새 세션, Goal 목적 교체와 resume도 상위 durable 집계를 초기화하지 않는다. 중복 이벤트·cumulative usage·resume의 과거 비용을 중복 합산하지 않도록 기존 run/event ID에 연결해야 한다. 해당 영속 집계 구현은 이번 범위 밖이다.
- quota/auth 실패를 API 키 과금 경로로 자동 전환하지 않는다. 새 인증/과금 경로에는 사용자의 별도 승인이 필요하다.

새 모드의 launch evaluator는 요구/권한/예산이 모두 유효한 Solo만 ok를 반환한다. 다른 5개 모드는 사실 입력이 낙관적이어도 현재 미연결 상태에서 실행되지 않는다. **ok는 기존 Controller의 승인·Origin/CSRF/session·경로·정책 검사를 대체하지 않는다.**

## Race 작업공간·재현성 계약

`validateRaceCandidates(candidates)`는 정확히 두 개의 **신뢰된 서버 facts**만 받는다. 다음이 모두 필요하다.

1. candidateId와 worktreeId가 각각 다르고, canonicalPath와 workspace가 서버에서 실제 검증돼 있어야 한다. currentPlanApproved도 true여야 한다.
2. 절대 canonicalPath가 서로 다르고 중첩되지 않아야 한다. Windows는 드라이브·대소문자·구분자 별칭을 같은 경로로 비교하며 dot segment·특수 경로는 거절한다. POSIX는 대소문자를 보존한다. 서로 다른 pathStyle을 혼합하지 않는다.
3. 동일 projectId, planningVersionId, baseSha, approvedRequirementHash, testSuiteHash, e2eSuiteHash를 고정한다. 해시는 정규화된 승인 요구·등록된 명령/인자/환경 계약·E2E 시나리오/수용 조건을 재현할 수 있어야 한다. 코드 파일에 들어 있는 자기 선택 테스트 정의만 해시해서 고정 suite라고 판단하면 안 된다.
4. 후보마다 현재 sourceDigest를 계산한다. 후보 A와 B의 digest가 **서로 다른 것은 정상**이며 같아도 허용한다. 비교 시 각 검증 증거가 자기 후보의 digest에 일치해야 한다.

서버는 canonicalization·symlink/junction/hardlink 방어·worktree 소유·실제 Git base/HEAD·승인 current head·검증 로그 파일 및 해시를 직접 확인해야 한다. 문자열이나 `workspaceVerified:true`를 HTTP body에서 받으면 누구나 위조할 수 있다. **이 순수 validator는 파일시스템 검증·HTTP authorization·서버 attestation을 대신하지 않는다.**

분석 중 source/HEAD/승인 버전/검증 suite가 변하면 증거를 stale로 처리하고 재검증한다. runtime 비교 전 서버가 동일 시점 facts를 새로 읽어야 한다. pure 함수가 숨은 파일 변경이나 TOCTOU를 탐지했다고 주장하지 않는다.

## Race 검증 증거와 비교 결과

`compareRaceCandidates()`는 후보별 선택된 tests 한 건과 e2e 한 건, 정확히 두 건의 검증 증거를 요구한다. 과거 실행 전체를 전달해 최신 성공을 임의로 고르지 않는다. 서버가 현재 source/suite에 해당하는 선택을 먼저 확정해야 한다.

각 증거에는 `origin:server-runner`, 고유 runId, project/worktree ID, 실제 프로세스 종료가 관찰된 `execution:completed`, 0 이상의 실제 exitCode, 자기 sourceDigest, 해당 test/E2E suiteHash, 로그/결과물의 evidenceDigest가 필요하다. 여기의 completed는 프로세스가 종료됐다는 뜻이며 exitCode 0만 성공이다. not_run/interrupted/lost/exit 미확인·누락/중복 suite·run ID 재사용·다른 source/suite 증거는 incomparable이다. agent 서술이나 가짜 log digest는 서버 증거가 아니다.

| 실제 증거 | 결과 |
|---|---|
| 두 후보 모두 tests=0, E2E=0 | `comparable / tie` |
| 한 후보만 tests=0, E2E=0, 다른 후보에는 유효한 비0 종료 증거가 있음 | `comparable / winner` |
| 두 후보 모두 한 가지 이상 유효한 비0 종료 | `comparable / no_winner` |
| 작업조건 또는 필수 증거가 비교 가능하지 않음 | `incomparable` |

agentReportedComplete, durationMs, tokensUsed, costMicros는 승자 판정에 사용하지 않는다. 속도·가격·토큰을 보조 정보로 표시할 수는 있지만 두 통과 후보의 우열은 사람이 결정한다. 비용/토큰 unknown을 0으로 바꾸지 않는다. 비교 결과는 자동 commit/merge/삭제/다음 호출을 수행하지 않는다.

## 순수 API와 오류

```ts
validateExecutionBudget(budget): {ok:true} | {ok:false; code:string}
evaluateExecutionModeLaunch(mode, facts): {ok:true} | {ok:false; code:string}
validateRaceCandidates(candidates): {ok:true} | {ok:false; code:string}
compareRaceCandidates(candidates):
  | {status:'incomparable'; code:string}
  | {status:'comparable'; outcome:'winner'; winnerId:string}
  | {status:'comparable'; outcome:'tie'|'no_winner'; winnerId:null}
```

예산 오류는 BUDGET_UNKNOWN/INVALID/EXHAUSTED/UNENFORCEABLE, 모드 오류는 UNKNOWN_EXECUTION_MODE/MODE_NOT_CONNECTED/MODE_REQUIREMENTS_UNMET/MODE_PERMISSION_DENIED다. Race는 RACE_CANDIDATES_INVALID/WORKSPACE_UNVERIFIED/PLAN_NOT_APPROVED/WORKSPACE_NOT_ISOLATED/CONDITIONS_MISMATCH/EVIDENCE_INCOMPLETE/EVIDENCE_MISMATCH를 사용한다. 값·원문·경로·사용량을 오류에 덧붙이지 않는다.

이 모듈은 Node·provider·DB·네트워크·비밀값을 가져오지 않는다. 입력 사실을 수정하거나 실행을 예약하지 않는다. immutable 모드 설명은 UI 표시 기반으로 사용할 수 있고, 실제 실행 연결은 별도 acceptance gate가 필요하다.

## 검증 증거

- 최초 계약 RED: `node --test tests/execution-modes.test.ts`, exit 1, 8 fail / 2 pass. 실제 미구현 분기를 확인했다.
- 기본 구현 GREEN: 동일 명령 exit 0, 10/10.
- 승인되지 않은 Race plan hash 회귀 RED: exit 1, 1 fail / 11 pass. hash 형태만으로 승인 사실을 대신하던 누락을 재현했다.
- 승인 facts gate 추가 GREEN: 동일 명령 exit 0, **12/12**, fail/skip 없음.
- targeted TypeScript: `node ../../node_modules/typescript/bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --allowImportingTsExtensions shared/execution-modes.ts tests/execution-modes.test.ts`, exit 0.

검증은 순수 fixture만 사용했다. 실제 모드 실행·모델 호출·subagents/Goal 활성화·계정/자격증명·사용자 DB/저장소 변경·설치·커밋은 하지 않았다. 전체 테스트/빌드/브라우저 검증은 통합 소유자가 기존 작업과 함께 취합하며, 이 focused 성공이 6모드 구현 완료 또는 제품 전체 완료를 뜻하지 않는다.
