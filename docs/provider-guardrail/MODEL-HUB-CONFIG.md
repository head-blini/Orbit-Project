# Model Hub: 서버 설정과 요청 승인 계약

작성·검증일: 2026-10-26. 구현은 `server/providers/model-hub-configuration.ts`, 집중 테스트는 `tests/model-hub-configuration.test.ts`다. 이 모듈은 설정 파싱과 메모리 내 반출 승인만 수행한다. 실제 연결·진단·요청 이력·HTTP·SQLite·UI는 통합 소유자가 연결한다.

## 내보내는 계약

```ts
readModelHubConfiguration(raw: string | undefined): readonly ModelHubConfiguration[]
authorizeConfiguredRequest(
  config: ModelHubConfiguration,
  request: ConfiguredModelHubRequest
): ConfiguredModelHubDecision
```

HTTP 설정 입력 각 항목은 다음 **12개 필드를 모두 정확히** 가져야 한다. Bedrock은 아래 별도 계약을 따른다. 알 수 없는 필드·누락·타입 강제 변환은 허용하지 않는다.

```json
[
  {
    "id": "local-fixture",
    "label": "Local fixture",
    "providerId": "local",
    "endpoint": "http://127.0.0.1:8000/v1",
    "locality": "loopback",
    "enabled": false,
    "projectPaths": ["C:\\Projects\\Fixture"],
    "models": ["fixture-model"],
    "requireCredential": false,
    "credentialEnv": null,
    "timeoutMs": 30000,
    "maxOutputTokens": 1024
  }
]
```

이는 형식 예시이며 서버를 시작하거나 무료·오프라인 서비스를 보장하지 않는다. `locality:loopback`도 해당 서버가 외부 추론을 중계하지 않는다는 증거는 아니다.

- HTTP providerId는 `openai-compatible`, `litellm`, `vllm`, `freellmapi`, `local`을 허용한다. `bedrock`은 HTTP 필드와 혼용할 수 없는 별도 계약이다. 다른 native/future 제공자 설정은 `MODEL_HUB_PROVIDER_UNSUPPORTED`로 거절한다.
- undefined·빈 문자열·공백 문자열은 frozen 빈 배열이다. JSON 전체는 UTF-8 256 KiB 이하, 최대 16개 설정이며 id는 고유해야 한다. 잘못된 한 항목 때문에 전체 설정이 실패하며 부분 설정으로 조용히 진행하지 않는다.
- id는 1–64자의 제한된 영숫자/underscore/hyphen, label은 1–120자다. 제어문자·앞뒤 공백·알려진 인증정보 패턴은 거절한다.
- models는 1–100개의 고유한 제한된 문자열이며 대소문자를 보존한다. public id/label/models/projectPaths/endpoint의 credential 패턴은 거절한다.
- projectPaths는 최대 32개다. 빈 목록은 모든 프로젝트를 거절한다. Windows drive 절대경로 또는 POSIX 절대경로의 lexical canonical 표현만 허용한다. 상대경로·dot segment·중복 구분자·trailing separator·Windows UNC/device/ADS·예약 이름 등을 거절한다. 파일시스템·realpath·링크·저장소 존재 여부는 조회하지 않는다.
- timeoutMs는 명시적 정수 1,000–60,000, maxOutputTokens는 명시적 정수 1–8,192다. 없거나 unknown인 값을 무한/기본 승인으로 바꾸지 않는다. maxOutputTokens는 실제 native transport에도 전달된다.
- credentialEnv는 null 또는 `ORBIT_MODEL_KEY_[A-Z0-9_]{1,50}` 형식의 **참조 이름**이다. requireCredential이 true이면 참조가 필요하다. 이 모듈은 환경변수 값·키의 존재/유효성·인증 파일·계정을 읽지 않는다. 참조가 있어도 실제 인증 성공을 뜻하지 않는다.

