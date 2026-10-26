import type { AgentCapabilities,Capability,CapabilityId,CapabilityRegistry,NativeProbeReport } from '../shared/capabilities.ts';
import type { ProviderStatus } from '../shared/types.ts';

const appServer='https://learn.chatgpt.com/docs/app-server';
const claude='https://code.claude.com/docs/en/';
type Definition=Pick<Capability,'id'|'label'|'documented'|'interfaces'|'sources'|'note'>;
const define=(id:CapabilityId,label:string,documented:Definition['documented'],interfaces:string[],sources:string[],note:string):Definition=>({id,label,documented,interfaces,sources,note});
const codexDefinitions:Definition[]=[
  define('session','세션 실행','supported',['stdio JSON-RPC; thread/start; turn/start'],[appServer],'기존 Controller의 승인·sandbox·MCP 격리 확인 후 연결합니다.'),
  define('streaming','응답 스트리밍','supported',['item/agentMessage/delta; turn/completed'],[appServer],'정제된 누적 텍스트만 저장하며 실행 완료를 검증 성공으로 취급하지 않습니다.'),
  define('resume','세션 복구','supported',['thread/resume'],[appServer],'프로젝트·worktree에 저장된 thread ID만 복구합니다. 프롬프트 자동 재전송은 없습니다.'),
  define('interrupt','실행 중단','supported',['turn/interrupt'],[appServer],'중단 요청과 실제 중단 상태를 구분합니다.'),
  define('planning','계획 제안','supported',['thread/start; turn/start outputSchema; agentMessage final_answer'],[appServer],'별도 읽기 전용 세션에 미리 본 요청을 1 turn 전송합니다. 검증된 제안은 별도 초안 저장 후 기존 승인 절차를 따릅니다. 실서비스 호출은 미검증이며 native 파일 읽기·컨텍스트·보존·전송은 Orbit 게이트웨이 통제 밖입니다.'),
  define('review','코드 리뷰','supported',['thread/start; review/start (inline custom); exitedReviewMode'],[appServer],'별도 읽기 전용 세션에서 승인한 정제 Diff를 1 turn으로 검토합니다. 매 실행 인증·sandbox·MCP 격리를 다시 확인하며 실서비스 리뷰는 미검증입니다. 완료는 실제 검증·사용자 승인이 아닙니다.'),
  define('verification','검증 증거','conditional',['agent tools; local command runner'],['https://learn.chatgpt.com/docs/agent-configuration/subagents'],'native 도구 검증은 미연결입니다. 별도 Orbit 서버 검증기는 등록한 로컬 명령의 exit·source 증거를 저장합니다. 모델 완료 판단과 구분합니다.'),
  define('skills','Skills','supported',['skills/list; skills/config/write; SKILL.md'],[appServer,'https://learn.chatgpt.com/docs/build-skills'],'연결한 세션에서 명시적으로 정제된 목록을 조회합니다. 실제 목록 API는 미검증이며 버전은 unknown입니다. 설정 변경·설치·프로필 적용은 미연결입니다.'),
  define('mcp','MCP','conditional',['mcpServerStatus/list; mcpServer/resource/read; mcpServer/tool/call'],[appServer],'현재 격리된 스레드의 disabled 목록만 명시 조회합니다. 격리 재검사 실패 시 연결을 차단합니다. MCP 호출·설치·OAuth·설정 변경은 비활성이며 실제 목록 API는 미검증입니다.'),
  define('hooks','Hooks','conditional',['hooks/list; lifecycle hooks'],['https://learn.chatgpt.com/docs/hooks'],'현재 --disable hooks. 명시 목록 조회는 설정 메타데이터만 보여 주며 실제 API는 미검증입니다. enabled·native trust는 Orbit 실행 승인이나 sandbox를 대체하지 않습니다.'),
  define('plugins','Plugins','conditional',['plugin/list; plugin/read; plugin/install'],[appServer,'https://developers.openai.com/plugins/concepts/plugins'],'현재 --disable plugins. 해당 App Server API는 공식 문서상 개발 중이며 production client 호출을 권하지 않습니다. 검토·격리 실험 전 설치하지 않습니다.'),
  define('subagents','서브에이전트','supported',['native multi_agent tools'],['https://learn.chatgpt.com/docs/agent-configuration/subagents'],'현재 --disable multi_agent. 내장 분배를 우선 재사용하되 별도 worktree·권한·예산 검증을 먼저 연결해야 합니다.'),
  define('goal','Goal','supported',['thread/goal/set; thread/goal/get; thread/goal/clear'],[appServer,'https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex'],'현재 --disable goals. 공식 지속 목표·tokenBudget 재사용에는 승인·자동 후속 turn·예산·중단·복구의 연결과 검증이 먼저 필요합니다.'),
  define('usage','사용량·상한','conditional',['account/rateLimits/read; account/usage/read'],[appServer],'Usage 화면에서 명시적으로 공식 계정 사용량을 조회합니다. 계정 전체 quota·토큰과 API 비용은 별개이며 누락된 값은 unknown입니다.'),
];
const claudeDefinitions:Definition[]=[
  define('session','세션 실행','supported',['claude -p; JSON/stream-json; Agent SDK query'],[claude+'headless',claude+'cli-reference'],'선택형 어댑터 미연결. 설치·로그인·배포 인증 허용을 가정하지 않습니다.'),
  define('streaming','응답 스트리밍','supported',['--include-partial-messages; stream_event'],[claude+'agent-sdk/streaming-output'],'원시 도구 입력·delta는 저장 전 정제해야 합니다.'),
  define('resume','세션 복구','supported',['--resume; --fork-session; SDK resume/forkSession'],[claude+'agent-sdk/sessions'],'project/worktree/session ID를 함께 확인해야 합니다.'),
  define('interrupt','실행 중단','conditional',['SDK interrupt; CLI process lifecycle'],[claude+'agent-sdk/overview'],'Orbit 어댑터의 중단·종료·재시작 회귀 검증이 필요합니다.'),
  define('planning','계획 인터페이스','supported',['--permission-mode plan'],[claude+'permissions'],'권한 mode는 별도 통제이며 계획 승인이 코드 쓰기 승인은 아닙니다.'),
  define('review','코드 리뷰','conditional',['separate session/subagent with tool restrictions'],[claude+'agent-sdk/subagents'],'리뷰는 native 세션을 이용한 Orbit 구성안입니다. 범용 review RPC가 확인됐다는 뜻은 아닙니다.'),
  define('verification','검증 workflow','conditional',['/run; /verify'],[claude+'skills#run-and-verify-your-app'],'bundled workflow 결과와 Orbit 실제 명령·SHA·E2E·사용자 승인을 분리합니다.'),
  define('skills','Skills','supported',['SKILL.md; settingSources; skills'],[claude+'skills',claude+'agent-sdk/claude-code-features'],'기본 설정 탐색 범위를 설치 버전에서 확인해야 합니다. Skills는 OS 격리 경계가 아닙니다.'),
  define('mcp','MCP','conditional',['stdio/HTTP; mcpServers; --strict-mcp-config'],[claude+'mcp',claude+'sub-agents'],'명시적 서버·인증·권한 범위가 필요합니다. inline 서버까지 strict flag가 차단한다고 가정하지 않습니다.'),
  define('hooks','Hooks','conditional',['PreToolUse; Stop; TaskCompleted; SDK callbacks'],[claude+'hooks',claude+'agent-sdk/user-input'],'자동 승인 도구가 canUseTool을 건너뛸 수 있습니다. defer 결과는 success여도 승인 대기일 수 있습니다. fail-closed 동작을 별도 검증해야 합니다.'),
  define('plugins','Plugins','conditional',['plugin marketplace; plugin install'],[claude+'plugins'],'서드파티는 출처·권한 검토와 격리 실험 전 도입하지 않습니다.'),
  define('subagents','서브에이전트','supported',['Agent tool; SDK agents'],[claude+'agent-sdk/subagents',claude+'sub-agents'],'공식 내장 작업 분배를 재사용합니다. 깊이·동시성·기본 도구는 설치 버전에서 확인해야 합니다.'),
  define('teams','Agent Teams','conditional',['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1'],[claude+'agent-teams'],'실험적 CLI 기능. SDK와 동일 기능으로 간주하지 않으며 복구·Windows 제약이 있습니다.'),
  define('goal','Goal','conditional',['/goal; claude -p "/goal …"'],[claude+'goal'],'session Stop hook과 별도 평가자가 사용됩니다. 추가 토큰 비용·resume 한도 재설정·권한 유지에 주의하며 native 판정은 실제 검증과 별개입니다.'),
  define('usage','사용량·상한','conditional',['result usage; modelUsage; total_cost_usd'],[claude+'agent-sdk/cost-tracking'],'total_cost_usd는 추정치이며 resume 이력 합산은 중복될 수 있습니다. subagent 포함 범위와 실제 청구를 분리합니다.'),
];

