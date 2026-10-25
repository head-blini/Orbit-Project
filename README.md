# Orbit — 로컬 프로젝트와 격리된 Codex 작업 공간

기존 ChatGPT 로그인으로 Codex를 연결하고, 로컬 Git 프로젝트를 별도 worktree에서 수정한 뒤 웹에서 변경 파일과 Git Diff를 검토하는 개발용 앱입니다. Phase 1의 스트리밍·중단·세션 복구를 유지합니다. 제품 표시명은 **Orbit**이며 기존 폴더·DB·환경변수·개발 브랜치 이름은 유지합니다.

**기본값은 프로젝트 쓰기 잠금**입니다. 등록만으로 쓰기를 허용하지 않습니다. 검증한 정확한 저장소 경로를 서버에서 허용해야 새 작업 공간을 만들고 코딩 세션에 연결할 수 있습니다. 현재 코딩 도구는 `apply_patch`이며 shell·설치·테스트 실행기는 제공하지 않습니다.

## 실행

필요 환경: Windows, Node.js **24.x**, npm, Git, 이미 설치된 Codex CLI. 검증한 Codex 버전은 **0.164.0**입니다. 별도 OpenAI API 키는 사용하지 않습니다.

일반 사용자 PowerShell에서 프로젝트 폴더로 이동한 뒤:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

브라우저에서 **http://127.0.0.1:4317** 을 엽니다. `localhost`나 LAN 주소는 허용하지 않습니다. 종료는 서버 터미널에서 **Ctrl+C**입니다.

```powershell
# 빌드 후 실행을 한 번에 (자동 hot reload는 없음)
npm.cmd run dev

# 타입 검사 + 오프라인 테스트 + 빌드
npm.cmd run verify

# 별도 인증이나 추론 없이 설치된 native Codex의 MCP 시작 차단 확인
node scripts/verify-mcp-isolation.mjs

# 코딩 모드의 MCP 격리 검사 (자격증명/추론 없음)
node scripts/verify-mcp-isolation.mjs --coding

# 기존 ChatGPT 인증 인식 확인 (추론·토큰 갱신 요청·인증정보 출력 없음)
node scripts/verify-auth-environment.mjs

# 실제 Codex 파일 수정 + Git Diff 검사 (새 임시 저장소, 기존 구독 사용량 발생)
node scripts/verify-worktree.mjs
```

PowerShell 실행 정책 때문에 `npm.ps1`/`codex.ps1`이 막힐 수 있으므로 `.cmd` 진입점을 사용합니다. 실행 정책 변경은 필요 없습니다. Codex 로그인 여부는 `codex.cmd login status`로 확인하고, 로그인이 필요하면 사용자가 터미널에서 `codex.cmd login`을 실행해 **ChatGPT 로그인**을 선택합니다. 앱은 로그인 폼이나 토큰을 받지 않습니다.

## 사용 흐름

1. 커밋이 있는 로컬 Git 저장소의 **절대 경로**를 입력하고 **프로젝트 등록**을 누릅니다. 등록은 파일을 수정하지 않습니다. 저장소 루트만 받으며 bare 저장소·외부 gitdir·submodule·symlink/junction·checkout filter/include 설정은 거절합니다.
2. 임시 저장소로 위 검증을 먼저 수행합니다. 실제 프로젝트 사용은 필요한 경로만 아래 서버 허용 목록에 넣은 뒤 재시작합니다. 이 설정을 웹에서 변경하는 기능은 없습니다.
3. **새 작업 공간 만들기**를 누릅니다. 현재 커밋 HEAD에서 서버가 생성한 `orbit/<UUID>` 브랜치와 `.local/workspaces/<UUID>` worktree를 만들고 선택합니다. 원본의 미커밋 변경은 복사하지 않으며 원본 main/master를 checkout하거나 수정하지 않습니다.
4. **실행할 작업 공간**을 선택한 뒤 **Codex 연결 / 세션 이어받기**를 누릅니다. 각 worktree에는 별도 thread와 실행 기록이 있습니다. 연결·실행 중에는 다른 공간으로 전환할 수 없습니다.
5. 수정할 파일과 구체적인 패치 내용을 프롬프트에 지정합니다. 예: `apply_patch로 greeting.ts의 "before"를 "Orbit"으로 바꿔줘.` 현재 shell이 꺼져 있으므로 코드 탐색·명령 실행이 필요한 작업은 수행하지 못할 수 있습니다.
6. 응답 후 **변경 파일**을 선택해 **Git Diff**를 검토합니다. 기준 커밋 대비 현재 파일, staged 변경, 미추적 파일을 포함합니다. 수동 **Diff 새로고침**도 가능합니다. 민감 파일·바이너리·큰 파일은 내용을 표시하지 않습니다.
7. **실행 중단**은 요청 수락 후 실제 interrupted 이벤트가 도착해야 **중단됨**으로 바뀝니다. 중단·실패·연결 유실 시 worktree와 변경 파일은 보존합니다. 자동 삭제·커밋·병합·배포는 없습니다.
8. 새로고침은 상태와 기록을 복원하며 프롬프트를 재전송하지 않습니다. 서버 재시작 후에도 선택·기록·Diff는 보존되고 **세션 이어받기**로 연결합니다. 불확실한 실행은 `연결 유실 · 결과 미확인`으로 남습니다.

