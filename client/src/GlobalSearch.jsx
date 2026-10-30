import React, { useState, useRef, useEffect, useCallback } from 'react';

const CATEGORY_META = {
  agents:      { icon: '◈', color: '#a78bfa', label: 'Agents' },
  workflows:   { icon: '⬡', color: '#60a5fa', label: 'Workflows' },
  memories:    { icon: '◆', color: '#34d399', label: 'Memories' },
  bus:         { icon: '⚡', color: '#fbbf24', label: 'Bus Messages' },
  commerce:    { icon: '◇', color: '#f472b6', label: 'Commerce' },
  threads:     { icon: '▤', color: '#818cf8', label: 'Threads' },
  reflections: { icon: '⚙', color: '#94a3b8', label: 'Reflections' },
  forged:      { icon: '🔧', color: '#fb923c', label: 'Forged Agents' },
};

export default function GlobalSearch({ onOpenDrawer, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const search = useCallback((q) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q || q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`);
        const data = await r.json();
        setResults(data.results || []);
      } catch { setResults([]); }
      setLoading(false);
    }, 250);
  }, []);

  const handleChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    search(v);
  };

  const handleSelect = (result) => {
    setOpen(false);
    setQuery('');
    setResults([]);
    if (result.panel === 'canvas') {
      onNavigate?.('canvas');
    } else {
      const panelMap = {
        fleet: 'fleet', vertiso: 'vertiso', bus: 'bus', commerce: 'commerce',
        health: 'health', forge: 'forge',
      };
      const panel = panelMap[result.panel] || result.panel;
      onOpenDrawer?.(panel, result.title);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); setResults([]); }
  };

  const grouped = {};
  for (const r of results) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{
          background: 'none', border: '1px solid #333', borderRadius: 6,
          color: '#666', fontSize: 13, padding: '4px 10px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#555'; e.currentTarget.style.color = '#999'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#666'; }}
        >
          <span style={{ fontSize: 12 }}>⌕</span>
          Search
          <span style={{ fontSize: 10, color: '#444', marginLeft: 4 }}>Ctrl+K</span>
        </button>
      ) : (
        <div style={{ position: 'relative' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Search agents, workflows, memories..."
            style={{
              width: 280, padding: '6px 12px', fontSize: 13,
              background: '#1a1a24', border: '1px solid #a78bfa55',
              borderRadius: 8, color: '#e2e8f0', outline: 'none',
              fontFamily: 'system-ui, sans-serif',
            }}
          />
          {(results.length > 0 || loading) && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0,
              marginTop: 4, background: '#14141e', border: '1px solid #2a2a3a',
              borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              maxHeight: 380, overflowY: 'auto', zIndex: 1000,
            }}>
              {loading && results.length === 0 && (
                <div style={{ padding: '12px 16px', color: '#555', fontSize: 12 }}>Searching...</div>
              )}
              {Object.entries(grouped).map(([cat, items]) => {
                const meta = CATEGORY_META[cat] || { icon: '•', color: '#888', label: cat };
                return (
                  <div key={cat}>
                    <div style={{
                      padding: '8px 14px 4px', fontSize: 10, fontWeight: 600,
                      color: meta.color, textTransform: 'uppercase', letterSpacing: 1,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span>{meta.icon}</span> {meta.label}
                    </div>
                    {items.map((r, i) => (
                      <button key={`${r.id}-${i}`} onClick={() => handleSelect(r)} style={{
                        display: 'flex', flexDirection: 'column', gap: 2,
                        width: '100%', padding: '8px 14px', border: 'none',
                        background: 'transparent', cursor: 'pointer', textAlign: 'left',
                        transition: 'background 0.1s',
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = '#1e1e2e'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>{r.title}</span>
                        {r.subtitle && (
                          <span style={{ fontSize: 11, color: '#555' }}>{r.subtitle}</span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
              {!loading && results.length === 0 && query.length >= 2 && (
                <div style={{ padding: '12px 16px', color: '#555', fontSize: 12 }}>No results</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
