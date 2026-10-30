import React, { useState, useEffect, useCallback } from 'react';

const card = { background: '#12121a', border: '1px solid #222', borderRadius: 8, padding: 16, marginBottom: 12 };
const btn = { padding: '6px 14px', borderRadius: 6, border: '1px solid #333', background: '#1a1a2e', color: '#a78bfa', cursor: 'pointer', fontSize: 12 };
const btnPrimary = { ...btn, background: '#7c3aed', color: '#fff', border: '1px solid #7c3aed' };
const btnDanger = { ...btn, background: '#991b1b', color: '#fca5a5', border: '1px solid #7f1d1d' };
const input = { padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0d0d14', color: '#ccc', fontSize: 13, width: '100%', boxSizing: 'border-box' };
const label = { fontSize: 11, color: '#666', marginBottom: 4, display: 'block' };

const TIER_COLORS = { big: '#22c55e', mid: '#eab308', none: '#666', unknown: '#444' };
const TIER_LABELS = { big: 'BIG OUTLIER', mid: 'MID OUTLIER', none: 'Normal', unknown: '—' };
const SORT_OPTIONS = [
  { value: 'recent', label: 'Recent First' },
  { value: 'outlier', label: 'Outlier Ratio' },
  { value: 'views', label: 'Most Views' },
  { value: 'duration', label: 'Longest First' },
];

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function OutlierBadge({ tier, ratio }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700,
      background: TIER_COLORS[tier] + '22', color: TIER_COLORS[tier], border: `1px solid ${TIER_COLORS[tier]}44`,
    }}>
      {TIER_LABELS[tier] || tier}{ratio != null ? ` ${ratio}x` : ''}
    </span>
  );
}

