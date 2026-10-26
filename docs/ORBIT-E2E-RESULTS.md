# Orbit UI E2E 결과

- 실행: 2026-10-25T18:20:03.545Z
- 모드: browser-e2e
- 결과: **passed**
- agent-browser: agent-browser 0.39.2
- 격리 서버: http://127.0.0.1:65276
- 기록: [result.json](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/result.json) · [commands.jsonl](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/commands.jsonl)

## 실행 방법

일반 PowerShell에서 프로젝트 루트 기준:

```powershell
node scripts/verify-orbit-ui.mjs
```

샌드박스용: `node scripts/verify-orbit-ui.mjs --check-only`. 이 모드는 제품 빌드·브라우저를 실행하지 않으며 E2E 결과를 not_run으로 남긴다. 설치·권한 확대·자동 수정은 하지 않는다.

## 단계

| 단계 | 결과 |
| --- | --- |
| CLI 설치·명령 확인 | passed |
| 스크립트 정적 검사 | passed |
| 타입 검사 | passed |
| 전체 테스트 | passed |
| 제품 빌드 | passed |
| 임시 Git·DB 서버 | passed |
| Chrome 접속 | passed |
| 전체 메뉴 이동 | passed |
| 프로젝트 등록·선택 | passed |
| 작업 공간·Git Diff | passed |
| Planning 저장·승인·Task | passed |
| Visualization 저장·복구 | passed |
| 모의 개인정보 반출 차단 | passed |
| 새로고침 데이터 복원 | passed |
| 서버 재시작 데이터 복원 | passed |
| 1366×768 전체 메뉴·캡처 | passed |
| 1744×864 전체 메뉴·캡처 | passed |
| 원본 fixture 보존 | passed |
| 실제 Node 검증·사용자 승인 | passed |
| 소스 변경 후 검증 무효화·복구 | passed |
| 실제 소스 그래프·파일 탐색·Artifact | passed |
| 소스 그래프·Artifact 무효화·복구 | passed |
| Model Hub 명시 동의·로컬 HTTP·반출 차단 | passed |
| Model Hub 중단·이력 복구 | passed |
| Planning MD·JSON 실제 다운로드·재가져오기 | passed |
| Planning 개발 증거·질문 폐기·승인 보존 | passed |
| Merge 전용 검증·리뷰 승인·후보 생성 | passed |
| Merge 별도 승인·실제 ff 반영·source 보존 | passed |
| Merge 새로고침·재시작 기록 복구 | passed |
| Workflow 전용 DAG 저장·미리보기·실제 명령 통과 | passed |
| Workflow 실패·종속 단계 생략·명시 재시도·버전 보존 | passed |
| Workflow 실제 중단·새로고침·재시작·재실행 없음 | passed |
| Bedrock 명시 동의·없는 CLI 실패·진단 복구·전송 차단 | passed |
| Native Review 정확한 입력·동의·mock 완료·복구 | passed |
| Native Review mock 시작·중단·복구·재실행 없음 | passed |

## 실패 및 정리

실행한 검사에서 보고된 실패 없음. not_run은 성공이 아니다.

정리 오류: 없음

최소 후속 조치: 실패한 단계의 stdout/stderr와 브라우저 증거를 먼저 확인한다. CLI 스키마 불일치는 설치 버전의 JSON 출력을 확인해 파서만 수정한다. CDP 실행 실패나 파일시스템 접근 거부는 정상 PowerShell의 동일 명령으로 비교하며 보안 우회나 원인 추정으로 성공 처리하지 않는다.

## 스크린샷

