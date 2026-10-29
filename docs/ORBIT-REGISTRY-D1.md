# REGISTRY-D1 — 사용자 모델/제공자/실행기 Registry 설계 (2026-10-29)

작성: Codex read-only 설계 run `REGISTRY-D1` (session `01a184f9-5a73-7fe3-9533-17786cda15ee`). 검토·채택: Claude Code 오케스트레이터.

**미결정 사항 처리 (보수적 기본값, 범위 축소 방향):** (1) 첫 구현은 기존 어댑터에 연결되는 항목만 실행 가능, 기타 CLI·웹은 등록·상태 관리까지. (2) 삭제는 이력 보존형 비활성화, 영구 삭제 제외. (3) env·builtin은 읽기 전용, 가져오기·전환은 후속. 사용자가 다르게 결정하면 이 문서를 갱신한다.

**확인한 현재 구현**

- `ORBIT_MODEL_HUB`는 시작 시 파싱됩니다. 설정 digest, 프로젝트 허용 목록, 명시 동의로 요청을 제한합니다.
- `ModelHubService`는 목록 진단·요청·중단·복구를 구현합니다. 비용은 `unknown`, `costUsd:null`입니다.
- `ProjectAiPreferencesService`의 타입·DB 제약은 `codex | claude-code`입니다. 프로젝트 종류별 실행 제한도 존재합니다.
- `CapabilityRuntimeAdapters`는 신뢰된 서버 코드만 등록하며, 두 런타임만 허용합니다.
- Native readiness는 설치·인증·연결을 구분합니다. GET은 진단 프로세스를 실행하지 않습니다.
- 근거: [설정·승인 코드](../server/providers/model-hub-configuration.ts), [Model Hub 서비스](../server/model-hub-service.ts), [프로젝트 선택](../server/project-ai-preferences.ts), [런타임 경계](../server/capability-runtime-adapters.ts).

**1. 최소 범위와 재사용 경계**

- Registry는 제공자 연결, 실행기, 모델을 구별하여 등록·조회·수정·비활성화합니다.
- 사용자 제공자 ID는 자유롭게 추가하되, 실행 방식은 기존 어댑터 ID와 명시적으로 연결합니다.
- 기존 HTTP 계열·Bedrock 설정은 Model Hub로 연결합니다. 원시 모델 API를 에이전트 실행기로 취급하지 않습니다.
- 기타 CLI·웹 연동도 메타데이터 등록은 허용합니다. 연결 어댑터가 없으면 `unsupported`이며 실행할 수 없습니다.
- 임의 실행파일·명령·스크립트·플러그인을 Registry 입력으로 실행하지 않습니다.
- 기존 두 런타임과 env 설정은 읽기 전용 원본으로 표시합니다. 사용자 레코드가 이를 덮어쓰지 못합니다.
- 프로젝트 기획·실행 선택은 기존 `ProjectAiPreferencesService`를 유지합니다. 신규 API 모델을 자동 편입하지 않습니다.
- 이번 단위의 완료는 Registry CRUD·검증·기존 Model Hub 연결입니다. 모든 제공자 실연동 완료를 뜻하지 않습니다.

**2. 저장 구조 — 신규 테이블 두 개**

| 테이블 | 주요 열·제약 |
|---|---|
| `registry_entries` | `id` PK, `kind(provider/runtime/model)`, `provider_id` 자기참조 FK, `revision`, `enabled`, `body`, `created_at`, `updated_at` |
| `registry_validations` | `id` PK, `request_id` UNIQUE, `entry_id` FK, `revision`, `config_digest`, `request_digest`, `state`, `body`, `created_at`, `finished_at` |

