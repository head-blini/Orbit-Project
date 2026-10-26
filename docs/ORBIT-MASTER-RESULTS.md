# Orbit 전체 구현·검증 증거

## Task34b — 화면에서 실제 Node 검증 명령 준비 (2026-10-27)

- 시작 HEAD `7c563a2`, branch `codex/orbit-mac-handoff-2026-10-26`, clean 단일 worktree, Darwin arm64/Node24.22.1. 전체 목표 파일을 다시 읽고 Task34a 이후의 검증 설정을 구현했다. `server/verification-setup.ts`, `shared/verification-setup.ts`, `web/verification-setup.tsx`가 실제 Git-visible `*.test.js/mjs/cjs` 최대60개를 찾아 서버 Node의 고정 `--test --` 프리셋으로 등록한다. 등록은 파일·Run·Check·프로세스를 만들지 않는다. 테스트가 없거나 기존 root manifest가 ignored인 경우 등록을 차단한다. 선택한 테스트와 존재하는 root package.json/package-lock.json은 보호 목록으로 고정한다. 테스트 작성·품질·전 요구사항 충족을 자동 판정하는 기능은 아니다.
- SQLite의 append-only revision/receipt/event 원자 저장, 같은 요청 replay, source/base/workspace/current config/revision CAS, 프로젝트별100개 상한과 저장 손상 차단을 구현했다. 호스트 명령이 우선하며 browser executable/argv/cwd 입력은 받지 않는다. Controller는 선택 workspace와 idle, 같은 프로젝트의 다른 workspace에 남은 검증/Workflow/merge/review/planning 복구 차단까지 확인한다. 기존 session/Origin/CSRF 및 정확한 필드 검사를 유지했다.
- 기존 parser를 `server/verification-configuration.ts`로 옮기고 원 export와 배열 constructor를 유지했다. Verification/Workflow/Acceptance는 같은 현재 명령 resolver를 사용한다. 명령 또는 보호 테스트 변경은 과거 Task 기준을 덮어쓰지 않고 기존 승인/기준의 현재성을 무효화한다. UI는 현재 미리보기에 대한 명시 동의와 동일 요청 재확인만 허용하고, 미확인 요청을 sessionStorage에 보존한다. 화면 재진입/새로고침에서 자동 등록하지 않으며 늦은 응답·offline·busy·workspace 변경을 격리한다.
- RED/GREEN: resolver2 RED→기존 Verification 포함10pass, 실제 Workflow 파일까지 포함한 관련16pass. HTTP 초기 route404 RED→통합20pass/1fail(false consent 400/409 불일치)→409 명시 동의 오류로 정합화. Registry15pass에는 ignored manifest 차단·100revision/replay·DB rollback/corruption을 포함한다. UI 최초12 RED→기존 포함25pass, 독립 리뷰가 찾은 비UUID API requestId=`setup-1` 조회 거부를 RED로 재현하고 서버 응답 validator만 수정해 관련26/26pass. 최종 독립 read-only 리뷰에서 추가 actionable finding 없음.
- 최종 `.local/verification/task34b-final-verify.log`: **1022total/1020pass/0fail/2 Windows-only skip, type0/build0/exit0**,42.28초. 직전 전체는1021/1019pass/2skip/0fail이며 이후 리뷰 회귀1개를 더했다. 타입·diff 검사 통과. Registry·resolver·HTTP RED 및 GREEN 로그는 같은 `.local/verification`에 보존했다. 새 운영 의존성·보안 설정 변경 없음.
- 실제 Chrome `.local/ui-e2e/verification-setup-20261027`: 소유 임시 Git/SQLite와 합성 완료 Run1개, 실제 AI0. 화면에서 revision0 후보를 보고 등록→revision1/Check0→명시 실행 Node pass/exit0→구현 파일만 의도적으로 변경→같은 검사 fail/exit1과 과거 pass 보존을 확인했다. 서버 종료/같은DB 새 process/reload 후 설정·Run·Check 전체 값 동일, 추가 실행0, Verification/Workflow 명령 동일, primary HEAD/파일·보호 테스트 hash 불변. `registered-before-check.json`, `start-status.json`, `restart-status.json`, `browser-checks.json`, `result.json`, PNG6개와 재현 server/finalize 스크립트를 보존했다. 브라우저 warn/error0. 소유 서버PID72602/10287 정상 exit0, 탭423251749 닫음, main52676 포트 ECONNREFUSED; finalizer exit0.
- 현재 가능한 시나리오: 테스트가 작성된 프로젝트에서 환경변수·Node 경로 입력 없이 실제 Node 검사를 준비하고, 기존 Task 실행 전 기준 고정과 명시 검사/Workflow에 사용한다. 이번 브라우저 Run은 합성이며 실제 AI E2E 성공 증거로 계산하지 않는다. 테스트 없음·Node 외 runner·ignored 의존성·외부 실행 파일 내용·중간 수정 후 원복은 이 프리셋으로 해결하지 않는다. Windows 실제 실행, 원클릭 전체 자동화, OpenCode/API·로컬 모델, 6모드 executor, 공통 소유권/복구 production 연결, 설치 및 시나리오 A–E와 전체 A–K Goal은 계속 미완료다.
- 다음 Task34c는 초보자 기본 화면의 현재 단계·필요한 준비·다음 실행을 프로젝트/기획/Task/검증 설정/미리보기와 연결한다. 테스트 작성과 고정 기준의 순서를 명확히 안내하고 기존 실행 동의·복구 gate를 재사용한다. 본 branch의 최신 로컬 커밋과 MASTER PLAN, `2026-10-27-verification-setup.md`에서 재개한다. 원격 push/배포·새 과금/인증·사용자 DB 변경 없음. 전체 Goal active.

## Task34a — 이름으로 새 프로젝트와 격리 작업 공간 준비 (2026-10-27)

- 시작 HEAD `ca87694`, branch `codex/orbit-mac-handoff-2026-10-26`, clean 단일 worktree, Darwin arm64/Node24.22.1. 목표 파일 전체를 다시 읽었으며 이전 Task33은 실제 진전으로 유지한다. 전체 A–K 목표는 active다. Task34를 프로젝트 준비와 신뢰된 검증 설정·기본 실행 흐름으로 나눴다. Verification/Workflow의 정적 명령 설정을 부분적으로만 바꾸지 않기 위한 순서이며 전체 범위 축소가 아니다.
- `server/project-creation.ts`, `server/projects.ts`, `shared/project-creation.ts`: 이름과 요청 ID만 받아 서버 전용 `.local/projects/<UUID>`에 고정 README·초기 Git commit을 만들고 기존 Projects 경로로 별도 worktree를 준비한다. 경로·명령·Git 옵션은 브라우저에서 받지 않는다. trustedGit의 고정 identity와 빈 template을 사용하며 사용자 Git 이름·이메일·기존 허용 목록을 바꾸지 않는다. 프로젝트 이름은 표시 값이며 파일·명령에 삽입하지 않는다. 새 운영 의존성 없음.
- SQLite에 두 ID·경로·요청 digest와 intent를 파일 생성 전에 저장한다. ready 요청 재전송/재시작은 같은 project/workspace를 반환하며 다른 이름은 충돌한다. Git·DB·프로젝트/작업 공간 저장 실패는 allocated ID와 파일을 보존하고 자동 새 생성·삭제·reset을 하지 않는다. root와 상위 디렉터리, 생성 저장소와 common Git의 identity를 다시 검사한다. 같은 폴더의 외부 저장소나 위조 project ID는 쓰기를 얻지 않으며 root 교체 후 재시작도 identity를 재설정하지 않는다. 실패한 생성의 자동 복구 UI는 아직 없다.
- Controller의 기존 idle/quarantine과 session/Origin/CSRF를 유지한 `POST /api/projects/create`를 추가했다. optional capability가 없는 호스트는 생성 UI를 노출하지 않는다. 기본 main은 별도 projects root를 제공한다. 일반 생성은 AI·Run·Check·검증 명령을 만들지 않는다. 명령 없는 프로젝트는 승인 불가 상태를 유지한다.
- `web/project-create.tsx`, `web/workspaces.tsx`, `web/main.tsx`, `web/pages.tsx`: 이름 입력→준비→작업 공간 선택→명시적 기획 이동을 연결하고 기존 Git 등록은 고급 항목으로 보존했다. 전송 전 sessionStorage에 요청을 저장하고, 응답 유실은 같은 ID로 확인하며 선택 실패는 선택만 재시도한다. 오프라인·선택 변경·unmount 후 후속 선택을 막는다. 확정 INVALID_FIELDS 거절만 이름 수정을 허용하며 불확실 요청은 고정한다. 이전 응답이 새 요청 기록을 덮거나 selected 상태를 되돌리는 경합을 차단했다.
- 독립 읽기 리뷰에서 첫 프로젝트의 등록 SSE가 create 응답보다 먼저 오면 resolveProject의 자동 선택이 사용자 범위 변경으로 오인될 수 있음을 발견했다. 실제 Chrome 기본 타이밍에서는 실패하지 않았지만 실제 resolveProject와 지연 응답 회귀에서 select POST 누락 RED를 재현했다. 빈 목록·선택 없음에서 반환 project로 정확히 한 번 전환되고 목록1개/작업 공간 미선택인 경우만 허용했다. 일시적인 다른 선택·연결 끊김·목록2개는 계속 차단한다. 수정 후 재검토에서 남은 실질 지적 없음.
- 검사: backend 초기 RED12→기존 Projects 포함25pass/2Windows skip, HTTP 미구현 RED5→5pass. HTTP 첫 GREEN 시도1실패는 의도적으로 고정된 README에 표시 이름을 기대한 테스트 오류여서 고정 문구 계약으로 수정했고 project.name 검사는 유지했다. UI 입력 거절·늦은 응답 RED2와 첫 목록 경합 RED1을 수정하고 UI/기존 Task UI20/20 통과. 첫 전체 `managed-project-creation-final.log`는981total/979pass/2skip/0fail/type0/build0였다. 경합 수정 후 최종 `.local/verification/managed-project-creation-reviewed.log`: **983total/981pass/0fail/2 Windows-only skip, type0/build0/exit0**,32.36초. `git diff --check` 통과. Windows 실제 실행은 수행하지 않았다.
- 실제 Chrome·제품 HTTP/Controller/Git/SQLite: `.local/ui-e2e/project-creation-20261027`에서 잠긴 기존 저장소를 둔 상태로 `첫 번째 Orbit 앱`을 생성하고 준비 완료·자동 작업 공간 선택·기획 이동을 확인했다. 개발 화면의 AI 실행 없음/명령 없음/승인 비활성을 확인했다. 새로고침과 소유 서버 정상 종료→같은 DB/포트 재시작 후 project/workspace/선택/명령·Check·Run 전체 값이 동일했다. 기존 imported 저장소는 쓰기 잠금·HEAD/파일 불변이다.
- 빈 목록 Chrome 검증은 별도 임시 DB 두 개에서 수행했다. 수정 전 기본 타이밍 성공과 수정 후 최종 빌드의 `새 출발 프로젝트` 생성→선택→기획 이동을 구분해 보존했다. 세 fixture 모두 생성 receipt1개·새 저장소1개·worktree1개, native factory0·Run0·명령0·Check0·승인 불가. 실제 AI 테스트가 아니며 Task33의 실제 AI 결과와 구분한다. 최종 탭 warn/error0, 테스트 탭3개 닫음. 소유 서버4회 모두 정상 종료exit0; 마지막 main/preview50687/51856/51857/51858와 선행 empty main51282는 ECONNREFUSED 확인. 초기 서버의 별도 preview 포트 번호는 기록하지 않았다.
- 증거: 같은 evidence 폴더의 server/empty-server/empty-final-server/finalize, start/restart-status, browser-checks/result/owned-ports JSON과 PNG5개. 별도 `project-creation-empty-20261027`, `project-creation-empty-final-20261027`에 빈 목록 fixture/status 보존. finalize는 같은 DB 결과 불변, Git primary 불변, ready receipt·단일 할당, 포트 폐쇄를 assert해 exit0으로 끝났다. 사용자 DB·auth·개인 설정은 읽거나 바꾸지 않았다. README의 과거 Mac 실제 모델 미검증 문구도 Task33 증거에 맞게 바로잡았다.
- 현재 가능한 새 흐름은 Git 명령 없이 프로젝트 이름으로 저장소와 작업 공간을 준비해 기존 기획 화면을 여는 것이다. Task34b 신뢰된 검증 명령 준비·기본 실행 흐름, 공통 ownership/recovery production 연결, OpenCode/API·로컬 모델, 협업 모드, 설치/Windows 및 전체 시나리오 A–E는 남아 있다. 다음 실행은 이 branch의 최신 로컬 commit과 Task34b에서 재개한다. 이번 변경은 로컬 커밋만 하며 push/배포/과금·인증·권한 변경 없음.

## Task33 — 실제 Mac Codex 할 일 앱 E2E와 미리보기 계약 (2026-10-27)

- 시작 HEAD `a56ead5`, branch `codex/orbit-mac-handoff-2026-10-26`, clean 단일 worktree. 목표 파일 전체를 다시 읽고 전체 A–K 범위를 유지했다. Node24.22.1/Darwin arm64, 공식 npm 설치의 native Codex 0.162.1을 사용했다. 현재 공식 App Server 문서와 설치 schema를 대조했으며 최신 문서의 이름을 설치 버전에 무조건 적용하지 않았다.
- `.local/ui-e2e/actual-codex-20261027`: canonical macOS 임시 경로에 새 Git primary/worktree/SQLite를 만들고 제품 Controller/Planning/HTTP/Verification을 그대로 사용했다. 기존 ChatGPT 로그인, API fallback 없음. 요청 원문은 새 할 일 앱의 기능·세 파일·고정 모델 API만 포함했다. 기존 사용자 DB·auth 파일·개인 설정을 직접 읽거나 바꾸지 않았다. native CLI 자체 컨텍스트/세션/제공자 전송은 별도 경계다.
- Chrome에서 실제 기획1회(47,829ms)→제안 저장→중복 ID 결정과 기획 전용 제약을 수동 검토한 r2→승인→Task1→고정 기준 확인→실제 코딩1회(84,144ms)를 수행했다. 원본 AI 제안은 r1에 보존했다. 자동 질문 해소·원클릭 완료로 표시하지 않는다. readOnly/workspaceWrite와 MCP-disabled 정책 attestation은 0.162.1 실제 응답으로 통과했다.
- 실제 Run `d9de6204-65ab-45f7-a8d2-2b72e0026153`, Task `76d5fb8c-d3e5-427e-9a6e-603d88e7e1b2`, workspace `44f99c67-340a-4b9a-a4fc-c9e34d9274e1`. 고정 기준 `89e922f5cf81ddf143baedb9b2c3e3bb65da8835771301863d8c8679f495f2b7`; `check.mjs`/README는 코딩 전에 생성하고 고정했다. native가 app.js/index.html/model.mjs 세 파일만 생성했다. 독립 정적 검토 후 기존 VerificationService의 Node Check exit0/current를 확인했다. 모델 응답과 Test 통과를 구분했다.
- 실제 브라우저 실패 발견: 입력/추가 후 계속0/0이며 입력도 남았다. 생성 앱은 form submit listener, 이전 Task30 성공 fixture는 일반 버튼 onclick이었다. WHATWG form submission 알고리즘은 sandboxed forms flag에서 submit 이벤트 발행 전 반환한다. 따라서 sandbox allow-scripts/form-action none을 유지한 현재 미리보기에서 submit listener는 동작하지 않는다. Node 모델 테스트 통과를 UI 성공으로 표시하지 않았다. `browser-first-attempt.json`과 `03-browser-form-failure.jpg`에 실패 보존.
- `server/app-preview-policy.ts`의 조건부 정적 미리보기 capability를 기획 prompt와 coding thread/start·resume의 developerInstructions에 공통 전달한다. type=button/click·Enter keydown, 상대 ES module·로컬 자산, network/storage/backend/build 제한을 설명하며 다른 프로젝트를 정적 앱으로 바꾸지 않도록 한다. 기획 preview/hash와 실제 전송 입력이 동일한지 검사했다. `web/app-preview.tsx`의 제한 안내도 보완했다. 기존 sandbox·CSP·MCP·network·approval 정책은 변경하지 않았다.
- 첫 host의 native 부모2개 close/exit0을 확인한 뒤 같은 DB/worktree를 재개했다. 브라우저 실패 근거를 r3 기획과 새 Task에 기록하고 native coding 수정1회만 허용했다. 실제 Run `ff3d59bc-7565-47ce-acbe-555832cce4ce`, Task `12e1bb5f-c73c-4853-9c93-9bb2f91532b1`, 새 기준 `d812a945457dda3aae67df44ed90fc18732836361c1c163b9deb21b03cc984b2`. Codex가 index.html의 버튼과 app.js 입력 처리만 수정했다. model.mjs·고정 check.mjs·README는 그대로이며 root가 생성 앱을 대신 고치지 않았다. 과거 Run/Check/baseline을 덮어쓰지 않았다.
- 수정 diff를 검토한 뒤 실제 Node Check `8f5a0c90-446d-42bd-9c0a-a8cab98b36b8` exit0. 수정 전 검사도 그대로 보존되지만 현재 승인 근거로 사용되지 않는다. 수정 후 source `c30ed278ccc9fcbbf89665d73a194b72db71811f83a09436c8f085af7fbad6a1`에서 Chrome 공백 무시0/0→클릭 추가0/1→Enter 추가0/2→완료1/2→삭제1/1을 확인했다. iframe 내부 폭320px에서 긴 한국어 항목 추가 후 scrollWidth320으로 가로 넘침 없음. 실제 IME 조합 입력은 미검증이며 코드의 조합 guard만 확인했다.
- 실제 source graph는 JS 파일3개, import2개, 미확인 관계74개를 기록하고 current로 저장했다. graph `691187f2-118a-4f9d-9cc8-a355477ff051`, Artifact `2babc1e3-d64d-489c-85dc-49f4f3028b1b` v1. Chrome 제품 버튼으로 다운로드한 MD378B/PPTX14,768B가 저장 버전 export bytes와 각각 일치했다. PPTX ZIP CRC·XML에서1슬라이드/편집 도형8/connector2/래스터0 및 파일명 텍스트를 확인했다. 이 파일의 별도 렌더·재편집은 수행하지 않았다. CUA download event 대기1회는 timeout이었으나 실제 Downloads 파일은 생성되어 정확한 파일명으로 확인했다. Homebrew Python3.14 XML은 libexpat 환경 오류로 실패하여 정상인 시스템 Python3.9.6으로 구조 검사를 완료했다.
- 제품의 리뷰 승인 버튼을 검증 에이전트가 로컬 fixture에서 실행했다. 실제 사람이 검토했다거나 AI Native Review를 실행했다는 증거는 아니다. 세 번째 native 부모도 정상 close/exit0 뒤 종료하고 같은 DB를 다시 열었다. observe 모드는 native factory를 금지했으며 새 process/turn0, 기존 Run2·Check2 전체 값과 graph 동일, 수정본 current approval 유지. Chrome reload 후 같은 source 미리보기를 열어 추가0/1을 재확인했다. 새로고침 시 할 일 입력 상태가 초기화되는 앱의 기존 범위도 유지된다.
- RED/GREEN: 미리보기 capability 미전달2 RED→관련48/48 GREEN. 독립 생성 코드 정적 검토와 제품 변경6파일 읽기 전용 리뷰에서 미해결 P1/P2 없음. 최종 `.local/verification/actual-codex-preview-final.log`: **950total/949pass/0fail/1 Windows-only skip, type0/build0/exit0**,31.88초. `git diff --check` 통과. 코드 변경 후 전체 gate와 실제 브라우저 수정 시나리오를 모두 수행했다.
- 증거: 같은 `.local/ui-e2e/actual-codex-20261027`의 fixture/server/resume/finalize, status/repair-status/observe-status, browser-checks/result/pptx-structure JSON, before-repair/after-repair 소스, JPEG7개, 실제 MD/PPTX. 총 실제 AI는 기획1+코딩2 turn, native 부모3개이며 API fallback 없음. 모든 소유 host 정상 종료, 마지막 main/preview 포트49222/49631/50371 ECONNREFUSED, 테스트 탭 닫음, primary HEAD/파일·보호 테스트 불변을 확인했다. native 부모 close를 모든 하위·원격 작업의 종료 qualification으로 확대하지 않는다.
- 현재 가능한 시나리오: 이미 연결된 Codex와 호스트가 설정한 검증 명령이 있는 Mac에서 자연어 기획→수동 검토·승인→격리 코딩→고정 검사→미리보기 실패 발견→수정 Task→재검증→소스 다이어그램·파일 내보내기. fixture가 Git/명령·고정 테스트를 미리 준비하고 검증 에이전트가 단계별 버튼을 조작했다. 초보자 설치·원클릭 자동화·자동 브라우저 판정이 완료된 것은 아니다. 새 capability를 포함한 기획의 신규 실제 생성은 재실행하지 않았고 prompt 전달 계약만 검사했다.
- 다음 수직기능은 Phase1의 기본 작업 흐름과 검증 명령 준비를 기존 Planning/Task/Verification/Preview에 연결하는 것이다. 실행 전 설정·동의의 반복을 줄이되 종료 불명확 상태의 중복 dispatch를 허용하지 않는다. 공통 ownership/recovery production 연결, OpenCode/API·로컬 모델, 협업 모드, Windows/설치와 시나리오 A–E는 여전히 남아 있다. 이 branch 최신 로컬 커밋과 본 기록에서 재개한다. 원격 push/배포/새 의존성·과금·인증·권한 변경 없음.
- 근거: [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server), [WHATWG form submission algorithm](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-submission-algorithm). 이 구간은 시나리오 A의 부분 실제 증거이며 자동 흐름·다른 runtime·전체 시나리오 A–E/설치/Windows/전체 제품 완료가 아니다.