검증 후 특정 프로젝트만 허용하는 PowerShell 예시:

```powershell
# 정확한 저장소 루트만 지정. 홈·드라이브 루트·상위 디렉터리를 허용하지 않습니다.
$env:ORBIT_ALLOWED_PROJECTS = ConvertTo-Json -Compress -InputObject @('C:\Projects\my-project')
npm.cmd start

# 서버 종료 후 허용 목록을 제거하면 기존 worktree의 새 실행도 차단합니다.
Remove-Item Env:ORBIT_ALLOWED_PROJECTS
```

허용 목록은 Git 저장소 소유권 검사를 우회하지 않습니다. 서버를 저장소 소유자와 같은 일반 사용자로 실행하세요. `safe.directory=*`, 관리자 실행, 보안 설정 완화는 필요 없습니다. 프로젝트를 선택하지 않으면 기존 Phase 1 읽기 전용 테스트 세션을 사용할 수 있습니다.

응답 완료는 코드 검증 성공을 뜻하지 않습니다. 이 버전에는 검증 실행기가 없으므로 모든 Run의 **검증 상태는 미검증(`not_run`)**입니다. 새 Run은 이전 Run의 검증 상태를 바꾸지 않습니다.

## 데이터와 보안 경계

Codex 자식 프로세스에는 OS 실행·임시 디렉터리·기존 인증 위치 탐색·locale에 필요한 환경변수만 전달합니다. `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME` 등은 유지하고, API 키·클라우드/GitHub 토큰·알 수 없는 변수·`NODE_OPTIONS`·Git 설정·Orbit 서버 설정·프록시/endpoint/CA 재정의는 제외합니다. Windows 이름은 대소문자를 구분하지 않으며 충돌하는 별칭은 연결을 차단합니다. 인증 파일을 복사하거나 사용자 설정을 수정하지 않습니다. 사용자 지정 프록시/CA가 필요한 환경은 아직 검증하지 않았으며, 연결 실패 시 전체 환경 상속으로 우회하지 마세요. 이 제한은 파일 시스템 샌드박스를 대체하지 않습니다.

