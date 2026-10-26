# Orbit 제품 통합 결과

검증일: 2026-10-25. 통합 브랜치: `integration/orbit-20261025104804486-08592a18`. 기준/현재 HEAD: `73ec364`.

**세 모듈의 실제 HTTP·SQLite·React 연결을 구현했다. 최종 TypeScript 검사와 자동 테스트 120/120개는 통과했다. 제품 빌드는 esbuild의 샌드박스 디렉터리 접근 거부로 실패했으므로 빌드 및 실제 브라우저 인수 검증까지 완료했다고 주장하지 않는다.** 변경은 현재 작업 트리에 있으며 커밋·Push·배포하지 않았다.

## 환경과 범위

- Windows 10.0.19045, Node 24.22.1, npm 11.19.1, Git 2.56.0.windows.3, Codex CLI 0.164.0.
- PowerShell의 `npm.ps1`/`codex.ps1`은 실행 정책으로 차단됐다. 정책을 변경하지 않고 기존 `npm.cmd`/`codex.cmd`로 버전을 확인했다.
- 기존 의존성만 사용했다. 패키지 설치, lockfile 변경, Mermaid 런타임 또는 PPTX 라이브러리 추가는 하지 않았다.
- 세 서브에이전트가 Planning / Visualization / Provider 보안과 계약을 읽기 전용 검토했다. 공통 파일과 모든 구현 수정은 메인 에이전트만 수행했다.
- 새로운 Runner, 별도 에이전트 실행기, 개발용 worktree, cherry-pick은 만들지 않았다. 기존 Git 회귀 테스트가 만드는 폐기 가능한 임시 저장소/worktree만 테스트 과정에서 사용했다.
- 기존 애플리케이션을 시작하거나 기존 DB/WAL/SHM을 열지 않았다. 모든 새 영속성 검증은 `:memory:` 또는 OS 임시 디렉터리에 새로 만든 DB에서 수행했다. 인증 파일을 읽거나 수정하지 않았다.

## 구현된 제품 경로

### 공통 계약과 Planning

- `shared/parallel.ts`: Planning, Task, Artifact, architecture, timeline, provider, launch-policy 공통 타입. `tests/parallel-contracts.test.ts`에서 기존 세 모듈과 구조적 호환성을 검사한다.
- `server/planning/repository.ts`: 기존 파서·승인 검증·신뢰된 Task 변환을 재사용하는 SQLite repository. 원문 입력은 별도 열에 보관하며, 정규화된 내용/hash/계보/head/생성 및 승인 시각/승인 주체를 영속화한다.
- 새 버전은 항상 draft. 이전 승인 버전은 승인 증거를 유지한다. 이전 미승인 draft는 superseded. head/revision 비교가 실패하면 409이다.
- `server/studio.ts`: 등록된 프로젝트만 접근 가능. 현재 제품은 단일 로컬 사용자 모델이며, 유효한 로컬 세션을 승인 주체 `local-user`로 기록한다. 다중 사용자 ACL/RBAC를 구현했다고 주장하지 않는다.
- 저장·새 버전 생성·승인·Task 변환·요청 영수증·감사 이벤트를 `BEGIN IMMEDIATE` 트랜잭션에 포함한다. 실패 시 롤백하고 커밋 이후에만 SSE 이벤트를 발행한다.
- Task는 서버의 승인된 저장 버전에서만 생성한다. 재호출과 DB 재시작에도 같은 Task ID를 반환한다. `state=draft`, `verification=not_run`이며 Run 생성이나 코드 실행은 하지 않는다.
- 기존 프로젝트 `writeEnabled`는 변경하지 않는다. 기획/Artifact DB 쓰기는 사용자 프로젝트 파일 쓰기 권한과 별개다.

### HTTP와 React

기존 Host·Origin·세션·CSRF 검사를 그대로 통과한 요청에만 다음 API를 제공한다.

