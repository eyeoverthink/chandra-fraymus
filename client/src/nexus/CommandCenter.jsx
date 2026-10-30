import React, { useState, useEffect } from 'react';

const WIDGETS = [
  { id: 'system', label: 'System Health', icon: '◈', color: '#22c55e', panel: 'dashboard' },
  { id: 'intelligence', label: 'Intelligence', icon: '♦', color: '#f59e0b', panel: 'intelligence' },
  { id: 'fleet', label: 'Agent Fleet', icon: '⚡', color: '#6366f1', panel: 'fleet' },
  { id: 'workflows', label: 'Workflows', icon: '⬡', color: '#8b5cf6', action: 'canvas' },
  { id: 'commerce', label: 'Commerce', icon: '◆', color: '#ec4899', panel: 'commerce' },
  { id: 'memory', label: 'Memory / RSI', icon: '◇', color: '#a78bfa', panel: 'vertiso' },
  { id: 'mcp', label: 'MCP Gateway', icon: '⬢', color: '#10b981', panel: 'mcp' },
  { id: 'automations', label: 'Automations', icon: '⟳', color: '#06b6d4', panel: 'automations' },
  { id: 'browser', label: 'Browser', icon: '◉', color: '#7c3aed', panel: 'browser' },
  { id: 'outlier', label: 'Outlier Board', icon: '◎', color: '#eab308', panel: 'outlier' },
];

export default function CommandCenter({ health, wsEvent, onOpenDrawer, onNavigate }) {
  const [data, setData] = useState({});
  const [events, setEvents] = useState([]);

  const load = () => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setData(p => ({ ...p, fleet: d.agents || [] }))).catch(() => {});
    fetch('/api/workflows').then(r => r.json()).then(d => setData(p => ({ ...p, workflows: d.workflows || [] }))).catch(() => {});
    fetch('/api/mcp/servers').then(r => r.json()).then(d => setData(p => ({ ...p, mcp: d.servers || d || [] }))).catch(() => {});
    fetch('/api/fraymus/health').then(r => r.json()).then(d => setData(p => ({ ...p, fraymus: d }))).catch(() => {});
    fetch('/api/vertiso/stats').then(r => r.json()).then(d => setData(p => ({ ...p, memory: d }))).catch(() => {});
    fetch('/api/automations').then(r => r.json()).then(d => setData(p => ({ ...p, automations: d.automations || d || [] }))).catch(() => {});
    fetch('/api/events?limit=20').then(r => r.json()).then(d => setEvents(Array.isArray(d) ? d : [])).catch(() => {});
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (wsEvent?.type) load();
  }, [wsEvent]);

  const metric = (id) => {
    const f = data.fraymus;
    switch (id) {
      case 'system': return f?.autonomous ? 'Autonomous' : health ? 'Online' : 'Connecting...';
      case 'intelligence': return f?.intelligence?.mood || 'neutral';
      case 'fleet': return `${(data.fleet || []).length} agents`;
      case 'workflows': return `${(data.workflows || []).length} defined`;
      case 'commerce': return '4 pipelines';
      case 'memory': return data.memory ? `${data.memory.totalMemories || 0} memories` : '—';
      case 'mcp': return `${(data.mcp || []).length} servers`;
      case 'automations': return `${(data.automations || []).length} active`;
      case 'browser': return 'Headless + Ext';
      case 'outlier': return 'YouTube Research';
      default: return '—';
    }
  };

  const sub = (id) => {
    const f = data.fraymus;
    switch (id) {
      case 'system': return f ? `Gen ${f.generation || 0} · Fitness ${(f.fitness || 0).toFixed(3)}` : '';
      case 'intelligence': return f?.intelligence ? `Dreams: ${f.intelligence.dreams || 0} · Ledger: ${f.intelligence.ledgerCount || 0}` : '';
      case 'fleet': return [...new Set((data.fleet || []).map(a => a.model).filter(Boolean))].join(', ');
      case 'memory': return data.memory ? `${data.memory.totalConsolidations || 0} consolidations` : '';
      default: return '';
    }
  };

  const handleClick = (w) => {
    if (w.action === 'canvas') onNavigate?.('canvas');
    else if (w.panel) onOpenDrawer?.(w.panel, w.label);
  };

  return (
    <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e0e8', marginBottom: 4 }}>Command Center</h2>
        <p style={{ fontSize: 13, color: '#666' }}>System overview — click any widget to dive deeper</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, marginBottom: 28 }}>
        {WIDGETS.map(w => (
          <button key={w.id} onClick={() => handleClick(w)} style={{
            background: '#111118', border: `1px solid ${w.color}25`, borderRadius: 12,
            padding: '18px 16px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.2s',
            position: 'relative', overflow: 'hidden',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = w.color + '60'; e.currentTarget.style.background = w.color + '08'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = w.color + '25'; e.currentTarget.style.background = '#111118'; }}
          >
            <div style={{
              position: 'absolute', top: 0, right: 0, width: 60, height: 60,
              background: `radial-gradient(circle at top right, ${w.color}15, transparent 70%)`,
            }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 18, color: w.color }}>{w.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#e0e0e8' }}>{w.label}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: w.color, marginBottom: 2 }}>{metric(w.id)}</div>
            {sub(w.id) && <div style={{ fontSize: 10, color: '#666' }}>{sub(w.id)}</div>}
          </button>
        ))}
      </div>

      {data.fraymus?.intelligence && (
        <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222', marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa', marginBottom: 14 }}>Intelligence Stack</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {[
              { label: 'Heart Mood', value: data.fraymus.intelligence.mood || 'neutral', color: '#f59e0b' },
              { label: 'Dreamer', value: `${data.fraymus.intelligence.dreams || 0} dreams`, color: '#8b5cf6' },
              { label: 'Ledger', value: `${data.fraymus.intelligence.ledgerCount || 0} events`, color: '#06b6d4' },
              { label: 'Cognition', value: data.fraymus.intelligence.cognitionMode || 'idle', color: '#10b981' },
              { label: 'Memory Bridge', value: data.memory ? `${data.memory.totalMemories} stored` : '—', color: '#a78bfa' },
              { label: 'Autonomy', value: data.fraymus.autonomous ? `Gen ${data.fraymus.generation}` : 'Paused', color: '#22c55e' },
            ].map(s => (
              <div key={s.label} style={{ background: '#0a0a14', borderRadius: 8, padding: '10px 12px', border: `1px solid ${s.color}20` }}>
                <div style={{ fontSize: 10, color: '#666', marginBottom: 3 }}>{s.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8', marginBottom: 14 }}>Recent Activity</h3>
        {events.length === 0 && <div style={{ color: '#555', fontSize: 12 }}>No recent events.</div>}
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {events.slice(0, 20).map((ev, i) => (
            <div key={ev.id || i} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '7px 0', borderBottom: i < events.length - 1 ? '1px solid #1a1a2e' : 'none',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: ev.type === 'error' ? '#ef4444' : ev.type === 'agent' ? '#6366f1' : '#a78bfa',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#e0e0e8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {ev.summary || ev.type || 'Event'}
                </div>
              </div>
              <div style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>
                {ev.created_at ? new Date(ev.created_at).toLocaleTimeString() : ''}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
