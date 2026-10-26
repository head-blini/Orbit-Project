# Orbit UI 정리 결과

검증일: 2026-10-25. 작업 브랜치: `integration/orbit-20261025104804486-08592a18`.

**UI 구현과 자동 회귀 검증은 수행했지만, 빌드와 실제 Chrome 인수 검증이 막혀 전체 완료 기준을 충족하지 못했다.** 실제 Chrome의 메뉴 이동·핵심 기능·해상도별 레이아웃과 변경 전후 스크린샷은 미검증이다.

## 추가 검증: agent-browser CLI

사용자의 후속 요청에 따라 2026-10-25에 **agent-browser로 직접 재시도**했다. 아래 결과는 앞선 내장 브라우저 origin 승인 거절과 별개의 실행 증거다. 제품 소스는 재작성하거나 수정하지 않았다.

### 설치와 실행 환경

- 설치 스킬: `C:/Users/lclk1/.agents/skills/agent-browser/SKILL.md`를 읽고, CLI가 제공하는 `skills get core`, `skills get dogfood`를 로드했다. 두 명령은 종료 0이다.
- `agent-browser.cmd --version`: **0.39.2**, 종료 0. 별도 설치나 업그레이드는 하지 않았다.
- `agent-browser.cmd session id --scope worktree --prefix orbit-ui-qa`: 전용 세션 `orbit-ui-qa-db9f8eb7c9fa`, 종료 0. 기본 공유 세션이나 기존 사용자 Chrome 프로필에 연결하지 않았다.
- doctor에서 설치된 Chrome **156.0.8078.47**, `C:/Program Files/Google/Chrome/Application/chrome.exe`를 확인했다. 사용자 인증 파일·프로필 내용·쿠키·토큰은 읽지 않았다.

### 이번 실행 결과

| 실행 | 종료 코드 | 실제 결과 |
| --- | ---: | --- |
| `npm.cmd run build` | 1 | esbuild의 `Cannot read directory "../../../../..": Access is denied.` 및 `Could not resolve "./web/main.tsx"` |
| `npm.cmd run typecheck` | 0 | 타입 검사 통과 |
| `npm.cmd test` | 0 | 125 tests, 125 pass, 0 fail, 0 skipped |
| `agent-browser.cmd --session orbit-ui-qa-db9f8eb7c9fa --allowed-domains 127.0.0.1 open http://127.0.0.1:4317` | 1 | `CDP response channel closed`. 페이지 접속 성공 증거 없음 |
| `agent-browser.cmd --session orbit-ui-qa-db9f8eb7c9fa doctor --offline --quick` | 1 | `Could not determine home directory`; Chrome 설치와 세션 daemon은 감지됨 |
| `agent-browser.cmd --session orbit-ui-qa-db9f8eb7c9fa doctor --offline` | 1 | 위 홈 디렉터리 실패와 `Browser launch failed: CDP response channel closed` 재현 |
| `agent-browser.cmd --session orbit-ui-qa-db9f8eb7c9fa close` | 0 | `Browser closed`. 이 작업의 전용 세션 정리 |

오프라인 doctor의 브라우저 실행 테스트에서도 CDP 연결이 끊겼으므로, 이 오류를 Orbit 페이지의 JavaScript·메뉴·서버 오류로 판정할 수 없다. **정확히 확인한 실패 지점은 브라우저 launch/CDP 응답 채널이며, 근본 원인이 OS 권한인지는 진단 출력만으로 확정하지 못했다.** `Could not determine home directory`는 함께 관찰된 환경 문제이며 CDP 실패의 확정 원인으로 간주하지 않는다. ffmpeg 미설치 경고는 동영상 기능 관련이고 이번 스크린샷 실패 원인으로 판정하지 않았다.

빌드가 실패해 현재 소스의 새 번들을 만들지 못했다. 기존 `dist` 파일이 있다는 사실만으로 최신 빌드로 간주하지 않았으며, 그 파일로 임시 검증 서버를 시작하지 않았다. **이번 시도에서는 로컬 서버를 새로 실행하지 않았고 임시 DB도 생성하지 않았다.** 기존 서버를 중단하거나 기존 DB/WAL/SHM을 열지 않았다. 후속 브라우저 입력·저장 작업은 전혀 수행하지 않았다.

