import { useState, useEffect, useCallback } from 'react';

export default function CalendarPanel({ wsEvent }) {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('upcoming');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scheduleForm, setScheduleForm] = useState({ topic: '', format: 'short_video', platforms: 'youtube,tiktok,instagram' });

  const load = useCallback(async () => {
    try {
      setError('');
      const [calRes, statsRes] = await Promise.all([
        fetch('/api/calendar?limit=50'),
        fetch('/api/calendar/stats'),
      ]);
      const calData = await calRes.json();
      setItems(calData.items || []);
      setStats(await statsRes.json());
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'calendar') load();
  }, [wsEvent, load]);

  const suggest = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/calendar/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 5, daysAhead: 7 }),
      });
      const data = await res.json();
      if (data.suggestions?.length) await load();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const learnPatterns = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/calendar/learn-patterns', { method: 'POST' });
      const data = await res.json();
      if (data.patterns !== undefined) await load();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const scheduleItem = async () => {
    if (!scheduleForm.topic.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/calendar/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: scheduleForm.topic,
          format: scheduleForm.format,
          platforms: scheduleForm.platforms.split(',').map(s => s.trim()).filter(Boolean),
        }),
      });
      setScheduleForm({ topic: '', format: 'short_video', platforms: 'youtube,tiktok,instagram' });
      await load();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const cancelItem = async (id) => {
    try {
      await fetch(`/api/calendar/${id}`, { method: 'DELETE' });
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (e) { setError(e.message); }
  };

  const now = Date.now();
  const upcoming = items.filter(i => i.status === 'scheduled' && i.scheduled_at > now);
  const past = items.filter(i => i.status !== 'scheduled' || i.scheduled_at <= now);

  const tabs = [
    { key: 'upcoming', label: `Upcoming (${upcoming.length})` },
    { key: 'past', label: `Past (${past.length})` },
    { key: 'schedule', label: 'Schedule' },
    { key: 'patterns', label: 'Patterns' },
  ];

  const formatDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const priorityColor = (p) => p >= 0.8 ? '#ef4444' : p >= 0.5 ? '#f59e0b' : '#10b981';

  return (
    <div style={{ padding: 16, color: '#e2e8f0' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, color: '#f59e0b' }}>Intelligent Content Calendar</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8' }}>AI-powered scheduling from analytics, revenue, and daemon dreams</p>

      {error && <div style={{ background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
          <StatCard label="Scheduled" value={stats.scheduled || 0} color="#f59e0b" />
          <StatCard label="Completed" value={stats.completed || 0} color="#10b981" />
          <StatCard label="Total" value={stats.total || 0} color="#6366f1" />
          <StatCard label="Patterns" value={stats.patterns?.length || 0} color="#8b5cf6" />
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13,
              background: tab === t.key ? '#f59e0b' : '#1e293b', color: tab === t.key ? '#000' : '#94a3b8' }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={suggest} disabled={loading}
          style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#f59e0b', color: '#000', fontSize: 13 }}>
          {loading ? 'Suggesting...' : 'AI Suggest'}
        </button>
        <button onClick={learnPatterns} disabled={loading}
          style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#8b5cf6', color: '#fff', fontSize: 13 }}>
          {loading ? 'Learning...' : 'Learn Patterns'}
        </button>
      </div>

      {(tab === 'upcoming' || tab === 'past') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(tab === 'upcoming' ? upcoming : past).length === 0 && (
            <p style={{ color: '#64748b', fontSize: 13 }}>{tab === 'upcoming' ? 'No upcoming items. Try AI Suggest!' : 'No past items yet.'}</p>
          )}
          {(tab === 'upcoming' ? upcoming : past).map(item => (
            <div key={item.id} style={{ background: '#1e293b', borderRadius: 8, padding: 12, borderLeft: `3px solid ${priorityColor(item.priority)}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{item.topic}</div>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: item.status === 'scheduled' ? '#1e3a5f' : item.status === 'completed' ? '#065f46' : '#7f1d1d',
                  color: item.status === 'scheduled' ? '#93c5fd' : item.status === 'completed' ? '#6ee7b7' : '#fca5a5' }}>
                  {item.status}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                {formatDate(item.scheduled_at)} — {item.format} — {item.source}
              </div>
              {item.reasoning && <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic', marginBottom: 6 }}>{item.reasoning}</div>}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {JSON.parse(item.platforms || '[]').map(p => (
                  <span key={p} style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: '#334155', color: '#cbd5e1' }}>{p}</span>
                ))}
                {item.status === 'scheduled' && (
                  <button onClick={() => cancelItem(item.id)}
                    style={{ marginLeft: 'auto', padding: '2px 10px', borderRadius: 4, border: '1px solid #dc2626', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: 11 }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'schedule' && (
        <div style={{ background: '#1e293b', borderRadius: 8, padding: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Topic</label>
            <input value={scheduleForm.topic} onChange={e => setScheduleForm(p => ({ ...p, topic: e.target.value }))}
              placeholder="What content to create..."
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', fontSize: 14, boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Format</label>
              <select value={scheduleForm.format} onChange={e => setScheduleForm(p => ({ ...p, format: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', fontSize: 13 }}>
                <option value="short_video">Short Video</option>
                <option value="long_video">Long Video</option>
                <option value="article">Article</option>
                <option value="podcast">Podcast</option>
                <option value="social_post">Social Post</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Platforms</label>
              <input value={scheduleForm.platforms} onChange={e => setScheduleForm(p => ({ ...p, platforms: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          </div>
          <button onClick={scheduleItem} disabled={loading || !scheduleForm.topic.trim()}
            style={{ padding: '8px 20px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#f59e0b', color: '#000', fontSize: 13 }}>
            Schedule
          </button>
        </div>
      )}

      {tab === 'patterns' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(!stats?.patterns || stats.patterns.length === 0) && (
            <p style={{ color: '#64748b', fontSize: 13 }}>No timing patterns learned yet. Click "Learn Patterns" to analyze your analytics data.</p>
          )}
          {stats?.patterns?.map((p, i) => (
            <div key={p.id || i} style={{ background: '#1e293b', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.platform || 'all'}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.day_of_week] || '?'} at {p.hour}:00
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#f59e0b' }}>{((p.avg_engagement || 0) * 100).toFixed(1)}%</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{p.sample_count} samples — {((p.confidence || 0) * 100).toFixed(0)}% conf</div>
              </div>
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
