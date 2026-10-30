import React, { useState, useEffect, useRef, useCallback } from 'react';

export default function AgentChatPanel({ wsEvent }) {
  const [agents, setAgents] = useState([]);
  const [activeAgent, setActiveAgent] = useState(null);
  const [threadId, setThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [polling, setPolling] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setPolling(false);
  }, []);

  const pollThread = useCallback((tid) => {
    stopPolling();
    setPolling(true);
    const check = async () => {
      try {
        const res = await fetch(`/api/fleet/threads/${tid}`);
        const data = await res.json();
        if (data.messages) setMessages(data.messages);
        const hasRunning = data.runs?.some(r => r.status === 'running');
        if (!hasRunning) stopPolling();
      } catch { stopPolling(); }
    };
    check();
    pollRef.current = setInterval(check, 1500);
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    if (wsEvent?.type === 'fleet' && threadId) pollThread(threadId);
  }, [wsEvent, threadId, pollThread]);

  const selectAgent = (agent) => {
    stopPolling();
    setActiveAgent(agent);
    setThreadId(null);
    setMessages([]);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const loadThread = async (tid) => {
    try {
      const res = await fetch(`/api/fleet/threads/${tid}`);
      const data = await res.json();
      if (data.messages) setMessages(data.messages);
      setThreadId(tid);
    } catch {}
  };

  const send = async () => {
    if (!activeAgent || !input.trim() || sending) return;
    const msg = input.trim();
    setSending(true);
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: msg, id: `temp-${Date.now()}` }]);
    try {
      const res = await fetch('/api/fleet/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: activeAgent.id, message: msg, threadId }),
      });
      const data = await res.json();
      if (data.threadId) {
        setThreadId(data.threadId);
        pollThread(data.threadId);
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${e.message}`, id: `err-${Date.now()}` }]);
    } finally {
      setSending(false);
    }
  };

  const roleStyle = (role) => {
    if (role === 'user') return { bg: '#1e1b4b', border: '#6366f1', color: '#c7d2fe', align: 'flex-end', label: 'You' };
    if (role === 'assistant') return { bg: '#1a1a2e', border: '#a78bfa', color: '#e2e8f0', align: 'flex-start', label: activeAgent?.name || 'Agent' };
    if (role === 'tool') return { bg: '#0a1a1a', border: '#10b981', color: '#6ee7b7', align: 'flex-start', label: 'Tool' };
    return { bg: '#1a1a1a', border: '#444', color: '#888', align: 'flex-start', label: role };
  };

  if (!activeAgent) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', marginBottom: 8 }}>Agent Chat</h2>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 24 }}>Select an agent to start a conversation</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          {agents.map(a => (
            <button key={a.id} onClick={() => selectAgent(a)} style={{
              background: '#111118', border: '1px solid #222', borderRadius: 12,
              padding: 16, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#a78bfa'; e.currentTarget.style.background = '#14141e'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#222'; e.currentTarget.style.background = '#111118'; }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8' }}>{a.name}</div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 4, lineHeight: 1.4 }}>
                {(a.role || a.description || 'Specialist').slice(0, 80)}
              </div>
              <div style={{ fontSize: 10, color: '#555', marginTop: 8 }}>
                {Array.isArray(a.tools) ? `${a.tools.length} tools` : a.tools === '*' ? 'All tools' : ''}
                {a.model ? ` · ${a.model}` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        borderBottom: '1px solid #222', flexShrink: 0,
      }}>
        <button onClick={() => { stopPolling(); setActiveAgent(null); setThreadId(null); setMessages([]); }} style={{
          background: 'none', border: '1px solid #333', borderRadius: 6,
          padding: '4px 10px', color: '#888', cursor: 'pointer', fontSize: 12,
        }}>← Back</button>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa' }}>{activeAgent.name}</div>
          <div style={{ fontSize: 11, color: '#666' }}>{activeAgent.role || activeAgent.description || 'Specialist'}</div>
        </div>
        {polling && (
          <span style={{
            marginLeft: 'auto', fontSize: 10, color: '#f59e0b',
            display: 'flex', alignItems: 'center', gap: 4,
            animation: 'pulse 1.5s infinite',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b' }} />
            Thinking...
          </span>
        )}
        {threadId && !polling && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#22c55e', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
            Ready
          </span>
        )}
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#444' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>◈</div>
            <div style={{ fontSize: 14 }}>Start a conversation with {activeAgent.name}</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Type a message below to begin</div>
          </div>
        )}

        {messages.filter(m => m.role !== 'tool').map((m, i) => {
          const s = roleStyle(m.role);
          return (
            <div key={m.id || i} style={{
              display: 'flex', flexDirection: 'column', alignItems: s.align,
              marginBottom: 12, maxWidth: '85%',
              alignSelf: s.align,
              marginLeft: s.align === 'flex-end' ? 'auto' : 0,
              marginRight: s.align === 'flex-start' ? 'auto' : 0,
            }}>
              <div style={{ fontSize: 10, color: '#555', marginBottom: 4, paddingLeft: 4 }}>{s.label}</div>
              <div style={{
                background: s.bg, border: `1px solid ${s.border}30`,
                borderRadius: 12, padding: '10px 14px',
                borderTopLeftRadius: s.align === 'flex-start' ? 4 : 12,
                borderTopRightRadius: s.align === 'flex-end' ? 4 : 12,
              }}>
                <div style={{
                  fontSize: 13, color: s.color, lineHeight: 1.6,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{m.content}</div>
              </div>
            </div>
          );
        })}

        {polling && messages.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px' }}>
            <div style={{
              display: 'flex', gap: 4,
              animation: 'pulse 1.2s infinite',
            }}>
              {[0, 1, 2].map(d => (
                <span key={d} style={{
                  width: 6, height: 6, borderRadius: '50%', background: '#a78bfa',
                  opacity: 0.4, animationDelay: `${d * 0.15}s`,
                }} />
              ))}
            </div>
            <span style={{ fontSize: 11, color: '#666' }}>{activeAgent.name} is thinking...</span>
          </div>
        )}
      </div>

      <div style={{
        padding: '12px 20px', borderTop: '1px solid #222', flexShrink: 0,
        display: 'flex', gap: 8,
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder={`Message ${activeAgent.name}...`}
          disabled={sending}
          style={{
            flex: 1, background: '#1a1a2e', border: '1px solid #333', borderRadius: 10,
            padding: '12px 16px', color: '#e0e0e8', fontSize: 14,
            outline: 'none', fontFamily: 'system-ui, sans-serif',
          }}
        />
        <button onClick={send} disabled={sending || !input.trim()} style={{
          background: sending ? '#444' : '#6366f1', border: 'none', borderRadius: 10,
          padding: '12px 24px', color: '#fff', fontSize: 14, fontWeight: 600,
          cursor: sending ? 'default' : 'pointer', transition: 'background 0.15s',
          opacity: !input.trim() && !sending ? 0.5 : 1,
        }}>
          {sending ? '...' : 'Send'}
        </button>
      </div>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
    </div>
  );
}