### 화면·스크린샷 검사 상태

| 요청 순서 | 페이지 | 버튼·입력·저장·새로고침 | 1744×864 | 1366×768 |
| ---: | --- | --- | --- | --- |
| 1 | Dashboard | 브라우저 실행 실패로 미검증 | 미촬영 | 미촬영 |
| 2 | Projects | 미검증 | 미촬영 | 미촬영 |
| 3 | Planning Studio | 미검증 | 미촬영 | 미촬영 |
| 4 | Agent Center | 미검증 | 미촬영 | 미촬영 |
| 5 | Development | 미검증 | 미촬영 | 미촬영 |
| 6 | Visualization Studio | 미검증 | 미촬영 | 미촬영 |

스크린샷 **0장**. 화면 레이아웃·메뉴 이동·콘솔 오류의 검사는 실행되지 않았다. 따라서 새로 발견·수정·브라우저 재검증한 UI 결함도 없으며, 이는 UI 결함이 없다는 의미가 아니다. 실패한 화면을 가짜 캡처나 정적 렌더링으로 대체하지 않았다.

실행 로그는 작업 트리의 Git-ignored 파일에 보존했다: `orbit-agent-browser-build.log`, `orbit-agent-browser-typecheck.log`, `orbit-agent-browser-tests.log`, `orbit-agent-browser-open.log`, `orbit-agent-browser-doctor.log`, `orbit-agent-browser-doctor-full.log`, `orbit-agent-browser-close.log`.

권한 확대, 홈 디렉터리 환경변수 변경, `--fix`, 브라우저 재설치, 보안 플래그 완화, raw CDP 연결 또는 다른 브라우저를 통한 우회는 수행하지 않았다. 최신 번들 빌드와 agent-browser launch가 정상인 환경에서 아래 인수 검증을 이어가야 한다.

## 범위와 보존

- Windows 10.0.19045 / Node 24.22.1 / npm 11.19.1 / Git 2.56.0.windows.3 / Codex CLI 0.164.0을 확인했다. PowerShell 실행 정책을 변경하지 않고 `npm.cmd`, `codex.cmd`를 사용했다.
- 이미 존재하던 전용 worktree에서 작업했다. 시작 시 존재한 backend·공통 타입·통합 문서·테스트 변경은 보존했다. 이번 작업은 web UI, UI 회귀 테스트, 이 문서와 UI 계획 문서를 수정했다.
- 새 패키지, UI 프레임워크, 실행 엔진, Runner, 외부 모델 연결, 서버 API 또는 DB 스키마를 추가하지 않았다. 기존 Codex App Server, CSRF, Origin, 세션, 정책 검사 경로를 재사용한다.
- 기존 서버를 재시작하지 않았으며 사용자 DB/WAL/SHM, 실행 기록, 인증 파일, 사용자 설정 파일을 열거나 변경하지 않았다. 테스트는 기존 테스트의 임시 저장소·worktree·SQLite fixture를 사용했다. 실제 Codex 인증·실행은 수행하지 않았다.
- 브라우저 선택 저장은 새 키 `orbit.ui.project`에 프로젝트 ID만 저장하도록 구현했다. 기존 설정 키를 지우지 않는다. 기획 원문과 프롬프트는 이 키에 저장하지 않는다.
- 커밋·push·merge·배포는 하지 않았다. 문서상의 Phase gate를 통과했다고 주장하지 않는다.

## 페이지 구성