## Task32 — 실행 전 검증 기준 고정과 변경 차단 (2026-10-27)

- 시작 HEAD `e053d8d`, branch `codex/orbit-mac-handoff-2026-10-26`, clean 단일 worktree, Darwin arm64/Node24.22.1. 목표 파일 전체를 다시 읽었다. 이전 구간은 Task31 구현·검증·커밋으로 progress이며 전체 A–K/실제 AI 시나리오 A–E는 여전히 미완료다.
- `shared/acceptance.ts`, `server/acceptance.ts`: 기존 Studio 승인 Task 검증과 Projects의 hardened Git-visible snapshot을 재사용한다. 인수조건·기획 버전/hash·workspace/base·호스트 명령 configDigest·선택 파일 path/Git mode/SHA-256을 고정한다. 파일 원문은 baseline에 저장하지 않는다. 전체 소스 digest를 고정하지 않아 일반 구현 변경은 가능하다. 보호 파일은 명령별 최대128개, 상대 정확 경로만 허용하고 민감 경로·링크·누락·ignored 파일은 차단한다. preview도 저장 validator를 통과해 생성/조회 계약을 일치시킨다.
- 기존 `ORBIT_VERIFICATION_COMMANDS`에 선택형 `protectedFiles`를 추가했다. 프로젝트 명령에 모두 지정하거나 전부 생략하며 일부 지정은 거부한다. 브라우저에 임의 명령 설정 권한을 추가하지 않았다. 기존 환경변수 없는/legacy 실행은 계속 사용할 수 있지만 인수조건 보존 증거로 승격하지 않는다. README에 설정과 한계를 기록했다.
- Controller/HTTP의 인증된 Task verification-preview GET 및 기존 run POST의 선택형 expectedAcceptanceDigest: 서버가 동일한 승인 기준인지 다시 계산하고 CAS한다. Run의 acceptanceDigest와 `run_acceptance_baselines` 행을 기존 Run/operation/event 트랜잭션에 함께 저장한 뒤 native turn/start를 호출한다. 저장 실패는 Run도 롤백하며 native dispatch0이다. 재시도는 기존 Run을 돌려주고 digest가 다르면409다. 기존 baseline을 수정하거나 새 테스트로 자동 덮어쓰는 API는 없다.
- VerificationService의 Check 실행 직전·직후 기준 검사와 승인 gate를 연결했다. 선택 테스트/runner·기획·명령이 바뀌거나 기준이 손상/누락되면 실행/승인을 차단한다. 구현 파일 변경 후 정상 Node exit0은 허용했고, 검사가 자신의 테스트를 약화한 exit0은 stale로 기록했다. Check.acceptanceDigest가 Run과 다르거나 누락되면 현재 승인 불가다. lost Run과 base 불일치도 직접 거부한다. Workflow runner에는 선택 파일 메타데이터를 실행 인자로 전달하지 않도록 분리했으며 기존 회귀를 통과했다.
- UI: Task 실행 전 기준/인수조건/보호 파일 확인 및 취소→명시적 기준 고정 후 실행. 기준 없음은 기존 2필드 요청을 유지한다. Development에 current/changed/unavailable/unbound와 고정 기준·Check 연결을 표시한다. 취소·지연 응답·중복 클릭·offline/project/session/workspace 변경은 오래된 확인 동작을 폐기한다. 확인은 검증 명령 자동 실행 권한이 아니다.
- RED/GREEN: acceptance module 부재10 RED→추가 경계 포함12/12. Task 통합 새2건은 protectedFiles 미지원으로 RED→추가 저장실패/검사중변경 포함Task7/7. 첫 통합34건 중28pass/6fail은 legacy verification mock의 Store workspace 누락이었으며 실제 project/workspace fixture를 등록해8/8 통과했다. 서비스 상태 검사를 완화하지 않았다. UI 즉시 POST·changed 승인 활성 RED, React render 전 offline/workspace 동작의 오래된 확인 콜백 RED를 동기 intent 폐기로 수정해9/9, 영향 UI 회귀27/27.
- 독립 whole-change 읽기 전용 리뷰: 기준 저장·CAS·legacy·동일 기준 Check gate·재시도·UI 경합 검토. 최종 미해결 P1/P2 없음, acceptance+UI20/20 독립 실행. 제안한 Check digest 누락/불일치 회귀도 실제 passing Check로 추가해 최종 suite에서 통과했다.
- 첫 전체 `.local/verification/task-acceptance-full-first.log`:943total/942pass/1skip/0fail·type/build0. 최종 `.local/verification/task-acceptance-final.log`: **948total/947pass/0fail/1 Windows-only skip, type0/build0/exit0**,31.48초. `git diff --check` 통과.
- Chrome CUA `.local/ui-e2e/task-acceptance-20261027`: 제품 Controller/HTTP/Studio/Projects/VerificationService, 임시 Git/SQLite, 합성 native 응답1건과 실제 Node24 Check1건. preview 시 Run/baseline/Check0, 취소 후 명시 확인 시 각각Run1/baseline1/Check0, 구현 HTML 변경 후 원래 테스트 exit0 및 수동 승인, assertion 삭제 후 실행/승인 비활성·과거 승인 stale를 확인했다. 같은 DB로 재시작 후 Run/기준/Check JSON 전체 동일, synthetic dispatch0, 새 Check0. 원본 repository clean, main 포트 ECONNREFUSED, 탭 닫음, 정상 검증 구간 console warn/error0.
- 증거: server.mjs/state.json/browser-checks.json/result.json, JPEG4개, shutdown-54385.json와 shutdown-76836.json. 실제 Run `ca7d7f7f-916f-4c0c-be84-720d59cc41a1`, Check `a38a4db9-457a-47f6-a45c-3e8ad82d0d0a`, baseline `f7d493a67c96ab45016b4042e3822678d3d880f2f9b6d6514835afae1e207f47`. 초기 fixture bootstrap은 shell PATH 범위 때문에 기본 Node로 시작했으나 Run0 상태에서 종료하고 Node24로 재시작한 뒤 모든 브라우저 실행/검사를 수행했다. 사용자 DB·인증·개인 설정에 접근하지 않았고 실제AI0/외부API0이다.
- 사용 가능: 호스트가 검토한 보호 파일 설정 → 승인 Task의 기준 확인·실행 → 동일 기준의 명시적 실제 검사 → 현재 결과 검토. 미완료: 완전한 test coverage/수용 판정, 선택 파일 밖·ignored 의존성·외부 바이너리·실행 중 변경 후 원복·동일 OS 사용자 DB 공격에 대한 보장, runtime qualification·공통 소유권/복구 production 연결, 자동 수정·원클릭 전체 흐름·초보자 명령 설정·실제AI/Windows 최종 시나리오. hash 일치를 전체 요구사항 통과로 표시하지 않는다.
- 다음은 기존 승인 Task→실제 Codex 코딩→고정 검사→정적 미리보기의 임시 저장소 시나리오를 수행하고 발견된 결함을 수정한다. native 정책 gate를 우회하지 않는다. 이 branch의 최신 local commit과 `docs/superpowers/plans/2026-10-27-task-acceptance-baseline.md`에서 재개한다. 원격 push/배포/새 의존성·과금·권한 변경 없음.

## Task31 — 기획·실행·검증·미리보기 결과 탐색 (2026-10-27)

- 시작 HEAD `46ff568`, branch `codex/orbit-mac-handoff-2026-10-26`, clean 단일 worktree, macOS Darwin arm64/Node24.22.1. 목표 파일 전체와 기존 계획·실제 연결 지점을 재확인했다. 이전 구간은 Task30 구현·검증·커밋으로 progress다. 전체 A–K와 실제 AI 시나리오 A–E는 계속 미완료다.
- `shared/development-results.ts`, `server/development-results.ts`, Controller/HTTP: 인증된 `GET /api/workspaces/:id/result?runId=...`는 선택 작업공간의 Run·Task·기획·Check를 authoritative 저장 기록으로 결합한다. 다른 workspace는409, 외부/없는 Run은404, 중복·알 수 없는 query는400. 기획 현재 head·hash/연결, 실제 source 재조회, 등록 명령별 최신 Check/config/base/source/finished digest를 확인한다. 기존 VerificationService.canApprove와 busy/복구 gate를 재사용하며 승인 권한을 새로 부여하지 않는다. 원문 prompt/response/check output·request ID·명령 인자는 응답에 포함하지 않는다.
- 최대100 Check 표시에서 현재 등록 명령의 최신 근거가 누락되면 성공을 추론하지 않는다. source 조회 실패/조회 중 변경, newer fail, config/base 변경, lost Run, 미설정 검사는 현재 통과를 만들지 않는다. free prompt와 Task 연결 누락을 구분하며 이전 기획의 역사 조회에 새 실행 gate를 사용하지 않는다. 새 DB 테이블·AI/명령 dispatch·승인 mutation은 추가하지 않았다.
- `web/development-results.tsx`, `web/pages.tsx`, `web/main.tsx`: 실행 선택·기획/실행/검증 요약·최근 검사 내역과 조회 시각을 추가했다. 명시적으로 선택한 이전 Run은 새 SSE Run이 와도 유지한다. Review/Verification/Merge는 같은 선택 Run을 사용하고 active Run 선택은 과거 종료 Run으로 대체하지 않는다. 작업공간/프로젝트 변경은 선택을 초기화하며 지연 응답과 offline의 이전 성공 근거는 표시하지 않는다. `web/agent-center.tsx`, `web/studios.tsx`의 결과 버튼은 정확한 workspace/task/planning 연결을 전달한다. Task 목록에서 현재 workspace에 없는 기록을 전역 미실행으로 부르지 않는다.
- `web/app-preview.tsx`: preview와 조회 결과의 workspace/source digest가 일치하고 현재 검사 근거가 유효할 때만 같은 소스의 등록 명령 통과를 표시한다. 미리보기는 현재 작업공간 사본이며 해당 Run이 모든 파일을 작성했다는 인과·과거 파일 복원·요구사항 전체 수용 판정을 주장하지 않는다. 기존 iframe/CSP 정책과 명시적 실행·승인 경계는 유지했다.
- 실패/검증: UI module 부재 RED4→UI4pass(탐색 추가 포함 최종5pass). HTTP route 부재404 RED1→외부Run404 은닉 계약에 맞춰 기대409 수정→통합 통과. 서버 projection 부재 RED11→기본11pass, 실제 Node pass→fail/config 변경과 lost Run 회귀를 추가했다. `.local/verification/development-results-focused.log`32total/31pass/1fail은 병행 추가한 lost Run RED이며 명시 lost 억제 후 서버13/13pass·type0 확인. async actual-TSX generic hooks 테스트5/5는 지연 응답·offline/workspace 첫 렌더 제거·15초 polling·unmount cleanup을 검증했다. 처음부터 통과했으며 결함 재현으로 표시하지 않는다.
- 독립 전체 변경 read-only review: 재현 가능한 P1/P2 없음. 제안된 async 검증 보강은 원래 계획의 지연 응답 요건으로 이미 추가했다. 별도 수정하지 않은 중요 지적 없음. `git diff --check` 통과.
- 첫 전체 `.local/verification/development-results-full.log`:917total/916pass/1skip/0fail·type/build0. 최종 `.local/verification/development-results-final.log`: **922total /921pass /0fail /1 Windows-only skip, type0/build0/exit0**,29.63초. 실제 AI·외부 API를 사용하지 않은 테스트다.
- 실제 Chrome CUA `.local/ui-e2e/development-results-20261027`: 제품 Controller/HTTP/Projects/Store, 실제 임시 Git worktree, 합성 AI Run3개 및 실제 로컬 Node Check2건(exit0/9). Agent Center의 이전 실행 선택→기획 연결/통과→같은 source preview→할 일 추가0/2, 새 Run 도착 후 선택 유지, 미검증 실행 전환에서 성공 제거, Planning Task 결과 링크, source 변경 SSE→stale 미리보기 숨김/통과 제거, 실제 재검사 실패와 과거 통과 분리, 다른 workspace 격리, 새 서버 프로세스/같은DB 재시작 후 기록 복원 확인.
- 소스 변경 직후 기존 VerificationPanel의 15초 조회 전 옛 digest로 누른 첫 요청은 서버에서 거절됐다. 기록에 새 Check가 없음을 화면에서 확인하고 상태 재조회·명시적 요청 잠금 해제 후 최신 소스로 다시 검사했다. 자동 재시도가 아니며 실제 명령 실행은 총2개다. 이 거절·잠금 UX는 기존 동작이다.
- `server.mjs`, `seed.json`, `state.json`, `browser-checks.json`, `result.json`, JPEG5개, `shutdown-{9437,11020}.json` 보존. 두 서버 모두 exit0, native factory0/실제AI0/외부API0. 두 shutdown의 Run 수3·Check ID/verdict/exit 전체 일치, 초기 main/preview 포트 ECONNREFUSED, 사용한 탭 닫음. 작업 중 root console warn/error0. 사용자 DB/인증/개인 설정 미접근.
- 현재 사용: 기획 Task 또는 에이전트 대화의 결과 버튼 → 개발 화면에서 실행 선택 → 연결 기획/조회 당시 실제 검사/현재 정적 앱 확인. 미완료: 자동 기획·코딩·검증, 빌드/backend preview, 신뢰된 수용 기준, 공통 authority production dispatch와 qualified recovery, 실제 AI 시나리오·Windows 최종 E2E. 다음은 기존 검증 명령 설정과 기획 인수조건을 신뢰된 기준으로 결합해 원클릭 실행 경로를 잇는 작업이다. 이 branch 최신 local commit과 계획 `2026-10-27-development-results.md`에서 재개한다. 원격 push/배포/신규 의존성·과금·권한 변경 없음.

## Task30 — 작업공간의 정적 앱 결과 미리보기 (2026-10-27)

- 시작 HEAD `5f99f68`, branch `codex/orbit-mac-handoff-2026-10-26`, 단일 clean checkout, macOS Darwin arm64/Node24.22.1. 목표 파일을 다시 읽고 Phase1의 생성 결과 화면을 연결했다. Task29 ownership/qualification 미완료 요구는 유지하며 독립적으로 가능한 사용자 기능을 구현했다.
- `server/app-preview.ts`, `shared/app-preview.ts`: 기존 `Projects.snapshot()`의 검증된 Git-visible bytes를 한 번 복사해 capability 경로의 별도 loopback origin에서 제공한다. Store/auth/프록시/파일시스템 fallback/빌드·명령 실행 경로는 없다. 최대4 snapshots,256개 지원 파일/8MiB,HTML1MiB,10분 TTL. 선택 HTML·JS/MJS·CSS·제한된 이미지/폰트만 제공하며 다른 HTML·삭제 파일·알 수 없는 MIME·경로 traversal·query·top-level 문서 요청은 거부한다. refresh는 해당 workspace의 이전 capability를 폐기한다.
- 기존 HTTP 세션·Origin·CSRF와 선택 workspace·idle 검사 후 생성하며 GET은 목록/digest만 반환한다. main listener가 preview listener를 소유하고 종료·workspace.selected 때 폐기한다. Orbit script/style CSP는 그대로 유지하고 frame-src는 정확한 preview origin만 허용한다. 생성 문서에는 response CSP sandbox allow-scripts, no same-origin/connect/worker/nested-frame/form/base/object와 권한 제한을 적용한다. 다른 포트가 cookie를 분리한다고 가정하지 않으며 preview는 Cookie를 사용/반사/기록하지 않는다.
- `web/app-preview.tsx`, Development 연결: HTML 선택·열기·최신 파일로 다시 열기·닫기, 시각/digest와 범위 안내. known source revision 변경은 catalog 재조회하고 stale iframe을 숨긴다. 실행/복구 busy 동안 iframe을 숨기며 오래된 응답을 generation으로 무시한다. 재시작 후 preview port가 바뀌면 처음 로드한 문서의 meta origin과 대조하여 iframe을 만들지 않고 다른 편집 내용을 저장한 뒤 명시적 화면 reload를 안내한다. 미리보기 load를 검증 성공이나 AI 완료로 표시하지 않는다.
- 독립 검토2회: listener bind 전에 close하면 늦게 열린 서버가 남는 P2를 RED로 재현하고 startup promise 대기/stopped 재검사를 추가했다. 마지막 terminal Run만 refreshKey로 삼아 workspace.changed를 놓치는 P2는 실제 Development props RED→state.lastSeq/locked 연동으로 수정했다. main CSP가 이전 ephemeral port를 유지하는 재시작 문제도 HTTP meta/origin 검사 RED→GREEN과 실제 브라우저 안내·재열기로 확인했다.
- 후속 독립 검토 P2: 생성 POST 중 무관한 SSE revision이 오면 공용 generation이 성공 응답을 버리고 서버에서 폐기된 이전 token을 유지했다. 실제 TSX를 실행하는 일반 hook fixture `tests/app-preview-state.test.ts`에서 RED1/2pass를 확인했다. catalog request sequence와 생성/lifecycle generation을 분리하고, 진행 중 이벤트를 대기시킨 뒤 POST 성공 후 현재 source를 다시 읽도록 수정했다. 기존 iframe은 새 생성 시작 시 제거하며 source 변경·locked 전환 후 늦은 응답을 표시하지 않는다. 관련7/7 통과, 독립 재검토3/3 및 추가 중요 지적 없음.
- 실패/검사: host module 부재 RED1→기본3pass, HTTP endpoint 부재 RED2→통합6pass, UI module 부재 RED2→UI2pass, lifecycle RED1. 첫 전체 `app-preview-full-first.log`893total/892pass/1skip/0fail·type/build0. review RED3→집중 `app-preview-review-green.log`10/10. 중간 전체 `app-preview-final.log`895total/894pass/1skip/0fail·type/build0 이후 POST/SSE 회귀를 추가했다. 최종 `.local/verification/app-preview-race-final.log`: **898total /897pass /0fail /1 Windows-only skip, type0/build0/exit0**,26.39초. `git diff --check` 통과.
- 실제 Chrome CUA `.local/ui-e2e/app-preview-20261027`: 제품 Controller/Projects/HTTP/SQLite와 실제 임시 Git worktree. 작성한 정적 할 일 앱에서 상대 CSS와 ES module import, 항목 추가·완료(1/2), 파일 변경→수동 및 SSE stale 숨김→최신 내용, 닫기/재열기, 다른 workspace의 빈 상태와 이전 capability404, 같은 DB/메인 포트의 별도 프로세스 재시작·새 미리보기 생성 확인. 부모 DOM·cookie·storage·Orbit API/fetch·image/script·popup/top 접근은 화면에서 차단, nested-frame/form/self-navigation의 소유 loopback canary 도달도0. 이는 테스트한 Chrome 경계이며 모든 브라우저/네트워크 채널의 OS 차단을 뜻하지 않는다.
- `browser-checks.json`, `result.json`, `server.mjs`, JPEG6개, `shutdown-{50414,50956,51779,51966,81577}.json` 보존. 마지막 비동기 경합 수정 후 다섯 번째 서버에서 최종 빌드·할 일 추가/완료1/2를 다시 확인했다. 다섯 서버 모두 exit0, native/Run/실제AI/외부API0, canary hits0, 최초·최종 preview listener 폐쇄 확인. 첫 host는 non-TTY stdin이 닫혀 명령 전달 실패 후 소유 PID50414에 SIGTERM으로 정상 종료했고 이후 TTY에서 stop했다. 공격 실행 전 루트 탭 console0이며 child CSP 진단까지 console0이라고 주장하지 않는다. 사용자 DB·인증·개인 설정 미접근.
- 현재 사용 시나리오: 선택한 관리 workspace에 Git-visible 정적 HTML 결과가 있으면 **개발 → 결과 미리보기 → HTML 선택 → 미리보기 열기**로 앱을 조작할 수 있다. 지원 범위는 상대 경로 자산을 사용하는 정적 앱이다. ignored dist, TSX/npm 빌드, / 또는 ? 자산 경로, backend/API/storage·다중 페이지는 미지원이며 실제 AI 제작 시나리오 A–E, Windows·Safari/Firefox E2E, 전체 제품은 미완료다. 외부 인증 없는 fixture 검증을 실제 AI 성공으로 대체하지 않았다.
- 다음: 기존 기획 Task→Run→Check→결과/preview를 동일 workspace/source 근거로 결합하고 사용자가 결과와 검증 상태를 함께 탐색하도록 연결한다. 공통 authority production dispatch·qualified recovery release와 신뢰된 수용 판정은 계속 필수 미완료다. 이 branch의 최신 local commit과 이 기록에서 재개한다. ignored `.local`은 검증 증거다. 원격 push/배포/신규 과금·의존성·권한 변경 없음.

