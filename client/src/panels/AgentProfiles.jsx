import { useState, useEffect, useCallback } from 'react';

const ROLE_COLORS = {
  concierge: '#6366f1', orchestrator: '#8b5cf6', researcher: '#3b82f6',
  analyst: '#0ea5e9', developer: '#10b981', creative: '#f59e0b',
  security: '#ef4444', commerce: '#ec4899', default: '#64748b',
};

function roleColor(role) {
  if (!role) return ROLE_COLORS.default;
  const lower = role.toLowerCase();
  for (const [key, color] of Object.entries(ROLE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return ROLE_COLORS.default;
}

function StatPill({ label, value, color }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '8px 12px', borderRadius: 8,
      background: color ? `${color}18` : 'rgba(255,255,255,0.04)',
      minWidth: 70,
    }}>
      <span style={{ fontSize: 18, fontWeight: 700, color: color || '#e2e8f0' }}>{value}</span>
      <span style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
    </div>
  );
}

function AgentCard({ agent, onSelect }) {
  const color = roleColor(agent.role);
  const s = agent.stats || {};
  return (
    <button onClick={() => onSelect(agent)} style={{
      all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column',
      gap: 8, padding: 14, borderRadius: 10,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
      transition: 'all .15s',
    }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor = color; }}
       onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: `${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, color,
        }}>{(agent.name || '?')[0].toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{agent.role || 'agent'}</div>
        </div>
        {s.runs > 0 && (
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: s.successRate >= 80 ? '#10b98120' : s.successRate >= 50 ? '#f59e0b20' : '#ef444420',
            color: s.successRate >= 80 ? '#10b981' : s.successRate >= 50 ? '#f59e0b' : '#ef4444',
            fontWeight: 600,
          }}>{s.successRate}%</span>
        )}
      </div>
      {agent.description && (
        <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {agent.description}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {s.runs > 0 && <span style={{ fontSize: 10, color: '#64748b' }}>{s.runs} runs</span>}
        {s.threads > 0 && <span style={{ fontSize: 10, color: '#64748b' }}>{s.threads} threads</span>}
        {s.busSent > 0 && <span style={{ fontSize: 10, color: '#64748b' }}>{s.busSent} msgs</span>}
        {s.memories > 0 && <span style={{ fontSize: 10, color: '#64748b' }}>{s.memories} mems</span>}
      </div>
    </button>
  );
}

function ProfileDetail({ agent, onBack }) {
  const color = roleColor(agent.role);
  const s = agent.stats || {};
  const tools = Array.isArray(agent.tools) ? agent.tools : agent.tools ? [agent.tools] : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button onClick={onBack} style={{
        all: 'unset', cursor: 'pointer', fontSize: 12, color: '#6366f1',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>← Back to fleet</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 52, height: 52, borderRadius: '50%',
          background: `${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24, fontWeight: 700, color,
        }}>{(agent.name || '?')[0].toUpperCase()}</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, color: '#e2e8f0' }}>{agent.name}</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>{agent.role || 'agent'} · {agent.model || 'default model'}</div>
        </div>
      </div>

      {agent.description && (
        <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
          {agent.description}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatPill label="Runs" value={s.runs ?? 0} color="#6366f1" />
        <StatPill label="Success" value={s.success ?? 0} color="#10b981" />
        <StatPill label="Failed" value={s.failed ?? 0} color="#ef4444" />
        <StatPill label="Threads" value={s.threads ?? 0} color="#3b82f6" />
        <StatPill label="Bus Sent" value={s.busSent ?? 0} color="#8b5cf6" />
        <StatPill label="Bus Recv" value={s.busReceived ?? 0} color="#0ea5e9" />
        <StatPill label="Memories" value={s.memories ?? 0} color="#f59e0b" />
      </div>

      {s.successRate !== null && s.successRate !== undefined && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>Success Rate</div>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 4, width: `${s.successRate}%`,
              background: s.successRate >= 80 ? '#10b981' : s.successRate >= 50 ? '#f59e0b' : '#ef4444',
              transition: 'width .3s',
            }} />
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4,
            color: s.successRate >= 80 ? '#10b981' : s.successRate >= 50 ? '#f59e0b' : '#ef4444' }}>
            {s.successRate}%
          </div>
        </div>
      )}

      {s.avgConfidence !== null && s.avgConfidence !== undefined && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Memory Confidence</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f59e0b' }}>{s.avgConfidence}%</div>
        </div>
      )}

      {s.lastRun && (
        <div style={{ fontSize: 11, color: '#64748b' }}>
          Last run: {new Date(typeof s.lastRun === 'number' ? s.lastRun : Date.parse(s.lastRun)).toLocaleString()}
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>Tools ({tools.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tools.map(t => (
              <span key={t} style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 6,
                background: `${color}18`, color, border: `1px solid ${color}30`,
              }}>{t}</span>
            ))}
          </div>
        </div>
      )}

      {agent.greeting && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', fontStyle: 'italic', fontSize: 12, color: '#94a3b8' }}>
          "{agent.greeting}"
        </div>
      )}
    </div>
  );
}

export default function AgentProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    fetch('/api/agent-profiles')
      .then(r => r.json())
      .then(d => { setProfiles(d.profiles || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 20, color: '#94a3b8' }}>Loading agent profiles…</div>;

  if (selected) return <ProfileDetail agent={selected} onBack={() => setSelected(null)} />;

  const filtered = profiles.filter(a =>
    !search || (a.name + ' ' + (a.role || '') + ' ' + (a.description || '')).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search agents…"
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 13, outline: 'none',
          }}
        />
        <span style={{ fontSize: 12, color: '#64748b' }}>{filtered.length} agents</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
        {filtered.map(a => <AgentCard key={a.id} agent={a} onSelect={setSelected} />)}
      </div>
      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>
          {search ? 'No agents match your search' : 'No agents found'}
        </div>
      )}
    </div>
  );
}
