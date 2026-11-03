import { useState, useEffect, useCallback } from 'react';

export default function AudiencePanel({ wsEvent }) {
  const [segments, setSegments] = useState([]);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('segments');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [persona, setPersona] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [predictTopic, setPredictTopic] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const [segRes, statRes] = await Promise.all([
        fetch('/api/audience/segments'),
        fetch('/api/audience/stats'),
      ]);
      const segData = await segRes.json();
      setSegments(segData.segments || []);
      setStats(await statRes.json());
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'segment_created' || wsEvent?.type === 'segments_discovered' || wsEvent?.type === 'persona_generated') load();
  }, [wsEvent, load]);

  const discover = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/api/audience/discover', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      await load();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const loadDetail = async (id) => {
    try {
      const res = await fetch(`/api/audience/segments/${id}`);
      const data = await res.json();
      setSelected(data);
      setPersona(null);
      setPrediction(null);
    } catch (e) { setError(e.message); }
  };

  const generatePersona = async (id) => {
    try {
      setLoading(true);
      const res = await fetch(`/api/audience/segments/${id}/persona`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      setPersona(await res.json());
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const predict = async (id) => {
    if (!predictTopic.trim()) return;
    try {
      setLoading(true);
      const res = await fetch(`/api/audience/segments/${id}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentTopic: predictTopic }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      setPrediction(await res.json());
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const st = { panel: { color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', padding: '1rem', height: '100%', overflowY: 'auto', background: '#0a0a1a' },
    tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
    tab: (a) => ({ padding: '0.4rem 0.9rem', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, background: a ? '#7c3aed' : '#1e1e3a', color: a ? '#fff' : '#a0a0c0' }),
    card: { background: '#12122a', borderRadius: '8px', padding: '0.8rem', marginBottom: '0.6rem', border: '1px solid #2a2a4a' },
    stat: { background: '#12122a', borderRadius: '8px', padding: '0.6rem 0.8rem', flex: 1, textAlign: 'center', border: '1px solid #2a2a4a' },
    statNum: { fontSize: '1.4rem', fontWeight: 700, color: '#a78bfa' },
    statLabel: { fontSize: '0.7rem', color: '#888', textTransform: 'uppercase' },
    btn: (c = '#7c3aed') => ({ padding: '0.4rem 0.9rem', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, background: c, color: '#fff' }),
    badge: (c) => ({ display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600, background: c + '22', color: c }),
    meter: (pct, c) => ({ height: '6px', borderRadius: '3px', background: '#1e1e3a', overflow: 'hidden', marginTop: '0.3rem', position: 'relative' }),
    meterFill: (pct, c) => ({ height: '100%', width: `${Math.min(100, pct)}%`, background: c, borderRadius: '3px' }),
    input: { padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid #2a2a4a', background: '#1e1e3a', color: '#e2e8f0', fontSize: '0.85rem', flex: 1 },
    h3: { margin: '0 0 0.3rem', fontSize: '1rem', fontWeight: 700 },
    sub: { color: '#888', fontSize: '0.75rem' },
    error: { color: '#f87171', fontSize: '0.8rem', marginBottom: '0.5rem' },
    back: { background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: '0.85rem', marginBottom: '0.5rem', padding: 0 },
  };

  const statusColor = (s) => s === 'active' ? '#22c55e' : '#94a3b8';

  if (selected) {
    const seg = selected.segment;
    let formats = [], platforms = [];
    try { formats = JSON.parse(seg.preferred_formats || '[]'); } catch {}
    try { platforms = JSON.parse(seg.preferred_platforms || '[]'); } catch {}
    return (
      <div style={st.panel}>
        <button style={st.back} onClick={() => setSelected(null)}>← Back to segments</button>
        <div style={st.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={st.h3}>{seg.name}</h3>
            <span style={st.badge(statusColor(seg.status))}>{seg.status}</span>
          </div>
          <p style={{ ...st.sub, margin: '0.3rem 0' }}>{seg.description}</p>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <div><span style={st.sub}>Size: </span><strong>{seg.size_estimate || '—'}</strong></div>
            <div><span style={st.sub}>Engagement: </span><strong>{((seg.engagement_avg || 0) * 100).toFixed(1)}%</strong></div>
            <div><span style={st.sub}>Revenue: </span><strong>${(seg.revenue_avg || 0).toFixed(2)}</strong></div>
          </div>
          {formats.length > 0 && <div style={{ marginTop: '0.4rem' }}><span style={st.sub}>Formats: </span>{formats.map(f => <span key={f} style={{ ...st.badge('#6366f1'), marginRight: '0.3rem' }}>{f}</span>)}</div>}
          {platforms.length > 0 && <div style={{ marginTop: '0.3rem' }}><span style={st.sub}>Platforms: </span>{platforms.map(p => <span key={p} style={{ ...st.badge('#f59e0b'), marginRight: '0.3rem' }}>{p}</span>)}</div>}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <button style={st.btn('#7c3aed')} onClick={() => generatePersona(seg.id)} disabled={loading}>
            {loading ? 'Generating...' : 'Generate Persona'}
          </button>
        </div>

        {persona && (
          <div style={{ ...st.card, borderColor: '#7c3aed44' }}>
            <h3 style={{ ...st.h3, color: '#a78bfa' }}>Persona</h3>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem', color: '#c4b5fd', margin: 0, lineHeight: 1.5 }}>
              {typeof persona.persona === 'string' ? persona.persona : JSON.stringify(persona.persona, null, 2)}
            </pre>
          </div>
        )}

        <div style={{ ...st.card, borderColor: '#6366f144' }}>
          <h3 style={{ ...st.h3, color: '#818cf8' }}>Predict Engagement</h3>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
            <input style={st.input} value={predictTopic} onChange={e => setPredictTopic(e.target.value)} placeholder="Content topic..." />
            <button style={st.btn('#6366f1')} onClick={() => predict(seg.id)} disabled={loading || !predictTopic.trim()}>Predict</button>
          </div>
          {prediction && (
            <div style={{ marginTop: '0.6rem' }}>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <div><span style={st.sub}>Engagement: </span><strong style={{ color: '#22c55e' }}>{((prediction.predicted_engagement || 0) * 100).toFixed(1)}%</strong></div>
                <div><span style={st.sub}>Conversion: </span><strong style={{ color: '#f59e0b' }}>{((prediction.predicted_conversion || 0) * 100).toFixed(1)}%</strong></div>
                <div><span style={st.sub}>Confidence: </span><strong style={{ color: '#a78bfa' }}>{((prediction.confidence || 0) * 100).toFixed(0)}%</strong></div>
              </div>
              {prediction.optimization_tips && (
                <p style={{ ...st.sub, marginTop: '0.4rem' }}>{typeof prediction.optimization_tips === 'string' ? prediction.optimization_tips : JSON.stringify(prediction.optimization_tips)}</p>
              )}
            </div>
          )}
        </div>

        {selected.signals?.length > 0 && (
          <div style={st.card}>
            <h3 style={st.h3}>Recent Signals ({selected.signals.length})</h3>
            {selected.signals.slice(0, 10).map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', borderBottom: '1px solid #1e1e3a', fontSize: '0.8rem' }}>
                <span>{s.signal_type} — {s.platform || 'any'}</span>
                <span style={{ color: '#22c55e' }}>{((s.engagement_rate || 0) * 100).toFixed(1)}% eng</span>
              </div>
            ))}
          </div>
        )}

        {error && <p style={st.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={st.panel}>
      <div style={st.tabs}>
        {['segments', 'stats'].map(t => (
          <button key={t} style={st.tab(tab === t)} onClick={() => setTab(t)}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {error && <p style={st.error}>{error}</p>}

      {tab === 'segments' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
            <h3 style={st.h3}>Audience Segments ({segments.length})</h3>
            <button style={st.btn()} onClick={discover} disabled={loading}>
              {loading ? 'Discovering...' : 'Discover Segments'}
            </button>
          </div>
          {segments.length === 0 && !loading && <p style={st.sub}>No segments yet. Click "Discover Segments" to analyze your audience data.</p>}
          {segments.map(seg => (
            <div key={seg.id} style={st.card} onClick={() => loadDetail(seg.id)} role="button" tabIndex={0}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: '0.9rem' }}>{seg.name}</strong>
                <span style={st.badge(statusColor(seg.status))}>{seg.status}</span>
              </div>
              <p style={{ ...st.sub, margin: '0.2rem 0' }}>{seg.description?.slice(0, 120)}</p>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.3rem' }}>
                <div>
                  <span style={st.sub}>Engagement</span>
                  <div style={st.meter()}>
                    <div style={st.meterFill((seg.engagement_avg || 0) * 100, '#22c55e')} />
                  </div>
                </div>
                <div><span style={st.sub}>Size: </span><span style={{ fontSize: '0.8rem' }}>{seg.size_estimate || '—'}</span></div>
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'stats' && stats && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
            <div style={st.stat}><div style={st.statNum}>{stats.totalSegments || 0}</div><div style={st.statLabel}>Segments</div></div>
            <div style={st.stat}><div style={st.statNum}>{stats.totalSignals || 0}</div><div style={st.statLabel}>Signals</div></div>
            <div style={st.stat}><div style={st.statNum}>{stats.totalPredictions || 0}</div><div style={st.statLabel}>Predictions</div></div>
            <div style={st.stat}><div style={st.statNum}>{stats.avgAccuracy ? (stats.avgAccuracy * 100).toFixed(0) + '%' : '—'}</div><div style={st.statLabel}>Avg Accuracy</div></div>
          </div>
          {stats.topSegments?.length > 0 && (
            <div style={st.card}>
              <h3 style={st.h3}>Top Segments</h3>
              {stats.topSegments.map((s, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', borderBottom: '1px solid #1e1e3a', fontSize: '0.8rem' }}>
                  <span>{s.name}</span>
                  <span style={{ color: '#22c55e' }}>{((s.engagement_avg || 0) * 100).toFixed(1)}% eng</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
