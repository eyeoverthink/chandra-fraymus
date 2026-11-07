import { useEffect, useMemo, useRef, useState } from 'react';
import { KIND_COLORS, api, formatWhen } from './api.js';

const KINDS = ['note', 'memory', 'agent', 'workflow', 'artifact', 'skill'];

function layout(nodes, edges) {
  const placed = new Map();
  nodes.forEach((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    const ring = 150 + (index % 6) * 36;
    placed.set(node.id, {
      x: Math.cos(angle) * ring,
      y: Math.sin(angle) * ring * 0.72,
      vx: 0,
      vy: 0,
    });
  });
  const steps = Math.min(90, 24 + nodes.length);
  for (let step = 0; step < steps; step += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = placed.get(nodes[i].id);
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = placed.get(nodes[j].id);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        if (dist > 280) continue;
        const push = 420 / (dist * dist);
        dx /= dist;
        dy /= dist;
        a.vx += dx * push;
        a.vy += dy * push;
        b.vx -= dx * push;
        b.vy -= dy * push;
      }
    }
    for (const edge of edges) {
      const a = placed.get(edge.from);
      const b = placed.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      a.vx += dx * 0.012;
      a.vy += dy * 0.012;
      b.vx -= dx * 0.012;
      b.vy -= dy * 0.012;
    }
    for (const node of nodes) {
      const point = placed.get(node.id);
      point.vx -= point.x * 0.008;
      point.vy -= point.y * 0.008;
      point.vx *= 0.55;
      point.vy *= 0.55;
      point.x += Math.max(-12, Math.min(12, point.vx));
      point.y += Math.max(-12, Math.min(12, point.vy));
    }
  }
  return placed;
}

function hashDots(count) {
  const dots = [];
  let seed = 20261106;
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = (seed % 1000) / 1000;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = (seed % 1000) / 1000;
    dots.push({ x, y, r: (seed % 10) / 12 + 0.3 });
  }
  return dots;
}

const STARFIELD = hashDots(48);

