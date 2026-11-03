import React, { useState, useEffect, useRef } from 'react';
import CommandBar from './CommandBar.jsx';

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
  { id: 'deploy', label: 'Deploy API', icon: '⚙', color: '#f97316', panel: 'deploy' },
  { id: 'bus', label: 'Agent Bus', icon: '↔', color: '#22d3ee', panel: 'bus' },
  { id: 'outlier', label: 'Outlier Board', icon: '◎', color: '#eab308', panel: 'outlier' },
  { id: 'health', label: 'Health Monitor', icon: '♥', color: '#ef4444', panel: 'health' },
  { id: 'media', label: 'Media Hub', icon: '▶', color: '#14b8a6', panel: 'media' },
  { id: 'forge', label: 'Forge + Synth', icon: '⚡', color: '#f59e0b', panel: 'forge' },
  { id: 'creation', label: 'Creation', icon: '✦', color: '#a78bfa', panel: 'creation' },
  { id: 'distribution', label: 'Distribution', icon: '⊕', color: '#3b82f6', panel: 'distribution' },
  { id: 'analytics', label: 'Analytics', icon: '◎', color: '#10b981', panel: 'analytics' },
  { id: 'nerve-center', label: 'Nerve Center', icon: '◈', color: '#ef4444', panel: 'nerve-center' },
  { id: 'learning-loop', label: 'Learning Loop', icon: '◆', color: '#10b981', panel: 'learning-loop' },
  { id: 'calendar', label: 'Calendar', icon: '▤', color: '#f59e0b', panel: 'calendar' },
  { id: 'ab-testing', label: 'A/B Testing', icon: '⚖', color: '#6366f1', panel: 'ab-testing' },
  { id: 'trend-radar', label: 'Trend Radar', icon: '◉', color: '#f59e0b', panel: 'trend-radar' },
  { id: 'audience', label: 'Audience', icon: '◎', color: '#7c3aed', panel: 'audience' },
  { id: 'repurpose', label: 'Repurpose', icon: '⟳', color: '#ec4899', panel: 'repurpose' },
  { id: 'settings', label: 'Settings', icon: '⚙', color: '#64748b', panel: 'settings' },
];

const EVENT_STYLES = {
  agents: { icon: '⚡', color: '#6366f1', drawer: 'fleet' },
  agent: { icon: '⚡', color: '#6366f1', drawer: 'fleet' },
  event: { icon: '◆', color: '#a78bfa', drawer: 'dashboard' },
  memory: { icon: '◇', color: '#a78bfa', drawer: 'vertiso' },
  v3: { icon: '◈', color: '#10b981', drawer: 'dashboard' },
  tasks: { icon: '⟳', color: '#06b6d4', drawer: 'automations' },
  deploy: { icon: '⚙', color: '#f97316', drawer: 'deploy' },
  bus: { icon: '↔', color: '#22d3ee', drawer: 'bus' },
  health: { icon: '♥', color: '#ef4444', drawer: 'health' },
  error: { icon: '✗', color: '#ef4444', drawer: 'dashboard' },
  creation: { icon: '✦', color: '#a78bfa', drawer: 'creation' },
  workflow: { icon: '⬡', color: '#8b5cf6', drawer: 'dashboard' },
  heart: { icon: '♥', color: '#ef4444', drawer: 'nerve-center' },
  dreamer: { icon: '◇', color: '#8b5cf6', drawer: 'nerve-center' },
  cognition: { icon: '◆', color: '#10b981', drawer: 'nerve-center' },
  consciousness: { icon: '◈', color: '#f59e0b', drawer: 'nerve-center' },
  intelligence: { icon: '♦', color: '#f59e0b', drawer: 'nerve-center' },
  needle: { icon: '⊕', color: '#06b6d4', drawer: 'nerve-center' },
  motor: { icon: '⚙', color: '#ec4899', drawer: 'nerve-center' },
  ledger: { icon: '⬡', color: '#3b82f6', drawer: 'nerve-center' },
  autonomy: { icon: '◎', color: '#22c55e', drawer: 'nerve-center' },
  rsi: { icon: '◎', color: '#a78bfa', drawer: 'vertiso' },
  streaming: { icon: '▶', color: '#14b8a6', drawer: 'media' },
  distribution: { icon: '⊕', color: '#3b82f6', drawer: 'distribution' },
  analytics: { icon: '◎', color: '#10b981', drawer: 'analytics' },
  music: { icon: '♫', color: '#8b5cf6', drawer: 'media' },
  mail: { icon: '✉', color: '#60a5fa', drawer: 'dashboard' },
  commerce: { icon: '◆', color: '#10b981', drawer: 'learning-loop' },
  calendar: { icon: '▤', color: '#f59e0b', drawer: 'calendar' },
  ab_testing: { icon: '⚖', color: '#6366f1', drawer: 'ab-testing' },
  trend_radar: { icon: '◉', color: '#f59e0b', drawer: 'trend-radar' },
  audience: { icon: '◎', color: '#7c3aed', drawer: 'audience' },
  repurpose: { icon: '⟳', color: '#ec4899', drawer: 'repurpose' },
};

