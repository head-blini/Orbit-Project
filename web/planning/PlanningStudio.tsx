import {planningDepth,planningDepthReason} from '../../shared/planning-agent.ts';
import { useEffect, useRef, useState } from 'react';
import type { PlanningDraft, PlanningVersion, TaskDraft } from '../../shared/parallel.ts';
import { approvalIssues, MAX_PLANNING_BYTES, parsePlanningDraft, serializePlanningDraft } from '../../server/planning/parser.ts';
import type { PlanningInput } from '../../server/planning/parser.ts';
import type { PlanningExportFormat } from '../../shared/planning-handoff.ts';
import type { PlanningComparisonProps } from '../../shared/planning-revisions.ts';
import { PlanningComparisonPanel } from './PlanningComparison.tsx';
import type { PlanningAgentPanelProps } from '../../shared/planning-agent.ts';
import { PlanningAgentPanel } from './PlanningAgent.tsx';
import { mergeStudioRecords } from '../studio-client.ts';
import './planning.css';

export interface PlanningStudioProps {
  projectId: string;
  showTaskPreview?: boolean;
  list(projectId: string): Promise<PlanningVersion[]>;
  create(projectId: string, input: PlanningInput): Promise<PlanningVersion>;
  revise(projectId: string, versionId: string, expectedRevision: number, input: PlanningInput): Promise<PlanningVersion>;
  approve(projectId: string, versionId: string, expectedRevision: number): Promise<PlanningVersion>;
  toTasks(projectId: string, versionId: string): Promise<TaskDraft[]>;
  onExport?(projectId: string, version: PlanningVersion, format: PlanningExportFormat): Promise<void>;
  onCompare?:PlanningComparisonProps['onCompare'];
  onReplan?:PlanningComparisonProps['onReplan'];
  agentPlanning?:Omit<PlanningAgentPanelProps,'projectId'|'onSaved'>&{general?:boolean};
}

const starter = '# 새 기획안\n\n## Goal\n\n## Requirements\n### REQ-01\n\n#### Acceptance criteria\n\n## Constraints\n\n## Decisions\n\n## Open questions\n';

/** Callbacks must call the server; UI state is never an approval credential. */
export function PlanningStudio(props: PlanningStudioProps) {
  // A project change discards editor state and prevents pending responses crossing projects.
  return <PlanningProject key={props.projectId} {...props} />;
}

