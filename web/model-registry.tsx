import {useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import type {RegistryEntry,RegistryValidation} from '../shared/model-registry.ts';
import {useUiMode} from './ui-mode.ts';

/** Mirrors server RegistryView (server/model-registry-service.ts); credential values never reach the browser. */
export type RegistryRow=RegistryEntry&{configDigest:string;authReferences:{name:string;configured:boolean}[];nativeStatus:{installation:string;authentication:string;connection:string}|null};
export interface RegistryListView {entries:RegistryRow[];collisions:{id:string;origins:string[]}[]}
export interface RegistryDetail {entry:RegistryRow;validations:RegistryValidation[]}
type Post=(path:string,body:object)=>Promise<unknown>;

const kindNames={provider:'제공자',runtime:'실행기',model:'모델'} as const;
const originNames={user:'사용자 등록',env:'서버 설정 · 읽기 전용',builtin:'기본 실행기 · 읽기 전용'} as const;
const validationNames:Record<RegistryValidation['state'],string>={intent:'진단 중 · 결과 미확인',passed:'통과',failed:'실패',unsupported:'지원하지 않는 연결',unknown:'결과 미확인'};
/** Only user entries are editable; env/builtin are projections of server configuration. */
export const writable=(entry:RegistryEntry)=>entry.origin==='user';
/** Current means bound to this revision and config digest; older evidence never counts. */
export function currentValidation(row:RegistryRow,validations:readonly RegistryValidation[],kind:RegistryValidation['kind']):RegistryValidation|null{
  return validations.filter(v=>v.kind===kind&&v.revision===row.revision&&v.configDigest===row.configDigest).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]??null;
}
export function registryStatus(row:RegistryRow,validations:readonly RegistryValidation[]):string{
  if(!row.enabled)return '비활성';
  const connection=currentValidation(row,validations,'connection');
  if(connection)return '연결 진단 '+validationNames[connection.state];
  const local=currentValidation(row,validations,'local');
  return local?'설정 검사 '+validationNames[local.state]+' · 연결 진단 전':'검증 전';
}