- HTTP는 코드에서 **127.0.0.1에 고정 바인딩**합니다. 정확한 Host/Origin, HttpOnly SameSite=Strict 세션 쿠키, CSRF 토큰, JSON 크기 제한, CSP를 사용합니다. 인증은 외부 원격 사용자를 위한 로그인 기능이 아니며, 동일 OS 사용자에게서 서버를 격리하는 수단도 아닙니다.
- 서버만 Codex App Server의 **stdio**를 소유합니다. 계정 응답은 ChatGPT 로그인 여부 확인에만 쓰며 이메일·토큰·인증 파일·원문 RPC·stderr를 브라우저나 앱 DB에 저장하지 않습니다.
- 기존 테스트 세션은 `read-only + untrusted`, 코딩 세션은 `workspace-write + on-request`, 검토자는 모두 `user`입니다. **도착한 승인 요청은 종류와 관계없이 기본 거절**합니다. 승인 허용/무조건 승인 UI는 없습니다. 코딩 세션의 정상 내부 패치는 sandbox 안에서 실행되며, 추가 경로·네트워크 권한 요청은 허용하지 않습니다.
- **MCP 격리:** 세션 생성·이어받기 전에 `config/read`로 유효 설정의 MCP 이름만 추출하고, 각 서버에 `enabled=false`를 요청별로 적용합니다. 기존 사용자 설정 파일은 수정하지 않습니다. 이후 해당 세션의 목록에서 알려진 서버가 명시적으로 `disabled`이고 도구가 없거나 목록이 비어 있을 때만 연결을 허용합니다. 설정 조회 실패, 모르는 서버, 상태 미확인, 도구 노출, 페이지 누락은 연결 차단으로 처리합니다. 앱·플러그인·hooks·shell·browser 등은 프로세스 옵션으로 비활성화합니다.
- 반환된 샌드박스·승인 정책을 확인합니다. 코딩 모드는 추가 writable roots가 비어 있고 networkAccess=false, excludeTmpdirEnvVar=true, excludeSlashTmp=true여야 합니다. 선택한 worktree만 cwd로 전달합니다. 코딩에 필요한 로컬 `code_mode_host`만 활성화하며 shell·code_mode·MCP·플러그인 등 제한은 유지합니다. `.git` 및 worktree의 `.codex/.agents/.aws` 디렉터리를 보호하며 사용자 설정 파일은 변경하지 않습니다.
- 연결 중 다른 프로그램에서 Codex 설정이나 작업 공간을 수정하지 마세요. 매 동작 전 경로·links·브랜치·HEAD를 재검증하지만 같은 OS 사용자의 동시 파일 교체를 원자적으로 방지하는 기능은 없습니다. 작업 공간 자체가 일반 사용자/다른 프로그램으로부터 격리된 VM은 아닙니다.
- Git은 shell 없이 인자 배열로 실행합니다. 서버가 생성한 브랜치/ID와 검증한 SHA만 사용하고 hooks·fsmonitor·외부 diff·textconv·submodule 재귀를 차단합니다. checkout 필터와 include 설정, link/hardlink, 특수 Windows 경로는 거절합니다. 대규모 저장소는 50,000개 항목 검사 한도, Diff는 200개 파일·파일당 128KB·합계 512KB 한도로 제한합니다.
- Git 실행 파일은 서버의 절대 PATH에서 한 번 결정합니다. 저장소 내부 `git.exe`를 실행하지 않습니다. literal pathspec으로 특수문자 파일명도 정확히 지정하며, promisor/partial clone과 지연 가져오기·전송 프로토콜은 차단합니다. 프롬프트 요청에는 예상 작업 공간 ID를 포함하고 현재 선택과 다르면 실행 전에 거절합니다. 다른 탭의 선택 변경은 전체 상태를 다시 동기화합니다.
- 대화 텍스트와 정규화 이벤트는 **`.local/control-center.sqlite`**에 남습니다. `.local/`, 원본 Phase 0 evidence, node_modules, 빌드 결과는 Git에서 제외됩니다. 입력한 일반 텍스트는 모델에 전달되고 로컬 기록에도 남으므로 민감한 내용을 입력하지 마세요. 알려진 키/토큰 패턴은 거절 또는 가림 처리하지만 임의의 모든 비밀을 판별하는 기능은 아닙니다.
- 프로젝트 경로·worktree·thread·Run 관계와 정규화 이벤트를 기존 SQLite에 추가 저장합니다. 파일 변경 이벤트는 작업 공간 ID와 상태만 저장합니다. 원문 diff·도구 출력·명령 문자열·임의 이벤트 payload는 DB에 수집하지 않습니다. CLI가 자체적으로 보존하는 세션 데이터는 Codex가 관리합니다.
- 앱 자체는 로컬이지만 모델 응답에는 기존 Codex의 OpenAI 서비스 연결과 **기존 구독 사용량**이 필요합니다. 일반 OpenAI API 종량 과금으로 자동 전환하지 않습니다.

## 설정과 문제 해결

`AICC_PORT`로 포트를 바꿀 수 있습니다(1024–65535). 바인딩 주소는 바뀌지 않습니다.

```powershell
$env:AICC_PORT = '4318'
npm.cmd start
```

Windows PATH에서 설치된 native `codex.exe`를 찾습니다. npm 글로벌 설치의 플랫폼 패키지도 탐지합니다. 다른 설치 방식이면 실행 파일 경로를 서버 환경변수로 지정할 수 있습니다. **브라우저에서 이 값을 설정할 수는 없습니다.**

```powershell
$env:AICC_CODEX_BIN = 'C:\실제\설치경로\codex.exe'
npm.cmd start
```