## Task29 — 저장소 공통 소유권 authority 기반 (2026-10-27)

- 시작 HEAD `437b0c7`, branch `codex/orbit-mac-handoff-2026-10-26`, macOS/Node24.22.1. 이전 turn은 실제 Task28 구현·검증·커밋으로 progress다. 목표 파일을 다시 읽고 기존 실행 경계를 독립 조사했다. Solo 외 Review/Planning 별도 factory, Check/Workflow subprocess, worktree add, Merge prepare의 object/ref 쓰기와 apply까지 공통 admission이 필요하다. Model Hub는 별도 account/destination 범위가 필요하다.
- 설계 검토 결과: 현재 부모 close·Run 완료·processStopped만으로 전체 descendants/remote 작업 종료를 판단할 수 없다. 이를 release로 승격하거나 정상 종료마다 영구 잠금을 남기는 전면 연결은 하지 않았다. 구현 순서를 명시적으로 authority 기반→qualified runtime/command profile→모든 dispatch/Recovery 연결로 정했다. 이 단계가 전체 OWNER/DISPATCH를 완료하거나 기존 경로를 보호한다고 표시하지 않는다.
- `Projects.repositoryResource`, `server/repository-resource.ts`, `shared/repository-authority.ts`는 기존 writable/validate 이후 canonical common Git 디렉터리의 dev/ino/birthtime와 경로로 저장소 identity를 만든다. 서로 다른 Store/Projects state directory 및 worktree가 같은 저장소 ID를 갖고 branch/worktree/base는 별도로 보존한다. 기존 Project/Workspace body는 변경하지 않고 조회 시 authority를 만들지 않는다. metadata 디렉터리를 복사 교체하면 새 identity가 되고 기존 authority marker/handle은 불일치를 거부한다.
- `server/repository-authority.ts`는 explicit create/open/inspect, 하나의 repository-exclusive manager claim, 단조 증가 fencing generation, operation intent→dispatch/quarantine, revision CAS, 감사 기록을 제공한다. `BEGIN IMMEDIATE` 안에서 소유권과 전이를 저장하고, native/Git 실행 전에 사용할 dispatch receipt를 발급한다. 동일 요청 replay는 필드 순서에 의존하지 않는다. 작업이 실행되지 않은 intent만 취소할 수 있으며 미해결 operation이 없는 claim만 relinquish 가능하다. dispatched/uncertain operation의 release API는 아직 없다. close·manager exit·TTL·PID로 claim을 제거하지 않는다.
- `.git/.orbit-authority-v1` 전용 namespace, schema/version/application ID/marker 일치, regular single-link DB/marker/journal, 열린 파일·디렉터리 identity 재확인, full synchronous rollback journal을 사용한다. symlink/hardlink/unknown 파일, 세대/행/감사 불일치, 저장 실패는 거부한다. 사용자 소유 기존 디렉터리 chmod/chown이나 사용자 DB 변환은 하지 않는다. 이는 협조하는 로컬 프로세스 간 authority이며 악의적 동시 filesystem 교체·임의 SQL 전체 재작성에 대한 OS containment 또는 network filesystem/Windows certification은 아니다.
- RED/GREEN: resource API RED3→기존 Projects 포함12pass/1Windows skip. authority 초기 부재 RED1→5pass/1fail(교체한 DB의 백업을 strict namespace 안에 둔 테스트 구성 오류; backup을 fixture root로 이동). 초기 type12오류→3오류→0. request resource key-order RED1, SQL generation-hidden operation RED1, 독립 review의 ignored UPDATE/audit RED1, AFTER-audit body mutation RED1, held/released claim 삭제 fencing 역행 RED1을 수정했다. body 변경 행 수와 저장값을 감사 전후 재조회하고 모든 canonical row↔audit를 양방향 확인한다. 최종 신규 suite `repository-authority-final-focused.log`:13/13pass. 최종 독립 검토는 보고한 결함 해소 및 추가 명백한 치명 문제 없음; diff check 통과.
- 실제 Node process fixture2개가 서로 다른 cwd/state directory에서 동시에 한 authority를 획득한다. 성공1/거부1을 확인하고 소유자가 합성 dispatched intent를 commit한 뒤 해당 fixture PID에만 SIGKILL했다. 새 DB handle/다른 owner의 acquire는 계속 거부하며 원래 manager 및 dispatched 상태가 남는다. 실제 AI/외부 API0; 모든 Git/DB/child는 소유 임시 fixture다. 이 검사는 모의 SQLite mutex가 아니라 실제 process·filesystem·SQLite contention이다. 제품 저장소 `.git/.orbit-authority-v1`은 생성되지 않았음을 확인했다.
- 최종 `.local/verification/repository-authority-full.log`: **885total /884pass /0fail /1 Windows-only skip, type0/build0/exit0**,25.84초. UI 변경이 없어 browser smoke는 실행하지 않았다. 사용자 인증/설정/기존 DB와 원격 저장소는 변경하지 않았다.
- 다음/미완료: production Controller/Review/Planning/Verification/Workflow/Merge/Projects writer에 authority를 아직 주입하지 않았다. 우선 exact runtime/build/OS/policy와 정상·중단·오류·transport loss의 descendant/remote lifecycle을 실제로 자격 검증해야 한다. 그 기준으로 기존 Recovery 계약과 원자 release를 연결한 뒤 모든 side-effect 경계에 같은 authority를 적용한다. Account-slot authority, Windows/network FS, 실제 AI A–E, 원클릭 preview 및 전체 A–K는 계속 미완료다. 독립적인 Phase1 결과 미리보기 작업도 기존 실행 안전 경계를 유지하며 병행 가능하다. 재개는 이 branch의 최신 local commit, 이 문서 및 `2026-10-27-repository-authority.md`에서 이어간다. 전체 Goal active, 원격 push/배포 없음.

## Task28 — 소유한 부모 프로세스의 관찰 기록 (2026-10-27)

- 시작 HEAD `3189d29`, branch `codex/orbit-mac-handoff-2026-10-26`, macOS Darwin25.2 arm64/Node24.22.1. 기존 Rpc/Controller/Store/Agent Center를 확장했다. `shared/native-process.ts`와 `server/rpc.ts`는 소유한 ChildProcess마다 opaque handle을 생성하고 실제 spawn/close 또는 PID 없는 spawn 실패를 관찰한다. EOF·signal 요청·실행 중 error를 종료로 바꾸지 않으며 실제 close 관찰이 generic closed보다 먼저 발생한다. 저장된 PID를 kill하거나 OS 시작 시각으로 해석하지 않는다.
- `server/native-connection-journal.ts`의 additive schema1은 manager incarnation/generation별 intent를 factory 호출 전에 저장하고, native session 및 프로세스 관찰·transport close를 원자적으로 기록한다. 이전 Run·operation journal bytes는 보존한다. 세션 ID는 policy 검사 실패 전이라도 응답에서 확인한 즉시 결합하며, 오래된 child의 늦은 종료는 원래 connection에만 저장한다. process handle/PID 불변, terminal 관찰 불변, inert shape 검사, getter·coercion 거부, migration/event rollback, disk restart를 검사했다.
- 독립 리뷰에서 pre-Run 저장 실패의 차단이 재시작 후 사라지는 P1, 확인된 session이 policy 실패 때 소실되는 P2, unknown factory 오류 뒤 같은 Controller가 재시도하는 P1을 발견했다. RED 후 미완료 collection journal의 startup admission, 조기 session 결합, 즉시 메모리 quarantine을 추가했다. `journalState=closed`는 관찰 수집 완료만 뜻하며 ownership/recovery release가 아니다. `NativeLaunchNotStarted`는 신뢰된 factory가 생성 시도 전에만 사용한다. executable 부재와 fixture의 명시적 pre-spawn 거부를 구분하며 일반 예외는 계속 unresolved로 남는다. 최종 독립 read-only 검토 추가 지적 없음.
- 인증된 기존 Run operation 조회에 connection 증거를 더하고 상세 UI에 부모 프로세스 상태·handle·관찰 시각·exit code/signal을 표시했다. Run 완료와 부모 종료, 현재 생존 여부 재조회, 하위·원격 작업 종료를 분리해 설명한다. 자동 release·자동 재시도·새 실행 경로나 운영 의존성은 추가하지 않았다.
- 검증: Rpc 실제 Node child RED3→관련14pass; Store/Controller 통합41pass; 실제 child 통합의 ACK 직후 completion 검사 1fail은 실제 notification 대기로 수정 후15pass. shape/key 순서 RED2와 review RED3→관련47pass. unknown factory RED1→9pass. 최초 전체 `.local/verification/native-process-full.log`는 **870total/867pass/2fail/1skip**, type0/build 미실행: 테스트 호스트의 일반 거부 오류가 unknown factory quarantine으로 처리된 기존 UI 시나리오2건이다. 알려진 pre-spawn 거부를 명시한 뒤 기존 권한 거부 assertion을 유지했고, 새 회귀를 포함한 `native-launch-refusal-green.log`21/21 통과.
- 최종 `.local/verification/native-process-final.log`: **872total /871pass /0fail /1 Windows-only skip, type0/build0/exit0**,24.99초. `git diff --check` 통과. 사용자 DB·인증·개인 설정은 읽거나 변경하지 않았다.
- 실제 Chrome CUA `.local/ui-e2e/native-process-20261027`: 제품 Controller/HTTP/SQLite/Rpc와 실제 Node 자식1개, 합성 JSON-RPC 응답·실제 AI/외부 API0. completed Run의 `종료 미관찰`을 확인한 뒤 소유 서버를 정상 종료하고 새 PID로 같은 DB를 열어 같은 handle의 종료 시각·code0, 기존 개정1–3 및 새로고침 보존을 확인했다. `before.json`, `shutdown-12454.json`, `shutdown-12482.json`, `browser-checks.json`, `result.json`, JPEG2개·재현 비교 스크립트 보존. Run/operation raw rows 불변, 두 번째 시작의 native child0, warn/error0. 최초 사후 비교는 SQLite null-prototype row와 JSON 객체의 prototype 차이로 실패하여 저장 column bytes 비교로 수정 후 exit0; 제품 데이터 차이는 없었다. 두 서버PID12454/12482 exit0, 탭423251717 닫음.
- 한계와 다음: 이번 기록은 현재 소유 ChildProcess의 관찰이며 OS boot/start identity, 하위·원격 작업 종료, exact runtime/version/policy qualification, cross-state-dir ownership, persisted recovery release CAS는 미완료다. 정상 Run 완료와 이 journal 완료를 공통 resource 해제 근거로 사용하지 않는다. 다음은 해당 facts와 공통 authority를 기존 dispatch에 연결하고 검증하는 단계다. 전체 Phase1 원클릭·실제 AI 시나리오 A–E·Windows 최종 E2E·A–K 제품 Goal은 계속 active다. 재개 시 이 branch의 최신 로컬 commit과 이 결과 문서에서 이어가며 ignored `.local`은 검증 증거다. 원격 push/배포 없음.

## Task27 — Solo 실행 식별 기록과 상태 변경 이력 (2026-10-27)

- 시작 HEAD `089fbb8`, macOS Darwin25.2 arm64/Node24.22.1. 기존 Store/Controller/Agent Center를 확장했다. `shared/solo-operation.ts`, `server/solo-operation-journal.ts`가 새 실행의 runtime/manager nonce/connection generation/native session/turn과 개정 이력을 보존한다. native turn/start 전에 Run·journal·event를 한 트랜잭션으로 저장하며, 실패하면 native 전송과 부분 Run을 남기지 않는다. 연결 초기화 전 프로세스 소유권을 증명하는 기능은 아니다.
- 버전1 additive migration의 DDL·version 쓰기 rollback, 반복 실행, 기존 Run bytes·event prefix·request receipt 보존을 검사했다. 시작 시 unresolved Run을 lost로 변경하는 기존 경로가 journal도 함께 갱신한다. 응답 chunk만 바뀌면 상태 이력을 늘리지 않으며 known turn ID를 바꾸지 못한다. 과거 Run에 manager/session을 추정해서 채우지 않는다.
- 인증된 `GET /api/runs/:id/operation`과 실행별 상세 화면은 조회 전용이다. 위조 browser identity POST, query, 인증 없는 요청·다른 Origin을 거부한다. 이력에는 prompt/response를 복제하지 않는다. legacy unknown 설명과 종료/복구 증거가 아니라는 안내, 명시적 새로고침을 제공한다.
- 독립 검토 P1: 완료 notification의 journal 쓰기 실패가 EventEmitter 밖으로 전파돼 서버를 종료시킬 수 있었다. RED2로 재현한 뒤 native 이벤트 경계에서 격리하고, 저장 작업 전에 connection generation을 무효화했다. loss·status 저장이 함께 실패해도 메모리 차단을 보존하며 close 실패도 새 실행 허용 근거로 삼지 않는다. 늦은 완료·ACK가 원래 journal을 덮지 않는 검사 포함. 독립 최종 probe는 journal/event/close 동시 실패에서도 격리·재연결 거부·늦은 알림 무시를 확인했고 추가 지적 없음.
- 검사 기록: 초기 Store RED4→GREEN4, Controller RED2, typecheck의 key tuple 오류2건 수정. Store/Controller/HTTP 통합34/34, notification 경계 RED2→관련33/33. 최종 `.local/verification/solo-operation-reviewed.log`: **854total /853pass /0fail /1 Windows-only skip, type0/build0/exit0**,24.91초. 이후 한국어 저장 실패 안내·상세 행 간격만 변경하여 typecheck/build exit0을 다시 확인했다. `git diff --check` 통과.
- 실제 Chrome CUA `.local/ui-e2e/solo-operation-20261027`: 합성 legacy/completed/lost Run3개, unknown 안내, 기록된 manager/session/generation7/native turn, 개정1–3, 수동 새로고침, 동일DB 새 프로세스 reload 후 기존 식별자·이력 및 실행 차단 유지. `browser-checks.json`, `result.json`, JPEG3개 보존. 마지막 `03-restarted.jpg`가 최종 간격 조정 화면이다. 두 서버PID83861/83935 exit0, 탭423251713 닫음, native factory0·실제AI/외부API0·Run/journal 불변, browser warn/error0. 브라우저 핸들 이름 재사용1회가 실패하여 설정된 Chrome의 새 탭을 정상 생성했으며 제품 동작 실패는 아니다.
- 한계: 신뢰된 종료/자식 프로세스 증명, runtime/version/policy qualification, cross-state-dir resource ownership, persisted recovery ledger와 release CAS는 아직 없다. 이 journal은 해제 권한이 아니며 기존 quarantine 해제 API를 추가하지 않았다. Windows 및 실제 AI 시나리오 A–E·원클릭 미리보기·전체 A–K Goal은 미완료다. 다음 구현은 공통 소유권과 복구 사실 수집을 기존 dispatch에 연결하는 단계다.

## Recovery 순수계약 감사 체크포인트 (2026-10-27)

- Task25 `25ecf4a`, Task26 `42b45c9` 로컬 커밋 완료. 이전부터 별도 미커밋으로 있던 `shared/recovery.ts`와 `tests/recovery-contract.test.ts`는 독립 read-only 검토를 마쳤다. 19개 계약 테스트가 실제 통과했고 최종 전체841 gate에도 포함돼 있다. 신뢰된 서버 facts라는 명시된 경계 안에서 재현 가능한 해제 우회는 발견하지 못했다.
- 계약은 operation/request/runtime/manager generation/session/turn, process identity, profile qualification, workspace/source, recovery revision, ownership와 수동 확인의 유효시간을 비교한다. PID/lease/timeout/interrupt ACK/EOF는 종료 증거가 아니다. 수동 확인도 unknown identity·안전성·실행 중인 소유자·작업을 우회하지 못한다.
- 이것은 pure 판정 함수이며 collector, OS 종료 증명, persisted recovery ledger, lock authority, CAS commit 또는 실제 release endpoint는 아니다. 합성 사실을 실제 qualification으로 쓰지 않는다. 다음 구현은 실제 수집·영속 기록·소유권 연결이며, 현재 quarantine의 자동/수동 해제는 여전히 제공하지 않는다.

## Task26 — Solo 종료 불확실 실행 격리 (2026-10-27)

