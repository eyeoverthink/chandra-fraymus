import React, { useState, useEffect, useRef, useCallback } from 'react';

export default function CommandBar({ onResult, onOpenDrawer }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [agents, setAgents] = useState([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [collapsed, setCollapsed] = useState(false);

  // Dock state: 'bottom' | 'top' | null (floating)
  const [dock, setDock] = useState(() => {
    try { return localStorage.getItem('chandra_cmdbar_dock') || 'bottom'; } catch { return 'bottom'; }
  });
  // Floating position (only used when dock === null)
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('chandra_cmdbar_pos'));
      if (saved?.x != null && saved?.y != null) return saved;
    } catch {}
    return { x: window.innerWidth / 2 - 280, y: window.innerHeight - 100 };
  });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const barRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
    try { setHistory(JSON.parse(localStorage.getItem('chandra_cmd_history') || '[]')); } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem('chandra_cmdbar_dock', dock || ''); } catch {}
  }, [dock]);

  useEffect(() => {
    if (!dock) {
      try { localStorage.setItem('chandra_cmdbar_pos', JSON.stringify(pos)); } catch {}
    }
  }, [pos, dock]);

  // --- Drag handlers ---
  const onMouseDown = useCallback((e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const x = Math.max(0, Math.min(window.innerWidth - 200, e.clientX - dragOffset.current.x));
      const y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - dragOffset.current.y));
      setPos({ x, y });
      if (dock) setDock(null);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging, dock]);

  // --- Command logic ---
  const filtered = agents.filter(a =>
    input.startsWith('@') && a.id.toLowerCase().startsWith(input.slice(1).split(' ')[0].toLowerCase())
  );

  const submit = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const newHistory = [text, ...history.filter(h => h !== text)].slice(0, 50);
    setHistory(newHistory);
    setHistIdx(-1);
    try { localStorage.setItem('chandra_cmd_history', JSON.stringify(newHistory)); } catch {}

    setLoading(true);
    setResponse(null);
    setShowSuggest(false);
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.type === 'error') {
        setResponse({ type: 'error', text: data.error });
      } else if (data.type === 'agent_run') {
        setResponse({ type: 'pending', text: `${data.agentName || data.agentId} is thinking...`, threadId: data.threadId, agentId: data.agentId });
        pollThread(data.threadId);
      } else if (data.type === 'pipeline_run') {
        setResponse({ type: 'success', text: `Pipeline "${data.pipeline}" launched` + (data.runId ? ` (run ${data.runId})` : '') });
      } else if (data.type === 'workflow_run') {
        setResponse({ type: 'success', text: `Workflow "${data.workflowName}" executed` });
      }
      onResult?.(data);
    } catch (err) {
      setResponse({ type: 'error', text: err.message });
    }
    setLoading(false);
    setInput('');
  };

  const pollThread = async (threadId) => {
    let attempts = 0;
    const poll = async () => {
      if (attempts++ > 60) {
        setResponse(r => r?.threadId === threadId ? { ...r, type: 'timeout', text: (r.text || '').replace('is thinking...', 'timed out') } : r);
        return;
      }
      try {
        const res = await fetch(`/api/fleet/threads/${threadId}`);
        const thread = await res.json();
        const msgs = thread.messages || [];
        const last = msgs.filter(m => m.role === 'assistant').pop();
        if (last) {
          setResponse(r => r?.threadId === threadId ? {
            type: 'complete', agentId: r.agentId,
            text: last.content || last.text || JSON.stringify(last),
          } : r);
          return;
        }
      } catch {}
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (showSuggest && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && showSuggest)) {
        e.preventDefault();
        const agent = filtered[suggestIdx];
        if (agent) { setInput(`@${agent.id} `); setShowSuggest(false); }
        return;
      }
    }
    if (!showSuggest && e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(next);
      setInput(history[next]);
      return;
    }
    if (!showSuggest && e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(next);
      setInput(next < 0 ? '' : history[next]);
    }
  };

  const handleChange = (e) => {
    const val = e.target.value;
    setInput(val);
    setHistIdx(-1);
    const atPos = val.lastIndexOf('@');
    if (atPos >= 0 && !val.slice(atPos).includes(' ')) {
      setShowSuggest(true);
      setSuggestIdx(0);
    } else {
      setShowSuggest(false);
    }
  };

  const selectAgent = (agent) => {
    setInput(`@${agent.id} `);
    setShowSuggest(false);
    inputRef.current?.focus();
  };

  const cycleDock = () => {
    if (dock === 'bottom') setDock('top');
    else if (dock === 'top') setDock('bottom');
    else setDock('bottom');
  };

  // Compute positioned style
  const containerStyle = (() => {
    const base = {
      position: 'fixed',
      left: 0,
      right: 0,
      zIndex: 900,
      padding: '0 24px',
      pointerEvents: 'none',
      transition: dragging ? 'none' : 'all 0.25s ease',
    };
    if (dock === 'bottom') return { ...base, bottom: 12, top: 'auto' };
    if (dock === 'top') return { ...base, top: 60, bottom: 'auto' };
    // floating
    return {
      position: 'fixed',
      left: pos.x,
      top: pos.y,
      zIndex: 900,
      width: Math.min(560, window.innerWidth - 48),
      pointerEvents: 'none',
      transition: dragging ? 'none' : 'all 0.25s ease',
    };
  })();

  const innerMaxWidth = dock ? 720 : undefined;

  return (
    <div style={containerStyle}>
      <div ref={barRef} onMouseDown={onMouseDown} style={{
        maxWidth: innerMaxWidth,
        margin: dock ? '0 auto' : undefined,
        pointerEvents: 'auto',
        cursor: dragging ? 'grabbing' : 'default',
        userSelect: dragging ? 'none' : 'auto',
      }}>
        {/* Response panel */}
        {response && !collapsed && (
          <div style={{
            background: '#0d0d15ee', borderRadius: 12, border: '1px solid #222',
            padding: 16, marginBottom: 6, maxHeight: 200, overflowY: 'auto',
            backdropFilter: 'blur(12px)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1,
                color: response.type === 'error' ? '#ef4444' : response.type === 'pending' ? '#f59e0b'
                  : response.type === 'timeout' ? '#ef4444' : '#22c55e',
              }}>
                {response.type === 'pending' ? '● Processing' : response.type === 'error' ? '✗ Error'
                  : response.type === 'timeout' ? '✗ Timeout' : '✓ Complete'}
              </span>
              <button onClick={() => setResponse(null)} style={{
                background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14,
              }}>✕</button>
            </div>
            <div style={{
              fontSize: 13, color: '#e0e0e8', lineHeight: 1.6, whiteSpace: 'pre-wrap',
            }}>{response.text}</div>
            {response.type === 'complete' && response.agentId && (
              <button onClick={() => onOpenDrawer?.('fleet', 'Agent Fleet')} style={{
                marginTop: 8, background: '#6366f120', border: '1px solid #6366f140',
                borderRadius: 6, padding: '4px 12px', color: '#6366f1', fontSize: 11,
                cursor: 'pointer', fontWeight: 500,
              }}>View in Fleet Panel</button>
            )}
          </div>
        )}

        {/* Autocomplete suggestions */}
        {showSuggest && filtered.length > 0 && (
          <div style={{
            marginBottom: 4,
            background: '#111118ee', border: '1px solid #333', borderRadius: 8,
            maxHeight: 200, overflowY: 'auto',
            backdropFilter: 'blur(12px)',
          }}>
            {filtered.map((a, i) => (
              <button key={a.id} onClick={() => selectAgent(a)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '8px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
                  background: i === suggestIdx ? '#a78bfa18' : 'transparent',
                  color: i === suggestIdx ? '#a78bfa' : '#ccc', fontSize: 12,
                }}
                onMouseEnter={() => setSuggestIdx(i)}
              >
                <span style={{ color: '#6366f1', fontWeight: 600 }}>@{a.id}</span>
                <span style={{ color: '#666' }}>{a.name} — {a.role || a.description || 'agent'}</span>
              </button>
            ))}
          </div>
        )}

        {/* Main input bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#0d0d15ee', borderRadius: 12, border: '1px solid #333',
          padding: '8px 12px',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}>
          {/* Drag grip */}
          <span
            style={{
              cursor: 'grab', color: '#444', fontSize: 14, flexShrink: 0,
              padding: '2px 4px', borderRadius: 4, lineHeight: 1,
              userSelect: 'none',
            }}
            title={dock ? `Docked ${dock} — drag to undock` : 'Drag to move'}
          >⠿</span>

          <span style={{ color: '#a78bfa', fontSize: 16, flexShrink: 0 }}>◈</span>

          {collapsed ? (
            <button onClick={() => setCollapsed(false)} style={{
              flex: 1, background: 'transparent', border: 'none', color: '#666',
              fontSize: 13, textAlign: 'left', cursor: 'pointer',
            }}>Command Bar (click to expand)</button>
          ) : (
            <input ref={inputRef} value={input} onChange={handleChange} onKeyDown={onKeyDown}
              placeholder="Type a command... (@agent, run pipeline, or just ask)"
              disabled={loading}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: '#e0e0e8', fontSize: 14, fontFamily: 'inherit',
              }}
            />
          )}

          {!collapsed && (
            <button onClick={submit} disabled={loading || !input.trim()} style={{
              background: loading ? '#333' : '#a78bfa20', border: '1px solid #a78bfa40',
              borderRadius: 8, padding: '6px 12px', color: loading ? '#666' : '#a78bfa',
              cursor: loading ? 'default' : 'pointer', fontSize: 13, fontWeight: 500,
              transition: 'all 0.15s', flexShrink: 0,
            }}>
              {loading ? '...' : '⏎'}
            </button>
          )}

          {/* Dock toggle */}
          <button onClick={cycleDock} title={dock === 'bottom' ? 'Dock to top' : dock === 'top' ? 'Dock to bottom' : 'Dock to bottom'} style={{
            background: 'none', border: '1px solid #333', borderRadius: 6,
            color: dock ? '#a78bfa' : '#555', cursor: 'pointer', fontSize: 11,
            padding: '4px 6px', flexShrink: 0, lineHeight: 1,
          }}>
            {dock === 'top' ? '▼' : dock === 'bottom' ? '▲' : '⊡'}
          </button>

          {/* Collapse toggle */}
          <button onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand' : 'Collapse'} style={{
            background: 'none', border: 'none', color: '#555', cursor: 'pointer',
            fontSize: 12, padding: '2px 4px', flexShrink: 0, lineHeight: 1,
          }}>
            {collapsed ? '◇' : '–'}
          </button>
        </div>
      </div>
    </div>
  );
}
