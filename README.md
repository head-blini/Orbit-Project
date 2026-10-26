# Orbit — 로컬 프로젝트와 격리된 Codex 작업 공간

**Mac 개발 인계:** [2026-10-26 이어받기 문서](docs/HANDOFF-MAC-2026-10-26.md)에서 브랜치·검증 상태·미완료 작업·Mac 실행 제약을 먼저 확인하세요. 전체 Goal 원문은 [ORBIT-GOAL.md](docs/ORBIT-GOAL.md)에 보존했습니다.

기획을 승인해 Task로 만들고, 기존 ChatGPT 로그인의 Codex로 격리 worktree를 수정한 뒤 실제 명령 검증·변경 승인·시각화 결과물을 관리하는 로컬 개발용 앱입니다. 스트리밍·중단·세션 복구를 지원하며, 전체 플랫폼은 계속 구현 중입니다. 제품 표시명은 **Orbit**이며 기존 폴더·DB·환경변수·개발 브랜치 이름은 유지합니다.

**기본값은 프로젝트 쓰기 잠금**입니다. 등록만으로 쓰기를 허용하지 않습니다. 검증한 정확한 저장소 경로를 서버에서 허용해야 새 작업 공간을 만들고 코딩 세션에 연결할 수 있습니다. Codex 코딩 도구는 `apply_patch`이며 shell·설치는 차단합니다. 별도 검증 명령은 서버 설정과 사용자의 명시적인 실행 승인이 필요합니다.

## 실행

필요 환경: Windows 또는 macOS, Node.js **24.x**, npm, Git. AI 실행에는 이미 설치·로그인된 Codex CLI가 필요하며 기획·시각화·소스 분석은 AI 없이 사용할 수 있습니다. 기존 Windows live 검증 버전은 **0.164.0-alpha.11.1**입니다. Mac은 **0.162.1** native 탐색·제한 옵션·stable schema와 로컬 계약/브라우저를 검증했으며 Mac의 실제 모델 실행은 미검증입니다. 별도 OpenAI API 키는 사용하지 않습니다.

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

응답 완료는 코드 검증 성공을 뜻하지 않습니다. Run의 `not_run`은 Check 기록 없음, `recorded`는 별도 Check 기록이 있다는 뜻이며 통과를 의미하지 않습니다. 실제 exit·소스 해시·판정과 사용자 승인은 Development에서 확인합니다.

## 통합 기능과 현재 한계 (2026-10-26)

