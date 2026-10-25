import { useEffect, useRef, useState } from 'react';
import type { PlanningDraft, PlanningVersion, TaskDraft } from '../../shared/parallel.ts';
import { approvalIssues, MAX_PLANNING_BYTES, parsePlanningDraft, serializePlanningDraft } from '../../server/planning/parser.ts';
import type { PlanningInput } from '../../server/planning/parser.ts';
import './planning.css';

export interface PlanningStudioProps {
  projectId: string;
  list(projectId: string): Promise<PlanningVersion[]>;
  create(projectId: string, input: PlanningInput): Promise<PlanningVersion>;
  revise(projectId: string, versionId: string, expectedRevision: number, input: PlanningInput): Promise<PlanningVersion>;
  approve(projectId: string, versionId: string, expectedRevision: number): Promise<PlanningVersion>;
  toTasks(projectId: string, versionId: string): Promise<TaskDraft[]>;
}

const starter = '# My plan\n\n## Goal\n\n## Requirements\n### REQ-01\n\n#### Acceptance criteria\n\n## Constraints\n\n## Open questions\n';

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
  const [message, setMessage] = useState('Loading versions…');
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
      if (!cancelled) { setVersions(rows); setMessage('Ready. No provider connection is required.'); }
    }).catch(() => { if (!cancelled) setMessage('Could not load versions. Try Reload versions.'); })
      .finally(() => { if (!cancelled) { setBusy(false); locked.current = false; } });
    return () => { cancelled = true; alive.current = false; };
    // Callback identity changes must not discard unsaved edits or reload behind an approval.
    // The parent keys this component by projectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  async function operation(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage('Working…');
    try { await work(); }
    catch {
      if (alive.current) setMessage('The operation could not be confirmed. Reload versions to check for a saved change or revision conflict.');
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
      setMessage('Draft saved. Approval is required before task conversion.');
      try {
        const rows = await props.list(props.projectId);
        if (alive.current) setVersions(rows);
      } catch { if (alive.current) setMessage('Draft saved; version history could not refresh. Use Reload versions.'); }
    });
  }

  async function approve() {
    if (!selected || dirty) return;
    await operation(async () => {
      const saved = await props.approve(props.projectId, selected.id, selected.revision);
      if (!alive.current) return;
      setVersions(rows => rows.map(row => row.id === saved.id ? saved : row));
      setMessage('Saved version approved. Task drafts can now be requested.');
    });
  }

  return <section className="planning-studio" aria-label="Planning Studio" aria-busy={busy}>
    <header><h2>Planning Studio</h2><p>Write a plan or import Markdown / JSON. Review a saved version, approve it, then create task drafts.</p></header>
    <p role="status">{message}</p>
    <div className="planning-toolbar">
      <label>Saved version<select value={selectedId} disabled={busy || dirty} onChange={event => choose(versions.find(version => version.id === event.target.value))}>
        <option value="">New plan</option>
        {versions.map(version => <option key={version.id} value={version.id}>{version.draft.title || 'Untitled'} · r{version.revision} · {version.state} · {version.id.slice(0, 8)}</option>)}
      </select></label>
      <button disabled={busy} onClick={() => { choose(); setMessage('New draft. Previous unsaved edits were discarded.'); }}>New plan / discard edits</button>
      <button disabled={busy} onClick={() => void operation(async () => {
        const rows = await props.list(props.projectId);
        if (!alive.current) return;
        setVersions(rows); setTasks([]); setMessage('Versions reloaded. Editor content was preserved.');
      })}>Reload versions</button>
    </div>
    <div className="planning-columns">
      <div>
        <div className="planning-toolbar">
          <label>Format<select disabled={busy} value={input.format} onChange={event => edit({ ...input, format: event.target.value as PlanningInput['format'] })}>
            <option value="markdown">Markdown</option><option value="json">JSON v1</option>
          </select></label>
          <label>Source<select disabled={busy} value={input.source} onChange={event => edit({ ...input, source: event.target.value as PlanningInput['source'] })}>
            <option value="manual">Manual</option><option value="import">Import</option>
          </select></label>
          <label>Import file<input type="file" accept=".md,.markdown,.json,text/plain,text/markdown,application/json" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            if (file.size > MAX_PLANNING_BYTES) { setMessage('File exceeds the 256 KiB limit.'); return; }
            void operation(async () => {
              const text = await file.text();
              if (!alive.current) return;
              edit({ format: file.name.toLowerCase().endsWith('.json') ? 'json' : 'markdown', source: 'import', text });
              setMessage('File loaded into the editor. Review and save a version.');
            });
          }} /></label>
        </div>
        <label className="planning-editor">Plan text<textarea value={input.text} disabled={busy} maxLength={MAX_PLANNING_BYTES + 1} spellCheck={false}
          onChange={event => edit({ ...input, text: event.target.value })} /></label>
        <p>Limit: 256 KiB UTF-8. Markdown sections: Goal, Requirements (### label / #### Acceptance criteria), Constraints, Open questions. List items use “- ”.</p>
      </div>
      <div aria-label="Plan preview">
        <h3>Preview</h3>
        {parsed.ok ? <PlanningPreview draft={parsed.draft} /> : <ul role="alert">{parsed.issues.map((issue, index) => <li key={index}>{issue.field}: {issue.code}</li>)}</ul>}
      </div>
    </div>
    {selected && <p>Saved r{selected.revision}: {selected.state}. {dirty ? 'Unsaved changes need a new revision.' : 'Editor matches the saved version.'}</p>}
    <div className="planning-toolbar">
      <button disabled={busy || !parsed.ok || (!!selected && !dirty)} onClick={() => void save()}>{selected ? 'Save new revision' : 'Save draft'}</button>
      <button disabled={busy || !selected || dirty || selected.state !== 'draft' || !parsed.ok || (parsed.ok && approvalIssues(parsed.draft).length > 0)} onClick={() => void approve()}>Approve saved version</button>
      <button disabled={busy || !selected || dirty || selected.state !== 'approved'} onClick={() => {
        if (!selected || dirty) return;
        void operation(async () => {
          const result = await props.toTasks(props.projectId, selected.id);
          if (alive.current) { setTasks(result); setMessage('Task drafts prepared. No agent run has started.'); }
        });
      }}>Create task drafts</button>
    </div>
    {tasks.length > 0 && <section aria-label="Task drafts"><h3>Task drafts</h3>{tasks.map((task, index) => <article key={index}>
      <h4>{task.title}</h4><p>{task.description}</p><ul>{task.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
      <small>Planning version: {task.planningVersionId}</small>
    </article>)}</section>}
  </section>;
}

export function PlanningPreview({ draft }: { draft: PlanningDraft }) {
  const issues = approvalIssues(draft);
  return <div className="planning-preview">
    <h4>{draft.title || 'Untitled draft'}</h4><p>{draft.goal || 'Add a goal.'}</p>
    {draft.requirements.map(requirement => <article key={requirement.label}><h5>{requirement.label}</h5><p>{requirement.description}</p>
      <ul>{requirement.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></article>)}
    <h4>Constraints</h4><ul>{draft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul>
    <h4>Open questions</h4><ul>{draft.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul>
    {issues.length > 0 && <p>Incomplete draft: {issues.map(issue => issue.field).join(', ')}. Saving is allowed; approval requires these fields.</p>}
  </div>;
}
