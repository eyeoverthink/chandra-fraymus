import React, { useState, useEffect, useCallback, useRef } from 'react';

const PROTOCOLS = [
  { id: 'sentinel',  label: 'Sentinel',  icon: '◎', color: '#9ca3af', desc: 'Balanced monitoring and response' },
  { id: 'deep_work', label: 'Deep Work', icon: '◉', color: '#60a5fa', desc: 'Minimal interruptions, max depth' },
  { id: 'creative',  label: 'Creative',  icon: '✦', color: '#a78bfa', desc: 'Relaxed constraints, exploration' },
  { id: 'research',  label: 'Research',  icon: '◈', color: '#34d399', desc: 'Systematic, citation tracking' },
  { id: 'lockdown',  label: 'Lockdown',  icon: '◆', color: '#f87171', desc: 'Manual-only, minimal autonomy' },
];

export default function ProtocolSelector() {
  const [active, setActive] = useState('sentinel');
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    fetch('/api/awareness/protocol')
      .then(r => r.json())
      .then(d => { if (d.active?.name) setActive(d.active.name); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const activate = useCallback(async (name) => {
    if (name === active || loading) return;
    setLoading(true);
    try {
      const res = await fetch('/api/awareness/protocol/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: name, reason: 'user_selection' }),
      });
      const d = await res.json();
      if (d.activated) setActive(name);
    } catch (_) {}
    setLoading(false);
    setIsOpen(false);
  }, [active, loading]);

  const current = PROTOCOLS.find(p => p.id === active) || PROTOCOLS[0];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 10px', border: `1px solid ${isOpen ? current.color : '#444'}`,
          borderRadius: 6, background: isOpen ? `${current.color}15` : 'none',
          color: isOpen ? current.color : '#aaa', fontSize: 13,
          cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (!isOpen) { e.currentTarget.style.borderColor = current.color; e.currentTarget.style.color = current.color; }}}
        onMouseLeave={e => { if (!isOpen) { e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#aaa'; }}}
      >
        <span style={{ fontSize: 12, color: current.color }}>{current.icon}</span>
        <span className="nav-btn-label" style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>
          {current.label}
        </span>
        <span style={{ fontSize: 8, marginLeft: 2, opacity: 0.5 }}>{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          background: '#151520', border: '1px solid #333', borderRadius: 8,
          padding: '4px 0', minWidth: 220, zIndex: 100,
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          <div style={{ padding: '6px 14px 4px', fontSize: 9, color: '#555', letterSpacing: 1, fontWeight: 700, textTransform: 'uppercase' }}>
            Operational Protocol
          </div>
          {PROTOCOLS.map(p => (
            <button key={p.id} onClick={() => activate(p.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 14px', border: 'none', cursor: p.id === active ? 'default' : 'pointer',
                background: p.id === active ? `${p.color}12` : 'transparent',
                color: p.id === active ? p.color : '#ccc', fontSize: 13, textAlign: 'left',
                transition: 'background 0.1s, color 0.1s',
                opacity: loading ? 0.5 : 1,
              }}
              onMouseEnter={e => { if (p.id !== active) { e.currentTarget.style.background = `${p.color}15`; e.currentTarget.style.color = p.color; }}}
              onMouseLeave={e => { if (p.id !== active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#ccc'; }}}
            >
              <span style={{ fontSize: 14, width: 20, textAlign: 'center', color: p.color }}>{p.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: p.id === active ? 600 : 400, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.label}
                  {p.id === active && (
                    <span style={{ fontSize: 8, color: p.color, background: `${p.color}20`, padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>
                      ACTIVE
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>{p.desc}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
