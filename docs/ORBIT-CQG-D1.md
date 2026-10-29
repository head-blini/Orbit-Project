# CQG-D1 — Continuous Quality Gate 설계 (2026-10-29)

작성: Codex read-only run `CQG-D1` (session `01a185ba-8e0e-7fc0-a2c8-a323c227b8fb`). 검토: Claude Code 오케스트레이터.

**잠정 기본값 (보수적, 사용자 결정 전):** (1) 종속 해제는 사전 승인된 해제 정책이 없으면 대기. (2) 코드 작업 독립 교차 모델 리뷰 필수 여부는 정책 항목으로 두고 미결정 시 필수 아님(F07), 일반 작업 semantic 검토는 기존 독립 검토 요건 유지. (3) N/A는 사용자 승인 사유가 있을 때만, 자동 면제 없음. (4) 선행 산출물은 통합 적용 이후에만 전달. (5) 일반 프로젝트 최종 승인 기록은 후속(미구현 동안 일반 종속 해제 대기).

**1. 현재 증거와 한계**

현재 HEAD `3fff7c1`. 재개 요약의 `25ca69b`와 다릅니다. 아래는 현재 코드의 저장·판정 능력입니다. 운영 DB의 개별 작업 통과 여부는 조회하지 않았습니다.

| 대상 | 현재 존재하는 증거·출처 | 결속·현재성·한계 |
|---|---|---|
| 작업별 집계 | `tasks[].quality`는 최신 Run의 품질. 이전 성공으로 대체하지 않음 | Run별 상세와 별도 제공. [project-progress.ts:44](../server/project-progress.ts) |
| 실행 | runtime source/outcome 이벤트에서 `native/mock/unknown`, 실행 관측 여부 | Codex turn 또는 Claude dispatch/exit 관측. 실행 `completed`는 검증 통과가 아님. [provider-evidence.ts:7](../server/provider-evidence.ts), [quality-progress.ts:45](../server/quality-progress.ts) |
| 코드 검사 | `verification_checks`: command ID, 종료·verdict·exit code·출력. 신규 기록 `local`, 과거 출처 누락 `unknown` | project/task/run/workspace, plan ID/hash, acceptance/config/source/finished digest, base SHA. 현재 명령별 최신 성공과 digest 일치를 검사. [verification-service.ts:57](../server/verification-service.ts), [85](../server/verification-service.ts) |
| 일반 형식·수치 | `quality_artifact_checks`, 신규 `local`. 파일별 hash와 검사 결과 저장 | task/run/plan/artifact 결속. digest는 **입력을 포함한 프로젝트 파일 목록 전체**. 작업 소유 산출물 manifest가 아님. [quality-loop-native.ts:36](../server/quality-loop-native.ts) |
| 의미 검토 | `quality_loops`의 승인 조건별 의견·findings·review step | baseline/artifact digest와 조건 원문 일치. `native/mock/unknown` 구분. 의미 일치는 객관적 정확성 증명과 다름. [quality-progress.ts:94](../server/quality-progress.ts) |
| 독립 검토 | 의미 판정과 별도 `completed` 차원. 반대 의견이어도 검토 완료 가능 | 엔진은 생산자와 다른 모델, reviewer 간 다른 모델, 중복 없는 session을 요구. 서비스는 관측 모델·run도 대조. [quality-loop.ts:16](../server/quality-loop.ts), [quality-loop-service.ts:138](../server/quality-loop-service.ts) |
| 수정·재검증 | repair step 완료와 이후 verification step/check IDs | 수정 산출물 digest와 현재 `local` 검사 성공이 맞아야 재검증 통과. 수정 완료 자체는 통과 아님. [quality-progress.ts:116](../server/quality-progress.ts) |
| 사용자 승인 | 코드의 `verification_approvals`, 출처 `local` | run/workspace/source/check-set digest 결속. 현재 검사 집합과 다르면 무효. 일반 프로젝트 동등 승인 기록은 없음. [verification-service.ts:119](../server/verification-service.ts), [quality-progress.ts:129](../server/quality-progress.ts) |
| 통합 후보 | `integration_queue`와 `integration_checks` | baseline/config/source/candidate/target 결속. 최신 target에 후보 구성 후 설정된 명령 전체 재실행. 현재 후보 검사에는 명시적 출처·모델·독립 검토 계약이 없음. [integration-queue.ts:145](../server/integration-queue.ts), [verification-service.ts:136](../server/verification-service.ts) |

공통 freshness는 `current/stale/unavailable/mismatch`. 기준·산출물 변경은 stale, 누락은 unavailable, 다른 소유 대상은 mismatch입니다. Mock/unknown의 외형상 성공은 `recorded`입니다. [quality-progress.ts:28](../server/quality-progress.ts), [55](../server/quality-progress.ts)

