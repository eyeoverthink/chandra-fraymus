import React, { useState, useEffect, useCallback } from 'react';

export default function CreationPanel({ wsEvent }) {
  const [tab, setTab] = useState('pipeline');
  const [topic, setTopic] = useState('');
  const [format, setFormat] = useState('short_video');
  const [style, setStyle] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runs, setRuns] = useState([]);
  const [expanded, setExpanded] = useState(null);

  const loadRuns = useCallback(() => {
    fetch('/api/creation/runs').then(r => r.json()).then(d => setRuns(d.runs || [])).catch(() => {});
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => {
    if (wsEvent?.type === 'creation' || wsEvent?.type === 'event') loadRuns();
  }, [wsEvent, loadRuns]);

  const runPipeline = async () => {
    if (!topic.trim() || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/creation/pipeline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic.trim(), format, style: style.trim() || undefined }),
      });
      const data = await res.json();
      setResult(data);
      setTopic('');
      setStyle('');
      loadRuns();
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  };

  const runStage = async (stage, body) => {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch(`/api/creation/${stage}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setResult(data);
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  };

  const TABS = [
    { id: 'pipeline', label: 'Full Pipeline', icon: '▶' },
    { id: 'stages', label: 'Individual Stages', icon: '◇' },
    { id: 'history', label: 'Run History', icon: '◈' },
  ];

  const FORMATS = ['short_video', 'long_video', 'podcast', 'social_post', 'hyperframes'];
  const STAGES = [
    { id: 'brief', label: 'Creative Brief', desc: 'Intelligence-driven concept generation' },
    { id: 'script', label: 'Script Writer', desc: 'Narration + shot list + timing' },
    { id: 'voice', label: 'Voice Synth', desc: 'Clone cascade or TTS fallback' },
    { id: 'visuals', label: 'Visual Assembly', desc: 'Image prompts + HyperFrames' },
    { id: 'distribute', label: 'Distribution Prep', desc: 'Platform packages + metadata' },
    { id: 'commerce-bridge', label: 'Commerce Bridge', desc: 'Route to commerce pipeline' },
  ];

  const statusColor = s => s === 'completed' ? '#22c55e' : s === 'running' ? '#f59e0b' : s === 'failed' ? '#ef4444' : '#888';

  return (
    <div style={{ padding: 20, color: '#e0e0e8' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #222', paddingBottom: 12 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? '#7c3aed22' : 'transparent',
            border: `1px solid ${tab === t.id ? '#7c3aed' : '#333'}`,
            borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
            color: tab === t.id ? '#a78bfa' : '#888', fontSize: 13, fontWeight: 500,
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'pipeline' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Topic / Concept</label>
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. sovereign identity in the age of AI"
              style={{ width: '100%', background: '#111', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', color: '#e0e0e8', fontSize: 14 }}
              onKeyDown={e => e.key === 'Enter' && runPipeline()} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Format</label>
              <select value={format} onChange={e => setFormat(e.target.value)}
                style={{ width: '100%', background: '#111', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', color: '#e0e0e8', fontSize: 13 }}>
                {FORMATS.map(f => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Style (optional)</label>
              <input value={style} onChange={e => setStyle(e.target.value)} placeholder="auto (intelligence-driven)"
                style={{ width: '100%', background: '#111', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', color: '#e0e0e8', fontSize: 13 }} />
            </div>
          </div>
          <button onClick={runPipeline} disabled={!topic.trim() || running}
            style={{
              background: running ? '#333' : 'linear-gradient(135deg, #7c3aed, #a78bfa)',
              border: 'none', borderRadius: 8, padding: '10px 24px', color: '#fff',
              fontWeight: 600, fontSize: 14, cursor: running ? 'wait' : 'pointer', width: '100%',
            }}>
            {running ? '◈ Running Pipeline...' : '▶ Run Full Creation Pipeline'}
          </button>

          {result && (
            <div style={{ marginTop: 16, background: result.error ? '#2a1515' : '#0f1a15', border: `1px solid ${result.error ? '#4a2020' : '#1a3a25'}`, borderRadius: 8, padding: 14 }}>
              {result.error ? (
                <div style={{ color: '#ef4444', fontSize: 13 }}>Error: {result.error}</div>
              ) : (
                <div style={{ fontSize: 13 }}>
                  <div style={{ color: '#22c55e', fontWeight: 600, marginBottom: 6 }}>Pipeline Complete</div>
                  <div style={{ color: '#aaa' }}>Run ID: <span style={{ color: '#a78bfa' }}>{result.runId || result.id}</span></div>
                  {result.stages && <div style={{ color: '#aaa', marginTop: 4 }}>Stages: {typeof result.stages === 'string' ? result.stages : JSON.stringify(result.stages).slice(0, 200)}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'stages' && (
        <div style={{ display: 'grid', gap: 10 }}>
          {STAGES.map(s => (
            <button key={s.id} onClick={() => runStage(s.id, { topic: topic || 'test topic', format })}
              disabled={running}
              style={{
                background: '#111', border: '1px solid #222', borderRadius: 8,
                padding: '12px 16px', cursor: 'pointer', textAlign: 'left',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
              <div>
                <div style={{ color: '#a78bfa', fontWeight: 600, fontSize: 14 }}>{s.label}</div>
                <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>{s.desc}</div>
              </div>
              <span style={{ color: '#555', fontSize: 18 }}>→</span>
            </button>
          ))}
          <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
            Tip: set a topic in the Pipeline tab first, then run individual stages here.
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div>
          {runs.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>No creation runs yet</div>}
          {runs.map(r => (
            <div key={r.id} onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 14, marginBottom: 8, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ color: '#a78bfa', fontWeight: 600, fontSize: 14 }}>{r.topic || 'Untitled'}</span>
                  <span style={{ color: '#555', fontSize: 12, marginLeft: 8 }}>{r.format || 'short_video'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: statusColor(r.status), fontSize: 12, fontWeight: 500 }}>{r.status}</span>
                  <span style={{ color: '#555', fontSize: 11 }}>{r.created_at ? new Date(typeof r.created_at === 'number' ? r.created_at : r.created_at).toLocaleString() : ''}</span>
                </div>
              </div>
              {expanded === r.id && r.stages && (
                <div style={{ marginTop: 10, padding: 10, background: '#0a0a14', borderRadius: 6, fontSize: 12, color: '#888' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {typeof r.stages === 'string' ? r.stages : JSON.stringify(JSON.parse(r.stages || '{}'), null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
