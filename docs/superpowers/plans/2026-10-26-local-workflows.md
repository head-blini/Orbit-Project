# Local workflow implementation plan

**Goal:** Automation에서 프로젝트별 유한 워크플로를 저장·버전 관리하고 고정 명령·의존성·대상 source를 검토한 뒤 명시 실행한다. 실제 Runner 결과·중단·재시작 복구·명시 재시도를 보존한다.
**Architecture:** 기존 `runVerification`/Runner와 Projects fingerprint·서버 `ORBIT_VERIFICATION_COMMANDS`를 재사용한다. AI 작업 분배 엔진이나 새 패키지는 추가하지 않는다. root가 shared/SQLite/Controller/HTTP, 독립 담당자가 DAG 검증과 UI를 소유한다.
**Spec:** goal-objective F/K, 기존 verification 계약. 선행 gate358/358·Windows29/29 완료.

- 명령은 서버에 등록한 id만 선택한다. 브라우저에서 실행파일·인자·cwd·환경·외부 endpoint를 받지 않는다. 최대12단계·DAG·결정적 순차 실행·총 timeout10분, 첫 실패에서 나머지 중단. native AI/외부 서비스·예약 scheduler는 이 범위에서 미연결로 명시한다.
- 정의는 immutable version과 optimistic revision/idempotency로 보존한다. 실행 preview는 현재 head version·command config·source/base·workspace에 결합하고 전체명령을 보여준다. POST의 별도 동의와 동일 digest를 확인한다.
- runVerification을 단계마다 재사용하며 실행 전후 같은 source를 확인한다. 명령은 OS 권한으로 실행되며 ignored 의존성·외부부작용·중간 변경 후 원복은 검증 범위 밖이다. 명령이 성공해도 코드 리뷰 승인이나 병합은 수행하지 않는다.
- SQLite intent를 실행 전에 저장, run/step 상태와 정제된 bounded output만 기록한다. events는 ID/status만. 전체 저장량/건수 한도, 요청 재전송은 중복 실행0.
- 정상 중단은 자신이 띄운 process tree만 종료한다. 재시작 running→lost, workspace 쓰기 quarantine. 이전 프로세스 종료를 사용자가 확인한 뒤 해제하며 자동 재실행하지 않는다.
- 재시도는 실패/중단된 run에 대한 별도 동의이며 같은 version/config/source를 다시 검사한다. 같은 retry chain 최대3회, unknown/lost 미확인 결과에는 재시도 금지. 사용자 수정 후에는 새 실행으로 검토한다.

## Tasks

- [x] root: shared 계약, WorkflowService 버전/preview/실행/복구·Controller 상호 배제. 실제 Node unit6/HTTP1 exit0, retry fork/lost 결과 경계 회귀 포함. workflow 결과를 기존 리뷰 승인으로 자동 변환하지 않는다.
- [x] definition 담당: bounded exact definition·DAG·결정적 순서·민감 문자열 검증, RED10fail→GREEN10pass exit0.
- [x] UI 담당: 명령 선택·의존성·저장 버전·preview/동의·단계 결과·중단·재시도/복구. UI focused6/6·관련 UI 합계12/12·type exit0. 실제 브라우저는 다음 gate에서 검증한다.
- [x] 독립 리뷰 후 첫 동결 gate: type/build0·전체382/382·Windows32/32·40PNG. 실제 DAG·exit7/종속 skip·명시 retry attempt2·actual-start 후 중단·refresh/restart/no replay·원본/HEAD/index/digest 보존. `orbit-e2e-VT6CNR` result/cleanup과 PNG38/40 root 직접 확인. 서버7개 exit0 관측·브라우저/포트 종료, 독립 PID 확인의 1개 Windows 프로세스 재사용 한계는 RESULTS에 기록. 실제 AI/계정/외부서비스0. 전체 Goal은 미완료.
