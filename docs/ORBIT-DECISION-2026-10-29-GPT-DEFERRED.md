# 결정 — ChatGPT 웹 연동 1차 실사용 보류 (2026-10-29)

**사용자 결정:** ChatGPT 웹 연동은 1차 실사용 버전에서 보류(deferred)한다. 삭제나 영구 제외가 아니다. 이후 개발은 Claude Code와 Codex 중심으로 Parallel-First 방식으로 진행한다. 진행 항목은 CQG 완성, 실제 병렬 E2E, 첫 실사용 흐름, Model Registry, Usage, Skills/MCP/Plugins, Harness Evolution이다. 기존 Adaptive Model Routing, CQG, 자동 통합, 권한·보안 정책은 유지한다. Push, main 병합, 배포, 신규 유료 API는 계속 금지한다.

## 요구사항 표시
- F04의 ChatGPT 웹 부분과 A06을 `deferred`로 표시한다(`ORBIT-SCOPE-2026-10-27.md`). 요구사항 문구는 삭제하지 않았다.
- **1차 실사용 완료 기준:** A04·A05와 나머지 수용 항목. A06은 제외한다.
- **전체 제품 완료 기준:** A06을 포함한다.

## 보존 상태 (추가 개발·실제 웹 연동 테스트 보류)

| 항목 | 위치 | 상태 |
|---|---|---|
| 설계 | `docs/ORBIT-GPT-D1.md` | 커밋됨 |
| G1 교환 표식·응답 검증 | 브랜치 `claude/gpt-g1` | 커밋됨, 13/13. dev 미통합 |
| G3 인계 문서 표식 | 브랜치 `claude/gpt-g3` | 커밋됨, 30/30. dev 미통합 |
| G2 가져오기 연결 | 브랜치 `codex/gpt-g2` `73471e1` | 커밋됨, planning 테스트 159/159. dev 미통합 |
| G4 UI, G5 진행판 | — | 미착수, 보류 |

GPT 브랜치는 통합 큐에서 제외했다. 현재 dev의 동작은 바뀌지 않는다. 브라우저 자동화 정책 차단(`server/browser/adapter.ts`)도 그대로다. 재개할 때는 최신 dev를 위 브랜치들에 병합하고, CQG 전체 검증을 거쳐 통합한다.
