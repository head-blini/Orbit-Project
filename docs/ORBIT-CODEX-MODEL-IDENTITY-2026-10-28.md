# Codex 0.162.1 모델 식별 계약 조사

- 조사일: 2026-10-28
- 범위: 설치된 `codex-cli 0.162.1`이 오프라인 생성한 App Server JSON Schema / TypeScript 계약
- 공식 인터페이스 안내: <https://learn.chatgpt.com/docs/app-server>
- 실제 App Server 실행·모델 호출·인증정보 조회 없음. 모의 계약 검사를 실환경 성공으로 해석하지 않는다.

## 결론

선택 모델, 요청 모델, 서버가 확인한 **설정 모델**은 구분하여 기록할 수 있다. 그러나 이 버전의 공식 계약에는 완료된 turn 전체에 귀속되는 실제 추론 모델을 입증하는 필드가 없다. Codex 실제 모델은 `unknown`으로 유지하고, 이를 이용한 독립 모델 교차 검증 성공을 선언하지 않는다. 서버 설정 응답과 카탈로그 정보가 모두 일치해도 이 결론은 달라지지 않는다.

`Thread.model`의 생성 스키마 설명은 다음과 같다.

> Current configured model when loaded, otherwise the latest persisted model. Null when unavailable. This is not per-turn execution telemetry.

이 명시적 제약은 요청/설정 모델을 실제 모델로 승격하지 않아야 하는 직접 근거다. 안정/experimental TypeScript의 `Turn` 정의 모두 모델 필드가 없으며 두 파일은 동일했다. 이 제약은 코딩·비코딩 프로젝트에 동일하게 적용된다. 제품의 범용 자동화 비전이나 기존 승인·격리·사용량 정책을 축소하거나 완화하지 않는다.

## 인터페이스별 지원 범위

| 인터페이스 | 보존 가능한 식별 정보 | 실제 모델 증거의 한계 |
| --- | --- | --- |
| 사용자 모델 선택 | 사용자가 선택한 모델 ID, 선택 시점 | 실행 요청·적용 사실이 아님 |
| `model/list` | 카탈로그 `id`, `model`, 표시명, 지원 설정 | 실행 또는 사용 권한의 증거가 아님 |
| `thread/start` 요청 | 지정한 모델·공급자 설정 | 요청값일 뿐 실행 증거가 아님 |
| `thread/start` 응답 | 서버 설정 `model`, `modelProvider`; thread `id`, `sessionId` | 실제 turn 모델이 아님 |
| `thread/resume` 요청/응답 | 재개 요청값과 서버 설정, thread/session 연결 | 이전 turn의 모델을 소급 확정하지 않음 |
| `turn/start` 요청 | `model` override: 현재 및 후속 turn에 대한 요청 | 서버 실행 모델 확정이 아님 |
| `turn/start` 응답, `turn/started`, `turn/completed` | turn ID, 상태, 항목 | `Turn`에 model/modelProvider 필드 없음 |
| `thread/read` | 현재/최근 저장된 설정, 요청 시 turn 이력 | `Thread.model`은 per-turn telemetry가 아니며 이력 Turn에도 모델 없음 |
| `thread/settings/updated` | 스레드 모델·공급자 설정 변경 | 완료된 turn의 모델 증명이 아님 |
| `model/rerouted` | thread/turn ID, `fromModel`, `toModel`, 사유 | 해당 turn의 라우팅 관측; 완료 전체의 모델 귀속이나 이후 변경 부재를 보증하지 않음 |
| `model/verification` | thread/turn ID, `trustedAccessForCyber` | 이름과 달리 모델 신원 검증이 아님 |
| `model/safetyBuffering/updated` | thread/turn ID, 모델, 버퍼 UI 정보, fasterModel | 안전 버퍼 UI 메타데이터이며 완료 모델 증명이 아님 |
| `rawResponse/completed` | response ID, 정확한 사용량, 임의 usage metadata | internal-only 계약이며 model 필드 없음 |
| `rawResponseItem/completed`, agentMessage 항목 | thread/turn 및 응답 항목 | 공식 실제 모델 귀속 필드 없음 |

`ResponseUsageMetadata.metadata`는 임의 JSON이다. 비공식 키나 추측으로 모델 ID를 추출해 확정 증거로 사용하지 않는다. `modelProvider`는 서버 설정의 공급자 ID이며 실제 모델 ID, 스레드 ID, 세션 ID, turn ID, Orbit Run ID와 별개다.

## 보존과 복구 계약