/** A read-only description, never authorization to launch, install, or change policy. */
export function buildCapabilityRegistry(status:ProviderStatus,probe:NativeProbeReport|null):CapabilityRegistry {
  const connected=new Set<CapabilityId>(['session','streaming','resume','interrupt','usage','review','skills','planning']);
  const blocked=new Set<CapabilityId>(['mcp','hooks','plugins','subagents','goal']);
  const capabilities=(definitions:Definition[],native:boolean):Capability[]=>definitions.map(definition=>({
    ...structuredClone(definition),
    runtime:native&&definition.id==='session'&&status==='ready'?'confirmed':'unknown',
    effective:native?(blocked.has(definition.id)?'blocked_policy':connected.has(definition.id)?status==='ready'?'available':'connection_required':'not_connected'):'not_connected',
    verification:native&&(connected.has(definition.id)||definition.id==='mcp'||definition.id==='hooks')?'contract_tests':'not_tested',
  }));
  const unknownProbe=()=>({status:'unknown' as const,version:null});
  const billing=(note:string)=>({source:'unknown' as const,remaining:null,resetAt:null,costUsd:null,note});
  const providers:AgentCapabilities[]=[
    {id:'codex',name:'Codex',nativeProbe:structuredClone(probe?.codex??unknownProbe()),connection:status,
      authStatus:status==='ready'?'connected':status==='auth_required'?'required':'unknown',
      authPolicy:'현재 Orbit는 공식 CLI의 기존 ChatGPT 로그인을 확인합니다. 인증정보를 읽거나 브라우저로 전달하지 않습니다.',
      billing:billing('연결 성공으로 구독 잔여량·초기화·API 비용을 추정하지 않습니다. native CLI 반출은 Orbit HTTP gateway 통제 범위 밖입니다.'),
      capabilities:capabilities(codexDefinitions,true)},
    {id:'claude',name:'Claude Code',nativeProbe:structuredClone(probe?.claude??unknownProbe()),connection:'not_connected',authStatus:'unknown',
      authPolicy:'개인 로컬 CLI 구독 이용과 제3자 배포 제품의 로그인·구독 제공 허용은 구분합니다. API 키 우선순위·요금 경로 확인과 배포 형태별 약관 확인 전 자동 연결하지 않습니다.',
      billing:billing('구독 OAuth·API key·cloud provider를 별도 프로필로 구분해야 합니다. 현재 인증·요금·quota 모두 unknown입니다.'),
      capabilities:capabilities(claudeDefinitions,false)},
  ];
  return {schemaVersion:1,documentedAt:'2026-10-25',generatedAt:new Date().toISOString(),probedAt:probe?.checkedAt??null,providers,
    boundaries:['공식 문서 지원 ≠ 설치 버전의 지원 ≠ 현재 Orbit 허용 ≠ 실서비스 검증.',
      '버전 진단은 PATH의 native CLI에 --version만 실행합니다. 인증·모델 요청·확장 설치는 수행하지 않습니다.',
      '서드파티 확장은 출처·버전·권한 검토와 disposable worktree 격리 실험 전 설치·활성화하지 않습니다.',
      '실행 완료와 코드 검증·사용자 승인은 별도 상태입니다. 알 수 없는 비용·한도는 unknown으로 유지합니다.']};
}