export default function BrainGraph({ compact = false, initialQuery = '', onOpen }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const camera = useRef({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const [pathIds, setPathIds] = useState([]);
  const [pathNote, setPathNote] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [note, setNote] = useState({ title: '', body: '', tags: '' });
  const [noteError, setNoteError] = useState('');
  const points = useMemo(() => (data ? layout(data.nodes, data.edges) : new Map()), [data]);

  useEffect(() => { setQuery(initialQuery || ''); }, [initialQuery]);

  useEffect(() => {
    const handle = setTimeout(() => { load(); }, 180);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kind]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, kind, limit: compact ? '80' : '180' });
      const body = await api(`/api/fraymus-os/graph?${params}`);
      setData(body);
      setError('');
      setSelected(current => body.nodes.find(node => node.id === current?.id) || null);
    } catch (err) {
      setError(err.message || 'The graph could not be read.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { draw(); }, [data, points, selected, pathIds, compact]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, [data, points, selected, pathIds]);

  function draw() {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !data) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, rect.width, rect.height);
    for (const dot of STARFIELD) {
      ctx.fillStyle = 'rgba(120, 170, 190, 0.28)';
      ctx.beginPath();
      ctx.arc(dot.x * rect.width, dot.y * rect.height, dot.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const { x, y, k } = camera.current;
    const toScreen = point => ({ sx: rect.width / 2 + (point.x + x) * k, sy: rect.height / 2 + (point.y + y) * k });
    ctx.lineWidth = 1;
    for (const edge of data.edges) {
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b) continue;
      const left = toScreen(a);
      const right = toScreen(b);
      const onPath = pathIds.includes(edge.from) && pathIds.includes(edge.to);
      ctx.strokeStyle = onPath ? 'rgba(245, 193, 108, 0.9)' : 'rgba(80, 140, 160, 0.35)';
      ctx.beginPath();
      ctx.moveTo(left.sx, left.sy);
      ctx.lineTo(right.sx, right.sy);
      ctx.stroke();
    }
    for (const node of data.nodes) {
      const point = points.get(node.id);
      if (!point) continue;
      const { sx, sy } = toScreen(point);
      const active = selected?.id === node.id || pathIds.includes(node.id);
      ctx.beginPath();
      ctx.fillStyle = KIND_COLORS[node.kind] || '#94a3b8';
      ctx.globalAlpha = active ? 1 : 0.88;
      ctx.arc(sx, sy, active ? 8 : 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (!compact && k > 0.72) {
        ctx.fillStyle = 'rgba(232, 244, 248, 0.86)';
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(node.title.slice(0, 32), sx + 9, sy + 4);
      }
    }
  }

  function screenToWorld(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    const { x, y, k } = camera.current;
    return {
      x: (event.clientX - rect.left - rect.width / 2) / k - x,
      y: (event.clientY - rect.top - rect.height / 2) / k - y,
    };
  }

  function hitNode(event) {
    const world = screenToWorld(event);
    let best = null;
    let bestDist = 18 / camera.current.k;
    for (const node of data?.nodes || []) {
      const point = points.get(node.id);
      if (!point) continue;
      const dist = Math.hypot(point.x - world.x, point.y - world.y);
      if (dist < bestDist) { best = node; bestDist = dist; }
    }
    return best;
  }

  async function choose(node, shift) {
    setSelected(node);
    setSourceText('');
    if (!shift) {
      setAnchor(node.id);
      setPathIds([node.id]);
      setPathNote('Shift-click a second record to trace a path.');
      return;
    }
    if (!anchor || anchor === node.id) return;
    try {
      const result = await api(`/api/fraymus-os/graph/path?from=${encodeURIComponent(anchor)}&to=${encodeURIComponent(node.id)}`);
      setPathIds(result.path || []);
      setPathNote(result.found ? `${result.path.length - 1} link${result.path.length === 2 ? '' : 's'} between these records.` : result.reason);
    } catch (err) {
      setPathNote(err.message);
    }
  }

  async function openSource(node) {
    if (!node?.openPath) return;
    try {
      const body = await api(node.openPath);
      const picked = {
        id: body.id,
        title: body.title || body.name || body.topic || body.goal,
        source: body.source || body.provenance?.store,
        status: body.status,
        provenance: body.provenance,
        excerpt: body.excerpt || body.body || body.summary || body.goal,
      };
      setSourceText(JSON.stringify(picked, null, 2).slice(0, 1500));
    } catch (err) {
      setSourceText(err.message);
    }
  }

  async function saveNote(event) {
    event.preventDefault();
    setNoteError('');
    try {
      await api('/api/fraymus-os/notes', {
        method: 'POST',
        body: JSON.stringify({
          title: note.title,
          body: note.body,
          tags: note.tags.split(',').map(tag => tag.trim()).filter(Boolean),
        }),
      });
      setNote({ title: '', body: '', tags: '' });
      await load();
    } catch (err) {
      setNoteError(err.message);
    }
  }

  function onPointerDown(event) {
    const node = hitNode(event);
    if (node) {
      drag.current = { kind: 'node', id: node.id, moved: false, sx: event.clientX, sy: event.clientY };
      return;
    }
    drag.current = { kind: 'pan', sx: event.clientX, sy: event.clientY, ox: camera.current.x, oy: camera.current.y };
  }

  function onPointerMove(event) {
    if (!drag.current) return;
    if (drag.current.kind === 'pan') {
      const k = camera.current.k;
      camera.current.x = drag.current.ox + (event.clientX - drag.current.sx) / k;
      camera.current.y = drag.current.oy + (event.clientY - drag.current.sy) / k;
      draw();
      return;
    }
    const point = points.get(drag.current.id);
    if (!point) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const dx = (event.movementX / camera.current.k);
    const dy = (event.movementY / camera.current.k);
    if (Math.hypot(event.clientX - drag.current.sx, event.clientY - drag.current.sy) > 3) drag.current.moved = true;
    point.x += dx;
    point.y += dy;
    if (rect) draw();
  }

  function onPointerUp(event) {
    const current = drag.current;
    drag.current = null;
    if (current?.kind === 'node' && !current.moved) {
      const node = (data?.nodes || []).find(item => item.id === current.id);
      if (node) choose(node, event.shiftKey);
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const next = Math.min(2.4, Math.max(0.45, camera.current.k * (event.deltaY > 0 ? 0.92 : 1.08)));
    camera.current.k = next;
    draw();
  }

  const counts = data?.counts || {};
  const empty = data && data.total === 0 && !query && !kind;

  return (
    <div className={`brain ${compact ? 'is-compact' : ''}`}>
      {!compact && (
        <div className="brain-toolbar">
          <label className="search">
            <span>Search</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search notes, memories, agents…" />
          </label>
          <div className="kind-row" role="list">
            <button type="button" className={!kind ? 'on' : ''} onClick={() => setKind('')}>All {data?.total ?? '—'}</button>
            {KINDS.map(item => (
              <button type="button" key={item} className={kind === item ? 'on' : ''} onClick={() => setKind(item)} style={{ '--kind': KIND_COLORS[item] }}>
                <i />{item} {counts[item] || 0}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="brain-stage">
        <div className="brain-canvas" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { drag.current = null; }}
            onWheel={onWheel}
          />
          {loading && !data && <div className="brain-overlay">Reading the second brain…</div>}
          {error && (
            <div className="brain-overlay error">
              <p>The graph could not be read.</p>
              <p>{error}</p>
              <button type="button" onClick={load}>Retry</button>
            </div>
          )}
          {empty && !error && (
            <div className="brain-overlay">
              <p>The second brain is empty.</p>
              <p>Notes, memories, agents, workflows, and artifacts show up here only when Chandra already has them. Nothing on this graph is invented.</p>
            </div>
          )}
          {data && !empty && data.matched === 0 && !error && (
            <div className="brain-overlay">No records match that search.</div>
          )}
          {compact && (
            <button type="button" className="open-graph" onClick={onOpen}>Open second brain</button>
          )}
        </div>
        {!compact && (
          <aside className="inspector">
            <h2>Inspector</h2>
            {!selected && <p className="muted">Click a record. Shift-click a second one to trace how they connect.</p>}
            {selected && (
              <>
                <p className="kind-pill" style={{ color: KIND_COLORS[selected.kind] }}>{selected.kind}</p>
                <h3>{selected.title}</h3>
                <p>{selected.excerpt || selected.summary}</p>
                <dl>
                  <div><dt>Source</dt><dd>{selected.source}</dd></div>
                  <div><dt>Source id</dt><dd>{selected.sourceId}</dd></div>
                  <div><dt>Updated</dt><dd>{formatWhen(selected.updatedAt)}</dd></div>
                  <div><dt>Visibility</dt><dd>{selected.visibility}</dd></div>
                </dl>
                <pre>{JSON.stringify(selected.provenance, null, 2)}</pre>
                <button type="button" onClick={() => openSource(selected)}>Open source</button>
                {sourceText && <pre>{sourceText}</pre>}
              </>
            )}
            {pathNote && <p className="path-note">{pathNote}</p>}
            <form className="note-form" onSubmit={saveNote}>
              <h2>Save a note</h2>
              <input value={note.title} onChange={event => setNote({ ...note, title: event.target.value })} placeholder="Title" maxLength={200} />
              <textarea value={note.body} onChange={event => setNote({ ...note, body: event.target.value })} placeholder="What should the second brain keep?" rows={4} />
              <input value={note.tags} onChange={event => setNote({ ...note, tags: event.target.value })} placeholder="Tags, comma separated" />
              {noteError && <p className="warn">{noteError}</p>}
              <button type="submit">Save note</button>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
}
