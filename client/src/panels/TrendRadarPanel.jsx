import { useState, useEffect, useCallback } from 'react';

export default function TrendRadarPanel({ wsEvent }) {
  const [trends, setTrends] = useState([]);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('active');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [assessment, setAssessment] = useState(null);
  const [filter, setFilter] = useState({ status: '', category: '' });

  const load = useCallback(async () => {
    try {
      setError('');
      const params = new URLSearchParams();
      if (filter.status) params.set('status', filter.status);
      if (filter.category) params.set('category', filter.category);
      const [tRes, sRes] = await Promise.all([
        fetch(`/api/trends?${params}`),
        fetch('/api/trends/stats'),
      ]);
      const tData = await tRes.json();
      setTrends(tData.trends || []);
      setStats(await sRes.json());
    } catch (e) { setError(e.message); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'scan_complete' || wsEvent?.type === 'trend_dismissed') load();
  }, [wsEvent, load]);

  const scanTrends = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/api/trends/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await load();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const assessTrend = async (id) => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch(`/api/trends/${id}/assess`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAssessment(data);
      setTab('assessment');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const dismissTrend = async (id) => {
    try {
      await fetch(`/api/trends/${id}/dismiss`, { method: 'POST' });
      await load();
    } catch (e) { setError(e.message); }
  };

  const statuses = ['emerging', 'trending', 'peaked', 'faded'];
  const categories = ['tech', 'culture', 'platform', 'format', 'audience', 'commerce'];
  const s = { panel: { padding: '1rem', fontFamily: 'system-ui, sans-serif', color: '#e0e0e0' },
    tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
    tab: (a) => ({ padding: '0.4rem 0.8rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
      background: a ? '#f59e0b' : '#1e1e2e', color: a ? '#000' : '#aaa', fontSize: '0.85rem' }),
    card: { background: '#1a1a2e', borderRadius: '8px', padding: '0.8rem', marginBottom: '0.6rem', border: '1px solid #333' },
    btn: { padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: '#f59e0b', color: '#000', fontSize: '0.85rem', fontWeight: 600 },
    btnSmall: { padding: '0.3rem 0.6rem', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '0.75rem' },
    stat: (c) => ({ display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: '4px', background: c || '#333', fontSize: '0.75rem', marginRight: '0.4rem' }),
    label: { fontSize: '0.75rem', color: '#888', marginBottom: '0.25rem', display: 'block' },
    select: { padding: '0.35rem', borderRadius: '4px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', fontSize: '0.8rem' },
    meter: (pct, c) => ({
      height: '6px', borderRadius: '3px', background: '#1e1e2e', overflow: 'hidden', flex: 1,
    }),
    meterFill: (pct, c) => ({ height: '100%', width: `${Math.min(100, pct)}%`, background: c, borderRadius: '3px', transition: 'width 0.3s' }),
  };

  const statusColor = (st) => ({ emerging: '#22c55e', trending: '#f59e0b', peaked: '#ef4444', faded: '#666', dismissed: '#444' })[st] || '#888';
  const catColor = (c) => ({ tech: '#3b82f6', culture: '#ec4899', platform: '#8b5cf6', format: '#06b6d4', audience: '#22c55e', commerce: '#f59e0b' })[c] || '#888';
  const verdictColor = (v) => ({ create: '#22c55e', monitor: '#f59e0b', skip: '#ef4444' })[v] || '#888';

  return (
    <div style={s.panel}>
      <h3 style={{ margin: '0 0 0.5rem' }}>Trend Radar</h3>
      {error && <div style={{ color: '#ef4444', marginBottom: '0.5rem', fontSize: '0.85rem' }}>{error}</div>}

      <div style={s.tabs}>
        {['active', 'stats', 'assessment'].map(t => (
          <button key={t} style={s.tab(tab === t)} onClick={() => setTab(t)}>
            {t === 'active' ? 'Signals' : t === 'stats' ? 'Stats' : 'Assessment'}
          </button>
        ))}
        <button style={{ ...s.btn, marginLeft: 'auto' }} onClick={scanTrends} disabled={loading}>
          {loading ? 'Scanning...' : 'Scan Trends'}
        </button>
      </div>

      {tab === 'active' && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
            <select style={s.select} value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
              <option value="">All Statuses</option>
              {statuses.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
            <select style={s.select} value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}>
              <option value="">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {trends.length === 0 && <div style={{ color: '#888', padding: '2rem', textAlign: 'center' }}>No trends tracked yet. Hit "Scan Trends" to start.</div>}
          {trends.map(t => {
            let keywords = [];
            try { keywords = JSON.parse(t.keywords || '[]'); } catch {}
            return (
              <div key={t.id} style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.3rem' }}>
                  <strong style={{ fontSize: '0.95rem' }}>{t.topic}</strong>
                  <span style={s.stat(statusColor(t.status))}>{t.status}</span>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                  <span style={s.stat(catColor(t.category))}>{t.category}</span>
                  {keywords.slice(0, 4).map((kw, i) => <span key={i} style={{ fontSize: '0.7rem', color: '#888' }}>#{kw}</span>)}
                </div>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                  <div style={{ flex: 1 }}>
                    <span style={s.label}>Relevance</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <div style={s.meter()}>
                        <div style={s.meterFill((t.relevance_score || 0) * 100, '#3b82f6')} />
                      </div>
                      <span>{((t.relevance_score || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <span style={s.label}>Velocity</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <div style={s.meter()}>
                        <div style={s.meterFill((t.velocity || 0) * 100, '#f59e0b')} />
                      </div>
                      <span>{((t.velocity || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button style={{ ...s.btnSmall, background: '#3b82f6', color: '#fff' }} onClick={() => assessTrend(t.id)}>Assess</button>
                  <button style={{ ...s.btnSmall, background: '#333', color: '#aaa' }} onClick={() => dismissTrend(t.id)}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'stats' && stats && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '0.5rem', marginBottom: '1rem' }}>
            {[
              { label: 'Total', val: stats.total, c: '#6366f1' },
              { label: 'Emerging', val: stats.emerging, c: '#22c55e' },
              { label: 'Trending', val: stats.trending, c: '#f59e0b' },
              { label: 'Peaked', val: stats.peaked, c: '#ef4444' },
            ].map(({ label, val, c }) => (
              <div key={label} style={{ ...s.card, textAlign: 'center', borderTop: `3px solid ${c}` }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: c }}>{val}</div>
                <div style={{ fontSize: '0.75rem', color: '#888' }}>{label}</div>
              </div>
            ))}
          </div>

          {stats.byCategory?.length > 0 && (
            <div style={s.card}>
              <strong>By Category</strong>
              {stats.byCategory.map(bc => (
                <div key={bc.category} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0', fontSize: '0.85rem' }}>
                  <span style={s.stat(catColor(bc.category))}>{bc.category}</span>
                  <span>{bc.c} signals, avg relevance {((bc.avg_rel || 0) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}

          {stats.recentScans?.length > 0 && (
            <div style={s.card}>
              <strong>Recent Scans</strong>
              {stats.recentScans.map(sc => (
                <div key={sc.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '0.2rem 0', color: '#aaa' }}>
                  <span>{new Date(sc.created_at).toLocaleString()}</span>
                  <span>{sc.trends_found} found, {sc.new_trends} new ({sc.duration_ms}ms)</span>
                </div>
              ))}
            </div>
          )}

          {stats.topTrends?.length > 0 && (
            <div style={s.card}>
              <strong>Top Active Trends</strong>
              {stats.topTrends.map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0', fontSize: '0.85rem' }}>
                  <div>
                    <span style={s.stat(statusColor(t.status))}>{t.status}</span>
                    {t.topic}
                  </div>
                  <span style={{ color: '#888' }}>{((t.relevance_score || 0) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'assessment' && assessment && (
        <div>
          <div style={s.card}>
            <h4 style={{ margin: '0 0 0.3rem' }}>{assessment.trend?.topic}</h4>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <span style={s.stat(catColor(assessment.trend?.category))}>{assessment.trend?.category}</span>
              <span style={s.stat(statusColor(assessment.trend?.status))}>{assessment.trend?.status}</span>
            </div>
          </div>

          {assessment.assessment && (
            <div style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <strong>Content Assessment</strong>
                <span style={{ ...s.stat(verdictColor(assessment.assessment.verdict)), fontSize: '0.85rem', fontWeight: 700 }}>
                  {assessment.assessment.verdict?.toUpperCase()}
                </span>
              </div>
              {assessment.assessment.confidence && (
                <div style={{ fontSize: '0.85rem', marginBottom: '0.3rem' }}>
                  Confidence: <strong>{(assessment.assessment.confidence * 100).toFixed(0)}%</strong>
                </div>
              )}
              {assessment.assessment.timing && (
                <div style={{ fontSize: '0.85rem', marginBottom: '0.3rem' }}>
                  Timing: <strong>{assessment.assessment.timing}</strong>
                </div>
              )}
              {assessment.assessment.suggestedAngle && (
                <div style={{ fontSize: '0.85rem', marginBottom: '0.3rem' }}>
                  Angle: <em>{assessment.assessment.suggestedAngle}</em>
                </div>
              )}
              {assessment.assessment.suggestedFormats?.length > 0 && (
                <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                  {assessment.assessment.suggestedFormats.map((f, i) => <span key={i} style={s.stat('#1e3a5f')}>{f}</span>)}
                </div>
              )}
              {assessment.assessment.reasoning && (
                <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '0.3rem' }}>{assessment.assessment.reasoning}</div>
              )}
            </div>
          )}
        </div>
      )}
      {tab === 'assessment' && !assessment && <div style={{ color: '#888', padding: '2rem', textAlign: 'center' }}>Click "Assess" on a trend to evaluate it</div>}
    </div>
  );
}
