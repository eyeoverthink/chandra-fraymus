import React, { useState, useEffect, useCallback } from 'react';

const C = {
  bg: '#0a0a0f', card: '#111118', border: '#1e1e2a',
  text: '#e0e0e0', dim: '#666', accent: '#2563eb',
  green: '#10b981', red: '#ef4444', amber: '#f59e0b',
  purple: '#a78bfa', teal: '#14b8a6', cyan: '#06b6d4',
};

const TIER_COLORS = { light: C.teal, standard: C.accent, heavy: C.purple, premium: C.amber };

function StatCard({ label, value, color, suffix }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}{suffix && <span style={{ fontSize: 12, fontWeight: 400 }}>{suffix}</span>}</div>
      <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function BarChart({ items, maxVal, colorFn }) {
  if (!items || items.length === 0) return null;
  const max = maxVal || Math.max(...items.map(i => i.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 90, fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{item.label}</div>
          <div style={{ flex: 1, height: 16, background: '#0d0d15', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
            <div style={{ width: `${(item.value / max) * 100}%`, height: '100%', background: colorFn ? colorFn(item) : C.accent, borderRadius: 4, transition: 'width 0.3s' }} />
            <span style={{ position: 'absolute', right: 6, top: 1, fontSize: 10, color: C.dim }}>{item.value}</span>
          </div>
          {item.suffix && <span style={{ fontSize: 10, color: C.dim, width: 40 }}>{item.suffix}</span>}
        </div>
      ))}
    </div>
  );
}

