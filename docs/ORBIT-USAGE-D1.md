# USAGE-D1 — 잔여 구독 한도 설계 (2026-10-29)

작성: Codex read-only run `USAGE-D1` (session `01a18526-06b3-7e70-bfd9-8a2678189cb8`). 검토·채택: Claude Code 오케스트레이터.

**결정 사항 기본값 (범위 축소 방향):** (1) 공식 관측 가능한 현재 연결부터 제공, 미식별 계정·ChatGPT 웹은 unknown, 다중 계정 목표는 미완료 유지. (2) 다중 로그인·계정 전환은 공식 인터페이스 확인 후 별도 승인. (3) 60초 stale 표시는 Orbit 표시 정책이며 공급자 보장이 아님, 값은 마지막 관측으로 보존. (4) 로컬 계정 별칭은 첫 구현에서 제외. 사용자가 다르게 결정하면 이 문서를 갱신한다.

**1. 현재 코드가 관측하는 데이터**

아래는 로컬 구현의 수집 능력이다. 이번 작업에서 실제 계정 잔여량이나 최신 공식 인터페이스 동작을 조회하지 않았다.

| 경로 | 관측 데이터·인터페이스 | 최신성·미확인 사항 |
|---|---|---|
| Codex 구독 quota | App Server `account/rateLimits/read({excludeResetCreditDetails:true})`. `rateLimitsByLimitId` 우선, 없으면 `rateLimits`. bucket ID, primary/secondary의 사용률·기간(분)·초기화 시각. 잔여율은 `clamp(100-usedPercent)` 계산값. [server/usage.ts:44](../server/usage.ts), [114](../server/usage.ts) | 두 조회 완료 후 로컬 `checkedAt`. 공급자 측 측정 시각은 없음. 계정 ID·공유 관계·절대 잔여 토큰/요청 수·모델별 배분은 수집하지 않음. |
| Codex 계정 활동 | `account/usage/read({})`: 누적/최대 일일 토큰, 최장 turn 초, 현재/최장 연속 활동일, 일별 토큰. **잔여 quota가 아님.** [server/usage.ts:76](../server/usage.ts) | quota 조회 실패에도 활동은 남을 수 있음. `partial`만 보고 quota가 알려졌다고 판단하면 안 됨. |
| Codex 조회 생명주기 | 연결 시 `account/read({refreshToken:false})`의 `type==='chatgpt'` 확인. 명시적 refresh만 수집, 동시 요청 합침, 60초 캐시, 세대가 바뀐 응답 폐기. [controller.ts:267](../server/controller.ts), [334](../server/controller.ts) | GET은 캐시만 반환. 연결 해제 시 unknown. **60초는 재조회 억제이며 stale 판정이 아님**. 연결 유지 중 오래된 값도 반환됨. [218](../server/controller.ts), [285](../server/controller.ts) |
| Claude 구독 quota | CLI `--output-format stream-json`의 `rate_limit_event.rate_limit_info`. 전체 status와 `unifiedWindows`별 ID·utilization(0~1)·초기화 시각·status. [claude-code.ts:38](../server/runtimes/claude-code.ts), [94](../server/runtimes/claude-code.ts) | 승인된 실행에서 이벤트가 와야 관측됨. 최대 32 windows 투영. 기간·계정 ID·공유 관계·공급자 측 측정 시각 없음. 현재 잔여율 계산 필드는 없음. |
| Claude 보존·조회 | task service가 `claude.quota` 이벤트를 run에 저장하고 최신 quota를 메모리에 유지. [claude-task-service.ts:98](../server/claude-task-service.ts) | 저장 이벤트에는 로컬 `at`·`seq`가 있지만 `claudeQuota()` 반환에는 시각 없음. 최신 캐시는 계정별이 아니며 재시작 복원도 없음. [31](../server/claude-task-service.ts), [store.ts:130](../server/store.ts) |
| Model Hub | 요청 응답의 prompt/completion/total tokens와 `provider|unknown` 출처. 요청 완료 시 저장. `costUsd:null`, `costSource:'unknown'`, native 구독과 별도. [model-hub.ts:4](../shared/model-hub.ts), [model-hub-service.ts:213](../server/model-hub-service.ts) | 토큰 기록은 청구액·구독 잔여량이 아님. Registry 단가 선언도 실제 청구 증거가 아님. [model-registry.ts:17](../shared/model-registry.ts) |

- 현재 Codex quota는 **명시적 RPC 조회 경로**다. Controller 알림 처리에 `account/rateLimits/updated`로 usage를 갱신하는 분기는 없다. [controller.ts:566](../server/controller.ts)
- `quotaSignal`은 관측 window의 잔여율 ≤0을 exhausted로 분류한다. `quotaFromClaudeWindows`는 rejected를 exhausted로 분류한다. 둘 다 계정·시각을 검사하지 않는다. Claude는 unknown status여도 window가 있으면 available이 될 수 있다. [project-progress.ts:132](../shared/project-progress.ts), [claude-task.ts:55](../server/runtimes/claude-task.ts)
- 현재 사용량 UI는 Codex 전용이다. ChatGPT 웹 잔여 quota 수집 경로는 확인되지 않았다. Codex의 `chatgpt_subscription` 표시는 ChatGPT 웹 잔여량 증거가 아니다. [usage.tsx:21](../web/usage.tsx)
- Registry는 provider/runtime/model을 구분하지만 계정 엔터티는 없다. `native_session`도 특정 계정 식별자가 아니다. [model-registry.ts:4](../shared/model-registry.ts)

**2. 최소 설계안 — 아직 승인되지 않은 제안**

