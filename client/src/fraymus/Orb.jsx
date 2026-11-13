import { useEffect, useMemo, useRef, useState } from 'react';

// The home screen's orb: an armillary of four live processes around the live neural core, drawn in 3-D on a canvas.
// Every motion is a measurement from /api/fraymus-os/pulse (server/fraymus-os/pulse.js) — a stalled process stops its
// ring, nothing is animated that did not happen (Vaughn, 2026-11-13: "more modern, detailed, functional; dimensional").
//   ring tilt / perspective  each process on its own plane; the near side is bright, the far side passes behind the core
//   ring spin                how fast that process is working (period from its rate, as before)
//   particles                one per real event — tool calls, model calls, reasoning steps — so density is the rate
//   routing beads            one per machine in the model pool; a comet flies from the core when that machine answers
//   core                     the 256 CTRNN neurons on a sphere, each lit by its current output tanh(B)
// Hover a ring to light it, click to pin its detail card; the legend shows two minutes of history per ring.
const RINGS = [
  { id: 'agents', R: 1.0, color: [62, 224, 255], tilt: 1.18, yaw: 0.0, dir: 1 },
  { id: 'routing', R: 0.84, color: [125, 255, 168], tilt: 0.55, yaw: 0.95, dir: -1 },
  { id: 'logic', R: 0.7, color: [255, 209, 102], tilt: 1.42, yaw: -0.85, dir: 1 },
  { id: 'matrix', R: 0.56, color: [199, 146, 255], tilt: 0.25, yaw: 0.4, dir: -1 },
];
const HISTORY = 60;          // readings kept per ring (pulse every 2 s → two minutes)
const SAMPLES = 120;         // points per ring