function PlanningProject(props: PlanningStudioProps) {
  const [versions, setVersions] = useState<PlanningVersion[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [input, setInput] = useState<PlanningInput>({ format: 'markdown', text: starter, source: 'manual' });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('기획 버전을 불러오는 중…');
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const alive = useRef(false);
  const locked = useRef(false);
  const selected = versions.find(version => version.id === selectedId);
  const parsed = parsePlanningDraft(input);

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    locked.current = true;
    Promise.resolve().then(() => props.list(props.projectId)).then(rows => {
      if (!cancelled) { setVersions(rows); setMessage('편집할 준비가 됐습니다. AI 연결은 필요하지 않습니다.'); }
    }).catch(() => { if (!cancelled) setMessage('기획 버전을 불러오지 못했습니다. 버전 새로고침을 눌러주세요.'); })
      .finally(() => { if (!cancelled) { setBusy(false); locked.current = false; } });
    return () => { cancelled = true; alive.current = false; };
    // Callback identity changes must not discard unsaved edits or reload behind an approval.
    // The parent keys this component by projectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  async function operation(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage('처리 중…');
    try { await work(); }
    catch {
      if (alive.current) setMessage('처리 결과를 확인하지 못했습니다. 버전 새로고침으로 저장 여부와 버전 충돌을 확인하세요.');
    } finally {
      if (alive.current) { locked.current = false; setBusy(false); }
    }
  }

  function choose(version?: PlanningVersion) {
    setSelectedId(version?.id ?? ''); setTasks([]); setDirty(false);
    setInput(version ? { format: 'json', text: serializePlanningDraft(version.draft), source: version.draft.source }
      : { format: 'markdown', text: starter, source: 'manual' });
  }

  function edit(next: PlanningInput) { setInput(next); setDirty(true); setTasks([]); }

  async function save() {
    await operation(async () => {
      const saved = selected
        ? await props.revise(props.projectId, selected.id, selected.revision, input)
        : await props.create(props.projectId, input);
      if (!alive.current) return;
      // A list failure does not discard the acknowledged save or invite a duplicate create.
      setVersions(rows => [...rows.filter(row => row.id !== saved.id), saved]);
      choose(saved);
      setMessage('초안을 저장했습니다. Task 생성 전 저장된 버전을 승인하세요.');
      try {
        const rows = await props.list(props.projectId);
        if (alive.current) setVersions(rows);
      } catch { if (alive.current) setMessage('초안은 저장됐으나 이력을 불러오지 못했습니다. 버전 새로고침을 눌러주세요.'); }
    });
  }

  async function approve() {
    if (!selected || dirty) return;
    await operation(async () => {
      const saved = await props.approve(props.projectId, selected.id, selected.revision);
      if (!alive.current) return;
      setVersions(rows => rows.map(row => row.id === saved.id ? saved : row));
      setMessage('저장된 버전을 승인했습니다. Task 초안을 생성할 수 있습니다.');
    });
  }

  return <section className="planning-studio" aria-label="Planning Studio" aria-busy={busy}>
    {props.agentPlanning&&<PlanningAgentPanel {...props.agentPlanning} projectId={props.projectId} busy={busy||props.agentPlanning.busy} onSaved={version=>{
      if(!alive.current)return;
      setVersions(rows=>mergeStudioRecords(rows,[version]));
      setMessage('AI 기획 제안을 별도 초안으로 추가했습니다. 현재 편집 내용은 유지했습니다.');
    }}/>}
    <header><h2>기획안 편집기</h2></header>
    <p role="status">{message}</p>
    <div className="planning-toolbar">
      <label>저장된 버전<select value={selectedId} disabled={busy || dirty} onChange={event => choose(versions.find(version => version.id === event.target.value))}>
        <option value="">새 기획안</option>
        {versions.map(version => <option key={version.id} value={version.id}>{version.draft.title || '제목 없음'} · r{version.revision} · {version.state} · {version.id.slice(0, 8)}</option>)}
      </select></label>
      <button disabled={busy} onClick={() => { choose(); setMessage('새 초안입니다. 이전 미저장 편집 내용은 버렸습니다.'); }}>새 기획안 / 편집 내용 버리기</button>
      <button disabled={busy} onClick={() => void operation(async () => {
        const rows = await props.list(props.projectId);
        if (!alive.current) return;
        setVersions(rows); setTasks([]); setMessage('버전을 새로 불러왔습니다. 편집 내용은 유지했습니다.');
      })}>버전 새로고침</button>
    </div>
    <div className="planning-columns">
      <div>
        <div className="planning-toolbar">
          <label>입력 형식<select disabled={busy} value={input.format} onChange={event => edit({ ...input, format: event.target.value as PlanningInput['format'] })}>
            <option value="markdown">Markdown</option><option value="json">JSON v1</option>
          </select></label>
          <label>출처<select disabled={busy} value={input.source} onChange={event => edit({ ...input, source: event.target.value as PlanningInput['source'] })}>
            <option value="manual">직접 작성</option><option value="import">가져오기</option>
          </select></label>
          <label>파일 가져오기<input type="file" accept=".md,.markdown,.json,text/plain,text/markdown,application/json" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            if (file.size > MAX_PLANNING_BYTES) { setMessage('파일이 256 KiB 제한을 초과합니다.'); return; }
            void operation(async () => {
              const text = await file.text();
              if (!alive.current) return;
              edit({ format: file.name.toLowerCase().endsWith('.json') ? 'json' : 'markdown', source: 'import', text });
              setMessage('파일을 불러왔습니다. 내용을 검토한 뒤 저장하세요.');
            });
          }} /></label>
        </div>
        <label className="planning-editor">기획안 원문<textarea value={input.text} disabled={busy} maxLength={MAX_PLANNING_BYTES + 1} spellCheck={false}
          onChange={event => edit({ ...input, text: event.target.value })} /></label>
        <p>최대 256 KiB UTF-8. Markdown 구역명: Goal, Requirements (### 식별자 / #### Acceptance criteria), Constraints, Open questions. 목록은 “- ”로 작성하세요.</p>
        <details className="planning-metadata-help"><summary>결정 사항과 출처 입력 안내</summary>
          <p>선택 구역 Decisions에는 주제마다 결정과 근거를 기록합니다. 작성한 결정 사항은 주제·결정·근거를 모두 채워야 승인할 수 있습니다.</p>
          <pre>{'## Decisions\n### 결정 주제\n#### Decision\n선택한 설계나 방식을 작성하세요.\n#### Rationale\n선택한 이유를 작성하세요.'}</pre>
          <p>JSON v1의 source에는 사용자 제공 출처 정보를 기록할 수 있습니다. 제공자·작성자·URL의 신원과 내용은 검증하지 않습니다. URL은 텍스트로 표시됩니다.</p>
          <pre>{'"source": {\n  "kind": "external",\n  "provider_id": "사용자 입력 제공자",\n  "external_url": "https://example.com/planning",\n  "author": "작성자 표기",\n  "references": [\n    {"title": "참고 자료", "url": "https://example.com/reference"}\n  ]\n}'}</pre>
          <p>출처 URL은 HTTP(S) 주소를 사용하세요. 제공자와 원문 URL이 없으면 null로 입력하고, 작성자와 참고 자료는 생략할 수 있습니다.</p>
        </details>
      </div>
      <div aria-label="기획안 미리보기">
        <h3>미리보기</h3>
        {parsed.ok ? <PlanningPreview draft={parsed.draft} disabled={busy} onDepthChange={depth=>edit({...input,format:'json',text:serializePlanningDraft({...parsed.draft,depth,depthReason:'사용자가 승인 전에 명세 깊이를 선택했습니다.'})})} /> : <ul role="alert">{parsed.issues.map((issue, index) => <li key={index}>{issue.field}: {issue.code}</li>)}</ul>}
      </div>
    </div>
    {selected && <p>저장 버전 {selected.revision}: {selected.state}. {dirty ? '편집 내용은 새 버전으로 저장해야 합니다.' : '저장된 버전과 일치합니다.'}</p>}
    <PlanningExportActions projectId={props.projectId} version={selected} dirty={dirty} busy={busy}
      onExport={props.onExport?async(version,format)=>operation(async()=>{
        await props.onExport!(props.projectId,version,format);
        if(alive.current)setMessage(`저장된 버전 r${version.revision}의 ${format==='json'?'JSON':'Markdown'} 다운로드를 요청했습니다.`);
      }):undefined}/>
    <div className="planning-toolbar">
      <button disabled={busy || !parsed.ok || (!!selected && !dirty)} onClick={() => void save()}>{selected ? '새 버전 저장' : '편집 내용을 초안으로 저장'}</button>
      <button disabled={busy || !selected || dirty || selected.state !== 'draft' || !parsed.ok || (parsed.ok && approvalIssues(parsed.draft).length > 0)} onClick={() => void approve()}>저장된 버전 승인</button>
      <button disabled={busy || !selected || dirty || selected.state !== 'approved'} onClick={() => {
        if (!selected || dirty) return;
        void operation(async () => {
          const result = await props.toTasks(props.projectId, selected.id);
          if (alive.current) { setTasks(result); setMessage('Task 초안을 생성했습니다. 에이전트는 실행되지 않았습니다.'); }
        });
      }}>Task 초안 생성</button>
    </div>
    {props.onCompare&&props.onReplan&&<PlanningComparisonPanel projectId={props.projectId} versions={versions} selected={selected} dirty={dirty} busy={busy} onCompare={props.onCompare} onReplan={props.onReplan}/>}
    {props.showTaskPreview !== false && tasks.length > 0 && <section aria-label="Task 초안"><h3>Task 초안</h3>{tasks.map((task, index) => <article key={index}>
      <h4>{task.title}</h4><p>{task.description}</p><ul>{task.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
      <small>기획 버전: {task.planningVersionId}</small>
    </article>)}</section>}
  </section>;
}

/** The host exports this exact saved id/revision/hash; unsaved editor text is never exported. */
export function PlanningExportActions({projectId,version,dirty,busy,onExport}:{projectId:string;version?:PlanningVersion;dirty:boolean;busy:boolean;onExport?:(version:PlanningVersion,format:PlanningExportFormat)=>Promise<void>}){
  const enabled=!!version&&version.projectId===projectId&&!dirty&&!busy&&!!onExport;
  return <div className="planning-toolbar planning-export-actions" aria-label="저장 기획 내보내기">
    <button disabled={!enabled} onClick={()=>{if(enabled&&version&&onExport)void onExport(version,'markdown');}}>저장 버전 Markdown 내보내기</button>
    <button disabled={!enabled} onClick={()=>{if(enabled&&version&&onExport)void onExport(version,'json');}}>저장 버전 JSON 내보내기</button>
    <p>선택한 저장 버전만 내보냅니다. 편집 중인 내용은 먼저 새 버전으로 저장하세요.</p>
  </div>;
}

export function PlanningPreview({ draft,disabled=false,onDepthChange }: { draft: PlanningDraft;disabled?:boolean;onDepthChange?:(depth:'simple'|'detailed')=>void }) {
  const issues = approvalIssues(draft);
  return <div className="planning-preview">
    <p>명세 깊이: {planningDepth(draft.depth)==='simple'?'간단히 정리':'자세히 정리'}</p>
    <p>{planningDepthReason(draft)}</p>
    {onDepthChange&&<label>명세 깊이 선택<select value={planningDepth(draft.depth)} disabled={disabled} onChange={event=>onDepthChange(planningDepth(event.target.value))}>
      <option value="simple">간단히 정리</option><option value="detailed">자세히 정리</option>
    </select><small>변경한 내용은 새 버전으로 저장한 뒤 승인하세요. 기존 완료 조건은 유지됩니다.</small></label>}
    <h4>{draft.title || '제목 없는 초안'}</h4><p>{draft.goal || '목표를 입력하세요.'}</p>
    {draft.requirements.map(requirement => <article key={requirement.label}><h5>{requirement.label}</h5><p>{requirement.description}</p>
      <ul>{requirement.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></article>)}
    <h4>제약 사항</h4><ul>{draft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul>
    {!!draft.nonGoals?.length&&<section aria-label="하지 않을 것"><h4>하지 않을 것</h4><ul>{draft.nonGoals.map((text,index)=><li key={index}>{text}</li>)}</ul></section>}
    {!!draft.risks?.length&&<section aria-label="위험 요소"><h4>위험 요소</h4><ul>{draft.risks.map((text,index)=><li key={index}>{text}</li>)}</ul></section>}
    {!!draft.decisions?.length && <section aria-label="기획 결정 사항"><h4>결정 사항</h4>
      {draft.decisions.map((item,index) => <article key={index}><h5>{item.topic || '주제 미입력'}</h5>
        <dl className="planning-metadata-values"><dt>결정</dt><dd>{item.decision || '결정 미입력'}</dd><dt>근거</dt><dd>{item.rationale || '근거 미입력'}</dd></dl>
      </article>)}
    </section>}
    <h4>미결정 사항</h4><ul>{draft.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul>
    {draft.provenance && <section aria-label="출처 정보"><h4>출처 정보 · 미검증</h4>
      <p>직접 입력·가져오기 또는 Orbit 기획 제안 경로에서 저장된 표기입니다. 제공자·작성자·URL의 신원과 내용은 검증하지 않았으며 기획 승인 근거가 아닙니다.</p>
      <dl className="planning-metadata-values"><dt>출처 유형</dt><dd>{draft.provenance.kind}</dd>
        <dt>제공자 표기</dt><dd>{draft.provenance.providerId ?? '미기재'}</dd>
        <dt>외부 원문 URL</dt><dd>{draft.provenance.externalUrl ?? '미기재'}</dd>
        {draft.provenance.author !== undefined && <><dt>작성자 표기</dt><dd>{draft.provenance.author}</dd></>}
      </dl>
      {!!draft.provenance.references?.length && <><h5>참고 자료</h5><ul>{draft.provenance.references.map((reference,index) => <li key={index}>
        <p>{reference.title}</p><p>{reference.url}</p>
      </li>)}</ul></>}
    </section>}
    {issues.length > 0 && <p>초안에 필요한 항목: {issues.map(issue => issue.field).join(', ')}. 저장할 수 있지만 승인하려면 해당 항목을 채워야 합니다.</p>}
  </div>;
}
