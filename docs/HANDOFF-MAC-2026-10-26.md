# Mac 개발 인계 — 2026-10-26

## 바로 이어받기

- 저장소: https://github.com/head-blini/Orbit-Project
- 인계 브랜치: `codex/orbit-mac-handoff-2026-10-26`
- 기존 통합 기준: `73ec364`, Windows 작업 브랜치 `integration/orbit-20261025104804486-08592a18`의 미커밋 통합 작업을 함께 보존했다.
- **전체 Goal 미완료.** 원문 요구는 [ORBIT-GOAL.md](ORBIT-GOAL.md), 현황은 [ORBIT-MASTER-PLAN.md](ORBIT-MASTER-PLAN.md), 실행 이력은 [ORBIT-MASTER-RESULTS.md](ORBIT-MASTER-RESULTS.md).
- 사용자가 Windows 작업을 여기서 Git에 보존하고 Mac에서 계속하도록 요청했다. 새 기능 확장은 중지하고 인계 검사만 수행했다. 마지막 병렬 작업은 계정 사용량 한도로 중단됐다.

새 폴더에서:

```sh
git clone --branch codex/orbit-mac-handoff-2026-10-26 https://github.com/head-blini/Orbit-Project.git
cd Orbit-Project
node --version   # 24.x 필수: built-in SQLite/TypeScript 실행 사용
git --version
npm ci
npm run verify
npm start
```

이미 clone한 폴더라면 기존 변경을 먼저 보존하고 `git fetch origin` 후 인계 브랜치를 checkout한다. `reset --hard`, `clean`, 사용자 변경 덮어쓰기는 금지한다. 앱 주소는 `http://127.0.0.1:4317`이며 loopback만 허용한다. AI 미연결 상태의 기획·결과물 작업부터 확인한다.

**macOS 실행·빌드·브라우저·Codex 연결은 아직 검증하지 않았다.** 위 명령은 Mac에서 수행할 인수 절차이며 이미 통과했다는 의미가 아니다.

## 현재 검증 상태

1. Task16까지의 마지막 완전한 Windows gate: 타입·빌드 exit 0, 전체 **445/445**, Chrome **35/35 시나리오·43 PNG**. Native Review 완료·중단·재시작·자동 재실행 방지, 기존 기획·결과물·소스 그래프·Model Hub·실제 명령 검증·안전 병합·Workflow 회귀를 확인했다. [이동 가능한 증거 요약](evidence/2026-10-26-native-review-windows.json).
2. Task17 Extensions inventory는 구현 후 인계용 검사 결과를 아래 `최종 인계 검사`에 기록한다. **Task17 전용 브라우저 2개 시나리오는 아직 작성·실행하지 않았다.** 기존 35단계의 성공을 Task17 성공으로 확대하지 않는다.
3. Native Review 및 Extensions 공식 RPC는 fake 계약 검증이다. 실제 native 리뷰/확장 목록 호출은 미검증이다. 이전에 별도로 수행한 Codex 단일 patch smoke와 구분한다.
4. 실 AWS/외부 모델 서비스·Claude/Gemini·Mac 런타임은 미검증이다. 모델 비용/버전/할당량을 확인 못하면 unknown으로 유지한다.

## Mac에서 먼저 해결할 실제 제약

