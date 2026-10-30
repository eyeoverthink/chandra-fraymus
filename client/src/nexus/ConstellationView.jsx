import React, { useState, useEffect, useRef } from 'react';

const NODES = [
  { id: 'heart', label: 'Heart', icon: '♥', ring: 1, color: '#f59e0b', panel: 'intelligence' },
  { id: 'dreamer', label: 'Dreamer', icon: '☾', ring: 1, color: '#8b5cf6', panel: 'intelligence' },
  { id: 'ledger', label: 'Ledger', icon: '⟐', ring: 1, color: '#06b6d4', panel: 'intelligence' },
  { id: 'cognition', label: 'Cognition', icon: '⧫', ring: 1, color: '#10b981', panel: 'intelligence' },
  { id: 'consciousness', label: 'Ouroboros', icon: '∞', ring: 1, color: '#ec4899', panel: 'intelligence' },
  { id: 'membridge', label: 'Memory Bridge', icon: '⊶', ring: 1, color: '#a78bfa', panel: 'vertiso' },

  { id: 'fleet', label: 'Agent Fleet', icon: '⚡', ring: 2, color: '#6366f1', panel: 'fleet' },
  { id: 'commerce', label: 'Commerce', icon: '◆', ring: 2, color: '#ec4899', panel: 'commerce' },
  { id: 'canvas', label: 'Workflows', icon: '⬡', ring: 2, color: '#8b5cf6', action: 'canvas' },
  { id: 'automations', label: 'Automations', icon: '⟳', ring: 2, color: '#06b6d4', panel: 'automations' },
  { id: 'mcp', label: 'MCP Gateway', icon: '⬢', ring: 2, color: '#10b981', panel: 'mcp' },
  { id: 'browser', label: 'Browser', icon: '◉', ring: 2, color: '#7c3aed', panel: 'browser' },
  { id: 'vertiso', label: 'Vertiso', icon: '◇', ring: 2, color: '#a78bfa', panel: 'vertiso' },
  { id: 'outlier', label: 'Outlier', icon: '◎', ring: 2, color: '#eab308', panel: 'outlier' },
];

const EDGES = [
  ['heart', 'fleet'], ['heart', 'commerce'],
  ['dreamer', 'fleet'], ['dreamer', 'cognition'],
  ['ledger', 'fleet'], ['ledger', 'automations'],
  ['cognition', 'fleet'], ['cognition', 'commerce'],
  ['consciousness', 'cognition'], ['consciousness', 'dreamer'],
  ['membridge', 'fleet'], ['membridge', 'commerce'], ['membridge', 'vertiso'],
  ['membridge', 'automations'], ['membridge', 'outlier'],
];

function nodePos(node, i, total, cx, cy) {
  const r = node.ring === 1 ? 130 : 260;
  const ringNodes = NODES.filter(n => n.ring === node.ring);
  const idx = ringNodes.indexOf(node);
  const angle = (2 * Math.PI * idx) / ringNodes.length - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

export default function ConstellationView({ wsEvent, onOpenDrawer, onNavigate }) {
  const [hover, setHover] = useState(null);
  const [status, setStatus] = useState({});
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 700, h: 600 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 100 && height > 100) setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fetch('/api/fraymus/health').then(r => r.json()).then(d => {
      setStatus(prev => ({
        ...prev,
        heart: d.intelligence?.mood || 'neutral',
        dreamer: `${d.intelligence?.dreams || 0} dreams`,
        ledger: `${d.intelligence?.ledgerCount || 0} events`,
        cognition: d.intelligence?.cognitionMode || 'idle',
        consciousness: d.intelligence?.proofs || '—',
        system: d.autonomous ? 'autonomous' : 'online',
      }));
    }).catch(() => {});
    fetch('/api/fleet/agents').then(r => r.json()).then(d => {
      setStatus(prev => ({ ...prev, fleet: `${(d.agents || []).length} agents` }));
    }).catch(() => {});
    fetch('/api/vertiso/stats').then(r => r.json()).then(d => {
      setStatus(prev => ({
        ...prev,
        membridge: `${d.totalMemories || 0} memories`,
        vertiso: `${d.totalConsolidations || 0} consolidated`,
      }));
    }).catch(() => {});
  }, []);

  const cx = size.w / 2;
  const cy = size.h / 2;
  const positions = {};
  NODES.forEach(n => { positions[n.id] = nodePos(n, 0, 0, cx, cy); });

  const handleClick = (n) => {
    if (n.action === 'canvas') onNavigate?.('canvas');
    else if (n.panel) onOpenDrawer?.(n.panel, n.label);
  };

  const isConnected = (id) => {
    if (!hover) return false;
    return EDGES.some(([a, b]) => (a === hover && b === id) || (b === hover && a === id));
  };

  return (
    <div ref={ref} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 24, left: 32, zIndex: 2 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e0e8', marginBottom: 4 }}>Constellation</h2>
        <p style={{ fontSize: 13, color: '#666' }}>System map — click any node to inspect</p>
      </div>

      <svg width={size.w} height={size.h} style={{ display: 'block' }}>
        {EDGES.map(([a, b], i) => {
          const pa = positions[a]; const pb = positions[b];
          if (!pa || !pb) return null;
          const active = hover === a || hover === b;
          return (
            <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke={active ? '#a78bfa' : '#222'} strokeWidth={active ? 1.5 : 0.7}
              opacity={active ? 0.8 : 0.4} />
          );
        })}

        {NODES.filter(n => n.ring === 1).map(n => {
          const p = positions[n.id];
          return (
            <line key={`hub-${n.id}`} x1={cx} y1={cy} x2={p.x} y2={p.y}
              stroke={hover === n.id ? n.color : '#333'} strokeWidth={hover === n.id ? 1.5 : 0.5}
              opacity={0.5} strokeDasharray="4 4" />
          );
        })}

        <circle cx={cx} cy={cy} r={36} fill="#111118" stroke="#a78bfa" strokeWidth={2} />
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#a78bfa" fontSize={11} fontWeight={700}>CHANDRA</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#666" fontSize={9}>NEXUS</text>

        {NODES.map(n => {
          const p = positions[n.id];
          const r = n.ring === 1 ? 26 : 30;
          const active = hover === n.id;
          const connected = isConnected(n.id);
          return (
            <g key={n.id}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => handleClick(n)}
              style={{ cursor: 'pointer' }}
            >
              <circle cx={p.x} cy={p.y} r={r}
                fill={active ? n.color + '20' : '#111118'}
                stroke={active ? n.color : connected ? n.color + '80' : '#333'}
                strokeWidth={active ? 2 : 1} />
              <text x={p.x} y={p.y - 4} textAnchor="middle" fill={n.color} fontSize={14}>{n.icon}</text>
              <text x={p.x} y={p.y + 12} textAnchor="middle"
                fill={active ? '#e0e0e8' : '#888'} fontSize={9} fontWeight={active ? 600 : 400}>
                {n.label}
              </text>
              {status[n.id] && active && (
                <g>
                  <rect x={p.x - 50} y={p.y + r + 6} width={100} height={20}
                    rx={4} fill="#0a0a14" stroke={n.color + '40'} strokeWidth={0.5} />
                  <text x={p.x} y={p.y + r + 20} textAnchor="middle" fill={n.color} fontSize={9}>
                    {status[n.id]}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