- **기획 스튜디오:** 저장·승인·Task 생성 뒤 선택한 worktree에서 Task를 실행합니다. 현재 승인 버전·미해결 질문·제약을 서버에서 확인하며 AI 없이도 기획을 저장할 수 있습니다. 저장 버전은 Markdown/JSON v1으로 내보내 다시 가져올 수 있습니다. Task/Run을 선택하면 상태·체크·현재 승인·변경 파일 목록의 수동 인계용 피드백을 생성합니다. 원문 코드·패치·명령·모델 응답·실행 로그는 제외하며 외부 서비스에 자동 전송하지 않습니다. 새 기획안은 별도 초안으로 검토·승인합니다.
- **Codex 기획 제안(선택):** Planning에서 등록한 격리 작업 공간을 선택하고 요청 미리보기 → 별도 동의 → 검증된 제안 확인 → 새 초안 저장 순서로 사용합니다. 공식 stable `turn/start outputSchema`의 최종 응답만 검사하며 제안 완료는 기획 승인·Task·Run을 만들지 않습니다. 원문 요청은 Orbit 이력에 저장하지 않고 영수증/digest와 검증된 결과만 보존합니다. 읽기 전용 Native CLI도 파일을 읽을 수 있으며 컨텍스트 로딩·보존·제공자 전송은 Model Hub 게이트웨이 밖입니다. 1 turn/60초와 종료 관찰을 사용하고 재시작 또는 종료 미확인 작업은 별도 종료 확인 후 복구합니다. 실제 모델 호출은 미검증이며 로컬 fake RPC 검증과 구분합니다.
- **시각화 스튜디오:** 저장된 Artifact를 실제 편집 가능한 PPTX와 Markdown으로 내보냅니다. ZIP/XML·편집 후 재저장·HTTP 파일 생성과 실제 제품 버튼의 브라우저 파일 저장을 검증했습니다. 자동화 도구의 `download` 명령 취소와 정상 `click` 저장을 구분한 증거는 [다운로드 결과](docs/visualization/DOWNLOAD-RESULTS.md)에 있습니다. PowerPoint GUI는 미검증입니다.
- **모델 제공자 / 확장 기능:** Capability Registry에서 공식 지원·현재 연결·정책 제한을 구분합니다. CLI 버전 진단은 native 실행 파일의 `--version`만 호출합니다. 인증·모델 요청·확장 설치는 수행하지 않으며 PATH 미발견을 설치 없음으로 단정하지 않습니다.
- **에이전트 센터:** Solo는 기존 Codex 실행 경로입니다. Cross Review, Debate, Race, Cooperate, Goal은 설계·검증 계약만 있고 executor가 미연결입니다. 기존 hooks/MCP/plugins/subagents 제한은 유지합니다.
- Development는 서버에 등록한 실제 로컬 명령의 승인·실행·중단·결과와 변경 리뷰 승인을 제공합니다. HTTP Model Hub는 서버 설정·명시 승인·로컬 mock 계약으로 연결하며 Claude와 외부 제공자 실서비스는 미검증입니다.
- **Native Review:** Development에서 현재 정제 Diff의 정확한 전송 본문·소스/입력 digest를 미리 보고 별도로 동의하면 공식 Codex `review/start`를 별도 읽기 전용 세션에서 실행합니다. 기존 ChatGPT 로그인을 확인하고 MCP·sandbox·승인 정책을 다시 검사합니다. 1개 turn·60초 제한이며 종료 관찰에 추가 시간이 걸릴 수 있습니다. 도구 실행·파일 변경을 허용하지 않고, 최종 review item과 완료 turn이 일치해야 결과를 보존합니다. 실제 Codex 리뷰 호출은 미검증이며 로컬 fake RPC 계약과 별도로 분류합니다.
- 리뷰 중 소스 변경은 stale, 프로세스 종료 미확인은 lost로 표시합니다. 재시작 후 자동 재전송하지 않으며 미확정 작업 공간은 이전 프로세스 종료 확인 뒤 **리뷰 복구**로 해제합니다. 해당 기록은 lost로 남습니다. AI 리뷰 완료는 테스트 통과·사용자 리뷰 승인·병합이 아닙니다. 이 기능은 수동 리뷰 primitive이며 전체 Cross Review executor가 아닙니다.
- 정제 Diff에 생략된 파일·binary·큰 패치·알려진 개인정보가 있으면 전체 리뷰 입력을 거절합니다. raw Git patch가 64,000자를 넘으면 마스킹 전에 too_large로 제외해 부분 Diff가 완료된 입력처럼 보이지 않게 합니다. Orbit 이력에는 입력 digest와 정제된 결과를 보존하며 전송 본문을 별도 필드에 저장하지 않습니다. Native CLI의 세션 저장·제공자 전송은 Model Hub 게이트웨이 통제 범위 밖이며 구독 잔여량·토큰·과금 상한을 보장하지 않습니다.
- **승인 기반 병합:** Development에서 현재 검증·리뷰 승인이 있는 변경의 후보를 먼저 만들고, 대상 branch/HEAD와 후보 commit을 확인한 뒤 별도로 반영합니다. 초기 범위는 source의 base와 HEAD가 같은 clean primary branch의 fast-forward입니다. 원 source worktree의 HEAD·index·파일은 보존합니다. 변경·검증 설정·승인·대상 HEAD가 바뀌면 후보를 그대로 반영하지 않습니다. 원격 push는 수행하지 않습니다.
- 병합 대상의 dirty/untracked·ignored 충돌·Git 작업/lock·외부 ignore·변환 attributes/filter·sparse 등 지원하지 않는 상태는 거절합니다. 자동 stash·reset·rollback·재시도는 하지 않습니다. 실패 또는 재시작으로 `lost/unknown`이면 프로젝트의 쓰기를 보류하고, 사용자가 이전 프로세스 종료를 확인한 뒤 **상태 재확인**으로 실제 Git/파일 상태만 관찰합니다. 원래 상태면 실패, 후보의 전체 bytes/index/HEAD가 일치하면 반영 완료, 그 밖에는 미확정으로 유지합니다. 실패한 후보 branch/commit은 복구를 위해 남깁니다. 외부 Git/편집기와 완전한 원자성은 보장하지 않습니다.
- **소스 그래프:** Development에서 현재 worktree를 명시 분석해 JS/TS 파일·함수·클래스·호출·상속과 잠재 변경 영향을 탐색합니다. 설치된 TypeScript 5.9.3 분석기를 런타임에도 재사용하며 새 프레임워크를 설치하지 않습니다. 저장소의 tsconfig·플러그인·코드를 실행하지 않습니다. 최대 100개 JS/TS 파일·파일당 256 KiB·합계 4 MiB이며 민감 경로·링크·불완전한 UTF-8·분석 실패는 거절합니다. 소스 원문은 저장하지 않고 코드 미리보기만 패턴 가림 후 반환합니다.
- 그래프는 Git-visible 소스 해시에 연결되고 SQLite에서 복구됩니다. **그래프 상태 새로고침**으로 현재성을 확인합니다. 파일 import 다이어그램을 Artifact로 저장한 뒤 시각화의 **저장 기록 다시 불러오기**로 열 수 있습니다. 소스 변경은 과거 분석으로, Artifact 원문 수동 수정은 연결 미확인으로 표시합니다. ignored 의존성·동적 호출·외부 패키지·다른 언어의 영향은 증명하지 않습니다. 기록은 worktree당 40개·16 MiB 한도로 보존하고 자동 삭제하지 않습니다.
- **사용량:** ready Codex 연결에서 사용자가 조회할 때 공식 계정 quota/토큰 API를 읽습니다. 계정 전체와 작업별 집계를 구분하고 API 비용·알 수 없는 값은 unknown으로 유지합니다. 실제 조회의 `available` 상태는 확인했지만 다른 제공자와 작업별 비용 집계는 미연결입니다.

