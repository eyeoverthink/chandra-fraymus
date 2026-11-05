import React, { useState, useEffect, useCallback, useRef } from 'react';

const SOURCES = [
  { id: 'all', label: 'All', color: '#8b5cf6' },
  { id: 'agents', label: 'Agent insights', color: '#a78bfa' },
  { id: 'youtube', label: 'YouTube', color: '#ef4444' },
  { id: 'web', label: 'Web', color: '#3b82f6' },
  { id: 'trends', label: 'Trends', color: '#f59e0b' },
  { id: 'browsing', label: 'Browsing', color: '#06b6d4' },
  { id: 'calendar', label: 'Calendar', color: '#10b981' },
];

const ACTIONS = ['commerce', 'creation', 'distribution', 'repurpose'];
const SOURCE_SETUP = {
  agents: { panel: 'debate', title: 'Debate Protocol', action: 'Open agent discussions', help: 'Completed debates, reflections, and reviewed agent memories. Ideas retain their source records.' },
  youtube: { panel: 'outlier', title: 'Outlier Board', action: 'Find and save videos', help: 'Search YouTube and save useful videos to the Outlier Board.' },
  web: { panel: 'chat', title: 'Agent Chat', action: 'Ask an agent to research', help: 'Ask a research agent to search and retain web sources for your current work.' },
  trends: { panel: 'trend-radar', title: 'Trend Radar', action: 'Open Trend Radar', help: 'Scan for trends relevant to your work. Model-generated trends need external verification.' },
  browsing: { panel: 'cross-tab', title: 'Cross-Tab Intelligence', action: 'Set up browsing capture', help: 'Capture and classify pages through Cross-Tab Intelligence.' },
  calendar: { panel: 'calendar', title: 'Content Calendar', action: 'Open content calendar', help: 'Schedule content to include upcoming work in this feed.' },
};

