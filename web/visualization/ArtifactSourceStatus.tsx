import { useEffect,useState } from 'react';
import type { ArtifactRecord } from '../../shared/parallel.ts';
const labels={manual:'소스 연계 없는 수동 Artifact',unverified:'원문이 수정됐거나 소스 연결을 확인할 수 없음',current:'조회 당시 소스와 일치하는 정적 다이어그램',stale:'소스 변경 · 이 Artifact는 과거 분석 결과',unavailable:'현재 소스 확인 불가'};
export function ArtifactSourceStatus({artifact}:{artifact:ArtifactRecord}){
  const [status,setStatus]=useState<keyof typeof labels|null>(null),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let disposed=false;setStatus(null);
    void fetch('/api/projects/'+encodeURIComponent(artifact.projectId)+'/artifacts/'+artifact.id+'/source-status?revision='+artifact.revision+'&hash='+artifact.contentHash).then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<{freshness:keyof typeof labels}>;}).then(result=>{if(!disposed)setStatus(Object.hasOwn(labels,result.freshness)?result.freshness:'unavailable');}).catch(()=>{if(!disposed)setStatus('unavailable');});
    return()=>{disposed=true;};
  },[artifact.id,artifact.revision,artifact.contentHash,artifact.projectId,refresh]);
  return <div className="artifact-source-status"><p>{status?labels[status]:'Artifact 소스 기준 확인 중…'}</p><button onClick={()=>setRefresh(value=>value+1)}>Artifact 소스 상태 확인</button></div>;
}
