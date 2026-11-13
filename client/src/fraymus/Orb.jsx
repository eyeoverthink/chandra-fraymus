import { useEffect, useRef, useState } from 'react';

// Each ring is one real process, measured by /api/fraymus-os/pulse (server/fraymus-os/pulse.js). A ring turns as fast as
// its process is working and stops when it stops; neighbouring rings turn in opposite directions. The routing ring is
// split into one arc per machine in the model pool: an arc lights while that machine is answering, and a dot runs to
// it each time it answers a call — the route a thought really took.
const RINGS = [
  { id: 'agents', r: 96, color: '#3ee0ff', dir: 'normal' },
  { id: 'routing', r: 80, color: '#7dffa8', dir: 'reverse' },
  { id: 'logic', r: 64, color: '#ffd166', dir: 'normal' },
  { id: 'matrix', r: 48, color: '#c792ff', dir: 'reverse' },
];

// seconds per turn from the measured work: idle → stopped, busier → faster; never faster than 3 s a turn
function periodFor(ring) {
  if (!ring) return null;
  const speed = ring.id === 'matrix' ? (ring.running ? ring.rate / 6 : 0) : ring.rate + 2 * (ring.active || 0);
  if (!(speed > 0)) return null;
  return Math.max(3, Math.min(60, 40 / Math.sqrt(speed)));
}

const arc = (r, a0, a1) => {
  const p = a => [110 + r * Math.cos(a), 110 + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export default function Orb({ state = 'idle', pulse = null }) {
  const label = state === 'idle' ? 'idle' : state;
  const rings = Object.fromEntries((pulse?.rings || []).map(r => [r.id, r]));
  const hosts = rings.routing?.hosts || [];
  const [routes, setRoutes] = useState([]);   // dots in flight to the machine that just answered
  const lastCalls = useRef(null);

  useEffect(() => {
    if (!hosts.length) return;
    const prev = lastCalls.current;
    lastCalls.current = Object.fromEntries(hosts.map(h => [h.name, h.calls]));
    if (!prev) return;
    const fresh = hosts.filter(h => h.calls > (prev[h.name] ?? h.calls)).map(h => ({ host: h.name, key: `${h.name}-${h.calls}-${Date.now()}` }));
    if (!fresh.length) return;
    setRoutes(list => [...list, ...fresh].slice(-8));
    const timer = setTimeout(() => setRoutes(list => list.filter(d => !fresh.some(f => f.key === d.key))), 1600);
    return () => clearTimeout(timer);
  }, [pulse?.at]);   // eslint-disable-line react-hooks/exhaustive-deps

  const sector = hosts.length ? (2 * Math.PI) / hosts.length : 0;
  const hostAngle = i => -Math.PI / 2 + sector * i + sector / 2;

  return (
    <div className={`fraymus-orb is-${state}`} role="img" aria-label={`F.R.A.Y.M.U.S. is ${label}`}>
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <circle className="orb-glow" cx="110" cy="110" r="70" />
        {RINGS.map(def => {
          const ring = rings[def.id];
          const period = periodFor(ring);
          const style = { animationName: period ? 'spin' : 'none', animationDuration: `${period || 1}s`, animationDirection: def.dir,
            animationTimingFunction: 'linear', animationIterationCount: 'infinite', transformOrigin: '110px 110px' };
          if (def.id === 'routing' && hosts.length) {
            return (
              <g key={def.id} className="orb-live-ring" style={style}>
                <title>{ring ? `${ring.label}: ${ring.rate} ${ring.unit} — ${ring.detail}` : def.id}</title>
                {hosts.map((h, i) => {
                  const a0 = -Math.PI / 2 + sector * i + 0.06, a1 = a0 + sector - 0.12;
                  return <path key={h.name} d={arc(def.r, a0, a1)} fill="none" stroke={def.color} strokeLinecap="round"
                    strokeWidth={h.inFlight ? 3.2 : 1.4} opacity={h.healthy ? (h.inFlight ? 1 : 0.55) : 0.15} />;
                })}
                {routes.map(d => {
                  const i = hosts.findIndex(h => h.name === d.host);
                  if (i < 0) return null;
                  const a = hostAngle(i);
                  return <circle key={d.key} className="orb-route" r="2.6" fill="#e8fff1"
                    style={{ '--tx': `${(def.r * Math.cos(a)).toFixed(1)}px`, '--ty': `${(def.r * Math.sin(a)).toFixed(1)}px` }} cx="110" cy="110" />;
                })}
              </g>
            );
          }
          const segments = def.id === 'matrix' ? Math.max(4, Math.round((ring?.active || 0) / 600)) : Math.max(1, (ring?.active || 0) + Math.ceil(ring?.rate || 0));
          const circ = 2 * Math.PI * def.r, dash = Math.max(2, circ / (segments * 2));
          return (
            <circle key={def.id} className="orb-ring orb-live-ring" cx="110" cy="110" r={def.r}
              strokeDasharray={ring ? `${dash.toFixed(2)} ${dash.toFixed(2)}` : '2 6'} opacity={period ? 0.9 : 0.35} style={{ ...style, stroke: def.color }}>
              <title>{ring ? `${ring.label}: ${ring.rate} ${ring.unit} — ${ring.detail}` : def.id}</title>
            </circle>
          );
        })}
        <circle className="orb-core" cx="110" cy="110" r="16" />
        <circle className="orb-hot" cx="110" cy="110" r="5" />
      </svg>
      <div className="orb-state">{label}</div>
      {pulse && (
        <ul className="orb-legend" aria-label="What the rings show">
          {RINGS.map(def => {
            const ring = rings[def.id];
            if (!ring) return null;
            return (
              <li key={def.id} title={ring.detail}>
                <i style={{ background: def.color }} />
                <b>{ring.label}</b>
                <span>{periodFor(ring) ? `${ring.rate} ${ring.unit}` : 'still'}{ring.active ? ` · ${ring.active} active` : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