### HTTP Model Provider Hub 설정

기본 `ORBIT_MODEL_HUB`는 빈 목록입니다. 서버 시작과 화면 조회만으로 제공자에 연결하지 않습니다. 설정된 목적지와 등록된 프로젝트 경로가 정확히 일치할 때 **모델 목록 조회 승인 → 모델 선택 → 본문·목적지·과금 가능성 확인 → 전송** 순서로 사용합니다. Codex의 ChatGPT 구독과 별도 경로이며 코드 실행 도구를 제공하지 않습니다.

다음은 **비활성 형식 예시**입니다. 실제 서버나 모델이 있다는 의미가 아닙니다. 기존에 사용하는 endpoint·모델·프로젝트 경로를 확인한 후 필요한 항목만 서버 환경에 설정합니다.

```powershell
$env:ORBIT_MODEL_HUB = ConvertTo-Json -Depth 4 -Compress -InputObject @(@{
  id = 'local-model'
  label = 'Local model server'
  providerId = 'local'
  endpoint = 'http://127.0.0.1:8000/v1'
  locality = 'loopback'
  enabled = $false
  projectPaths = @('C:\Projects\my-project')
  models = @('your-model-id')
  requireCredential = $false
  credentialEnv = $null
  timeoutMs = 30000
  maxOutputTokens = 1024
})
```