export function ModelRegistryPanel({projectId,online,post}:{projectId:string;online:boolean;post:Post}){
  const mode=useUiMode(),[list,setList]=useState<RegistryListView|null>(null),[details,setDetails]=useState<Record<string,RegistryValidation[]>>({});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[tick,setTick]=useState(0),[confirm,setConfirm]=useState<string|null>(null);
  useEffect(()=>{let live=true;if(!online)return;
    void fetch('/api/registry',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then(async(value:RegistryListView)=>{
      if(!live||!Array.isArray(value?.entries))return;setList(value);
      const pairs=await Promise.all(value.entries.filter(writable).map(row=>fetch('/api/registry/entries/'+encodeURIComponent(row.id),{cache:'no-store'}).then(r=>r.ok?r.json():null).then((d:RegistryDetail|null)=>[row.id,d?.validations??[]] as const).catch(()=>[row.id,[]] as const)));
      if(live)setDetails(Object.fromEntries(pairs));
    }).catch(()=>{if(live)setError('Registry를 불러오지 못했습니다.');});
    return()=>{live=false;};},[online,tick]);
  async function act(fn:()=>Promise<unknown>){if(busy||!online)return;setBusy(true);setError('');try{await fn();setTick(t=>t+1);}catch(e){setError(e instanceof Error&&e.message?e.message:'요청을 처리하지 못했습니다.');}finally{setBusy(false);setConfirm(null);}}
  const base=(row:RegistryRow)=>'/api/registry/entries/'+encodeURIComponent(row.id);
  const validate=(row:RegistryRow,kind:'local'|'connection')=>act(()=>post(base(row)+'/validate',{requestId:crypto.randomUUID(),kind,expectedRevision:row.revision,expectedConfigDigest:row.configDigest,...(kind==='connection'?{confirmed:true,projectId}:{})}));
  const providers=list?.entries.filter(row=>row.kind==='provider')??[];
  return <section className="surface" aria-labelledby="registry-title">
    <h2 id="registry-title">모델·제공자 Registry</h2>
    <p className="work-muted">등록·설정 검사는 실행 권한이 아닙니다. 인증 값은 입력하거나 저장하지 않고, 서버 환경 변수 참조 이름만 씁니다. 연결 진단은 확인한 뒤에만 실행합니다.</p>
    {error&&<p role="alert">{error}</p>}
    {!!list?.collisions.length&&<p role="alert">ID 충돌: {list.collisions.map(c=>`${c.id} (${c.origins.join(', ')})`).join(' · ')}. 덮어쓰지 않고 사용을 막았습니다.</p>}
    {!list?<p>불러오는 중…</p>:<table className="progress-runs"><thead><tr><th>이름</th><th>종류</th><th>출처</th><th>상태</th>{mode==='advanced'&&<th>근거</th>}<th></th></tr></thead>
      <tbody>{list.entries.map(row=>{const validations=details[row.id]??[];return <tr key={row.origin+row.id}>
        <td title={row.id}>{row.label}</td><td>{kindNames[row.kind]}</td><td>{originNames[row.origin]}</td>
        <td>{writable(row)?registryStatus(row,validations):row.nativeStatus?`설치 ${row.nativeStatus.installation} · 인증 ${row.nativeStatus.authentication}`:'서버 설정'}</td>
        {mode==='advanced'&&<td><small>
          {row.kind==='model'&&<>모델 ID {row.modelId} · </>}
          {row.authReferences.length?'인증 참조 '+row.authReferences.map(a=>`${a.name}(${a.configured?'설정됨':'없음'})`).join(', '):'인증 참조 없음'}
          {' · '}비용 {row.cost.kind}/{row.cost.source}{row.cost.unitPrice!==null?` ${row.cost.unitPrice} ${row.cost.currency}/${row.cost.unit}`:''}
          {row.declaredCapabilities.length?' · 선언 기능 '+row.declaredCapabilities.join(', '):''} · 설정 {row.configDigest.slice(0,12)} · r{row.revision}</small></td>}
        <td>{writable(row)&&row.enabled&&<span className="progress-actions">
          <button disabled={busy||!online} onClick={()=>void validate(row,'local')}>설정 검사</button>
          {confirm===row.id?<><button disabled={busy||!online} onClick={()=>void validate(row,'connection')}>확인: 연결 진단 실행</button><button onClick={()=>setConfirm(null)}>취소</button></>
            :<button disabled={busy||!online||!projectId} title="외부 목적지에 진단 요청을 보낼 수 있으며 비용은 미확인입니다" onClick={()=>setConfirm(row.id)}>연결 진단…</button>}
          <button disabled={busy||!online} onClick={()=>void act(()=>post(base(row)+'/disable',{expectedRevision:row.revision}))}>비활성화</button></span>}</td>
      </tr>;})}</tbody></table>}
    {list&&<ModelEntryForm providers={providers} disabled={busy||!online} onCreate={entry=>act(()=>post('/api/registry/entries',entry))}/>}
  </section>;
}

/** Model entries only; provider/runtime registration needs server-side review of endpoints and auth references (advanced follow-up). */
function ModelEntryForm({providers,disabled,onCreate}:{providers:RegistryRow[];disabled:boolean;onCreate:(entry:object)=>void}){
  const [id,setId]=useState(''),[label,setLabel]=useState(''),[providerId,setProviderId]=useState(''),[modelId,setModelId]=useState('');
  const submit=(event:FormEvent)=>{event.preventDefault();onCreate({kind:'model',id:id.trim(),label:label.trim(),providerId,modelId:modelId.trim()});};
  return <form onSubmit={submit} aria-label="모델 등록"><fieldset disabled={disabled}><legend>모델 등록 (비활성 상태로 저장)</legend>
    <label>ID<input value={id} onChange={e=>setId(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" required/></label>
    <label>이름<input value={label} onChange={e=>setLabel(e.target.value)} required/></label>
    <label>제공자<select value={providerId} onChange={e=>setProviderId(e.target.value)} required><option value="">선택</option>{providers.map(p=><option key={p.origin+p.id} value={p.id}>{p.label}</option>)}</select></label>
    <label>제공자 모델 ID<input value={modelId} onChange={e=>setModelId(e.target.value)} required/></label>
    <p className="work-muted">지정한 모델 ID는 요청값입니다. 실제 실행 모델은 실행 기록에서 관측된 경우에만 표시합니다.</p>
    <button type="submit">등록</button></fieldset></form>;
}