CQG에서 메워야 할 확인된 간극:

- 코드 명령은 임의 ID 목록입니다. lint/type/build/unit/contract/E2E **범주별 충족 여부**는 현재 계약에 없습니다. [shared/verification.ts:2](../shared/verification.ts)
- 일반 수치 검사는 Markdown 표·CSV의 숫자가 입력에 존재하는지만 비교합니다. 출처 권위·계산·문맥은 증명하지 않습니다. [deliverables.ts:42](../server/deliverables.ts)
- 입력 부재·검사할 숫자 부재는 `unverified`. 현재 일반 검사는 `needs_review`만 실패시키므로 형식 종합 `passed`만으로 수치 통과를 추론하면 안 됩니다. [quality-loop-native.ts:45](../server/quality-loop-native.ts)
- 일반 검사·리뷰에는 코드와 같은 검사 설정 digest 무효화가 없습니다. CQG 정책/검사기 버전 결속이 필요합니다.
- Codex 실제 모델은 현재 unknown으로 유지됩니다. native 실행이라는 이유로 품질 완료로 승격할 수 없습니다. [quality-loop-native.ts:24](../server/quality-loop-native.ts)

**2. 최소 `task verified-done` 계약 — 제안**

기존 QG 차원은 유지하고 `tasks[].completion`을 추가합니다. UI용 요약만 AND하지 말고, **현재 요구된 gate에 선택된 증거**를 판정합니다. 과거 stale 기록은 이력으로 보존합니다.

```ts
completion = {
  binding,                 // 아래 범위와 digest
  gates,                   // gate별 status, evidenceIds, source, freshness, blockers
  qualityPassed,
  independentReview,
  userApproval,
  verifiedDone,
  reasonCodes
}
```

`binding` 필수값: project/task/run, planningVersionId/approved-baseline hash, acceptance digest, graph revision/contract digests, artifact ID/manifest hash, policy/config digest.

- 코드는 workspace source fingerprint와 base SHA를 재사용합니다. commit SHA만으로 미커밋 산출물까지 검증했다고 보지 않습니다.
- 일반 작업은 PW의 격리 공간·입력 snapshot·산출물 manifest를 사용합니다. 프로젝트 전체 inventory를 작업 소유 증명으로 재해석하지 않습니다.
- 후보는 별도 subject입니다. integration ID, candidate hash, target HEAD/일반 출력 hash를 추가합니다. Worker 통과 증거를 후보에 복사하지 않습니다.
- 필수 binding 누락·현재 파일 읽기 실패·불완전 inventory는 차단합니다. null은 wildcard가 아닙니다.

| 프로젝트 유형 | 필수 gate 제안 |
|---|---|
| 코드 | lint, type, build, unit, contract, E2E. 승인 정책에서 각 범주를 실제 command ID와 연결. 아키텍처 제약은 lint/contract에 명시적으로 매핑 |
| 일반 | 산출물 존재·읽기·형식, 수치/출처 검증, 승인 조건별 semantic review. 현재 semantic 경로의 독립 검토 요건 유지 |
| 통합 후보 | 해당 유형의 전체 gate를 후보에 다시 적용. 일반 후보도 형식 명령 성공만으로 의미 검토를 대신하지 않음 |

적용 불가능한 범주는 **사용자가 승인한 사유 있는 `not_applicable`**만 허용하는 안을 제안합니다. 검사 미설정·도구 미지원·`unknown`은 면제가 아닙니다.

판정 규칙:

1. `qualityPassed`: 현재 승인 기준·산출물·정책에 결속된 모든 필수 gate 충족, 복구/실패 차단 없음.
2. AI 생산·검토·수정 증거는 native 실행과 실제 관측 모델이 필요합니다. configured model·별칭으로 보완하지 않습니다.
3. 로컬 검사는 `local`로 인정합니다. Mock/unknown 검사를 실제 성공으로 올리지 않습니다.
4. independent-review 완료, semantic 통과, 최종 user approval은 별도 필드입니다. 같은 모델 Worker 둘은 교차 모델 검토가 아닙니다.
5. 수정했다면 새 산출물에 필수 검사와 필요한 검토를 다시 수행합니다. repair 완료는 재검증을 대체하지 않습니다.
6. baseline/artifact/config/policy/관련 계약 변경 시 이전 판정은 stale입니다. 변경된 binding에 재검증 없이 증거를 이월하지 않습니다.
7. `verifiedDone = qualityPassed && 승인된 dependency-release 정책 충족`. 승인 정책 미확정 시 종속 해제는 계속 차단합니다.
8. 실행 종료·형식 검사만·mock·미확인 모델·stale 중 어느 것도 단독 완료 근거가 아닙니다. 이것이 AX04의 필수 불변식입니다.