- HTTP 지원 프로토콜은 `GET /models`, `POST /chat/completions`의 JSON/text SSE입니다. `openai-compatible`, `litellm`, `vllm`, `freellmapi`, `local`은 해당 계약을 실제로 구현한 endpoint에서만 동작합니다. 해당 브랜드의 모든 API·로그인 방식을 지원한다는 뜻이 아닙니다. Bedrock은 별도 공식 AWS CLI 2 `Converse` 어댑터를 사용하며 비스트리밍 텍스트만 지원합니다. CLI 설치·인증·지역별 모델 접근은 별도 진단이 필요합니다.
- 외부 목적지는 `locality:'external'`과 HTTPS/public DNS 검증이 필요합니다. loopback도 무료·오프라인을 보장하지 않습니다. redirect·private IP 재지정·proxy·임의 header·브라우저의 endpoint/정책 변경은 허용하지 않습니다.
- Bearer 인증이 필요한 경우 설정에는 `credentialEnv:'ORBIT_MODEL_KEY_PROVIDER'` 같은 서버 환경변수 **참조 이름**만 둡니다. 키 값은 JSON·UI·로그에 넣지 않습니다. 앱은 해당 참조를 승인·반출 검사 후에만 읽으며 OAuth/구독 토큰을 변환하거나 인증 파일을 읽지 않습니다. 참조가 있다는 것과 인증 성공은 다릅니다.
- 알려진 인증정보·이메일·전화번호·식별번호 패턴을 차단하고 목적지·모델·프로젝트·설정 digest를 매 요청 재검사합니다. 전송 대상은 사용자가 입력한 본문뿐이며 프로젝트 파일을 자동 첨부하지 않습니다. 입력 본문을 별도 이력 필드에 저장하지 않습니다. 응답은 가림 처리 후 저장되므로 모델이 되풀이한 일반 입력이 포함될 수 있습니다. 감사 이벤트에는 본문·응답을 넣지 않습니다.
- 최대 출력은 `max_tokens` 요청값(1~8,192), 시간 제한은 1~60초입니다. 공급자가 상한 초과 usage를 보고하면 실패로 기록합니다. 이는 **실제 청구 금액의 강제 상한이나 환불을 보장하지 않습니다**. 중단·timeout 전에 이미 처리된 요청의 비용은 unknown이며 자동 재시도·제공자 전환은 없습니다.
- 마지막 20개 요청을 표시하고 프로젝트별 최대 200개·16 MiB까지 기록합니다. 새 전송 전에 최악의 JSON 출력 공간을 예약합니다. 같은 request ID 재전송은 기존 결과를 반환하고 서버 비정상 종료 중인 요청은 lost로 복구하며 자동 재전송하지 않습니다. 설정 변경은 서버 재시작 후 적용합니다.

자세한 구성 계약은 [Model Hub 설정](docs/provider-guardrail/MODEL-HUB-CONFIG.md), 현재 검증 범위는 [전체 결과](docs/ORBIT-MASTER-RESULTS.md)를 참고하세요. 이 개발 검증은 전용 localhost 합성 서버만 호출하며 실제 외부 계정·키·과금 서비스는 활성화하지 않습니다.

Bedrock을 선택하려면 서버 설정에 명시적인 AWS CLI 실행 파일 경로, 리전, 직접 foundation model ID, 프로젝트 allowlist와 인증 환경변수 참조를 둡니다. 앱이 AWS CLI를 설치하거나 사용자 profile/인증 파일을 읽지 않습니다. 교차 리전 inference profile, ARN, 자동 재시도·자동 모델 전환은 지원하지 않습니다. 모델 목록 진단은 `ListFoundationModels`, 전송은 `Converse`를 호출하므로 해당 계정의 권한과 별도 API 비용을 확인해야 합니다. 현재 개발 머신에는 AWS CLI가 없으며 실제 AWS 인증·모델 호출·과금 검증은 하지 않았습니다.

