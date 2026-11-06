import React, { useState, useEffect, useCallback, useRef } from 'react';

const CATEGORY_STYLES = {
  health:       { bg: '#1c0a0a', border: '#7f1d1d', icon: '♥', color: '#f87171', label: 'Health' },
  intelligence: { bg: '#1a0a2e', border: '#6d28d9', icon: '⚡', color: '#a78bfa', label: 'Intelligence' },
  fleet:        { bg: '#0a1628', border: '#1e40af', icon: '◈', color: '#60a5fa', label: 'Fleet' },
  user_context: { bg: '#1a1408', border: '#854d0e', icon: '◉', color: '#fbbf24', label: 'Context' },
  suggestions:  { bg: '#0a1c14', border: '#166534', icon: '◆', color: '#4ade80', label: 'Suggestion' },
};

const DEFAULT_STYLE = { bg: '#1e293b', border: '#334155', icon: 'ℹ', color: '#94a3b8', label: 'System' };

let nudgeId = 0;

export default function NudgeToast({ wsEvent, onNavigate }) {
  const [nudges, setNudges] = useState([]);
  const [dnd, setDnd] = useState(false);
  const [showDndToggle, setShowDndToggle] = useState(false);
  const timersRef = useRef({});

  const dismiss = useCallback((id) => {
    setNudges(prev => prev.filter(n => n.id !== id));
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id]);
      delete timersRef.current[id];
    }
  }, []);

  const addNudge = useCallback((nudge) => {
    const id = ++nudgeId;
    const entry = { id, ...nudge, enteredAt: Date.now() };
    setNudges(prev => {
      const next = [...prev, entry];
      if (next.length > 5) return next.slice(-5);
      return next;
    });
    timersRef.current[id] = setTimeout(() => dismiss(id), 10000);
  }, [dismiss]);

  useEffect(() => {
    if (!wsEvent || wsEvent.type !== 'nudge' || dnd) return;
    const p = wsEvent.payload || wsEvent;
    addNudge({
      category: p.category || 'suggestions',
      title: p.title || 'System nudge',
      body: p.body || '',
      priority: p.priority || 'info',
    });
  }, [wsEvent, dnd, addNudge]);

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(clearTimeout);
    };
  }, []);

  const toggleDnd = useCallback(async () => {
    const next = !dnd;
    setDnd(next);
    try {
      await fetch('/api/awareness/nudge/dnd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
    } catch (_) {}
  }, [dnd]);

  return (
    <>
      {/* DND indicator in bottom-right corner */}
      <div style={{
        position: 'fixed', bottom: 12, right: 12, zIndex: 1001,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
        pointerEvents: 'none',
      }}>
        {/* DND toggle button */}
        <button
          onClick={toggleDnd}
          onMouseEnter={() => setShowDndToggle(true)}
          onMouseLeave={() => setShowDndToggle(false)}
          style={{
            pointerEvents: 'auto',
            width: 28, height: 28, borderRadius: '50%',
            border: `1px solid ${dnd ? '#f87171' : '#333'}`,
            background: dnd ? '#2a0a0a' : '#151520',
            color: dnd ? '#f87171' : '#555',
            fontSize: 12, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.2s',
            opacity: showDndToggle || dnd ? 1 : 0.4,
          }}
          title={dnd ? 'Do Not Disturb ON — click to disable' : 'Enable Do Not Disturb'}
        >
          {dnd ? '🔕' : '🔔'}
        </button>
      </div>

      {/* Nudge toasts */}
      <div style={{
        position: 'fixed', bottom: 48, right: 12, zIndex: 1000,
        display: 'flex', flexDirection: 'column-reverse', gap: 8,
        maxHeight: '50vh', overflow: 'hidden',
        pointerEvents: 'none',
      }}>
        {nudges.map(nudge => {
          const style = CATEGORY_STYLES[nudge.category] || DEFAULT_STYLE;
          return (
            <div key={nudge.id} style={{
              pointerEvents: 'auto',
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 14px', borderRadius: 10, minWidth: 280, maxWidth: 380,
              background: style.bg, border: `1px solid ${style.border}`,
              boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${style.border}33`,
              animation: 'nudge-slide-in 0.3s ease-out',
              cursor: 'pointer',
              transition: 'opacity 0.2s, transform 0.2s',
            }}
              onClick={() => dismiss(nudge.id)}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateX(-4px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateX(0)'; }}
            >
              <span style={{ fontSize: 16, color: style.color, flexShrink: 0, marginTop: 1 }}>
                {style.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: style.color, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                    {style.label}
                  </span>
                  {nudge.priority === 'warning' && (
                    <span style={{ fontSize: 8, color: '#fbbf24', background: '#422006', padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>
                      WARN
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#ddd', lineHeight: 1.4 }}>
                  {nudge.title}
                </div>
                {nudge.body && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 3, lineHeight: 1.3 }}>
                    {nudge.body}
                  </div>
                )}
              </div>
              <button onClick={(e) => { e.stopPropagation(); dismiss(nudge.id); }} style={{
                background: 'none', border: 'none', color: '#555', fontSize: 14,
                cursor: 'pointer', padding: 0, flexShrink: 0, lineHeight: 1,
              }}>×</button>
            </div>
          );
        })}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes nudge-slide-in {
          from { opacity: 0; transform: translateX(80px); }
          to { opacity: 1; transform: translateX(0); }
        }
      ` }} />
    </>
  );
}
