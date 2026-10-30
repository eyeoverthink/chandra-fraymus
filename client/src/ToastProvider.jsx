import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

let idCounter = 0;

const VARIANTS = {
  info:    { bg: '#1e293b', border: '#334155', icon: 'ℹ', color: '#60a5fa' },
  success: { bg: '#052e16', border: '#166534', icon: '✓', color: '#4ade80' },
  warning: { bg: '#422006', border: '#854d0e', icon: '⚠', color: '#fbbf24' },
  error:   { bg: '#350a0a', border: '#991b1b', icon: '✕', color: '#f87171' },
  agent:   { bg: '#1a0a2e', border: '#6d28d9', icon: '◈', color: '#a78bfa' },
  system:  { bg: '#0c1222', border: '#1e40af', icon: '⚙', color: '#60a5fa' },
};

const WS_MAP = {
  agents:        { variant: 'agent',   fmt: p => p?.action === 'started' ? `Agent ${p.agentName || p.agentId || ''} started` : 'Agent activity' },
  workflow:      { variant: 'info',    fmt: p => `Workflow ${p?.type || 'updated'}${p?.id ? ` #${String(p.id).slice(0,6)}` : ''}` },
  forge:         { variant: 'success', fmt: () => 'New agent forged' },
  autonomy:      { variant: 'system',  fmt: p => `Autonomy ${p?.type || 'event'}` },
  heart:         { variant: 'agent',   fmt: p => `Feeling: ${p?.primary || 'shift'}${p?.intensity ? ` (${Math.round(p.intensity * 100)}%)` : ''}` },
  dreamer:       { variant: 'agent',   fmt: p => p?.action === 'dream' ? `Dream #${p.number}` : `Dreamer: ${p?.action || 'active'}` },
  cognition:     { variant: 'info',    fmt: p => `Cognition cycle${p?.phase ? `: ${p.phase}` : ''}` },
  consciousness: { variant: 'success', fmt: p => `Ouroboros: ${p?.allPassed ? 'all passed' : 'tests ran'}` },
  intelligence:  { variant: 'system',  fmt: () => 'Intelligence cycle complete' },
  needle:        { variant: 'info',    fmt: p => `Needle: ${p?.type?.replace(/_/g, ' ') || 'event'}` },
  motor:         { variant: 'info',    fmt: p => `Motor: ${p?.type || 'dispatch'}` },
  deploy:        { variant: p => p?.status === 'error' ? 'error' : 'success', fmt: p => `API /${p?.slug || '?'}: ${p?.durationMs || 0}ms` },
  health:        { variant: 'system',  fmt: () => 'Health check updated' },
  tasks:         { variant: 'info',    fmt: p => `Task: ${p?.type || 'event'}` },
  memory:        { variant: 'info',    fmt: p => `Memory updated${p?.key ? `: ${p.key}` : ''}` },
  reflection:    { variant: 'system',  fmt: () => 'Reflection cycle complete' },
  ledger:        { variant: 'info',    fmt: p => `Ledger: ${p?.kind || 'entry'} #${p?.seq || '?'}` },
};

export default function ToastProvider({ children, wsEvent }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 300);
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const push = useCallback((message, variant = 'info', duration = 4000) => {
    const id = ++idCounter;
    setToasts(prev => {
      const next = [...prev, { id, message, variant, leaving: false }];
      return next.length > 6 ? next.slice(-6) : next;
    });
    const timer = setTimeout(() => dismiss(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismiss]);

  const prevTs = useRef(0);
  useEffect(() => {
    if (!wsEvent || !wsEvent.type || wsEvent.ts === prevTs.current) return;
    prevTs.current = wsEvent.ts;
    const mapping = WS_MAP[wsEvent.type];
    if (!mapping) return;
    const v = typeof mapping.variant === 'function' ? mapping.variant(wsEvent.payload) : mapping.variant;
    const msg = mapping.fmt(wsEvent.payload);
    push(msg, v);
  }, [wsEvent, push]);

  return (
    <ToastCtx.Provider value={{ push, dismiss }}>
      {children}
      <div style={{
        position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
        display: 'flex', flexDirection: 'column-reverse', gap: 8,
        pointerEvents: 'none', maxWidth: 360,
      }}>
        {toasts.map(t => {
          const v = VARIANTS[t.variant] || VARIANTS.info;
          return (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', borderRadius: 10,
              background: v.bg, border: `1px solid ${v.border}`,
              color: '#e2e8f0', fontSize: 13, fontFamily: 'system-ui, sans-serif',
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
              pointerEvents: 'auto', cursor: 'pointer',
              animation: t.leaving ? 'toast-out 0.3s forwards' : 'toast-in 0.3s forwards',
              maxWidth: 360,
            }} onClick={() => dismiss(t.id)}>
              <span style={{ fontSize: 15, color: v.color, flexShrink: 0, width: 18, textAlign: 'center' }}>{v.icon}</span>
              <span style={{ flex: 1, lineHeight: 1.35 }}>{t.message}</span>
              <span style={{ fontSize: 16, color: '#555', flexShrink: 0, marginLeft: 4 }}>×</span>
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes toast-in { from { opacity: 0; transform: translateY(12px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes toast-out { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(12px) scale(0.95); } }
      `}</style>
    </ToastCtx.Provider>
  );
}
