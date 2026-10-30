import React, { useState, useEffect, useRef, useCallback } from 'react';

const CATEGORIES = [
  { key: 'all', label: 'All', color: '#a78bfa' },
  { key: 'agent', label: 'Agent', color: '#60a5fa' },
  { key: 'workflow', label: 'Workflow', color: '#34d399' },
  { key: 'commerce', label: 'Commerce', color: '#fbbf24' },
  { key: 'bus', label: 'Bus', color: '#f472b6' },
  { key: 'health', label: 'Health', color: '#f87171' },
  { key: 'evolution', label: 'Evolution', color: '#c084fc' },
];

const STATUS_COLORS = {
  running: '#fbbf24', complete: '#34d399', completed: '#34d399',
  success: '#34d399', failed: '#f87171', error: '#f87171',
  warning: '#fbbf24', critical: '#f87171', resolved: '#6b7280',
  delivered: '#60a5fa', pending: '#9ca3af', unknown: '#9ca3af',
};

function categoryColor(cat) {
  return (CATEGORIES.find(c => c.key === cat) || {}).color || '#a78bfa';
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function ActivityTimeline() {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const url = filter === 'all' ? '/api/timeline?limit=200' : `/api/timeline?limit=200&category=${filter}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      setEvents(data.events || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(load, 5000);
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, load]);

  const grouped = {};
  for (const ev of events) {
    const day = ev.timestamp ? new Date(ev.timestamp).toLocaleDateString() : 'Unknown';
    (grouped[day] ||= []).push(ev);
  }

  return (
    <div style={{ padding: '12px 16px', height: '100%', overflowY: 'auto', background: '#0a0a1a' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 15 }}>Activity Timeline</span>
        <label style={{ color: '#94a3b8', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={autoRefresh} onChange={() => setAutoRefresh(a => !a)}
            style={{ accentColor: '#a78bfa' }} />
          Auto-refresh
        </label>
      </div>

      {/* Category filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {CATEGORIES.map(c => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 500, cursor: 'pointer',
              border: filter === c.key ? `1px solid ${c.color}` : '1px solid #334155',
              background: filter === c.key ? c.color + '22' : 'transparent',
              color: filter === c.key ? c.color : '#94a3b8',
            }}>
            {c.label}
          </button>
        ))}
      </div>

      {loading && events.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading timeline...</div>
      )}

      {!loading && events.length === 0 && (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>
          No events yet. Run agents, workflows, or pipelines to see activity here.
        </div>
      )}

      {/* Timeline */}
      {Object.entries(grouped).map(([day, dayEvents]) => (
        <div key={day} style={{ marginBottom: 18 }}>
          <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 }}>
            {day}
          </div>
          <div style={{ borderLeft: '2px solid #1e293b', marginLeft: 8, paddingLeft: 16 }}>
            {dayEvents.map(ev => (
              <div key={ev.id} style={{
                position: 'relative', marginBottom: 10, padding: '8px 12px',
                background: '#111827', borderRadius: 8, border: '1px solid #1e293b',
              }}>
                {/* Timeline dot */}
                <div style={{
                  position: 'absolute', left: -24, top: 14, width: 10, height: 10,
                  borderRadius: '50%', background: categoryColor(ev.category),
                  border: '2px solid #0a0a1a',
                }} />

                {/* Top row: type badge + time */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
                    color: categoryColor(ev.category), background: categoryColor(ev.category) + '18',
                    padding: '1px 6px', borderRadius: 4,
                  }}>
                    {ev.type}
                  </span>
                  <span style={{ fontSize: 10, color: '#64748b' }}>{relativeTime(ev.timestamp)}</span>
                </div>

                {/* Title */}
                <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
                  {ev.title}
                </div>

                {/* Detail + status */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#94a3b8', fontSize: 11, maxWidth: '75%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ev.detail}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 500, padding: '1px 6px', borderRadius: 4,
                    color: STATUS_COLORS[ev.status] || '#9ca3af',
                    background: (STATUS_COLORS[ev.status] || '#9ca3af') + '18',
                  }}>
                    {ev.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