- 선택값·요청값·서버 설정값을 독립 필드로 두고 출처 메서드/이벤트와 관측 시점, thread/session/turn ID를 함께 기록한다.
- 모델 변경·재개 응답은 새로운 설정 관측이다. 이전 실행의 근거를 덮어쓰거나 새로운 turn의 실제 모델로 복사하지 않는다.
- 중단·이벤트 누락·응답 유실 시 unknown을 유지한다. 이벤트 부재를 모델 변경이 없었다는 증거로 사용하지 않는다.
- turn에 연결된 라우팅 관측도 전체 실행의 최종 모델 증거로 승격하지 않는다. 알려진 설정/라우팅 정보는 고급 증거 화면에서 실제 모델과 분리한다.
- 실행 완료, 실제 모델 식별, 독립 검증 통과, 사용자 승인은 별개 상태다. unknown을 모델 불일치의 긍정 증거로 취급하지 않는다.

## 현재 실행기 연결

기존 Controller와 native review에 수동 관측기를 연결했다. 새로운 App Server 호출이나 모델 선택 API는 추가하지 않았다. 현재 Controller/review 요청에는 모델 override가 없으므로 `selectedModelId`·`requestedModelId`는 `null`(미지정)이다. 서버 설정 기본값을 선택값이나 요청값으로 복사하지 않는다. 향후 실제 선택 입력을 연결할 때 이 두 필드에 각각 전달할 계약은 모의 테스트로 검증했다. Quality Loop에 기존 검증자 선택값이 있더라도 그것은 선택일 뿐 실행 관측이 아니다.

`model/list`는 별도 카탈로그 디코더 계약만 검사했고, `thread/read`도 모의 응답의 설정 해석만 검사했다. 이 단계에서 실제 서버에 이 메서드를 요청하지 않았다. Controller는 이미 수행하는 start/resume/turn 응답과 이벤트만 관측한다. native review는 기존 review 응답·이벤트를 사용한다.

SQLite `run_model_attributions`에 실행별 근거를 보존하고 인증된 `GET /api/runs/:runId/model-identity` 및 프로젝트 진행판에 연결했다. 조회는 실행을 재개하지 않는다. 실제 모델은 계속 `unknown/unavailable`이며 Quality Loop의 `modelId:null/source:unknown` 및 production Codex 교차 검증 사전 차단을 유지한다. `threadId`, 실제 `nativeSessionId`, `turnId`, Orbit Run ID는 구분한다. 종료 실행과 근거 저장 사이 장애는 재시작 때 관측 불완전으로 처리한다. 간편 모드에는 상세 근거를 노출하지 않고 고급 모드에서 설정 모델·실제 모델의 차이를 표시한다.

## 오프라인 재현 자료

`tests/fixtures/codex-0.162.1-model-schema.json`은 생성 JSON Schema의 작은 투영이다. 전체 vendor 스키마를 복사하지 않는다. 각 항목은 원본 JSON 파일명·JSON pointer·SHA-256과 대응 TypeScript 원본 SHA-256을 보존한다. 투영은 `type/title/description/enum/required`를 원문 그대로 복사하고, 전체 property 이름 목록과 모델 식별에 필요한 property schema만 복사한다. 따라서 model 필드 부재 검사는 필터 결과가 아니라 전체 property 이름 목록을 검사한다. `$ref`는 원본 그대로이며 이 자료는 독립 실행 가능한 JSON Schema가 아니다.

동일 CLI 버전으로 다음 오프라인 명령을 실행하면 원본을 다시 생성할 수 있다.

```sh
codex --version
codex app-server generate-json-schema --out /tmp/orbit-codex-01621-schema-json
codex app-server generate-ts --out /tmp/orbit-codex-01621-schema-ts
codex app-server generate-ts --experimental --out /tmp/orbit-codex-01621-experimental-ts
node --test tests/codex-model-schema.test.ts
```

원본 바이트의 SHA-256을 fixture의 source hash와 대조하고, JSON pointer의 정의에서 동일 투영을 추출해 비교할 수 있다. 저장된 hash 자체는 실제 모델 호출의 증거가 아니다. 계약 테스트는 카탈로그·요청·설정 구분, nullable Thread.model 설명, 모델 없는 Turn, cyber verification 의미, raw usage의 모델 부재를 검사한다. CLI 업그레이드 시 이 fixture를 그대로 최신 지원 계약이라고 주장해서는 안 된다.

## 남은 실환경 검증 조건

사용자 별도 승인 이후에만 실제 네이티브 호출을 진행한다. 승인 시 선택→요청→서버 설정의 상관관계, 모델 변경, 재개, 중단, 실제 이벤트 전달 및 영속화를 검증할 수 있다. 현재 단계에서는 이 실환경 검증을 수행하지 않았다.

현재 공식 계약으로는 실제 모델 독립성 성공을 입증할 수 없으므로, 사용자 호출 승인만으로 Codex 교차 검증 차단을 해제하지 않는다. 향후 공식 인터페이스가 turn/response와 연결된 신뢰 가능한 실제 모델 귀속 정보를 제공하면 해당 계약·이벤트 누락·혼합 모델·재개 동작을 먼저 검증하고 실제 모델 증거 지원 여부를 다시 판단한다. 비공식 인증 데이터 접근이나 유료 API 전환은 대안이 아니다.
