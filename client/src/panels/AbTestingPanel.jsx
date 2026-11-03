import { useState, useEffect, useCallback } from 'react';

export default function AbTestingPanel({ wsEvent }) {
  const [experiments, setExperiments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [results, setResults] = useState(null);
  const [tab, setTab] = useState('list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', hypothesis: '', dimension: 'topic', variantA: '', variantB: '' });

  const load = useCallback(async () => {
    try {
      setError('');
      const res = await fetch('/api/ab/experiments');
      const data = await res.json();
      setExperiments(data.experiments || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'experiment_created' || wsEvent?.type === 'experiment_concluded') load();
  }, [wsEvent, load]);

  const viewResults = async (id) => {
    try {
      setLoading(true);
      const res = await fetch(`/api/ab/experiments/${id}/results`);
      const data = await res.json();
      setResults(data);
      setSelected(id);
      setTab('results');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const concludeExperiment = async (id) => {
    try {
      setLoading(true);
      await fetch(`/api/ab/experiments/${id}/conclude`, { method: 'POST' });
      await load();
      await viewResults(id);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const createExperiment = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/api/ab/experiments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Create failed');
      setForm({ name: '', hypothesis: '', dimension: 'topic', variantA: '', variantB: '' });
      await load();
      setTab('list');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const autoGenerate = async () => {
    try {
      setLoading(true);
      setError('');
      const topic = prompt('Enter a content topic for auto-experiment:');
      if (!topic) return;
      const res = await fetch('/api/ab/experiments/auto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Auto-generate failed');
      await load();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const tabs = ['list', 'create', 'results'];
  const dims = ['topic', 'format', 'hook', 'thumbnail', 'timing'];
  const s = { panel: { padding: '1rem', fontFamily: 'system-ui, sans-serif', color: '#e0e0e0' },
    tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
    tab: (a) => ({ padding: '0.4rem 0.8rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
      background: a ? '#6366f1' : '#1e1e2e', color: a ? '#fff' : '#aaa', fontSize: '0.85rem' }),
    card: { background: '#1a1a2e', borderRadius: '8px', padding: '0.8rem', marginBottom: '0.6rem', border: '1px solid #333' },
    btn: { padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: '#6366f1', color: '#fff', fontSize: '0.85rem' },
    btnDanger: { padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: '#ef4444', color: '#fff', fontSize: '0.85rem' },
    input: { width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', marginBottom: '0.5rem', fontSize: '0.85rem' },
    select: { padding: '0.5rem', borderRadius: '6px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', marginBottom: '0.5rem', fontSize: '0.85rem' },
    stat: (c) => ({ display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: '4px', background: c || '#333', fontSize: '0.75rem', marginRight: '0.4rem' }),
    label: { fontSize: '0.75rem', color: '#888', marginBottom: '0.25rem', display: 'block' },
    bar: (pct, c) => ({ height: '8px', borderRadius: '4px', background: '#1e1e2e', overflow: 'hidden', marginBottom: '0.3rem',
      position: 'relative' }),
    barFill: (pct, c) => ({ height: '100%', width: `${Math.min(100, pct)}%`, background: c || '#6366f1', borderRadius: '4px', transition: 'width 0.3s' }),
  };

  const statusColor = (st) => st === 'running' ? '#22c55e' : st === 'concluded' ? '#6366f1' : '#888';

  return (
    <div style={s.panel}>
      <h3 style={{ margin: '0 0 0.5rem' }}>A/B Testing Engine</h3>
      {error && <div style={{ color: '#ef4444', marginBottom: '0.5rem', fontSize: '0.85rem' }}>{error}</div>}

      <div style={s.tabs}>
        {tabs.map(t => <button key={t} style={s.tab(tab === t)} onClick={() => setTab(t)}>{t === 'list' ? 'Experiments' : t === 'create' ? 'New' : 'Results'}</button>)}
        <button style={{ ...s.btn, marginLeft: 'auto', background: '#8b5cf6' }} onClick={autoGenerate} disabled={loading}>
          {loading ? '...' : 'AI Generate'}
        </button>
      </div>

      {tab === 'list' && (
        <div>
          {experiments.length === 0 && <div style={{ color: '#888', padding: '2rem', textAlign: 'center' }}>No experiments yet</div>}
          {experiments.map(exp => (
            <div key={exp.id} style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <strong style={{ fontSize: '0.95rem' }}>{exp.name}</strong>
                <span style={s.stat(statusColor(exp.status))}>{exp.status}</span>
              </div>
              {exp.hypothesis && <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: '0.3rem' }}>{exp.hypothesis}</div>}
              <div style={{ fontSize: '0.8rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                <span style={s.stat('#1e3a5f')}>{exp.dimension || 'general'}</span>
                <span style={{ color: '#aaa' }}>A: {(exp.variant_a || '').slice(0, 40)}</span>
                <span style={{ color: '#aaa' }}>B: {(exp.variant_b || '').slice(0, 40)}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button style={s.btn} onClick={() => viewResults(exp.id)}>Results</button>
                {exp.status === 'running' && <button style={s.btnDanger} onClick={() => concludeExperiment(exp.id)}>Conclude</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'create' && (
        <div style={s.card}>
          <span style={s.label}>Name</span>
          <input style={s.input} placeholder="Experiment name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <span style={s.label}>Hypothesis</span>
          <input style={s.input} placeholder="What you expect to learn" value={form.hypothesis} onChange={e => setForm(f => ({ ...f, hypothesis: e.target.value }))} />
          <span style={s.label}>Dimension</span>
          <select style={s.select} value={form.dimension} onChange={e => setForm(f => ({ ...f, dimension: e.target.value }))}>
            {dims.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <span style={s.label}>Variant A</span>
          <input style={s.input} placeholder="Control variant" value={form.variantA} onChange={e => setForm(f => ({ ...f, variantA: e.target.value }))} />
          <span style={s.label}>Variant B</span>
          <input style={s.input} placeholder="Test variant" value={form.variantB} onChange={e => setForm(f => ({ ...f, variantB: e.target.value }))} />
          <button style={s.btn} onClick={createExperiment} disabled={loading || !form.name || !form.variantA || !form.variantB}>
            {loading ? 'Creating...' : 'Create Experiment'}
          </button>
        </div>
      )}

      {tab === 'results' && results && (
        <div>
          <div style={s.card}>
            <h4 style={{ margin: '0 0 0.5rem' }}>{results.experiment?.name || 'Experiment'}</h4>
            <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: '0.5rem' }}>{results.experiment?.hypothesis}</div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
              <div>
                <span style={s.label}>Status</span>
                <span style={s.stat(statusColor(results.experiment?.status))}>{results.experiment?.status}</span>
              </div>
              {results.winner && <div>
                <span style={s.label}>Winner</span>
                <span style={s.stat('#22c55e')}>Variant {results.winner.toUpperCase()}</span>
              </div>}
              {results.significant !== undefined && <div>
                <span style={s.label}>Significant?</span>
                <span style={s.stat(results.significant ? '#22c55e' : '#f59e0b')}>{results.significant ? 'Yes (p < 0.05)' : 'Not yet'}</span>
              </div>}
            </div>
          </div>

          {results.stats && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
              {['a', 'b'].map(v => {
                const st = results.stats?.[v] || {};
                const convRate = st.impressions ? ((st.conversions / st.impressions) * 100).toFixed(1) : '0.0';
                return (
                  <div key={v} style={{ ...s.card, borderLeft: `3px solid ${v === 'a' ? '#3b82f6' : '#f59e0b'}` }}>
                    <strong style={{ fontSize: '0.9rem' }}>Variant {v.toUpperCase()}</strong>
                    <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '0.3rem' }}>
                      {results.experiment?.[`variant_${v}`]?.slice(0, 50)}
                    </div>
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                      <div>Impressions: <strong>{st.impressions || 0}</strong></div>
                      <div>Conversions: <strong>{st.conversions || 0}</strong></div>
                      <div>Rate: <strong>{convRate}%</strong></div>
                      <div style={s.bar()}>
                        <div style={s.barFill(parseFloat(convRate), v === 'a' ? '#3b82f6' : '#f59e0b')} />
                      </div>
                      <div>Revenue: <strong>${(st.revenue || 0).toFixed(2)}</strong></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {results.zScore !== undefined && (
            <div style={s.card}>
              <strong>Statistical Analysis</strong>
              <div style={{ fontSize: '0.85rem', marginTop: '0.3rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
                <div>Z-Score: <strong>{results.zScore?.toFixed(4)}</strong></div>
                <div>P-Value: <strong>{results.pValue?.toFixed(6)}</strong></div>
                <div>Confidence: <strong>{results.confidence ? (results.confidence * 100).toFixed(1) + '%' : 'N/A'}</strong></div>
                <div>Recommendation: <strong style={{ color: results.significant ? '#22c55e' : '#f59e0b' }}>{results.recommendation || 'Gather more data'}</strong></div>
              </div>
            </div>
          )}
        </div>
      )}
      {tab === 'results' && !results && <div style={{ color: '#888', padding: '2rem', textAlign: 'center' }}>Select an experiment to view results</div>}
    </div>
  );
}