function VideoCard({ video, onSave, onRemove, saved }) {
  const [notes, setNotes] = useState(video.notes || '');
  const [showNotes, setShowNotes] = useState(false);

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative' }}>
        {video.thumbnail && (
          <img src={video.thumbnail} alt="" style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }} />
        )}
        {video.duration > 0 && (
          <span style={{
            position: 'absolute', bottom: 4, right: 4, background: '#000c', color: '#fff',
            padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600,
          }}>
            {formatDuration(video.duration)}
          </span>
        )}
      </div>
      <div style={{ padding: '10px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <a
          href={`https://youtube.com/watch?v=${video.videoId || video.video_id}`}
          target="_blank" rel="noopener noreferrer"
          style={{ color: '#e0e0e8', fontSize: 13, fontWeight: 600, textDecoration: 'none', lineHeight: 1.3,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {video.title}
        </a>
        <div style={{ color: '#888', fontSize: 11 }}>{video.channelTitle || video.channel_title}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: '#aaa', fontSize: 11 }}>{formatCount(video.viewCount || video.view_count)} views</span>
          <span style={{ color: '#555', fontSize: 11 }}>·</span>
          <span style={{ color: '#aaa', fontSize: 11 }}>{formatCount(video.subscriberCount || video.subscriber_count)} subs</span>
        </div>
        <OutlierBadge tier={video.outlierTier || video.outlier_tier} ratio={video.outlierRatio || video.outlier_ratio} />
        {showNotes && (
          <textarea
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Add notes..."
            style={{ ...input, minHeight: 50, resize: 'vertical', marginTop: 4, fontSize: 11 }}
          />
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
          <button style={{ ...btn, fontSize: 11, padding: '4px 8px' }} onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? 'Hide' : 'Notes'}
          </button>
          {saved ? (
            <button style={{ ...btnDanger, fontSize: 11, padding: '4px 8px' }} onClick={() => onRemove?.(video)}>Remove</button>
          ) : (
            <button style={{ ...btnPrimary, fontSize: 11, padding: '4px 8px' }} onClick={() => onSave?.(video, notes)}>Save</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OutlierPanel() {
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [results, setResults] = useState([]);
  const [boardItems, setBoardItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [searching, setSearching] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [boardSearch, setBoardSearch] = useState('');
  const [boardSort, setBoardSort] = useState('recent');
  const [analyzed, setAnalyzed] = useState(null);

  const loadBoard = useCallback(() => {
    const params = new URLSearchParams({ sort: boardSort });
    if (tierFilter !== 'all') params.set('tier', tierFilter);
    if (boardSearch) params.set('search', boardSearch);
    fetch(`/api/youtube/board?${params}`).then(r => r.json()).then(d => setBoardItems(d.items || [])).catch(() => {});
    fetch('/api/youtube/board/stats').then(r => r.json()).then(setStats).catch(() => {});
  }, [tierFilter, boardSearch, boardSort]);

  useEffect(() => { loadBoard(); }, [loadBoard]);

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true); setError(''); setResults([]);
    try {
      const r = await fetch('/api/youtube/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), maxResults: 20 }),
      });
      const data = await r.json();
      if (data.error) { setError(data.error); return; }
      setResults(data.results || []);
    } catch (e) { setError(e.message); }
    finally { setSearching(false); }
  };

  const doAnalyzeUrl = async () => {
    if (!url.trim()) return;
    setAnalyzing(true); setError(''); setAnalyzed(null);
    try {
      const r = await fetch('/api/youtube/analyze-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await r.json();
      if (data.error) { setError(data.error); return; }
      setAnalyzed(data);
    } catch (e) { setError(e.message); }
    finally { setAnalyzing(false); }
  };

  const saveVideo = async (video, notes = '') => {
    try {
      setError('');
      await fetch('/api/youtube/board', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video, notes, searchQuery: query }),
      });
      loadBoard();
    } catch (e) { setError(`Save failed: ${e.message}`); }
  };

  const removeVideo = async (video) => {
    try {
      setError('');
      await fetch(`/api/youtube/board/${video.id}`, { method: 'DELETE' });
      loadBoard();
    } catch (e) { setError(`Remove failed: ${e.message}`); }
  };

  const boardIds = new Set(boardItems.map(i => i.video_id));

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h2 style={{ color: '#a78bfa', fontSize: 20, marginBottom: 4 }}>Outlier Board</h2>
      <p style={{ color: '#666', fontSize: 12, marginBottom: 16 }}>
        Find YouTube videos that outperform their channel's subscriber count — proven demand signals
      </p>

      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <div style={{ ...card, padding: '8px 14px', marginBottom: 0, flex: 1, textAlign: 'center' }}>
            <div style={{ color: '#a78bfa', fontSize: 20, fontWeight: 700 }}>{stats.total}</div>
            <div style={{ color: '#666', fontSize: 10 }}>Saved</div>
          </div>
          <div style={{ ...card, padding: '8px 14px', marginBottom: 0, flex: 1, textAlign: 'center' }}>
            <div style={{ color: '#22c55e', fontSize: 20, fontWeight: 700 }}>{stats.byTier?.big || 0}</div>
            <div style={{ color: '#666', fontSize: 10 }}>Big Outliers</div>
          </div>
          <div style={{ ...card, padding: '8px 14px', marginBottom: 0, flex: 1, textAlign: 'center' }}>
            <div style={{ color: '#eab308', fontSize: 20, fontWeight: 700 }}>{stats.byTier?.mid || 0}</div>
            <div style={{ color: '#666', fontSize: 10 }}>Mid Outliers</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[{ id: 'search', label: 'Search' }, { id: 'url', label: 'Analyze URL' }, { id: 'board', label: 'My Board' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            ...btn, background: tab === t.id ? '#7c3aed' : '#1a1a2e',
            color: tab === t.id ? '#fff' : '#a78bfa',
          }}>{t.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ ...card, background: '#1a0a0a', borderColor: '#7f1d1d', color: '#fca5a5', fontSize: 12, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Search tab */}
      {tab === 'search' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              placeholder="Search by topic, interest, or keyword..."
              style={{ ...input, flex: 1 }}
            />
            <button onClick={doSearch} disabled={searching} style={btnPrimary}>
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>
          {results.length > 0 && (
            <>
              <div style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
                {results.length} results · {results.filter(r => r.outlierTier === 'big').length} big outliers · {results.filter(r => r.outlierTier === 'mid').length} mid outliers
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                {results
                  .sort((a, b) => (b.outlierRatio || 0) - (a.outlierRatio || 0))
                  .map(v => (
                    <VideoCard
                      key={v.videoId}
                      video={v}
                      saved={boardIds.has(v.videoId)}
                      onSave={saveVideo}
                    />
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* URL analyze tab */}
      {tab === 'url' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={url} onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doAnalyzeUrl()}
              placeholder="Paste a YouTube URL..."
              style={{ ...input, flex: 1 }}
            />
            <button onClick={doAnalyzeUrl} disabled={analyzing} style={btnPrimary}>
              {analyzing ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>
          {analyzed && (
            <div style={{ maxWidth: 320 }}>
              <VideoCard video={analyzed} saved={boardIds.has(analyzed.videoId)} onSave={saveVideo} />
            </div>
          )}
        </div>
      )}

      {/* Board tab */}
      {tab === 'board' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              value={boardSearch} onChange={e => setBoardSearch(e.target.value)}
              placeholder="Search titles, channels, notes..."
              style={{ ...input, flex: 1, minWidth: 200 }}
            />
            <select value={boardSort} onChange={e => setBoardSort(e.target.value)}
              style={{ ...input, width: 'auto', flex: 'none' }}>
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {['all', 'big', 'mid', 'none'].map(t => (
              <button key={t} onClick={() => setTierFilter(t)} style={{
                ...btn, fontSize: 11, padding: '4px 10px',
                background: tierFilter === t ? (TIER_COLORS[t] || '#7c3aed') + '33' : '#1a1a2e',
                color: tierFilter === t ? (TIER_COLORS[t] || '#a78bfa') : '#888',
                borderColor: tierFilter === t ? (TIER_COLORS[t] || '#7c3aed') + '66' : '#333',
              }}>
                {t === 'all' ? 'All' : TIER_LABELS[t]}
              </button>
            ))}
          </div>
          {boardItems.length === 0 ? (
            <div style={{ color: '#555', fontSize: 13, textAlign: 'center', padding: 40 }}>
              No saved videos yet. Search for outliers and save the best ones here.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {boardItems.map(v => (
                <VideoCard key={v.id} video={{ ...v, videoId: v.video_id }} saved onRemove={removeVideo} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
