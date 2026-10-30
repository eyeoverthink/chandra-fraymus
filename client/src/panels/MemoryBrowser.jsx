import { useState, useEffect, useCallback } from 'react';

const CAT_COLORS = {
  general: '#6366f1', interaction: '#3b82f6', outcome: '#10b981',
  dream: '#8b5cf6', fossil: '#f59e0b', skill: '#ec4899',
  reflection: '#0ea5e9', default: '#64748b',
};

function catColor(cat) {
  return CAT_COLORS[cat] || CAT_COLORS.default;
}

function relTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ConfidenceBar({ value }) {
  const pct = Math.round((value ?? 1) * 100);
  const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10, color, fontWeight: 600 }}>{pct}%</span>
    </div>
  );
}

function MemoryCard({ mem, onVerify, onForget }) {
  const [expanded, setExpanded] = useState(false);
  const color = catColor(mem.category);
  const val = String(mem.value);
  const long = val.length > 120;

  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 4,
          background: `${color}20`, color, fontWeight: 600, textTransform: 'uppercase',
        }}>{mem.category}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mem.key}
        </span>
        {mem.verified_at && <span style={{ fontSize: 9, color: '#10b981', fontWeight: 600 }}>VERIFIED</span>}
        {!mem.verified_at && <span style={{ fontSize: 9, color: '#64748b' }}>unverified</span>}
      </div>

      <div style={{
        fontSize: 12, color: '#94a3b8', lineHeight: 1.5,
        ...(long && !expanded ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}),
      }}>
        {val}
      </div>
      {long && (
        <button onClick={() => setExpanded(!expanded)} style={{
          all: 'unset', cursor: 'pointer', fontSize: 11, color: '#6366f1',
        }}>{expanded ? 'Collapse' : 'Show more'}</button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}><ConfidenceBar value={mem.confidence} /></div>
        <span style={{ fontSize: 10, color: '#64748b' }}>{mem.access_count}x accessed</span>
        <span style={{ fontSize: 10, color: '#64748b' }}>{relTime(mem.updated_at)}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#64748b' }}>
        <span>src: {mem.source}</span>
        <span style={{ flex: 1 }} />
        {!mem.verified_at && (
          <button onClick={() => onVerify(mem.id)} style={{
            all: 'unset', cursor: 'pointer', color: '#10b981', fontWeight: 600,
          }}>Verify</button>
        )}
        <button onClick={() => onForget(mem.id)} style={{
          all: 'unset', cursor: 'pointer', color: '#ef4444', fontWeight: 600,
        }}>Forget</button>
      </div>
    </div>
  );
}

function AgentSummary({ agent, onClick }) {
  return (
    <button onClick={() => onClick(agent.agent_id)} style={{
      all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
      transition: 'all .15s',
    }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
       onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: '#6366f130', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 700, color: '#6366f1',
      }}>{(agent.agent_id || '?')[0].toUpperCase()}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0' }}>{agent.agent_id}</div>
        <div style={{ fontSize: 11, color: '#64748b' }}>{agent.count} memories · last active {relTime(agent.lastActive)}</div>
      </div>
      <span style={{ fontSize: 14, color: '#64748b' }}>→</span>
    </button>
  );
}

export default function MemoryBrowser() {
  const [stats, setStats] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [memories, setMemories] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(() => {
    fetch('/api/fleet/memory/stats')
      .then(r => r.json())
      .then(d => { setStats(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const loadMemories = useCallback((agentId) => {
    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('q', search);
    if (catFilter) params.set('category', catFilter);
    fetch(`/api/fleet/memory/${agentId}?${params}`)
      .then(r => r.json())
      .then(d => setMemories(d.memories || []))
      .catch(() => {});
  }, [search, catFilter]);

  useEffect(() => {
    if (selectedAgent) loadMemories(selectedAgent);
  }, [selectedAgent, loadMemories]);

  const handleVerify = (id) => {
    fetch(`/api/fleet/memory/verify/${id}`, { method: 'POST' })
      .then(() => loadMemories(selectedAgent))
      .catch(() => {});
  };

  const handleForget = (id) => {
    fetch(`/api/fleet/memory/${id}`, { method: 'DELETE' })
      .then(() => { loadMemories(selectedAgent); loadStats(); })
      .catch(() => {});
  };

  if (loading) return <div style={{ padding: 20, color: '#94a3b8' }}>Loading memory stats…</div>;

  if (selectedAgent) {
    const categories = [...new Set(memories.map(m => m.category))].sort();
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => { setSelectedAgent(null); setMemories([]); setSearch(''); setCatFilter(''); }} style={{
            all: 'unset', cursor: 'pointer', fontSize: 12, color: '#6366f1',
          }}>← All agents</button>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{selectedAgent}</span>
          <span style={{ fontSize: 12, color: '#64748b' }}>{memories.length} memories</span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search memories…"
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 12, outline: 'none',
            }}
          />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{
            padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 12, outline: 'none',
          }}>
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {memories.map(m => (
            <MemoryCard key={m.id} mem={m} onVerify={handleVerify} onForget={handleForget} />
          ))}
          {memories.length === 0 && (
            <div style={{ textAlign: 'center', padding: 30, color: '#64748b' }}>
              {search || catFilter ? 'No memories match filters' : 'No memories stored for this agent'}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
        borderRadius: 8, background: 'rgba(255,255,255,0.03)',
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0' }}>{stats?.total ?? 0}</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>Total Memories</div>
        </div>
        <div style={{ flex: 1 }} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#6366f1' }}>{stats?.agents?.length ?? 0}</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>Agents with Memory</div>
        </div>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>Agents</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(stats?.agents || []).map(a => (
          <AgentSummary key={a.agent_id} agent={a} onClick={setSelectedAgent} />
        ))}
        {(!stats?.agents || stats.agents.length === 0) && (
          <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>
            No agent memories stored yet. Memories are created when agents run and interact.
          </div>
        )}
      </div>
    </div>
  );
}
