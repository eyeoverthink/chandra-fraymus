import React, { useRef, useEffect, useState, useCallback } from 'react';

const GRID_SIZE = 16;
const CELL_SIZE = 2;
const HEIGHT_SCALE = 8;

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rgbStr(r, g, b, a = 1) {
  return a < 1 ? `rgba(${r|0},${g|0},${b|0},${a})` : `rgb(${r|0},${g|0},${b|0})`;
}

// CTRNN functional region map — each row mapped to its subsystem
const REGION_MAP = [
  { name: 'Self-Model',        short: 'PROPRIO',    color: [251, 191, 36],  hex: '#fbbf24', desc: 'System proprioception' },
  { name: 'Resource Envelope',  short: 'RESOURCE',   color: [251, 146, 60],  hex: '#fb923c', desc: 'Energy & fatigue sensing' },
  { name: 'Sensory Input',     short: 'SENSORY-IN', color: [96, 165, 250],  hex: '#60a5fa', desc: 'Internal state signals' },
  { name: 'Predictive',        short: 'PREDICT',    color: [34, 211, 238],  hex: '#22d3ee', desc: 'Forward model & surprise' },
  { name: 'Metacognitive',     short: 'META-COG',   color: [74, 222, 128],  hex: '#4ade80', desc: 'Cognitive self-assessment' },
  { name: 'Active Inference',   short: 'INFERENCE',  color: [45, 212, 191],  hex: '#2dd4bf', desc: 'Prediction error → action' },
  { name: 'Working Memory',    short: 'TEMPORAL',   color: [167, 139, 250], hex: '#a78bfa', desc: 'Temporal buffer & trends' },
  { name: 'Integration',       short: 'INTEG',      color: [148, 163, 184], hex: '#94a3b8', desc: 'Cross-region integration' },
  { name: 'Motor Band',        short: 'MOTOR-EXT',  color: [248, 113, 113], hex: '#f87171', desc: 'External action outputs' },
  { name: 'Integration',       short: 'INTEG',      color: [148, 163, 184], hex: '#94a3b8', desc: 'Cross-region integration' },
  { name: 'Sensory Action',    short: 'SENSORY-ACT',color: [96, 165, 250],  hex: '#60a5fa', desc: 'Action state signals' },
  { name: 'Integration',       short: 'INTEG',      color: [148, 163, 184], hex: '#94a3b8', desc: 'Cross-region integration' },
  { name: 'Adaptive Strategy',  short: 'ADAPT',     color: [251, 191, 36],  hex: '#fbbf24', desc: 'Behavioral parameter tuning' },
  { name: 'Integration',       short: 'INTEG',      color: [148, 163, 184], hex: '#94a3b8', desc: 'Cross-region integration' },
  { name: 'Motor Cortex',      short: 'MOTOR-SELF', color: [248, 113, 113], hex: '#f87171', desc: 'Self-directed actions' },
  { name: 'Integration',       short: 'INTEG',      color: [148, 163, 184], hex: '#94a3b8', desc: 'Cross-region integration' },
];

// Known injection coordinates where subsystems push signals into the CTRNN
const INJECTION_POINTS = [
  { row: 2, col: 2,  label: 'Bus Traffic' },
  { row: 2, col: 6,  label: 'Memory Writes' },
  { row: 2, col: 10, label: 'Emotion/Heart' },
  { row: 2, col: 14, label: 'Consciousness' },
  { row: 10, col: 2,  label: 'Agent Activity' },
  { row: 10, col: 6,  label: 'Health Status' },
  { row: 10, col: 10, label: 'Workflows' },
  { row: 10, col: 14, label: 'Goals/RSI' },
  { row: 14, col: 2,  label: 'Reflect' },
  { row: 14, col: 6,  label: 'Neurogenesis' },
  { row: 14, col: 10, label: 'Dream' },
  { row: 14, col: 14, label: 'Self-Audit' },
  { row: 8, col: 4,   label: 'Communicate' },
  { row: 8, col: 12,  label: 'Goal-Seek' },
  { row: 8, col: 8,   label: 'Emotion Core' },
];