| 위치 / 메뉴 | 실제 연결한 UI | 검증 범위 |
| --- | --- | --- |
| 주 메뉴 / Dashboard · 대시보드 | snapshot의 프로젝트 수, AI 상태, 선택 프로젝트 작업 공간, 현재 실행, 서버에 저장된 Task 초안, 최근 실행 | React 정적 렌더링·상태 격리 테스트. 실제 브라우저 미검증 |
| 주 메뉴 / Projects · 프로젝트 | 기존 로컬 저장소 등록, 공통 프로젝트 선택, worktree 생성·선택 | 기존 프로젝트/HTTP/임시 Git 회귀 + 선택 프로젝트만 표시하는 렌더링 검사 |
| 주 메뉴 / Planning Studio · 기획 스튜디오 | 기존 편집·파일 가져오기·버전 저장/개정·승인·Task 초안 생성/목록 | 기존 실제 HTTP/SQLite 통합 테스트 + 전용 페이지 렌더링 |
| 주 메뉴 / Agent Center · 에이전트 센터 | 기존 Codex 연결·응답·프롬프트·중단·이어받기·실행 타임라인·이벤트 | 기존 합성 RPC의 재연결/중단/미검증 회귀 + 전송 가드 렌더링 |
| 주 메뉴 / Development · 개발 | 선택 프로젝트 worktree/브랜치/기준 커밋, 현재 작업 공간의 기존 Git Diff | 기존 임시 Git/Diff 회귀 + 타 프로젝트 내용 제외 검사 |
| 주 메뉴 / Visualization Studio · 시각화 스튜디오 | 기존 제한된 Mermaid/SVG 미리보기·Artifact 저장/개정/이력 | 기존 parser/HTTP/SQLite 테스트 + inert SVG/내보내기 비활성 검사 |
| 주 메뉴 / Automation · 자동화 | **준비 중** | 준비 중 문구·작동하는 것처럼 보이는 컨트롤 없음 검사 |
| 하단 관리 / Model Providers · 모델 제공자 | Codex 상태/Agent Center 이동, 기존 mock-only 목록·합성 정책 검사 | 모의 상태 렌더링 + 기존 provider/guardrail 통합 테스트 |
| 하단 관리 / Extensions · 확장 기능 | **MCP / Skills / Plugins 관리 준비 중** | 준비 중 렌더링 |
| 하단 관리 / Privacy & Security · 개인정보 및 보안 | 고정 반출 정책, mock 어댑터 제한, 패턴 차단, 승인/MCP/쓰기 보호, 현재 연결 진단 | 정책 설명 렌더링 + 기존 서버 보안 회귀 |
| 하단 관리 / Usage & Analytics · 사용량 및 분석 | **집계 준비 중**. 가상 비용·토큰·할당량 없음 | 준비 중 렌더링 |
| 하단 관리 / Settings · 설정 | 현재 다크/한국어/선택 보존 방식 안내. **추가 설정 편집 준비 중** | 준비 중 렌더링 |

## 화면 및 상태 처리

- `StudioHub` 통합 카드와 내부 Studio 탭을 제거했다. 각 메뉴는 `#/dashboard` 등 독립 주소를 사용한다. 브라우저 새로고침·뒤로/앞으로 이동은 URL을 기준으로 페이지를 복원한다. 알 수 없는 주소는 Dashboard로 돌아간다.
- 좌측 240px 고정 사이드바에 주 메뉴 7개와 하단 관리 메뉴 5개를 배치했다. 현재 메뉴는 강조 색과 `aria-current="page"`로 표시한다. 상단에는 프로젝트 선택기, 로컬/Codex 상태, AI 명령, 설정 버튼을 둔다.
- 900px 이하에서는 사이드바를 접고 메뉴 버튼·닫기 배경·Escape로 제어한다. 1100px 이하에서 편집기 열을 한 열로 바꾸며 짧은 화면의 사이드바 간격도 줄였다. **CSS 구현과 문법 검사만 수행했으며 실제 기하·스크롤 검증은 하지 못했다.**
- 기존 다크 배경과 민트 강조를 유지하면서 Studio·타임라인·입력·카드·버튼·SVG 미리보기의 흰 배경을 제거했다. 사용자에게 보이는 주요 편집·저장·이력·오류 문구를 한국어로 맞췄다. Markdown 파서의 영문 구역명과 진단 코드는 기존 계약을 유지한다.
- 기획/시각화 페이지는 최초 방문 시 마운트하고 메뉴를 바꾸면 숨겨 미저장 편집 상태를 유지한다. 프로젝트를 바꾸면 기존 계약대로 해당 편집기를 초기화한다. **미저장 기획/Artifact 원문은 새로고침을 넘겨 복원되지 않는다.** 서버에 저장된 버전은 기존 API로 복구한다.
- 프로젝트 ID를 공통 선택기로 전달한다. Projects와 Development는 선택한 프로젝트의 작업 공간만 표시한다. 선택 프로젝트와 서버의 실행 작업 공간이 다르면 Codex 연결·전송 UI와 전송 핸들러가 실행을 막는다. 서버의 `WORKSPACE_MISMATCH` 검사는 그대로 유지한다.
- 프롬프트 초안은 현재 브라우저 메모리에서 프로젝트/작업 공간별로 구분한다. 메뉴 이동과 명령 패널 열기·닫기에는 유지되며 서버나 localStorage에 자동 저장하지 않는다.
- AI 명령 패널은 같은 `AgentCenter` 컴포넌트를 사용한다. 동시에 두 대화 컴포넌트를 렌더링하지 않으며 native dialog의 모달 처리와 Escape, 닫기 버튼, 이전 포커스 복원을 사용한다. 실제 포커스 동작은 Chrome 미검증이다.
- 브라우저가 세션 저장소에 요청 ID 보존을 허용하지 않으면 새 Codex 요청을 보내지 않는다. 기존 pending 전송의 명시적 확인과 자동 재전송 금지 동작을 유지했다.

