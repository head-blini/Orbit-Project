# PRODUCT P4/P5/P6 — 구현 및 검증 기록

## 기준과 재개 상태

- 작업 브랜치: `codex/product-p456`, 시작 HEAD `c3f0299`. 시작 시 작업 트리는 깨끗했다.
- `ORBIT-STATUS.md`의 `25ca69b`·`fc0afd1` 등은 과거 통합 체크포인트다. 실제 worktree 기준과 구별했다. 이 문서는 현재 작업의 인계 기록이며, STATUS는 통합 담당 단독 작성 규칙에 따라 수정하지 않았다.
- 기준: `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md`, `ORBIT-PRODUCT-ACCEPTANCE.md`, `ORBIT-CQG-D1.md`. 최신 상단 재개 참조인 GPT 보류 결정도 확인했다.
- 설치된 Graphify의 로컬 query로 관련 호출 관계를 확인했다. 그래프의 과거 행 번호는 실제 코드와 대조했다.
- 구현 완료와 제품 실사용 승인·라이브 E2E를 구별한다. A13 전체를 실사용 검증 완료로 승격하지 않는다.

## 변경 파일과 동작

- `server/deliverables.ts`: P2 바이트 읽기 재사용. 다운로드 전용 출력 경계와 응답 헤더 추가. 원래 목록·미리보기·수치 검사는 유지한다.
- `server/deliverable-versions.ts` (신규): append-only SQLite 메타데이터, 프로젝트/결과물별 조회, 현재 또는 기존 worker 공간의 보존된 바이트 재검사. UPDATE/DELETE는 트리거로 차단한다. 바이트 저장소는 추가하지 않았다.
- `server/controller.ts`: 출력 파일에 프로젝트별 opaque ID를 부여한다. 실행 종료 관측 및 명시적 관측 쓰기를 연결한다. 파일명만으로 생성 실행을 추정하지 않는다.
- `server/http.ts`: 인증된 다운로드·버전 조회 GET, Origin/CSRF 보호 관측 POST, Goal의 기존 progress reader 연결.
- `shared/deliverables.ts`, `shared/goals.ts`: 버전·완료 참조 계약과 완료 표시 하향 가드.
- `server/goal-service.ts`: 현재 승인 기획에 연결된 모든 작업의 최신 CQG 판정 및 근거 참조. 다른 프로젝트/실행의 결과물 참조 제외. 읽기는 DB 변경·모델 실행·검증 실행을 하지 않는다.
- `web/deliverables.tsx`: `파일 받기`, `이전 버전 보기`, `파일 변경 확인`. 보존되지 않은 버전은 다운로드 불가로 표시한다.
- `web/goals.tsx`: 결과물 버전 및 gate/독립 검토/승인 근거 ID를 읽기 전용으로 표시한다. 추적 상태와 작업 검증 완료를 구별한다.
- 테스트: `tests/deliverable-versions.test.ts` (신규), `tests/deliverables-route.test.ts` (신규), `tests/deliverables-http.test.ts`, `tests/deliverables-ui.test.ts`, `tests/goals.test.ts`, `tests/goals-ui.test.ts`.

## 다운로드 보안 경계

- 공통 HTTP 세션·Host·Origin·Referer·Sec-Fetch-Site 검사 뒤에만 경로가 실행된다. GET은 기존 패턴대로 CSRF 토큰을 요구하지 않으며 데이터를 기록하지 않는다.
- 관측 POST는 기존 Origin/CSRF 검사를 통과해야 하며 body는 정확히 `{}`여야 한다.
- GET 경로는 프로젝트 ID, 64자리 opaque 결과물 ID, 선택적 버전 UUID만 허용한다. query parameter는 모두 거부한다. 기존 preview의 path 계약은 그대로이며 다운로드에서는 사용하지 않는다.
- 서버가 프로젝트 소유권을 확인하고 결과물 ID를 출력 목록에 매핑한다. 입력 자료에는 다운로드 ID가 없다.
- `readOutputDeliverable`은 입력 경로, traversal/정규화 alias, 루트 alias, symlink, hardlink를 거부한다. P2의 `O_NOFOLLOW`, dev/ino 재검사, 깊이·32 MiB 크기 제한을 재사용한다. 읽기 전후 루트/파일 identity와 수정 시각도 비교한다.
- 과거 버전은 SHA256·크기가 기록과 일치해야 한다. worker 공간 fallback은 기존 reservation/manifest/공간 identity 검증을 통과해야 한다. 다른 경로를 탐색하거나 새 파일을 복제하지 않는다.
- ASCII 안전 파일명과 `Content-Disposition: attachment`, MIME allowlist, `nosniff`를 사용한다. HTML·SVG·미지원 형식은 `application/octet-stream`이다.