function formatEvent(ev) {
  const p = ev.payload || {};
  if (ev.type === 'agents' || ev.type === 'agent') {
    const name = p.agentName || p.agentId || 'Agent';
    const action = p.action || 'updated';
    const preview = p.preview ? `: ${p.preview}` : '';
    return `${name} ${action}${preview}`;
  }
  if (ev.type === 'event' && p.source === 'pipeline') {
    return `${p.pipeline} pipeline ${p.action || 'event'}${p.arg ? ` — ${p.arg}` : ''}`;
  }
  if (ev.type === 'event' && p.source === 'workflow') {
    return `Workflow "${p.workflow}" ${p.action || 'event'}`;
  }
  if (ev.type === 'memory') return `Memory ${p.key ? `"${p.key}"` : ''} updated`;
  if (ev.type === 'v3') return 'V3 security event';
  if (ev.type === 'heart') return `Heart felt ${p.primary || 'emotion'}${p.intensity ? ` (${(p.intensity * 100).toFixed(0)}%)` : ''}`;
  if (ev.type === 'dreamer') return `Dreamer ${p.action || 'active'}${p.number ? ` #${p.number}` : ''}`;
  if (ev.type === 'cognition') return `Cognition ${p.phase || 'processing'}${p.primary ? ` — ${p.primary}` : ''}`;
  if (ev.type === 'consciousness') return `Consciousness proof ${p.allPassed ? 'PASSED' : 'partial'} (${p.nodeCount || 4} nodes)`;
  if (ev.type === 'intelligence') return `Intelligence ${p.type || 'event'}${p.skill ? ` — ${p.skill}` : ''}${p.primary ? ` — ${p.primary}` : ''}`;
  if (ev.type === 'needle') return `Needle ${p.type || 'event'}${p.jobId ? ` #${String(p.jobId).slice(0, 8)}` : ''}`;
  if (ev.type === 'motor') return `Motor ${p.type || 'event'}${p.node ? ` → ${p.node}` : ''}`;
  if (ev.type === 'ledger') return `Ledger recorded ${p.kind || 'event'}${p.seq ? ` (seq ${p.seq})` : ''}`;
  if (ev.type === 'autonomy') return `Autonomy ${p.type || 'event'}${p.generation ? ` gen ${p.generation}` : ''}${p.R ? ` R=${p.R.toFixed(3)}` : ''}`;
  if (ev.type === 'streaming') return `Streaming ${p.type || 'event'}`;
  if (ev.type === 'workflow') return `Workflow ${p.type || 'event'}${p.id ? ` #${String(p.id).slice(0, 8)}` : ''}`;
  if (ev.type === 'mail') return 'New mail received';
  if (ev.summary) return typeof ev.summary === 'string' ? ev.summary : 'System event';
  return typeof ev.type === 'string' ? ev.type : 'System event';
}