Bedrock 입력은 승인·반출 검사 후 **서버 소유 임시 JSON 파일**로 전달하며 명령행 인자·DB·이벤트에는 원문을 넣지 않습니다. 정상적으로 프로세스가 종료되면 삭제하고, 서버 강제 종료나 정리 실패로 남을 수 있는 입력은 요청 기록에 표시합니다. 해당 AWS CLI 프로세스 종료를 확인한 뒤 **임시 입력 파일 정리** 버튼을 사용하세요. 이 정리는 모델을 재호출하지 않으며 lost 결과를 성공으로 바꾸지 않습니다. 미정리 Bedrock 요청이 있으면 새 Bedrock 전송을 차단합니다. 중단·timeout은 원격 처리 중지나 환불을 증명하지 않습니다.
- 사용량 및 분석은 연결된 Codex의 공식 읽기 전용 API로 계정 전체 quota·초기화 시각·토큰 통계를 조회합니다. 표시값에 출처·조회 시각을 붙이고 60초간 재사용합니다. 값이 없으면 unknown이며, 작업별 토큰과 API 비용은 미연결입니다. 크레딧 소비·한도 초기화·API 과금 전환은 수행하지 않습니다.

자세한 상태는 [전체 계획](docs/ORBIT-MASTER-PLAN.md), [누적 검증](docs/ORBIT-MASTER-RESULTS.md), [E2E 결과](docs/ORBIT-E2E-RESULTS.md), [Capability Registry](docs/architecture/CAPABILITY-REGISTRY.md), [실행 모드](docs/architecture/EXECUTION-MODES.md)를 참고하세요.

## 데이터와 보안 경계

### 검증 명령 등록

기본 목록은 비어 있습니다. 서버를 실행하는 사용자가 정확한 프로젝트와 검토한 명령만 설정합니다. 아래 예시의 경로·테스트 파일은 실제 프로젝트에 맞춰 변경하세요.

```powershell
$env:ORBIT_VERIFICATION_COMMANDS = ConvertTo-Json -Depth 5 -Compress -InputObject @(
  @{
    projectPath = 'C:\Projects\my-project'
    id = 'tests'
    label = 'Node tests'
    executable = (Get-Command node.exe).Source
    args = @('--test', 'tests/example.test.mjs')
    timeoutMs = 300000
    protectedFiles = @('tests/example.test.mjs', 'package.json')
  }
)
npm.cmd start
```

완료된 AI Run이 있는 worktree의 **개발 → 실제 명령 검증 및 승인**에서 명령·인자·제한 시간을 확인하고 실행합니다. 브라우저에서 명령·cwd·환경을 바꿀 수 없습니다. 비밀값을 인자에 넣지 마세요. 알려진 credential 옵션과 패턴은 거절하지만 임의 비밀값을 모두 감지하는 기능은 아닙니다.

`protectedFiles`는 선택 사항이며, 해당 명령이 사용하는 테스트·runner·설정·manifest 중 실행 전에 고정할 파일을 지정합니다. 프로젝트 상대 경로만 허용하며 각 파일은 선택 worktree에 Git-visible 일반 파일로 존재해야 합니다. 이 기능을 사용하려면 프로젝트의 모든 검증 명령에 목록을 지정하세요. 기획의 Task 실행 버튼에서 인수조건·명령 설정·보호 파일 해시를 검토한 뒤 **기준 고정 후 Task 실행**을 누르면 AI 실행 기록과 함께 저장됩니다. 이 승인은 검증 명령을 자동 실행하지 않습니다.

일반 구현 파일은 수정할 수 있지만 고정한 파일·기획·명령 설정이 바뀌면 해당 Run의 검증 실행과 결과 승인을 차단합니다. 기존 Run의 기준을 새 파일로 덮어쓰지 않습니다. 의도적인 테스트 변경은 별도로 검토하고 새 Task 실행의 기준으로 승인하세요. 목록을 지정하지 않은 실행과 기존 이력은 일반 명령 검증으로 유지되며, 원래 테스트의 보존이나 인수조건 충족 증거로 승격되지 않습니다. 선택한 파일의 해시 일치가 테스트의 완전성·품질이나 모든 요구사항 충족을 증명하지는 않습니다.

