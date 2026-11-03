import { useState, useEffect, useCallback } from 'react';

export default function LearningLoopPanel({ wsEvent }) {
  const [summary, setSummary] = useState(null);
  const [byTopic, setByTopic] = useState([]);
  const [byPlatform, setByPlatform] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const [sumRes, topicRes, platRes, decRes] = await Promise.all([
        fetch('/api/commerce/revenue/summary'),
        fetch('/api/commerce/revenue/by-topic'),
        fetch('/api/commerce/revenue/by-platform'),
        fetch('/api/commerce/learning/decisions'),
      ]);
      setSummary(await sumRes.json());
      const topicData = await topicRes.json();
      setByTopic(topicData.topics || []);
      const platData = await platRes.json();
      setByPlatform(platData.platforms || []);
      const decData = await decRes.json();
      setDecisions(decData.decisions || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'commerce' || wsEvent?.type === 'revenue_attribution') load();
  }, [wsEvent, load]);

  const generateDecisions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/commerce/learning/decisions', { method: 'POST' });
      const data = await res.json();
      if (data.decisions) setDecisions(prev => [...data.decisions, ...prev]);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const applyDecision = async (id) => {
    try {
      await fetch(`/api/commerce/learning/decisions/${id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'applied' }),
      });
      setDecisions(prev => prev.map(d => d.id === id ? { ...d, applied: 1 } : d));
    } catch (e) { setError(e.message); }
  };

  const pollShopify = async () => {
    setLoading(true);
    try {
      await fetch('/api/commerce/revenue/poll-shopify', { method: 'POST' });
      await load();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'topics', label: 'By Topic' },
    { key: 'platforms', label: 'By Platform' },
    { key: 'decisions', label: 'Decisions' },
  ];

  return (
    <div style={{ padding: 16, color: '#e2e8f0' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, color: '#10b981' }}>Commerce Learning Loop</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8' }}>Revenue attribution + strategic decisions</p>

      {error && <div style={{ background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13,
              background: tab === t.key ? '#10b981' : '#1e293b', color: tab === t.key ? '#000' : '#94a3b8' }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && summary && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
            <StatCard label="Total Revenue" value={`$${(summary.totalRevenue || 0).toFixed(2)}`} color="#10b981" />
            <StatCard label="Attributions" value={summary.totalAttributions || 0} color="#6366f1" />
            <StatCard label="Avg Confidence" value={`${((summary.avgConfidence || 0) * 100).toFixed(0)}%`} color="#f59e0b" />
            <StatCard label="Decisions" value={decisions.length} color="#8b5cf6" />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={pollShopify} disabled={loading}
              style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#10b981', color: '#000', fontSize: 13 }}>
              {loading ? 'Polling...' : 'Poll Shopify Orders'}
            </button>
            <button onClick={generateDecisions} disabled={loading}
              style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#6366f1', color: '#fff', fontSize: 13 }}>
              {loading ? 'Generating...' : 'Generate Decisions'}
            </button>
          </div>
        </div>
      )}

      {tab === 'topics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {byTopic.length === 0 && <p style={{ color: '#64748b', fontSize: 13 }}>No revenue attributed by topic yet</p>}
          {byTopic.map((t, i) => (
            <div key={i} style={{ background: '#1e293b', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t.topic || 'Unknown'}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{t.orders || 0} orders</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981' }}>${(t.revenue || 0).toFixed(2)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'platforms' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {byPlatform.length === 0 && <p style={{ color: '#64748b', fontSize: 13 }}>No revenue attributed by platform yet</p>}
          {byPlatform.map((p, i) => (
            <div key={i} style={{ background: '#1e293b', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.platform || 'Unknown'}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{p.orders || 0} orders — avg confidence {((p.avg_confidence || 0) * 100).toFixed(0)}%</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#3b82f6' }}>${(p.revenue || 0).toFixed(2)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'decisions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={generateDecisions} disabled={loading}
            style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#6366f1', color: '#fff', fontSize: 13 }}>
            {loading ? 'Generating...' : 'Generate New Decisions'}
          </button>
          {decisions.length === 0 && <p style={{ color: '#64748b', fontSize: 13 }}>No decisions generated yet</p>}
          {decisions.map((d, i) => (
            <div key={d.id || i} style={{ background: '#1e293b', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: d.decision_type === 'scale_up' ? '#065f46' : d.decision_type === 'pause' ? '#7f1d1d' : '#1e3a5f',
                  color: d.decision_type === 'scale_up' ? '#6ee7b7' : d.decision_type === 'pause' ? '#fca5a5' : '#93c5fd' }}>
                  {d.decision_type || 'recommendation'}
                </span>
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {((d.confidence || 0) * 100).toFixed(0)}% confidence
                </span>
              </div>
              <p style={{ margin: '0 0 8px', fontSize: 13 }}>{d.recommendation}</p>
              {!d.applied ? (
                <button onClick={() => applyDecision(d.id)}
                  style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #10b981', background: 'transparent', color: '#10b981', cursor: 'pointer', fontSize: 12 }}>
                  Apply
                </button>
              ) : (
                <span style={{ fontSize: 12, color: '#10b981' }}>Applied</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