export default function CommandCenter({ health, wsEvent, onOpenDrawer, onNavigate }) {
  const [data, setData] = useState({});
  const [liveEvents, setLiveEvents] = useState([]);
  const [newPulse, setNewPulse] = useState(false);
  const eventIdRef = useRef(0);

  const load = () => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setData(p => ({ ...p, fleet: d.agents || [] }))).catch(() => {});
    fetch('/api/workflows').then(r => r.json()).then(d => setData(p => ({ ...p, workflows: d.workflows || [] }))).catch(() => {});
    fetch('/api/mcp/servers').then(r => r.json()).then(d => setData(p => ({ ...p, mcp: d.servers || d || [] }))).catch(() => {});
    fetch('/api/fraymus/health').then(r => r.json()).then(d => setData(p => ({ ...p, fraymus: d }))).catch(() => {});
    fetch('/api/vertiso/stats').then(r => r.json()).then(d => setData(p => ({ ...p, memory: d }))).catch(() => {});
    fetch('/api/automations').then(r => r.json()).then(d => setData(p => ({ ...p, automations: d.automations || d || [] }))).catch(() => {});
  };

  useEffect(() => {
    load();
    fetch('/api/events?limit=20').then(r => r.json()).then(d => {
      const initial = (Array.isArray(d) ? d : []).map(ev => ({
        ...ev, _id: ++eventIdRef.current, _ts: ev.created_at || Date.now(), _live: false,
      }));
      setLiveEvents(initial);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!wsEvent?.type || wsEvent.type === 'hello') return;
    load();
    const newEv = {
      type: wsEvent.type,
      payload: wsEvent.payload || {},
      _id: ++eventIdRef.current,
      _ts: Date.now(),
      _live: true,
    };
    setLiveEvents(prev => [newEv, ...prev].slice(0, 100));
    setNewPulse(true);
    setTimeout(() => setNewPulse(false), 1500);
  }, [wsEvent]);

  const metric = (id) => {
    const f = data.fraymus;
    switch (id) {
      case 'system': return f?.autonomous ? 'Autonomous' : health ? 'Online' : 'Connecting...';
      case 'intelligence': return f?.intelligence?.mood?.mood || 'neutral';
      case 'fleet': return `${(data.fleet || []).length} agents`;
      case 'workflows': return `${(data.workflows || []).length} defined`;
      case 'commerce': return '4 pipelines';
      case 'memory': return data.memory ? `${data.memory.totalMemories || 0} memories` : '—';
      case 'mcp': return `${(data.mcp || []).length} servers`;
      case 'automations': return `${(data.automations || []).length} active`;
      case 'browser': return 'Headless + Ext';
      case 'outlier': return 'YouTube Research';
      case 'media': return '5 engines';
      case 'nerve-center': return f?.intelligence?.mood?.mood || 'neutral';
      default: return '—';
    }
  };

  const sub = (id) => {
    const f = data.fraymus;
    switch (id) {
      case 'system': return f ? `Gen ${f.generation || 0} · Fitness ${(f.fitness || 0).toFixed(3)}` : '';
      case 'intelligence': return f?.intelligence ? `Dreams: ${f.intelligence.dreamerState?.dreamCount || 0} · Ledger: ${f.intelligence.ledgerIntegrity?.checked || 0}` : '';
      case 'fleet': return [...new Set((data.fleet || []).map(a => a.model).filter(Boolean))].join(', ');
      case 'memory': return data.memory ? `${data.memory.totalConsolidations || 0} consolidations` : '';
      default: return '';
    }
  };

  const handleClick = (w) => {
    if (w.action === 'canvas') onNavigate?.('canvas');
    else if (w.panel) onOpenDrawer?.(w.panel, w.label);
  };

  const handleEventClick = (ev) => {
    const style = EVENT_STYLES[ev.type] || EVENT_STYLES.event;
    if (style.drawer) onOpenDrawer?.(style.drawer, style.drawer);
  };

  const timeAgo = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e0e8', marginBottom: 4 }}>Command Center</h2>
        <p style={{ fontSize: 13, color: '#666' }}>System overview — click any widget to dive deeper, or type a command below</p>
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
              { label: 'Heart Mood', value: data.fraymus.intelligence.mood?.mood || 'neutral', color: '#f59e0b' },
              { label: 'Dreamer', value: `${data.fraymus.intelligence.dreamerState?.dreamCount || 0} dreams`, color: '#8b5cf6' },
              { label: 'Ledger', value: `${data.fraymus.intelligence.ledgerIntegrity?.checked || 0} events`, color: '#06b6d4' },
              { label: 'Cognition', value: data.fraymus.intelligence.cognition ? `${Object.keys(data.fraymus.intelligence.cognition.modules || {}).length} modules` : 'idle', color: '#10b981' },
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

      <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222', marginBottom: 20, flex: '0 1 auto', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{
            fontSize: 14, fontWeight: 600, color: '#e0e0e8',
            transition: 'color 0.3s',
            ...(newPulse ? { color: '#a78bfa' } : {}),
          }}>
            {newPulse ? '● ' : ''}Live Activity
          </h3>
          {liveEvents.length > 0 && (
            <button onClick={() => setLiveEvents([])} style={{
              background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11,
            }}>Clear</button>
          )}
        </div>
        {liveEvents.length === 0 && <div style={{ color: '#555', fontSize: 12 }}>No recent events.</div>}
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {liveEvents.slice(0, 50).map((ev) => {
            const style = EVENT_STYLES[ev.type] || EVENT_STYLES.event;
            return (
              <button key={ev._id} onClick={() => handleEventClick(ev)} style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                padding: '7px 0', background: 'transparent',
                border: 'none', borderBottom: '1px solid #1a1a2e', cursor: 'pointer', textAlign: 'left',
                animation: ev._live ? 'slideIn 0.3s ease-out' : 'none',
              }}>
                <span style={{ fontSize: 12, color: style.color, flexShrink: 0, width: 18, textAlign: 'center' }}>
                  {style.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#e0e0e8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {formatEvent(ev)}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>
                  {timeAgo(ev._ts)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 8 }}>
        <CommandBar onOpenDrawer={onOpenDrawer} />
      </div>

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