- **홈 디렉터리 오류:** Codex가 로그인된 일반 사용자 터미널에서 실행하세요. 샌드박스·서비스 계정·다른 사용자 환경에서는 기존 인증에 접근하지 못할 수 있습니다. 인증 파일을 복사하지 마세요.
- **이미 실행 중:** 이 데이터 디렉터리를 사용하는 서버는 한 개만 실행할 수 있습니다. 다른 포트를 지정해도 기존 인스턴스 종료가 먼저입니다. 별도 SQLite 잠금은 프로세스 crash 시 OS가 해제합니다.
- **MCP 격리 차단:** 현재 검증 버전은 Codex 0.164.0입니다. 설정 조회·비활성 상태 확인이 지원되지 않거나 강제 MCP 정책이 적용되면 실행을 허용하지 않습니다. 사용자 MCP 설정을 지우거나 승인 정책을 완화하지 말고, 차단 상태를 유지한 채 버전·관리 정책을 확인하세요.
- **정책 불일치:** 반환된 샌드박스·네트워크·승인 정책 중 하나가 다르면 연결을 차단합니다. 이 앱을 위해 권한을 확대하거나 자동 승인으로 바꾸지 마세요.
- **WRITES_DISABLED:** 해당 프로젝트의 정확한 canonical 경로가 서버 허용 목록에 없습니다. 기존 worktree와 Diff는 남으며 새로운 실행은 막힙니다.
- **GIT_OPERATION_FAILED:** 유효한 HEAD, Git 설치, 저장소 소유권·접근 권한을 확인하세요. 설정·인증을 노출할 수 있는 원문 Git stderr는 웹에 반환하지 않습니다. 소유권이 다르면 같은 사용자로 새 테스트 저장소를 만들며 Git의 안전 검사를 끄지 않습니다.
- **LINK_REJECTED / UNSUPPORTED_TREE / GIT_CONFIG_REJECTED:** 링크·submodule·checkout helper·설정 include 등이 있는 저장소는 이 단계에서 지원하지 않습니다. 원본을 자동 수정하지 않습니다.
- **WORKSPACE_CHANGED:** 저장한 브랜치·HEAD·보호 디렉터리와 실제 상태가 다릅니다. 기존 공간을 삭제하거나 reset하지 말고 변경 내용을 보존한 채 확인하세요. 다른 세션과 동시 수정하지 마세요.
- **연결만 하고 종료한 빈 세션:** 실제 turn이 없는 thread는 Codex가 저장하지 않을 수 있습니다. 이 경우 이어받기는 실패하며 자동으로 다른 세션이나 프롬프트를 만들지 않습니다. 아래 백업 절차로 별도 데이터 디렉터리를 만들 수 있습니다.
- **임시 저장소가 삭제/변경됨:** 기존 Phase 1 테스트 저장소의 변경 여부를 확인하세요. `.local`에는 실제 worktree도 들어 있으므로 통째로 이동하거나 지우지 마세요. worktree 경로를 이동하면 Git 연결이 깨질 수 있습니다. 종료 후 백업 복사본을 보관하고 오류 원인을 확인하세요.
- **전송 결과 미확인:** 자동 재전송하지 않습니다. 기록을 확인하고 화면의 확인 버튼을 누른 뒤 새 입력을 작성하세요. 서버는 동일 request ID에 대해 새 turn을 만들지 않습니다.
- **빌드 접근 거부:** 일반 사용자 터미널에서 `npm.cmd run build`를 실행하세요. 이 개발 세션의 제한된 샌드박스에서는 esbuild의 상위 디렉터리 탐색이 차단됐습니다.

## 파일 구성

| 경로 | 역할 |
|---|---|
| `server/main.ts`, `instance.ts` | 시작·종료, 단일 인스턴스 소유권 |
| `server/http.ts` | 보안 경계, REST, SSE 재전송, 정적 자산 |
| `server/controller.ts`, `rpc.ts`, `codex.ts` | Codex 연결과 Run 상태, 기본 거절 |
| `server/store.ts`, `privacy.ts`, `workspace.ts` | SQLite, 텍스트 필터, 임시 저장소 검사 |
| `server/projects.ts` | 프로젝트 경로 검증, 쓰기 허용 목록, Git worktree와 Diff |
| `shared/types.ts` | UI와 서버의 실행·검증 상태 계약 |
| `web/` | React 최소 UI |
| `tests/` | 오프라인 회귀·통합 테스트 |
| `spikes/phase0/` | 보존된 원래 스파이크 및 추가 실서비스 검증 코드 |

이번 범위는 **Phase 2-A**입니다. 계획 승인/Task 변환, 테스트 실행기, 승인 허용 UI, 다른 제공자, 코드 그래프, Visualization Studio, 공개 서버, 자동 병합·배포는 포함하지 않습니다. macOS/Linux/WSL 및 다른 Codex 버전은 미검증입니다. 실제 사용자 프로젝트는 이 작업에서 등록하거나 쓰기를 활성화하지 않았습니다.

현재 시험과 한계는 [docs/PHASE2A-RESULTS.md](docs/PHASE2A-RESULTS.md), 구현 계획은 [docs/PHASE2A-PLAN.md](docs/PHASE2A-PLAN.md)를 참고하세요. 이전 결과는 [docs/PHASE1-RESULTS.md](docs/PHASE1-RESULTS.md)에 보존합니다.