// seconds per turn from the measured work: idle → stopped, busier → faster; never faster than 3 s a turn
function periodFor(ring) {
  if (!ring) return null;
  const speed = ring.id === 'matrix' ? (ring.running ? ring.rate / 6 : 0) : ring.rate + 2 * (ring.active || 0);
  if (!(speed > 0)) return null;
  return Math.max(3, Math.min(60, 40 / Math.sqrt(speed)));
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// point on a ring's plane at angle t → 3-D (unit radius = 1), after tilt about x and yaw about y
function ringPoint(def, t) {
  const x0 = Math.cos(t) * def.R, y0 = Math.sin(t) * def.R;
  const y1 = y0 * Math.cos(def.tilt), z1 = y0 * Math.sin(def.tilt);
  const x2 = x0 * Math.cos(def.yaw) + z1 * Math.sin(def.yaw), z2 = -x0 * Math.sin(def.yaw) + z1 * Math.cos(def.yaw);
  return [x2, y1, z2];
}

export default function Orb({ state = 'idle', pulse = null }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const live = useRef({ pulse: null, spin: {}, particles: {}, comets: [], hover: null, selected: null, coreSpin: 0, lastCalls: null, last: 0, carry: {} });
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState({});
  const rings = useMemo(() => Object.fromEntries((pulse?.rings || []).map(r => [r.id, r])), [pulse]);

  // keep the newest reading for the draw loop, two minutes of rates for the legend, and comets for answered calls
  useEffect(() => {
    const L = live.current;
    L.pulse = pulse;
    if (!pulse) return;
    setHistory(h => {
      const next = { ...h };
      for (const r of pulse.rings || []) next[r.id] = [...(h[r.id] || []), r.rate || 0].slice(-HISTORY);
      return next;
    });
    const hosts = rings.routing?.hosts || [];
    const prev = L.lastCalls;
    L.lastCalls = Object.fromEntries(hosts.map(h => [h.name, h.calls]));
    if (prev) for (const h of hosts) {
      const fresh = Math.min(4, (h.calls || 0) - (prev[h.name] ?? h.calls));
      for (let i = 0; i < fresh; i++) L.comets.push({ host: h.name, born: performance.now() + i * 180 });
    }
  }, [pulse, rings]);

  useEffect(() => { live.current.hover = hover; live.current.selected = selected; }, [hover, selected]);

  // the draw loop
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    const ctx = canvas.getContext('2d');
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, size = 300;
    const resize = () => {
      size = Math.max(220, Math.min(380, wrap.clientWidth));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = size * dpr; canvas.height = size * dpr;
      canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    const project = ([x, y, z]) => {
      const scale = size * 0.42, f = 3.2;
      const k = f / (f + z);
      return { x: size / 2 + x * scale * k, y: size / 2 + y * scale * k, z, k };
    };

    const frame = now => {
      const L = live.current;
      const dt = Math.min(0.1, L.last ? (now - L.last) / 1000 : 0);
      L.last = now;
      const p = L.pulse;
      const byId = Object.fromEntries((p?.rings || []).map(r => [r.id, r]));
      ctx.clearRect(0, 0, size, size);

      // backdrop: a soft halo whose strength follows how much is moving
      const busy = RINGS.reduce((n, d) => n + (periodFor(byId[d.id]) ? 1 : 0), 0) / RINGS.length;
      const halo = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
      halo.addColorStop(0, `rgba(62,224,255,${0.10 + 0.10 * busy})`);
      halo.addColorStop(1, 'rgba(62,224,255,0)');
      ctx.fillStyle = halo; ctx.fillRect(0, 0, size, size);

      // advance spins and particles from the measurements
      for (const def of RINGS) {
        const ring = byId[def.id];
        const period = periodFor(ring);
        const w = period ? (2 * Math.PI) / period : 0;
        L.spin[def.id] = ((L.spin[def.id] || 0) + def.dir * w * dt * (reduce ? 0.2 : 1)) % (2 * Math.PI);
        const parts = (L.particles[def.id] = (L.particles[def.id] || []).filter(q => q.life > 0));
        // events per second for this ring; the matrix ring shows activity, not events
        const eps = def.id === 'matrix' ? (ring?.running ? Math.min(3, (ring.rate || 0) / 20) : 0) : (ring?.rate || 0) / 60;
        L.carry[def.id] = (L.carry[def.id] || 0) + eps * dt;
        while (L.carry[def.id] >= 1 && !reduce) { L.carry[def.id] -= 1; if (parts.length < 40) parts.push({ t: Math.random() * Math.PI * 2, v: def.dir * (0.9 + Math.random() * 0.8), life: 1 }); }
        for (const q of parts) { q.t += q.v * dt; q.life -= dt / 4; }
      }

      // collect everything drawable with its depth, then paint far → near so rings pass behind and in front of the core
      const items = [];
      for (const def of RINGS) {
        const ring = byId[def.id];
        const lit = L.hover === def.id || L.selected === def.id;
        const moving = !!periodFor(ring);
        const spin = L.spin[def.id] || 0;
        const pts = [];
        for (let i = 0; i <= SAMPLES; i++) pts.push(project(ringPoint(def, (i / SAMPLES) * Math.PI * 2)));
        for (let i = 0; i < SAMPLES; i++) {
          const a = pts[i], b = pts[i + 1], z = (a.z + b.z) / 2;
          // ticks rotate with the spin so a moving ring visibly turns
          const phase = ((i / SAMPLES) * Math.PI * 2 - spin) * (def.id === 'matrix' ? 8 : 6);
          const tick = Math.cos(phase) > 0.55;
          const depth = 0.35 + 0.65 * (1 - (z + 1) / 2);
          const alpha = (moving ? 0.5 : 0.18) * depth * (lit ? 1.6 : 1) * (tick ? 1.5 : 0.7);
          items.push({ z, draw: () => {
            ctx.strokeStyle = rgba(def.color, Math.min(1, alpha));
            ctx.lineWidth = (tick ? 2.2 : 1.1) * a.k * (lit ? 1.5 : 1);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          } });
        }
        for (const q of L.particles[def.id] || []) {
          const pt = project(ringPoint(def, q.t + spin));
          items.push({ z: pt.z, draw: () => {
            const r = 2.4 * pt.k;
            const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r * 4);
            g.addColorStop(0, rgba([255, 255, 255], 0.9 * q.life)); g.addColorStop(0.3, rgba(def.color, 0.7 * q.life)); g.addColorStop(1, rgba(def.color, 0));
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pt.x, pt.y, r * 4, 0, Math.PI * 2); ctx.fill();
          } });
        }
        if (def.id === 'routing') {
          const hosts = ring?.hosts || [];
          hosts.forEach((h, i) => {
            const t = (i / Math.max(1, hosts.length)) * Math.PI * 2 + spin;
            const pt = project(ringPoint(def, t));
            items.push({ z: pt.z, draw: () => {
              const r = (h.inFlight ? 5 : 3.6) * pt.k;
              ctx.fillStyle = h.healthy ? rgba(def.color, h.inFlight ? 1 : 0.75) : 'rgba(255,107,107,0.6)';
              ctx.shadowColor = rgba(def.color, 0.9); ctx.shadowBlur = h.inFlight ? 14 : 4;
              ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
              ctx.fillStyle = `rgba(207,233,241,${0.35 + 0.5 * (1 - (pt.z + 1) / 2)})`;
              ctx.font = `${Math.round(9 * pt.k + 1)}px system-ui, sans-serif`;
              ctx.fillText(h.name, pt.x + r + 3, pt.y + 3);
            } });
          });
          // comets: core → the machine that just answered
          L.comets = L.comets.filter(c => now - c.born < 1400);
          for (const c of L.comets) {
            const i = hosts.findIndex(h => h.name === c.host);
            if (i < 0 || now < c.born) continue;
            const u = (now - c.born) / 1400;
            const end = ringPoint(def, (i / hosts.length) * Math.PI * 2 + spin);
            const pt = project(end.map(v => v * u));
            items.push({ z: pt.z, draw: () => {
              ctx.fillStyle = `rgba(232,255,241,${1 - u})`; ctx.shadowColor = '#7dffa8'; ctx.shadowBlur = 12;
              ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6 * pt.k, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
            } });
          }
        }
      }

      // core: the CTRNN's neurons on a Fibonacci sphere, turning only while the network ticks
      const m = byId.matrix;
      const grid = m?.grid || [];
      if (m?.running) L.coreSpin += dt * Math.min(0.6, (m.rate || 0) / 60) * (reduce ? 0.2 : 1);
      const n = grid.length || 256, rc = 0.27, gold = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i++) {
        const yy = 1 - (i / (n - 1)) * 2, rad = Math.sqrt(1 - yy * yy), th = gold * i + L.coreSpin;
        const v = grid[i] ?? 0;
        const pt = project([Math.cos(th) * rad * rc, yy * rc, Math.sin(th) * rad * rc]);
        items.push({ z: pt.z, draw: () => {
          const a = Math.abs(v);
          const col = v >= 0 ? [62, 224, 255] : [199, 146, 255];
          ctx.fillStyle = rgba(col, (0.15 + 0.85 * a) * (0.45 + 0.55 * (1 - (pt.z + 1) / 2)));
          ctx.beginPath(); ctx.arc(pt.x, pt.y, (0.8 + 1.8 * a) * pt.k, 0, Math.PI * 2); ctx.fill();
        } });
      }
      items.sort((a, b) => b.z - a.z);
      for (const it of items) it.draw();

      // the heart of the core: brightens with mean activation
      const c = size / 2, glow = ctx.createRadialGradient(c, c, 0, c, c, size * 0.08);
      const act = Math.min(1, (m?.meanActivation || 0) * 3);
      glow.addColorStop(0, `rgba(232,253,255,${0.55 + 0.4 * act})`); glow.addColorStop(1, 'rgba(62,224,255,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(c, c, size * 0.08, 0, Math.PI * 2); ctx.fill();

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // hover and click: the ring whose drawn line is nearest the pointer (within 9 px)
    const hit = e => {
      const rect = canvas.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let best = null, bestD = 9;
      for (const def of RINGS) {
        for (let i = 0; i < 48; i++) {
          const pt = project(ringPoint(def, (i / 48) * Math.PI * 2));
          const d = Math.hypot(pt.x - mx, pt.y - my);
          if (d < bestD) { bestD = d; best = def.id; }
        }
      }
      if (!best && Math.hypot(mx - size / 2, my - size / 2) < size * 0.13) best = 'matrix';
      return best;
    };
    const onMove = e => { const h = hit(e); setHover(h); canvas.style.cursor = h ? 'pointer' : 'default'; };
    const onLeave = () => setHover(null);
    const onClick = e => { const h = hit(e); setSelected(s => (h && s !== h ? h : null)); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('click', onClick);
    return () => {
      cancelAnimationFrame(raf); ro?.disconnect();
      canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); canvas.removeEventListener('click', onClick);
    };
  }, []);

  const label = state === 'idle' ? 'idle' : state;
  const focus = selected || hover;
  const focusRing = focus ? rings[focus] : null;
  const focusDef = focus ? RINGS.find(d => d.id === focus) : null;

  return (
    <div className={`fraymus-orb is-${state}`} role="img" aria-label={`F.R.A.Y.M.U.S. is ${label}`}>
      <div className="orb-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} aria-hidden="true" />
      </div>
      <div className="orb-state">{label}</div>

      {focusRing && (
        <div className="orb-card" style={{ '--ring': rgba(focusDef.color, 1) }}>
          <div className="orb-card-head">
            <b>{focusRing.label}</b>
            <span>{periodFor(focusRing) ? `${focusRing.rate} ${focusRing.unit}` : 'still'}</span>
            {selected && <button type="button" onClick={() => setSelected(null)} aria-label="Close">×</button>}
          </div>
          <Spark values={history[focus] || []} color={rgba(focusDef.color, 1)} wide />
          <RingDetail ring={focusRing} />
        </div>
      )}

      {pulse && (
        <ul className="orb-legend" aria-label="What the rings show">
          {RINGS.map(def => {
            const ring = rings[def.id];
            if (!ring) return null;
            const moving = periodFor(ring);
            return (
              <li key={def.id} title={ring.detail} className={focus === def.id ? 'is-focus' : ''}
                onMouseEnter={() => setHover(def.id)} onMouseLeave={() => setHover(null)} onClick={() => setSelected(s => (s === def.id ? null : def.id))}>
                <i style={{ background: rgba(def.color, 1), boxShadow: moving ? `0 0 8px ${rgba(def.color, 0.8)}` : 'none' }} />
                <b>{ring.label}</b>
                <span>{moving ? `${ring.rate} ${ring.unit}` : 'still'}{ring.active ? ` · ${ring.active} active` : ''}</span>
                <Spark values={history[def.id] || []} color={rgba(def.color, 1)} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// two minutes of a ring's rate
function Spark({ values, color, wide = false }) {
  const w = wide ? 240 : 56, h = wide ? 34 : 14;
  if (values.length < 2) return <svg className="orb-spark" width={w} height={h} aria-hidden="true" />;
  const max = Math.max(...values, 0.0001);
  // spread over the readings there are: spacing for the full two minutes squashed the first minutes into the left edge
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(' ');
  return (
    <svg className="orb-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={wide ? 1.6 : 1.2} strokeLinejoin="round" opacity="0.9" />
      {wide && <text x={w - 2} y={10} textAnchor="end" fontSize="9" fill="#8aa4b0">peak {Number(max).toFixed(1)}</text>}
    </svg>
  );
}

// what is behind a ring's number
function RingDetail({ ring }) {
  if (ring.id === 'routing') {
    return (
      <table className="orb-table"><tbody>
        {(ring.hosts || []).map(h => (
          <tr key={h.name}><td><i className={h.healthy ? 'ok' : 'bad'} />{h.name}</td><td>{h.model}</td><td>{h.calls} calls</td><td>{h.inFlight ? `${h.inFlight} now` : h.healthy ? 'idle' : h.why}</td></tr>
        ))}
      </tbody></table>
    );
  }
  if (ring.id === 'logic' && ring.parts) {
    return (
      <table className="orb-table"><tbody>
        {Object.entries(ring.parts).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v} in 5 min</td></tr>)}
        {ring.active ? <tr><td>in flight</td><td>{ring.active}</td></tr> : null}
      </tbody></table>
    );
  }
  if (ring.id === 'matrix') {
    return (
      <table className="orb-table"><tbody>
        <tr><td>state</td><td>{ring.running ? `${ring.rate} ticks / s` : 'stopped'}</td></tr>
        <tr><td>synapses</td><td>{ring.active}</td></tr>
        <tr><td>mean activation</td><td>{ring.meanActivation ?? '—'}</td></tr>
        <tr><td>connectivity</td><td>{ring.connectivity ?? '—'}</td></tr>
        <tr><td>saturation</td><td>{ring.saturation ?? '—'}</td></tr>
      </tbody></table>
    );
  }
  return <p className="orb-card-detail">{ring.detail}</p>;
}