async function nexusRequest(path, options = {}) {
  const response = await fetch(`/api/nexus/${path}`, { signal: AbortSignal.timeout(path.startsWith('recommendations') ? 190_000 : 15_000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  if (data.error) throw new Error(data.error);
  return data;
}

const cardStyle = {
  background: '#12121f', border: '1px solid #222', borderRadius: 8,
  padding: 14, marginBottom: 10, transition: 'border-color 0.15s',
};

export default function ContentNexusPanel({ wsEvent, onOpenPanel }) {
  const [tab, setTab] = useState('feed');
  const [stats, setStats] = useState(null);
  const [feed, setFeed] = useState([]);
  const [recs, setRecs] = useState(null);
  const [source, setSource] = useState('all');
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState('');
  const [sourceDetails, setSourceDetails] = useState([]);
  const [lastSync, setLastSync] = useState(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [focus, setFocus] = useState(() => localStorage.getItem('content-nexus-focus') || '');
  const syncBusy = useRef(false);
  const feedRequest = useRef(0);

  const loadStats = useCallback(async () => {
    try {
      const [statsData, sourcesData] = await Promise.all([nexusRequest('stats'), nexusRequest('sources')]);
      setStats(statsData);
      setSourceDetails(sourcesData.details || []);
    } catch (e) { setError(e.message); }
  }, []);

  const loadFeed = useCallback(async () => {
    const request = ++feedRequest.current;
    setFeedLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (source !== 'all') params.set('source', source);
      const data = await nexusRequest(`feed?${params}`);
      if (!Array.isArray(data.items)) throw new Error('The feed returned an invalid response');
      if (request === feedRequest.current) setFeed(data.items);
    } catch (e) { if (request === feedRequest.current) setError(e.message); }
    finally { if (request === feedRequest.current) setFeedLoading(false); }
  }, [source]);

  const loadRecs = useCallback(async () => {
    setLoading(true);
    try {
      setError('');
      setRecs(await nexusRequest(`recommendations?${new URLSearchParams({ limit: '5', focus })}`));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [focus]);

  useEffect(() => { loadStats(); loadFeed(); }, [loadStats, loadFeed]);

  useEffect(() => {
    if (wsEvent?.type === 'nexus' || wsEvent?.type === 'ingested') {
      loadStats(); loadFeed();
    }
  }, [wsEvent, loadStats, loadFeed]);

  const doIngest = useCallback(async (quiet = false) => {
    if (syncBusy.current) return;
    syncBusy.current = true;
    setIngesting(true);
    try {
      const data = await nexusRequest('ingest', { method: 'POST' });
      setLastSync(data);
      if (!quiet) setError('');
      if (data.total > 0) setRecs(null);
      await Promise.all([loadStats(), loadFeed()]);
    } catch (e) { setError(e.message); }
    finally { setIngesting(false); syncBusy.current = false; }
  }, [loadStats, loadFeed]);

  // Sync only existing local records; this never launches research or an LLM.
  useEffect(() => {
    doIngest(true);
    const timer = setInterval(() => doIngest(true), 30_000);
    return () => { clearInterval(timer); feedRequest.current++; };
  }, [doIngest]);

  const doAct = async (id, actionType) => {
    setActing(id);
    try {
      await nexusRequest(`act/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType }),
      });
      setError('');
      setRecs(null);
      await Promise.all([loadStats(), loadFeed()]);
    } catch (e) { setError(e.message); }
    finally { setActing(null); }
  };

  const sourceColor = (src) => SOURCES.find(s => s.id === src)?.color || '#666';

  return (
    <div style={{ padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#8b5cf6' }}>Content Nexus</h2>
        <span style={{ fontSize: 11, color: '#aaa' }}>agent insights + saved content · syncs every 30s while open</span>
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 16, borderBottom: '1px solid #222', paddingBottom: 8 }}>
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
          <button onClick={() => doIngest()} disabled={ingesting}
            style={{
              background: ingesting ? '#333' : '#8b5cf6', border: 'none', borderRadius: 6,
              color: '#fff', padding: '6px 14px', cursor: ingesting ? 'wait' : 'pointer', fontSize: 12,
            }}>
            {ingesting ? 'Syncing...' : 'Sync saved content'}
          </button>
        </div>
      </div>

      {error && <div role="alert" style={{ background: '#2a1520', border: '1px solid #f87171', borderRadius: 6, padding: 10, marginBottom: 12, color: '#f87171', fontSize: 12 }}>{error}</div>}
      {lastSync && <div role="status" style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
        {lastSync.total > 0 ? `Synced ${lastSync.total} new or updated items.` : 'No new saved items since the last sync.'}
        {lastSync.results?.some(result => ['unavailable', 'error', 'partial_failure'].includes(result.status)) && ' Some sources need attention—check Sources.'}
      </div>}

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

          {feedLoading && <div role="status" style={{ color: '#aaa', padding: 12 }}>Loading feed...</div>}
          {!feedLoading && !error && feed.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: '#aaa', border: '1px solid #292935', borderRadius: 8 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
              <div style={{ color: '#e0e0e8', fontWeight: 600, marginBottom: 8 }}>{source === 'all' ? 'Your feed is waiting for source content' : `No ${SOURCES.find(item => item.id === source)?.label} items synced yet`}</div>
              <div>Agent discussions and saved research appear here as they become available. Syncing does not search the web or create content.</div>
              <button onClick={() => setTab('sources')} style={{ marginTop: 16, background: '#8b5cf6', color: '#fff', border: 0, borderRadius: 6, padding: '8px 14px', cursor: 'pointer' }}>Check sources and get started</button>
            </div>
          ) : !feedLoading && (
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
                    {item.source === 'agents' && <div style={{ fontSize: 11, color: '#b9a7ef', marginTop: 6 }}>
                      Agent-generated · {item.metadata?.kind} · record {item.metadata?.recordId}
                      {item.metadata?.agents?.length > 0 && ` · ${item.metadata.agents.join(', ')}`}
                      {onOpenPanel && <button onClick={() => onOpenPanel(item.metadata?.kind === 'debate' ? 'debate' : item.metadata?.kind === 'memory' ? 'memory' : 'evolution')} style={{ marginLeft: 8, background: 'transparent', color: '#c4b5fd', border: '1px solid #4b4264', borderRadius: 4, cursor: 'pointer' }}>View source</button>}
                    </div>}
                  </div>
                  {item.thumbnail && <img src={item.thumbnail} alt="" style={{ width: 80, height: 50, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />}
                </div>
                {!item.acted_on && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#aaa' }}>Mark handled after:</span>
                    {ACTIONS.map(a => (
                      <button key={a} disabled={acting === item.id} onClick={() => doAct(item.id, a)}
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
            <span style={{ fontSize: 13, color: '#aaa' }}>Recommendations guided by recent agent discussions and your feed</span>
            <button onClick={loadRecs} disabled={loading}
              style={{ background: '#8b5cf6', border: 'none', borderRadius: 6, color: '#fff', padding: '6px 14px', cursor: loading ? 'wait' : 'pointer', fontSize: 12 }}>
              {loading ? 'Analyzing...' : 'Refresh'}
            </button>
          </div>
          <label style={{ display: 'block', color: '#bbb', fontSize: 12, marginBottom: 14 }}>
            Optional focus
            <input aria-label="Optional focus" value={focus} maxLength={500} onChange={event => { const value = event.target.value; setFocus(value); setRecs(null); localStorage.setItem('content-nexus-focus', value); }} placeholder="e.g. AI, local models, Fraynix development" style={{ display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 6, padding: 10, background: '#12121f', border: '1px solid #444', borderRadius: 6, color: '#eee' }} />
            <span style={{ display: 'block', marginTop: 5, color: '#999' }}>Leave blank to follow agents' evolving discussions. Your suggestions guide the ranking without fixing the topic list.</span>
          </label>
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
                {recs.error ? `Error: ${recs.error}` : recs.message || 'No recommendations available. Sync source content first.'}
              </div>
            )
          )}
        </div>
      )}

      {/* Sources tab */}
      {tab === 'sources' && stats && (
        <div>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 12 }}>Use existing agent intelligence or save content in a source. This feed syncs those records automatically while open.</div>
          {SOURCES.filter(item => item.id !== 'all').map(s => {
            const detail = sourceDetails.find(item => item.source === s.id);
            const setup = SOURCE_SETUP[s.id];
            const count = detail?.inFeed ?? stats.bySource?.find(item => item.source === s.id)?.c ?? 0;
            return (
              <div key={s.id} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <strong style={{ color: s.color }}>{s.label}</strong>
                  <span style={{ fontSize: 12, color: '#bbb' }}>{detail ? detail.available ? `${detail.saved} saved · ` : 'Not ready · ' : ''}{count} in feed</span>
                </div>
                <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>{setup.help}</div>
                {detail?.message && <div style={{ color: '#fbbf24', fontSize: 12, marginBottom: 10 }}>{detail.message}</div>}
                {onOpenPanel && <button onClick={() => onOpenPanel(setup.panel, setup.title)} style={{ background: '#242037', color: '#ddd', border: '1px solid #4b4264', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>{setup.action}</button>}
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
