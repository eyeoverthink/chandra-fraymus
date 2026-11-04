import { useState, useEffect, useCallback } from 'react';

export default function CrossTabPanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [visits, setVisits] = useState([]);
  const [insights, setInsights] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ingestUrl, setIngestUrl] = useState('');
  const [filter, setFilter] = useState({ category: '', domain: '' });

  const load = useCallback(async () => {
    try {
      setError('');
      const [sRes, vRes, iRes, cRes] = await Promise.all([
        fetch('/api/cross-tab/stats'),
        fetch(`/api/cross-tab/visits?limit=30${filter.category ? `&category=${filter.category}` : ''}${filter.domain ? `&domain=${filter.domain}` : ''}`),
        fetch('/api/cross-tab/insights?limit=10'),
        fetch('/api/cross-tab/clusters?limit=15'),
      ]);
      setStats(await sRes.json());
      const vData = await vRes.json();
      setVisits(vData.visits || []);
      const iData = await iRes.json();
      setInsights(iData.insights || []);
      const cData = await cRes.json();
      setClusters(cData.clusters || []);
    } catch (e) { setError(e.message); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'visit' || wsEvent?.type === 'ingested' || wsEvent?.type === 'insights_generated') load();
  }, [wsEvent, load]);

  const ingest = async () => {
    if (!ingestUrl.trim()) return;
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/api/cross-tab/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ingestUrl.trim(), source: 'manual' }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIngestUrl('');
      await load();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const generateInsights = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/api/cross-tab/insights/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 24 }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await load();
      setTab('insights');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const categories = ['tech', 'news', 'entertainment', 'shopping', 'social', 'research', 'finance', 'creative', 'education', 'other'];
  const catColors = { tech: '#06b6d4', news: '#f59e0b', entertainment: '#a78bfa', shopping: '#f87171', social: '#34d399', research: '#60a5fa', finance: '#10b981', creative: '#ec4899', education: '#8b5cf6', other: '#6b7280' };

  const s = {
    panel: { padding: '1rem', fontFamily: 'system-ui, sans-serif', color: '#e0e0e0' },
    tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' },
    tab: (a) => ({ padding: '0.4rem 0.8rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
      background: a ? '#06b6d4' : '#1e1e2e', color: a ? '#000' : '#aaa', fontSize: '0.85rem', fontWeight: a ? 600 : 400 }),
    card: { background: '#1a1a2e', borderRadius: '8px', padding: '0.8rem', marginBottom: '0.6rem', border: '1px solid #333' },
    btn: { padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: '#06b6d4', color: '#000', fontSize: '0.85rem', fontWeight: 600 },
    btnSmall: { padding: '0.3rem 0.6rem', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '0.75rem' },
    stat: (c) => ({ display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: '4px', background: c || '#333', fontSize: '0.75rem', marginRight: '0.4rem' }),
    input: { width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', fontSize: '0.85rem', boxSizing: 'border-box' },
    label: { fontSize: '0.75rem', color: '#888', marginBottom: '0.25rem', display: 'block' },
    select: { padding: '0.35rem', borderRadius: '4px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', fontSize: '0.8rem' },
    meter: (pct, c) => ({ height: 6, borderRadius: 3, background: '#222', overflow: 'hidden', marginTop: 4,
      position: 'relative', display: 'flex', children: { width: `${Math.min(100, pct)}%`, background: c || '#06b6d4', height: '100%', borderRadius: 3 } }),
  };

  const ago = ts => {
    const d = Date.now() - ts;
    if (d < 60_000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86400_000)}d ago`;
  };

  return (
    <div style={s.panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <span style={{ fontSize: 20 }}>🌐</span>
        <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#06b6d4' }}>Cross-Tab Intelligence</h2>
      </div>

      {error && <div style={{ ...s.card, borderColor: '#f87171', color: '#f87171', marginBottom: '0.8rem' }}>{error}</div>}

      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {[
            { label: 'Visits', value: stats.total, color: '#06b6d4' },
            { label: 'Classified', value: stats.classified, color: '#34d399' },
            { label: 'Today', value: stats.recentCount, color: '#f59e0b' },
            { label: 'Insights', value: stats.insightCount, color: '#a78bfa' },
            { label: 'Clusters', value: stats.clusterCount, color: '#60a5fa' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ ...s.card, flex: '1 1 80px', textAlign: 'center', minWidth: 80 }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: '0.7rem', color: '#888' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={s.tabs}>
        {['overview', 'visits', 'insights', 'clusters', 'ingest'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={s.tab(tab === t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === 'overview' && stats && (
        <div>
          <div style={s.card}>
            <div style={s.label}>Category Breakdown</div>
            {(stats.byCategory || []).map(({ category, count }) => (
              <div key={category} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: 4 }}>
                <span style={s.stat(catColors[category] || '#333')}>{category}</span>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: '#222', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, (count / (stats.total || 1)) * 100)}%`, background: catColors[category] || '#06b6d4', height: '100%', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: '0.75rem', color: '#aaa', minWidth: 24, textAlign: 'right' }}>{count}</span>
              </div>
            ))}
          </div>
          <div style={s.card}>
            <div style={s.label}>Top Domains</div>
            {(stats.byDomain || []).slice(0, 10).map(({ domain, count }) => (
              <div key={domain} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: '0.8rem' }}>
                <span style={{ color: '#06b6d4' }}>{domain}</span>
                <span style={{ color: '#888' }}>{count}</span>
              </div>
            ))}
          </div>
          <button onClick={generateInsights} disabled={loading} style={{ ...s.btn, width: '100%', marginTop: '0.5rem', opacity: loading ? 0.5 : 1 }}>
            {loading ? 'Analyzing...' : 'Generate Insights from Last 24h'}
          </button>
        </div>
      )}

      {/* Visits tab */}
      {tab === 'visits' && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
            <select value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))} style={s.select}>
              <option value="">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {visits.map(v => (
            <div key={v.id} style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={s.stat(catColors[v.category])}>{v.category}</span>
                <span style={{ fontSize: '0.7rem', color: '#666' }}>{ago(v.visited_at)}</span>
              </div>
              <div style={{ fontSize: '0.85rem', color: '#e0e0e0', marginTop: 4, fontWeight: 500 }}>{v.title || '(no title)'}</div>
              <div style={{ fontSize: '0.75rem', color: '#06b6d4', marginTop: 2, wordBreak: 'break-all' }}>{v.domain}</div>
              {v.summary && <div style={{ fontSize: '0.75rem', color: '#aaa', marginTop: 4 }}>{v.summary}</div>}
              {v.topics && v.topics !== '[]' && (
                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {JSON.parse(v.topics).map((t, i) => (
                    <span key={i} style={{ ...s.stat('#1e3a5f'), fontSize: '0.65rem' }}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {visits.length === 0 && <div style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>No visits recorded yet. Use the Ingest tab or Chrome extension to start.</div>}
        </div>
      )}

      {/* Insights tab */}
      {tab === 'insights' && (
        <div>
          <button onClick={generateInsights} disabled={loading} style={{ ...s.btn, marginBottom: '0.8rem', opacity: loading ? 0.5 : 1 }}>
            {loading ? 'Generating...' : 'Refresh Insights'}
          </button>
          {insights.map(ins => {
            let data = {};
            try { data = JSON.parse(ins.data); } catch (_) {}
            return (
              <div key={ins.id} style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#a78bfa' }}>
                    Insight #{ins.id.slice(0, 6)}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: '#666' }}>{ago(ins.created_at)} | {ins.visit_count} visits</span>
                </div>
                {(data.emerging_interests || []).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={s.label}>Emerging Interests</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {data.emerging_interests.map((int, i) => (
                        <span key={i} style={s.stat('#1e3a5f')}>{int}</span>
                      ))}
                    </div>
                  </div>
                )}
                {(data.suggestions || []).length > 0 && (
                  <div>
                    <div style={s.label}>Suggestions</div>
                    {data.suggestions.map((sug, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: '#ccc', padding: '4px 0', borderBottom: '1px solid #222' }}>
                        {sug}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {insights.length === 0 && <div style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>No insights generated yet. Click the button above to analyze recent browsing.</div>}
        </div>
      )}

      {/* Clusters tab */}
      {tab === 'clusters' && (
        <div>
          {clusters.map(cl => (
            <div key={cl.id} style={s.card}>
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#60a5fa', marginBottom: 4 }}>{cl.theme}</div>
              <div style={{ fontSize: '0.8rem', color: '#ccc', marginBottom: 4 }}>{cl.insight}</div>
              {cl.opportunity && <div style={{ fontSize: '0.75rem', color: '#34d399', marginBottom: 4 }}>Opportunity: {cl.opportunity}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#666' }}>
                <span>Strength: {(cl.strength * 100).toFixed(0)}%</span>
                <span>Last seen: {ago(cl.last_seen)}</span>
              </div>
            </div>
          ))}
          {clusters.length === 0 && <div style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>No topic clusters yet. Generate insights first.</div>}
        </div>
      )}

      {/* Ingest tab */}
      {tab === 'ingest' && (
        <div>
          <div style={s.card}>
            <div style={s.label}>Manual Page Ingest</div>
            <p style={{ fontSize: '0.8rem', color: '#aaa', margin: '0 0 0.8rem 0' }}>
              Paste a URL to record and classify it. The Chrome extension does this automatically for browsed pages.
            </p>
            <input
              value={ingestUrl}
              onChange={e => setIngestUrl(e.target.value)}
              placeholder="https://example.com/article"
              style={s.input}
              onKeyDown={e => e.key === 'Enter' && ingest()}
            />
            <button onClick={ingest} disabled={loading || !ingestUrl.trim()} style={{ ...s.btn, width: '100%', marginTop: '0.5rem', opacity: (loading || !ingestUrl.trim()) ? 0.5 : 1 }}>
              {loading ? 'Ingesting...' : 'Ingest & Classify'}
            </button>
          </div>
          <div style={s.card}>
            <div style={s.label}>Chrome Extension</div>
            <p style={{ fontSize: '0.8rem', color: '#aaa', margin: 0 }}>
              When connected, the Chrome extension automatically sends page visits to Cross-Tab Intelligence.
              Use <code style={{ color: '#06b6d4' }}>POST /api/cross-tab/visit</code> for lightweight recording or
              <code style={{ color: '#06b6d4' }}> POST /api/cross-tab/ingest</code> for recording + LLM classification.
            </p>
          </div>
          <div style={s.card}>
            <div style={s.label}>Perspective Context</div>
            <p style={{ fontSize: '0.8rem', color: '#aaa', margin: '0 0 0.5rem 0' }}>
              Cross-Tab context is automatically injected into Perspective framing when agents run.
              This helps agents understand what you've been browsing without you having to explain it.
            </p>
            <button onClick={async () => {
              try {
                const res = await fetch('/api/cross-tab/perspective-context');
                const data = await res.json();
                if (data.context) alert(data.context);
                else alert('No cross-tab context available yet (need classified visits in the last 6 hours)');
              } catch (e) { setError(e.message); }
            }} style={{ ...s.btnSmall, background: '#1e3a5f', color: '#06b6d4' }}>
              Preview Perspective Context
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