## 보수적 기본값과 열린 질문

1. 기록 시점은 `run.completed`와 사용자의 `파일 변경 확인`이다. GET은 영속 기록을 추가하지 않는다. 파일 watcher는 추가하지 않았다. 두 관측 사이에 생성·덮어쓴 미관측 버전은 복원할 수 없다. 더 촘촘한 관측 시점이 필요한지는 후속 결정 사항이다.
2. 생성 task/run/time은 현재 바이트와 일치하는 유일한 검증된 worker manifest가 있을 때만 기록한다. manifest 없는 단독 실행·수동 파일·출처가 모호한 동일 바이트는 `null`이다. 이러한 파일도 다운로드·버전 관측은 가능하지만 Goal에 추정 연결하지 않는다. 단독 실행의 신뢰 가능한 산출물 manifest 확장은 후속 범위다.
3. `runAt`은 run record의 `updatedAt`, `observedAt`은 관측 시각이다. mtime을 생성 시각으로 승격하지 않는다. 바이트가 같고 생성 run도 같으면 중복 관측을 추가하지 않는다. 바이트 또는 확인된 생성 run이 바뀌면 새 기록을 추가한다.
4. 기존 worker 저장소 정리 정책은 바꾸지 않았다. 바이트 보존 기간과 영구 버전 보존은 미결정이다. 바이트가 없어지면 메타데이터는 남고 다운로드는 거부한다.
5. Goal의 요구사항 수용 판정은 기존 `unverified` 계약을 유지한다. 별도의 연결 작업 완료는 모든 관련 작업이 현재 CQG `verifiedDone`이어야 한다. 필수 gate의 mock/unknown/stale, 최신 run 불일치, 기획 변경, 누락된 작업은 완료를 차단한다. 정책상 필수가 아닌 미실행 독립 검토/사용자 승인을 완료라고 표시하지 않는다.

## 실제 검증

환경: Darwin, Node `v24.22.1`. PATH 맨 앞은 `/Users/DKLEE/.local/share/fnm/node-versions/v24.22.1/installation/bin`.

- `npx tsc --noEmit`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0.
- 아래 제한된 테스트 실행: **106개, 92 pass, 14 fail, 0 skip**, exit 1. 14개 실패는 모두 `listen EPERM: operation not permitted 127.0.0.1`이다. 테스트를 skip 처리하거나 약화하지 않았다.

```sh
node --test tests/deliverable-versions.test.ts tests/deliverables*.test.ts tests/goals*.test.ts tests/http*.test.ts tests/controller.test.ts tests/quality-loop-controller.test.ts tests/project-progress.test.ts tests/project-progress-service.test.ts
```

리스너 차단 파일: `tests/deliverables-http.test.ts` (2개), `tests/goals-http.test.ts` (1개), `tests/http-keepalive.test.ts` (1개), `tests/http.test.ts` (10개).

통과한 `tests/deliverables-route.test.ts`는 실제 HTTP handler를 소켓 없이 호출한다. 세션·Host/Origin·cross-site·CSRF·정확한 필드·프로젝트 격리·입력 파일 거부·symlink/hardlink·크기 제한·응답 헤더·버전 변경·GET 무기록을 검사한다. 라이브 리스너 검증을 대신했다고 주장하지 않는다.

추가 통과 근거: 기존 worker 저장소의 이전 바이트 다운로드/변조 거부, DB 재시작, append-only, 생성 실행/시각 참조, 모든 연결 작업 조건, mock/unknown/stale 하향, UI SSR 렌더링. 테스트의 완료 증거는 fixture이며 실제 모델 검증이 아니다.

최종 테스트 로그: `/private/tmp/orbit-p456-final-tests.log`. 전체 suite, 브라우저 E2E, 외부 연결, 실제 모델/provider 호출은 실행하지 않았다. 커밋·설치·push·merge·배포 없음.

다음 통합 담당 작업: 변경 검토 후 리스너 허용 환경에서 위 14개 테스트 재실행, 현재 HEAD에서 A13/UI 실사용 검증, STATUS 갱신. 공유 파일 lock 해제/통합은 오케스트레이터가 관리한다.
