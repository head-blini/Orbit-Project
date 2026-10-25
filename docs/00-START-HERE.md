# AI Coding Control Center — 설계 패키지 v0.3

- 작성일: 2026-10-25 (Asia/Seoul)
- 상태: **설계 초안 / 구현 전**
- 용도: 특정 AI 서비스에 종속되지 않는 로컬 개발 관제센터. 기획·코딩·검토 각 단계의 제공자를 사용자가 자유롭게 선택한다.
- 대상: ChatGPT 이용자, Claude 전용 사용자, Codex 전용 사용자, 향후 Gemini CLI/OpenCode 등 다른 에이전트 사용자.
- 전제: **ChatGPT 계정·구독·API 키는 필수 아님.** 코드 실행에는 지원되는 코딩 에이전트 한 개 이상이 필요하며, 미연결 상태도 기획 편집과 Git 조회는 가능하도록 설계.
- 작성 상태: 설계 초안이며, 각 계정·CLI 실제 연결은 개발 머신에서 POC 필요.

## 한 줄 목표
**기획 도구를 원하는 것으로 선택하거나 관제센터 안에서 직접 기획하고, 연결된 AI 에이전트 1개 이상으로 구현·검증하며, 진행·코드·확장·사용량을 웹에서 통합 관리**한다. ChatGPT 웹 연동은 핵심 선택 시나리오지만 필수 의존성은 아니다.

## 역할 선택과 기본값
- **Planning:** 관제센터 내 수동 편집, 연결된 AI의 기획 모드(읽기 전용), 외부 ChatGPT/Claude/Gemini 웹 문서 가져오기 중 선택.
- **Coding:** Claude Code·Codex 중 설치·인증된 1개 이상으로 시작. 다른 CLI는 독립 Adapter로 점진 지원.
- **Review:** 다른 모델/에이전트가 있으면 교차 검토, 없다면 단일 에이전트의 격리된 새 검토 세션 또는 사람 검토를 선택. **타 모델 독립 검토처럼 표기하지 않음.**
- **Control Center:** 승인된 요구사항 버전, Task/Run 상태, 실제 검증 증거, Git 및 확장·사용량 관리.
- **개인 맞춤 기본 프로필:** ChatGPT 웹 기획 + Claude Code 구현 + Codex 검토. 설치 시 강제하지 않는다.

> ChatGPT 웹이나 Claude 웹의 개인 채팅·기억을 자동 복제하지 않는다. 외부 기획 도구는 사용자 승인 기반 Markdown/JSON 가져오기 및 피드백 내보내기를 공통으로 제공한다.

## V1 완성 기준 (핵심 경로)
1. 관제센터 내부 편집기/연결된 AI 기획 모드/외부 웹(예: ChatGPT·Claude·Gemini) 가운데 선택해 구현 범위·완료 조건을 포함한 **기획안**을 준비한다.
2. 관제센터의 **Ideas & Planning**에서 Markdown/JSON 붙여넣기 또는 파일 가져오기 → 원문 출처·문서 버전 기록 → 요구사항/제약/미결정 사항 미리보기.
3. 사용자가 **기획안 승인** → 프로젝트 Task 초안으로 변환 → 설치·인증된 코딩 에이전트 한 개 이상에서 담당 선택.
4. 웹에서 프롬프트를 보내고 실시간 출력/파일 변경/오류/중단 상태를 확인.
5. 담당 AI가 고립된 작업 디렉터리에서 코드 작성.
6. 사람이 고른 테스트/빌드 명령 실행 결과 및 종료 코드를 저장.
7. 변경 기준 커밋과 결과 커밋을 고정하고, **가능할 때** 다른 AI에 읽기 전용 코드 리뷰 의뢰. 단일 에이전트 사용자는 새 격리 세션 또는 사람 검토로 대체하며 리뷰 출처를 구분.
8. 유효한 지적만 수정하여 재검증하고, 최종 diff와 증거를 사용자에게 보여준 뒤 승인받음.
9. 개발 중 설계 이슈·새 제약이 발생하면 **제공자 중립 Markdown 피드백 패키지**를 내보내 원하는 기획 경로에서 수정하고, 이전 승인 버전과 비교 후 사용자가 승인.
10. 서버 재시작 후에도 기획/버전/작업/로그/승인 이력/체크포인트가 보존됨. 실제 프로세스 재실행은 자동으로 하지 않음.

> **핵심 원칙:** 'AI가 완료했다고 말함' ≠ '검증 완료'. 검증을 수행하지 못했을 때는 완료로 표시하지 않는다.