## 읽기 전용 회귀 검토와 보완

메인 에이전트가 UI 파일을 수정했고, 서브에이전트 한 개가 코드만 읽어 검토했다. 다음 두 결함을 각각 실패하는 테스트로 확인한 뒤 수정했다.

1. 선호 프로젝트 B와 실제 실행 프로젝트 A가 다르면 활성 실행 때문에 프로젝트 선택이 잠기고 중단 버튼까지 숨겨지는 문제: 보기용 프로젝트 선택과 서버 작업 공간 변경의 잠금을 분리했고, 불일치 화면에 **현재 실행으로 이동** 버튼을 추가했다. 실제 실행 중 workspace 변경은 기존 서버 정책대로 금지한다.
2. 읽기 전용 프로젝트를 등록하면 기존 기본 Codex 테스트 세션에 접근할 수 없던 문제: 서버가 기본 세션인 경우 프로젝트 선택기에 **읽기 전용 테스트 세션**을 제공한다. 이미 서버가 실제 worktree를 선택한 경우에는 UI 선호만으로 기본 세션으로 바뀐 것처럼 표시하지 않는다.

## 실행한 검사

| 명령 / 검사 | 종료 코드 | 결과 |
| --- | ---: | --- |
| `npm.cmd test` — 변경 전 | 0 | 120 tests, 120 pass |
| `node --test tests/studio-ui.test.ts` — 분리 전 RED | 1 | 기존 통합 카드가 다른 Studio까지 렌더링함을 확인 |
| `npm.cmd run typecheck` — 중간 | 2 | 제거한 StudioHub를 참조하던 테스트, select nullable 값 발견 후 수정 |
| `node --test tests/studio-ui.test.ts tests/visualization.test.ts` | 0 | 18/18 |
| `node --test tests/orbit-navigation.test.ts` — 복구 RED | 1 | 등록 프로젝트가 기본 읽기 전용 세션 선택을 막음 |
| `node --test tests/studio-ui.test.ts` — 복구 RED | 1 | 프로젝트 불일치 상태의 활성 실행 복구 동선 누락 |
| `node --test tests/orbit-navigation.test.ts tests/studio-ui.test.ts` — 복구 GREEN | 0 | 6/6 |
| `npm.cmd run typecheck` | 0 | TypeScript 통과 |
| `npm.cmd test` | 0 | 125 tests, 125 pass, 0 fail, 0 skipped |
| esbuild `transform`으로 5개 CSS 파일 문법 검사 | 0 | style/orbit/studios/planning/visualization CSS 경고 없음. 번들·브라우저 검증은 아님 |
| `npm.cmd run build` | 1 | 아래 파일시스템 접근 제한으로 실패 |
| `npm.cmd run verify` — 최종 소스 | 1 | 타입 검사 0 → 전체 테스트 125/125·종료 0 → 빌드에서 같은 접근 거부·종료 1 |
| `git diff --check` | 0 | 공백 오류 없음. Git의 LF→CRLF 안내만 발생 |

전체 테스트는 기존 세션/CSRF/Origin, RPC 상태 전이, interrupt/reconnect, 실행 완료와 검증 분리, 경로·worktree·민감 Diff, 기획 승인·Task 영속성, Artifact 이력, outbound 패턴 차단 테스트를 포함한다. 테스트용 합성 RPC는 실제 계정 연결 성공 증거가 아니다. React 정적 렌더링은 클릭·입력·effect 실행을 검증하지 않는다.