- [screenshots/01-1366x768-dashboard.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/01-1366x768-dashboard.png) (1366×768)
- [screenshots/02-1366x768-projects.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/02-1366x768-projects.png) (1366×768)
- [screenshots/03-1366x768-planning.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/03-1366x768-planning.png) (1366×768)
- [screenshots/04-1366x768-agents.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/04-1366x768-agents.png) (1366×768)
- [screenshots/05-1366x768-development.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/05-1366x768-development.png) (1366×768)
- [screenshots/06-1366x768-visualization.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/06-1366x768-visualization.png) (1366×768)
- [screenshots/07-1366x768-automation.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/07-1366x768-automation.png) (1366×768)
- [screenshots/08-1366x768-providers.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/08-1366x768-providers.png) (1366×768)
- [screenshots/09-1366x768-extensions.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/09-1366x768-extensions.png) (1366×768)
- [screenshots/10-1366x768-security.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/10-1366x768-security.png) (1366×768)
- [screenshots/11-1366x768-usage.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/11-1366x768-usage.png) (1366×768)
- [screenshots/12-1366x768-settings.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/12-1366x768-settings.png) (1366×768)
- [screenshots/13-1744x864-dashboard.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/13-1744x864-dashboard.png) (1744×864)
- [screenshots/14-1744x864-projects.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/14-1744x864-projects.png) (1744×864)
- [screenshots/15-1744x864-planning.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/15-1744x864-planning.png) (1744×864)
- [screenshots/16-1744x864-agents.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/16-1744x864-agents.png) (1744×864)
- [screenshots/17-1744x864-development.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/17-1744x864-development.png) (1744×864)
- [screenshots/18-1744x864-visualization.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/18-1744x864-visualization.png) (1744×864)
- [screenshots/19-1744x864-automation.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/19-1744x864-automation.png) (1744×864)
- [screenshots/20-1744x864-providers.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/20-1744x864-providers.png) (1744×864)
- [screenshots/21-1744x864-extensions.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/21-1744x864-extensions.png) (1744×864)
- [screenshots/22-1744x864-security.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/22-1744x864-security.png) (1744×864)
- [screenshots/23-1744x864-usage.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/23-1744x864-usage.png) (1744×864)
- [screenshots/24-1744x864-settings.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/24-1744x864-settings.png) (1744×864)
- [screenshots/25-verification-approved.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/25-verification-approved.png) (1744×864)
- [screenshots/26-verification-stale-after-restart.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/26-verification-stale-after-restart.png) (1744×864)
- [screenshots/27-source-graph-current.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/27-source-graph-current.png) (1744×864)
- [screenshots/28-source-artifact-current.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/28-source-artifact-current.png) (1744×864)
- [screenshots/29-source-graph-stale-after-restart.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/29-source-graph-stale-after-restart.png) (1744×864)
- [screenshots/30-source-artifact-stale-after-restart.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/30-source-artifact-stale-after-restart.png) (1744×864)
- [screenshots/31-model-hub-current.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/31-model-hub-current.png) (1744×864)
- [screenshots/32-model-hub-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/32-model-hub-restored.png) (1744×864)
- [screenshots/33-planning-reimported-draft.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/33-planning-reimported-draft.png) (1744×864)
- [screenshots/34-planning-handoff-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/34-planning-handoff-restored.png) (1744×864)
- [screenshots/35-merge-candidate-prepared.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/35-merge-candidate-prepared.png) (1744×864)
- [screenshots/36-merge-applied.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/36-merge-applied.png) (1744×864)
- [screenshots/37-merge-applied-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/37-merge-applied-restored.png) (1744×864)
- [screenshots/38-workflow-passed.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/38-workflow-passed.png) (1744×864)
- [screenshots/39-workflow-failed-retry.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/39-workflow-failed-retry.png) (1744×864)
- [screenshots/40-workflow-interrupted-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/40-workflow-interrupted-restored.png) (1744×864)
- [screenshots/41-bedrock-missing-cli-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/41-bedrock-missing-cli-restored.png) (1744×864)
- [screenshots/42-native-review-completed-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/42-native-review-completed-restored.png) (1744×864)
- [screenshots/43-native-review-interrupted-restored.png](../../../../../../AppData/Local/Temp/orbit-e2e-pRQaWi/screenshots/43-native-review-interrupted-restored.png) (1744×864)

## 격리와 검증 한계

새 run 디렉터리의 test.sqlite와 네 disposable Git 저장소를 사용한다. 첫 두 primary fixture는 보존하고 실제 병합은 별도 승인된 세 번째 primary에만 반영한다. 네 번째 worktree에서만 고정 workflow 명령과 ignored 표식 및 baseline 전 고정 리뷰 marker를 사용하며 primary와 앞선 세 저장소는 보존한다. 서버는 실제 제품 HTTP/Controller/Store/Projects를 재사용하고 기본 AI factory는 거절하며 여섯 번째 CLI exact grant에서만 네 번째 worktree의 읽기 전용 fake RpcPort를 별도 허용한다. 실제 Codex CLI·AI는 실행하지 않는다. 사용자 DB·인증 파일·실제 프로젝트에 접근하지 않는다. 브라우저는 전용 session/namespace, 빈 명시적 설정, 127.0.0.1 도메인 제한을 사용하며 기존 승인 관련 환경변수는 유지한다. 테스트 중 사용한 DB와 증거는 삭제하지 않는다. SIGINT/SIGTERM은 finally 정리를 수행하며 강제 프로세스 종료·OS 종료는 보장할 수 없다.

