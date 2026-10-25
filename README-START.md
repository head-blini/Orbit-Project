# AI Coding Control Center — Codex-only starter

작성 기준: 2026-10-25. 상태: 설계 + Phase 0 실행 패키지. **실제 개발 환경 테스트나 코드 구현은 아직 수행하지 않았다.**

## 이 패키지가 해결하는 것
- GPT Pro 구독만 가진 사용자도 Phase 0를 시작한다. Claude Code, Gemini CLI, 다른 유료 모델은 필수 아님.
- 제품 자체는 **Provider-neutral**로 설계한다. 다른 사용자는 Claude-only, Codex-only, 기타 제공자 조합으로 사용할 수 있어야 한다.
- ChatGPT 웹 기획은 **옵션**, 수동 기획 입력과 외부 Markdown/JSON import는 **기본**.
- Codex CLI/App Server는 GPT Pro 계정 로그인으로 사용할 수 있다. 별도 API 키를 자동 생성하거나 API 결제를 활성화하지 않는다.

## 0. 준비
Windows 또는 macOS에서 Git, Node.js LTS, Codex를 사용할 수 있게 준비한다. 데스크톱 Codex 화면만으로 프로젝트를 여는 것은 가능하나, 관제센터의 App Server 프로토콜 연결을 시험하려면 Codex CLI도 필요하다.

설치 확인 명령:
```
node --version
npm --version
git --version
codex --version
```

Codex CLI가 없다면 Node.js 설치 후:
```
npm install -g @openai/codex@latest
codex
```
최초 실행에 **Sign in with ChatGPT**를 선택한다. `OPENAI_API_KEY`를 따로 만들 필요는 없다. 사용량은 구독 한도 내에서 차감된다.

## 1. 폴더 열기
이 ZIP 파일을 압축 해제하고 `README-START.md`, `AGENTS.md`, `docs/`, `prompts/`가 함께 있는 폴더를 Codex 데스크톱 앱에서 **로컬 프로젝트로 열기** 한다. 또는 터미널에서 그 폴더로 이동한 후 `codex`를 실행한다.

CLI 사용 시:
```
cd <압축을 푼 폴더 경로>
codex
```

참고: 아직 코드를 개발하지 않은 상태라서 ZIP 내부에는 설계 문서와 지시서만 있다. Codex가 Phase 0에서 필요한 최소 코드를 생성하게 한다.

## 2. 첫 번째 작업
Codex에 `prompts/PHASE0-CODEX-ONLY.md`를 읽고 그 지시대로 진행하라고 요청한다. 우선 공식 프로토콜 연결과 안전한 작업 분리 가능성을 검증한다.

최초 프롬프트 예시:
```
AGENTS.md와 prompts/PHASE0-CODEX-ONLY.md를 읽고 Phase 0만 수행해.
내가 가진 유료 서비스는 GPT Pro 하나야. 다른 AI 계정은 필수가 아니야.
환경을 실제로 확인하고, Codex App Server 연결 가능성을 검증해.
검증하지 않은 기능은 완료 처리하지 말고 docs/PHASE0-RESULTS.md에 결과를 남겨.
```

권장 모델: 계정에 표시된다면 **GPT-6.1 Sol / High**로 Phase 0 프로토콜·안전 설계를 수행한다. 이후 UI 반복 구현은 Medium부터 비교한다. 모델이 표시되지 않으면 현재 계정에서 선택 가능한 모델 중 하나를 사용한다.

## 3. Phase 0 완료 조건
- 현재 OS/Node/Git/Codex 설치 버전 및 로그인 상태 확인(인증 파일 값 접근/출력 금지)
- Codex App Server의 공식 `stdio` 연결, 세션/턴/이벤트/승인 기능을 가능한 범위에서 검증
- 실행 상태와 검증 완료 상태를 구분하는 이벤트/데이터 계약
- 테스트용 임시 Git 저장소에서만 변경 작업을 실행하고 실제 사용자 저장소에는 무단 변경 없음
- GPT가 없어도 사용 가능한 공통 기획 입력 포맷의 최소 테스트 준비
- 누락된 제공자는 `not_installed` 또는 `unavailable`로 표현
- 검증 결과와 다음 구현 순서를 Markdown으로 저장

## 4. Phase 0 다음
검증에 성공하면 `prompts/PHASE1-VERTICAL-SLICE.md`로 **첫 실제 웹 화면**을 구현한다. 화면에는 프로젝트 선택, 프롬프트 전송, 실시간 이벤트, 실행 중단, Task 상태, 승인 로그가 들어간다. 코드 그래프·MCP 설치 화면·다중 AI 자동 배정은 이후로 미룬다.

## 제약
- 공식 문서: https://learn.chatgpt.com/docs/app-server
- App Server는 제품 통합용 인터페이스지만 일부 기능 및 전송 모드는 실험적이다. 처음에는 로컬 `stdio`부터 사용하고, 버전을 고정하고 회귀 테스트를 작성한다.
- 공개 웹에 배포하지 말고 `127.0.0.1`에만 바인딩한다. 인증·토큰 파일이나 OAuth 정보를 사용자 브라우저/로그에 노출하지 않는다.