- `server/codex.ts:findCodex()`가 **Windows `.exe`와 win32 배포 구조만 탐색**한다. `AICC_CODEX_BIN`도 `.exe`만 받는다. 현재 그대로는 Mac Codex 연결이 실패한다. Darwin의 실제 설치 경로/아키텍처/실행 파일 형식을 조사하고 Windows 동작을 보존하는 작은 플랫폼별 resolver와 회귀 테스트를 먼저 추가한다. 임의 shell 실행이나 인증 우회로 해결하지 않는다.
- Windows에서 검증한 Codex는 `0.164.0-alpha.11.1`이었다. Mac의 설치 버전은 `codex --version`으로 확인하고 공식 App Server schema/flags를 비교한다. 알 수 없는 feature flag 때문에 실패하더라도 hooks/plugins/goals/MCP/승인 격리를 제거하지 않는다.
- `server/capability-probe.ts`, `server/child-env.ts`, `scripts/verify-*.mjs`, `scripts/lib/orbit-ui-e2e.ts`의 운영체제 분기를 실제 Mac 환경에서 점검한다. 특히 CLI 실행 파일 탐색과 브라우저 실행은 별도 검증이 필요하다.
- Windows의 `.local` DB에는 Windows 절대 경로와 worktree 메타데이터가 있다. 이를 Mac 앱 데이터로 복사해 바로 실행하지 않는다. Mac은 새 `.local`로 시작하고 테스트용 저장소를 새로 등록한다. Windows 원본 DB/WAL/SHM·작업 공간은 그대로 보존했다.
- Codex 인증은 Mac의 공식 CLI에서 사용자가 직접 설정한다. Windows 인증 파일·토큰·환경 비밀값을 복사하거나 Git에 넣지 않는다. API 키 과금 경로로 자동 전환하지 않는다.

## Task17: 지금 이어서 할 작업

계획: [extension-inventory.md](superpowers/plans/2026-10-26-extension-inventory.md).

- 구현: `shared/extensions.ts`, `server/extensions.ts`, Controller의 `extensionSnapshot/refreshExtensions`, `GET /api/extensions`, `POST /api/extensions/refresh`, `web/extensions.tsx`.
- GET은 캐시만 읽는다. 명시 POST는 현재 격리 세션의 MCP 상태를 먼저 재검사한 후 `skills/list`와 `hooks/list`를 조회한다. 임의 cwd/thread/provider는 받지 않는다. 60초 캐시·조회 중 실행 상호 배제·세션 변경 시 폐기·지연 응답 무시를 구현했다.
- 이름/enum/boolean/opaque ID만 투영한다. command/env/description/path/error 원문은 UI/DB에 저장하지 않는다. MCP/Hooks는 현재 실행 정책에서 계속 차단된다. Skills의 configured enabled는 Orbit 실행 승인이 아니다. 버전은 unknown이다.
- **수정한 리뷰 지적:** null workspace의 기존 읽기 전용 세션을 UI가 막던 문제를 RED→GREEN으로 수정했다.
- **기각한 리뷰 지적:** Hooks `handlerType`가 schema에 없다는 주장은 잘못됐다. stable/experimental `HookMetadata.oneOf`의 네 variant 모두 해당 필드를 required로 선언한다. 원문 command를 읽거나 검증을 느슨하게 하지 않았다.
- Fixture: `scripts/lib/orbit-ui-server.mjs`의 **일곱 번째 exact fourth-project grant**에서만 metadata fake RPC를 허용한다. 이전 여섯 번째 readonly review grant와 분리하며 실제 모델/CLI를 실행하지 않는다. 새 fixture 회귀는 explicit connect→collect→cache→다른 workspace 거절→재시작 미조회·DB 원문 미노출을 검증한다.
- 아직 남은 검증: Controller/HTTP 상호 배제·session generation 경계에 대한 독립 최종 리뷰, Task17 browser 수집/캐시와 재시작 unknown 두 단계, 새 PNG와 cleanup 증거. 기존 `scripts/verify-orbit-ui.mjs`는 **35단계**이며 일곱 번째 grant를 아직 전달하지 않는다. 목표 37단계/45 PNG를 완료했다고 기록하면 안 된다.
- 이후 H 영역: 프로젝트별 확장 profile·preview·불변 backup·CAS restore. 우선 Orbit 소유 선언만 관리하고 글로벌 native 설정/실제 설치·활성화는 별도 adapter·출처 검토·격리 실험 후 연결한다. 손실된 inventory DTO를 설정 복원 원문으로 쓰지 않는다.

브라우저 재검증은 이미 승인·설치된 agent-browser와 Chrome이 있을 때:

```sh
node scripts/verify-orbit-ui.mjs
```

`--check-only`는 브라우저를 실행하지 않아 E2E 통과를 뜻하지 않는다. 추가 설치가 필요하면 자동 설치하거나 승인 환경변수를 변경하지 않는다. 최신 결과 문서는 이 스크립트가 갱신한다.

## 전체 목표에서 남은 항목

