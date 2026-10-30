import React, { useState, useEffect, useCallback } from 'react';

export default function FleetPanel({ wsEvent }) {
  const [agents, setAgents] = useState([]);
  const [threads, setThreads] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentDetail, setAgentDetail] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [activeThread, setActiveThread] = useState(null);
  const [threadDetail, setThreadDetail] = useState(null);

  const load = useCallback(() => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
    fetch('/api/fleet/threads').then(r => r.json()).then(d => setThreads(d.threads || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type && ['agents', 'agent', 'event'].includes(wsEvent.type)) load();
  }, [wsEvent, load]);

  const selectAgent = async (id) => {
    setSelectedAgent(id);
    setAgentDetail(null);
    try {
      const res = await fetch(`/api/fleet/agents/${id}`);
      const data = await res.json();
      setAgentDetail(data);
    } catch {}
  };

  const openThread = async (id) => {
    setActiveThread(id);
    setThreadDetail(null);
    try {
      const res = await fetch(`/api/fleet/threads/${id}`);
      const data = await res.json();
      setThreadDetail(data);
    } catch {}
  };

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
      if (data.threadId) openThread(data.threadId);
      setTimeout(load, 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const roleColor = role => {
    if (role === 'assistant') return '#a78bfa';
    if (role === 'user') return '#6366f1';
    if (role === 'tool') return '#10b981';
    return '#888';
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', marginBottom: 20 }}>Agent Fleet — {agents.length} Specialist Agents</h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginBottom: 24 }}>
        {agents.map(a => (
          <div key={a.id} onClick={() => selectAgent(a.id)} style={{
            background: selectedAgent === a.id ? '#1a1a3e' : '#111118',
            border: `1px solid ${selectedAgent === a.id ? '#a78bfa' : '#222'}`,
            borderRadius: 12, padding: 16, cursor: 'pointer', transition: 'all 0.15s',
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8' }}>{a.name}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{a.role || a.description || 'Specialist'}</div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 6 }}>
              Tools: {Array.isArray(a.tools) ? a.tools.length : a.tools === '*' ? 'all' : '—'}
              {a.model && ` · ${a.model}`}
            </div>
          </div>
        ))}
      </div>

      {selectedAgent && agentDetail && (
        <div style={{ background: '#111118', borderRadius: 12, padding: 20, marginBottom: 24, border: '1px solid #a78bfa30' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#a78bfa' }}>{agentDetail.name}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{agentDetail.role || agentDetail.description}</div>
            </div>
            {agentDetail.model && (
              <span style={{ fontSize: 10, padding: '4px 8px', borderRadius: 6, background: '#6366f120', color: '#6366f1' }}>
                {agentDetail.model}
              </span>
            )}
          </div>
          {Array.isArray(agentDetail.tools) && agentDetail.tools.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>Tools</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {agentDetail.tools.map(t => (
                  <span key={t} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, background: '#10b98115', color: '#10b981' }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {agentDetail.systemPrompt && (
            <div>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>System Prompt</div>
              <pre style={{ fontSize: 11, color: '#888', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto',
                background: '#0a0a14', borderRadius: 6, padding: 10 }}>
                {agentDetail.systemPrompt.slice(0, 500)}{agentDetail.systemPrompt.length > 500 ? '...' : ''}
              </pre>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#a78bfa', marginBottom: 8 }}>Send task</div>
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
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: activeThread ? '300px 1fr' : '1fr', gap: 16 }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#888', marginBottom: 12 }}>Recent Threads</h3>
          {threads.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>No conversations yet.</div>}
          {threads.map(t => (
            <div key={t.id} onClick={() => openThread(t.id)} style={{
              background: activeThread === t.id ? '#1a1a3e' : '#111118',
              borderRadius: 8, padding: '12px 16px', marginBottom: 8, cursor: 'pointer',
              border: `1px solid ${activeThread === t.id ? '#6366f1' : '#222'}`,
              transition: 'all 0.15s',
            }}>
              <div style={{ fontSize: 13, color: '#e0e0e8' }}>{t.title || t.agent_id}</div>
              <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                Agent: {t.agent_id} · {new Date(t.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>

        {activeThread && threadDetail && (
          <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e8' }}>
                {threadDetail.title || threadDetail.agent_id}
              </h3>
              <button onClick={() => { setActiveThread(null); setThreadDetail(null); }}
                style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>×</button>
            </div>

            {threadDetail.runs && threadDetail.runs.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {threadDetail.runs.map(r => (
                  <div key={r.id} style={{ fontSize: 10, color: '#666', padding: '4px 8px', borderRadius: 4,
                    background: r.status === 'done' ? '#22c55e10' : r.status === 'running' ? '#f59e0b10' : '#ef444410',
                    marginBottom: 4, display: 'inline-block', marginRight: 6 }}>
                    Run: {r.status} {r.model && `· ${r.model}`}
                  </div>
                ))}
              </div>
            )}

            {threadDetail.approvals && threadDetail.approvals.length > 0 && (
              <div style={{ background: '#f59e0b15', borderRadius: 8, padding: 12, marginBottom: 12, border: '1px solid #f59e0b30' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b', marginBottom: 6 }}>Pending Approvals</div>
                {threadDetail.approvals.map(a => (
                  <div key={a.id} style={{ fontSize: 11, color: '#888' }}>{a.tool_name}: {a.description || 'Awaiting approval'}</div>
                ))}
              </div>
            )}

            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {(threadDetail.messages || []).map((m, i) => (
                <div key={m.id || i} style={{ marginBottom: 12, paddingLeft: m.role === 'assistant' ? 12 : 0 }}>
                  <div style={{ fontSize: 10, color: roleColor(m.role), fontWeight: 600, marginBottom: 2, textTransform: 'capitalize' }}>
                    {m.role}
                  </div>
                  <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                    {(m.content || '').slice(0, 1000)}{(m.content || '').length > 1000 ? '...' : ''}
                  </div>
                  {m.tool_calls && m.tool_calls.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {m.tool_calls.map((tc, j) => (
                        <span key={j} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3,
                          background: '#10b98115', color: '#10b981', marginRight: 4 }}>
                          {tc.function?.name || tc.name || 'tool'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