로그: Git-ignored `orbit-ui-baseline.log`, `orbit-ui-focused.log`, `orbit-ui-navigation-red.log`, `orbit-ui-recovery-red.log`, `orbit-ui-recovery-green.log`, `orbit-ui-typecheck.log`, `orbit-ui-tests.log`, `orbit-ui-build.log`. 최종 전체 명령은 `orbit-ui-verify.log`에 기록했다.

## 실패·미검증과 스크린샷 비교

### 제품 빌드

`npm.cmd run build`가 esbuild에서 다음 오류로 종료 1을 반환했다.

```text
Cannot read directory "../../../../..": Access is denied.
Could not resolve "./web/main.tsx"
```

기존 통합 결과 문서에도 기록된 같은 환경 제한이다. 타입 검사와 모듈 정적 렌더링 성공을 제품 번들 성공으로 바꾸어 보고하지 않는다. 파일시스템 권한 확대·빌드 우회 패치·의존성 재설치는 하지 않았다. 따라서 기존 실행 서버가 이 소스 변경을 제공한다고 주장하지 않는다.

### 실제 Chrome 및 스크린샷

Chrome 인벤토리에서 기존 `http://127.0.0.1:4317/` 탭을 확인했다. 기존 탭은 다른 세션 소유여서 검증용 새 탭을 요청했으나, 브라우저 자동 승인 검토가 로컬 origin 접근 권한 거절을 반환했다. 도구는 동일 목적의 다른 브라우저 표면, raw CDP 또는 우회 실행을 금지했다. 이후 브라우저 작업을 시도하지 않았다.

| 요구 증거 | 상태 |
| --- | --- |
| 변경 전 실제 화면 캡처 | 미확보 |
| 변경 후 1744×864 캡처·레이아웃 검사 | 미검증 |
| 변경 후 1366×768 캡처·레이아웃 검사 | 미검증 |
| 좁은 화면 사이드바·키보드·명령 패널 | 코드 구현, 실제 화면 미검증 |
| 실제 Chrome 메뉴 12개 이동·새로고침·프로젝트 선택 보존 | 미검증 |
| Chrome 기획 저장/승인/Task·Artifact 저장/이력·Diff·Codex 연결/중단/복구 | 미검증 |
| 현재 화면과 변경 후 화면의 스크린샷 비교 | 미수행. 합성 이미지나 다른 앱 화면을 대체 증거로 만들지 않음 |

소스 구조상 비교: 단일 Codex 사이드바 → 12개 전용 메뉴, 혼합 Studios 카드 → 독립 페이지, 흰 Studio/타임라인 → 다크 스타일, 페이지별 프로젝트 선택 → 공통 선택기. 이 비교는 실제 화면 캡처 비교가 아니다.

## 이어서 필요한 인수 검증

1. 접근 가능한 일반 개발 환경에서 `npm.cmd run verify`의 타입 검사·전체 테스트·빌드가 모두 종료 0인지 확인한다.
2. 기존 사용자 DB를 건드리지 않도록 `docs/ORBIT-INTEGRATION-RESULTS.md`의 별도 임시 실행 디렉터리 절차로 loopback 검증 서버를 띄운다. 승인된 Chrome 접근 환경에서만 수행한다.
3. 모든 메뉴 이동, 새로고침/뒤로 가기, 공통 프로젝트 선택, 편집 중 페이지 이동, 서로 다른 프로젝트의 workspace/Diff/프롬프트 분리를 검사한다. 실제 읽기 전용 세션과 활성 실행 복귀도 확인한다.
4. 기획 작성→저장→개정→승인→Task, Mermaid→Artifact 저장→개정→이력, 합성 정책 입력의 차단·mock 응답을 확인한다. 쓰기 통합 테스트는 폐기 가능한 저장소에서만 수행한다.
5. 1744×864·1366×768 및 좁은 화면에서 캡처하고 스크롤·가로 넘침·모달 포커스·접힌 메뉴 동작을 검토한다. 변경 전 캡처가 없으므로 원본 화면 증거도 별도로 확보해야 한다.

이 인수 검증이 끝나기 전에는 전체 UI/UX 완료로 처리하지 않는다.
