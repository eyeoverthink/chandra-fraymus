import React, { useState, useEffect, useCallback } from 'react';

export default function FleetPanel() {
  const [agents, setAgents] = useState([]);
  const [threads, setThreads] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [activeThread, setActiveThread] = useState(null);

  const load = useCallback(() => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
    fetch('/api/fleet/threads').then(r => r.json()).then(d => setThreads(d.threads || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const sendMessage = async () => {
    if (!selectedAgent || !message.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/fleet/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgent, message: message.trim() }),
      });
      const data = await res.json();
      setMessage('');
      setActiveThread(data.threadId);
      setTimeout(load, 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', marginBottom: 20 }}>Agent Fleet — 16 Specialist Agents</h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260, 1fr))', gap: 12, marginBottom: 24 }}>
        {agents.map(a => (
          <div key={a.id} onClick={() => setSelectedAgent(a.id)} style={{
            background: selectedAgent === a.id ? '#1a1a3e' : '#111118',
            border: `1px solid ${selectedAgent === a.id ? '#a78bfa' : '#222'}`,
            borderRadius: 12, padding: 16, cursor: 'pointer', transition: 'all 0.15s',
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8' }}>{a.name}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{a.role || a.description || 'Specialist'}</div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 6 }}>
              Tools: {Array.isArray(a.tools) ? a.tools.length : a.tools === '*' ? 'all' : '—'}
              {a.source && ` · ${a.source}`}
            </div>
          </div>
        ))}
      </div>

      {selectedAgent && (
        <div style={{ background: '#111118', borderRadius: 12, padding: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa', marginBottom: 12 }}>
            Send task to: {agents.find(a => a.id === selectedAgent)?.name || selectedAgent}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={message} onChange={e => setMessage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()}
              placeholder="Enter a task for this agent..."
              style={{
                flex: 1, background: '#1a1a2e', border: '1px solid #333', borderRadius: 8,
                padding: '10px 14px', color: '#e0e0e8', fontSize: 13,
              }} />
            <button onClick={sendMessage} disabled={sending} style={{
              background: '#6366f1', border: 'none', borderRadius: 8, padding: '10px 20px',
              color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>{sending ? 'Sending...' : 'Send'}</button>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 15, fontWeight: 600, color: '#888', marginBottom: 12 }}>Recent Threads</h3>
      {threads.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>No conversations yet. Select an agent and send a message.</div>}
      {threads.map(t => (
        <div key={t.id} style={{
          background: '#111118', borderRadius: 8, padding: '12px 16px', marginBottom: 8,
          border: '1px solid #222',
        }}>
          <div style={{ fontSize: 13, color: '#e0e0e8' }}>{t.title || t.agent_id}</div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            Agent: {t.agent_id} · {new Date(t.created_at).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