- 실제 Codex/외부 AI 추론은 의도적으로 비활성화; 성공한 연결·응답·중단 검증 대상 아님.
- 검증 단계의 terminal Run은 전용 fixture 서버 IPC로 생성한 synthetic 기록이다. 실제 Codex 실행으로 주장하지 않는다. Node --test 검증 명령만 서버에 고정 등록하고 disposable worktree에서 실제 실행한다.
- 소스 그래프는 새 disposable worktree에 직접 만든 두 TS 파일의 정적 import·함수 호출과 파일 탐색·Artifact 연결을 검사한다. 동적 실행·전체 런타임 정확성·의존 패키지 분석을 보장하지 않는다.
- Capability Registry는 GET·표시·확장 필터만 검사하며 로컬 CLI 버전 진단 버튼은 누르지 않는다. 실행 모드는 설명 열기만 검사하며 모델·확장 설치·모드 실행은 하지 않는다.
- Usage는 연결하지 않은 fixture의 GET·unknown·계정 전체 범위·조회 버튼 비활성·과금 전환 없음 표시만 확인한다. 공식 사용량 조회 버튼은 누르지 않으며 실제 계정 RPC·quota·token 활동은 조회하지 않는다.
- 이번 브라우저 다운로드는 저장 기획 MD/JSON와 수동 handoff Markdown만 검사한다. plain --download-path와 제품 버튼 click을 사용하며 CLI download 명령은 사용하지 않는다. Artifact PPTX/MD 저장은 별도 증거(docs/visualization/DOWNLOAD-RESULTS.md)이며 이번에 재검증하지 않는다.
- 자동 레이아웃 검사는 viewport/가로 넘침/메뉴 경계 검사이며 시각적 품질 전체를 증명하지 않음.
- Model Hub는 전용 child의 127.0.0.1 HTTP fixture를 실제 제품 transport로 호출한다. literal text/SSE/합성 usage/중단/이력만 검증하며 실제 모델 추론·외부 서비스·인증·요금·Bedrock 지원을 검증하지 않는다. 모델 기본 설정은 제품에서 활성화하지 않으며 fixture의 정확한 프로젝트 경로만 허용한다.
- Planning feedback은 실제 AI 실행 대신 Task metadata가 결합된 synthetic terminal Run과 실제 Node Check/현재성 조회를 사용한다. 저장 파일 bytes·parser roundtrip·UI 파일 재가져오기·별도 draft 저장을 검사하며 외부 AI 전달이나 기존 승인·Task 변경은 하지 않는다.
- Merge는 별도로 만든 세 번째 disposable repository의 primary에만 UI 명시 승인 후 실제 fast-forward를 수행한다. 이전 두 primary fixture는 그대로 보존한다. 원 source HEAD/index/bytes와 target 전후 SHA는 fixture 전용 read-only IPC로 비교한다. unknown/lost 복구는 제품 focused HTTP/unit 증거이며 이 브라우저 run에서 DB를 조작해 생성하지 않는다.
- Workflow는 네 번째 disposable repository의 고정 Node 명령만 실제 OS 권한으로 실행한다. ignored 표식은 의도한 부작용이며 sandbox 격리·AI Run·검증 Check·리뷰 승인으로 자동 승격을 주장하지 않는다. 순차 DAG·실패 시 생략·명시 재시도·실제 중단·기록 복구를 검사하며 lost 복구는 focused 서비스/HTTP 증거 범위이다.
- Bedrock은 네 번째 fixture에만 등록한 존재하지 않는 CLI 경로의 명시 모델 진단 실패를 검사한다. AWS CLI 설치·계정·인증정보·AWS 네트워크·실제 추론·과금·임시 입력 파일 생성/정리 성공은 검사하지 않는다. 다른 프로젝트는 project_blocked이며 실패 진단의 복원은 재시도나 모델 요청을 생성하지 않아야 한다.
- Native Review는 여섯 번째 CLI 인자로 명시한 네 번째 worktree의 read-only factory에만 별도 fake RpcPort를 허용한다. 실제 제품 native protocol runner/ReviewService/HTTP/UI를 거치지만 계정 응답·리뷰 텍스트·프로세스 종료는 합성 RPC 증거이며 실제 Codex CLI·ChatGPT 로그인·AI 추론·구독 사용량·원격 전송을 검증하지 않는다. 고정 README marker는 worktree 생성 직후 baseline 전에만 seed하며 이후 source HEAD/index/digest와 primary를 보존한다. lost·종료 미확인 복구는 focused unit/HTTP 범위이고 브라우저 DB를 조작하지 않는다.
