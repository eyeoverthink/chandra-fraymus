import React, { useState, useEffect, useCallback } from 'react';

const SOURCES = [
  { id: 'all', label: 'All', color: '#8b5cf6' },
  { id: 'youtube', label: 'YouTube', color: '#ef4444' },
  { id: 'web', label: 'Web', color: '#3b82f6' },
  { id: 'trends', label: 'Trends', color: '#f59e0b' },
  { id: 'browsing', label: 'Browsing', color: '#06b6d4' },
  { id: 'calendar', label: 'Calendar', color: '#10b981' },
];

const ACTIONS = ['commerce', 'creation', 'distribution', 'repurpose'];

const cardStyle = {
  background: '#12121f', border: '1px solid #222', borderRadius: 8,
  padding: 14, marginBottom: 10, transition: 'border-color 0.15s',
};

export default function ContentNexusPanel({ wsEvent }) {
  const [tab, setTab] = useState('feed');
  const [stats, setStats] = useState(null);
  const [feed, setFeed] = useState([]);
  const [recs, setRecs] = useState(null);
  const [source, setSource] = useState('all');
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch('/api/nexus/stats');
      setStats(await r.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (source !== 'all') params.set('source', source);
      const r = await fetch(`/api/nexus/feed?${params}`);
      const data = await r.json();
      setFeed(data.items || []);
    } catch (e) { setError(e.message); }
  }, [source]);

  const loadRecs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/nexus/recommendations?limit=5');
      setRecs(await r.json());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadStats(); loadFeed(); }, [loadStats, loadFeed]);

  useEffect(() => {
    if (wsEvent?.type === 'nexus' || wsEvent?.type === 'ingested') {
      loadStats(); loadFeed();
    }
  }, [wsEvent, loadStats, loadFeed]);

  const doIngest = async () => {
    setIngesting(true);
    try {
      const r = await fetch('/api/nexus/ingest', { method: 'POST' });
      const data = await r.json();
      setError('');
      loadStats(); loadFeed();
    } catch (e) { setError(e.message); }
    setIngesting(false);
  };

  const doAct = async (id, actionType) => {
    try {
      await fetch(`/api/nexus/act/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType }),
      });
      loadStats(); loadFeed();
    } catch (e) { setError(e.message); }
  };

  const sourceColor = (src) => SOURCES.find(s => s.id === src)?.color || '#666';

  return (
    <div style={{ padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#8b5cf6' }}>Content Nexus</h2>
        <span style={{ fontSize: 11, color: '#555' }}>unified feed + action surface</span>
      </div>

      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { label: 'Total', val: stats.total, color: '#8b5cf6' },
            { label: 'Pending', val: stats.pending, color: '#f59e0b' },
            { label: 'Acted', val: stats.acted, color: '#10b981' },
            { label: 'Avg Score', val: stats.avgScore, color: '#3b82f6' },
          ].map(s => (
            <div key={s.label} style={{ background: '#12121f', border: '1px solid #222', borderRadius: 8, padding: '8px 14px', minWidth: 80, textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.val}</div>
              <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid #222', paddingBottom: 8 }}>
        {['feed', 'recommendations', 'sources'].map(t => (
          <button key={t} onClick={() => { setTab(t); if (t === 'recommendations' && !recs) loadRecs(); }}
            style={{
              background: tab === t ? '#8b5cf618' : 'transparent', border: 'none',
              color: tab === t ? '#8b5cf6' : '#666', padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: tab === t ? 600 : 400,
              textTransform: 'capitalize',
            }}>
            {t}
          </button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={doIngest} disabled={ingesting}
            style={{
              background: ingesting ? '#333' : '#8b5cf6', border: 'none', borderRadius: 6,
              color: '#fff', padding: '6px 14px', cursor: ingesting ? 'wait' : 'pointer', fontSize: 12,
            }}>
            {ingesting ? 'Ingesting...' : 'Ingest All Sources'}
          </button>
        </div>
      </div>

      {error && <div style={{ background: '#2a1520', border: '1px solid #f87171', borderRadius: 6, padding: 10, marginBottom: 12, color: '#f87171', fontSize: 12 }}>{error}</div>}

      {/* Feed tab */}
      {tab === 'feed' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {SOURCES.map(s => (
              <button key={s.id} onClick={() => setSource(s.id)}
                style={{
                  background: source === s.id ? `${s.color}20` : 'transparent',
                  border: `1px solid ${source === s.id ? s.color : '#333'}`,
                  borderRadius: 20, padding: '4px 12px', color: source === s.id ? s.color : '#666',
                  cursor: 'pointer', fontSize: 12,
                }}>
                {s.label}
              </button>
            ))}
          </div>

          {feed.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#555' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
              <div>No items yet. Click "Ingest All Sources" to populate the feed.</div>
            </div>
          ) : (
            feed.map(item => (
              <div key={item.id} style={{ ...cardStyle, borderLeft: `3px solid ${sourceColor(item.source)}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, background: `${sourceColor(item.source)}30`, color: sourceColor(item.source), padding: '2px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>{item.source}</span>
                      <span style={{ fontSize: 10, color: '#555' }}>{item.item_type}</span>
                      <span style={{ fontSize: 10, color: '#f59e0b' }}>score: {item.relevance_score}</span>
                      {item.acted_on ? <span style={{ fontSize: 10, background: '#10b98120', color: '#10b981', padding: '2px 8px', borderRadius: 10 }}>acted: {item.action_type}</span> : null}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8', marginBottom: 4 }}>
                      {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: '#e0e0e8', textDecoration: 'none' }}>{item.title}</a> : item.title}
                    </div>
                    {item.description && <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>{item.description.slice(0, 200)}</div>}
                    {item.tags && <div style={{ fontSize: 10, color: '#555' }}>tags: {item.tags}</div>}
                  </div>
                  {item.thumbnail && <img src={item.thumbnail} alt="" style={{ width: 80, height: 50, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />}
                </div>
                {!item.acted_on && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {ACTIONS.map(a => (
                      <button key={a} onClick={() => doAct(item.id, a)}
                        style={{
                          background: '#1a1a2e', border: '1px solid #333', borderRadius: 4,
                          color: '#888', padding: '3px 10px', cursor: 'pointer', fontSize: 11,
                          textTransform: 'capitalize',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = '#8b5cf6'; e.currentTarget.style.color = '#8b5cf6'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#888'; }}>
                        {a}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Recommendations tab */}
      {tab === 'recommendations' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: '#888' }}>AI-powered action recommendations from your feed</span>
            <button onClick={loadRecs} disabled={loading}
              style={{ background: '#8b5cf6', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 14px', cursor: loading ? 'wait' : 'pointer', fontSize: 12 }}>
              {loading ? 'Analyzing...' : 'Refresh'}
            </button>
          </div>
          {loading && <div style={{ textAlign: 'center', padding: 30, color: '#8b5cf6' }}>Analyzing feed items with LLM...</div>}
          {recs && !loading && (
            recs.recommendations?.length > 0 ? (
              recs.recommendations.map((rec, i) => (
                <div key={i} style={{ ...cardStyle, borderLeft: '3px solid #8b5cf6' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8', marginBottom: 4 }}>{rec.title}</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, background: '#8b5cf620', color: '#8b5cf6', padding: '2px 8px', borderRadius: 10 }}>{rec.action}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>{rec.reason}</div>
                </div>
              ))
            ) : (
              <div style={{ textAlign: 'center', padding: 30, color: '#555' }}>
                {recs.error ? `Error: ${recs.error}` : 'No recommendations available. Ingest some content first.'}
              </div>
            )
          )}
        </div>
      )}

      {/* Sources tab */}
      {tab === 'sources' && stats && (
        <div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>Items by source in the Content Nexus</div>
          {stats.bySource?.map(s => {
            const pct = stats.total > 0 ? Math.round((s.c / stats.total) * 100) : 0;
            return (
              <div key={s.source} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 10, background: `${sourceColor(s.source)}30`, color: sourceColor(s.source), padding: '2px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase', minWidth: 70, textAlign: 'center' }}>{s.source}</span>
                <div style={{ flex: 1, height: 6, background: '#1a1a2e', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: sourceColor(s.source), borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: sourceColor(s.source), minWidth: 40, textAlign: 'right' }}>{s.c}</span>
                <span style={{ fontSize: 10, color: '#555', minWidth: 30 }}>{pct}%</span>
              </div>
            );
          })}

          <div style={{ fontSize: 13, color: '#888', marginTop: 20, marginBottom: 12 }}>By type</div>
          {stats.byType?.map(t => (
            <div key={t.item_type} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: '#e0e0e8', minWidth: 80, textTransform: 'capitalize' }}>{t.item_type}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#8b5cf6' }}>{t.c}</span>
            </div>
          ))}

          {stats.topTags?.length > 0 && (
            <>
              <div style={{ fontSize: 13, color: '#888', marginTop: 20, marginBottom: 12 }}>Top tags</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stats.topTags.map(t => (
                  <span key={t.tags} style={{ fontSize: 11, background: '#1a1a2e', border: '1px solid #333', borderRadius: 20, padding: '4px 10px', color: '#888' }}>
                    {t.tags} ({t.c})
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
