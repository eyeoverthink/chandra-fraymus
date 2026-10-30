import React, { useState, useEffect, useCallback } from 'react';

const SOURCES = [
  { id: 'all', label: 'All' },
  { id: 'commerce', label: 'Commerce Runs' },
  { id: 'workflows', label: 'Workflow Runs' },
  { id: 'outlier', label: 'Outlier Saves' },
  { id: 'threads', label: 'Agent Threads' },
];

const SOURCE_COLORS = {
  commerce: '#ec4899', apparel: '#ec4899', shopper: '#f59e0b', fixer: '#10b981',
  workflow: '#8b5cf6', outlier: '#eab308', thread: '#6366f1',
};

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function LibraryView({ wsEvent, onOpenDrawer }) {
  const [source, setSource] = useState('all');
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(() => {
    const fetches = [];
    if (source === 'all' || source === 'commerce') {
      fetches.push(
        fetch('/api/commerce/runs').then(r => r.json()).then(d => (d.runs || []).map(r => ({ ...r, _source: 'commerce', _label: r.topic || 'Content Pipeline' }))).catch(() => []),
        fetch('/api/apparel/runs').then(r => r.json()).then(d => (d.runs || []).map(r => ({ ...r, _source: 'apparel', _label: r.niche || 'Apparel Pipeline' }))).catch(() => []),
        fetch('/api/shopper/runs').then(r => r.json()).then(d => (d.runs || []).map(r => ({ ...r, _source: 'shopper', _label: r.store_url || 'Mystery Shopper' }))).catch(() => []),
        fetch('/api/fixer/runs').then(r => r.json()).then(d => (d.runs || []).map(r => ({ ...r, _source: 'fixer', _label: 'Store Fixer' }))).catch(() => []),
      );
    }
    if (source === 'all' || source === 'outlier') {
      fetches.push(
        fetch('/api/youtube/board').then(r => r.json()).then(d => (d.items || []).map(r => ({
          ...r, _source: 'outlier', _label: r.title || 'Outlier Video',
          created_at: r.saved_at || r.created_at,
        }))).catch(() => []),
      );
    }
    if (source === 'all' || source === 'threads') {
      fetches.push(
        fetch('/api/fleet/threads').then(r => r.json()).then(d => (d.threads || []).map(r => ({
          ...r, _source: 'thread', _label: r.title || `Thread ${r.id?.slice(0, 8)}`,
        }))).catch(() => []),
      );
    }
    if (source === 'all' || source === 'workflows') {
      fetches.push(
        fetch('/api/workflows').then(r => r.json()).then(d => (d.workflows || []).map(r => ({
          ...r, _source: 'workflow', _label: r.name || `Workflow ${r.id?.slice(0, 8)}`,
        }))).catch(() => []),
      );
    }
    Promise.all(fetches).then(results => {
      const merged = results.flat().sort((a, b) => {
        const ta = new Date(a.created_at || a.saved_at || 0).getTime();
        const tb = new Date(b.created_at || b.saved_at || 0).getTime();
        return tb - ta;
      });
      setItems(merged);
    });
  }, [source]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (wsEvent?.type) load(); }, [wsEvent, load]);

  const filtered = search
    ? items.filter(i => (i._label || '').toLowerCase().includes(search.toLowerCase()) || (i._source || '').includes(search.toLowerCase()))
    : items;

  const statusColor = (s) => s === 'done' ? '#22c55e' : s === 'error' ? '#ef4444' : s === 'running' ? '#f59e0b' : '#666';

  return (
    <div style={{ padding: 32, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e0e8', marginBottom: 4 }}>Library</h2>
        <p style={{ fontSize: 13, color: '#666' }}>All generated content, pipeline runs, and saved artifacts</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {SOURCES.map(s => (
          <button key={s.id} onClick={() => setSource(s.id)} style={{
            padding: '6px 14px', borderRadius: 8, border: '1px solid',
            borderColor: source === s.id ? '#a78bfa' : '#333',
            background: source === s.id ? '#a78bfa15' : '#111118',
            color: source === s.id ? '#a78bfa' : '#888',
            cursor: 'pointer', fontSize: 12, fontWeight: 500,
          }}>{s.label}</button>
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search library..."
          style={{
            width: '100%', padding: '10px 14px', borderRadius: 8,
            border: '1px solid #333', background: '#111118', color: '#e0e0e8', fontSize: 13,
          }} />
      </div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>{filtered.length} items</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.length === 0 && <div style={{ color: '#555', fontSize: 13, textAlign: 'center', padding: 40 }}>No items found.</div>}
        {filtered.slice(0, 100).map((item, i) => {
          const color = SOURCE_COLORS[item._source] || '#a78bfa';
          const isExpanded = expanded === (item.id || i);
          return (
            <div key={item.id || i}
              onClick={() => setExpanded(isExpanded ? null : (item.id || i))}
              style={{
                background: '#111118', borderRadius: 10, padding: '14px 16px',
                border: `1px solid ${isExpanded ? color + '40' : '#222'}`,
                cursor: 'pointer', transition: 'border-color 0.15s',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  fontSize: 9, padding: '2px 8px', borderRadius: 10,
                  background: color + '20', color, fontWeight: 600, textTransform: 'uppercase',
                  flexShrink: 0,
                }}>{item._source}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: '#e0e0e8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item._label}
                  </div>
                </div>
                {item.status && (
                  <span style={{ fontSize: 10, color: statusColor(item.status), fontWeight: 600, flexShrink: 0 }}>
                    {item.status}
                  </span>
                )}
                <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>
                  {timeAgo(item.created_at || item.saved_at)}
                </span>
              </div>
              {isExpanded && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1a1a2e' }}>
                  {item.score != null && <div style={{ fontSize: 11, color: '#888' }}>Score: {item.score}/10</div>}
                  {item.grade && <div style={{ fontSize: 11, color: '#888' }}>Grade: {item.grade}</div>}
                  {item.outlier_tier && <div style={{ fontSize: 11, color: '#888' }}>Tier: {item.outlier_tier} ({item.outlier_ratio}x)</div>}
                  {item.view_count && <div style={{ fontSize: 11, color: '#888' }}>Views: {item.view_count?.toLocaleString()}</div>}
                  {item.stages && typeof item.stages === 'object' && (
                    <div style={{ fontSize: 11, color: '#888' }}>Stages: {Object.keys(item.stages).join(' → ')}</div>
                  )}
                  {item.nodes && <div style={{ fontSize: 11, color: '#888' }}>Nodes: {Array.isArray(item.nodes) ? item.nodes.length : '—'}</div>}
                  {item.agent_id && <div style={{ fontSize: 11, color: '#888' }}>Agent: {item.agent_id}</div>}
                  <pre style={{
                    marginTop: 8, fontSize: 10, color: '#666', whiteSpace: 'pre-wrap',
                    maxHeight: 200, overflow: 'auto', background: '#0a0a14',
                    padding: 8, borderRadius: 6,
                  }}>
                    {JSON.stringify(item, (k, v) => k.startsWith('_') ? undefined : v, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
