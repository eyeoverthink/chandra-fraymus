import React, { useState, useEffect, useCallback } from 'react';

export default function AnalyticsPanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [topPerformers, setTopPerformers] = useState([]);
  const [insights, setInsights] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [searchTopic, setSearchTopic] = useState('');
  const [topicResults, setTopicResults] = useState([]);
  const [expanded, setExpanded] = useState(null);

  const loadOverview = useCallback(() => {
    fetch('/api/analytics/overview').then(r => r.json()).then(d => setOverview(d)).catch(() => {});
  }, []);

  const loadTop = useCallback(() => {
    fetch('/api/analytics/top?limit=15').then(r => r.json()).then(d => setTopPerformers(d.top || [])).catch(() => {});
  }, []);

  const loadInsights = useCallback(() => {
    fetch('/api/analytics/insights?limit=20').then(r => r.json()).then(d => setInsights(d.insights || [])).catch(() => {});
  }, []);

  useEffect(() => { loadOverview(); loadTop(); loadInsights(); }, [loadOverview, loadTop, loadInsights]);
  useEffect(() => {
    if (wsEvent?.type === 'analytics') { loadOverview(); loadTop(); loadInsights(); }
  }, [wsEvent, loadOverview, loadTop, loadInsights]);

  const generateInsights = async () => {
    setGenerating(true);
    try {
      await fetch('/api/analytics/insights', { method: 'POST' });
      loadInsights();
    } catch {}
    finally { setGenerating(false); }
  };

  const searchByTopic = async () => {
    if (!searchTopic.trim()) return;
    try {
      const res = await fetch(`/api/analytics/topic/${encodeURIComponent(searchTopic.trim())}`);
      const d = await res.json();
      setTopicResults(d.analytics || []);
    } catch {}
  };

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'top', label: 'Top Performers' },
    { id: 'insights', label: 'AI Insights' },
    { id: 'search', label: 'By Topic' },
  ];

  const s = {
    container: { padding: 20, height: '100%', overflowY: 'auto', color: '#e0e0e8' },
    tabs: { display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #222' },
    tab: (active) => ({
      padding: '8px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: 'transparent',
      border: 'none', borderBottom: active ? '2px solid #10b981' : '2px solid transparent',
      color: active ? '#10b981' : '#888', transition: 'all 0.2s',
    }),
    card: { background: '#111118', borderRadius: 10, padding: 16, border: '1px solid #222', marginBottom: 12 },
    input: { width: '100%', padding: '10px 14px', background: '#0a0a12', border: '1px solid #333', borderRadius: 8, color: '#e0e0e8', fontSize: 13, outline: 'none', boxSizing: 'border-box' },
    btn: (color, disabled) => ({
      padding: '10px 20px', background: disabled ? '#333' : color, border: 'none', borderRadius: 8,
      color: '#fff', fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    }),
    badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '20', color }),
    stat: { textAlign: 'center', padding: 12 },
    statVal: { fontSize: 22, fontWeight: 700, color: '#10b981' },
    statLabel: { fontSize: 10, color: '#666', marginTop: 2 },
    bar: (pct, color) => ({ height: 6, borderRadius: 3, background: '#1a1a2e', overflow: 'hidden', marginTop: 4 }),
    barFill: (pct, color) => ({ height: '100%', width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 3 }),
  };

  return (
    <div style={s.container}>
      <div style={s.tabs}>
        {TABS.map(t => <button key={t.id} onClick={() => setTab(t.id)} style={s.tab(tab === t.id)}>{t.label}</button>)}
      </div>

      {tab === 'overview' && overview && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
            <div style={s.stat}><div style={s.statVal}>{overview.total || 0}</div><div style={s.statLabel}>Total Entries</div></div>
            <div style={s.stat}><div style={{ ...s.statVal, color: '#3b82f6' }}>{overview.byPlatform?.length || 0}</div><div style={s.statLabel}>Platforms</div></div>
            <div style={s.stat}><div style={{ ...s.statVal, color: '#f59e0b' }}>{overview.topTopics?.length || 0}</div><div style={s.statLabel}>Topics Tracked</div></div>
          </div>

          {overview.byPlatform?.length > 0 && (
            <div style={s.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: '#10b981' }}>By Platform</div>
              {overview.byPlatform.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1a1a2e' }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{p.platform}</span>
                    <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>{p.posts} posts</span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#3b82f6' }}>{(p.total_views || p.views || 0).toLocaleString()} views</span>
                    <span style={{ fontSize: 11, color: '#10b981' }}>{(p.avg_engagement || 0).toFixed(1)}% eng</span>
                    {p.revenue > 0 && <span style={{ fontSize: 11, color: '#f59e0b' }}>${p.revenue.toFixed(2)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {overview.topTopics?.length > 0 && (
            <div style={s.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: '#8b5cf6' }}>Top Topics</div>
              {overview.topTopics.slice(0, 8).map((t, i) => {
                const maxEng = Math.max(...overview.topTopics.map(x => x.avg_engagement || 0), 1);
                return (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span>{t.content_topic}</span>
                      <span style={{ color: '#10b981' }}>{(t.avg_engagement || 0).toFixed(1)}%</span>
                    </div>
                    <div style={s.bar()}>
                      <div style={s.barFill((t.avg_engagement / maxEng) * 100, '#8b5cf6')} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {overview.recentTrend?.length > 0 && (
            <div style={s.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: '#06b6d4' }}>14-Day Trend</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
                {overview.recentTrend.slice().reverse().map((d, i) => {
                  const maxViews = Math.max(...overview.recentTrend.map(x => x.views || 0), 1);
                  const h = Math.max(4, ((d.views || 0) / maxViews) * 70);
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: '100%', height: h, background: '#06b6d4', borderRadius: 2, minWidth: 4 }}
                        title={`${d.day}: ${d.views} views, ${d.posts} posts`} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!overview.total && <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>No analytics data yet — record metrics via the API or agent tools</div>}
        </div>
      )}

      {tab === 'top' && (
        <div>
          {topPerformers.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>No performance data yet</div>}
          {topPerformers.map((item, i) => (
            <div key={item.id || i} style={s.card} onClick={() => setExpanded(expanded === i ? null : i)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#10b981', marginRight: 8 }}>#{i + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{item.content_topic || 'Untitled'}</span>
                  <span style={s.badge('#3b82f6')}>{item.platform}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#10b981' }}>{(item.engagement_rate || 0).toFixed(1)}%</div>
                  <div style={{ fontSize: 10, color: '#888' }}>{(item.views || 0).toLocaleString()} views</div>
                </div>
              </div>
              {expanded === i && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  <div style={{ fontSize: 11, color: '#888' }}>Likes: <span style={{ color: '#e0e0e8' }}>{item.likes || 0}</span></div>
                  <div style={{ fontSize: 11, color: '#888' }}>Shares: <span style={{ color: '#e0e0e8' }}>{item.shares || 0}</span></div>
                  <div style={{ fontSize: 11, color: '#888' }}>Comments: <span style={{ color: '#e0e0e8' }}>{item.comments || 0}</span></div>
                  <div style={{ fontSize: 11, color: '#888' }}>CTR: <span style={{ color: '#e0e0e8' }}>{(item.click_through_rate || 0).toFixed(1)}%</span></div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'insights' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <button onClick={generateInsights} disabled={generating} style={s.btn('#10b981', generating)}>
              {generating ? 'Generating...' : 'Generate AI Insights'}
            </button>
          </div>
          {insights.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>No insights yet — generate them from accumulated analytics data</div>}
          {insights.map((ins, i) => (
            <div key={ins.id || i} style={{ ...s.card, borderLeft: `3px solid ${ins.insight_type === 'recommendation' ? '#3b82f6' : ins.insight_type === 'warning' ? '#f59e0b' : '#10b981'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={s.badge(ins.insight_type === 'recommendation' ? '#3b82f6' : ins.insight_type === 'warning' ? '#f59e0b' : '#10b981')}>
                  {ins.insight_type || 'pattern'}
                </span>
                <span style={{ fontSize: 10, color: '#555' }}>
                  {ins.confidence ? `${(ins.confidence * 100).toFixed(0)}% confidence` : ''}
                </span>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{ins.insight}</div>
              {(ins.topic || ins.platform) && (
                <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                  {ins.topic && <span>Topic: {ins.topic}</span>}
                  {ins.topic && ins.platform && <span> · </span>}
                  {ins.platform && <span>Platform: {ins.platform}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'search' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <input value={searchTopic} onChange={e => setSearchTopic(e.target.value)} placeholder="Search by topic..."
              style={{ ...s.input, flex: 1 }} onKeyDown={e => e.key === 'Enter' && searchByTopic()} />
            <button onClick={searchByTopic} style={s.btn('#8b5cf6', false)}>Search</button>
          </div>
          {topicResults.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>Search for a topic to see its analytics</div>}
          {topicResults.map((item, i) => (
            <div key={item.id || i} style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{item.content_topic || 'Untitled'}</span>
                  <span style={s.badge('#3b82f6')}>{item.platform}</span>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#10b981' }}>{(item.engagement_rate || 0).toFixed(1)}%</span>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: '#888' }}>
                <span>{(item.views || 0).toLocaleString()} views</span>
                <span>{item.likes || 0} likes</span>
                <span>{item.shares || 0} shares</span>
                <span>{new Date(item.collected_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