- `body`는 종류별로 엄격히 검증한 JSON입니다. 임의 확장 필드·인증 원문·원시 응답을 저장하지 않습니다.
- 제공자는 연결 방식·목적지·인증 참조·프로젝트 범위·제한을 보유합니다. 모델은 제공자와 정확한 `modelId`를 참조합니다.
- 실행기는 `adapterId`와 연결 제공자를 참조합니다. 네이티브 런타임 별칭은 기존 런타임 ID에만 연결됩니다.
- FK 존재뿐 아니라 참조 종류·순환·중복 모델을 검증합니다. 등록 ID와 제공자 모델 문자열은 구별합니다.
- 수정은 `expectedRevision` 기반 비교 후 트랜잭션 처리합니다. 변경 시 종속 설정 digest와 검증 현재성을 갱신합니다.
- 제공자 비활성화는 하위 모델의 신규 사용도 차단합니다. 하위 설정·과거 증거를 삭제하지 않습니다.
- 최소 삭제 정책은 논리 삭제인 비활성화입니다. 재활성화해도 이전 승인·검증이 자동 복원되지 않습니다.
- 변경 감사는 기존 `Store.append`를 재사용합니다. 이벤트에는 ID·revision·작업·고정 사유 코드만 남깁니다.

**3. 공통 타입과 상태**

신규 `shared/model-registry.ts`에 다음 계약을 둡니다.

- `RegistryEntry`: 종류별 discriminated union, `origin:user|env|builtin`, ID·revision·enabled·참조.
- `RegistryAuth`: 아래 표의 인증 방식과 비밀이 아닌 참조만 허용.
- `RegistryValidation`: 설정 digest, 검증 종류, 상태, 시각, 증거 참조, 고정 오류 코드.
- `RegistryCost`: `subscription|metered_api|local_resource|unknown`, 출처, 확인 시각, 통화·단위·단가 또는 `null`.
- 기능 선언은 `declaredCapabilities`로 분리합니다. 실행 가능 판정은 기존 `CapabilityEntry`·어댑터·정책·현재 증거를 사용합니다.
- 설치·인증·연결·기능 검증·실행 승인 상태를 합쳐 하나의 `ready` 값으로 저장하지 않습니다.
- 단가의 `user_declared`와 `provider_reported`를 구별합니다. 구독 잔여량·실제 청구액을 추정하지 않습니다.
- `local`·loopback이라는 이유로 무료·오프라인이라고 표시하지 않습니다. 가격 출처 URL도 자동 조회하지 않습니다.

**4. 종류별 인증**

| 연결 종류 | 허용 방식 | 경계 |
|---|---|---|
| Codex·Claude Code | `native_session` | 기존 공식 연결·readiness 재사용. 인증 파일·쿠키·토큰을 읽지 않음 |
| HTTP API·게이트웨이 | `env_ref` 또는 `none` | 기존 `ORBIT_MODEL_KEY_*` 참조 규칙 재사용 |
| Bedrock | `aws_env_refs` | 기존 `ORBIT_BEDROCK_*` 참조·AWS CLI 경로 검증 재사용 |
| 로컬 모델 서버 | `none` 또는 `env_ref` | 동일한 목적지·전송 승인 정책 적용 |
| 기타 CLI·웹 | 인증 방식 선언만 | 신뢰된 어댑터 없으면 인증 검증·실행 차단 |

- UI에는 인증 참조 이름·설정 여부만 표시합니다. 비밀 입력란·값 조회 API·임의 인증 헤더는 제공하지 않습니다.
- 실제 인증 값은 승인된 기존 transport가 필요할 때 메모리에서만 해석합니다. DB·로그·오류·UI로 반환하지 않습니다.
- 새로운 OAuth 흐름·credential helper·keychain 지원은 별도 어댑터 작업입니다. 인증 실패 시 API 방식으로 전환하지 않습니다.

**5. 검증·승인·모델 식별**

