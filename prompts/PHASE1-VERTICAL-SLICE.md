# Phase 1 — Codex-only first web slice (only after Phase 0 gate)

선행 조건: `docs/PHASE0-RESULTS.md`에서 실제 Codex CLI/App Server 연동 방법과 제한 사항을 확인하고 문제를 해결한 후 진행.

목표: `http://127.0.0.1:<port>`에서 실행되는 최소 관제 웹에 다음을 구현한다.
1. 로컬 프로젝트 폴더 등록/전환(허용된 경로만), Git 상태 표시.
2. 제공자 상태: Codex ready, Claude not_installed, 다른 제공자 unavailable 등 실제 값. 0개인 경우 Planning 화면만 활성화.
3. `Ideas & Planning`: Markdown/JSON 붙여넣기 또는 업로드, PRD 미리보기/버전/수동 승인.
4. 승인된 계획을 Task로 변환하고 Codex 실행기에 사용자 프롬프트 전달.
5. App Server stdio 기반 스트리밍 결과/명령 실행 상태/중단/승인 요청 표시. 실제로 지원되지 않는 기능은 숨기고 이유 표시.
6. Git diff, 테스트 종료 코드, 미검증 표시, 사용자 완료 승인.
7. SQLite에 Task/Run/승인/이벤트 저장. 새로고침과 서버 재시작 후 읽기 가능. 중단 작업은 자동 재실행 금지.

권장: TypeScript + React + Node.js + SQLite. 최소 의존성 및 Vitest 테스트. UI와 백엔드의 인증/권한 경계를 분리. 원격 접속 비활성화. 새 프로젝트 생성이나 Git 변경 전에 사용자 승인; 기존 repo는 자동 수정하지 않는다.

완료 조건: 임시 Git 프로젝트에서 `기획안 입력 -> 승인 -> 웹 프롬프트 -> Codex 답변/명령 -> 테스트 결과 -> diff 검토 -> 사람 승인`이 실제로 재현되고, 로그/화면에 비밀정보가 남지 않는 것. 실제 실행하지 않은 결과는 성공으로 꾸미지 않는다.

Phase 1 완료 후 사용자에게 실행 명령, 주요 화면, 구현한 기능과 남은 기능, 테스트 실행 결과를 보고하라.
