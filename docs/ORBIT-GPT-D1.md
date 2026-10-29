# GPT-D1 — ChatGPT 웹 구조화 인계 설계 (2026-10-29)

작성: Claude worker (Plan, model opus via model-routing ledger `GPT-D1`), read-only. 검토: Claude Code 오케스트레이터.

**결론:** 브라우저 자동화가 금지된 상태다(`server/browser/adapter.ts:21-34`, `POLICY_REVIEW_REQUIRED`). 그래서 백로그 4의 "실제 연결 증거"와 A06은 **blocked**로 기록한다. 구현 가능한 범위는 사용자가 매개하는 구조화 왕복뿐이다. 이 왕복은 결속 확인 수단이지 출처 증명이 아니다.

**잠정 기본값 (보수적, 사용자 결정 전):**
1. chatgpt.com 브라우저 자동화는 하지 않는다.
2. 실제 ChatGPT 대화로 하는 왕복 시험은 승인 전까지 하지 않는다.
3. 붙여넣은 응답은 기존 `revise` 동작으로 들어간다. 즉 새 draft가 생기고 head가 이동하며, 사용자가 승인하기 전에는 실행할 수 없다. 기존 task 인계가 stale이 되는 것은 의도한 신호다.
4. 표식이 없는 일반 붙여넣기는 계속 허용한다. 다만 ChatGPT 출처로 표시하지 않는다.
5. ChatGPT 웹 잔여 한도는 unknown으로 둔다.

## 1. 현재 상태

### 재사용할 기존 기능
- **작업 인계 내보내기**
  - 데이터 구조는 `HandoffPackage`(`shared/handoff.ts:5-18`)다.
  - `HandoffService.build`(`server/handoff-service.ts:22-66`)가 승인 version·contentHash·current에 결속해 만들고, 경로를 가린다.
  - `GET /tasks/:id/handoff`(`server/http.ts:127-130`)로 내보낸다.
- **기획 재검토 패키지**
  - `PlanningHandoffService`(`server/planning-handoff-service.ts:24-68`)가 만든다.
  - 크기·credential·outbound 검사를 한다.
  - 자동 전송은 하지 않는다.
- **응답 가져오기**
  - JSON v1/Markdown 파서(`server/planning/parser.ts:13-33`)를 쓰고, 크기 상한은 256KiB다.
  - provenance는 사용자가 자유롭게 선언한다. 그래서 UI에는 "미검증"으로 표시한다.
- **stale 보호**
  - `revise`는 `REVISION_CONFLICT`를 낸다(`server/planning/repository.ts:32-48`).
- **Registry 'web' 항목**
  - `declared` 인증만 지원한다. 검증 결과는 `unsupported`다(`server/model-registry-service.ts:216-218`).

### 없는 것
- 요청과 응답을 결속하는 장치가 없다.
- 출처 `kind`를 사칭해도 막지 못한다.
- T5 테스트(`tests/chatgpt-web-bridge.test.ts`)가 없다.

### 정책상 blocked (유지)
- 대화·모델·전송·완료를 관측하는 것
- 쿠키·토큰을 추출하는 것
- 유료 API로 전환하는 것

## 2. 최소 설계

### 내보내기 표식
기존 Markdown 두 가지에 다음 한 줄과 "첫 줄 표식 유지, JSON v1로 답변" 지시를 추가한다.

```
<!-- orbit-exchange:v1 id=<sha256(projectId|taskId|versionId|revision|contentHash) 16hex> v=<versionId> r=<rev> h=<contentHash> t=<taskId> -->
```

새 라우트나 새 테이블은 만들지 않는다.

### 가져오기 검증 (순수 함수)
1. 표식은 정확히 1개여야 한다.
2. 크기와 제어문자를 검사한다.
3. `containsCredential`·`inspectOutbound`에 걸리면 `PLANNING_IMPORT_BLOCKED`로 거부한다.
4. v/r/h가 현재 head와 다르면 `GPT_EXCHANGE_STALE`(409)로 거부한다.
5. id/t가 맞지 않거나 task의 기준 version이 다르면 `GPT_EXCHANGE_MISMATCH`로 거부한다.
6. 본문은 `parsePlanningDraft`로 파싱한다.
7. 출처는 `{kind:'chatgpt_web_user_pasted', providerId:null}`로 강제한다.
8. 표식 없이 이 kind를 선언하면 거부한다.

### 증거 등급
- 모델 식별 필드는 없다. 관측 모델은 unknown이다.
- review/quality 기록을 만들지 않는다. 그래서 독립 모델 리뷰 증거로 세지 않는다.

### UI
- 표시 문구: "ChatGPT 웹 응답(사용자 붙여넣기) · 모델·대화 미확인"
- stale·mismatch 오류는 한국어 문구로 안내한다.
- 복사 버튼을 둔다.

### 증명 범위
- 증명하는 것: 기준에 묶인 요청을 생성했다는 사실, 같은 표식을 돌려준 붙여넣기가 들어왔다는 사실. 즉 사용자가 증언한 왕복이다.
- 증명하지 않는 것: ChatGPT가 실제로 생성했는지, 어느 대화·어느 모델인지.

## 3. 작업 단위 (fake 테스트)

| 단위 | 소유 파일 | 순서 |
|---|---|---|
| G1 core | 신규 `server/planning/gpt-exchange.ts`, `tests/gpt-exchange.test.ts`, `tests/chatgpt-web-bridge.test.ts` | 1 |
| G2 import 연결 | `server/studio.ts`, `server/planning/repository.ts`, `server/planning/parser.ts` (+ 기존 planning-revisions 테스트) | 2 |
| G3 export 표식 | `server/handoff-service.ts`, `server/planning-handoff-service.ts`, `shared/handoff.ts` (+ handoff 테스트) | 2 (G2와 병렬) |
| G4 UI | `web/planning/PlanningStudio.tsx`, `web/project-progress.tsx`, `web/main.tsx`(errors 맵만) | 3 |
| G5 진행판 | `server/project-progress.ts`, `shared/project-progress.ts` | CQG-4 이후, 선택 사항 |

T5 테스트는 네 가지다:
- `wrong_conversation_does_not_complete_task`
- `late_reply_matches_original_request`
- `timeout_after_submit_does_not_auto_resubmit`
- `login_required_is_blocked_not_success`
