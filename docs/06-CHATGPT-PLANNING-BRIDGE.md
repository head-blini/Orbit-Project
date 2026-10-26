# ChatGPT 웹 ↔ AI Coding Control Center : 기획 인계 설계 v0.3 (선택적 커넥터)

작성일: 2026-10-25 · 상태: **설계 및 일부 구현**

2026-10-26 구현 범위: 직접 편집·Markdown/JSON v1 가져오기·버전·승인·Task 실행, 저장 버전 내보내기, Task/Run 기반 수동 피드백, 저장 버전 diff·영향 Task 표시·선택한 후속 Task 생성을 제공한다. 아래 schema 0.2 예시는 초기 설계이며 현재 가져오기는 `server/planning/parser.ts`의 schema 1.0 계약을 따른다. decisions와 전체 출처 metadata, ChatGPT 원격 MCP는 아직 구현하지 않았다. 피드백은 원시 로그·코드·명령·모델 응답을 제외하고 구조화된 실제 기록만 제공한다. 자동 외부 전송이나 기존 승인본 변경은 없다. 최신 검증 결과는 ORBIT-MASTER-RESULTS.md를 참조한다.

### 구현된 버전 비교와 후속 Task

- 같은 프로젝트·lineage의 이전 저장 버전과 목표 버전을 비교한다. 요구사항 label을 기준으로 추가·삭제·내용·완료 조건 변화와 영향받는 이전 Task를 표시한다.
- `GET /api/projects/:projectId/plans/:targetId/diff?baseVersionId=...`는 읽기 전용이다. 현재 승인된 head이고 미결정 질문이 없을 때, 사용자가1–100개 label과 별도 동의를 선택하여 `POST /api/projects/:projectId/plans/:targetId/replan`을 호출한다. 최신 preview digest·세션·CSRF를 검증한다.
- 이전 Task/Run/승인은 불변이다. 새 Task 초안에 이전 버전과 Task 식별자를 연결하며, 후속 실행은 별도 사용자 동작이다. 삭제된 요구사항에는 새 Task를 만들지 않는다. 부분 생성 후 전체 Task 생성은 누락된 요구사항만 채우고 기존 ID와 연결을 보존한다.

> 이 문서는 `07-PROVIDER-NEUTRAL-CORE.md`의 공급자 중립 기획 구조에 **ChatGPT 웹을 연결하는 방법만** 설명한다. 시스템의 필수 시작 경로는 내장 편집기 + 제공자 중립 import다.

## 1. 요구사항과 역할

**ChatGPT 웹은 선택 가능한 기획 경로 중 하나다. GPT/ChatGPT 계정이 없는 사용자도 관제센터에서 직접 기획하거나 다른 AI 웹·CLI를 통해 같은 단계를 진행한다.** ChatGPT Projects는 관련 채팅·파일·지침을 묶는 작업 공간이며, 관제센터 자체가 ChatGPT 웹 전체를 재현하는 제품이 아니다. 관제센터는 **명시적으로 인계받은 기획 산출물을 승인된 개발 기준**으로 보존하고, 구현·테스트·리뷰 증거를 ChatGPT로 되돌릴 수 있게 한다.

- ChatGPT 웹: 아이디어 제안, 대안 검토, 자료 조사, 기능/비기능 요구사항, 우선순위, 설계 결정, 미결정 문제를 산출.
- 관제센터: 아이디어/기획 인제스트, 원문·출처·버전 관리, 사용자 승인, Task 생성, 실행·검증 결과의 기획 피드백 생성.
- Claude Code·Codex: 승인된 버전의 명세 및 실제 저장소를 근거로 구현과 교차 검토 수행.
- 사용자는 ChatGPT 웹과 관제센터의 두 화면을 오가되 **중요 문서는 버전·변경 이력으로 연결**할 수 있어야 한다.

## 2. ChatGPT 이용자용 선택 UX (V1에서 지원, 계정 연결 필수 아님)