- `validate(local)`은 문법·참조·어댑터 호환성만 검사합니다. DNS·네트워크·CLI·인증 값 조회는 없습니다.
- `validate(connection)`은 명시적 동의 후 기존 Model Hub 진단 또는 native readiness를 호출합니다.
- 승인에는 프로젝트·정확한 목적지·작업·설정 digest를 결속합니다. 등록·활성화·목록 조회 승인은 생성 요청 승인이 아닙니다.
- 외부 진단 전에 목적지·전송 내용·비용 미확인 가능성을 표시합니다. 실제 생성 검증은 별도 승인된 실행 경로를 사용합니다.
- HTTP 목적지·DNS·redirect·반출 방어는 기존 transport를 재사용합니다. 승인 전 인증 값이나 네트워크에 접근하지 않습니다.
- 설정 변경·비활성화를 dispatch 직전에 재검사합니다. 시작된 실행은 기존 snapshot으로 관측·중단하며, 종료를 임의 확정하지 않습니다.
- 진단 의도를 먼저 저장합니다. 중복 요청은 같은 기록을 반환하며, 재시작 시 미완료 진단은 `unknown`으로 남깁니다.
- 검증 결과는 해당 revision·digest에만 유효합니다. 목록 조회 성공은 streaming·tools·resume 성공 증거가 아닙니다.
- 선택 모델, 요청 모델, 실제 관측 모델을 분리합니다. 설정·카탈로그·사용자 선언을 실제 모델로 복사하지 않습니다.
- 기존 Codex attribution을 그대로 사용합니다. HTTP의 기존 `ModelHubRequest.model`은 요청 모델이며, actual은 `unknown`입니다.
- 실제 모델 증거는 실행별로 보존합니다. Registry 수정이나 모델 별칭으로 과거 실행의 독립 검토 판정을 바꾸지 않습니다.

**6. HTTP와 UI**

| 신규 경로 | 동작 |
|---|---|
| `GET /api/registry` | user·env·builtin 목록과 정제된 상태. 부수효과 없음 |
| `GET /api/registry/entries/:id` | 상세·참조·검증 이력 |
| `POST /api/registry/entries` | 사용자 레코드 등록. 기본 비활성 |
| `POST /api/registry/entries/:id/update` | `expectedRevision`으로 수정 |
| `POST /api/registry/entries/:id/disable` | 멱등 비활성화. 신규 사용 차단 |
| `POST /api/registry/entries/:id/validate` | `local|connection`, revision·digest·요청 ID 검사 |

- 기존 POST 방식에 맞춥니다. 모든 변경은 기존 session·Origin·CSRF·본문 크기·필드 검사를 적용합니다.
- 잘못된 입력은 400, 권한 거부는 403, stale·충돌은 409입니다. 입력 원문을 오류에 반사하지 않습니다.
- 기존 `web/model-hub.tsx`에 Registry 관리 진입점을 추가하고, 신규 `web/model-registry.tsx`에 목록·편집·검증 상세를 둡니다.
- 간편 모드는 이름·종류·상태·등록/검증/비활성화만 표시합니다. 고급 모드는 인증 참조·목적지·기능·비용 출처·증거를 펼칩니다.
- env·builtin에는 원본 출처와 읽기 전용 이유를 표시합니다. 미지원 실행기는 선택 가능 상태로 오인시키지 않습니다.
- 비활성화 시 참조 모델·진행 중 요청을 보여줍니다. 늦은 응답이나 프로젝트 전환으로 이전 승인 상태를 복원하지 않습니다.

**7. 기존 설정 이행**

- 자동 DB 복사·env 수정은 하지 않습니다. env·builtin은 기존 객체에서 읽기 전용으로 투영합니다.
- env의 기존 ID·정렬·파싱 실패·digest·승인·catalog·요청 이력 의미를 유지합니다.
- 사용자 설정만 DB에 저장하고, 기존 `readModelHubConfiguration`으로 정규화하여 신뢰된 설정 객체를 생성합니다.
- Model Hub에는 사용자 설정 공급자를 선택적으로 추가합니다. 기본값은 빈 목록이므로 기존 생성자 사용은 그대로 동작합니다.
- 사용자 목적지 ID가 env ID와 충돌하면 병합·덮어쓰기 없이 차단합니다. 시작 시 충돌도 명시적으로 표시합니다.
- 신규 테이블은 추가형 migration으로 생성합니다. 기존 프로젝트 선택·Run·DB/WAL/SHM은 재작성하지 않습니다.
- 롤백 시 사용자 Registry 연결만 제거합니다. 기존 env 동작은 유지하고 신규 데이터는 보존합니다.

