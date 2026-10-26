# Planning handoff implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the shared service and superpowers:subagent-driven-development for independent serializer/UI work.

**Goal:** 저장된 기획을 MD/JSON으로 내보내고 Task/Run에 연결된 개발 증거를 수동 재기획용 문서로 제공한다.
**Architecture:** 기존 Studio/SQLite 버전·Task와 VerificationService를 재사용한다. export는 저장 id/revision/hash에 결합하고 feedback은 서버 증거만 투영한다. 외부 웹 호출·새 프레임워크·자동 실행은 없다.
**Tech Stack:** 기존 Node24/TypeScript5.9.3/React/SQLite.
**Spec:** goal-objective B, docs/06-CHATGPT-PLANNING-BRIDGE.md, docs/planning/INTEGRATION-CONTRACT.md. 실제 schema1.0이 오래된 Bridge 예시0.2에 우선한다.

## Constraints and review focus

- 승인·기존 Task/Run 불변, 과거 버전 export 허용, 재기획은 새 draft.
- 기획 MD/JSON 모두 무손실 재가져오기. 일반 MD로 표현 불가능한 내용은 정확한 전용 envelope의 canonical JSON code block으로 제공한다. envelope 외부에 중복된 권위 본문을 두지 않는다.
- export/feedback에 알려진 개인정보·credential 패턴이 있으면 본문을 변조하지 않고 고정 코드로 차단한다. 검출은 휴리스틱이며 외부 전송 전 사용자 검토 필요.
- project→plan→task→run→workspace→check 결합을 검증한다. feedback은 구조화된 ID/status/hash/time/exit만 포함하며 prompt/response/output/명령/절대경로는 제외한다.
- 현재성은 기존 검증 서비스가 판단한다. 실패·stale·unknown·실행중을 통과로 바꾸지 않는다. 수집 실패는 available처럼 표시하지 않는다. diff는 현재 workspace의 파일 상태만, Run이 바꾼 파일이라는 인과관계는 주장하지 않는다.
- 다운로드는 명시 버튼, feedback은 명시 생성 POST·미리보기 후 다운로드. 질문 텍스트는 저장·로그 없이 요청 범위에서만 사용한다. 프로젝트 전환 뒤 늦은 응답은 폐기한다.

## Tasks

- [x] Serializer owner: server/planning/export.ts + parser.ts 좁은 envelope 지원, tests/planning-export.test.ts. RED→GREEN로 일반/복잡 MD·JSON roundtrip, 악성 구역/제어문자·크기·credential·PII·불변 content 검증.
- [x] Root: shared/planning-handoff.ts DTO, server/planning-handoff-service.ts 증거 수집, Studio export/HTTP 보호 경로, tests/planning-handoff.test.ts 및 HTTP 검증. 권한·최신성·확정/미확정·secret 제외·과거버전 확인.
- [x] UI owner: PlanningStudio 저장버전 export, 별도 PlanningFeedback 컴포넌트와 ProjectStudio 연결. SSR·프로젝트 epoch, E2E에서 다운로드 파일/preview/신규초안·기존승인보존 검증.
- [x] 독립 리뷰 후 focused/type, 제품 동결 뒤 전체322/322·type/build0·Windows26/26. 실패와 검증 한계를 master results에 기록했다.