| 경로 | 기능 |
| --- | --- |
| `GET/POST /api/projects/:projectId/plans` | 버전 목록 / 신규 저장 |
| `POST /api/projects/:projectId/plans/:id/revisions` | 새 버전 |
| `POST /api/projects/:projectId/plans/:id/approve` | 저장 버전 승인 |
| `POST /api/projects/:projectId/plans/:id/task-drafts` | Task 영속 생성/복구 |
| `GET /api/projects/:projectId/tasks` | 저장 Task 목록 |
| `GET/POST /api/projects/:projectId/artifacts` | 최신 Artifact 목록 / 신규 저장 |
| `POST /api/projects/:projectId/artifacts/:id/revisions` | Artifact 새 버전 |
| `GET /api/projects/:projectId/artifacts/:id/history` | 불변 버전 이력 |
| `GET /api/providers` | 모의 연결의 실제 지원 상태 |
| `POST /api/providers/mock/send` | 고정 서버 정책으로 합성 요청 검사 |

- 생성 body는 `{requestId,input}`, 새 버전은 `{requestId,expectedRevision,input}`, 승인은 `{expectedRevision}`, Task 변환은 `{}`이다. 알 수 없는 필드와 위조 권한 필드는 거절한다.
- 생성/개정 영수증은 프로젝트·작업·대상·입력 digest와 결과를 원자적으로 저장한다. 같은 ID의 다른 요청은 409. 브라우저는 불확실한 저장의 같은 요청 ID를 유지한다. sessionStorage에는 문서 대신 ID와 SHA-256만 남긴다.
- Studio 저장 경로에만 JSON escape 확장을 고려한 `6 × 256 KiB + 256 KiB` envelope 한도를 적용한다. 기존 실행 경로의 18,000-byte 한도와 원문 256 KiB 한도는 유지한다.
- 프로젝트당 총 200개 기획/Artifact 버전 및 기존 저장량 16 MiB 초과 시 추가 버전 생성을 차단하는 로컬 한도를 둔다. 한도는 승인·기존 Task 생성/복구를 막지 않는다. 입력별 크기 제한도 함께 적용한다.
- `web/studios.tsx`를 메인 UI에 연결했다. Codex 연결/worktree 생성 없이 등록 프로젝트를 선택해 두 Studio를 사용할 수 있다. 저장 Task 목록도 복원한다.
- 탭은 두 편집기를 숨겨서 전환하므로 작성 중 내용과 진행 중 요청을 유지한다. 프로젝트 변경 시에는 기존 계약대로 편집기를 새로 시작한다. 새로고침을 넘는 미저장 원문의 자동 보존 기능은 없다.
- 늦은 목록 응답은 ID/revision 기준으로 합쳐 최신 저장 결과를 지우지 않는다. 지연된 Codex 연결 응답은 generation/cursor 검사로 오래된 화면 상태를 복원하지 못한다.

### Visualization

- 기존 restricted Mermaid parser와 React SVG 미리보기를 그대로 재사용했다. 원시 HTML/SVG 삽입, 네트워크 렌더러, 외부 URL 호출이 없다.
- Mermaid/architecture/presentation source와 metadata를 검증하고, 서버가 Artifact ID/hash/time/revision을 부여한다. 프로젝트 경계와 expected revision을 검사하며 정확한 원문과 과거 버전을 SQLite에 보관한다.
- RunTimeline을 메인 UI에 연결했다. 고정 snapshot anchor에 이후 SSE 이벤트만 재생하고, gap·workspace 변경·재연결 또는 200개 버퍼 한도에서 authoritative reload한다. `completed`를 검증 성공으로 바꾸지 않는다.
- Mermaid는 TD/LR 선언, 명시된 사각형 노드와 방향 간선만 지원한다. 미리보기는 고정 grid이며 전체 Mermaid 문법/자동 layout 엔진이 아니다.
- **실제 PPTX 직렬화·다운로드는 미지원.** 편집 가능한 presentation 구조 생성 기반만 있으며 Export PPTX 버튼은 비활성화했다.

### Provider / Guardrail과 기존 실행 정책

