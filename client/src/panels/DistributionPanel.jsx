import React, { useState, useEffect, useCallback } from 'react';

export default function DistributionPanel({ wsEvent }) {
  const [tab, setTab] = useState('publish');
  const [platforms, setPlatforms] = useState([]);
  const [content, setContent] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState(null);
  const [calendar, setCalendar] = useState([]);
  const [schedTopic, setSchedTopic] = useState('');
  const [schedPlatform, setSchedPlatform] = useState('youtube');
  const [schedTime, setSchedTime] = useState('');
  const [expanded, setExpanded] = useState(null);

  const loadPlatforms = useCallback(() => {
    fetch('/api/distribution/platforms').then(r => r.json()).then(d => {
      setPlatforms(d.platforms || []);
      if (!selectedPlatforms.length && d.platforms?.length) {
        setSelectedPlatforms(d.platforms.filter(p => p.available).map(p => p.id));
      }
    }).catch(() => {});
  }, []);

  const loadRuns = useCallback(() => {
    fetch('/api/distribution/runs').then(r => r.json()).then(d => setRuns(d.runs || [])).catch(() => {});
  }, []);

  const loadStats = useCallback(() => {
    fetch('/api/distribution/stats').then(r => r.json()).then(d => setStats(d)).catch(() => {});
  }, []);

  const loadCalendar = useCallback(() => {
    fetch('/api/distribution/calendar').then(r => r.json()).then(d => setCalendar(d.scheduled || [])).catch(() => {});
  }, []);

  useEffect(() => { loadPlatforms(); loadRuns(); loadStats(); loadCalendar(); }, [loadPlatforms, loadRuns, loadStats, loadCalendar]);
  useEffect(() => {
    if (wsEvent?.type === 'distribution' || wsEvent?.type === 'event') { loadRuns(); loadStats(); }
  }, [wsEvent, loadRuns, loadStats]);

  const publish = async () => {
    if (!content.trim() || !selectedPlatforms.length || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/distribution/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim(), platforms: selectedPlatforms }),
      });
      setResult(await res.json());
      setContent('');
      loadRuns();
      loadStats();
    } catch (e) { setResult({ error: e.message }); }
    finally { setRunning(false); }
  };

  const optimize = async (platformId) => {
    if (!content.trim() || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/distribution/optimize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim(), platform: platformId }),
      });
      setResult(await res.json());
    } catch (e) { setResult({ error: e.message }); }
    finally { setRunning(false); }
  };

  const schedule = async () => {
    if (!schedTopic.trim() || !schedTime || running) return;
    setRunning(true);
    try {
      await fetch('/api/distribution/calendar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: schedTopic.trim(), platform: schedPlatform, scheduledAt: new Date(schedTime).getTime() }),
      });
      setSchedTopic('');
      setSchedTime('');
      loadCalendar();
    } catch (e) { setResult({ error: e.message }); }
    finally { setRunning(false); }
  };

  const cancelScheduled = async (id) => {
    await fetch(`/api/distribution/calendar/${id}`, { method: 'DELETE' }).catch(() => {});
    loadCalendar();
  };

  const togglePlatform = (id) => {
    setSelectedPlatforms(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  const TABS = [
    { id: 'publish', label: 'Publish' },
    { id: 'calendar', label: 'Calendar' },
    { id: 'runs', label: 'Run History' },
  ];

  const s = {
    container: { padding: 20, height: '100%', overflowY: 'auto', color: '#e0e0e8' },
    tabs: { display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #222' },
    tab: (active) => ({
      padding: '8px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: 'transparent',
      border: 'none', borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
      color: active ? '#3b82f6' : '#888', transition: 'all 0.2s',
    }),
    card: { background: '#111118', borderRadius: 10, padding: 16, border: '1px solid #222', marginBottom: 12 },
    input: { width: '100%', padding: '10px 14px', background: '#0a0a12', border: '1px solid #333', borderRadius: 8, color: '#e0e0e8', fontSize: 13, outline: 'none', boxSizing: 'border-box' },
    btn: (color, disabled) => ({
      padding: '10px 20px', background: disabled ? '#333' : color, border: 'none', borderRadius: 8,
      color: '#fff', fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    }),
    badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '20', color }),
    stat: { textAlign: 'center', padding: 12 },
    statVal: { fontSize: 22, fontWeight: 700, color: '#3b82f6' },
    statLabel: { fontSize: 10, color: '#666', marginTop: 2 },
    platformChip: (selected) => ({
      padding: '6px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer',
      background: selected ? '#3b82f6' : '#1a1a2e', color: selected ? '#fff' : '#888',
      border: `1px solid ${selected ? '#3b82f6' : '#333'}`, transition: 'all 0.2s',
    }),
  };

  return (
    <div style={s.container}>
      <div style={s.tabs}>
        {TABS.map(t => <button key={t.id} onClick={() => setTab(t.id)} style={s.tab(tab === t.id)}>{t.label}</button>)}
      </div>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
          <div style={s.stat}><div style={s.statVal}>{stats.total || 0}</div><div style={s.statLabel}>Total Runs</div></div>
          <div style={s.stat}><div style={{ ...s.statVal, color: '#22c55e' }}>{stats.published || 0}</div><div style={s.statLabel}>Published</div></div>
          <div style={s.stat}><div style={{ ...s.statVal, color: '#f59e0b' }}>{stats.platforms || 0}</div><div style={s.statLabel}>Platforms</div></div>
          <div style={s.stat}><div style={{ ...s.statVal, color: '#ec4899' }}>{calendar.length}</div><div style={s.statLabel}>Scheduled</div></div>
        </div>
      )}

      {tab === 'publish' && (
        <div>
          <div style={s.card}>
            <label style={{ fontSize: 11, color: '#888', marginBottom: 6, display: 'block' }}>Content / Topic</label>
            <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Enter content to distribute..."
              style={{ ...s.input, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }} />

            <label style={{ fontSize: 11, color: '#888', margin: '14px 0 8px', display: 'block' }}>Target Platforms</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {platforms.map(p => (
                <button key={p.id} onClick={() => togglePlatform(p.id)} style={s.platformChip(selectedPlatforms.includes(p.id))}>
                  {p.name}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={publish} disabled={!content.trim() || !selectedPlatforms.length || running} style={s.btn('#3b82f6', !content.trim() || !selectedPlatforms.length || running)}>
                {running ? 'Publishing...' : 'Publish to All'}
              </button>
              {selectedPlatforms.map(pid => (
                <button key={pid} onClick={() => optimize(pid)} disabled={!content.trim() || running} style={s.btn('#6366f1', !content.trim() || running)}>
                  Optimize for {pid}
                </button>
              ))}
            </div>
          </div>

          {result && (
            <div style={{ ...s.card, border: result.error ? '1px solid #ef4444' : '1px solid #22c55e' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: result.error ? '#ef4444' : '#22c55e', marginBottom: 8 }}>
                {result.error ? 'Error' : 'Result'}
              </div>
              <pre style={{ fontSize: 11, color: '#ccc', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 300, overflow: 'auto' }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {tab === 'calendar' && (
        <div>
          <div style={s.card}>
            <label style={{ fontSize: 11, color: '#888', marginBottom: 6, display: 'block' }}>Schedule Content</label>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <input value={schedTopic} onChange={e => setSchedTopic(e.target.value)} placeholder="Topic..."
                style={{ ...s.input, flex: '1 1 200px' }} />
              <select value={schedPlatform} onChange={e => setSchedPlatform(e.target.value)}
                style={{ ...s.input, flex: '0 0 140px' }}>
                {platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input type="datetime-local" value={schedTime} onChange={e => setSchedTime(e.target.value)}
                style={{ ...s.input, flex: '0 0 200px' }} />
            </div>
            <button onClick={schedule} disabled={!schedTopic.trim() || !schedTime || running}
              style={s.btn('#8b5cf6', !schedTopic.trim() || !schedTime || running)}>
              Schedule
            </button>
          </div>

          {calendar.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>No scheduled content</div>}
          {calendar.map(item => (
            <div key={item.id} style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item.topic}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {item.platform} — {new Date(item.scheduled_at).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={s.badge(item.status === 'pending' ? '#f59e0b' : '#22c55e')}>{item.status}</span>
                  {item.status === 'pending' && (
                    <button onClick={() => cancelScheduled(item.id)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}>✕</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'runs' && (
        <div>
          {runs.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>No distribution runs yet</div>}
          {runs.map(run => (
            <div key={run.id} style={s.card}>
              <div onClick={() => setExpanded(expanded === run.id ? null : run.id)} style={{ cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{run.platform || 'multi'}</span>
                    <span style={{ fontSize: 11, color: '#888', marginLeft: 10 }}>{run.content_topic || ''}</span>
                  </div>
                  <span style={s.badge(run.status === 'published' ? '#22c55e' : run.status === 'failed' ? '#ef4444' : '#f59e0b')}>
                    {run.status}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                  {run.created_at ? new Date(run.created_at).toLocaleString() : ''}
                </div>
              </div>
              {expanded === run.id && (
                <pre style={{ fontSize: 10, color: '#999', marginTop: 10, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                  {JSON.stringify(run, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