endpoint 문법·locality 검증은 기존 `createHttpProviderTransport`의 **inert constructor**를 재사용한다. 이때 approved=false, deny callback, undefined credential getter를 공급하고 메서드를 호출하지 않는다. 따라서 URL 정책을 중복 구현하거나 완화하지 않으며 DNS·HTTP·HTTPS·인증 콜백을 실행하지 않는다. 자격증명 URL·query·fragment·escapes·alternate IP spelling·dot segment는 거절한다. loopback은 literal 127.0.0.1/::1, external은 기존 HTTPS DNS-host 정책이다. 실제 DNS/public address/TLS/redirect 검사는 명시적 전송 때 native transport가 다시 수행한다.

## 불변 설정과 digest

성공한 설정은 detached deep-frozen 객체/배열이다. 고정 필드 순서의 canonical JSON에 모든 12개 필드를 포함해 SHA-256 `configDigest`를 추가한다. 원문 object key 순서가 달라도 digest는 같다. 모델/프로젝트 배열 순서는 보존하고 digest에 반영한다. 모델 기본 선택과 UI 순서 같은 서버 동작을 승인 없이 바꾸지 않기 위해 순서를 무시하지 않는다.

## Bedrock 서버 설정

다음은 비활성 형식 예시이며 설치나 계정 활성화를 수행하지 않는다. `ORBIT_MODEL_HUB` 배열에 HTTP 항목과 함께 둘 수 있다.

```json
{
  "id": "bedrock-text",
  "label": "Bedrock text",
  "providerId": "bedrock",
  "enabled": false,
  "projectPaths": ["C:\\Projects\\Fixture"],
  "models": ["amazon.nova-micro-v1:0"],
  "cliPath": "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe",
  "region": "us-east-1",
  "credentialEnvs": {
    "accessKeyId": "ORBIT_BEDROCK_ACCESS_KEY",
    "secretAccessKey": "ORBIT_BEDROCK_SECRET_KEY",
    "sessionToken": null
  },
  "timeoutMs": 30000,
  "maxOutputTokens": 1024
}
```

위 11개 필드를 정확히 요구한다. `endpoint`, `locality`, `credentialEnv`, `requireCredential`, `profile`, 추가 CLI 인자는 받지 않는다. 공개 endpoint는 리전에서 파생하고 locality는 external이다. 지원 범위는 표준 AWS partition의 직접 foundation model TEXT/ON_DEMAND 목록이며, 실제 catalog와 서버 allowlist의 교집합만 전송할 수 있다. ARN·inference profile·교차 리전 라우팅을 허용하지 않는다. 예시 model ID의 계정/리전별 실제 접근 가능성은 보장하지 않는다.

`cliPath`는 운영자가 신뢰하는 기존 AWS CLI 2 native 실행 파일의 canonical 절대경로다. 등록 프로젝트/workspace 내부 바이너리는 실행하지 않는다. 파싱·GET은 파일과 환경변수를 읽지 않고, 승인된 진단에서 실제 경로와 버전을 확인한다. 버전 문자열은 공급망 서명 검증을 대신하지 않는다. Windows는 aws.exe, POSIX는 aws 파일 이름을 사용하며 다른 OS에서의 실제 CLI 실행은 별도 검증 대상이다.

`credentialEnvs`는 서로 다른 `ORBIT_BEDROCK_[A-Z0-9_]{1,50}` 참조 이름만 받는다. sessionToken은 null 또는 같은 형식의 참조다. 값을 설정 파일·UI에 넣지 않는다. runtime 부재·승인 거절 시 값에 접근하지 않으며 승인된 호출 경계에서만 child 환경에 전달한다. 사용자 AWS profile, SSO, credential_process, metadata 서비스, container/web identity 인증 체인 및 proxy를 재사용하지 않는다. 키 발급이나 인증 방식 우회는 하지 않는다. CLI의 표준 TLS 검증을 유지하고 endpoint override를 공급하지 않는다.