## 결론: 권장 구조
**독립 관제 엔진 + 독립 웹 UI**를 권장한다. CloudCLI와 Claude Deck은 사전 조사·선택적 코드 재사용·설치형 도구로 평가한다. CloudCLI 플러그인은 현재 별도 탭은 추가할 수 있으나 기존 채팅을 수정하거나 에이전트로 메시지를 보내는 API가 없으므로, 플러그인 하나만으로 핵심 오케스트레이터를 만들 수 없다.

```text
Browser (React UI)
   | HTTP + SSE/WebSocket (same-origin)
Local Control Server (Node/TypeScript)
   +-- Planning Hub (manual / in-app agent / external imports)
   +-- Task Orchestrator + Policy/Approval
   +-- Project/Git Worktree Manager
   +-- Provider Registry + Capability Detection
   |     +-- Claude Code Adapter (V1)
   |     +-- Codex Adapter (V1, optional)
   |     +-- Gemini CLI Adapter (P1)
   |     +-- OpenCode / local model Adapter (P1, capability POC)
   +-- Verification Runner / Review Handoff
   +-- Usage Collector / Graph Adapter / Extension Inventory
   +-- SQLite (state + event log) / content artifacts
                  |
            Local Git repositories
```

## 단계 범위
- **V1: 제공자 중립 관제 기본기** — GPT 없는 사용자도 가입·로그인 없이 로컬 앱 이용, 기획 직접 작성 또는 외부 Markdown/JSON import, 승인·Task 변환·개발 피드백 export, **연결된 에이전트 한 개로 완결되는 개발/검증 흐름**, 프로젝트/실행 로그/Git/사용량(지원시).
- **V1 사용자별 선택 조합** — ChatGPT 웹 + Claude + Codex, Claude-only, Codex-only 모두 대시보드/기획/코드 실행·검증을 사용할 수 있게 설계. 교차 AI 리뷰는 가능한 경우에만 제공.
- **V2: 프로젝트 지능화·지원 제공자 확장** — Graphify, 변경 영향, 작업 메모리, MCP·스킬·플러그인 관리, Gemini CLI 및 OpenCode 등 연동(공식 인터페이스와 인증 POC 후).
- **V3: 멀티 AI 협업 / 선택적 웹 기획 직접 연동** — 다중 worktree, 규칙 기반 자동 배정, 제한된 자동 리뷰/재시도, 선택한 웹 기획 도구와의 인증된 최소 권한 브리지.

## 의도적으로 제외하는 범위
- 외부 AI 웹(모든 제공자)의 채팅·기억·계정 UI를 무단 수집하거나 그대로 가져오는 기능. **제공자 중립 기획 import/export는 V1 필수.**
- 타인 계정의 OAuth 토큰 저장/전달, Anthropic 구독을 제3자 추론 서비스 인증으로 사용하는 기능
- 외부에 기본 공개되는 웹 서버, 무인 배포, 무조건 자동 병합·배포, 무한 자동 수정 루프
- 모든 CLI 세션에 대한 실시간 동일 세션 공유 보장(제공자별로 가능한 연결만 지원)

## 파일 안내
- `01-PRD.md`: 화면, 사용자 시나리오, 기능 우선순위, 수용 기준
- `02-TECH-DESIGN.md`: 시스템 구조, 이벤트/상태, 데이터 모델, API, 보안, 장애 복구
- `03-BACKLOG.md`: 구현 작업 순서, 선행 조건, 단계별 검증 게이트
- `04-ADR-RISKS-SOURCES.md`: 결정 근거, 오픈소스 비교, 제약, 위험, 원문 링크
- `05-IMPLEMENTATION-KICKOFF.md`: 코딩 에이전트에 전달할 최초 지시서, 검증 체크리스트
- `06-CHATGPT-PLANNING-BRIDGE.md`: **선택적** ChatGPT 웹 기획 연동 사례와 연결 경계.
- `07-PROVIDER-NEUTRAL-CORE.md`: **v0.3 신규** 제공자 독립 구조, 기획 모드, Capability Registry, 사용자 유형, 인증·복구·수용 테스트.

## 설계 결정의 유보 조건
운영체제와 설치된 CLI 버전, CloudCLI/Claude Deck 소스 재사용 방식은 현재 확인되지 않았다. 구현 착수 시 개발 머신에서 버전·인증 경로·지원 명령을 먼저 점검하여 설계를 조정한다.
