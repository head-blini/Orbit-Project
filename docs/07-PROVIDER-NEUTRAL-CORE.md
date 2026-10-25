# Provider-Neutral Core — AI Coding Control Center v0.3

작성일: 2026-10-25 / 상태: **설계 초안, 실행·인증 POC 전**

## 1. 목표 및 비목표
- **목표:** 사용자가 ChatGPT·Claude·Gemini 등 특정 서비스의 회원이 아니어도 앱을 설치하고 기획·코드·개발 진행을 시각화할 수 있게 한다. 실제 AI 실행에는 하나 이상의 **지원하는 코딩 에이전트 연결**이 필요하다.
- **우선 사용 사례:** (A) Claude-only, (B) Codex-only, (C) ChatGPT 웹 + Claude Code + Codex, (D) 외부 웹 PRD import, (E) 향후 Gemini CLI/OpenCode 기반.
- **비목표:** 플랫폼 제공자의 웹 채팅·기억·계정 쿠키를 관제센터가 추출하거나, 모델별 다른 인증/할당량을 통합 로그인처럼 우회하는 것.
- **제품 원칙:** 사용자 입장에서 중요한 것은 **기획→코드 변경→검증→승인** 과정이지 모델 브랜드가 아니다. 제품 제목·데이터 모델·API 경로를 특정 공급자 이름으로 고정하지 않는다.

## 2. 사용자 첫 실행(Onboarding)
1. 로컬 웹 열기(로그인 화면 강제 X). 프로젝트를 등록하거나 새 기획안 작성 선택.
2. 'AI 연결' 화면에서 현재 OS에 설치된 CLI를 **감지만** 수행(인증 토큰/쿠키/환경변수 값 수집 금지).
3. 카드는 `Ready`, `Login required`, `Not installed`, `Unsupported on this OS`, `Error`로 표시. 구독 유도·일괄 OAuth 로그인 없음.
4. 사용자에게 기본 역할을 묻되 부분 설정 허용: `Planning=Manual`, `Coding=Claude Code`, `Review=Human`처럼 구성 가능.
5. 기획 문서 없이는 실행 금지. 내장 PRD 편집기에서 작성하거나 외부 자료를 가져온 뒤 내용 검토·승인.
6. 사용량 카드에서는 미연결 제공자를 보이지 않거나 '미연결'로 표시. 한도 정보 미지원과 잔여 100%를 혼동하지 않음.

## 3. 기획 모드 세 가지 — V1 우선순위
| 모드 | 방식 | 외부 계정 필요 여부 | 필수 조건 |
|---|---|---|---|
| 내장 수동 기획 | 로컬 웹 편집기에서 PRD·완료 기준 작성, 승인·버전 관리 | **없음** | 로컬 앱 |
| 에이전트 기획 | **이미 연결된** CLI를 `role=planning`, 읽기 전용 정책으로 호출하고 결과를 DRAFT에 저장 | 해당 CLI의 공식 인증만 | planning capability·권한 POC |
| 외부 기획 | ChatGPT/Claude/Gemini 웹, Markdown/JSON/붙여넣기, 기타 텍스트 도구 | 선택한 서비스가 요구할 수 있음 | 내장 importer; 관제센터의 ChatGPT 로그인 불필요 |

**기획 교체 가능성:** 모든 모드는 같은 `PlanningArtifact`를 생성. 소스명은 이력용 정보지 실행 우선권이 아니다.

### PlanningArtifact v1 최소 스키마
```json
{
  "schema_version": "1.0",
  "title": "검색 기능 개발",
  "goal": "사용자가 항목을 검색한다",
  "requirements": [
    {"id": "REQ-01", "description": "검색어 입력 및 결과 표시", "acceptance_criteria": ["유효한 검색어로 결과를 볼 수 있다"]}
  ],
  "constraints": ["기존 공개 API 유지"],
  "open_questions": [],
  "decisions": [],
  "source": {"kind": "in_app_manual", "provider_id": null, "external_url": null}
}
```
클라이언트가 제출한 `source`는 비신뢰 메타데이터. 서버에서 정규화·승인/ID/해시/버전 부여. 불완전한 수동 초안은 저장 가능하지만 승인된 실행 명세로 승격할 때는 필수 항목 검증.

