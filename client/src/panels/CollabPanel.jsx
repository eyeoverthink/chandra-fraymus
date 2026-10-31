import React, { useState, useEffect, useCallback } from 'react';

const STRATEGIES = [
  { id: 'chain', label: 'Chain', icon: '🔗', desc: 'Sequential pipeline — each agent builds on the previous output' },
  { id: 'parallel', label: 'Parallel', icon: '⚡', desc: 'Fan-out all agents, then synthesize results' },
  { id: 'debate', label: 'Debate', icon: '⚔️', desc: 'Proponent vs Opponent, with a Judge verdict' },
];

const STATUS_COLORS = {
  pending: '#666', running: '#3b82f6', done: '#22c55e', error: '#ef4444',
};

function StrategyCard({ s, selected, onSelect }) {
  const active = selected === s.id;
  return (
    <button onClick={() => onSelect(s.id)} style={{
      flex: 1, minWidth: 140, padding: '12px 14px', borderRadius: 10,
      background: active ? '#1a1a3e' : '#111118', border: `1px solid ${active ? '#7c3aed' : '#222'}`,
      cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: 20, marginBottom: 4 }}>{s.icon}</div>
      <div style={{ color: active ? '#a78bfa' : '#ccc', fontWeight: 600, fontSize: 13 }}>{s.label}</div>
      <div style={{ color: '#666', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>{s.desc}</div>
    </button>
  );
}

function StepCard({ step, index }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
      background: '#0f0f18', borderRadius: 8, border: '1px solid #1a1a2e',
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
        background: STATUS_COLORS[step.status] || '#444', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 700,
      }}>{index + 1}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ color: '#e0e0e8', fontSize: 13, fontWeight: 600 }}>{step.agent_id}</span>
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 4,
            background: STATUS_COLORS[step.status] + '22', color: STATUS_COLORS[step.status],
          }}>{step.status}</span>
          {step.duration_ms != null && (
            <span style={{ fontSize: 10, color: '#555' }}>{(step.duration_ms / 1000).toFixed(1)}s</span>
          )}
        </div>
        {step.result && (
          <div style={{ color: '#888', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
            {step.result.slice(0, 600)}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionDetail({ session, onBack }) {
  const steps = session.steps || [];
  const result = session.result || {};
  return (
    <div style={{ padding: 16 }}>
      <button onClick={onBack} style={{
        background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer',
        fontSize: 13, padding: 0, marginBottom: 12,
      }}>&larr; Back to sessions</button>

      <div style={{
        background: '#0f0f18', borderRadius: 10, padding: 16, border: '1px solid #1a1a2e', marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>
            {STRATEGIES.find(s => s.id === session.strategy)?.icon || '?'}
          </span>
          <span style={{ color: '#e0e0e8', fontSize: 15, fontWeight: 600 }}>{session.goal}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: 'Strategy', value: session.strategy },
            { label: 'Status', value: session.status, color: STATUS_COLORS[session.status] },
            { label: 'Agents', value: (session.agents || []).join(', ') },
            { label: 'Initiator', value: session.initiator },
          ].map(p => (
            <span key={p.label} style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 6,
              background: '#111', border: '1px solid #222', color: p.color || '#aaa',
            }}>{p.label}: {p.value}</span>
          ))}
        </div>
      </div>

      <h4 style={{ color: '#888', fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
        Steps ({steps.length})
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {steps.map((step, i) => <StepCard key={step.id} step={step} index={i} />)}
        {steps.length === 0 && <div style={{ color: '#555', fontSize: 12, padding: 12 }}>No steps recorded</div>}
      </div>

      {result.finalOutput && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ color: '#888', fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Final Output
          </h4>
          <div style={{
            background: '#0f0f18', borderRadius: 8, padding: 12, border: '1px solid #1a1a2e',
            color: '#ccc', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto',
          }}>{result.finalOutput}</div>
        </div>
      )}

      {result.synthesis && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ color: '#888', fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Synthesis
          </h4>
          <div style={{
            background: '#0f0f18', borderRadius: 8, padding: 12, border: '1px solid #1a1a2e',
            color: '#ccc', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto',
          }}>{result.synthesis}</div>
        </div>
      )}

      {result.verdict && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ color: '#888', fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Judge Verdict ({result.verdict.agent})
          </h4>
          <div style={{
            background: '#0f0f18', borderRadius: 8, padding: 12, border: '1px solid #22c55e33',
            color: '#ccc', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto',
          }}>{result.verdict.decision}</div>
        </div>
      )}
    </div>
  );
}