- Task25 local commit `25ecf4a` 위에서 진행. 저장된 lost Run 또는 저장 실패 시 메모리 차단 상태가 있으면 재연결·새 프롬프트·작업 공간 변경과 Check/Review/Planning/Workflow/Merge/Model Hub의 새 실행을 차단한다. 기존 요청 결과 재조회와 기록·상태 조회는 실행을 반복하지 않는다. 같은 상태 DB 재시작 시 unresolved Run을 lost로 읽어 계속 차단한다.
- RPC closed 시 generation을 먼저 무효화한다. lost 저장 실패 후 늦은 완료 알림이 durable Run을 completed로 덮는 경계 결함을 독립 리뷰/FakeRpc로 재현해 수정했다. 현재 concrete Rpc의 close 이후 stdout은 이미 차단되며, 일반 OS 종료에서 자연 발생까지 확인한 것은 아니다.
- Model Hub는 접수·비동기 대기 이후·실제 HTTP request/Bedrock invoke 직전에 동일 admission을 확인한다. DNS/CLI 버전 대기 중 Solo loss가 발생해도 후속 전송을 하지 않는다. 서버 내부 함수 인자만 사용하며 browser 설정 필드를 추가하지 않았다. 차단 사유는 `SOLO_RECOVERY_REQUIRED`로 보존한다.
- 실패 기록: `solo-quarantine-red.log` 1fail, `solo-quarantine-red2.log` restart/storage/workspace RED, `solo-ui-red.log` 1fail. `solo-services.log`는 승인 경로의 기대 오류가 잘못되어 1fail 후 수정. 첫 전체 `solo-quarantine-verify.log`는 HTTP 대역의 새 메서드 누락으로 1개 테스트 실패 및 deferred 테스트 대기, 소유 테스트 프로세스 종료 후 총829/826pass/2fail/1skip으로 종료; build 미실행. 대역·timeout 보완 뒤 집중36/36과 전체839/838pass/1skip/0fail 통과.
- 후속 리뷰 경계 RED: `solo-review-red.log` 21/19pass/2fail(late event·queued dispatch), `solo-dispatch-red.log` Bedrock6/5pass/1fail, `solo-http-dispatch-red.log` DNS dispatch1fail. 수정 후 `solo-review-green.log`36/36, `solo-dispatch-green.log`39/39. 마지막 독립 검토 추가 지적 없음, `git diff --check` 통과.
- 최종 `.local/verification/solo-quarantine-dispatch-final.log`: **macOS Node24.22.1, type0 / 841total / 840pass / 0fail / 1 Windows-only skip / build0 / exit0**,25.28초. loopback fixture를 위한 승인된 host 검사이며 실제 AI·외부 서비스 요청은0이다.
- Chrome CUA `.local/ui-e2e/solo-quarantine-20261027`: Task25 DB 사본에 합성 lost Run1개를 넣은 실제 Controller/HTTP/SQLite 서버. Goal 이력 개정1–3 조회, 격리 배너·연결/프롬프트 비활성, 동일DB 새 프로세스 재시작 후 유지 확인. browser-checks.json과3JPEG, console warn/error0. native factory0, 기존 합성 Run1개 유지. 서버46408/46431 정상 종료exit0, 검증 탭423251705 닫음.
- 한계: 같은 Controller/상태 DB의 quarantine만 구현했다. 안전한 release endpoint, 정확한 종료/자식 프로세스 증거, 공통 ownership, 다른 state-dir와 동시 실행 격리, Windows 실제 재검증은 미완료다. 따라서 lost 이후 실행 재개 기능은 제공하지 않는다. 기록 삭제·새 state-dir로 우회하도록 안내하지 않는다. 실제 AI 성공·V4-02 전체 완료·제품 완료를 뜻하지 않는다.
- 다음: 기존 `shared/recovery.ts` 순수계약을 감사하고 persisted recovery/identity/ownership과 연결한 뒤 수동 복구를 구현한다. 공통 dispatch와 신뢰된 수용 판정이 갖춰져야 원클릭 실행 연결을 자격 검증할 수 있다.

## Task25 — Goal Tracking 통합 및 새 목표 기준선 (2026-10-27)

- 실제 환경: macOS Darwin25.2 arm64, 시작 HEAD `faba903bb9e6856e26166600cbcc413058fef553`, branch `codex/orbit-mac-handoff-2026-10-26`(remote보다8commits ahead), 단일 checkout. 최초 cwd의 하위 `Orbit-Project`가 실제 Git root다. 시스템 Node25.8.2 대신 기존 ignored Node24.22.1 사용. 기존 Goal/Control Plane/Recovery 미커밋 변경 보존.
- 최초 `.local/verification/goal-20261027-baseline.log`: typecheck exit2, `runsTotal` 계약 누락4건. 새 실제 서비스→UI coordinator 회귀와105개 실행 projection 회귀 RED2를 확인하고 shared/server 계약·100개 상한을 수정했다. 전체 기록의 lost blocker와 합계는 보존한다. `web/main.tsx` 자동화 화면에 기존 GoalTrackingPanel을 연결했다.
- 독립 검토4건: UI 미연결, runsTotal 불일치, lost Check 복구 사유 누락, 시간순이 아닌 근거 목록의 '최근' 오표시. 앞2개 통합 후 lost Check RED1→수정, 설명을 '최대100개'로 정정했다. 목표 추적은 여전히 무실행·reference-only이며 achieved를 허용하지 않는다.
- 샌드박스 전체 검사 `.local/verification/goal-foundation-verify.log`:831total/750pass/80fail/1skip, loopback listen EPERM 등 환경 제한으로 실패, build 미실행. 승인된 host 검사 `goal-foundation-host-verify.log`:831total/830pass/0fail/1skip, type/build0. 최종 `goal-foundation-final-verify.log`: **832total/831pass/0fail/1 Windows-only skip, type0/build0/exit0**,24.86초.
- Chrome CUA `.local/ui-e2e/goal-foundation-20261027`: 실제 제품 화면에서 Atlas 승인 기획 선택→Goal 생성v1→pause v2→resume v3, history, Boreal 격리, reload, 새 서버/같은DB 복원 확인. browser-checks.json과3JPEG 보존, console warn/error0. 실제 Controller/HTTP/SQLite 사용; fixture native factory0, Run0, 외부 API0. 두 서버18945/19090 정상 종료exit0; 탭423251701 닫음. 첫 서버 stdin이 닫혀 stop 입력 실패 후 동일 소유 PID에 SIGTERM으로 정상 종료했으며 재시작은 별도 프로세스다.
- 변경 주요 파일: shared/goals.ts, server/goal-service.ts, web/goals.tsx, web/main.tsx, tests/goals*.test.ts와 기존 Control Plane 기반. 기존 user DB·인증·설정은 열거나 변경하지 않았다. 이번 검증은 Goal Tracking과 Mac fixture 범위이며 실제 AI·Windows·설치·원클릭 시나리오 A–E는 미완료다.
- 다음: V4-02 Solo lost가 terminal로 취급되어 reconnect/새 작업을 허용하는 경로를 영속 차단하고 회귀 검증. 이어 공통 resource ownership, 증거 기반 release, 수용 테스트 무결성, 원클릭 실행 연결. 전체 제품 Goal은 계속 active.

## 2026-10-25 시작 기준

- 목표 파일을 전체 읽고 기존 로컬 통합 worktree를 우선 확인했다. 기준 HEAD `73ec364`, 브랜치 `integration/orbit-20261025104804486-08592a18`. 기존 통합/UI 변경이 미커밋으로 존재하며 보존한다.
- Windows 10.0.19045, 실행 runtime Node v24.19.0, Git 2.53.0.windows.3, Codex 0.164.0-alpha.11.1. 이 세션 PATH에는 npm이 없으며 기존 설치 의존성의 CLI를 Node로 직접 실행했다. 패키지 설치 없음.
- 실제 사용자 DB/인증정보를 읽거나 앱의 기존 서버를 시작하지 않았다. 테스트의 임시 DB/Git fixture만 사용했다.
- 기존 보고서의 134 테스트와 이번 재실행 결과를 구분한다.