- Bedrock/LiteLLM/vLLM/FreeLLMAPI는 모두 `mock_only`, 코딩 미지원. 고정 인메모리 transport가 합성 응답만 반환한다. 이 네 어댑터의 실제 외부 API 호출은 비활성화했다. 기존 Codex CLI 추론 경로까지 로컬 모델이라는 뜻은 아니다.
- 정책은 서버의 고정 `block` 설정이다. 브라우저가 endpoint/action/transport를 전달해 바꿀 수 없다. 개인정보·인증정보 탐지 거절은 값 대신 고정 코드만 응답/감사 기록에 남긴다.
- Codex 프롬프트도 새 outbound 검사를 통과한 뒤에만 저장/RPC 전송한다. 기존 검출기가 놓치던 JSON API-key, AWS secret assignment와 이메일 패턴의 차단을 추가 검증했다.
- `evaluateLaunch`는 기존 sandbox/MCP 확인의 서버 측 증거와 매 요청 workspace 재검증을 사용한다. RPC 승인 기본 거절, MCP 비활성 검증, child environment, 쓰기 allowlist, Git 경로·diff 정책은 유지한다.
- 개인정보 검출은 제한된 패턴 휴리스틱이다. 포괄적인 DLP, DNS/redirect 보안 검증 또는 실제 외부 모델 연결을 완료했다고 주장하지 않는다.

## 검증 증거

| 명령 / 검사 | 종료 코드 | 결과 |
| --- | ---: | --- |
| `npm.cmd run typecheck` (최종) | 0 | 통합 TypeScript 통과 |
| `npm.cmd test` (최종) | 0 | **120 tests, 120 pass, 0 fail, 0 skipped** |
| `node --test tests/studio-integration.test.ts` (최종 개별 실행) | 0 | 8/8, 실제 loopback HTTP + 임시 SQLite |
| `node --test tests/studio-client.test.ts tests/studio-integration.test.ts` (quota 테스트 추가 전) | 0 | 10/10, 재시도·stale 응답·감사 증거 포함 |
| `node --test tests/studio-ui.test.ts` | 0 | 1/1, TypeScript 변환 + React 정적 렌더링 |
| `node --test tests/parallel-contracts.test.ts tests/controller.test.ts tests/studio-integration.test.ts` (중간) | 0 | 당시 18/18 |
| `node --test tests/provider-guardrail.test.ts` (서브에이전트) | 0 | 16/16 |
| `node --test tests/visualization.test.ts` (서브에이전트) | 0 | 17/17 |
| `node tests/fixtures/visualization/verify-ui-build.mjs` (서브에이전트, 1회) | 1 | esbuild 상위 디렉터리 Access denied |
| `npm.cmd run build` (제품 빌드, 1회) | 1 | 같은 샌드박스 접근 제한으로 entry point 해석 실패 |
| `git diff --check` | 0 | 공백 오류 없음 |

최종 전체 테스트 출력은 작업 트리의 Git-ignored `orbit-final-tests.log`에 있다. 전체 테스트는 위 개별 테스트를 모두 포함한다.

확인한 행위:

- 기획 저장→승인→Task 생성, 같은 요청 재전송, 변경된 요청 충돌, 동시 개정 1승/1충돌, superseded draft 승인 거절, 승인 이력 보존, 재시작 후 Task/버전 복구.
- Artifact 정확한 source/hash/이력 복원, stale revision 및 타 프로젝트 ID 거절, 악성 Mermaid와 알 수 없는 경로/권한 필드 거절.
- 18 KB를 넘는 큰 입력 및 JSON escape된 유효 입력 수용, decoded 256 KiB 초과 거절.
- SQLite trigger로 Task 저장 실패를 유도해 부분 기록/감사 이벤트가 남지 않는지 확인. 이벤트 수신 시 `db.isTransaction=false` 확인.
- 버전 quota가 승인과 기존 Task 복구를 막지 않는지 확인.
- 모의 개인정보 거절, 외부 정책 override 거절, Run 생성 없음. Codex 프롬프트 거절 시 RPC 전송/원문 저장 없음.
- 기존 Codex mock RPC, reconnect/interrupt/lost, 검증 분리, MCP 격리, 승인 거절, 환경변수 격리, worktree 원본 보존, Git pathspec/민감 diff/쓰기 allowlist 회귀.

실패→수정 확인: 최초 타입 검사는 누락된 `shared/parallel.ts`로 종료 1. 최초 Studio HTTP 테스트 4개는 미연결 경로 404로 종료 1. 개인정보 테스트는 거절 누락으로 종료 1. 감사 대상 ID 테스트와 quota 경계 테스트도 수정 전에 실패했다. 수정 후 해당 테스트와 최종 전체 검사가 통과했다. 새 client export를 작성하기 전 테스트 실행에서는 미존재 모듈/export 로딩 실패가 있었으며, 이는 기능 검증 통과로 세지 않았다.

