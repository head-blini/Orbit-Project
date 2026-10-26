import { useEffect, useRef, useState } from 'react';
import type { PlanningDraft, PlanningVersion, TaskDraft } from '../../shared/parallel.ts';
import { approvalIssues, MAX_PLANNING_BYTES, parsePlanningDraft, serializePlanningDraft } from '../../server/planning/parser.ts';
import type { PlanningInput } from '../../server/planning/parser.ts';
import type { PlanningExportFormat } from '../../shared/planning-handoff.ts';
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
}

const starter = '# 새 기획안\n\n## Goal\n\n## Requirements\n### REQ-01\n\n#### Acceptance criteria\n\n## Constraints\n\n## Open questions\n';

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
      </div>
      <div aria-label="기획안 미리보기">
        <h3>미리보기</h3>
        {parsed.ok ? <PlanningPreview draft={parsed.draft} /> : <ul role="alert">{parsed.issues.map((issue, index) => <li key={index}>{issue.field}: {issue.code}</li>)}</ul>}
      </div>
    </div>
    {selected && <p>저장 버전 {selected.revision}: {selected.state}. {dirty ? '편집 내용은 새 버전으로 저장해야 합니다.' : '저장된 버전과 일치합니다.'}</p>}
    <PlanningExportActions projectId={props.projectId} version={selected} dirty={dirty} busy={busy}
      onExport={props.onExport?async(version,format)=>operation(async()=>{
        await props.onExport!(props.projectId,version,format);
        if(alive.current)setMessage(`저장된 버전 r${version.revision}의 ${format==='json'?'JSON':'Markdown'} 다운로드를 요청했습니다.`);
      }):undefined}/>
    <div className="planning-toolbar">
      <button disabled={busy || !parsed.ok || (!!selected && !dirty)} onClick={() => void save()}>{selected ? '새 버전 저장' : '초안 저장'}</button>
      <button disabled={busy || !selected || dirty || selected.state !== 'draft' || !parsed.ok || (parsed.ok && approvalIssues(parsed.draft).length > 0)} onClick={() => void approve()}>저장된 버전 승인</button>
      <button disabled={busy || !selected || dirty || selected.state !== 'approved'} onClick={() => {
        if (!selected || dirty) return;
        void operation(async () => {
          const result = await props.toTasks(props.projectId, selected.id);
          if (alive.current) { setTasks(result); setMessage('Task 초안을 생성했습니다. 에이전트는 실행되지 않았습니다.'); }
        });
      }}>Task 초안 생성</button>
    </div>
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

export function PlanningPreview({ draft }: { draft: PlanningDraft }) {
  const issues = approvalIssues(draft);
  return <div className="planning-preview">
    <h4>{draft.title || '제목 없는 초안'}</h4><p>{draft.goal || '목표를 입력하세요.'}</p>
    {draft.requirements.map(requirement => <article key={requirement.label}><h5>{requirement.label}</h5><p>{requirement.description}</p>
      <ul>{requirement.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></article>)}
    <h4>제약 사항</h4><ul>{draft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul>
    <h4>미결정 사항</h4><ul>{draft.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul>
    {issues.length > 0 && <p>초안에 필요한 항목: {issues.map(issue => issue.field).join(', ')}. 저장할 수 있지만 승인하려면 해당 항목을 채워야 합니다.</p>}
  </div>;
}