| 명령 (통합 worktree) | exit | 실제 결과 |
|---|---:|---|
| `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 | baseline 타입 검사 통과 |
| `node --test tests/*.test.ts spikes/phase0/*.test.mjs` | 0 | 134/134, fail/skip 0; `orbit-master-baseline-tests.log` |
| `node scripts/build.mjs` (sandbox) | 1 | 기존 esbuild 상위 디렉터리 access denied 재현 |
| `node scripts/build.mjs` (승인된 일반 사용자 실행) | 0 | app.js 296.3kb, app.css 24.3kb 생성; 제품 코드 변경 없이 빌드 통과 |

전체 Goal은 **미완료**다. 실제 browser E2E, 실제 Codex 연결과 코드 생성, 제공자 실서비스, PPTX 등은 이번 시작 기준에서 아직 검증하지 않았다.

## 진행 기록

- 독립 읽기 전용 감사 3개를 실행했다: Planning/Development/Runner, Provider/Security/Extensions/Usage, Visualization/Automation. 공통 수정 소유자는 메인 에이전트다.
- 중요한 발견: 입력 credential detector가 거절하는 합성 credential 형식 일부가 출력 `safeText`에서 가려지지 않는다. 실제 비밀을 읽지 않고 합성값으로 확인했으며 우선 수정 대상으로 지정했다.

## 첫 통합 묶음: 비밀정보 출력 / 승인 Task 실행 / PPTX

- `safeTextItems`는 누적 원문을 메모리에서만 검사하고 credential·PEM span과 각 item 미완성 tail을 같은 좌표계에서 합친다. Controller가 정제 snapshot만 DB/event에 저장한다. 독립 리뷰에서 확인한 cross-item assignment/PEM 문맥 소실은 추가 RED→GREEN으로 수정했다. 유한 패턴 검사이며 모든 비밀값 탐지를 보장하지 않는다.
- 승인 Task 실행은 저장된 current head의 프로젝트·버전·해시·승인 evidence·요구사항 snapshot·미결정 질문을 확인한다. 목표/인수조건/제약을 포함한 4,000자 이하 brief를 서버에서 생성한다. 넘치는 내용은 잘라 보내지 않고 거절한다. Run 생성과 Task/버전 연결을 원자적으로 저장한 다음 기존 Codex submit을 사용한다. uncertain response 후 같은 request는 이미 존재하는 Run을 반환한다. 실행 완료는 여전히 검증 성공이 아니다.
- PPTX는 실제 ZIP/OpenXML 12개 part와 native text/shape/connector를 생성한다. 선택한 저장 Artifact의 project/id/revision/hash를 확인한 보호된 다운로드 경로와 Markdown 다운로드를 연결했다. 수정한 원문은 먼저 저장해야 한다.

| 실제 실행 | exit | 결과 |
|---|---:|---|
| Task HTTP 신규 회귀 최초 실행 | 1 | 3/3 실패, 실행 endpoint 부재(404) 확인 |
| Task HTTP + Controller 집중 실행 | 0 | 16/16; uncertainty·멱등성·현재 head·미결정·CSRF·프로젝트 gate |
| interleaved incomplete AKIA Controller 회귀 | 1 → 0 | 원문 prefix 저장 재현 후 각 item boundary 처리로 수정 |
| 출력 모듈 집중 회귀(독립 담당 최종) | 0 | privacy/core/controller/task-runs/provider 44/44 |
| Artifact export HTTP 최초/수정 후 | 1 → 0 | endpoint 부재 및 Mermaid direction extra field 연결 오류 수정; 고정 버전 bytes·ownership/hash 검증 |
| `node --test tests/studio-ui.test.ts tests/studio-integration.test.ts tests/task-runs.test.ts tests/controller.test.ts tests/pptx.test.ts` | 0 | 32/32; `orbit-master-slices.log` |
| `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 | 위 통합 이후 타입 검사 |
| PPTX 독립 Python zipfile/XML/python-pptx | 0 | ZIP CRC·12 XML/관계, 한글 text 수정·도형 이동·저장·재열기·connector endpoint 보존 |
| Windows E2E 첫 실행 | 1 | 기존 agent-browser 설치가 PATH에 없어 CLI 발견 실패. `.local/ui-e2e/run-2026-10-25T13-13-53-871Z-ok8erJ/` |
| Windows E2E 설치경로만 PATH 추가 후 | 1 | CLI/정적/타입 통과; 병행 개발 중이던 provider transport 신규 RED 테스트로 전체 검사 실패. 브라우저 단계 미도달. `.local/ui-e2e/run-2026-10-25T13-14-42-080Z-r7vpap/` |

독립 PPTX 산출물: `C:/Users/lclk1/AppData/Local/Temp/orbit-pptx-evidence/editable-korean.pptx`, `C:/Users/lclk1/AppData/Local/Temp/orbit-pptx-evidence/edited-roundtrip.pptx`. 실제 PowerPoint GUI와 full OOXML XSD 검증은 아직 실행하지 않았다. 독립 담당의 병행 전체검사 161/161 기록은 최종 통합 기준의 전체검사를 대신하지 않는다.

다음 진행: transport/verification 모듈 구현과 통합, PPTX 저장 validator 정합성 리뷰 보완, 안정된 소스에서 전체 검사와 E2E 재실행. 전체 Goal 미완료.

## 중간 통합 검사와 사용자 추가 요구

- `.local/ui-e2e/run-2026-10-25T13-20-18-395Z-YX4C99/`: 타입 exit0, 전체 **194/194 exit0**, build exit0. 임시 Git fixture가 긴 Windows 경로에서 `Filename too long` exit128로 실패해 browser 단계에 도달하지 못했다. 전역 longpaths 설정을 바꾸지 않고, 소유 marker가 있는 짧은 OS temp evidence root를 쓰도록 E2E harness를 수정 중이다.
- HTTP transport는 native Node HTTP(S)로 models/text SSE, 정책 callback, endpoint/DNS pinning, redirect 거절, unknown usage와 취소/제한을 구현한 **미연결 모듈**이다. 기존 mock UI를 실제 연결 성공으로 바꾸지 않았다. 독립 리뷰에서 final text yield 뒤 취소가 done으로 이어지는 결함을 찾아 보완 중이다. 실서비스·실제 외부 DNS/TLS·Bedrock는 미검증/미구현이다.
- verification도 기존 Runner process/policy의 해시 동일 복사본을 재사용하는 **미연결 모듈**이다. 실제 Node 명령 fixture 9/9에서 exit/timeout/interrupt/stale/마스킹을 검증했다. 사용자 승인 config·DB evidence·HTTP/UI 연결은 아직 없다. Codex sandbox와 별도인 로컬 OS 실행 권한을 가진다.
- PPTX 저장/UI validator와 exporter의 geometry/XML 제한 차이를 수정했고, Visualization+PPTX **27/27 exit0**으로 확인했다.
- 최신 사용자 지시에 따라 지금 범위의 전체 검증을 우선하고, 이후 공식 Capability Registry와 Solo/Cross Review/Debate/Race/Cooperate/Goal 모드로 확장한다. 전체 설계 완성 목표를 대체하지 않는다. 현재 공식 문서 조사는 읽기 전용으로 진행한다.

## 현재 개발 범위 검증 종료 (Capability 작업 전)

- 최종 전체 검사 `node --test tests/*.test.ts spikes/phase0/*.test.mjs`: **196/196, exit0**, fail/skip 0. 증거 `orbit-master-final-tests.log`. HTTP transport 취소/deadline 회귀 2개 포함. 타입 검사에서 테스트 generator.return 인자 누락을 수정한 뒤 `tsc --noEmit` exit0, transport 20/20 exit0.
- Windows browser E2E: **18단계 exit0**, 12개 메뉴 × 2해상도 **24 PNG**, refresh/restart 후 기획·Task·Artifact 복구, 원본 Git fixture 보존. 해당 E2E snapshot의 typecheck/전체194/build 모두 exit0. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-qGLnOx`; 세부는 ORBIT-E2E-RESULTS.md. 메인 에이전트가 planning 1366×768과 visualization 1744×864 PNG를 직접 확인했다.
- 같은 fixture 저장 Artifact의 HTTP export: PPTX **12713 bytes**, Markdown **213 bytes**, 모두 HTTP200/attachment. ZIP 필수 entry와 Markdown 원문/버전 확인 exit0; `http-export-check.json`, `http-exports/`에 보존.
- **실제 브라우저 파일 저장은 실패/미검증**: 공식 agent-browser download가 제품 blob 버튼과 직접 HTTP attachment 모두 `Download was canceled`로 종료했다. console/errors는 비었으며 blob만의 제품 오류라는 근거는 없다. 보안 flags·HOME·권한 변경이나 추측 제품 수정 없이 진단을 종료했다. 서버 export 성공으로 브라우저 저장 성공을 주장하지 않는다.
- E2E 전용 서버·Chrome 종료와 cleanup 오류 0 확인. native Codex 실제 추론/코드 생성, PowerPoint GUI, 외부 모델 실서비스, 실제 비용/usage는 이번 범위에서 검증하지 않았다.
- 현재 범위의 검증 실행·실패 분류를 마쳤다. 브라우저 파일 저장 문제는 남겨두고 독립적인 Capability/모드 작업을 진행한다. HTTP transport와 verification은 계속 제품 미연결이며 전체 Goal은 미완료다.

## Capability Registry / 6개 실행 모드

- 공식 문서와 로컬 Codex stable/experimental JSON schema를 확인해 세션·stream·resume·interrupt·계획·review·Skills·MCP·Hooks·plugins·subagents·Goal·usage를 Registry에 반영했다. Claude는 공식 CLI/SDK·Goal·Teams와 인증/과금 조건을 별도 정리했다. 출처·확인일은 `docs/architecture/`에 보존했다.
- Registry GET은 실행 없는 조회이며 명시 POST 진단만 고정 native `--version`을 호출한다. CSRF·Origin·빈 body·safe env·3초·4KiB·60초 캐시·pending 공유를 검증했다. 실제 sanitized probe exit0: 2026-10-25T13:40:11.937Z Codex found `0.164.0-alpha.11.1`, Claude not_found_on_path. 설치 전체·인증·비용·quota까지 확인한 것은 아니다.
- Solo/Cross Review/Debate/Race/Cooperate/Goal을 native 재사용 전제로 설계하고 순수 예산·격리·비교 계약과 UI 설명을 연결했다. Race는 같은 승인 계획/요구/base/test/E2E, 독립 worktree, 후보별 source에 묶인 실제 증거를 요구한다. unknown·미강제 예산은 차단하며 속도나 agent 자기평가로 승자를 정하지 않는다.
- 기존 Solo 실행기는 유지되며 새 모드 gate는 아직 Controller 미연결이다. 나머지 5개 모드 executor는 미구현이다. UI에서 실행 선택/성공으로 표시하지 않는다. hooks/plugins/multi_agent/MCP 비활성 정책과 승인 거절은 그대로다.
- 독립 리뷰에서 probe가 await 이전의 ready 상태를 응답하는 P2를 재현하고 회귀 RED→GREEN으로 수정했다. 6모드 계약 리뷰의 중요 finding은 없었다.

| 검증 | exit | 결과 |
|---|---:|---|
| Registry 최초 / HTTP 최초 | 1 → 0 | module 없음 / route404에서 구현 후 통과 |
| Registry+native probe+mode+HTTP+SSR 집중 | 0 | 31/31; 뒤이어 stale connection 회귀 2/2 |
| 최종 E2E 내부 타입검사 | 0 | `tsc --noEmit` |
| 최종 E2E 내부 전체 테스트 | 0 | **221/221**, fail/skip0 |
| 최종 E2E 내부 build | 0 | 승인된 일반 사용자 동일 build |
| Windows 실제 브라우저 | 0 | **18단계**, 24 PNG, refresh/restart, Registry·확장 정책·6모드 설명 확인 |

증거 root: `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-HDdQCK` (2026-10-25T13:43:00.861Z~13:43:55.753Z). 메인 에이전트가 providers 1366×768, agents 1744×864 화면을 직접 검토했다. 전용 서버/Chrome 종료, cleanupErrors0. browser에서 native probe/모드/실제 AI 실행은 하지 않았다. 과거 download canceled 실패는 해결되지 않았고 이번 범위에 포함하지 않았다. 전체 Goal은 미완료이며 다음은 실제 verification evidence·승인 경로의 제품 통합이다.

## 실제 검증·리뷰 승인 수직기능

- 서버의 프로젝트별 고정 명령 설정 `ORBIT_VERIFICATION_COMMANDS`(기본 빈 목록), 명령/config/source preview, 명시 실행 승인, 실제 Runner 실행·중단, SQLite Check·이벤트, 소스·설정·최신 결과에 결합한 리뷰 승인을 Development에 연결했다. 실행 중 agent/check/workspace 전환을 상호 배제한다.
- 체크 기록이 있는 Run은 `verification:recorded`이며 통과를 뜻하지 않는다. 실제 exit/verdict는 별도 Check에 있다. 소스·설정 변경, 최신 실패 재시도, 중단/timeout/lost는 승인 근거로 사용하지 않는다. 자동 merge는 없다.
- source fingerprint는 Git stage0 tracked/nonignored 목록, 삭제·mode·내용 digest와 base/정책을 결합한다. 민감 경로는 내용을 열기 전에 거절하고 link/hardlink/경계/관찰된 파일교체/파일 수·용량 초과를 fail-closed 처리한다. ignored 의존성과 중간 변경 후 원복은 증명하지 않는다.
- 재시작 중이던 check는 lost로 보존하고 같은 workspace를 격리한다. 사용자가 이전 로컬 프로세스 종료를 확인한 뒤 다시 검증해야 한다. 서버가 PID만으로 기존 프로세스를 kill하거나 자동 재실행하지 않는다.
- 명령은 Codex sandbox 밖의 로컬 OS 권한이다. preview/UI/README에 이를 표시한다. 독립 리뷰에서 `--api-key value` 분리 인자의 preview 노출 P1을 재현하고 구성/preview 양쪽에 알려진 credential 옵션 거절을 추가했다(RED→GREEN). 유한 패턴이며 임의 비밀값 탐지의 완전성을 주장하지 않는다.

| 검증 | exit | 결과 |
|---|---:|---|
| source fingerprint focused | 0 | 10/10; 최초stub RED3 fail→GREEN |
| verification service focused | 0 | 7/7; 실행전 source race·최신재시도·설정·lost복구·분리credential |
| 실제 임시 Git + HTTP | 0 | 2/2; 실제Node exit/approval/stale·CSRF·override·민감파일·중단·동시실행 |
| 독립 review 재실행 | 0 | service+HTTP 9/9, 추가 P1/P2 없음 |
| 첫 전체 E2E 선행검사 | 1 | 239/240; 의도적으로 바뀐 timeline 문구의 기존 assertion 불일치. build/browser 미도달. `orbit-e2e-A7Q2BM` |
| 문구 회귀 수정 | 0 | 새 안내 확인과 임의 검증통과 표시 금지 유지; focused1/1 |
| 최종 전체/type/build | 0 | **240/240**, 타입·빌드 통과 |
| Windows 브라우저 | 0 | **20/20 단계**, 26 PNG, 실제Node검증→승인→변경후무효→refresh/restart복구 |

최종 증거: `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-hze7tz` (2026-10-25T14:06:49.239Z~14:08:05.473Z). 사용자 DB/원본 Git 보존, 전용 서버 종료, cleanupErrors0. 메인 에이전트가 `25-verification-approved.png`, `26-verification-stale-after-restart.png`를 직접 확인했다.

이 브라우저 검사의 terminal Run은 fixture 전용 IPC로 만든 **합성 실행 기록**이고 검증 명령은 실제 Node 프로세스다. 실제 Codex 코드 생성과 구분한다. 과거 브라우저 다운로드 취소는 계속 미해결이다. 전체 Goal 미완료; 다음은 실제 Codex 승인Task→코드→검증→승인→산출물 단일 smoke와 남은 제공자/그래프/자동화/확장/사용량 연결이다.

## Codex 사용량 조회와 실제 승인 Task workflow

- 공식 `account/rateLimits/read`(`excludeResetCreditDetails:true`)와 `account/usage/read`만 사용한다. ready ChatGPT 연결·CSRF empty POST·60초 cache/pending 공유·연결 generation 폐기를 적용했다. GET은 캐시만 읽는다. quota 초기화·credits 소비·email·과금 전환 기능은 없다.
- 허용한 숫자·날짜·ID만 반환하고 null/오류는 unknown으로 유지한다. 계정 전체 quota/토큰과 작업별 usage/API 비용을 구분한다. 원시 account fields·credits·오류를 UI/DB/로그에 보존하지 않는다.
- 파서/collector 12 및 Controller/HTTP 3개 focused 통과. 검토 중 초기 GET이 최신 수동 refresh를 덮는 UI 경합을 확인해 요청 epoch를 분리했다(Capability 진단에도 동일 수정). 해당 지연 UI 경합은 코드 검토로 확인·수정했으며 브라우저 지연 재현은 별도로 실행하지 않았다.
- 최종 Usage gate: **타입검사·전체255/255·build exit0**, Windows **20/20**, 26 PNG, cleanupErrors0. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-0PJj0y` (2026-10-25T14:26:47.871Z~14:28:01.633Z). UI의 disconnected unknown·계정 전체·비활성 조회 버튼을 확인했으며 이 E2E에서는 실제 계정 RPC/모델 요청이 0회다. 메인이 usage 1366×768 PNG를 확인했다.
- 이후 `node scripts/verify-approved-workflow.mjs`를 검토하고 승인된 일반 사용자 경로에서 **1회** 실행했다. **exit0 / passed**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-approved-live-CyWYy0/summary.json`.
- 실제 공식 Codex 연결 → 승인 Planning/Task → **native process1 / turn1 / completed fileChange1** → 정확한 greeting.ts diff1파일 → 원본 Git/테스트 파일 보존 → 실제 Node check exit0 → source/checkset-bound 리뷰 승인 서비스 → 실제 PPTX/Markdown 파일·ZIP CRC·native text/shape/connector·Markdown exact bytes 확인. cleanupComplete=true, approvalDenials0.
- 같은 연결의 실제 공식 사용량 조회도 수행했고 summary에는 `usageReadAttempted:true, usageStatus:available`만 기록했다. 계정 수치·인증정보·원문 RPC는 출력하지 않았다. 기존 ChatGPT 구독으로 실행했으며 새 API 키·과금 경로·계정 설정을 만들지 않았다.
- 이 live smoke의 리뷰 승인은 고정 fixture diff에 대한 **script attestation**이다. 실제 사용자 브라우저 클릭, PowerPoint GUI, 전체 플랫폼/모든 제공자의 성공을 뜻하지 않는다. 하나의 native turn은 내부 model request 수나 token 비용 상한 1회를 의미하지 않는다. Controller 120초 deadline과 1turn gate를 사용했고 추가 모델 실행은 하지 않았다.

전체 Goal은 계속 미완료다. browser file download 취소, 안전 merge, 소스 graph·확장 다이어그램/PDF, 실제 provider 연결 구성, 5개 모드 executor, automation, extensions profile/설정복구, 작업별 비용/usage가 남아 있다.

## 브라우저 Artifact 저장 재검증

- `node scripts/verify-artifact-download.mjs` 최종 exit0. 새 disposable fixture `C:/Users/lclk1/AppData/Local/Temp/orbit-download-8NErjl`에서 명시 plain `--download-path`와 제품 PPTX/Markdown 버튼의 일반 click으로 실제 디스크 파일을 생성했다.
- PPTX 12,721 bytes / Markdown 221 bytes가 서버의 같은 immutable Artifact 출력과 완전히 일치했다. ZIP CRC/12 XML parts/internal relations/한글/native shape5+connector1을 script와 별도 Python 검사로 확인(exit0). 전용 서버·브라우저 종료, 원본 Git 보존, cleanupErrors0.
- 같은 세션·같은 버튼에서 CLI `download <ref> <path>`만 사용하면 취소가 재현된다. 제품 버튼 저장 성공과 도구 명령 실패를 구분한다. Windows extended canonical path 원인은 아직 가설이다. 보안 옵션·HOME·allowlist 변경이나 제품 패치 없이 성공 경로를 검증했다.
- 사전 2회는 CLI PATH 탐색/대기식 오류로 다운로드 비교 전에 실패했으며 성공으로 집계하지 않았다. 자세한 증거·공식 동일버전 소스는 `docs/visualization/DOWNLOAD-RESULTS.md`. PowerPoint GUI 미검증, 모델 추론/새 API 호출 없음.

## 소스 그래프 수직기능 진행

- 설치된 TypeScript 5.9.3을 runtime dependency로 재분류했다. lock 버전·integrity는 동일하고 새 패키지 설치/프레임워크/Graphify 플러그인 도입은 없다.
- 기존 fingerprint 단일 read의 같은 bytes에서 bounded JS/TS source snapshot을 얻는다. fingerprint 정책·field 순서/기존 동작은 보존, source 제한/UTF8/BOM/민감경로/no-open 검사를 추가했다. focused17/17 exit0.
- map-only TypeScript CompilerHost는 tsconfig·패키지·라이브러리·원격/추가 fs resolution을 하지 않는다. file/function/class/method 및 import/call/extends의 정적 근거와 unresolved를 기록한다. 분석·지원 범위는 제한되어 있으며 runtime 호출과 실제 검증 통과를 뜻하지 않는다.
- 서버의 권위 manifest에서 계산한 file ID로만 코드 미리보기를 찾는다. redacted display path는 파일 접근 권한으로 쓰지 않는다. 원문 source/diagnostic은 DB/events에 저장하지 않는다.
- graph SQLite 이력·source-current/stale·파일탐색·기존 Artifact/PPTX 연계·Artifact 원문 exact 비교를 구현했다. 소스가 바뀌면 stale, 수동으로 바꾼 Artifact는 metadata가 남아 있어도 unverified다. 첫 HTTP회귀 RED(미구현route)→GREEN2/2, 실제 disposable Git·재시작·원본 보존 포함. 새 브라우저/전체 gate는 아직 대기 중이다.
- 독립 리뷰 P2: redaction 팽창 후 64,000자 절단을 truncated:false로 표시하던 문제를 실제 합성 입력으로 확인하고 cap-sized output도 보수적으로 표시하도록 수정했다. 회귀 API 검사 통과. 구조분해 함수 재할당을 놓친 parser P2는 담당자가 회귀 수정 중이다.
- parser 구조분해 P2는 배열·객체·nested/rest/default/shorthand 6가지 write를 unresolved로 처리하는 회귀로 수정됐다. 최초 RED(단순LHS검사), shorthand 추가 RED 후 최종 focused14/14 exit0. typecheck도 exit0. 런타임 dispatch 정확성을 주장하지 않는다.
- 첫 source graph 전체 gate는 `orbit-e2e-QZasQp`: type0, 전체278중276pass/2fail(exit1), build/browser 미도달. 원인은 기존 visualization SSR helper가 Studio 한 파일만 TSX 변환해 새 ArtifactSourceStatus.tsx import를 읽지 못한 것이다. 같은 저장소의 scoped registerHooks/TypeScript transpile 방식으로 component dependency tree를 로드하도록 수정했고 기존 assertions는 모두 유지했다. visualization focused21/21 및 typecheck exit0 확인 후 전체 gate 재실행 중이다.
- 최종 source graph gate: **타입검사·전체278/278·build exit0**, Windows browser **22/22**, 30PNG, cleanupErrors0. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-cBONNn` (2026-10-25T14:56:33.371Z~14:58:06.723Z). 메인이 27-source-graph-current와30-source-artifact-stale-after-restart PNG를 직접 확인했다.
- 새 disposable worktree의 JS/TS3파일에서 main→greet import/call·잠재영향·원문preview 확인, 소스 Artifact 생성, source현재성, 변경 후 graph/Artifact stale 및새로고침·서버재시작 복구를 검증했다. 원본fixture clean, 전용서버 모두 종료. 이 E2E의 실제AI/계정조회0회; 앞서 실제Codex1turn smoke와 구분한다.
- source graph 수직기능 검증을 마쳤으며 전체 Goal은 미완료다. 다음은 실제 Model Provider Hub 구성·진단·text stream 연결. 기본off, 명시승인·목적지/PII검사·출력한도·중단·unknown비용 경계와 로컬mock HTTP 검증부터 진행한다.

## Model Provider Hub 통합 진행 (2026-10-26)

- 기존 native HTTP transport에 maxOutputTokens(default1024, explicit1..8192) 및 항상 max_tokens 전달을 추가했다. localhost실제body/5종ID/경계·mutation/상한초과usage회귀 RED20pass4fail→GREEN24/24(exit0). 공급자가상한을준수했다는보장이나hardcostcap/환불의미가아니다. 초과completionTokens 보고는 done없이 PROVIDER_OUTPUT_LIMIT 실패, 누락usage는unknown.
- default[] 서버 ORBIT_MODEL_HUB 설정파서와 exact project/destination/model/digest/confirmed gate를구현했다. deepfreeze·WeakSet trusted config, credential값없는env참조, constructor조회무통신, 모든메시지PII/credential검사focused13/13+type0. Bedrock/future실행은거절하고 registry만정직표시한다.
- SQLite요청/진단서비스, explicitCSRF POST, inertGET, allowlist교집합models, textstream·중단·재시작lost·동일request중복전송방지를연결했다. 원문prompt는별도DB필드에저장하지않고 response는safeText만보존하며 audit에는ID/status만남긴다. 응답DB갱신은200ms로제한한다.
- ModelHub처음단위검사는missingmodule로RED, HTTP처음은미구현route로RED. 구현후service4/HTTP1통과. Controller/HTTP/SSR관련합계27/27 및전체type exit0 확인. 실제외부서비스나인증정보를사용하지않았다.
- 독립리뷰P2: 기존128000byte예약이64000자CJK/JSONescape출력을수용하지못하는storagequota초과를재현했다. UTF16unit당최대6 JSONbytes+metadata를전송전에예약하도록수정,실제SQLite에bounded CJK이력을채운후추가network0으로거절하는회귀통과. 다른확정P1/P2는현재읽은service/config/HTTP범위에서없었다.
- 최종 Model Hub gate 1회: **전체303/303·타입·빌드 exit0, Windows24/24·32JPEG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-11B9Ee` (2026-10-25T15:31:19.661Z 시작). 초기·동의 전 mock통신0, models1·chat2, 개인정보 차단 시 증가0, hang interrupt 후 socket abort, refresh/restart 후 재전송0·동일 설정/이력 복구를 확인했다. 실제 AI·계정 조회·외부 HTTP0회.
- cleanupErrors0, 브라우저와 서버5개 종료·앱/mock 포트 닫힘·원본 fixture 보존. 메인 에이전트가31-model-hub-current PNG를 직접 확인했다. UI의 “요청 출력 상한”은 공급자 준수 여부 미확인을 명시한다. Bedrock·외부 서비스 인증은 미구현/미검증이며 전체 Goal은 미완료다.

## Planning 내보내기·피드백 진행 (2026-10-26)

- 저장 기획 id/revision/hash를 검증하는 MD/JSON export와 명시 CSRF POST 피드백을 연결했다. 피드백은 project→plan→Task→Run→workspace→Check를 검증하고 구조화된 상태/해시/시각/exit와 현재 변경 파일 목록만 포함한다. 모델 prompt/response, Check.output, 패치·명령·절대경로와 원시 예외는 제외한다. 질문·문서를 DB/이벤트에 새로 저장하거나 외부에 전송하지 않는다.
- 최초 service 테스트는 미구현 module로 exit1, HTTP 2개는 미구현 route404로 exit1. 독립 리뷰에서 fingerprint 실패가 예외 대신 sourceIssue로 돌아오는 경우 available=true가 되는 P2를 추가 회귀로 재현(5pass/1fail exit1), unavailable 처리로 수정해 service4+HTTP2 **6/6 exit0**, 타입검사 exit0를 확인했다.
- Markdown/JSON 내보내기는 알려진 개인정보/credential을 변조 없이 차단하며 사용자가 수동 인계 전에 검토해야 한다. 검출은 휴리스틱이고 승인 권한은 export로 전달되지 않는다. 일반 Markdown으로 무손실 표현이 불가능하면 exact canonical JSON envelope를 사용한다. 64k 초과 정상 문서·경계 credential·최종256KiB 회귀를 포함해 parser/serializer25개 통과.
- 최종 Planning gate 첫1회 **전체322/322·type/build exit0, Windows26/26·34PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-YvKUvq` (2026-10-25T15:56:33.043Z~15:58:18.034Z). 실제 Chrome 저장 MD346B/JSON602B는 서버 bytes와 같고 재파싱도 정확했다. 두 형식 UI 업로드·source=import 별도 draft 저장, 기존 승인/Task 보존, dirty export 비활성, refresh 복구를 확인했다.
- 실제 피드백 MD3813B는 화면 pre의 UTF-8 bytes와 같다. 과거 Check passed/exit0와 현재 canApprove=false/approvalCurrent=false를 구분하고, 질문 변경 시 이전 preview 폐기와 refresh 후 질문/preview 미복원을 확인했다. 질문 원문을 서버에 저장하지 않는다. 메인이33/34 PNG를 직접 확인했다.
- cleanupErrors0, 브라우저·서버5개 종료·제품/mock 포트 닫힘, 원본 fixture 보존. 실제 AI/계정조회/외부HTTP0, 로컬 mock만 models1·chat2. 전체 Goal은 미완료이며 다음은 D/K 승인 기반 안전 병합이다.

## 승인 기반 안전 병합 진행 (2026-10-26)

- 승인 source/checkset/approval와 현재 primary branch/base를 고정하고 같은 raw bytes로 별도 index·tree·단일 parent commit을 만든다. 후보 생성과 실제 반영은 서로 다른 사용자 승인이다. 반영은 native Git ff-only이며 완료 전 전체 bytes/index/HEAD를 확인한다. 원 source HEAD/index/files는 변경하지 않고 실패 후보와 durable intent는 보존한다.
- snapshot focused27/27, Git 최종14/14, service5/5, UI5/5와 실제 HTTP1/1 모두 exit0. 통합 중 Projects/Controller/HTTP/verification/sourcegraph/merge 관련41/41 exit0, 이후 발견한 P2는 해당 focused 검사로 다시 확인했다. 최신 타입검사 exit0. 실제 쓰기는 임시 Git fixture에서만 실행했다. 전체 suite/build/Windows browser는 아직 이번 변경에 대해 미실행이다.
- 독립 리뷰는 `merge.autoStash=true`가 검사 뒤 생긴 사용자 변경을 이동시키는 상황과 외부 `core.excludesFile`이 untracked를 숨기는 상황을 재현했다. autostash 이중 비활성화 및 외부 ignore 고정/설정 거절 후 두 회귀를 통과했다. 추가로 source ref lock, 후보 검증 뒤 변경, 현재 Run 필터로 과거 unknown을 숨기는 문제, UI 응답 유실 후 수동 재확인 경계를 회귀로 검증했다.
- 실제 HTTP 검사는 Node 검증 명령·리뷰 승인·후보 생성 때 primary 불변·명시 반영·ff 후 primary bytes와 ignored 파일 보존·source HEAD/index/bytes 보존·요청 재전송 무동작·미확정 격리와 관찰 복구를 확인했다. 합성 terminal Run을 사용했으며 AI 실행은 0회다.
- `.gitattributes`/filter/sparse/외부 ignore 등 지원하지 않는 Git 상태와 dirty·ignored 충돌은 거절한다. 외부 편집기/Git과 완전한 원자성, POSIX 실제 executable mode, 실제 사용자 저장소 병합은 미검증이다. 자동 stash/reset/rollback/retry/push는 수행하지 않는다. 전체 Goal은 미완료다.
- 후속 공식 native 검토에서 설치 CLI 0.164.0-alpha.11.1의 깨끗한 임시 설정은 `goals stable true`, `--disable goals`는 false로 확인됐다(각 exit0). 실제 restricted Solo의 Goal tool 노출/자동 후속 turn은 재현하지 않았다. 제품의 Goal 미연결 선언에 맞춰 readonly/write 시작 옵션에 명시 차단을 추가하고 Registry도 blocked_policy로 맞췄다. 정책 회귀 RED3pass/2fail→GREEN17/17 exit0. 현재 연결의 Goal을 실행하거나 계정/모델을 호출하지 않았다.
- 최종 동결 gate 첫1회 **전체358/358·type/build exit0·Windows29/29·37PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-MuuaOA` (2026-10-25T16:43:20~16:46:40Z). 후보 생성 당시 primary/source 불변, 별도 UI checkbox·버튼 승인 뒤 실제 primary ff 및 승인 raw bytes 일치, 원 source HEAD/index/bytes와 기존 두 primary fixture 보존, refresh/restart 후 같은 applied 기록·반복 반영0을 확인했다. root가 result/cleanup와 PNG35/37을 직접 확인했다.
- cleanupErrors0, 서버6개와 브라우저 종료, 앱50942/mock50941 포트 닫힘. 실제 AI/계정/외부 HTTP0. 기존 Planning 다운로드·재가져오기와 source graph/Model Hub 회귀도 통과했다. 전체 Goal은 미완료이며 다음은 F Automation의 저장 워크플로·명시 실행·중단/복구다.

## 로컬 워크플로 진행 (2026-10-26)

- 기존 server verification 설정·명령 preview·runVerification/Runner를 재사용한다. 최대12단계의 DAG를 고정 순서로 실행하며 첫 실패 뒤 후속 실행을 중단한다. 새 프레임워크나 AI 분배 엔진은 추가하지 않는다. immutable version·source/config-bound preview·별도 동의·SQLite intent/receipt·저장 quota·정제된8k/step 출력·lost 격리/관찰 후 해제를 구현했다.
- definition10개 RED→GREEN, service 최초 missingmodule RED→실제 Node4/4, HTTP 미구현404 RED→실제 Git/Node1/1. 추가 실제 프로세스 중단·source 변경·출력/저장한도 검사 후 service6+HTTP1 **7/7 exit0**. Controller/HTTP/verification 관련 묶음28/28 exit0(추가2개 전). source HEAD/index/파일과 primary 보존, AI Run0·실제 모델0을 확인했다.
- retry chain 분기와 recovered lost를 실패로 취급하던 경계를 각각 RED→GREEN으로 수정했다. lost의 종료 확인은 실패 증거가 아니므로 retryOf로 재시도하지 않는다. 이 RED 과정에서 새로 생성된 복구 서비스의 test teardown 누락으로 DB close 뒤 비동기 오류도 발생했으며, 해당 서비스도 종료하도록 fixture를 고쳐 최종7/7에서 재발하지 않았다.
- 서비스/HTTP/Controller 독립 리뷰에서 추가 확정 P1/P2는 없었다. UI 개발 중 1회 전역 타입 검사에서 아직 없는 component import 오류가 확인됐으며 전체 성공으로 집계하지 않는다. UI focused/type와 최종 전체/build/Windows browser는 별도 취합 중이다.
- UI 완성 후 root 전역 타입검사 exit0, Workflow UI/Studio/navigation12/12 exit0를 확인했다. 네 번째 fixture는 명시 exact CLI 경로에서만 허용하고 기존 세 fixture의 설정은 보존한다. 전용 서버 회귀3/3·nodecheck exit0. 최종 전체/build/Windows gate는 대기 중이다.
- 최종 동결 gate 첫1회 **전체382/382·type/build exit0·Windows32/32·40PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-VT6CNR` (2026-10-25T17:18:10.207Z~17:22:00.547Z). 실제 Node DAG 통과·exit7 실패/종속 skip·명시 retry attempt2·actual-start 확인 후 exit130 중단·3개 정의 버전 보존·refresh/restart 후 실행0을 확인했다. 기존2 primary/merge source 및 반영된 merge primary, 네 번째 primary/source HEAD·index·digest를 보존했다. root가 result/cleanup 및 PNG38/40을 직접 확인했다.
- 소유 서버7개는 각각 exit0 관측 후 종료됐다. 독립 PID 확인은 6개 ESRCH, 나머지 PID30784는 Windows SearchFilterHost로 재사용돼 EPERM이었으며 해당 다른 프로세스는 수정·종료하지 않았다. 앱55169/mock55168 ECONNREFUSED, 브라우저 closed=true/launched=false, cleanupErrors0. 실제 AI/계정조회/외부서비스0이며 Model Hub의 로컬 mock만 사용했다.
- 현재 로컬 workflow 수직기능은 검증 완료다. 예약 실행·외부 서비스 단계는 계속 미연결이며 전체 Goal은 미완료다. 다음은 G의 남은 Bedrock 선택형 adapter를 공식 인터페이스로 구현·진단하는 작업이다.

## 선택형 Bedrock CLI 진행 (2026-10-26)

- 공식 AWS CLI 2의 ListFoundationModels/Converse를 선택했다. CLI 미설치 환경에서 설치·SDK/프레임워크 추가·실제 AWS 호출·키 발급 없이 구현한다. 비스트리밍 텍스트, 고정 standard region/direct foundation ID, 프로젝트/model allowlist, 명시 동의, 단일 시도와 기존 privacy gate를 재사용한다. 교차 리전 profile·SSO/profile/metadata 인증·자동 전환은 미지원이다.
- Bedrock 설정 RED1pass/2fail→GREEN3/3, 기존 HTTP 설정 포함16/16·focused type exit0. 기존 HTTP 설정 canonical 순서를 유지해 digest가 바뀌지 않는 회귀도 확인했다. 미설치 서비스 RED→GREEN, 기존 Model Hub 포함 service/HTTP7/7. 통합 중 transport 모듈 작성 대기와 chat options의 union excess-property 타입 오류가 발생했으며 완료 주장에 포함하지 않았다.
- CLI 입력은 승인 후 소유 temp JSON을 이용하며 argv/SQLite/events에 원문을 넣지 않는다. 종료 후 제거·중단·lost/cleanup_required·명시 stopped attestation·정리 후 결과 불확실성 유지와 재실행 방지를 연결했다. old unresolved가 최근20개 뒤에 숨겨지는 P2를 RED2/3→GREEN으로 수정하고 복구 대상 우선 표시·전역 복구 metadata와 새 Bedrock 전송 차단을 추가했다. 실제 temp 파일+모의 CLI 응답 서비스5/5, HTTP cleanup1/1, UI6/6이 통과했다.
- 전용 네 번째 테스트 fixture grant에만 없는 CLI 목적지를 추가했다. 정상 RED→GREEN, fixture4/4 및 nodecheck exit0. missing runtime 진단은 BEDROCK_CLI_NOT_FOUND, chat은 MODEL_CATALOG_REQUIRED로 차단되며 요청 기록0·로컬 HTTP mock호출0·CLI 파일/디렉터리 미생성을 확인했다. 최종 전체/type/build/Windows browser 및 독립 리뷰는 진행 중이다.
- 독립 서비스/HTTP 및 native/process/temp 리뷰에서 추가 확정 P1/P2는 없었다. 자체 경계 검토에서 model accessor/deps root 변경과 겹치는 credential의 부분 suffix 노출을 각각 RED→GREEN으로 보강했다. root가 재시작 TEMP 변경 뒤 old input 잔존/removed 오표시를 RED4pass1fail로 재현하고, 승인 start transaction에 temp base를 저장해 chat/cleanup에서 재사용하도록 수정했다. 후속 서비스5+HTTP1 **6/6 exit0**, 전체 Bedrock 집중19/19·type exit0. 저장 root에 대한 별도 재리뷰도 추가 확정 P1/P2 없음.
- 타입 검사와 일반 사용자 로컬 build는 exit0. 실AWS CLI/인증/Converse/청구·원격 중단은 미검증이며 marker 누락/손상, 예상 외 파일·link는 자동 삭제하지 않는다. 전체 테스트와 Windows gate는 진행 중이다.
- 최종 동결 gate 첫1회 **전체405/405·type/build exit0·Windows33/33·41PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-esVqPJ` (2026-10-25T17:48:40.826Z~17:52:36.772Z). 명시 승인 뒤 실제 missing CLI 진단 실패, 모델 목록 empty·추가 동의 후에도 chat 비활성·request0, refresh/restart 후 같은 진단/자동 재시도0을 확인했다. root가 result/cleanup과 PNG41을 직접 확인했다.
- 이전 HTTP models1/chat2/중단1, Planning MD346B/JSON602B/feedback3813B, source graph/검증/승인/실제 ff 병합/Workflow의 실패·재시도·중단 회귀도 통과했다. 기존2 primary·merge source 및 승인된 primary·fourth HEAD/index/digest/ignored markers를 보존했다. 소유 서버8PID 모두 ESRCH, 앱60158/mock60157 ECONNREFUSED, 브라우저 closed=true/launched=false, cleanupErrors0. 실제 AI/AWSCLI/계정/외부 서비스0. `git diff --check` exit0.
- Bedrock 수직기능의 로컬 구현·검증을 완료했으며 전체 Goal은 미완료다. 다음은 공식 Codex review/start를 이용하는 별도 읽기 전용 AI 리뷰와 source-bound 검토 이력이다. 현재 Solo 외 모드 executor, Claude/Gemini adapter, PDF/추가 다이어그램, Extensions/보안등급/분석/예약 실행은 남아 있다.

## 공식 Native Review 진행 (2026-10-26)

- 로컬 설치 CLI의 stable JSON schema를 기준으로 fresh thread/start(read-only, ephemeral)→review/start(inline/custom)를 사용한다. detached delivery는 사용하지 않는다. 기존 Rpc/CLI 제한·denyRequest를 재사용하며 별도 새 SDK/오케스트레이션 의존성을 도입하지 않았다. 실제 native AI 호출 없이 fake RPC, 실제 임시 Git, 순수 입력 계약으로 구현한다.
- 입력 builder RED10→GREEN10, native protocol 최종15/15, UI4/4와 관련10/10 exit0. native 작성 중 Node strip-only에서 parameter property 문법 오류가 발생했고 explicit field로 수정했다. builder unknown/null narrowing 오류도 function declaration으로 수정한 뒤 type0을 확인했다. 성공한 테스트로 오류를 숨기지 않는다.
- service 최초 missingmodule RED→GREEN4/4, HTTP 최초404 RED→실제 Git/fakeRPC1/1. source 변경·응답 정제·완료 없음·중단·receipt·재시작 quarantine·복구·모델 재호출0과 Check/승인 미생성을 확인했다. 이후 durable intent 직후 변경/old unresolved history/quota 회귀 포함 service6/6. Registry contract 상태 회귀 RED→GREEN, 타입0.
- 독립 리뷰의 P2 두 건: (1) raw Diff가64k로 잘린 뒤 credential masking으로 짧아져 builder가 누락을 인지하지 못함, (2) 동일 요청의 JSON key 순서만 달라도 receipt 충돌. 실제 Git와 서비스에서 함께 RED6pass/2fail을 확인하고 rawpatch 크기를 마스킹 전에 제외 및 canonical receipt 해시로 수정했다. Projects/Controller/HTTP/review 관련 **39/39 exit0**.
- Native 자기검토는 null MCP configuration, 정상 결과 뒤 close 대기 중 abort, early queue/closure/persistence callback, 과도한 raw final review를 RED→GREEN으로 보강했다. 실제 초과 응답을 잘라 성공 처리하지 않는다. main Controller의 동일 null MCP 경계도 별도 RED→GREEN1/1로 맞췄다. 도구 실행이나 승인을 새로 허용하지 않았다.
- 브라우저용 exact6th grant에서만 네 번째 worktree의 readonly fake RPC를 허용한다. default/다른 프로젝트/write 경로는 계속 거절한다. fixture5/5·harness8/8·구문/type exit0, 예정 browser35/PNG43. 실제 native CLI/AI/계정/외부 요청0. 전체 테스트와 최종 Windows gate는 진행 중이며 전체 Goal은 미완료다.
- 최종 Native Review gate 첫1회 **전체445/445·type/build exit0·Windows35/35·43PNG**. 증거 `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-pRQaWi` (2026-10-25T18:20:03.545Z~18:24:43.047Z). exact preview/별도 동의·fake review 완료1·실제 mock start 확인 후 중단1, 새로고침/재시작 동일 이력·자동 연결/재실행0·Check/승인/Run 생성0을 확인했다. root가 result/cleanup 및 PNG42/43을 직접 확인했다.
- source HEAD/index/digest와 기존 fixture/승인 merge primary 보존, HTTP/Planning 다운로드/그래프/검증/병합/Workflow/Bedrock 회귀 통과. 소유 서버10PID 모두 ESRCH, app65276/mock65275 ECONNREFUSED, Chrome closed=true/launched=false, cleanupErrors0. 실제 native CLI/AI/AWS/계정/외부요청0. `git diff --check` exit0. 실제 native AI 리뷰 및 전체 Cross Review executor는 계속 미검증/미구현이다.
- Task17은 공식 읽기 전용 Extensions inventory부터 연결한다. 글로벌 설정 직접 탐색/쓰기, 플러그인 catalog 조회/설치, 권한 활성화 없이 기존 isolated session과 official list schema를 재사용한다. 프로젝트 profile preview/backup/restore는 이후 독립 수직기능이며 전체 Goal은 미완료다.

## Mac 인계 및 Extensions 진행 (2026-10-26)

- 사용자가 현재 작업을 Git에 보존하고 Mac에서 이어가도록 요청했다. 목표 원문은 docs/ORBIT-GOAL.md, 인계 절차·Windows 전용 Codex resolver·남은 구현·검증은 docs/HANDOFF-MAC-2026-10-26.md에 보존한다. 자동 후속 기능 개발 대신 현재 변경의 인계 검사를 수행한다.
- collector9/9·UI8/8·root Controller/HTTP6/6·Registry5/5를 구현했고 관련 통합53/53/type0을 확인했다. 독립 리뷰 도중 하위 에이전트들이 사용량 한도로 종료됐다. Task17 전용 browser37/45 계획은 미구현/미실행이다.
- root가 null workspace 읽기 전용 세션의 UI 조회 차단을 RED8pass1fail→GREEN9/9로 수정했다. Hooks handlerType 누락이라는 리뷰 주장은 설치 stable/experimental HookMetadata.oneOf 네 variant의 required 필드에서 반증했으며 검증을 약화하지 않았다.
- 중단된 exact7th inventory fixture를 완료했다. 신규 회귀의 초기 INVALID_REVIEW_FIXTURE_GRANT 실패 후 explicitconnect/metadata/cache/foreignscope/restart/DB 원문 미노출을 실제HTTP+fakeRPC로 확인해1/1 exit0. 기존 test 기대값의 Skills effective와 Hook 이름을 실제 DTO 계약(unknown/preToolUse)에 맞췄고 나머지 검사를 유지했다.
- 인계 시 실제 도구: Node v24.22.1, Git2.56.0.windows.3. 타입/build exit0. 첫 전체 실행은471중470pass/1fail(exit1): 기존merge-http의fetch ECONNRESET. 원인 확정 없이 성공 처리하지 않으며 해당 집중검사 및 동일 전체검사를 재실행한다.
- 인계 전체 재검사도471중470pass/1fail(exit1), 동일merge-http ECONNRESET. 집중merge-http1/1 exit0(25.2초). 원인은 미확정이며 테스트 삭제/완화/재시도 코드는 추가하지 않았다. 같은 전체검사를 concurrency4로 확인 중이다.
- 최종 인계 bounded 전체검사 `node --test --test-concurrency=4 tests/*.test.ts spikes/phase0/*.test.mjs`: **471/471·fail/skip0·exit0**(86.8초). 타입·build0, staged diff 공백 검사0. 기본 병렬 전체검사의 ECONNRESET은 미해결로 기록하며 Task17 전용 browser/Mac native 검증은 미실행이다. 추가 기능 구현 없이 인계 브랜치에 보존한다.

## Mac 재개: 런타임·회귀 (2026-10-26)

- 시작 branch `codex/orbit-mac-handoff-2026-10-26`, HEAD `23a9296b80c09f7b226478e8c2bc03dd4f7400ad`, dirty 없음. macOS 26.2 arm64, Git 2.50.1 (Apple Git-155), 기본 Node25.8.2는 engine 범위 밖이었다. 공식 Node24.22.1 darwin-arm64 배포본 SHA-256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` 확인 후 `.local/toolchains`에 설치했다. 시스템 Node는 변경하지 않았다.
- 최초 `npm ci`는 Node25 engine 경고 후 제한된 네트워크의 registry ENOTFOUND로 exit1. Node24와 허용된 registry 접근으로 `npm ci --cache .local/npm-cache --no-audit --no-fund` exit0(11 packages). esbuild postinstall 승인 미설정 경고는 있었지만 설치된 플랫폼 패키지로 아래 실제 build가 통과했다. lockfile 변경 없음.
- Mac PATH의 codex는 npm JS symlink였다. native 파일 검증(regular/executable/header), absolute PATH, npm nested/sibling/bundled vendor, native symlink와 명시 override를 구현했다. shell wrapper를 실행하지 않는다. Windows 파일/패키지 회귀와 격리 옵션은 유지한다. resolver RED3fail→GREEN5/5, native probe Mac RED→GREEN, 관련21/21·type0. 독립 리뷰의 Windows-host POSIX fixture 지적을 반영해 해당 OS 전용 케이스를 구분했다. 실제 Windows/Linux runtime은 이번에 실행하지 않았다.
- 설치 native `codex-cli 0.162.1`의 `--version`, readonly/write의 모든 restricted flag를 `features list`로 확인(exit0). 공식 `app-server generate-json-schema` exit0, `.local/capability-schema-mac`의 Skills/Hooks/thread-scoped MCP/Review schema를 확인했다. 모델·account RPC·인증 파일 접근은 하지 않았다. 실제 native 세션/리뷰/inventory 성공을 뜻하지 않는다.
- 첫 기본 `npm run verify`: type0, **477중415pass/61fail/1skip**, build 미도달. `.local/verification/mac-first-verify.log`. Mac `/var` OS temp alias를 no-link 정책이 거절한 실패가 다수였다. 같은 기본 병렬 전체검사를 canonical TMPDIR에서 진단: **471pass/5fail/1skip**, `.local/verification/mac-canonical-temp-diagnostic.log`. merge-http는 통과했고 ECONNRESET은 재현되지 않았다.
- 테스트 fixture의 OS temp root만 정규화하는 `tests/temp.ts`를 도입하고 생산 경로 보호는 유지했다. 실제 Bedrock 기본 temp root도 canonical OS 경로로 저장하도록 RED→GREEN 보완했다. 명시한 linked temp root는 계속 거절한다. E2E fixture의 `aws.exe`를 플랫폼별 이름으로 수정하고, kill 요청 후 소유 child exit/close 관찰 전에 완료를 반환하던 경합을 수정했다. 관련18/18 exit0.
- Task17 독립 리뷰에서 MCP 실패/transport 종료 뒤 server busy는 false지만 UI busy가 true로 남는 경로를 실제 Controller/reducer/AgentCenter로2/2 재현했다. `clearExtensions`의 unlock 이벤트 누락 회귀 RED→GREEN으로 수정했다. 이전 session의 지연 finally가 새 request를 해제하지 않는 기존 경계는 유지했다.
- 최종 기본 환경 `npm run verify` **exit0: type0, 전체480중479pass/1 Windows-only skip/0fail, build0**(tests22.6초). `.local/verification/mac-second-verify.log`. concurrency 변경·재시도·assertion 완화 없음. 기본 병렬 merge-http가 통과했지만 과거 Windows ECONNRESET의 원인이 해결됐다고 주장하지 않는다.
- Task17 전용 Chrome 수집/캐시·재시작 검증은 진행 중이다. agent-browser CLI는 이 Mac PATH에 없으므로 연결된 Chrome 도구와 동일 exact-grant fixture로 검증한다. 전체35/37단계 gate와 구분해 기록한다. 전체 Goal 미완료.

### Task17 Mac 브라우저·독립 검토 완료

- 연결된 Chrome CUA로 **전용 2시나리오·2JPEG**를 확인했다. 증거 `.local/ui-e2e/mac-task17-tMEmcL/result.json` 및 `screenshots/01-extensions-collected.jpg`, `02-extensions-restarted.jpg`. 실제 제품 Controller/HTTP/SQLite/UI와 exact seventh-grant fake RPC를 사용했다. 제품 연결은 created1/MCP1/Skills0/Hooks0, 명시 조회 뒤 MCP2/Skills1/Hooks1이었다. 연속 조회·캐시 새로고침·브라우저 reload 후 같은 계수와 목록을 유지했다.
- Skills 버전·실행은 unknown, Hook configured enabled와 blocked execution·native trust 별도, MCP disabled override·Plugins 미연결을 화면에서 확인했다. 합성 금지 원문 marker와 로컬 경로는 화면/cache에 없었다. 실제 AI/CLI/외부 요청0, 금지 RPC0이다.
- 서버 재시작 후 모든 RPC 계수0, disconnected·목록 unknown·조회 버튼 비활성으로 복원했다. primary/source HEAD·index·digest는 baseline과 동일하며 DB/WAL/SHM에 합성 금지 marker가 없었다. 소유 서버2개 exit0 관찰·loopback 포트 종료·브라우저 탭 종료, cleanupErrors0. 서버를 분리하려던 `/app.css` 이동은 Chrome client가 차단하여 `about:blank`로 전환했다. 제품 화면에서 수집한 console 경고/오류는0이었다.
- `scripts/verify-orbit-ui.mjs`에 같은2단계 및 seventh grant·IPC counters·DB 원문 부재·기존 fixture 보존 검사를 추가했다. 총37단계/예정45PNG이며 구문·diff 공백 검사 exit0, 관련 **39/39 exit0** (`.local/verification/task17-final-focused.log`). 독립 최종 리뷰 추가 지적 없음, 리뷰어 focused3/3·구문0. **전체37단계 자동 브라우저·Windows 재검증·실제 native inventory는 미실행**이다. Mac 전용2시나리오를 전체 통합 pass로 집계하지 않는다.
- 전체 Goal은 미완료다. 다음 수직기능은 기존 Planning 버전의 차이·영향 Task를 표시하고 명시 승인 후 후속 Task를 만드는 재계획 경로이다.
- 보존 직전 기본 `npm run verify` 재실행도 **type0·479pass/1skip/0fail·build0**, exit0(22.3초)이었다. 로그 `.local/verification/mac-task17-final-verify.log`. CUA screenshot은 실제 JPEG bytes여서 최초 PNG signature assertion이 실패했으며 파일명을 `.jpg`로 정정하고 증거 hash를 기록했다. 픽셀 변환은 하지 않았다.
- 검증된 Mac/Task17 변경은 로컬 커밋 `4c303ff`로 보존했다. 원격 push는 하지 않았다. Git이 현재 시스템 이름/호스트 기반 committer를 자동 설정했다는 안내를 출력했으며 전역 Git 설정이나 커밋 저자 정보를 변경하지 않았다.

## Planning 버전 비교·후속 Task 진행 (2026-10-26)

- 기존 불변 버전과 Studio transaction/receipt를 재사용한다. 같은 lineage의 저장된 이전 버전과 내용·요구사항·영향 Task를 비교하고, 현재 승인된 head와 preview digest가 일치할 때1–100개의 선택한 요구사항에만 후속 Task를 만든다. 기존 Task/Run/승인과 코드를 변경하거나 모델을 실행하지 않는다. 새 Task에는 이전 기획/Task 식별자만 연결한다.
- 순수 비교17/17 RED→GREEN. Studio의 미구현 compare 경로4fail→4pass, HTTP404→1pass. 합계 **22/22 exit0**, `.local/verification/planning-revisions-focused.log`. draft/stale/foreign/질문/잘못된 선택 차단, 부분 생성 후 전체 생성의 ID·provenance 보존, 재시작 receipt·JSON/선택순서 멱등성, rollback과 audit 원문 미포함을 확인했다. UI·전체 검증·독립 리뷰는 진행 중이다.

### Task18 최종 로컬 검증

- 최종 `npm run verify` exit0: **516 total / 515 pass / 1 Windows-only skip / 0 fail**, type0·build0,22.5초. 로그 `.local/verification/planning-revisions-final-verify.log`. 이전 전체 실행도514pass/1skip/0fail이었다.
- preview 이후 이전 Task가 추가되면 승인할 provenance가 달라지므로 base/target 전체 Task 식별자를 digest에 포함했다. 영향 없는 label도 stale preview를 거절하는 회귀 RED→GREEN. 선택 순서·JSON key 순서가 달라도 request receipt를 재사용한다.
- 독립 리뷰 P2 두 건 수정: (1) 유효한256KiB 미만 입력이 저장 JSON 확장 후 외부 입력 크기 제한에 걸리던 오류는 저장 구조 정규화로 분리하고 exact canonical/hash 검증을 유지했다. compact JSON/escaped Markdown262143B 회귀2건 포함 parser/export/comparator44/44. (2) 이전 Task가 없다는 이유로 새 요구사항으로 표시하던 오류는 실제 Studio/SSR 회귀로 재현 후 “연결된 이전 Task 없음”으로 수정했다. UI/service/provenance16/16.
- 전용 Chrome CUA 증거: `.local/ui-e2e/mac-task18-B9GhIA/result.json`, `screenshots/01-draft-comparison.jpg`, `02-selected-followup.jpg`, `03-restored-comparison.jpg`(실제JPEG3개·SHA256 기록). draft 생성 차단→승인 시 preview 초기화→재비교→R1만 선택+별도 동의→1개 후속 Task 생성→전체 생성으로 R3만 추가→reload/server restart 후4개 Task·기존 ID·predecessor 연결 보존을 확인했다. 재시작 후 consent 미복원·중복 생성 차단.
- primary/source HEAD·index·digest 및 이전 Task 원본 동일, model/run/nativeCLI/외부요청0, console warning/error0. 소유 서버2개 exit0·loopback 포트 종료·탭 종료·cleanupComplete true·cleanupErrors0. 최초 브라우저 exact label 조회는 DOM의 combobox locator로 해결했고, ignored host의 중복 binding 구문 오류는 실행 전에 수정했다.
- Task18 전용 Mac 검증이며 전체37단계 자동 E2E와 Windows 최종 gate를 대신하지 않는다. decisions/전체 가져오기 출처 metadata·선택적 AI 기획 등 전체 Goal 미완료 항목은 계속 진행한다.

- Task18 검증 변경은 로컬 커밋 `278ef12`로 보존했으며 원격 push는 하지 않았다.

## Task19 기획 결정·출처 metadata 진행 (2026-10-26)

- 기존 v1의 optional decisions/provenance를 확장해 legacy hash를 유지한다. Root는 shared/실행/비교/통합, 독립 작업자는 parser/export 및 UI를 담당한다. 출처는 사용자 입력의 미검증 metadata이며 링크를 방문하지 않고 실행 명세에 포함하지 않는다. 결정 내용과 이유는 승인된 실행 명세에 보존한다.
- 실행/비교 회귀32개 중29pass/3fail로 미지원 경로를 확인했다(`.local/verification/planning-metadata-root-red.log`). Studio persistence 회귀2개도 UNSUPPORTED_DECISIONS로 실패했다(`planning-metadata-service-red.log`,exit1). 구현·전체 검증·브라우저 검증은 진행 중이다.

### Task19 최종 로컬 검증

- 결정 주제·내용·근거(최대100개)와 source kind/provider/원문URL/작성자/참고 링크(최대50개)를 정규화해 보존한다. 기존 absent 필드와 hash는 변경하지 않는다. 결정이 불완전하면 저장만 가능하고 승인은 차단된다. 결정 변경은 모든 이전 Task의 기획 맥락에 반영하며 승인된 실행 brief에도 포함한다. 출처는 미검증 사용자 입력이며 실행 prompt에서 제외하고 URL을 요청하지 않는다.
- Parser/export 신규15개 RED3pass/12fail→focused40/40; UI 신규5개 RED→기존 포함19/19. 새 필드 export 개인정보 검사를 잠시 제거한 mutation check에서2개가 예상대로 실패한 뒤 원복했다. 초기 full539pass/1skip과 mutation 확인 시간이 겹칠 수 있어 동결 후 재검사했다.
- 최종 `.local/verification/planning-metadata-frozen-verify.log`: **540total / 539pass / 1 Windows-only skip / 0fail**, type0·build0·exit0,23.2초. 실행/비교/실제SQLite 보존·legacy hash·불완전 결정 차단 회귀 포함. 독립 최종 리뷰 추가 지적 없음.
- 전용 Chrome CUA `.local/ui-e2e/mac-task19-JCR8SF/result.json`, `screenshots/01-decisions-and-source.jpg`, `02-approved-followup.jpg`, `03-restored-metadata.jpg`: 결정·근거와 사용자 제공 출처 표시, active link/image0, 결정 변경의 영향 Task1개, 승인→선택 후속 생성→reload/restart의2개 Task·출처·결정 보존. 기존 Task 및 primary/source HEAD·index·digest 동일.
- 제품 JSON 다운로드 버튼의 event wait는10초 timeout이었으나 예상 Downloads 파일을 확인했다. 실제813B JSON을 다시 parse한 결과 저장 승인본과 정확히 일치했고 SHA256 `274ce4c24e223db88bac12ed801d715f4c7229c9a95a02913dfc1cbe88076569`; 증거 `downloaded-plan.json`, `download-evidence.json`. 각 단계의 HTTP JSON/Markdown export도 모든 metadata 보존 확인.
- AI/nativeCLI/외부요청0, Run0, console warning/error0. 소유 서버2개 exit0·port 종료·tab 종료·cleanupComplete true·cleanupErrors0. dedicated Mac 범위이며 전체 자동/Windows E2E를 대체하지 않는다. 전체 Goal과 선택적 AI 기획·나머지 A–K 기능은 미완료다.

- Task19 검증 변경은 로컬 커밋 `aceedc9`로 보존했으며 원격 push는 하지 않았다.

## Task20 선택형 네이티브 기획 제안 진행 (2026-10-26)

- 설치된 0.162.1 stable schema와 공식 App Server 문서에서 ordinary `turn/start`의 `outputSchema`와 `agentMessage final_answer`를 확인했다. 실험 collaborationMode에 의존하지 않는다. 새 세션·읽기 전용·MCP 격리·승인 거부, 도구 이벤트/외부 phase 차단, 단일 turn/60초와 종료 관찰 계약을 구현 중이다. native 파일 읽기·컨텍스트·보존·전송을 gateway가 통제한다고 주장하지 않는다.
- 입력 원문은 preview/start 요청에서만 사용하고 SQLite/audit에는 digest와 lifecycle·검증된 proposal만 저장한다. 별도 save는 Studio의 결정적 receipt를 사용해 crash/응답 유실 후 같은 미승인 초안을 복구한다. 자동 승인·Task·Run은 없다.
- 입력 최초 missing-module5RED→5GREEN; 서비스5RED→5GREEN. 추가 decoded C0 edge가 trim으로 숨겨지는 회귀1RED→GREEN으로 원본 decoded 문자열을 정규화 전에 검사했다. 현재 input/service11/11. Registry 신규1RED→GREEN; 기존 Controller 포함30/30. native initial17RED→19GREEN, 기존 review 포함34/34; UI12/12, 관련34/34. production page embed SSR은 미연결 RED를 먼저 확인했다.
- 독립 리뷰에서 thread/start의 실제 cwd/ephemeral/provider attestation 누락과 Rpc error가 close 증거로 취급되는 경계를 발견했다. 담당 작업자가 회귀와 수정을 진행 중이며 전체 성공으로 표시하지 않는다. 실제 모델 호출0; 전체/type/build/브라우저 최종 결과는 후속 기록한다.

### Task20 최종 로컬 검증

- 입력6/service8/native21/HTTP7/UI13/페이지 연결1/Registry1/Rpc close3 신규 회귀를 포함한다. 추가 독립 검토에서 발견한 (1) 실제 cwd/ephemeral/OpenAI provider 확인, (2) kill error를 close로 간주하던 Rpc 종료 증거, (3) 배경 SQLite UPDATE 실패의 미관찰 rejection, (4) 영수증 재확인 시 approved→draft UI 회귀를 보완했다. 각 실패를 재현했고 최종 독립 검토 추가 지적 없음. SQLite 실패는 메모리 lost 격리로 노출하고 durable 복구 저장 성공 후에만 해제한다.
- 처음 동결된 전체검사 `.local/verification/native-planning-frozen-verify.log`는599total/598pass/1skip/0fail/type0/build0. 브라우저에서 Orbit 생성 출처까지 사용자 입력이라고 표시하던 문구를 발견해 공통 미검증 출처 표기로 수정하고 UI 회귀를 추가했다. 최종 `.local/verification/native-planning-final-verify.log`: **600total / 599pass / 1 Windows-only skip / 0fail**, type0·build0·exit0,24.0초. 원래 UI 테스트의 setImmediate 해시 완료 가정은 실제 POST 신호로 대체해 중복클릭 assertions를 유지했다. HTTP test의 unknown Studio.read 타입 오류5건도 명시적 반환형으로 수정 후 type0.
- dedicated Chrome CUA 증거 `.local/ui-e2e/mac-task20-POGrI1/result.json`와4JPEG: preview까지 RPC0/plan0 → 별도 동의 후 완료 proposal1/plan0 → 명시 save로 draft1/기존 dirty 편집 유지 → 별도 승인 후 receipt 재확인해 approved 보존 → reload/server restart 동일 version/모델 재호출0 → 소유 fake turn 중단/close → restart intent lost 격리 → unchecked recovery 차단/별도 종료 확인 후 lost 유지·격리 해제. UI 출처 문구 수정 후 reload 재확인.
- fake RPC created2/turn2/interrupt1/closed2, 실제 AI/nativeCLI/외부요청0, Task0/Run0. primary/workspace HEAD·index·source digest/text 동일. 시작 시 proposal save는 draft였고 이후 테스트의 명시 승인만 approved로 변경했다. 브라우저 warn/error0, 소유 host exit0·loopback 포트 종료·tab 종료·cleanupComplete true/errors0. screenshot 실제 JPEG signature·SHA256 기록.
- ignored browser host 첫 실행은 read-only Projects로 source fingerprint를 요청해 WRITES_DISABLED로 종료했다. 제품 권한을 바꾸지 않고 fixture 전용 증거 객체를 분리했다. 다음 비대화형 host는 stdin EOF로 즉시 정상 종료해, PTY 소유 host에서 위 시나리오를 진행했다. 이 예비 실행을 브라우저 성공으로 집계하지 않았다.
- 현재 Mac dedicated 검증이며 전체37단계 자동/Windows E2E 및 실제 Codex 모델 기획은 미검증이다. 전체 플랫폼 Goal은 미완료로 유지한다.

- Task20 검증 변경은 로컬 커밋 `a4518fc`로 보존했으며 원격 push는 하지 않았다.

## Task21 프로젝트 사용량·실행 통계 (2026-10-26)

- 기존 SQLite의 Run, Model Hub 요청, native 기획·리뷰, workflow와 실제 Check를 프로젝트 소유권에 따라 집계했다. 이벤트·receipt·기획 저장은 추가 실행으로 세지 않는다. `GET /api/projects/:projectId/analytics`는 인증된 읽기 전용이며 파일 fingerprint·모델·계정 조회를 실행하지 않는다. 기본25/최대50개 keyset 페이지와 전체 집계·측정 커버리지를 분리한다.
- Codex 수집은 기존 연결의 passive `thread/tokenUsage/updated`를 사용한다. 설치된 stable schema와 공식 OpenAI 소스에서 `last`는 최근 증가분, `total`은 thread 누적 관찰값임을 확인했다. 초기 기준값은 추정하지 않으며 첫 작업은 unknown이다. 같은 연결의 유효한 이전 관찰이 있으면 누적 차이를 표시하고, 재전송·누락·역전·foreign turn·늦은 이전 작업 변경·합성/비정상 counter는 보수적으로 처리한다. 실제 청구량이나 완전한 최종 합계라고 주장하지 않는다.
- 실제 `turn/start` 응답의 thread/turn 소유권, 최대128개 projected pre-ack 사실과 최근128개 종료 기록을 사용한다. 모델은 기존 handshake에서 확인하고 변경 시 귀속을 미확인으로 둔다. 늦은 사용량은 별도 `run_metrics`에 기록하며 Run 종료 상태·응답·종료 시각을 변경하지 않는다. 로컬 monotonic 시간은 작업 경과 시간이며 lost/legacy는 unknown이다. 재시도 알림은 관찰 횟수이고, 정확한 재시도는 workflow의 검증된 연결만0/1로 센다.
- 저장 실패 시 metrics 전용 메모리 불완전 상태를 노출하고 성공적인 후속 저장에서 해제한다. metrics-only 실패로 코딩 완료나 Store 재시작을 막지 않는다. 재시작 lost Run은 stale 측정값을 사용할 수 없다. 전체 저장 실패 중 발생한 메모리 상태는 재시작을 넘어 보존할 수 없으므로, 오래된 저장 관찰의 시각과 부분적 측정 범위를 유지한다.
- 공개 projection은 ID·고정 상태·숫자·시각·안전한 모델 식별자만 포함한다. prompt/response/proposal/command output/path/endpoint/native thread ID는 제외한다. 모델에 들어온 URL·Windows 경로·IP·credential/개인정보 패턴도 미확인으로 처리한다. 계정 전체 구독 사용량과 API 토큰 관찰은 구분하며 비용은 unknown이다. 실행 완료와 과거 Check 통과·현재 소스 승인도 구분한다.
- RED→GREEN: 집계9, HTTP1, Controller/복구5, native telemetry18, UI11 신규 회귀. 독립 리뷰에서 모델 이름 경로 노출, lost recovery 분리 쓰기, pre-ack 종료 시간, metrics 저장 실패, 늦은 비정상 이전 관찰의 후속 작업 귀속을 찾아 보완했다. 최종 독립 리뷰 추가 지적 없음.
- 최초 전체 검사는 동료 작업자의 RED 회귀 추가 시점과 겹쳐 `641total/638pass/2fail/1skip`(late loss timing, pre-ack retry unknown)였으며 빌드로 진행하지 않았다. 동결 후 `.local/verification/project-analytics-frozen-verify.log`: **644total / 643pass / 1 Windows-only skip / 0fail**, type0·build0·exit0,23.9초. 최종 안내 문구 반영 후 전체 재검사와 Chrome 증거는 아래에 이어 기록한다.
- 집계는 전체 canonical 기록을 읽으므로 보존 이력과 모델 그룹 수에 따라 비용이 증가한다. 페이지 결과는 bounded지만 Run/Check 보존량 자체에 새 임의 제한을 두지 않았다. 실제 native 모델 토큰 이벤트·외부 제공자 실서비스·전체37단계/Windows 최종 gate는 미검증이다.

### Task21 최종 로컬 검증

- 최종 안내 문구 포함 `.local/verification/project-analytics-final-verify.log`: **644total / 643pass / 1 Windows-only skip / 0fail**, type0·build0·exit0,23.9초. 핵심 신규44개 회귀와 기존600개를 함께 실행했다.
- 전용 Chrome CUA 증거 `.local/ui-e2e/mac-task21-0Z2678/result.json`, `screenshots/01-project-summary.jpg`, `02-project-isolation.jpg`, `03-paged-history.jpg`, `04-restored-summary.jpg`: Atlas35개/관찰416, 25→35개 페이지·합계 불변, Boreal1개/777의 프로젝트 격리, 명시 새로고침25개 복귀, 새 서버 프로세스/같은DB/reload 후35개·416·측정 시간·과거 Check2개·workflow 재시도2 보존을 확인했다. provider disconnected 상태에서도 조회 가능하고 계정 refresh는 disabled다.
- 원본 fixture 두 저장소 HEAD/README 동일, fake native2turn/계정조회0/실제 AI·CLI·외부요청0, console warning/error0. 실제JPEG4개 크기/SHA256 기록. 소유 서버2개 exit0·loopback65134 종료 확인, Chrome423251661 종료, 양쪽 cleanupComplete true. 자동 승인 심사가 일시적으로 사용량 한도를 보고하여 evidence용 stdin 명령1회가 실행되지 않았으나 이후 동일 tool의 종료/재시작 검증이 성공했다. 우회 실행하지 않았다.
- 전용 Mac 시나리오이며 전체 통합/Windows E2E를 대신하지 않는다. 이 수직기능 완료는 전체 A–K 플랫폼 Goal 완료가 아니다.

- Task21 검증 변경은 로컬 커밋 `ff99b88`로 보존했으며 원격 push는 하지 않았다.

## Task22 시퀀스 다이어그램 (2026-10-26)

- 기존 `mermaid` Artifact와 exact-source hash를 재사용해 명시 참가자/actor, 실선·점선·자기 호출, 메모, autonumber, 활성 구간과 alt/opt/loop/par를 추가했다. 기존 `parseMermaid` 반환 형식은 유지하고 새 document dispatcher를 사용한다. 외부 Mermaid 런타임·제공자 호출·의존성은 추가하지 않았다.
- 시퀀스 AST와 고정 box/line/label 도형 계약을 분리했다. SVG와 실제 PPTX가 같은 페이지 배치를 사용하고, 참가자·활성 구간·분기 문맥을 페이지마다 이어 표시한다. 시퀀스 PPTX는 point 좌표의 여러 페이지이며 legacy 흐름도의 16:9 출력은 유지한다. 화면과 저장 경계가 배치 한도를 먼저 검사한다.
- 저장된 파일 내보내기는 원문 해시와 프로젝트/ID를 재확인한다. 독립 리뷰의 SQL revision1 / JSON revision2 재현을 RED로 확인한 뒤 이력 읽기에서 SQL·JSON 식별자/버전 일치를 검사하도록 수정했다. `ARTIFACT_INTEGRITY`409는 Markdown/PPTX 반환 전에 발생한다.
- 현재 확인한 증거: parser18, 새 presentation/PPTX6, 기존 PPTX6 =30/30 통과. Studio/legacy visualization/layout40개 초기 실행은 legacy flowchart의 `direction` 필드를 구조 입력으로 넘긴 회귀2건으로38pass/2fail이었고, 명시 nodes/edges projection으로 수정 후40/40 통과. SQL revision 회귀 추가 후 Studio HTTP11/11 통과. 타입 검사 exit0. 전체 최종 검사는 아직 실행 전이다.
- 첫 실제2페이지 PPTX는85,879bytes, SHA256 `4a499aa5f194f8365cd404af86d1b838195b47f05a3a48e6ec11cb0598a3fca6`; bundled package/geometry 검사 finding0, import 성공, 두 페이지 PNG를 생성하고 확인했다. 최초 importer 실행은 `RUNTIME_NODE_MODULES` 환경 누락으로 실패했으며 설정 후 통과했다. 증거 `.local/verification/sequence-qa/build/validation.json`, `output/page-1.png`, `output/page-2.png`. 이 파일은 최종 배치 수정 이전의 중간 검증이며 최종 출력으로 보고하지 않는다.
- 독립 리뷰에서 OOXML slide 최소914400EMU(72point) 미달 입력, grapheme 분리 줄바꿈, shorthand 활성 구간의 메시지 경계 불일치를 발견했다. 최소 크기 RED→GREEN 완료; 글자·활성 구간 및 화면 폭 개선은 진행 중이다. 최종 독립 리뷰·실제 브라우저·전체 verify·로컬 커밋이 남아 있다. C4/기타 UML/PDF와 전체 플랫폼 Goal은 미완료다.

### Task22 최종 로컬 검증

- 위 중간 상태의 남은 수정 완료: Intl.Segmenter로 결합 문자·ZWJ emoji를 분리하지 않고 줄바꿈한다. 인접 activate/deactivate는 해당 메시지의 실제 화살표 경계와 맞추며 페이지 경계에서도 보존한다. 짧은 메시지 배경이 활성 막대를 가리지 않도록 좁히고, 보통 2참가자 화면은900point부터 시작하도록 폭을 조절했다. 키보드 스크롤과 명시적 페이지 한도 오류도 검증했다.
- 집중 신규40개(parser18/layout·UI14/presentation6/HTTP2)와 기존644개를 함께 실행했다. `.local/verification/sequence-frozen-verify.log`: **684total / 683pass / 1 Windows-only skip / 0fail**, type0·build0·exit0,24.3초. 페이지 한도 HTTP 저장 차단 assertion 추가 후 `.local/verification/sequence-final-verify.log`: **684total / 683pass / 1skip / 0fail**, type0·build0·exit0,24.2초. 기존 flowchart/Architecture/PPTX/Studio 회귀도 포함했다.
- 독립 최종 리뷰: actionable finding 없음. reviewer가 parser/layout/presentation/legacy PPTX44개를 별도로 실행해44pass/0fail/exit0을 확인했고, 소유한 메모리 SQLite에서 layout-limit create/revise 차단, canonical revision 및 malformed JSON 차단도 확인했다.
- 극단 입력: 10actor×160자 레이블+120긴 자기 호출은24페이지/2304도형/471641JSON bytes, 4중첩+24긴 메모+88긴 자기 호출은30페이지/3098도형/661807bytes로 원문 전체를 보존했다. 더 큰 반복 분기 문맥은32페이지 한도 오류로 처리하며 UI 부분 SVG나 DB 기록·이벤트를 만들지 않는다.
- 최종 실제 PPTX `.local/verification/sequence-qa/output/v2/sequence-qa.pptx`: **2페이지, 85,808bytes, SHA256 `fc01db94def1ff35ef93be3a507df21a6b8c88e96d49da552300b916c9bef7c5`**. 최종 package/geometry finding0, bundled importer 성공, 두 페이지 PNG 렌더/시각 확인. `.local/verification/sequence-qa/build/v2/editability.json`:49개 editable textbox와55개 native line shape를 인식했고, 별도 복사본에서 참가자 텍스트를 수정→PPTX 재출력→재가져오기 후 수정값 보존을 확인했다. 제품 출력 원본은 변경하지 않았다. PowerPoint/Google Slides 자체 편집 실행은 미검증이다.
- 실제 Chrome CUA `.local/ui-e2e/mac-task22-hO4d5B/result.json`: 예제 저장v1, 긴 원문 수정v2/2페이지, dirty export disabled, 이전 버전 exact 원문 복원, 다른 프로젝트에 Artifact 없음, 새 서버 프로세스+같은DB+reload 후 원문·페이지·이력·내보낸 bytes 동일, 위험 문법 save/export disabled 및 SVG 없음 확인. Downloads의v1/v2 PPTX·MD4개를 서버 export와 byte-for-byte 비교했고 각각 SHA256을 `download-checks.json`에 보존했다.
- 브라우저 download-event 대기1회가 timeout되어 CUA kernel이 초기화되었다. fresh UI와 알려진 파일 경로에서 실제 성공을 확인했으므로 성공/실패를 추정하지 않았다. 실제 JPEG5개를 저장했고 console warn/error0, native factory0·실제AI/CLI0·Run0, fixture원본HEAD/status/README 동일이다. 서버PID67969/68105 종료exit0·loopback50234 닫힘, Chrome423251671 종료, cleanupComplete true.
- 전용 Mac 기능 시나리오이며 Windows 최종 gate/전체37단계/실서비스 검증을 대신하지 않는다. C4/기타 UML/PDF와 전체 A–K Goal은 계속 미완료다.

- Task22 검증 변경은 로컬 커밋 `6957fb5`로 보존했다. 원격 push는 하지 않았다.

## Task23 C4 구조 뷰 (2026-10-26, 진행 중)

- 공식 C4 정의와 기존 코드 재사용 가능성을 독립 조사했다. Context/system, container/system boundary, component/container+parent system boundary 및 sibling container 포함 규칙을 고정했다. 새 `c4-v1` 원문·`c4` Artifact kind로 수동 작성 모델을 보존하고 소스 코드 검증으로 표시하지 않는다.
- root가 공유 타입·Studio/HTTP·presentation을 소유하고 parser/layout 에이전트가 독립 모듈을 담당한다. 새 패키지/외부 렌더러/실제 모델 실행 없이 기존 SVG/PPTX 고정 도형을 `canvas-v1`으로 재사용한다.
- generic canvas 지원 RED(1fail/1pass) 후 관련 PPTX14/14 GREEN. 공통 SVG RED2 이후 새 SSR2+기존 시퀀스14=16/16 GREEN. C4 HTTP 최초 RED는 기대200에 실제400이며 아직 최종 통합 검증 전이다.
- 기존 Task22 최종 제품 PPTX를 현재 코드로 다시 생성해 byte-for-byte 비교했다:85808bytes, SHA256 `fc01db94def1ff35ef93be3a507df21a6b8c88e96d49da552300b916c9bef7c5`, 동일함. 공통 도형 추출이 기존 시퀀스 파일 bytes를 변경하지 않았다.


### Task23 최종 로컬 검증

- context/container/component 입력 검사26개와 배치/UI12개, generic canvas2개, 공통 SVG4개, Studio HTTP3개 회귀를 추가했다. 최대12요소/24관계/256KiB, exact fields·부모/범위/leaf endpoint·형식/Unicode/숨은 제어문자 검증을 저장 전에 적용한다. 관계의 서로 다른 포트와 경로를 보존하고 collinear 공유 구간을 금지한다. 수직 교차는 연결이 아님을 범례에 명시한다.
- 36개 배치 후보에 걸친750,000 work-unit 예산과3600×1200point 상한을 사용한다. 짧은12요소/24관계와 역방향 밀집 입력은 약5.3–5.5ms에서 명시적 `C4_LAYOUT_LIMIT`으로 거절했고, 세 예제는약3.4–4.1ms에 전체 배치됐다. 지원 문법이어도 전체 내용을 배치할 수 없으면 부분 SVG/저장/이벤트를 만들지 않는다. 이는 모든 기기에서의 실행 시간 보장은 아니다.
- 독립 리뷰 수정: sibling container의 선택 범위 밖 색상, 공유 직선 구간의 방향 모호성, Cf 숨은 제어문자,48pt 라벨의22px 고정 줄간격, legacy 문서의 고정 canvas renderer 오진입을 회귀 재현 후 보완했다. 최종 C4 리뷰 추가 지적 없음. reviewer 별도88tests pass/exit0,36개 geometry probe 중34개 완전 배치·2개 명시 한도 거절·assertion 실패0. 메모리 SQLite rollback/history/project isolation도 확인했다. reviewer의 HTTP 실행은 loopback EPERM으로 제한됐으며 root 전체 gate와 브라우저에서 검증했다.
- 첫 동결 전체검사 `.local/verification/c4-frozen-verify.log`:731total/729pass/1fail/1skip, type0, build 미실행. 기존 `E2E mock native review requires a sixth exact grant...`의 첫 review preview가403이었다. 단독 재실행은 통과했다. 원래 실패의 UUID/SHA가 보존되지 않아 그 표본의 원인을 단정하지 않는다. 별도 결정적 probe에서는 정규 UUID/Git 해시의 숫자 구간이 전화번호/식별번호로 오탐되어 같은403이 발생함을 확인했다.
- Native Review 보완: 모델에 필요 없는 workspaceId/baseSha를 outbound JSON에서 제외했다. UUID/SHA 형식 검증, 실제 전송 files의 경로/status/patch 개별·결합 검사, 로컬 previewDigest의 project/workspace/run/base/source/input 결속은 유지한다. RED4fail→관련34pass/exit0. 동일 숫자 문자열이 path/patch에 있으면 계속403이며, 동일 diff의 다른 workspace 또는 변경된 base에 이전 승인을 재사용하면 STALE·runner0이다. 개인정보 패턴의 전역 예외나 검사 제거는 없다.
- 첫 수정 후 `.local/verification/c4-final-verify.log`:733total/732pass/1 Windows-only skip/0fail, type0·build0·exit0,24.3초. 교차 workspace 회귀를 포함한 최종 `.local/verification/c4-reviewed-verify.log`: **734total / 733pass / 1 Windows-only skip / 0fail**, type0·build0·exit0,24.5초. 추가 독립 보안 리뷰19pass/exit0·추가 지적 없음.
- 실제 제품 PPTX 세 종류 `.local/verification/c4-qa/output/v2/{context,container,component}/c4-qa.pptx`를 생성했다. 각각1페이지이며 context29416bytes/SHA256 `f6132e4a5a23fba8351d977eb7a33595c962a309f8ec96103cad7382bad65871`, container48012bytes/`e06ff6e6becc6c48ef4fa14f31c85b37ba5c280049694e3faf6179ff9ec5e948`, component52771bytes/`75f69b5554ca743ea0e7f5b788d0456b11cd20335fbba34629bd074133fac933`이다. bundled package/geometry finding0·warnings0, import/render 성공, 최종PNG3개를 시각 확인했다.
- editable textbox/native line은 각각14/14,31/20,35/25개다. 각 별도 복사본의 Orbit 텍스트를 수정→PPTX 재출력→재가져오기하여 변경 보존을 확인했다. 원본 제품 PPTX는 변경하지 않았다. 증거 `.local/verification/c4-qa/build/v2/*/{validation,editability}.json`. PowerPoint/Google Slides 자체 실행은 미검증이다.
- Chrome CUA `.local/ui-e2e/mac-task23-6LFusp/result.json` 및7JPEG: 세 예제 preview, container v1저장→원문 수정v2, dirty export 차단, v1 exact 원문 복원, Boreal 프로젝트 격리, 새 서버/같은DB/reload 후 v2 원문·이력·export bytes 동일, self/expanded-boundary/HTML 입력 및 dense layout 한도 차단, 방향키 가로·세로 스크롤을 확인했다. 제품 버튼으로 받은 Downloads의PPTX/MD4개가 서버 export와 byte-for-byte 일치하며 `download-checks.json`에SHA256을 기록했다.
- 브라우저 warning/error0, native factory0·실제AI/CLI0·Run0. 두 fixture의HEAD/status/README 동일, 소유 서버PID6159/6272 exit0·loopback51778 닫힘·Chrome423251675 종료·cleanupComplete true/errors0. 인증정보나 실제 프로젝트 DB는 사용하지 않았다.
- 전용 Mac 기능 검증이며 전체37단계/Windows 최종 gate를 대체하지 않는다. authored C4의 실제 코드 일치 여부, 기타 UML/PDF 및 나머지 A–K 기능은 계속 미완료다. 전체 Goal은 active다.

- Task23 검증 변경은 로컬 커밋 `cd149e0`로 보존했다. 원격 push는 하지 않았다.

## Task24 — UML class diagram local integration (2026-10-26)

Implemented the authored `classDiagram` subset in existing Mermaid Artifacts: explicit class declarations, names/annotations/attribute/operation compartments, eight relationship kinds with reverse normalization, endpoint multiplicities and exact source/version preservation. Fixed native diamond geometry extends the shared canvas; one complete deterministic overview uses45bounded size candidates and rejects unsupported density before saving/exporting. No dependency or model invocation added. Existing sequence/C4 PPTX4files regenerated byte-for-byte unchanged after the common primitive extension.

### Failures found and corrected

- API stubs and missing UI/HTTP integration were observed RED before implementation. Actual v1PPTX rendering exposed needless splitting of short ASCII members; conservative weighted grapheme wrapping preserves words and all source characters. A10class/20unlabeled-relation case needed a compact fallback; larger/dense text still fails explicitly.
- Independent review found normal member names (`link`, `style`, `direction`, `callback`) rejected as commands; command-shaped syntax is now distinguished from typed fields/operations.
- A second review finding rejected `data: String` / `file: File` and fully typed method arguments as URI text. A narrow field/parameter type exception was added without allowing actual data/file/executable URLs or relaxing general labels.
- Null-prototype arrays passed AST validation but failed layout methods. Four RED cases now reject with INVALID_CLASS_DIAGRAM. Plain inert records with null prototypes remain supported. Final independent review: no remaining actionable findings; parser/layout41pass, earlier broad65pass and owned Studio source/replay/rollback/receipt/isolation probes passed.

### Verification

- Final Node24 `.local/verification/class-reviewed-verify.log`: **779total /778pass /1Windows-onlyskip /0fail**, typecheck0/build0/exit0, tests25.76s. Earlier774pass gate was superseded after the last review fix. Parser27/layout14; parser+legacy92pass.
- Actual final6class/8relationship PPTX: one2388×912pt page,95native primitives, **63175bytes**, SHA256`c75b22e883f682a1b147480bdc75857d2f3597a3400d67a6e01f11f3b9b1f46e`. Package/layout findings0/warnings0; bundled first-party import/render and visual inspection passed.38textboxes/50lines imported; a separate copy changed프로젝트→검증 프로젝트, reexport/reimport preserved the edit. Product file untouched. Evidence `.local/verification/class-qa/{build,output}/v2`.
- Final Chrome CUA fixture `.local/ui-e2e/mac-task24-NOI3kC`: sample preview, reviewed typed-member acceptance, invalidself/namespace/HTML/density rejection, v1save→v2revise→exactv1history, dirtyexportdisabled, Boreal projectisolation, newserverprocess/sameDBreload v2+history, keyboardscroll and actualproduct-button downloads.4downloaded files byte-equal to server exports: v1PPTX63175B/MD901B, v2PPTX63176B/MD902B.
- Browser console warnings/errors0 before cleanup; nativefactory0, actualAI/CLI0, Run0. Source Git HEAD/status/README unchanged. Owned server PID37541/43454exit0, loopback53353closed, tab423251683closed, cleanupComplete true/errors[]. Evidence result.json, browser-checks.json, download-checks.json, screenshots, tab-cleanup.json. Initial pre-review fixture mac-task24-xseyXL also cleanly closed; screenshot stitching artifacts are distinct from the rendered diagram.

### Limits and next work

This is a bounded authored UML class grammar, not a full Mermaid engine or verified code model. Self relations, namespace/generics/static member syntax and dense layouts outside the complete overview remain unsupported. PDF export/report/chart functionality and whole-platform requirements remain incomplete. Native PowerPoint/Google Slides and Windows final gate were not run. No remote push, deployment, real AI or external-service activation occurred. Continue with saved Artifact PDF export.
