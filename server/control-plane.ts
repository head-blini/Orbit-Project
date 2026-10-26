import type {ProviderStatus} from '../shared/types.ts';
import type {ControlPlaneStatus} from '../shared/control-plane.ts';

/** Pure projection: no native discovery, account refresh or safety qualification. */
export function controlPlaneStatus(provider:ProviderStatus):ControlPlaneStatus {
  return {schemaVersion:1,levels:{tracking:'available',assisted:'qualification_pending',autonomous:'disabled'},policies:[
    {id:'http-admission',label:'로컬 API 접근',owner:'orbit',status:'enforced',scope:'loopback·세션·Origin·CSRF와 요청 필드 검사를 서버에서 강제합니다.'},
    {id:'approval',label:'승인과 요청 중복 방지',owner:'orbit',status:'enforced',scope:'기존 실행의 요청 ID 중복 검사, 네이티브 승인 기본 거절, 별도 검증·병합 승인을 유지합니다. 모든 쓰기 경로의 기획 결속은 아직 통합 전입니다.'},
    {id:'gateway-egress',label:'Model Hub 반출 검사',owner:'orbit',status:'enforced',scope:'설정된 Model Hub 요청의 목적지·모델·본문에 적용합니다. 네이티브 CLI 자체 전송은 이 경계를 통과하지 않습니다.'},
    {id:'native-isolation',label:'네이티브 파일·네트워크 격리',owner:'runtime',status:provider==='ready'?'attested':'unknown',scope:'Codex 설정과 세션 응답을 검사합니다. 실제 차단은 런타임에 의존하며 현재 OS·버전 전체의 격리 증명은 아닙니다.'},
    {id:'deadline',label:'실행 시간 제한',owner:'orbit',status:'enforced',scope:'기존 Solo는 120초 후 중단 절차를 시작합니다. 종료 시각이나 토큰·비용 상한을 보장하지 않습니다.'},
    {id:'token-cap',label:'강제 토큰·비용 상한',owner:'unverified',status:'unknown',scope:'관찰 사용량과 구독 잔여량은 강제 실행 예산이 아닙니다. 알 수 없는 값은 0으로 표시하지 않습니다.'},
    {id:'cross-manager-ownership',label:'실행 관리자 간 단일 쓰기 소유권',owner:'unverified',status:'unknown',scope:'기존 상태 디렉터리 잠금은 서로 다른 디렉터리·외부 실행 관리자까지 보장하지 않습니다.'},
    {id:'termination',label:'종료 증명과 격리 해제',owner:'unverified',status:'unknown',scope:'프로세스 close·세션 종료·자식 종료·수동 확인을 구분하는 공통 계약은 단계적으로 연결합니다. PID나 timeout만으로 안전한 재실행을 보장하지 않습니다.'},
  ],limitations:[
    'Goal Tracking은 실행 권한을 부여하지 않습니다. Assisted 실행 계약은 아직 전체 실행 경로에 연결되지 않았으며 Autonomous 실행은 비활성입니다.',
    '구독 잔여량 unknown의 제한된 수동 실행은 별도 확인과 검증된 격리·소유권·복구·중단 조건이 모두 필요합니다. 미확인 안전성을 승인으로 우회할 수 없습니다.',
    'Mac 테스트 통과는 Windows E2E 완료나 실제 네이티브 서비스 검증을 뜻하지 않습니다.',
  ]};
}
