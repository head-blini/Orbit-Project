# Phase 0 disposable spike

제품 서버·UI가 아닌 검증용 코드다. Node 24.22.1의 내장 TypeScript stripping과 `node:test`만 사용하며 패키지를 설치하지 않는다. TypeScript 컴파일러에 의한 타입 검사는 별도로 수행하지 않았다.

오프라인 테스트:

```powershell
node --test spikes/phase0/*.test.mjs
```

프로토콜 스키마 재생성(인증 파일을 읽는 명령이 아님):

```powershell
codex.cmd app-server generate-json-schema --out .phase0-schema
```

실제 스모크는 **기존 구독 사용량을 소비**하며, 재실행 때마다 새 프롬프트 한 번을 전송한다. 이번 조사에서는 단 한 번만 실행했다. 다음 명령은 이미 검증된 설치 경로를 명시한 재현 예시다. 다른 컴퓨터에서는 실제 설치 경로를 먼저 확인해야 한다.

```powershell
node spikes/phase0/live.mjs --one-prompt --codex-entry C:/Users/lclk1/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js
```

추가 프롬프트 없이 계정 상태만 재확인:

```powershell
node spikes/phase0/account.mjs C:/Users/lclk1/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js
```

- `rpc.mjs`: Node child_process의 stdio JSONL RPC, 상관 ID, 제한 시간, 기본 거절. 임의 명령 입력이나 웹 리스너 없음.
- `contracts.ts`: 제공자/기획 타입, 상태·검증 분리, canonical path 검사, 메타데이터만 남기는 로그 allowlist.
- `*.test.mjs`: 합성 이벤트와 로컬 자식 프로세스 fixture. 실서비스 성공을 뜻하지 않는다.
- `evidence.json`, `account-evidence.json`: 실제 실행의 제한된 메타데이터. 원문 stdout/stderr·계정 응답·이메일·인증정보를 저장하지 않는다.
- `.phase0-schema/`: 설치된 CLI에서 생성한 전체 프로토콜 캐시. Git 제외, 제품 코드 아님.

실제 프롬프트는 `read-only`, `on-request`, `approvalsReviewer=user`로 실행한다. 첫 델타에서 interrupt를 요청하며, 델타가 늦으면 12초 후 중단을 시도한다. 실제 승인을 유발하기 위한 파일 쓰기·권한 확대는 하지 않는다. 중단 후 서버를 정상 종료하고 새 프로세스에서 thread를 로드한다. 새 turn을 보내지 않으므로 대화 이어쓰기·생성 재개까지 검증하지 않는다.

임시 저장소와 경로 테스트 디렉터리는 OS 임시 경로에 남겨 두며 자동 삭제하지 않는다. 저장된 Codex thread도 지우지 않는다. 임시 저장소에는 테스트 커밋이나 코드 생성을 요청하지 않았다.

`safeLog`는 임의 원문을 안전하게 보관하는 범용 마스킹 도구가 아니다. 원문을 버리는 allowlist이며, 실제 evidence도 별도의 고정 필드만 선택한다. 클라이언트 메모리의 원본 이벤트를 제품 로그나 브라우저로 그대로 전달하면 안 된다. 사용자 Codex 설정은 변경하지 않았으므로 기존 MCP의 시작 알림이 발생할 수 있다. 제품에서는 승인된 확장 목록을 적용해야 한다.

전체 결과와 한계: [PHASE0-RESULTS.md](../../docs/PHASE0-RESULTS.md).
