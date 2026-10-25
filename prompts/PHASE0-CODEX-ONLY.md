# Phase 0 — Codex-only local integration spike

## Context
사용 가능한 구독: **GPT Pro**. 현재 Claude Code나 다른 유료 AI는 필수가 아님. 최종 제품은 제공자 중립이며 ChatGPT 계정이 없어도 내장 기획·로컬 관리가 가능해야 함. 이 단계에서 전체 앱이나 화려한 UI를 만들지 마라.

## 0. 먼저 확인
- `AGENTS.md`와 `docs/00-START-HERE.md`, `docs/02-TECH-DESIGN.md`, `docs/03-BACKLOG.md`, `docs/07-PROVIDER-NEUTRAL-CORE.md`를 읽어라.
- 현재 OS, `node`, `npm`, `git`, `codex` 버전과 설치 여부를 확인해라. 값이 없는 도구는 미설치로 기록하고 사용자가 설치 승인하기 전까지 무리하게 설치하지 마라.
- Codex CLI 로그인은 일반 명령 수준에서 확인하되 토큰과 인증 파일의 내용을 조회하거나 로그로 출력하지 마라.
- 공식 App Server 문서와 실제 CLI `help`를 확인하고 지원하지 않는 명령을 추측하지 마라.

## 1. Codex integration POC
- 테스트 코드 및 스키마만 최소한으로 만들 것.
- Node.js child_process로 `codex app-server`를 **stdio**로 실행하고 `initialize`, `initialized` 후 thread와 turn을 시작하는 JSON-RPC 클라이언트를 작성/검증하라.
- 실제 프롬프트 테스트는 격리된 임시 Git 저장소에서 단 한 번의 짧고 안전한 메시지로 진행해라. 실행이 불가능하거나 추가 승인이 필요하면 일단 미검증으로 두고 결과를 보고하라.
- 델타 이벤트, 완료/오류/중단 이벤트, 서버 측 승인 요청을 파싱할 수 있는 테스트 픽스처와 단위 테스트를 작성하라. 승인 테스트에서는 기본값을 `deny`로 두어라.
- `threadId`, `turnId`, 작업 실행 상태, 실제 테스트 검증 상태를 분리하라.
- rate limit/usage는 제공되는 공식 인터페이스가 확인되면 시도하되, 값이 없을 때는 `unknown` 처리하라. 가짜 값으로 실제 사용량을 표시하지 마라.
- 로그 파일에 토큰, 비밀 값, 민감한 원문이 노출되지 않도록 필터를 두어라.

## 2. Provider-neutral contract
- 0/1/2개 제공자가 등록된 상태를 표현할 수 있는 최소 ProviderRegistry 타입과 capability 계약 테스트를 만든다.
- `not_installed`, `auth_required`, `ready`, `unsupported`, `unknown`을 구분한다.
- 외부 기획 원본/수동 Markdown 또는 JSON의 출처, 버전, 완료 조건을 표현하는 planning 타입과 검증 테스트를 만든다. ChatGPT/Claude/Gemini 계정이 없어도 통과한다.
- 제품 요구사항 중 Claude 어댑터는 별도 후속 작업으로 남기고, 스텁을 실제 기능으로 표시하지 마라.

## 3. Deliverable and gate
작업 후 `docs/PHASE0-RESULTS.md`를 작성해라.
- 실제 환경·버전·로그인 가능 여부(비밀 데이터 제외)
- 실제 실행한 명령과 결과(검증 성공·실패·미실행을 분리)
- App Server 인터페이스 검증 결과, 미지원 또는 실험적 API 위험
- 테스트 명령과 통과/실패 개수
- Phase 1의 기술 선택과 기존 설계 수정 필요사항
- 다음에 구현할 한 개의 좁은 수직 슬라이스

**Phase 0 범위를 넘는 거대한 UI, 실제 Claude 인증 요구, OpenAI API 키 발급, 자동 전체 권한 승인, 공유 포트 개방, 무한 반복 구현은 하지 마라.**