export default function ModelRouterPanel({ wsEvent }) {
  const [stats, setStats] = useState(null);
  const [models, setModels] = useState([]);
  const [days, setDays] = useState(7);
  const [testPrompt, setTestPrompt] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/model-router/stats?days=${days}`);
      const data = await res.json();
      setStats(data);
    } catch (e) { setError(e.message); }
  }, [days]);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/model-router/models');
      const data = await res.json();
      setModels(data.models || []);
    } catch (e) { /* non-critical */ }
  }, []);

  useEffect(() => { loadStats(); loadModels(); }, [loadStats, loadModels]);
  useEffect(() => {
    if (wsEvent?.type === 'system.model_routing') loadStats();
  }, [wsEvent, loadStats]);

  const testRoute = async () => {
    if (!testPrompt.trim()) return;
    setTesting(true);
    setError('');
    try {
      const res = await fetch('/api/model-router/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: testPrompt.trim(), type: 'test' }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTestResult(data);
      loadStats();
    } catch (e) { setError(e.message); }
    setTesting(false);
  };

  const totalRouted = stats?.totalRouted || 0;
  const byModel = stats?.byModel || [];
  const byComplexity = stats?.byComplexity || [];

  const overallSuccess = byModel.length > 0
    ? Math.round(byModel.reduce((s, m) => s + m.successes, 0) / byModel.reduce((s, m) => s + m.total, 0) * 100)
    : 0;

  const avgDuration = byModel.length > 0
    ? Math.round(byModel.reduce((s, m) => s + (m.avgDuration || 0) * m.total, 0) / byModel.reduce((s, m) => s + m.total, 0))
    : 0;

  const DAY_OPTIONS = [1, 7, 14, 30];

  return (
    <div style={{ padding: '16px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: C.text, maxHeight: '100%', overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Adaptive Model Router</h2>
      <p style={{ fontSize: 11, color: C.dim, margin: '0 0 16px' }}>Intelligent model selection based on task complexity, cost, and historical performance</p>

      {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {DAY_OPTIONS.map(d => (
          <button key={d} onClick={() => setDays(d)} style={{
            background: days === d ? C.accent + '30' : 'transparent', border: `1px solid ${days === d ? C.accent : C.border}`,
            borderRadius: 4, padding: '3px 8px', fontSize: 10, color: days === d ? C.accent : C.dim, cursor: 'pointer',
          }}>{d}d</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <StatCard label="Total Routed" value={totalRouted} color={C.text} />
        <StatCard label="Success Rate" value={overallSuccess} color={overallSuccess > 80 ? C.green : overallSuccess > 50 ? C.amber : C.red} suffix="%" />
        <StatCard label="Avg Duration" value={avgDuration} color={C.cyan} suffix="ms" />
        <StatCard label="Models Known" value={models.length} color={C.purple} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.accent, marginBottom: 10 }}>Routing by Model</div>
          {byModel.length > 0 ? (
            <BarChart
              items={byModel.map(m => ({
                label: m.model?.split(':')[0] || m.model,
                value: m.total,
                suffix: `${Math.round((m.successes / m.total) * 100)}%`,
                tier: m.tier,
              }))}
              colorFn={item => TIER_COLORS[item.tier] || C.accent}
            />
          ) : (
            <div style={{ color: C.dim, fontSize: 11, textAlign: 'center', padding: 16 }}>No routing data</div>
          )}
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.purple, marginBottom: 10 }}>Routing by Complexity</div>
          {byComplexity.length > 0 ? (
            <BarChart
              items={byComplexity.map(c => ({
                label: c.complexity,
                value: c.total,
                suffix: `${Math.round((c.successes / c.total) * 100)}%`,
                complexity: c.complexity,
              }))}
              colorFn={item => {
                const m = { simple: C.teal, moderate: C.accent, complex: C.purple, expert: C.amber };
                return m[item.complexity] || C.accent;
              }}
            />
          ) : (
            <div style={{ color: C.dim, fontSize: 11, textAlign: 'center', padding: 16 }}>No complexity data</div>
          )}
        </div>
      </div>

      {models.length > 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.teal, marginBottom: 10 }}>Available Models</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {models.map((m, i) => (
              <div key={i} style={{
                background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 6,
                padding: '4px 10px', fontSize: 11, color: C.text, display: 'flex', gap: 6, alignItems: 'center',
              }}>
                <span>{m.name}</span>
                <span style={{ background: (TIER_COLORS[m.tier] || C.dim) + '20', color: TIER_COLORS[m.tier] || C.dim, padding: '0 4px', borderRadius: 3, fontSize: 9, fontWeight: 600 }}>{m.tier}</span>
                <span style={{ color: C.dim, fontSize: 9 }}>×{m.costFactor}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.amber, marginBottom: 8 }}>Test Model Selection</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={testPrompt} onChange={e => setTestPrompt(e.target.value)} placeholder="Enter a prompt to test routing..."
            style={{ flex: 1, background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', color: C.text, fontSize: 12, boxSizing: 'border-box' }}
            onKeyDown={e => e.key === 'Enter' && testRoute()} />
          <button onClick={testRoute} disabled={testing || !testPrompt.trim()} style={{
            background: testing ? C.dim : C.accent, color: '#fff', border: 'none', borderRadius: 6,
            padding: '6px 14px', fontSize: 11, cursor: testing ? 'default' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
          }}>{testing ? 'Routing...' : 'Test Route'}</button>
        </div>
        {testResult && (
          <div style={{ marginTop: 10, background: '#0d0d15', border: `1px solid ${C.accent}30`, borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12 }}>
                <span style={{ color: C.dim }}>Selected:</span>{' '}
                <span style={{ color: C.green, fontWeight: 600 }}>{testResult.model}</span>
              </div>
              <div style={{ fontSize: 12 }}>
                <span style={{ color: C.dim }}>Tier:</span>{' '}
                <span style={{ color: TIER_COLORS[testResult.tier] || C.dim, fontWeight: 600 }}>{testResult.tier}</span>
              </div>
              <div style={{ fontSize: 12 }}>
                <span style={{ color: C.dim }}>Complexity:</span>{' '}
                <span style={{ color: C.text }}>{testResult.complexity}</span>
              </div>
              <div style={{ fontSize: 12 }}>
                <span style={{ color: C.dim }}>Score:</span>{' '}
                <span style={{ color: C.amber }}>{testResult.score}</span>
              </div>
            </div>
            {testResult.candidates && testResult.candidates.length > 1 && (
              <div>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>Candidates considered:</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {testResult.candidates.map((c, i) => (
                    <span key={i} style={{ fontSize: 10, color: i === 0 ? C.green : C.dim, background: i === 0 ? C.green + '15' : '#0d0d15', padding: '1px 6px', borderRadius: 3, border: `1px solid ${i === 0 ? C.green + '30' : C.border}` }}>
                      {c.model} ({c.score})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