- Solo 외 Cross Review/Debate/Race/Cooperate/Goal executor 연결. 현재 6모드 설계·순수 계약만 있으며 수동 Native Review가 Cross Review 전체 실행기는 아니다.
- Claude/Gemini 선택형 실제 adapter, native 역할/handoff/병렬 실행. 경쟁 실행은 서로 다른 worktree와 동일 승인 요구·base SHA·테스트/E2E 증거로 비교한다.
- Planning 버전 diff/decisions/provenance/영향 Task 재계획, 선택적 AI 기획.
- PDF·sequence/C4/UML, 다른 언어 소스 분석.
- Workflow 예약·외부 서비스 단계.
- Extensions profile/backup/restore와 검증된 설치·활성화.
- 프로젝트 보안등급·fallback 목적지 재검사·감사 확장.
- 작업별 토큰/시간/재시도·API 비용·프로젝트 분석.
- 여러 worker 결과의 Runner 순차 통합.

외부 계정이 없어도 진행 가능한 구현은 계속한다. 사용자 승인 없는 유료 API·서비스 활성화·원격 배포·main 병합은 하지 않는다. 공유 Controller/HTTP/SQLite/shared 타입은 한 명만 수정하고, 독립 모듈만 병렬 분담한다.

## Git에 포함하지 않은 데이터

`.local`, 사용자 DB/WAL/SHM, 인증정보, `.env`, `node_modules`, `dist`, 원본 worktree, OS temp의 전체 브라우저 캡처/로그/임시 Git 저장소는 포함하지 않는다. 코드·잠금 파일·테스트·설계·결과 요약을 보존한다. 기존 결과 문서의 Windows 절대 링크는 Mac에서 열리지 않을 수 있으며 검증 재실행으로 새 증거를 만든다.

## 다음 Codex 채팅에 붙여넣기

> `docs/HANDOFF-MAC-2026-10-26.md`, `AGENTS.md`, `docs/ORBIT-GOAL.md`, `docs/ORBIT-MASTER-PLAN.md`를 먼저 읽고 현재 branch/dirty 상태와 Mac 도구 버전을 확인해라. 전체 Orbit 완성이 목표이며 MVP/일부 Phase 완료로 끝내지 마라. 먼저 인계 코드의 타입·전체 테스트·빌드와 Mac Codex resolver 제약을 확인하고 Task17 Extensions의 미완료 독립 리뷰·브라우저 검증을 마무리해라. 이후 MASTER-PLAN의 미완료 기능을 계속 구현·검증하라. 공식 native 기능을 우선 재사용하고 보안 경계·비용/구독 구분·독립 worktree·동일 검증 기준을 유지해라. 실제 미검증 기능을 완료로 표시하지 마라.

## 최종 인계 검사

- 환경: Windows, Node v24.22.1, Git2.56.0.windows.3.
- 타입 검사 및 제품 빌드: exit 0. 최신 Extensions UI9/9, 신규7th-grant HTTP fixture1/1, 관련 통합53/53(추가nullscope 검사 전) 통과.
- 기본 병렬 전체 검사 두 번: 각각471중470pass/1fail(exit1). 동일 `tests/merge-http.test.ts`에서 fetch ECONNRESET. 테스트를 변경·삭제·재시도 로직으로 숨기지 않았다.
- 해당 merge HTTP 집중 검사:1/1 exit0. 병렬 실행 시에만 이번 오류가 관측됐지만 원인 확정/수정 완료를 주장하지 않는다. Mac에서 기본 `npm run verify`를 다시 실행하고 재현되면 네트워크 연결 수명·동기 Git 작업·병렬 부하를 먼저 조사한다.
- 동일 전체 검사 `node --test --test-concurrency=4 tests/*.test.ts spikes/phase0/*.test.mjs`: **471/471, fail/skip0, exit0**(86.8초). assertion이나 테스트 수를 줄이지 않았다. 기본 병렬 실행의 연결 오류는 별도 미해결로 남는다.
- 최신 Task17 브라우저와 Mac 검증은 미실행. 마지막 완전한 브라우저 증거는 Task16의35/35·43PNG이다.