## 4. Provider Registry
- `ProviderAdapter` 구현체가 제공하는 공통 기능: `probe()`, `start(role, policy, prompt)` / 선택적 `resume`, `interrupt`, `subscribe`, `listModels`, `getUsage`, `getExtensions`.
- 제공자 ID는 **자유로운 문자열**(`claude_code`, `codex`, `gemini_cli`, `opencode` 등); DB migration 없이 확장.
- 기능별 capability: `planning`, `coding`, `review`, `stream`, `approval`, `resume`, `read_only_mode`, `quota`, `token_usage`, `plugins`, `mcp`, `skills`.
- capability는 공식 문서 존재만으로 `true`가 되지 않음. 설치된 정확한 CLI 버전의 기능 진단 + 계약 테스트를 근거로 표시.
- **역할 선택:** Planning/Coding/Review 제공자를 각각 지정하되, Review는 `human`, `same_provider_new_session`, `cross_provider`, `skip_with_approval` 중 선택 가능. **다른 제공자 없다고 개발 작업을 Blocked로 만들지 않는다.**
- **복구:** 실행 실패/한도 소진 시 같은 에이전트 재개가 지원되면 재개, 아니면 다른 에이전트에 명세·현재 SHA·테스트 증거를 인계. 대화 내부 상태 동기화라고 표현하지 않음.

## 5. 최소 기능 지원 표 (설계/검증 상태 구분)
| 제공자 | 로그인·인증 경로(공식 문서 확인) | 실시간 구조화 출력 | V1 역할 | 실제 연결 확인 |
|---|---|---|---|---|
| Claude Code | Claude 계정/지원되는 기업·API 구성 | CLI `--output-format stream-json` | **기획·구현·검토** | 미검증 |
| Codex | ChatGPT 로그인 **또는 OpenAI API 키(별도 과금)** | App Server 이벤트 | **기획·구현·검토** | 미검증 |
| Gemini CLI | Google 계정 로그인 또는 Gemini API 키/Vertex AI | Headless `stream-json` | **P1 확장** | 미검증 |
| OpenCode | 제공자별 인증, API, 지원되는 로컬 모델 | 제공 API/CLI 검증 필요 | **P1 확장 후보** | 미검증 |

*이 표의 명시는 실제 연결 성공을 뜻하지 않는다. 환경별 지원 모델·권한·요금 정책은 설치 버전과 계정에 따라 달라진다.*

## 6. 단일 AI 환경 E2E 예시
### A: GPT 없는 Claude-only 사용자
1. 관제센터에서 프로젝트 등록하고 내장 PRD를 직접 작성 **또는** Claude Code 기획 모드에서 초안 생성.
2. PRD 승인 → 구현 담당 Claude Code 선택 → 격리된 worktree에서 변경.
3. 테스트/린트 실행 → 변경 SHA·로그와 연결.
4. Reviewer는 사람이 검토하거나 Claude의 **새 읽기 전용 세션**에 맡김. 같은 모델이라고 표시.
5. 최종 승인/병합. 피드백은 외부 ChatGPT 없이 관제센터 안에서 수정 가능.

### B: Codex-only 사용자
위 과정에서 Codex를 기획·구현·검토 역할에 선택. **ChatGPT 웹을 열거나 GPT Pro를 구매할 필요는 없음**(단, Codex를 직접 쓰기 위한 계정 또는 공식 API 인증은 필요할 수 있고 API 키는 과금된다).

### C: ChatGPT 웹 + Claude Code + Codex 사용자
ChatGPT에서 아이디어·PRD → 관제센터 import/승인 → Claude 구현 → Codex 독립 리뷰 → ChatGPT로 피드백 export. 사용자 편의용 기본 프리셋이며 필수 워크플로가 아님.

