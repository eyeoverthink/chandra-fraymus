import React, { useState, useEffect, useCallback } from 'react';

const PIPELINES = [
  { id: 'content', label: 'Content-to-Commerce', endpoint: '/api/commerce/pipeline', runsEndpoint: '/api/commerce/runs', color: '#6366f1',
    fields: [{ key: 'topic', label: 'Topic', required: true }, { key: 'contentType', label: 'Type', options: ['both', 'digital', 'physical'] }] },
  { id: 'apparel', label: 'Apparel Production', endpoint: '/api/apparel/pipeline', runsEndpoint: '/api/apparel/runs', color: '#ec4899',
    fields: [{ key: 'niche', label: 'Niche', required: true }, { key: 'season', label: 'Season' }, { key: 'productTypes', label: 'Product Types' }] },
  { id: 'shopper', label: 'Mystery Shopper', endpoint: '/api/shopper/audit', runsEndpoint: '/api/shopper/runs', color: '#f59e0b',
    fields: [{ key: 'storeUrl', label: 'Store URL' }, { key: 'autoApply', label: 'Auto-fix', type: 'toggle' }] },
  { id: 'fixer', label: 'Store Fixer', endpoint: '/api/fixer/pipeline', runsEndpoint: '/api/fixer/runs', color: '#10b981',
    fields: [{ key: 'auditReport', label: 'Audit Report (JSON)', multiline: true }] },
];

export default function CommercePanel({ wsEvent }) {
  const [activePipeline, setActivePipeline] = useState('content');
  const [runs, setRuns] = useState({});
  const [form, setForm] = useState({});
  const [running, setRunning] = useState(null);
  const [result, setResult] = useState(null);
  const [expandedRun, setExpandedRun] = useState(null);

  const loadRuns = useCallback(() => {
    for (const p of PIPELINES) {
      fetch(p.runsEndpoint).then(r => r.json()).then(d => {
        setRuns(prev => ({ ...prev, [p.id]: d.runs || [] }));
      }).catch(() => {});
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => {
    if (wsEvent?.type && ['commerce', 'event'].includes(wsEvent.type)) loadRuns();
  }, [wsEvent, loadRuns]);

  const pipeline = PIPELINES.find(p => p.id === activePipeline);
  const pipelineRuns = runs[activePipeline] || [];

  const launch = async () => {
    if (!pipeline || running) return;
    setRunning(pipeline.id);
    setResult(null);
    try {
      const body = { ...form };
      if (body.autoApply === true) body.autoApply = true;
      const res = await fetch(pipeline.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setResult(data);
      loadRuns();
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setRunning(null);
    }
  };

  const statusColor = s => s === 'done' ? '#22c55e' : s === 'error' ? '#ef4444' : s === 'running' ? '#f59e0b' : '#666';

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#6366f1', marginBottom: 8 }}>Commerce Pipelines</h2>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 20 }}>
        4 AI pipelines — Content-to-Commerce, Apparel Production, Mystery Shopper, Store Fixer — powered by Ollama + Shopify.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {PIPELINES.map(p => (
          <button key={p.id} onClick={() => { setActivePipeline(p.id); setResult(null); setForm({}); }}
            style={{
              flex: 1, padding: '12px 8px', border: 'none', borderRadius: 10, cursor: 'pointer',
              background: activePipeline === p.id ? `${p.color}20` : '#111118',
              color: activePipeline === p.id ? p.color : '#888',
              borderColor: activePipeline === p.id ? p.color + '40' : '#222',
              fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
            }}>
            {p.label}
          </button>
        ))}
      </div>

      {pipeline && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
          <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: `1px solid ${pipeline.color}30` }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: pipeline.color, marginBottom: 14 }}>
              Launch {pipeline.label}
            </h3>
            {pipeline.fields.map(f => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>
                  {f.label}{f.required ? ' *' : ''}
                </label>
                {f.type === 'toggle' ? (
                  <button onClick={() => setForm(prev => ({ ...prev, [f.key]: !prev[f.key] }))}
                    style={{
                      padding: '6px 14px', borderRadius: 6, border: '1px solid #333', cursor: 'pointer',
                      background: form[f.key] ? '#22c55e20' : '#1a1a2e', color: form[f.key] ? '#22c55e' : '#888',
                      fontSize: 12,
                    }}>
                    {form[f.key] ? 'ON' : 'OFF'}
                  </button>
                ) : f.options ? (
                  <select value={form[f.key] || f.options[0]}
                    onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #333', background: '#1a1a2e', color: '#e0e0e8', fontSize: 12 }}>
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.multiline ? (
                  <textarea value={form[f.key] || ''} onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    rows={4} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #333', background: '#1a1a2e', color: '#e0e0e8', fontSize: 12, resize: 'vertical' }} />
                ) : (
                  <input value={form[f.key] || ''} onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #333', background: '#1a1a2e', color: '#e0e0e8', fontSize: 12 }} />
                )}
              </div>
            ))}
            <button onClick={launch} disabled={!!running}
              style={{
                width: '100%', padding: '10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: running ? '#333' : pipeline.color, color: '#fff', fontSize: 13, fontWeight: 600,
                marginTop: 6, opacity: running ? 0.6 : 1,
              }}>
              {running === pipeline.id ? 'Running...' : `Launch ${pipeline.label}`}
            </button>
          </div>

          <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8', marginBottom: 12 }}>
              Run History ({pipelineRuns.length})
            </h3>
            {pipelineRuns.length === 0 && <div style={{ color: '#555', fontSize: 12 }}>No runs yet.</div>}
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {pipelineRuns.slice(0, 20).map((r, i) => (
                <div key={r.id || i} onClick={() => setExpandedRun(expandedRun === (r.id || i) ? null : (r.id || i))}
                  style={{
                    padding: '10px 12px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                    background: expandedRun === (r.id || i) ? '#1a1a2e' : '#0a0a14',
                    border: '1px solid #1a1a2e',
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#e0e0e8' }}>
                      {r.topic || r.niche || r.store_url || `Run #${i + 1}`}
                    </span>
                    <span style={{ fontSize: 10, color: statusColor(r.status), fontWeight: 600 }}>
                      {r.status || 'done'}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                    {new Date(r.created_at).toLocaleString()}
                    {r.score != null && ` · Score: ${r.score}/10`}
                    {r.grade && ` · Grade: ${r.grade}`}
                    {r.overall_score != null && ` · Overall: ${r.overall_score}`}
                  </div>
                  {expandedRun === (r.id || i) && (
                    <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
                      {r.issues && Array.isArray(r.issues) && r.issues.length > 0 && (
                        <div>Issues: {r.issues.join(', ')}</div>
                      )}
                      {r.scores && typeof r.scores === 'object' && (
                        <div>Scores: {Object.entries(r.scores).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>
                      )}
                      {r.stages && typeof r.stages === 'object' && (
                        <div>Stages: {Object.keys(r.stages).join(' → ')}</div>
                      )}
                      {r.content_type && <div>Type: {r.content_type}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {result && (
        <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: `1px solid ${result.error ? '#ef4444' : '#22c55e'}30` }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: result.error ? '#ef4444' : '#22c55e', marginBottom: 10 }}>
            {result.error ? 'Pipeline Error' : 'Pipeline Result'}
          </h3>
          <pre style={{ fontSize: 11, color: '#888', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