1. 관제센터에서 프로젝트를 선택해 **Ideas & Planning** 탭을 연다.
2. 'ChatGPT 웹에서 기획'은 `https://chatgpt.com/`을 여는 링크와 함께 현재 프로젝트의 목표/제약/완료 조건 템플릿을 복사하게 한다. 앱이 로그인 비밀번호나 채팅 토큰을 요구하지 않는다.
3. ChatGPT 웹에서 브레인스토밍·조사·대안 평가를 하고, 최종안/요구사항/완료 조건을 Markdown 또는 구조화된 JSON으로 정리한다.
4. Ideas & Planning의 **붙여넣기·파일 가져오기**로 산출물을 넣는다. ChatGPT 대화 URL·작성자·참고 링크는 사용자 입력일 때만 provenance로 저장한다. URL을 자동 방문하거나 채팅 전체를 수집하지 않는다.
5. 서버가 schema/version/필수 값 검증을 하고 **미리보기**에 목표·요구사항·완료 조건·제약·미결정 사항을 표시한다. 누락·충돌은 사용자에게 명시한다.
6. 승인하지 않으면 `DRAFT/REVIEW_REQUIRED`이며 **실행 버튼 비활성**. 사용자가 '기획 확정'하면 불변 `APPROVED` 버전을 만들고 **Task 초안**으로 매핑한다.
7. Claude Code·Codex 작업과 테스트/리뷰는 **그 Task의 참조 기획 버전**을 근거로 실행한다. 중간에 새로운 문서를 가져와도 기존 실행 Task는 자동 변경되지 않는다.
8. 실행 중 새 제약·오류·설계 질문이 나오면 'ChatGPT에 재검토 요청' 버튼으로 **Markdown 피드백 패키지**를 생성한다. 사용자가 복사하거나 파일을 다운로드해 ChatGPT에 제공한다.
9. ChatGPT에서 수정된 기획안을 가져오면 기존 승인본과 diff·변경 요구사항·영향 Task를 보고 승인. 선택적으로 후속 Task 생성/일시 정지/재계획을 수행한다. 무단 덮어쓰기·작업 재실행 없음.

## 3. Ideas & Planning 화면 세부 기능

| 섹션 | MVP 기능 | 설명 |
|---|---|---|
| ChatGPT Launch | 'ChatGPT 열기' + '기획용 프롬프트 복사' | 웹 채팅 자체를 로컬에 iframe으로 내장하지 않는다 |
| Import | 텍스트 붙여넣기, `.md`, `.json` 파일 | 파일 포맷·크기 제한, 원문 불변 보존, 데이터만 처리 |
| Overview | 목표, 범위, 결정, 미결정 질문, 제약, 완료 조건 | 추출 신뢰도가 낮거나 누락된 항목은 경고 |
| Versions | `Draft`, `Approved`, `Superseded` 목록 | 승인 전 버전 차이, Task 영향, 이전 이력 열람 |
| Promote | 승인 버전 → Task 초안 생성 | 개발 실행과 분리. Task 선택·편집 후 사용자 실행 |
| Feedback | 체크 결과, 리뷰, 구현 장애, 의사결정 요청 추출 | ChatGPT 붙여넣기/파일용 Markdown 패키지 |
| Traceability | 요구사항 ID ↔ Task ↔ 실행/체크/리뷰/커밋 | '왜 바꿨는가?'와 '완료 근거'를 연결 |

## 4. 구조화된 인계 페이로드 (권장 최소안)

사용자가 Markdown 본문으로 전달해도 되고, 다음 JSON을 복사해 올 수도 있다. JSON은 **기획 내용에 대한 data schema**이지 실행 지시 API가 아니다.

```json
{
  "schema_version": "0.2",
  "source_type": "chatgpt_web",
  "title": "사용자 로그인 개선",
  "goal": "사용자가 안정적으로 로그인하고 오류를 이해할 수 있도록 한다",
  "scope": ["로그인 화면", "오류 상태 처리"],
  "non_goals": ["회원가입 개편"],
  "requirements": [
    {
      "label": "REQ-01",
      "title": "로그인 오류 표현",
      "description": "인증 실패와 네트워크 오류를 구분해 안내한다",
      "acceptance_criteria": ["두 오류를 사용자 화면에서 구분할 수 있다"]
    }
  ],
  "constraints": ["기존 인증 인터페이스 유지"],
  "decisions": [{"topic": "인증", "decision": "기존 클라이언트 재사용", "rationale": "중복 구현 방지"}],
  "open_questions": ["실패 횟수 제한은 기존 정책을 따른다 — 정책 확인 필요"],
  "references": []
}
```

- 필수: `schema_version`, `title`, `goal`, `requirements`(최소 하나), 각 requirement의 `title`·`description`·`acceptance_criteria`.
- 선택: `source_type`, `scope`, `non_goals`, `constraints`, `decisions`, `open_questions`, `references`, 사용자 제공 원본 URL.
- 서버가 실제 고유 ID 및 버전 번호를 발급하며, 사용자 제공 `label`은 출력용 식별자일 뿐 우선권이 없다.
- Markdown은 필드 매핑 화면에서 내용 확인 후 저장; 모델의 요약을 '원문에서 확인된 사실'로 자동 승인하지 않는다.
- 승인된 문서는 서버가 콘텐츠 해시로 보존하고 Task에 연결한다.

## 5. 개발 → ChatGPT 피드백 형식

```markdown
# 기획 재검토 요청: 사용자 로그인 개선
- 프로젝트: <프로젝트 표시 이름>
- 기획 버전: v2 (승인일 포함)
- 대상 작업: TASK-003
- 구현 커밋: <base SHA>..<head SHA>

## 확인된 구현 사실
- 변경 파일/주요 결정
- 실제 통과·실패한 빌드/테스트와 실행 시각
- Codex/Claude 리뷰의 확인된 발견사항

## 기획적으로 결정이 필요한 문제
1. <문제와 근거, 선택지, 각 선택의 영향>

## ChatGPT 요청
- 기존 요구사항에서 유지할 것과 수정할 것을 구분해 제안해줘.
- 바뀐 요구사항의 완료 조건과 이유를 적어줘.
- 불확실한 부분은 미결정 질문으로 남겨줘.
- 수정된 인계 문서를 새 버전으로 작성해줘.
```

