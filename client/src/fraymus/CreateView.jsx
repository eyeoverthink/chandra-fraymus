import { useEffect, useState } from 'react';
import { api, formatWhen } from './api.js';

export default function CreateView() {
  const [presets, setPresets] = useState([]);
  const [topics, setTopics] = useState({ 'research-brief': '', 'short-video-script': '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    api('/api/fraymus-os/recipes').then(body => setPresets(body.presets || [])).catch(err => setError(err.message));
    refresh();
  }, []);

  function refresh() {
    api('/api/fraymus-os/artifacts').then(body => setHistory(body.artifacts || [])).catch(err => setError(err.message));
  }

  async function run(preset) {
    const topic = topics[preset.id]?.trim();
    if (!topic) { setError('Add a topic first.'); return; }
    setBusy(preset.id);
    setError('');
    setLatest(null);
    try {
      const body = await api(`/api/fraymus-os/recipes/${preset.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ topic }),
      });
      setLatest(body.artifact);
      refresh();
    } catch (err) {
      setError(err.message);
      if (err.body?.artifact) setLatest(err.body.artifact);
      refresh();
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="create">
      <header>
        <h1>Create</h1>
        <p>Two Chandra creation stages, saved with provenance. Nothing here publishes, posts, or spends.</p>
      </header>
      {error && <p className="warn banner">{error}</p>}
      <div className="preset-grid">
        {(presets.length ? presets : [
          { id: 'research-brief', title: 'Research brief', summary: 'Topic to a creative brief.', stages: ['creative_brief'], services: ['ollama'] },
          { id: 'short-video-script', title: 'Short-video script', summary: 'Topic to a brief and narration script.', stages: ['creative_brief', 'script_writer'], services: ['ollama'] },
        ]).map(preset => (
          <article key={preset.id} className="preset">
            <h2>{preset.title}</h2>
            <p>{preset.summary}</p>
            <p className="muted">Stages: {(preset.stages || []).join(' → ')} · Needs {(preset.services || []).join(', ')}</p>
            <label>
              Topic
              <input
                value={topics[preset.id] || ''}
                onChange={event => setTopics(current => ({ ...current, [preset.id]: event.target.value }))}
                placeholder="What is this about?"
              />
            </label>
            <button type="button" onClick={() => run(preset)} disabled={!!busy}>
              {busy === preset.id ? 'Running…' : 'Run preset'}
            </button>
          </article>
        ))}
      </div>
      {latest && (
        <article className="artifact">
          <h2>{latest.status === 'failed' ? 'Attempt saved' : 'Artifact'} · {latest.topic}</h2>
          <p className="muted">{latest.id} · creation run {latest.creationRunId || 'not recorded'} · {latest.provenance?.model || latest.provenance?.modelNote}</p>
          {latest.error && <p className="warn">{latest.error}</p>}
          {latest.payload?.brief && (
            <div>
              <h3>{latest.payload.brief.title || 'Brief'}</h3>
              <p>{latest.payload.brief.hook}</p>
              <p>{latest.payload.brief.narrative_arc}</p>
            </div>
          )}
          {latest.payload?.script?.narration_script && (
            <pre>{latest.payload.script.narration_script}</pre>
          )}
        </article>
      )}
      <section className="history">
        <h2>Saved artifacts</h2>
        {history.length === 0 && <p className="muted">No presets have been run on this machine yet.</p>}
        <ul>
          {history.map(item => (
            <li key={item.id}>
              <button type="button" onClick={() => api(`/api/fraymus-os/artifacts/${item.id}`).then(setLatest).catch(err => setError(err.message))}>
                {item.topic}
              </button>
              <span>{item.preset} · {item.status} · {formatWhen(item.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