검증 정책·필수 gate를 Worker나 개선 에이전트가 바꾸지 못하게 합니다. 신규 검사는 정상·실패·보호 회귀 표본으로 검증하며, 생성만으로 개선 완료를 선언하지 않습니다.

**3. 연결 위치**

- **서버 read model 하나:** 제안 `server/task-completion.ts`. `QualityProgressCollector`, 기존 check/loop/approval readers와 PW manifest를 재사용합니다. 새 실행기·done 캐시·중복 evidence DB는 만들지 않습니다.
- **Task Graph HTTP:** 현재 `verifiedDoneIds:[]`를 해당 graph revision에 대한 read model facts로 교체합니다. baseline·graph·DB 증거를 일관된 snapshot으로 읽습니다. [http.ts:482](../server/http.ts)
- **상태 우선순위 유지:** `stale > blocked > done > waiting > ready`. 미실행 작업의 “증거 없음”을 전부 blocked로 만들지 않습니다. 그래야 독립 노드는 ready로 실행 가능합니다. [task-graph.ts:43](../server/task-graph.ts)
- **Scheduler:** 외부 `verifiedDoneIds`를 제거하고 같은 서버 reader를 주입합니다. admission·예약 후·`beforeDispatch`마다 fresh facts를 얻습니다. 현재 코드는 재검사에도 최초 전달된 ID 배열을 재사용합니다. [worker-scheduler.ts:67](../server/worker-scheduler.ts)
- **입력 인계:** 종속 Worker가 받는 선행 산출물 hash도 완료 증거와 일치해야 합니다. 완료 ID만 맞고 다른 파일을 받으면 차단합니다.
- **통합 큐:** 기존 후보 재검증·적용 직전 hash 재확인을 유지하고 동일 gate 정책을 적용합니다. 실행은 기존 명시적 drain/write 경로에서만 합니다.
- **UI:** 서버 completion을 표시하고 출처·stale·독립 검토·최종 승인을 분리합니다. 기존 downgrade-only 로직은 완료 권한으로 사용하지 않습니다. [project-work-model.ts:35](../web/project-work-model.ts)
- **GET 금지 동작:** 검사·모델·repair·dispatch·재시도·migration·복구·이벤트 append 없음. 파일 hash 읽기는 허용하되 검증 실행과 구별합니다.

**4. 독립 소유 작업 단위와 통합 순서**

신규 경로는 제안입니다. 각 단위는 대응 테스트도 독점 소유합니다. 공통 파일을 두 담당이 동시에 수정하지 않습니다.

| 단위 | 독점 파일 소유권 | 필수 테스트 |
|---|---|---|
| CQG-1 계약·판정 | 신규 `shared/task-completion.ts`, `server/task-completion.ts`, `tests/task-completion.test.ts` | gate 누락, binding mismatch, 최신 시도 우선, stale, 승인 정책, AX04 전체 행렬 |
| CQG-2 증거 보완 | `shared/verification.ts`, `server/verification-{service,configuration}.ts`, `server/quality-{progress,loop-native}.ts`, `server/deliverables.ts`; 해당 테스트 | 범주 매핑, config 변경, 일반 수치 unverified, PW manifest 결속, provenance 누락 |
| CQG-3 후보 검증 | `server/integration-queue.ts`, `tests/integration-queue.test.ts` | Worker 통과 재사용 거부, 후보 gate 누락, HEAD/hash 변경 후 재검증, 일반 의미 근거 누락 시 적용 거부 |
| CQG-4 서버 연결 | `server/{controller,http,project-progress,task-graph,worker-scheduler}.ts`, `shared/project-progress.ts`; 해당 테스트 | HTTP/TG/Scheduler 판정 일치, forged facts 거부, 예약 후 stale 시 dispatch=0, restart·GET 무실행 |
| CQG-5 UI | `web/project-work-model.ts`, 필요한 기존 진행판 컴포넌트; 해당 UI 테스트 | 서버 완료만 표시, mock/unknown/stale 하향, 검토와 승인 분리, 구버전 필드 부재 |

통합 순서: **CQG-1 계약 고정 → CQG-2 → CQG-3 → CQG-4 → CQG-5**. STATUS·graphify 갱신은 향후 통합 담당 단독 소유입니다.

AX04는 생산자·reviewer·repair 각각의 mock/unknown, stale baseline/artifact/config, 형식-only, 같은 모델 검토를 개별 fake 사례로 검증합니다. 모두 `verifiedDone=false`, 종속 dispatch=0이어야 합니다. 유효한 코드·일반 fake fixture의 양성 경로도 포함합니다. 테스트용 native 관측 fixture는 실연동 성공이 아닙니다.

