# LIVE-CLI — 구독 CLI 실제 Orbit Runtime E2E (2026-10-29)

근거: `ORBIT-SCOPE-EXTENSION-2026-10-29.md` 절대 경계 7, `ORBIT-UNIFIED-BACKLOG-2026-10-29.md` 순번 1.
기준 HEAD `fecf6ff` (`codex/orbit-mac-handoff-2026-10-26`, INT-QG fast-forward 후). Node 24.22.1.
호출 수: Codex 1회, Claude Code 1회. Reviewer 호출 0회. 재시도 0회. 유료 API, 설치, 로그인 변경, Push 없음.

## 결과

| 항목 | Codex (`execute.code`) | Claude Code (`execute.general`) |
|---|---|---|
| Harness | `scripts/phase4-native-e2e.ts --approved-live` | `scripts/live-claude-general-e2e.ts --approved-live` |
| 증거 | `docs/evidence/live-cli-codex-2026-10-29.json` | `docs/evidence/live-cli-claude-2026-10-29.json` |
| CLI / 인증 | 0.165.0 / `confirmed`, connection `ready` | 2.1.312 / `subscription` (`claude.auth.status`) |
| 경로 | HTTP → capability route → execution → `codex.app_server` | HTTP → capability route → execution → `claude.print` |
| runId | `7cdbdb00-80c7-4477-8cab-5845c638f144` | `8b269460-445a-4341-9640-a38cbb3ea54c` |
| requestId | `acc7a3d7-cbf2-4f76-b057-185ae4000c5a` | `70c0bd57-cd8d-470c-b248-dd7246f0e850` |
| session / turn | turn `01a184f5-f316-7873-82db-c534e0637301` | session `af82ae4b-0e89-4c9f-81c0-fc1e7177653a` |
| 산출물 | worktree `result.txt` exact, sha256 `29519dcf…b691a`, worktree 변경은 `result.txt`만, 원본 clean | project `result.txt` exact, sha256 `81e8eb3f…2faab3`, 파일 `README.md`, `result.txt`만 |
| 종료 | `completed` → `quality_blocked` | `completed` → `execution_completed` |
| 소요 | 12,469 ms | 14,811 ms |
| 관측 모델 | actual `unknown` (서버 설정 `gpt-6-astra`는 실제 모델로 승격하지 않음) | `claude-opus-5-5`, `native_observed`, evidenceSource `native` |
| 출처 | `native`, `livePipelineVerified:false` | `native`, `livePipelineVerified:false` |
| 중복 방지 | 같은 `start` 재요청 → 같은 runId, Run 1개 | 같은 `start` 재요청 → 같은 runId, Run 1개 |
| GET 읽기 전용 | 이벤트 seq 불변 | 이벤트 seq 불변 |
| 재열기 | Store 재열기 Run 1개, 상태 보존 | Store 재열기 Run 1개, 상태 보존 |
| 품질 | `QUALITY_PRODUCER_MODEL_UNKNOWN`, steps 0. Reviewer 호출 없음 | `quality-preview`만 실행. Reviewer 호출은 승인 범위 밖이라 실행하지 않음. 진행판 `tasks[].quality.execution=completed/native`, format `QUALITY_EVIDENCE_MISSING` |

두 실행 모두 "실행 완료"이며 "독립 품질 검증 통과"가 아니다. Codex 모델 unknown은 그대로 유지했다.

## 발견 사항 (CORE-LIVE 입력)

1. **일반 작업 프롬프트 충돌**: Orbit 일반 작업 프롬프트는 결과를 `task-<id>.md`에 쓰라고 지시한다. 그런데 승인된 요구사항은 "다른 파일을 만들거나 수정하지 말 것"이다. Claude는 충돌을 보고하고 승인 기준을 따라 `result.txt`만 만들었다. 프롬프트가 승인 요구사항보다 우선하지 않도록 고쳐야 한다.
2. **Codex 실제 모델 관측 불가**: `codex.app_server` 경로에서는 actual model이 계속 `unknown`이다. 그래서 Codex 산출물의 독립 교차 리뷰는 계속 `QUALITY_PRODUCER_MODEL_UNKNOWN`으로 차단된다.
3. **Claude 산출물 독립 리뷰**: 실행 모델이 관측되므로 다른 모델 reviewer로 리뷰할 수 있다. 다만 reviewer 실제 호출은 추가 승인이 필요하다 (경계 7).
4. **HTTP 전체 재시작 증명**: 두 harness 모두 Store 재열기까지만 확인했다. 전체 HTTP 재시작 증명은 별도로 필요하다.