**8. 독립 작업 단위와 파일 소유권**

| 단위·소유자 | 수정 대상과 신규 파일 | 선행·완료 조건 |
|---|---|---|
| R1 계약·DB / Codex | 신규 `shared/model-registry.ts`, `server/model-registry-store.ts`, `tests/model-registry-store.test.ts` | 계약 고정, 추가형 migration·revision·참조 검증 |
| R2 서비스 / Codex | 신규 `server/model-registry-service.ts`, `tests/model-registry-service.test.ts` | R1 이후 CRUD·진단 의도·상태·비밀 비노출 |
| R3 Model Hub 연결 / Codex | 기존 `server/model-hub-service.ts`, `server/controller.ts`; 신규 `tests/model-registry-model-hub.test.ts` | R2 이후 사용자 설정 연결·dispatch 재검사·env 회귀 |
| R4 UI / Claude Code | 기존 `web/model-hub.tsx`; 신규 `web/model-registry.tsx`, `tests/model-registry-ui.test.ts` | R1 계약으로 독립 개발, R3 연결 후 브라우저 검증 |
| R5 HTTP·통합 / Codex + 통합 담당 | 기존 `server/http.ts`; 신규 `tests/model-registry-http.test.ts`; 통합 담당만 `docs/ORBIT-STATUS.md` | R2·R3·R4 이후 보안·재시작·통합 회귀 |

- 공통 타입·DB·Controller·HTTP는 Codex 단일 작성자입니다. 작업은 별도 worktree로 분리하고 통합은 직렬화합니다.
- `shared/model-hub.ts`, 설정 parser, AI preferences, capability adapters, native readiness는 기존 계약을 재사용하며 본안에서는 수정하지 않습니다.
- 코드 변경 뒤 `graphify update .`는 통합 담당만 수행합니다. 이번 읽기 전용 설계에서는 실행하지 않습니다.

**9. 구현 시 검증 조건**

- 정상: 등록→수정→로컬 검증→명시 연결 진단→비활성화→재시작 보존, 기존 env 요청·두 native runtime 회귀.
- 실패: 잘못된 인증 종류·비밀 입력·목적지·참조·중복 ID, stale revision·승인, CSRF 누락, 미지원 어댑터.
- 경합: 진단 중 수정·비활성화, 전송 직전 변경, 중복 요청, 응답 유실·재시작에서 자동 재전송 없음.
- 증거: 사용자 기능 선언이 실행 권한으로 승격되지 않음, actual unknown 유지, 비용 출처 없음은 `null`.
- 보존: 비활성화 후 기존 실행의 관측·중단 가능, 모델 변경 후 과거 실행·선택·승인 이력 불변.
- 격리 fixture와 주입한 mock으로 호출 수·비밀 비노출을 검사합니다. 기존 Model Hub·readiness·capability 테스트도 회귀 실행합니다.
- Node24에서 `npm run verify` 및 UI 검증을 수행합니다. mock 통과와 승인된 실연동 검증은 별도 기록합니다.

**승인이 필요한 미결정 사항**

1. 첫 구현은 기존 어댑터에 연결되는 항목만 실행하고, 기타 CLI·웹은 등록·상태 관리까지만 제공해도 될까요?
2. UI의 삭제를 이력 보존형 비활성화로 정의하고, 영구 삭제는 제외해도 될까요?
3. env·builtin은 읽기 전용으로 유지하고, 사용자 DB 설정으로의 가져오기·전환은 후속 작업으로 분리해도 될까요?