## 7. 동작 저하와 실패 표시
- 제공자 0개: 기획/기존 Git 상태 조회 가능, AI 실행 버튼 비활성화. 이유/연결 방법만 표시.
- 제공자 1개: 전체 개발/검증 가능. 독립 교차 AI 리뷰 없음; 사람/새 세션 검토를 구분.
- 제공자 2개 이상: 실제로 준비 상태(`ready`)인 제공자만 모델 선택·업무 분업·교차 리뷰.
- 사용량/한도 API 없음: `unsupported` 또는 `unknown`; 비로그인 `auth_required`; **0% 또는 무제한으로 둔갑 금지**.
- 제공자가 기획/읽기 전용 모드를 안전하게 지원하지 못하면 해당 옵션 숨김, 내장 수동 기획과 외부 자료 import로 대체.
- 성능 비교에는 실제 확인된 실행 시간/검증 결과/사용량만 사용하고 공급자마다 다른 사용률을 단일 %로 합산하지 않음.

## 8. UI 정보 구조
- **Ideas & Planning:** `내부에서 기획 | AI에게 기획 | 외부 문서 가져오기`, 현재 초안·버전·승인·피드백.
- **Providers:** 연결 감지, 공식 로그인 안내, 모델 목록, 역할(Planning/Coding/Review), capability/상태/버전/비용 방식.
- **Command:** Ready provider 한 개를 기본 선택, 프롬프트 입력, 실시간 이벤트. 공급자 전환 시 인계 패키지 미리보기·승인.
- **Usage:** 연결된 공급자 카드만 표시, 갱신 시각/소스/알 수 없음 상태.
- **Extensions:** 제공자별 스킬·MCP·플러그인 설정을 **분리**해 관리하며 지원되는 범위만 노출.

## 9. 수용 기준 및 테스트 케이스
- T-01: `OPENAI_API_KEY`/ChatGPT 세션이 전혀 없는 Claude-only 환경에서 내장 기획→작업→테스트→사람 승인 E2E 가능.
- T-02: Codex-only 사용자는 외부 ChatGPT 웹 기획 없이 PRD import/수동 편집→작업 실행 가능.
- T-03: 외부 AI 웹/일반 Markdown을 동일 importer에 넣고 버전/결정/피드백 이력이 보존됨.
- T-04: 공급자 감지 결과 `not_installed` / `auth_required` / `unsupported` / `unknown quota`를 0 또는 정상 동작으로 잘못 표시하지 않음.
- T-05: 새 모델/제공자 등록은 코어 DB 스키마 변경 없이 adapter registry 등록만으로 가능(기본 계약 범위).
- T-06: 같은 모델 새 세션 리뷰를 '독립 교차 모델 리뷰'라고 표시하지 않음.
- T-07: 제공자 간 작업 인계는 기획 SHA/기준 commit SHA/diff/검증 요약/미해결 문제로 재현 가능.
- T-08: 제공자별 인증 토큰·환경변수 값·사용자 대화 쿠키를 관제센터에서 수집·노출하지 않음.

## 10. 단계와 설계 결정
- **V1 필수:** 중립 기획 스키마, 수동 editor/import/export, 제공자 감지, Claude·Codex 어댑터를 각각 선택적으로 지원, 한 제공자만으로 end-to-end, 명확한 리뷰 fallback.
- **V2 후보:** Gemini CLI, OpenCode, 로컬 모델, 공급자별 플러그인/MCP 연결 확대, 사용자 기획 프로필 저장.
- **V3 후보:** 비용·성능 기반 추천, 다중 AI 병렬 분업, 선택한 기획 웹과 권한 제한형 직접 브리지.

## 11. 공식 출처
- Claude Code 인증: https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code
- Claude Code CLI/headless: https://code.claude.com/docs/en/headless
- Codex 로그인(ChatGPT 또는 API 키): https://learn.chatgpt.com/docs/auth
- Codex App Server 이벤트: https://learn.chatgpt.com/docs/app-server
- Gemini CLI 인증: https://geminicli.com/docs/get-started/authentication/
- Gemini CLI headless/JSONL: https://geminicli.com/docs/cli/headless/
- OpenCode 다중 제공자·로컬 모델 및 인증 제약: https://docs.opencode.ai/docs/providers/

**한계:** 문서는 공식 안내와 설계 추론을 구분했고, CLI 설치/계정별 API 작동을 직접 확인하지 않았다. 일부 자동화 기능은 각 제공자 adapter POC에 따라 축소될 수 있다.