명령은 **Codex sandbox 밖의 OS 사용자 권한**으로 실행됩니다. 환경변수의 토큰은 상속하지 않지만 HOME 등 인증 탐색 위치는 유지하며, 파일·네트워크를 별도 격리하지 않습니다. 신뢰한 로컬 검증 코드만 등록하세요.

검증은 Git-visible tracked/nonignored 파일을 읽어 실행 전후 해시를 비교합니다. 민감 경로·링크·충돌 index·파일 2,000개/개별 4MiB/총 32MiB 초과는 생략하지 않고 차단합니다. ignored 의존성·외부 도구와 중간 수정 후 원복은 증명 범위 밖입니다. 검증 중 nonignored 출력 파일이 생기면 stale가 정상입니다.

모든 등록 명령의 최신 결과가 같은 소스·설정에서 통과해야 리뷰 승인이 가능합니다. 승인 후 소스·설정·최신 검사 변경은 승인을 무효화합니다. 승인은 원본 저장소에 merge하지 않습니다. 정상 종료는 실행 중 명령을 중단합니다. 비정상 재시작의 Check는 lost로 남고, 이전 명령의 종료를 사용자가 확인하기 전 같은 worktree의 새 실행을 차단합니다. PID만으로 기존 사용자 프로세스를 종료하지 않습니다.

**자동화 워크플로:** 같은 서버 등록 명령을 선택해 최대 12단계와 의존성을 저장합니다. 정의는 수정할 때 새 버전으로 보존되며, 현재 버전·전체 명령·대상 source 미리보기와 별도 실행 동의가 필요합니다. DAG 순서로 한 번에 한 명령을 실행하고 첫 실패 뒤 나머지는 건너뜁니다. 단계별 timeout 합계는 최대 10분이며 실제 전체 wall-clock 상한을 보장하는 값은 아닙니다. AI 연결 없이 사용할 수 있고, 실행파일·인자·환경은 웹에서 변경하지 못합니다.

워크플로는 기존 Runner를 사용하지만 AI Run이나 Development의 리뷰 승인으로 자동 변환되지 않습니다. 각 단계의 실제 exit·소스 일치·정제된 출력(최대 8,000자와 잘림 표시)을 별도 기록합니다. 프로젝트별 저장 버전 100개, 실행 100개/32MiB 한도를 적용하며 자동 삭제하지 않습니다. 같은 요청은 중복 실행하지 않습니다. 실패 실행의 동일 version/config/source 재시도는 새 동의가 필요하고, 한 retry chain은 분기 없이 최대 3회입니다. 예약 scheduler·AI 작업 분배·외부 서비스 단계는 미연결입니다.

정상 중단은 이 실행에서 시작한 프로세스만 종료합니다. 비정상 재시작의 `lost`는 이전 프로세스 종료를 확인하기 전 같은 worktree의 실행·검증·승인·병합을 차단합니다. 종료 확인은 결과 성공/실패를 증명하지 않아 `lost`의 재시도는 허용하지 않습니다. 필요한 경우 현재 조건을 새로 미리보기하고 별도 새 실행을 승인합니다. 설정 없는 환경에서는 자동화를 실행하지 않습니다.

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

현재는 Phase 2-A 이후의 통합 worktree입니다. 전체 Goal은 미완료이며 안전 merge, 선택형 제공자 연결, 다섯 추가 실행 모드, 자동화·확장 설정 관리, PDF/추가 다이어그램 등이 남아 있습니다. 공개 서버·자동 배포는 제공하지 않습니다. macOS/Linux/WSL 및 다른 Codex 버전은 미검증이며 실제 사용자 프로젝트의 쓰기는 이 작업에서 활성화하지 않았습니다.

현재 시험·한계는 [전체 결과](docs/ORBIT-MASTER-RESULTS.md), 남은 작업은 [전체 계획](docs/ORBIT-MASTER-PLAN.md)을 참고하세요. 과거 Phase 기록은 docs에 보존합니다.