**이 파일은 명시적으로 ChatGPT에 업로드/붙여넣기하는 결과물**이다. 서버가 타 서비스의 채팅을 자동 갱신했다고 표시하지 않는다.

## 6. 선택적 V2: ChatGPT 커스텀 MCP 플러그인

OpenAI 공식 개발 문서는 ChatGPT가 **인증 가능한 인터넷 HTTPS MCP 서버**에 연결해 도구를 호출하는 흐름을 안내한다. `localhost` 전용 관제센터에 직접 연결하는 방식이 아니다.

```text
ChatGPT 웹(사용자가 선택한 경우)
    │ 사용자 호출·승인
    ▼
Custom ChatGPT Plugin / MCP
    │ HTTPS + 인증, 기본 OFF, 최소 권한
    ▼
별도 Planning Bridge Gateway (요청 범위 제한)
    │ 허용된 Planning API만 접근
    ▼
로컬 관제센터 Planning Service ──> 승인 전 Draft 저장
    (코드/CLI/파일 원문 접근 없음)
```

초기 공개 도구 예시: `submit_planning_draft`, `get_project_plan_summary`, `list_open_questions`, `propose_plan_revision`. 직접 실행, 파일 쓰기, SSH/Git push, 비밀정보·임의 파일 조회 도구는 **제공하지 않는다**.

요건: 사용자 명시 opt-in, 안전한 인증, CSRF/Origin 제한, 터널 만료/철회, 요청별 범위 제한, 감사 기록, 데이터 최소화. 사용 계정에 커스텀 플러그인 접근이 가능한지와 인증 호환성은 실제 POC로 검증한다. 공개 포트로 로컬 CLI 서버를 직접 노출하지 않는다.

## 7. 명시적 제외 사항과 비용

- ChatGPT 전체 대화·프로젝트 메모리·플러그인을 API처럼 직접 추출, 스크래핑, 세션 쿠키 공유하는 기능 제외.
- ChatGPT Pro 구독만으로 **일반 OpenAI API가 무료 호출되는 것으로 가정하지 않는다**. V1 수동 기획 인계에는 별도 OpenAI API를 요구하지 않는다.
- ChatGPT 대화 공유 URL은 단순 참조 링크이며, 그 URL을 넣었다고 완전한 인계가 완료되는 것은 아니다.
- ChatGPT에서 작성한 내용은 검토와 승인 전까지 비신뢰 입력이며, 기획 문서만으로 쉘 명령을 자동 실행할 수 없다.

## 8. 이 경로의 수용 테스트

1. ChatGPT에서 만든 Markdown/JSON을 가져오면 원문·출처·해시·버전이 저장된다.
2. 스키마 누락 시 오류와 보완 방법이 표시되고 부분 원문은 보존된다.
3. 승인 전은 코드 실행 비활성; 승인 후 요구사항별 Task 초안이 생성된다.
4. 새 기획 버전이 들어와도 기존 Task/브랜치/커밋은 변하지 않는다. 변경 diff와 영향 Task가 보인다.
5. Task의 테스트 실패 결과·리뷰·의사결정 질문을 Markdown 파일로 내보낼 수 있다.
6. 사용자가 ChatGPT에서 수정한 새 기획을 가져오면 이전 승인안과 비교해 수동 승인 후 선택적으로 Task를 업데이트할 수 있다.
7. 어떠한 경우에도 ChatGPT 웹 인증 토큰/쿠키나 프로젝트 전체 대화를 수집하지 않는다.

## 9. ChatGPT 웹 기획 프롬프트 (복사해 시작)

```text
우리는 현재 프로젝트의 기능을 구현하기 전에 아이디어와 요구사항을 설계하고 있다.
브레인스토밍을 거쳐 다음 결과를 작성해줘.
1) 해결하려는 문제와 사용자 가치
2) 범위(포함/제외) 및 가장 중요한 대안·절충점
3) 기능별 요구사항과 검증 가능한 완료 조건
4) 비기능 요구사항과 주의할 제약
5) 아직 결정할 수 없는 질문과 확인 방법
6) 개발 에이전트에 전달할 간결한 작업 명세

확인되지 않은 기술 전제를 확정된 사실처럼 쓰지 말고 구분해줘.
사용자가 승인할 수 있도록 기획안을 먼저 제시하고, 최종 승인된 내용은
Markdown 또는 위의 planning_handoff.json 형식으로 만들어줘.
```

## 공식 자료

- ChatGPT Projects: https://help.openai.com/ko-kr/articles/10169521-projects-in-chatgpt
- ChatGPT 커스텀 MCP 플러그인/HTTPS 연결: https://developers.openai.com/plugins/build/app-quickstart