[AWS CLI Converse](https://docs.aws.amazon.com/cli/latest/reference/bedrock-runtime/converse.html)의 `bedrock:InvokeModel` 권한과 [ListFoundationModels](https://docs.aws.amazon.com/cli/latest/reference/bedrock/list-foundation-models.html) 접근이 필요하다. CLI의 [Bedrock streaming 미지원](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)에 따라 최종 텍스트를 한 번 전달한다. usage는 공급자가 반환한 유효한 수만 기록하고 누락값·비용은 unknown이다. 재시도 횟수는 최초 요청 1회로 제한한다.

`--cli-input-json file://...`용 임시 파일에는 승인된 본문이 존재한다. 입력을 명령행·DB·이벤트에 넣지 않으며 credentials는 임시 파일에도 쓰지 않는다. 정상 종료 후 정리하지만 강제 종료 시 남을 수 있다. SQLite의 temporaryInput 상태가 possible/present/cleanup_required이면 요청 기록에서 이전 프로세스 종료 확인 후 정리해야 새 Bedrock 전송이 가능하다. 정리 API는 기록에 결합된 서버 UUID 경로만 사용하고 path 입력·임의 PID kill·모델 재실행을 받지 않는다. 상태 lost와 원격 처리/과금 불확실성은 정리 뒤에도 유지한다.

첫 승인 전송의 transaction에 임시 base 경로를 metadata로 보존한다. 재시작 시 TEMP가 바뀌어도 기존 base를 재사용하며, metadata가 없거나 소유 marker가 누락·손상되면 삭제 성공으로 표시하지 않는다. 예상하지 못한 파일·link·변경된 소유 정보가 있는 디렉터리는 보존한다. 이 경우 운영자가 원래 OS 위치를 직접 점검해야 하며 앱이 임의 경로 삭제나 보안 설정 변경으로 우회하지 않는다. Windows 임시 디렉터리 접근 권한은 OS의 사용자 프로필/ACL 경계를 따르며 별도 ACL 강화나 강제 종료 뒤 안전한 디스크 소거를 보장하지 않는다.

Bedrock digest에는 모든 설정과 파생 endpoint/외부 분류/필수 인증 메타데이터를 포함한다. 기존 HTTP canonical 필드 순서와 digest는 보존한다. 이번 구현의 실서비스 인증·지역별 모델 응답·청구 검증은 미실행이며 최신 로컬 계약/브라우저 증거는 ORBIT-MASTER-RESULTS에 기록한다.

digest에는 credentialEnv 참조가 들어가지만 **credential 값은 읽거나 포함하지 않는다**. label·프로젝트·endpoint·enabled·모델·인증 참조·timeout·출력 상한 중 하나라도 변경하면 digest가 달라진다. digest는 사용자 승인 범위를 결합하는 값이지 비밀정보 검출이나 네트워크 격리의 증거가 아니다.

설정은 이 파서가 발급한 객체만 private WeakSet으로 attestation한다. serialize/revive/구조 복제·직접 위조한 config는 authorize에서 거절된다. 설정 원문·effective config는 서버 시작/설정 교체 때 이 파서로 다시 읽고 원본 frozen 객체를 사용한다. DB에는 진단/요청 증거만 보존하고 effective config 객체를 복원해 권한처럼 사용하지 않는다.

## 명시적 요청 승인

models 요청은 정확히 다음 네 필드만 받는다.

```ts
{projectPath, expectedConfigDigest, operation: 'models', confirmed: true}
```

chat 요청은 여기에 model과 messages 두 필드가 추가돼야 한다.

```ts
{
  projectPath, expectedConfigDigest, operation: 'chat', confirmed: true,
  model: 'fixture-model',
  messages: [{role: 'user', content: 'ordinary text'}]
}
```

먼저 trusted config·enabled·동일 설정 digest·사용자 확인·허용 프로젝트·허용 model을 확인한다. 이 gate 전에는 메시지 배열/본문을 읽거나 반출 검사하지 않는다. models는 model/messages가 있으면 거절한다. unknown operation·필드·상속 객체·accessor도 거절한다.

projectPath는 **서버가 등록 프로젝트에서 얻은 canonical 저장 경로**여야 한다. Windows 런타임은 대소문자를 무시하는 동일 경로 비교를 사용하며 다른 OS는 정확한 문자열을 비교한다. 상위/하위 경로에 권한이 확장되지 않는다. 브라우저 projectPath나 confirmed boolean만으로 HTTP 권한이 생기지 않는다. 통합 계층은 session/Origin/CSRF, 프로젝트 접근, 명시적 클릭, 현재 설정/취소 상태를 별도로 확인해야 한다.

chat messages는 1–100개이며 각 항목은 정확한 role/content만 갖는다. role은 system/user/assistant만 허용한다. 누적 최대 64,000 UTF-16 문자(항목 사이 구분 포함), serialized messages는 256 KiB−512 bytes 이하이며 초과 시 절단하지 않는다. 64k 상한은 재사용하는 privacy helper의 분석 범위와 일치시킨다.

모든 역할의 각 content와 결합된 전체 content를 검사한다. `inspectOutbound`의 credential/이메일/전화/식별번호 패턴 또는 기존 `containsCredential`의 추가 패턴이 하나라도 있으면 **block**한다. mask나 permissive fallback은 없다. 값이 다음 메시지로 나뉜 키 할당도 결합 검사로 차단한다. 이 검사는 휴리스틱이며 임의의 암호화/인코딩/분할 비밀이나 모든 개인정보를 검출한다는 보장은 아니다.

허용한 메시지는 새 plain 객체로 복제·동결한 뒤 반환한다. 요청 이후 원본 배열이나 메시지가 바뀌어도 허용 snapshot은 바뀌지 않는다. 반환 형태는 다음뿐이다.

```ts
{allowed: false, code: 'MODEL_HUB_REQUEST_DENIED'}
{allowed: true} // models
{allowed: true, messages: readonly HttpChatMessage[]} // chat
```

거절 결과에 입력·필드값·matched secret·원시 오류·stack/cause·endpoint를 덧붙이지 않는다. 허용 메시지는 검사한 모델 입력이지 안전한 감사 로그나 실행 가능한 명령이 아니다. 이 함수를 우회하는 raw send/fallback을 연결하면 안 된다.

## 운영 경계

설정 enabled는 현재 연결 성공·모델 존재·실제 인증·구독/요금·무제한 예산·코딩 기능을 증명하지 않는다. 알려지지 않은 비용·사용량은 unknown으로 유지한다. 로컬이라고 무료라고 표시하지 않는다. Codex/Claude native 실행 및 Bedrock는 별도 검증된 adapter 범위다.

credentialEnv의 실제 값은 통합 소유자가 **승인된 요청의 최종 transport 경계에서만** 메모리 callback으로 공급한다. 이 모듈은 환경변수·네트워크·파일·DB를 읽지 않고 아무 진단도 자동 실행하지 않는다. 토큰 상한은 native transport의 max_tokens 및 응답 제한과 함께 사용하되 실제 외부 청구액을 하드 캡했다는 주장으로 확대하지 않는다. 다른 제공자나 API 과금 경로로 자동 전환하지 않는다.

## 검증

Windows / Node 24.19.0의 합성 메모리 fixture만 사용했다. 초기 stub 실행은 8 fail / 2 pass, exit 1이었다. 구현 후 10/10, 추가 snapshot/분할/용량/경계 검증을 포함한 최종 결과는 **13/13, fail/skip 0, exit 0**이다.

```powershell
node --test tests/model-hub-configuration.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --allowImportingTsExtensions server/providers/model-hub-configuration.ts tests/model-hub-configuration.test.ts
```

targeted 타입 검사도 exit 0이다. 테스트는 HTTP/HTTPS/DNS 함수가 throw하는 상태에서 정상 설정 파싱이 성공하는지, deep freeze/digest, provider/endpoint/참조/프로젝트/명령 한도, gate 전 메시지 비접근, 세 역할의 반출 차단, accessor·위조 config·원문 비노출, 100개/64k 메시지 경계를 확인한다. 실제 환경변수 값·인증정보·계정·서비스·사용자 DB에 접근하지 않았고 설치·커밋하지 않았다. 전체 제품 테스트/빌드/브라우저는 통합 소유자의 별도 검증이다.