// Deduplicated legend entries with row ranges
const LEGEND_ENTRIES = (() => {
  const map = new Map();
  REGION_MAP.forEach((r, i) => {
    if (!map.has(r.short)) map.set(r.short, { ...r, rows: [i] });
    else map.get(r.short).rows.push(i);
  });
  return [...map.values()];
})();

function regionColor(row, t) {
  const region = REGION_MAP[row] || REGION_MAP[7];
  const { color } = region;
  const dim = 0.1;
  const brightness = dim + (1 - dim) * t;
  return [color[0] * brightness, color[1] * brightness, color[2] * brightness];
}

export default function ManifestationPlane({ wsEvent }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({
    B: new Float64Array(GRID_SIZE * GRID_SIZE),
    gridSize: GRID_SIZE,
    tick: 0,
    running: false,
  });
  const animRef = useRef(null);
  const [stats, setStats] = useState(null);
  const [ctrnnRunning, setCtrnnRunning] = useState(false);
  const [rotation, setRotation] = useState({ x: 0.6, y: 0.3 });
  const dragRef = useRef(null);
  const [hoverRegion, setHoverRegion] = useState(null);
  const [showInjections, setShowInjections] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/fraymus/ctrnn/stats');
      const data = await res.json();
      setStats(data);
      setCtrnnRunning(data.running);
    } catch (_) {}
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  useEffect(() => {
    if (wsEvent?.type === 'ctrnn') {
      const d = wsEvent.payload || {};
      if (d.B && d.gridSize) {
        stateRef.current.B = new Float64Array(d.B);
        stateRef.current.gridSize = d.gridSize;
        stateRef.current.tick = d.tick || 0;
        stateRef.current.running = true;
        if (d.metrics) setStats(prev => ({ ...prev, ...d.metrics, tick: d.tick }));
      }
    }
  }, [wsEvent]);

  const toggleCTRNN = useCallback(async () => {
    const endpoint = ctrnnRunning ? 'stop' : 'start';
    try {
      await fetch(`/api/fraymus/ctrnn/${endpoint}`, { method: 'POST' });
      setCtrnnRunning(!ctrnnRunning);
      fetchStats();
    } catch (_) {}
  }, [ctrnnRunning, fetchStats]);

  const injectStimulus = useCallback(async (tx, ty) => {
    try {
      await fetch('/api/fraymus/ctrnn/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tx, ty, sigma: 2.5, amplitude: 1.5 }),
      });
    } catch (_) {}
  }, []);

  const hoverRef = useRef(null);
  useEffect(() => { hoverRef.current = hoverRegion; }, [hoverRegion]);
  const showInjRef = useRef(true);
  useEffect(() => { showInjRef.current = showInjections; }, [showInjections]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function project(x, y, z) {
      const cosX = Math.cos(rotation.x), sinX = Math.sin(rotation.x);
      const cosY = Math.cos(rotation.y), sinY = Math.sin(rotation.y);
      const y1 = y * cosX - z * sinX;
      const z1 = y * sinX + z * cosX;
      const x1 = x * cosY + z1 * sinY;
      const scale = 600 / (600 + z1 * 0.5);
      return { x: canvas.width / 2 + x1 * scale, y: canvas.height / 2 - y1 * scale, z: z1, scale };
    }

    function render() {
      const { B, gridSize } = stateRef.current;
      const N = gridSize;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width = canvas.clientWidth * dpr;
      const h = canvas.height = canvas.clientHeight * dpr;
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, w, h);

      const hr = hoverRef.current;

      // Build indexed grid for O(1) neighbor lookup
      const grid = new Array(N * N);
      const points = [];
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const idx = gy * N + gx;
          const activation = B[idx] || 0;
          const height = Math.tanh(activation) * HEIGHT_SCALE;
          const normHeight = (Math.tanh(activation) + 1) / 2;
          const worldX = (gx - N / 2) * CELL_SIZE;
          const worldZ = (gy - N / 2) * CELL_SIZE;
          const p = project(worldX, height, worldZ);
          const pt = { gx, gy, idx, activation, height, normHeight, ...p };
          grid[idx] = pt;
          points.push(pt);
        }
      }

      points.sort((a, b) => b.z - a.z);

      // Grid lines — color-coded by region
      for (const pt of points) {
        const region = REGION_MAP[pt.gy] || REGION_MAP[7];
        const dimmed = hr !== null && region.short !== hr;
        const lineAlpha = dimmed ? 0.02 : 0.08;

        if (pt.gx < N - 1) {
          const right = grid[pt.gy * N + pt.gx + 1];
          if (right) {
            ctx.strokeStyle = dimmed
              ? `rgba(40,40,50,${lineAlpha})`
              : `rgba(${region.color.join(',')},${lineAlpha})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(right.x, right.y);
            ctx.stroke();
          }
        }
        if (pt.gy < N - 1) {
          const down = grid[(pt.gy + 1) * N + pt.gx];
          if (down) {
            ctx.strokeStyle = `rgba(100,100,120,${lineAlpha * 0.5})`;
            ctx.lineWidth = 0.3;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(down.x, down.y);
            ctx.stroke();
          }
        }
      }

      // Neuron dots — color-coded by region
      for (const pt of points) {
        const region = REGION_MAP[pt.gy] || REGION_MAP[7];
        const dimmed = hr !== null && region.short !== hr;
        const [r, g, b] = regionColor(pt.gy, dimmed ? pt.normHeight * 0.25 : pt.normHeight);
        const radius = clamp(2 + pt.normHeight * 4, 1, 8) * pt.scale;

        if (pt.normHeight > 0.6 && !dimmed) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, radius * 2, 0, Math.PI * 2);
          ctx.fillStyle = rgbStr(r, g, b, 0.15);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = rgbStr(r, g, b, dimmed ? 0.25 : 1);
        ctx.fill();
      }

      // Injection point indicators — pulsing rings at known signal coordinates
      if (showInjRef.current) {
        const now = Date.now();
        for (const ip of INJECTION_POINTS) {
          if (ip.row >= N || ip.col >= N) continue;
          const pt = grid[ip.row * N + ip.col];
          if (!pt) continue;
          const region = REGION_MAP[ip.row];
          const dimmed = hr !== null && region.short !== hr;
          if (dimmed) continue;

          const pulse = 0.5 + 0.5 * Math.sin(now / 600 + ip.row * 0.7 + ip.col * 0.3);
          const ringR = 3 + pulse * 4;

          // Outer glow ring
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, ringR + 2, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${region.color.join(',')}, ${0.12 + pulse * 0.18})`;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Inner bright dot
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${region.color.join(',')}, ${0.6 + pulse * 0.3})`;
          ctx.fill();
        }
      }

      animRef.current = requestAnimationFrame(render);
    }

    render();
    return () => cancelAnimationFrame(animRef.current);
  }, [rotation]);

  const handleMouseDown = useCallback((e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, rx: rotation.x, ry: rotation.y };
  }, [rotation]);

  const handleMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    const dx = (e.clientX - dragRef.current.x) * 0.005;
    const dy = (e.clientY - dragRef.current.y) * 0.005;
    setRotation({ x: dragRef.current.rx + dy, y: dragRef.current.ry + dx });
  }, []);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  const handleCanvasClick = useCallback((e) => {
    if (dragRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * GRID_SIZE;
    const py = ((e.clientY - rect.top) / rect.height) * GRID_SIZE;
    injectStimulus(Math.floor(px), Math.floor(py));
  }, [injectStimulus]);

  const cardStyle = {
    background: '#16161e', border: '1px solid #222', borderRadius: 8,
    padding: '8px 12px', fontSize: 12, color: '#888',
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a0f' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px', borderBottom: '1px solid #1a1a24', flexShrink: 0,
        flexWrap: 'wrap', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#a78bfa' }}>ManifestationPlane</h2>
          <span style={{ fontSize: 11, color: '#555' }}>CTRNN Neural Terrain</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {stats && (
            <>
              <span style={cardStyle}>Tick: {stats.tick || 0}</span>
              <span style={cardStyle}>Neurons: {stats.neuronCount || GRID_SIZE * GRID_SIZE}</span>
              <span style={cardStyle}>Synapses: {stats.activeSynapses || 0}</span>
              <span style={cardStyle}>Connectivity: {((stats.connectivityRatio || 0) * 100).toFixed(1)}%</span>
            </>
          )}
          <button onClick={() => setShowInjections(v => !v)} style={{
            background: showInjections ? '#22d3ee15' : 'none',
            border: `1px solid ${showInjections ? '#22d3ee' : '#444'}`,
            color: showInjections ? '#22d3ee' : '#666',
            borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 500,
          }}>
            {showInjections ? '◉ Injections' : '○ Injections'}
          </button>
          <button onClick={toggleCTRNN} style={{
            background: ctrnnRunning ? '#dc262620' : '#a78bfa20',
            border: `1px solid ${ctrnnRunning ? '#dc2626' : '#a78bfa'}`,
            color: ctrnnRunning ? '#f87171' : '#a78bfa',
            borderRadius: 6, padding: '6px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>
            {ctrnnRunning ? 'Stop CTRNN' : 'Start CTRNN'}
          </button>
        </div>
      </div>

      {/* Canvas + region legend */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', cursor: 'grab' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleCanvasClick}
        />

        {/* Region legend — hover to isolate */}
        <div style={{
          position: 'absolute', top: 12, right: 12, padding: '10px 14px',
          background: 'rgba(10,10,15,0.92)', border: '1px solid #222',
          borderRadius: 8, fontSize: 10, zIndex: 2, minWidth: 160,
        }}>
          <div style={{
            color: '#555', fontSize: 8, fontWeight: 700, letterSpacing: 1,
            textTransform: 'uppercase', marginBottom: 6,
          }}>
            CTRNN Regions
          </div>
          {LEGEND_ENTRIES.map((r, i) => {
            const isHovered = hoverRegion === r.short;
            return (
              <div key={i}
                onMouseEnter={() => setHoverRegion(r.short)}
                onMouseLeave={() => setHoverRegion(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '3px 4px', borderRadius: 4, cursor: 'pointer',
                  background: isHovered ? `${r.hex}15` : 'transparent',
                  transition: 'background 0.15s',
                }}
                title={r.desc}
              >
                <div style={{
                  width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                  background: r.hex, opacity: isHovered ? 1 : 0.6,
                  boxShadow: isHovered ? `0 0 6px ${r.hex}` : 'none',
                  transition: 'all 0.15s',
                }} />
                <span style={{
                  color: isHovered ? r.hex : '#777', flex: 1,
                  fontWeight: isHovered ? 600 : 400,
                  transition: 'color 0.15s',
                }}>
                  {r.name}
                </span>
                <span style={{ color: '#444', fontSize: 8, flexShrink: 0 }}>
                  {r.rows.length === 1 ? `R${r.rows[0]}` : r.rows.map(x => `${x}`).join(',')}
                </span>
              </div>
            );
          })}
        </div>

        {/* Instructions */}
        <div style={{
          position: 'absolute', bottom: 16, left: 16, padding: '8px 12px',
          background: 'rgba(10,10,15,0.85)', border: '1px solid #222',
          borderRadius: 8, fontSize: 11, color: '#666',
        }}>
          Drag to rotate · Click to inject stimulus · Hover legend to isolate regions
        </div>
      </div>
    </div>
  );
}
