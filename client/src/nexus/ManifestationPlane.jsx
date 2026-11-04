import React, { useRef, useEffect, useState, useCallback } from 'react';

const GRID_SIZE = 16;
const CELL_SIZE = 2;
const HEIGHT_SCALE = 8;
const COLORS = {
  terrain: { low: [10, 10, 30], high: [167, 139, 250] },
  grid: 'rgba(167,139,250,0.08)',
  glow: 'rgba(167,139,250,0.4)',
};

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rgbStr(r, g, b, a = 1) {
  return a < 1 ? `rgba(${r|0},${g|0},${b|0},${a})` : `rgb(${r|0},${g|0},${b|0})`;
}

function heightColor(t) {
  const { low, high } = COLORS.terrain;
  return [lerp(low[0], high[0], t), lerp(low[1], high[1], t), lerp(low[2], high[2], t)];
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
      const d = wsEvent.data || wsEvent;
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
      return {
        x: canvas.width / 2 + x1 * scale,
        y: canvas.height / 2 - y1 * scale,
        z: z1,
        scale,
      };
    }

    function render() {
      const { B, gridSize } = stateRef.current;
      const N = gridSize;
      const w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
      const h = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
      ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, w, h);

      const halfGrid = (N * CELL_SIZE) / 2;
      const points = [];

      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const idx = gy * N + gx;
          const activation = B[idx] || 0;
          const height = Math.tanh(activation) * HEIGHT_SCALE;
          const normHeight = (Math.tanh(activation) + 1) / 2;

          const worldX = (gx - N / 2) * CELL_SIZE;
          const worldZ = (gy - N / 2) * CELL_SIZE;
          const worldY = height;

          const p = project(worldX, worldY, worldZ);
          points.push({ gx, gy, idx, activation, height, normHeight, ...p });
        }
      }

      points.sort((a, b) => b.z - a.z);

      for (const pt of points) {
        if (pt.gx < N - 1 && pt.gy < N - 1) {
          const right = points.find(p => p.gx === pt.gx + 1 && p.gy === pt.gy);
          const down = points.find(p => p.gx === pt.gx && p.gy === pt.gy + 1);

          if (right) {
            ctx.strokeStyle = COLORS.grid;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(right.x, right.y);
            ctx.stroke();
          }
          if (down) {
            ctx.strokeStyle = COLORS.grid;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(down.x, down.y);
            ctx.stroke();
          }
        }
      }

      for (const pt of points) {
        const [r, g, b] = heightColor(pt.normHeight);
        const radius = clamp(2 + pt.normHeight * 4, 1, 8) * pt.scale;

        if (pt.normHeight > 0.6) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, radius * 2, 0, Math.PI * 2);
          ctx.fillStyle = rgbStr(r, g, b, 0.15);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = rgbStr(r, g, b);
        ctx.fill();
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
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px', borderBottom: '1px solid #1a1a24', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#a78bfa' }}>ManifestationPlane</h2>
          <span style={{ fontSize: 11, color: '#555' }}>CTRNN Neural Terrain</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {stats && (
            <>
              <span style={cardStyle}>Tick: {stats.tick || 0}</span>
              <span style={cardStyle}>Neurons: {stats.neuronCount || GRID_SIZE * GRID_SIZE}</span>
              <span style={cardStyle}>Synapses: {stats.activeSynapses || 0}</span>
              <span style={cardStyle}>Connectivity: {((stats.connectivityRatio || 0) * 100).toFixed(1)}%</span>
            </>
          )}
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
        <div style={{
          position: 'absolute', bottom: 16, left: 16, padding: '8px 12px',
          background: 'rgba(10,10,15,0.85)', border: '1px solid #222',
          borderRadius: 8, fontSize: 11, color: '#666',
        }}>
          Drag to rotate · Click to inject stimulus · {GRID_SIZE}x{GRID_SIZE} neuron grid
        </div>
      </div>
    </div>
  );
}