## 남은 인수 검증과 제한

- **제품 빌드 미통과:** `Cannot read directory "../../../../..": Access is denied` / entry point resolve 실패. 명령 반복, 권한 완화, 의존성 재설치 또는 빌드 우회 패치는 하지 않았다. 일반 PowerShell에서 성공 여부를 확인해야 한다.
- 실제 브라우저의 클릭·편집·탭 전환·프로젝트 전환·스크린샷은 미검증이다. 정적 렌더링과 client 상태 함수/HTTP 테스트가 브라우저 E2E를 대체하지는 않는다.
- 이번 세션에서 실제 인증된 Codex 연결/외부 모델 호출은 하지 않았다. 기존 실행 경로의 회귀는 합성 RPC 및 폐기 가능한 Git fixture로 검증했다.
- v1 planning의 nonempty `decisions`는 기존 계약대로 거절하며, 공개 source는 manual/import로 정규화한다. 원본 provenance 입력은 DB 원문에 유지한다.
- 검토에서 확인한 기존 Codex 실행 파일의 상대 경로 허용, legacy credential 거절의 감사 이벤트 누락, `close()` 시 launch 증거 플래그가 남는 정리 사항은 이번 변경으로 확장하지 않았다. 마지막 항목은 RPC 해제/상태 검사로 제출이 차단되며, 실제 승인 우회로 판정되지 않았다.
- SQLite repository 변경은 코드에 포함되어 있으나 기존 사용자 DB에 실제 적용하지 않았다. 일반 `npm start`는 기존 `.local`에 스키마를 만들 수 있으므로 이번 인수 검증은 아래 임시 데이터 위치를 사용한다.

## 일반 PowerShell 재현 명령

현재 통합 작업 트리에서 실행한다. 설치/인증 변경은 필요 없다.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

각 명령 직후 `$LASTEXITCODE`가 0인지 확인한다. 세 단계가 모두 통과하면 다음 한 명령으로도 재검증할 수 있다.

```powershell
npm.cmd run verify
```

기존 DB를 사용하지 않는 브라우저 수동 확인은 **빌드가 성공한 뒤** 다음처럼 별도 임시 실행 디렉터리에서 한다. 원본 프로젝트의 파일 쓰기 권한은 주지 않는다. 기존 서버와 충돌하지 않는 loopback 포트를 선택한다.

```powershell
$orbitSource = (Get-Location).Path
$orbitSmoke = Join-Path ([IO.Path]::GetTempPath()) ('orbit-studio-ui-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $orbitSmoke | Out-Null
Copy-Item -LiteralPath (Join-Path $orbitSource 'dist') -Destination (Join-Path $orbitSmoke 'dist') -Recurse
$orbitOldAllowed = $env:ORBIT_ALLOWED_PROJECTS
$orbitOldPort = $env:AICC_PORT
Push-Location $orbitSmoke
try {
  $env:ORBIT_ALLOWED_PROJECTS = '[]'
  $env:AICC_PORT = '14317'
  node (Join-Path $orbitSource 'server/main.ts')
} finally {
  Pop-Location
  $env:ORBIT_ALLOWED_PROJECTS = $orbitOldAllowed
  $env:AICC_PORT = $orbitOldPort
}
```

`http://127.0.0.1:14317`에서 읽기 전용으로 프로젝트를 등록하고, **Codex 연결/worktree 생성 없이** Studio 프로젝트를 선택한다. 기획 작성→저장→승인→Task 생성, Mermaid 저장→개정→이력 선택을 확인한다. 탭을 오가도 미저장 입력이 유지되는지 확인하고, 새로고침 및 같은 임시 디렉터리로 서버 재시작 후 저장 기록을 확인한다. Provider 탭에서는 합성 이메일이 차단되고 일반 합성 텍스트는 `mock_only`로 처리되는지 확인한다. PPTX 버튼은 비활성 상태여야 한다. 이 수동 절차는 제시한 재현 절차이며 이번 세션에서 실행한 검증으로 집계하지 않았다.