기존 parser·Controller·Claude 이벤트·UsagePanel을 재사용한다. 독립 수집 서비스, 폴링, 추가 의존성은 불필요하다.

| 계약 | 최소 내용 |
|---|---|
| 대상 | Registry `providerId`·`runtimeId`, 별도 로컬 `connectionRef`, `accountRef:null|string`, `identityStatus:observed|unknown`. Registry 별칭을 별도 계정으로 간주하지 않음. |
| 출처 | 정확한 인터페이스 식별자, `native|mock|unknown` 증거 구분, 기존 event/run 참조. 원시 응답은 저장하지 않음. |
| 시각 | `observedAt`=Orbit 수신 시각, `providerObservedAt:null`=미제공, `lastAttemptAt` 별도. 조회 실패·GET·재시작으로 관측 시각을 갱신하지 않음. |
| 값 | 기존 `QuotaWindow`·bucket 재사용. Claude utilization이 유효할 때만 `(1-utilization)*100` 계산, 계산 출처 표시. status만으로 숫자를 만들지 않음. |
| 상태 | 데이터 `available|partial|unknown`, 최신성 `fresh|stale|unknown`, 제공자 상태 `allowed|allowed_warning|rejected|unknown`을 분리. unknown 사유 코드 포함. |
| pool | `poolRef:null|string`, `sharing:shared|not_shared|unknown`, 근거 참조. 공식 근거 없으면 unknown. 같은 이름·이메일·구독 종류로 pool을 합치지 않음. |

- **계정 경계:** 기존 인터페이스가 안전한 안정 식별자를 제공하는지 먼저 확인한다. 없으면 “현재 연결 · 계정 미식별”로 표시한다.
- 여러 공식 계정 연결이 확보되면 같은 계약의 행을 추가한다. 현재 singleton 관측값을 여러 Registry 항목에 복제하지 않는다.
- **최신성 기본안:** 60초 이후 stale 표시. 이는 Orbit 표시 정책이며 공급자 보장 시간이 아니다. reset 경과·연결 단절·재시작 시에도 stale 처리한다.
- stale 값은 “마지막 관측”으로 보존한다. 초기화 시각이 지났다고 100%로 복원하거나 실행을 자동 재개하지 않는다.
- 계정 결속·최신성이 없는 값은 프로젝트 quota 신호에 사용하지 않는다. Claude unknown-only windows도 available로 승격하지 않는다.
- **보존:** 기존 `Store.append`에 정제한 관측 envelope를 저장한다. 재시작 시 이력으로 복원하되 현재 계정 값으로 자동 재결속하지 않는다.
- **조회:** 기존 GET은 무부수효과 유지. Codex 수동 refresh만 기존 두 RPC를 재사용한다. Claude·ChatGPT에는 quota 확인용 실행 버튼을 만들지 않는다.
- **공유:** 확인된 동일 pool은 한 번 표시하고 연결들을 참조시킨다. 서로 다른 window의 백분율도 합산하지 않는다.
- **비용:** 구독 quota와 Model Hub API 토큰·비용을 별도 영역에 둔다. `costUsd:null` 유지. Registry 가격 선언으로 실비를 계산하지 않는다.
- **UI:** 계정/연결·runtime별 행에 잔여율 또는 unknown, window, reset, 출처, 관측 시각, stale, 공유 여부를 표시한다.
- scraping, 인증 파일·쿠키·토큰 조회, 로그인 전환, 추가 모델 호출, 자동 유료 API fallback은 제외한다.

**3. 독립 작업 단위·단일 파일 소유권**

아래 신규 파일은 제안 경로다. U1 계약 고정 후 U2·U3·U4를 별도 worktree에서 진행한다.

| 단위·소유자 | 소유 파일 | 완료 테스트 |
|---|---|---|
| U1 계약·정규화 / 계약 담당 | `shared/usage.ts`, `server/usage.ts`, `tests/usage.test.ts`; 신규 `tests/subscription-usage.test.ts` | null/0 구분, 부분 실패, Claude 소수 utilization, timestamp 검증, pool 비합산, native/mock 분리 |
| U2 관측·저장·계정 결속 / 서버 담당 | `server/controller.ts`, `server/claude-task-service.ts`; 신규 `server/subscription-usage.ts`, `tests/subscription-usage-store.test.ts`; 기존 `tests/usage-controller.test.ts` | 지연 응답·연결 세대 변경·계정 혼동 방지, 실패 시 과거 관측 보존, 재시작 stale, 비밀 비노출, 추가 모델 호출 0 |
| U3 HTTP·진행 신호 / API 담당 | `server/http.ts`, `shared/project-progress.ts`, `server/runtimes/claude-task.ts`, `tests/claude-task.test.ts`; 신규 `tests/subscription-usage-http.test.ts` | GET 호출 0, refresh 인증/Origin/CSRF·캐시, stale/미식별 신호 unknown, rejected와 숫자 unknown 분리 |
| U4 화면 / UI 담당 | `web/usage.tsx`; 신규 `tests/subscription-usage-ui.test.ts` | 계정·runtime 행, 미식별/미지원/부분/stale, 공유 중복 방지, 비용 분리, 늦은 응답·화면 전환 |
| U5 통합 / 통합 담당 | `docs/ORBIT-STATUS.md`, 승인 후 USAGE 설계 문서, `graphify-out/` | Node24 전체 verify·브라우저 fixture 검증. 실제 quota 관측은 별도 승인된 실행 증거로 기록 |

`shared/model-registry.ts`는 기존 식별·비용 계약을 참조한다. 계정 관리 기능을 Registry에 중복 추가하지 않는다.

