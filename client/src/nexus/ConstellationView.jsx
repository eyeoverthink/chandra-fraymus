import React, { useState, useEffect, useRef, useCallback } from 'react';

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

const EVENT_TO_NODES = {
  agents: ['fleet'],
  agent: ['fleet'],
  memory: ['membridge', 'vertiso'],
  v3: ['heart', 'dreamer', 'ledger', 'cognition', 'consciousness', 'membridge'],
  tasks: ['automations'],
};

function eventToNodes(ev) {
  if (!ev?.type) return [];
  const mapped = EVENT_TO_NODES[ev.type];
  if (mapped) return mapped;
  if (ev.type === 'event') {
    const src = ev.payload?.source;
    if (src === 'pipeline') return ['commerce'];
    if (src === 'workflow') return ['canvas'];
    return ['heart'];
  }
  return [];
}

function nodePos(node, cx, cy) {
  const r = node.ring === 1 ? 130 : 260;
  const ringNodes = NODES.filter(n => n.ring === node.ring);
  const idx = ringNodes.indexOf(node);
  const angle = (2 * Math.PI * idx) / ringNodes.length - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

export default function ConstellationView({ wsEvent, onOpenDrawer, onNavigate }) {
  const [hover, setHover] = useState(null);
  const [status, setStatus] = useState({});
  const [activity, setActivity] = useState({});
  const [autonomous, setAutonomous] = useState(false);
  const [generation, setGeneration] = useState(0);
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 700, h: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 100 && height > 100) setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadStatus = useCallback(() => {
    fetch('/api/fraymus/health').then(r => r.json()).then(d => {
      setAutonomous(!!d.autonomous);
      setGeneration(d.generation || 0);
      setStatus(prev => ({
        ...prev,
        heart: d.intelligence?.mood || 'neutral',
        dreamer: `${d.intelligence?.dreams || 0} dreams`,
        ledger: `${d.intelligence?.ledgerCount || 0} events`,
        cognition: d.intelligence?.cognitionMode || 'idle',
        consciousness: d.intelligence?.proofs || '—',
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

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (!wsEvent?.type || wsEvent.type === 'hello') return;
    loadStatus();
    const nodes = eventToNodes(wsEvent);
    if (nodes.length > 0) {
      const now = Date.now();
      setActivity(prev => {
        const next = { ...prev };
        nodes.forEach(id => { next[id] = now; });
        return next;
      });
    }
  }, [wsEvent, loadStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      setActivity(prev => {
        const now = Date.now();
        const next = {};
        let changed = false;
        for (const [id, ts] of Object.entries(prev)) {
          if (now - ts < 4000) next[id] = ts;
          else changed = true;
        }
        return changed || Object.keys(next).length !== Object.keys(prev).length ? next : prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const cx = size.w / 2;
  const cy = size.h / 2;
  const positions = {};
  NODES.forEach(n => { positions[n.id] = nodePos(n, cx, cy); });

  const handleClick = (n) => {
    if (n.action === 'canvas') onNavigate?.('canvas');
    else if (n.panel) onOpenDrawer?.(n.panel, n.label);
  };

  const isConnected = (id) => {
    if (!hover) return false;
    return EDGES.some(([a, b]) => (a === hover && b === id) || (b === hover && a === id));
  };

  const isActive = (id) => {
    const ts = activity[id];
    return ts && (Date.now() - ts) < 4000;
  };

  const glowIntensity = (id) => {
    const ts = activity[id];
    if (!ts) return 0;
    const elapsed = Date.now() - ts;
    if (elapsed > 4000) return 0;
    return Math.max(0, 1 - elapsed / 4000);
  };

  const edgeActive = (a, b) => isActive(a) || isActive(b);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 24, left: 32, zIndex: 2 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e0e8', marginBottom: 4 }}>Constellation</h2>
        <p style={{ fontSize: 13, color: '#666' }}>System map — click any node to inspect</p>
      </div>

      <svg width={size.w} height={size.h} style={{ display: 'block' }}>
        <defs>
          {NODES.map(n => (
            <filter key={`glow-${n.id}`} id={`glow-${n.id}`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={isActive(n.id) ? 6 * glowIntensity(n.id) : 0} result="blur" />
              <feFlood floodColor={n.color} floodOpacity={0.6 * glowIntensity(n.id)} />
              <feComposite in2="blur" operator="in" />
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          ))}
          <filter id="hubGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feFlood floodColor="#a78bfa" floodOpacity="0.3" />
            <feComposite in2="blur" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {EDGES.map(([a, b], i) => {
          const pa = positions[a]; const pb = positions[b];
          if (!pa || !pb) return null;
          const hovered = hover === a || hover === b;
          const flowing = edgeActive(a, b);
          const nodeA = NODES.find(n => n.id === a);
          return (
            <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke={flowing ? (nodeA?.color || '#a78bfa') : hovered ? '#a78bfa' : '#222'}
              strokeWidth={flowing ? 2 : hovered ? 1.5 : 0.7}
              opacity={flowing ? 0.7 : hovered ? 0.8 : 0.4}
              strokeDasharray={flowing ? '6 4' : 'none'}
              style={flowing ? { animation: 'edgeFlow 1.5s linear infinite' } : {}}
            />
          );
        })}

        {NODES.filter(n => n.ring === 1).map(n => {
          const p = positions[n.id];
          const active = isActive(n.id);
          return (
            <line key={`hub-${n.id}`} x1={cx} y1={cy} x2={p.x} y2={p.y}
              stroke={active ? n.color : hover === n.id ? n.color : '#333'}
              strokeWidth={active ? 1.5 : hover === n.id ? 1.5 : 0.5}
              opacity={active ? 0.7 : 0.5} strokeDasharray="4 4"
              style={active ? { animation: 'edgeFlow 2s linear infinite' } : {}}
            />
          );
        })}

        <g filter={autonomous ? 'url(#hubGlow)' : 'none'}
          style={autonomous ? { animation: 'hubBreathe 4s ease-in-out infinite' } : {}}>
          <circle cx={cx} cy={cy} r={36} fill="#111118" stroke="#a78bfa"
            strokeWidth={autonomous ? 2.5 : 1.5}
            opacity={autonomous ? 1 : 0.5} />
          <text x={cx} y={cy - 10} textAnchor="middle" fill="#a78bfa" fontSize={11} fontWeight={700}>CHANDRA</text>
          <text x={cx} y={cy + 4} textAnchor="middle" fill="#666" fontSize={9}>NEXUS</text>
          {autonomous && (
            <text x={cx} y={cy + 18} textAnchor="middle" fill="#a78bfa50" fontSize={8}>Gen {generation}</text>
          )}
        </g>

        {NODES.map(n => {
          const p = positions[n.id];
          const r = n.ring === 1 ? 26 : 30;
          const hovered = hover === n.id;
          const connected = isConnected(n.id);
          const active = isActive(n.id);
          const glow = glowIntensity(n.id);
          return (
            <g key={n.id}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => handleClick(n)}
              style={{ cursor: 'pointer' }}
              filter={active ? `url(#glow-${n.id})` : 'none'}
            >
              {active && (
                <circle cx={p.x} cy={p.y} r={r + 6}
                  fill="none" stroke={n.color}
                  strokeWidth={1} opacity={glow * 0.4}
                  style={{ animation: 'nodeRipple 2s ease-out infinite' }}
                />
              )}
              <circle cx={p.x} cy={p.y} r={r}
                fill={hovered || active ? n.color + '20' : '#111118'}
                stroke={hovered ? n.color : active ? n.color : connected ? n.color + '80' : '#333'}
                strokeWidth={hovered || active ? 2 : 1} />
              <text x={p.x} y={p.y - 4} textAnchor="middle" fill={n.color} fontSize={14}>{n.icon}</text>
              <text x={p.x} y={p.y + 12} textAnchor="middle"
                fill={hovered || active ? '#e0e0e8' : '#888'} fontSize={9} fontWeight={hovered ? 600 : 400}>
                {n.label}
              </text>

              {status[n.id] && (
                <text x={p.x} y={p.y + r + 16} textAnchor="middle"
                  fill={n.color + '80'} fontSize={8}>
                  {status[n.id]}
                </text>
              )}

              {hovered && status[n.id] && (
                <g>
                  <rect x={p.x - 55} y={p.y - r - 26} width={110} height={20}
                    rx={4} fill="#0a0a14" stroke={n.color + '40'} strokeWidth={0.5} />
                  <text x={p.x} y={p.y - r - 12} textAnchor="middle" fill={n.color} fontSize={9} fontWeight={600}>
                    {status[n.id]}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      <style>{`
        @keyframes hubBreathe {
          0%, 100% { transform-origin: center; opacity: 1; }
          50% { opacity: 0.85; }
        }
        @keyframes edgeFlow {
          from { stroke-dashoffset: 20; }
          to { stroke-dashoffset: 0; }
        }
        @keyframes nodeRipple {
          0% { r: ${26}; opacity: 0.4; }
          100% { r: ${40}; opacity: 0; }
        }
      `}</style>
    </div>
  );
}