export default function CollabPanel({ wsEvent }) {
  const [agents, setAgents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [goal, setGoal] = useState('');
  const [strategy, setStrategy] = useState('chain');
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('create');

  const fetchAgents = useCallback(() => {
    fetch('/api/fleet').then(r => r.json()).then(d => {
      const list = d.agents || d.fleet || [];
      setAgents(list.map(a => a.id || a.agentId || a.name));
    }).catch(() => {});
  }, []);

  const fetchSessions = useCallback(() => {
    fetch('/api/collab?limit=50').then(r => r.json()).then(d => {
      setSessions(Array.isArray(d) ? d : []);
    }).catch(() => {});
  }, []);

  useEffect(() => { fetchAgents(); fetchSessions(); }, [fetchAgents, fetchSessions]);

  useEffect(() => {
    if (wsEvent?.type === 'collab') fetchSessions();
  }, [wsEvent, fetchSessions]);

  const toggleAgent = (id) => {
    setSelectedAgents(prev =>
      prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]
    );
  };

  const startCollab = async () => {
    if (!goal.trim() || selectedAgents.length < 2) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim(), strategy, agents: selectedAgents }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || 'Failed');
      }
      const session = await res.json();
      setGoal('');
      setSelectedAgents([]);
      setTab('history');
      setSelectedSession(session);
      fetchSessions();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const viewSession = async (id) => {
    try {
      const r = await fetch(`/api/collab/${id}`);
      const d = await r.json();
      setSelectedSession(d);
    } catch (_) {}
  };

  if (selectedSession) {
    return <SessionDetail session={selectedSession} onBack={() => setSelectedSession(null)} />;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {['create', 'history'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: `1px solid ${tab === t ? '#7c3aed' : '#222'}`,
            background: tab === t ? '#1a1a3e' : '#111118',
            color: tab === t ? '#a78bfa' : '#666', cursor: 'pointer',
          }}>{t === 'create' ? 'New Collaboration' : `History (${sessions.length})`}</button>
        ))}
      </div>

      {tab === 'create' && (
        <div>
          <label style={{ color: '#888', fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            Goal
          </label>
          <textarea
            value={goal} onChange={e => setGoal(e.target.value)}
            placeholder="Describe what the agents should accomplish together..."
            rows={3}
            style={{
              width: '100%', background: '#0f0f18', border: '1px solid #222', borderRadius: 8,
              color: '#e0e0e8', fontSize: 13, padding: 10, resize: 'vertical',
              outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />

          <label style={{ color: '#888', fontSize: 11, fontWeight: 600, display: 'block', marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Strategy
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {STRATEGIES.map(s => <StrategyCard key={s.id} s={s} selected={strategy} onSelect={setStrategy} />)}
          </div>

          <label style={{ color: '#888', fontSize: 11, fontWeight: 600, display: 'block', marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Agents (select 2+)
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {agents.map(id => {
              const active = selectedAgents.includes(id);
              return (
                <button key={id} onClick={() => toggleAgent(id)} style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: 12,
                  border: `1px solid ${active ? '#7c3aed' : '#222'}`,
                  background: active ? '#1a1a3e' : '#111118',
                  color: active ? '#a78bfa' : '#888', cursor: 'pointer',
                  transition: 'all 0.15s',
                }}>{id}</button>
              );
            })}
            {agents.length === 0 && <span style={{ color: '#555', fontSize: 12 }}>Loading agents...</span>}
          </div>

          {error && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 6, background: '#ef444422', border: '1px solid #ef4444', color: '#ef4444', fontSize: 12 }}>
              {error}
            </div>
          )}

          <button onClick={startCollab} disabled={running || !goal.trim() || selectedAgents.length < 2} style={{
            marginTop: 16, width: '100%', padding: '10px 0', borderRadius: 8,
            background: running ? '#333' : 'linear-gradient(135deg, #7c3aed, #6d28d9)',
            border: 'none', color: '#fff', fontSize: 14, fontWeight: 600, cursor: running ? 'wait' : 'pointer',
            opacity: (!goal.trim() || selectedAgents.length < 2) ? 0.4 : 1,
          }}>
            {running ? 'Running collaboration...' : `Start ${strategy.charAt(0).toUpperCase() + strategy.slice(1)} Collaboration`}
          </button>
        </div>
      )}

      {tab === 'history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map(s => (
            <button key={s.id} onClick={() => viewSession(s.id)} style={{
              background: '#0f0f18', borderRadius: 10, padding: '12px 14px',
              border: '1px solid #1a1a2e', cursor: 'pointer', textAlign: 'left',
              transition: 'border-color 0.15s',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = '#7c3aed'}
              onMouseLeave={e => e.currentTarget.style.borderColor = '#1a1a2e'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 16 }}>
                  {STRATEGIES.find(st => st.id === s.strategy)?.icon || '?'}
                </span>
                <span style={{ color: '#e0e0e8', fontSize: 13, fontWeight: 600, flex: 1 }}>
                  {s.goal?.slice(0, 80)}{s.goal?.length > 80 ? '...' : ''}
                </span>
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 4,
                  background: STATUS_COLORS[s.status] + '22', color: STATUS_COLORS[s.status],
                }}>{s.status}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, color: '#555' }}>
                  {(s.agents || []).length} agents
                </span>
                <span style={{ fontSize: 10, color: '#555' }}>
                  {s.strategy}
                </span>
                {s.created_at && (
                  <span style={{ fontSize: 10, color: '#444' }}>
                    {new Date(s.created_at).toLocaleString()}
                  </span>
                )}
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: 40 }}>
              No collaboration sessions yet. Create one to get started.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
