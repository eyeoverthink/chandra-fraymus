import { useEffect, useMemo, useRef, useState } from 'react';
import { api, formatWhen } from './api.js';

/*
 * The second brain, as the agents use it: /api/fraymus-os/brain (knowledge graph + facts + goals + skills + model
 * calls). Drawn as orbits — the core at the centre, agents around it each carrying its memories as moons, facts /
 * goals / skills / models on the outer orbit next to the agent they belong to. Neighbouring orbits turn in opposite
 * directions; what was touched in the last seconds pulses (polled from /brain/pulse).
 *
 * Codes: colour = kind, line colour = relation, size = connections, outer ring = quality / confidence (red → green),
 * glow = added or touched in the last 24 h, a white flash = touched just now.
 */
export const BRAIN_KINDS = {
  core: { color: '#ffd36e', label: 'core' },
  agent: { color: '#c084fc', label: 'agents' },
  memory: { color: '#3ee0ff', label: 'memories' },
  reflection: { color: '#3ddc97', label: 'reflections' },
  fossil: { color: '#d4a373', label: 'fossils' },
  fact: { color: '#f472b6', label: 'facts' },
  goal: { color: '#a3e635', label: 'goals' },
  skill: { color: '#fb923c', label: 'skills' },
  model: { color: '#60a5fa', label: 'models' },
  note: { color: '#f5c16c', label: 'notes' },
};
export const RELATIONS = {
  semantically_related: { color: '62, 224, 255', alpha: 0.12, label: 'similar meaning' },
  owns_memory: { color: '192, 132, 252', alpha: 0.1, label: 'owns' },
  core: { color: '255, 211, 110', alpha: 0.07, label: 'core' },
  fact_of: { color: '244, 114, 182', alpha: 0.35, label: 'fact read from' },
  executed: { color: '163, 230, 53', alpha: 0.3, label: 'executed' },
  calls: { color: '251, 146, 60', alpha: 0.5, label: 'calls skill' },
  answered_by: { color: '96, 165, 250', alpha: 0.35, label: 'answered by' },
  note: { color: '245, 193, 108', alpha: 0.35, label: 'your note' },
};
const MOONS = new Set(['memory', 'reflection', 'fossil']);
const OUTER = { fact: 0, goal: 46, model: 92, skill: 120 };
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const R_AGENTS = 250, R_CLOUD = 120, R_NOTES = 64;

const fmt = n => (n == null ? '—' : Number(n).toLocaleString());
const pct = n => (n == null ? '—' : `${(n * 100).toFixed(1)} %`);
const qualityColor = q => `hsl(${Math.round(Math.max(0, Math.min(1, q)) * 120)}, 85%, 55%)`;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function hashAngle(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/** Orbit parameters for every node; positions are computed from them per frame (pos(t)). */
function buildOrbits(data) {
  const nodes = data.nodes, byId = new Map(nodes.map(n => [n.id, n]));
  const agents = nodes.filter(n => n.kind === 'agent').sort((a, b) => (b.metrics?.links || 0) - (a.metrics?.links || 0));
  const agentByLabel = new Map(agents.map(a => [a.agentId || a.title, a.id]));
  const agentIndex = new Map(agents.map((a, i) => [a.id, i]));
  const ownerOf = new Map(), linkedAgent = new Map();
  for (const e of data.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    if (e.type === 'owns_memory') { if (a.kind === 'agent' && MOONS.has(b.kind)) ownerOf.set(b.id, a.id); else if (b.kind === 'agent' && MOONS.has(a.kind)) ownerOf.set(a.id, b.id); }
    if (a.kind === 'agent' && !linkedAgent.has(b.id)) linkedAgent.set(b.id, a.id);
    if (b.kind === 'agent' && !linkedAgent.has(a.id)) linkedAgent.set(a.id, b.id);
  }
  const orbit = new Map([['core', { type: 'core' }]]);
  const moonCount = new Map(), cloud = [];
  let maxMoon = 0;
  for (const n of nodes) {
    if (!MOONS.has(n.kind)) continue;
    const owner = ownerOf.get(n.id) || agentByLabel.get(n.agentId);
    if (owner && agentIndex.has(owner)) {
      const k = moonCount.get(owner) || 0; moonCount.set(owner, k + 1);
      const r = 14 + 4.2 * Math.sqrt(k);                                     // packed tight: 60 moons stay within ~47 units
      maxMoon = Math.max(maxMoon, r);
      orbit.set(n.id, { type: 'moon', owner, angle: k * GOLDEN, r });
    } else cloud.push(n);
  }
  // each agent gets arc length for its whole moon system, big systems interleaved with small ones, and the ring grows
  // until nothing overlaps (the busiest agents side by side had merged into one blob)
  const reach = a => (moonCount.get(a.id) ? 14 + 4.2 * Math.sqrt(moonCount.get(a.id)) : 6) + 8;
  const bySize = [...agents].sort((a, b) => reach(b) - reach(a)), ring = [];
  for (let i = 0, j = bySize.length - 1; i <= j; i += 1, j -= 1) { ring.push(bySize[i]); if (i !== j) ring.push(bySize[j]); }
  const circumference = ring.reduce((s, a) => s + 2 * reach(a), 0);
  const rAgents = Math.max(R_AGENTS, circumference / (2 * Math.PI));
  let acc = 0;
  for (const a of ring) { const share = (2 * reach(a)) / Math.max(1, circumference) * Math.PI * 2; orbit.set(a.id, { type: 'agent', base: acc + share / 2, r: rAgents }); acc += share; }
  cloud.forEach((n, k) => orbit.set(n.id, { type: 'cloud', angle: k * GOLDEN, r: 40 + (R_CLOUD - 40) * Math.sqrt((k + 1) / (cloud.length + 1)) }));
  const outerBase = rAgents + Math.min(110, maxMoon) + 70;
  const outerCount = new Map();
  for (const n of nodes) {
    if (n.kind === 'note') { orbit.set(n.id, { type: 'note', angle: hashAngle(n.id), r: R_NOTES }); continue; }
    if (!(n.kind in OUTER)) continue;
    const agent = linkedAgent.get(n.id);
    const key = `${agent || 'none'}:${n.kind}`, k = outerCount.get(key) || 0; outerCount.set(key, k + 1);
    orbit.set(n.id, { type: 'outer', agent: agent && agentIndex.has(agent) ? agent : null, angle: agent ? (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.035 : hashAngle(n.id), r: outerBase + OUTER[n.kind] + (k % 3) * 9 });
  }
  return { orbit, agents, outerBase, rAgents };
}

export default function BrainGraph({ compact = false, initialQuery = '', onOpen }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const camera = useRef({ x: 0, y: 0, k: compact ? 0.42 : 0.78 });
  const drag = useRef(null);
  const posRef = useRef(new Map());
  const pulses = useRef(new Map());
  const clock = useRef({ t: 0, last: 0, paused: false });
  const hoverRef = useRef(null);
  const fitRef = useRef(true);                                                  // fit the whole system to the frame on the next draw
  const [query, setQuery] = useState(initialQuery);
  const [focus, setFocus] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [paused, setPaused] = useState(reducedMotion());
  const [pathIds, setPathIds] = useState([]);
  const [anchor, setAnchor] = useState(null);
  const [pathNote, setPathNote] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [note, setNote] = useState({ title: '', body: '', tags: '' });
  const [noteError, setNoteError] = useState('');

  const orbits = useMemo(() => (data ? buildOrbits(data) : null), [data]);
  const adjacency = useMemo(() => {
    const adj = new Map();
    for (const e of data?.edges || []) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      if (!adj.has(e.to)) adj.set(e.to, new Set());
      adj.get(e.from).add(e.to); adj.get(e.to).add(e.from);
    }
    return adj;
  }, [data]);
  const byId = useMemo(() => new Map((data?.nodes || []).map(n => [n.id, n])), [data]);

  useEffect(() => { setQuery(initialQuery || ''); }, [initialQuery]);
  useEffect(() => { clock.current.paused = paused; }, [paused]);
  useEffect(() => { hoverRef.current = hover?.id || null; }, [hover]);

  useEffect(() => {
    const handle = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, focus]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ budget: compact ? '260' : '700' });
      if (query.trim()) params.set('q', query.trim());
      if (focus) params.set('focus', focus);
      const body = await api(`/api/fraymus-os/brain?${params}`);
      fitRef.current = true;
      setData(body);
      setError('');
      setSelected(current => body.nodes.find(node => node.id === current?.id) || null);
    } catch (err) {
      setError(err.message || 'The second brain could not be read.');
    } finally {
      setLoading(false);
    }
  }

  // live: ids touched since the last look flash and glow
  useEffect(() => {
    let since = Date.now() - 60_000, stop = false;
    async function tick() {
      try {
        const body = await api(`/api/fraymus-os/brain/pulse?since=${since}`);
        since = body.at;
        const at = performance.now();
        for (const id of body.ids || []) pulses.current.set(id, at);
        for (const a of body.agents || []) for (const n of byId.values()) if (n.kind === 'agent' && (n.agentId === a || n.title === a)) pulses.current.set(n.id, at);
      } catch { /* the next tick tries again */ }
      if (!stop) timer = setTimeout(tick, compact ? 8000 : 4000);
    }
    let timer = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(timer); };
  }, [byId, compact]);

  // the frame loop: positions from orbit parameters and time, then draw
  useEffect(() => {
    if (!data || !orbits) return undefined;
    let raf = 0;
    const frame = (now) => {
      const c = clock.current;
      if (!c.paused && c.last) c.t += Math.min(0.1, (now - c.last) / 1000);
      c.last = now;
      place(c.t);
      draw(now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, orbits, selected, pathIds, hidden, hover]);

  function place(t) {
    const pos = posRef.current, { orbit } = orbits;
    pos.clear();
    pos.set('core', { x: 0, y: 0 });
    const agentAngle = new Map();
    for (const [id, o] of orbit) if (o.type === 'agent') {
      const a = o.base + t * 0.018;
      agentAngle.set(id, a);
      pos.set(id, { x: Math.cos(a) * o.r, y: Math.sin(a) * o.r });
    }
    for (const [id, o] of orbit) {
      if (o.type === 'moon') {
        const p = pos.get(o.owner); if (!p) continue;
        const a = o.angle - t * 0.12;
        pos.set(id, { x: p.x + Math.cos(a) * o.r, y: p.y + Math.sin(a) * o.r });
      } else if (o.type === 'cloud') {
        const a = o.angle + t * 0.03;
        pos.set(id, { x: Math.cos(a) * o.r, y: Math.sin(a) * o.r });
      } else if (o.type === 'note') {
        const a = o.angle - t * 0.05;
        pos.set(id, { x: Math.cos(a) * o.r, y: Math.sin(a) * o.r });
      } else if (o.type === 'outer') {
        const a = (o.agent ? agentAngle.get(o.agent) : -t * 0.01) + o.angle;
        pos.set(id, { x: Math.cos(a) * o.r, y: Math.sin(a) * o.r });
      }
    }
  }

  function sizeOf(node) {
    if (node.kind === 'core') return 15;
    if (node.kind === 'agent') return 5 + Math.min(9, Math.sqrt(node.metrics?.links || 0) * 0.9);
    return 2.2 + Math.min(5, Math.sqrt(node.metrics?.links || 0) * 0.8);
  }

  function draw(now) {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr)), h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (fitRef.current && rect.width > 10) {
      fitRef.current = false;
      camera.current = { x: 0, y: 0, k: Math.max(0.15, Math.min(1.2, (Math.min(rect.width, rect.height) / 2 - 16) / (orbits.outerBase + OUTER.skill + 30))) };
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createRadialGradient(rect.width / 2, rect.height / 2, 0, rect.width / 2, rect.height / 2, Math.max(rect.width, rect.height) * 0.7);
    bg.addColorStop(0, '#0b1424'); bg.addColorStop(1, '#05080e');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, rect.width, rect.height);
    const { x: cx, y: cy, k } = camera.current;
    const sx = p => rect.width / 2 + (p.x + cx) * k, sy = p => rect.height / 2 + (p.y + cy) * k;
    const pos = posRef.current, focusId = hoverRef.current || selected?.id || null;
    const near = focusId ? adjacency.get(focusId) || new Set() : null;
    const lit = id => !near || id === focusId || near.has(id) || pathIds.includes(id);
    const visible = n => !hidden.has(n.kind);

    // orbit guides
    ctx.lineWidth = 1;
    for (const r of [R_NOTES, R_CLOUD, orbits.rAgents, orbits.outerBase, orbits.outerBase + OUTER.goal, orbits.outerBase + OUTER.model]) {
      ctx.strokeStyle = 'rgba(120, 170, 210, 0.07)';
      ctx.beginPath(); ctx.arc(rect.width / 2 + cx * k, rect.height / 2 + cy * k, r * k, 0, Math.PI * 2); ctx.stroke();
    }

    // links
    for (const e of data.edges) {
      const a = pos.get(e.from), b = pos.get(e.to), na = byId.get(e.from), nb = byId.get(e.to);
      if (!a || !b || !na || !nb || !visible(na) || !visible(nb)) continue;
      const rel = RELATIONS[e.type] || RELATIONS.core;
      const onPath = pathIds.includes(e.from) && pathIds.includes(e.to);
      const touches = focusId && (e.from === focusId || e.to === focusId);
      let alpha = rel.alpha * (0.5 + Math.min(1, e.weight ?? 0.5));
      if (near) alpha = touches ? Math.min(0.9, alpha * 4) : alpha * 0.25;
      if (onPath) alpha = 0.95;
      ctx.strokeStyle = onPath ? 'rgba(255, 211, 110, 0.95)' : `rgba(${rel.color}, ${alpha})`;
      ctx.lineWidth = onPath || touches ? 1.6 : 0.8;
      ctx.beginPath(); ctx.moveTo(sx(a), sy(a)); ctx.lineTo(sx(b), sy(b)); ctx.stroke();
    }

    // nodes
    const showLabels = !compact;
    for (const n of data.nodes) {
      const p = pos.get(n.id);
      if (!p || !visible(n)) continue;
      const x = sx(p), y = sy(p), r = sizeOf(n) * Math.max(0.6, Math.min(1.6, k * 1.2));
      const color = (BRAIN_KINDS[n.kind] || BRAIN_KINDS.memory).color;
      const dim = !lit(n.id);
      const pulseAt = pulses.current.get(n.id), pulseAge = pulseAt ? (now - pulseAt) / 1000 : Infinity;
      ctx.globalAlpha = dim ? 0.16 : 1;
      if (n.metrics?.recent || pulseAge < 8 || n.kind === 'core') {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * (n.kind === 'core' ? 4 : 3));
        g.addColorStop(0, `${color}88`); g.addColorStop(1, `${color}00`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * (n.kind === 'core' ? 4 : 3), 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      const q = n.metrics?.quality ?? n.metrics?.confidence;
      // quality rings always on facts, goals, skills, models; on the thousands of moons only when zoomed in
      if (q != null && !Number.isNaN(Number(q)) && (!MOONS.has(n.kind) || k > 1.3 || n.id === focusId)) {
        ctx.strokeStyle = qualityColor(Number(q)); ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(x, y, r + 2.2, 0, Math.PI * 2); ctx.stroke();
      }
      if (pulseAge < 2.5) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${1 - pulseAge / 2.5})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, r + 4 + pulseAge * 10, 0, Math.PI * 2); ctx.stroke();
      }
      if (selected?.id === n.id || pathIds.includes(n.id)) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
      }
      const labelled = n.kind === 'core' || (showLabels && ((n.kind === 'agent' && k > 0.55) || k > 1.7 || n.id === focusId || (near && near.has(n.id) && k > 0.9)));
      if (labelled && !dim) {
        ctx.font = n.kind === 'core' ? '600 13px ui-sans-serif, system-ui, sans-serif' : '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = n.kind === 'core' ? '#ffe7a8' : 'rgba(225, 240, 248, 0.88)';
        ctx.fillText(n.kind === 'core' ? `${n.title} · ${n.metrics?.tier || ''}` : n.title.slice(0, 34), x + r + 5, y + 4);
      }
      ctx.globalAlpha = 1;
    }
  }

  function screenToWorld(event) {
    const rect = canvasRef.current.getBoundingClientRect(), { x, y, k } = camera.current;
    return { x: (event.clientX - rect.left - rect.width / 2) / k - x, y: (event.clientY - rect.top - rect.height / 2) / k - y };
  }
  function hitNode(event) {
    const w = screenToWorld(event);
    let best = null, bestDist = 12 / camera.current.k;
    for (const n of data?.nodes || []) {
      if (hidden.has(n.kind)) continue;
      const p = posRef.current.get(n.id); if (!p) continue;
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d < bestDist) { best = n; bestDist = d; }
    }
    return best;
  }

  function pathBetween(from, to) {
    const prev = new Map([[from, null]]), queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      for (const nx of adjacency.get(cur) || []) { if (prev.has(nx)) continue; prev.set(nx, cur); queue.push(nx); }
    }
    if (!prev.has(to)) return null;
    const chain = []; for (let c = to; c; c = prev.get(c)) chain.push(c);
    return chain.reverse();
  }

  function choose(node, shift) {
    setSelected(node);
    setSourceText('');
    if (!shift || !anchor || anchor === node.id) {
      setAnchor(node.id); setPathIds([]);
      setPathNote(compact ? '' : 'Shift-click another node to trace how they connect.');
      return;
    }
    const chain = pathBetween(anchor, node.id);
    setPathIds(chain || []);
    setPathNote(chain ? `${chain.length - 1} link${chain.length === 2 ? '' : 's'} apart: ${chain.map(id => byId.get(id)?.title || id).join(' → ')}` : 'No path joins these two in the part of the brain shown.');
  }

  async function openSource(node) {
    if (!node?.openPath) return;
    try {
      const body = await api(node.openPath);
      setSourceText(JSON.stringify({ title: body.title || body.name, source: body.source || body.provenance?.store, excerpt: body.excerpt || body.body || body.summary, provenance: body.provenance }, null, 2).slice(0, 1500));
    } catch (err) { setSourceText(err.message); }
  }

  async function saveNote(event) {
    event.preventDefault();
    setNoteError('');
    try {
      await api('/api/fraymus-os/notes', { method: 'POST', body: JSON.stringify({ title: note.title, body: note.body, tags: note.tags.split(',').map(t => t.trim()).filter(Boolean) }) });
      setNote({ title: '', body: '', tags: '' });
      await load();
    } catch (err) { setNoteError(err.message); }
  }

  function onPointerDown(event) {
    if (!data) return;
    const node = hitNode(event);
    drag.current = node ? { kind: 'node', id: node.id, sx: event.clientX, sy: event.clientY } : { kind: 'pan', sx: event.clientX, sy: event.clientY, ox: camera.current.x, oy: camera.current.y, moved: false };
  }
  function onPointerMove(event) {
    if (!data) return;
    if (drag.current?.kind === 'pan') {
      const k = camera.current.k;
      camera.current.x = drag.current.ox + (event.clientX - drag.current.sx) / k;
      camera.current.y = drag.current.oy + (event.clientY - drag.current.sy) / k;
      if (Math.hypot(event.clientX - drag.current.sx, event.clientY - drag.current.sy) > 3) drag.current.moved = true;
      return;
    }
    const node = hitNode(event);
    const rect = canvasRef.current.getBoundingClientRect();
    if ((node?.id || null) !== (hover?.id || null)) setHover(node ? { id: node.id, x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
  }
  function onPointerUp(event) {
    const cur = drag.current;
    drag.current = null;
    if (cur?.kind === 'node') { const node = byId.get(cur.id); if (node) choose(node, event.shiftKey); }
    if (cur?.kind === 'pan' && !cur.moved && !compact) { setSelected(null); setPathIds([]); setPathNote(''); }
  }
  function onWheel(event) {
    event.preventDefault();
    camera.current.k = Math.min(4, Math.max(0.2, camera.current.k * (event.deltaY > 0 ? 0.9 : 1.1)));
  }
  function toggleKind(kind) {
    setHidden(prev => { const next = new Set(prev); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; });
  }

  const whole = data?.whole, shown = data?.shown, coreNode = data?.nodes?.[0];
  const hoverNode = hover ? byId.get(hover.id) : null;
  const neighbours = selected ? [...(adjacency.get(selected.id) || [])].map(id => byId.get(id)).filter(Boolean).sort((a, b) => (b.metrics?.links || 0) - (a.metrics?.links || 0)).slice(0, 14) : [];

  const metricsStrip = whole && (
    <div className="bx-metrics" aria-label="Brain metrics">
      <span title="The knowledge graph agents recall from"><b>{fmt(whole.knowledgeNodes)}</b> nodes</span>
      <span><b>{fmt(whole.knowledgeEdges)}</b> links</span>
      {!compact && <span title="Memories with an embedding (searchable by meaning)"><b>{fmt(whole.memories)}</b> memories · {pct(whole.memories ? whole.memoriesEmbedded / whole.memories : null)} embedded</span>}
      <span title="Current claims; older versions are kept as superseded"><b>{fmt(whole.facts)}</b> facts{!compact && ` · ${fmt(whole.factsSuperseded)} superseded`}</span>
      {!compact && <span title="Separate islands in the whole knowledge graph"><b>{fmt(whole.components)}</b> islands · {pct(whole.orphanShare)} unlinked</span>}
      {!compact && <span>avg <b>{whole.avgDegree}</b> links/node</span>}
      <span title="Knowledge nodes added in the last 24 hours"><b>+{fmt(whole.added24h)}</b> today</span>
      {!compact && <span title="Times a node was handed to an agent's prompt"><b>{fmt(whole.recallHits)}</b> recalls</span>}
      {!compact && whole.goals7d && <span title="Goals finished in 7 days, mean quality"><b>{fmt(whole.goals7d.n)}</b> goals · q <b style={{ color: whole.goals7d.q != null ? qualityColor(whole.goals7d.q) : undefined }}>{whole.goals7d.q ?? '—'}</b></span>}
      {coreNode?.metrics?.tier && <span className="bx-tier">{coreNode.metrics.tier}{coreNode.metrics.phi != null && ` · Φ ${Number(coreNode.metrics.phi).toFixed(2)}`}</span>}
      {!compact && whole.lastConsolidation && <span>consolidated {formatWhen(whole.lastConsolidation)}</span>}
    </div>
  );

  return (
    <div className={`brain bx ${compact ? 'is-compact' : ''}`}>
      {!compact && (
        <div className="brain-toolbar">
          <div className="bx-row">
            <label className="search">
              <span>Search</span>
              <input value={query} onChange={event => { setQuery(event.target.value); setFocus(''); }} placeholder="Search what the brain knows…" />
            </label>
            <button type="button" onClick={() => setPaused(p => !p)}>{paused ? 'Resume orbits' : 'Pause orbits'}</button>
            {focus && <button type="button" onClick={() => setFocus('')}>Show whole brain</button>}
            <button type="button" onClick={() => { fitRef.current = true; }}>Recentre</button>
          </div>
          {metricsStrip}
          <div className="kind-row" role="list">
            {Object.entries(BRAIN_KINDS).filter(([kind]) => kind !== 'core').map(([kind, info]) => (
              <button type="button" key={kind} className={hidden.has(kind) ? '' : 'on'} onClick={() => toggleKind(kind)} style={{ '--kind': info.color }} title={hidden.has(kind) ? 'Show' : 'Hide'}>
                <i />{info.label} {data?.counts?.[kind] || 0}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="brain-stage">
        <div className="brain-canvas" ref={wrapRef}>
          <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerLeave={() => { drag.current = null; setHover(null); }} onWheel={onWheel} />
          {loading && !data && <div className="brain-overlay">Reading the second brain…</div>}
          {error && (
            <div className="brain-overlay error">
              <p>The second brain could not be read.</p>
              <p>{error}</p>
              <button type="button" onClick={load}>Retry</button>
            </div>
          )}
          {data && data.nodes.length <= 1 && !error && <div className="brain-overlay">{query ? 'Nothing the brain knows matches that search.' : 'The second brain is empty.'}</div>}
          {hoverNode && (
            <div className="bx-tip" style={{ left: Math.min(hover.x + 14, (wrapRef.current?.clientWidth || 400) - 250), top: hover.y + 14 }}>
              <p className="kind-pill" style={{ color: BRAIN_KINDS[hoverNode.kind]?.color }}>{hoverNode.kind}</p>
              <b>{hoverNode.title}</b>
              {hoverNode.summary && <span>{hoverNode.summary.slice(0, 140)}</span>}
              <small>{hoverNode.metrics?.links || 0} links shown{hoverNode.metrics?.degree ? ` · ${hoverNode.metrics.degree} in the brain` : ''}{hoverNode.metrics?.access ? ` · recalled ${hoverNode.metrics.access}×` : ''}</small>
            </div>
          )}
          {compact && (
            <>
              <div className="bx-mini">{metricsStrip}</div>
              <button type="button" className="open-graph" onClick={onOpen}>Open second brain</button>
            </>
          )}
          {!compact && data && (
            <div className="bx-legend">
              {Object.entries(RELATIONS).map(([key, rel]) => (data.relations?.[key] ? <span key={key}><i style={{ background: `rgb(${rel.color})` }} />{rel.label} {fmt(data.relations[key])}</span> : null))}
              <span><i className="bx-q" />quality / confidence</span>
              {shown && <span>showing {fmt(shown.nodes)} nodes · {fmt(shown.edges)} links</span>}
            </div>
          )}
        </div>
        {!compact && (
          <aside className="inspector">
            <h2>Inspector</h2>
            {!selected && <p className="muted">Hover a node to light up what it touches. Click to inspect it. Shift-click a second node to trace the path between them.</p>}
            {selected && (
              <>
                <p className="kind-pill" style={{ color: BRAIN_KINDS[selected.kind]?.color }}>{selected.kind}</p>
                <h3>{selected.title}</h3>
                <p>{selected.summary}</p>
                <dl>
                  {selected.metrics?.tier && <div><dt>Tier</dt><dd>{selected.metrics.tier}{selected.metrics.phi != null && ` · Φ ${Number(selected.metrics.phi).toFixed(3)}`} · {selected.metrics.proofs}/4 proofs</dd></div>}
                  <div><dt>Links</dt><dd>{selected.metrics?.links || 0} shown{selected.metrics?.degree ? ` · ${fmt(selected.metrics.degree)} in the whole brain` : ''}</dd></div>
                  {selected.metrics?.access != null && <div><dt>Recalled</dt><dd>{selected.metrics.access}×</dd></div>}
                  {selected.metrics?.quality != null && <div><dt>Quality</dt><dd style={{ color: qualityColor(selected.metrics.quality) }}>{Number(selected.metrics.quality).toFixed(2)}</dd></div>}
                  {selected.metrics?.confidence != null && <div><dt>Confidence</dt><dd style={{ color: qualityColor(selected.metrics.confidence) }}>{Number(selected.metrics.confidence).toFixed(2)}</dd></div>}
                  {selected.metrics?.status && <div><dt>Status</dt><dd>{selected.metrics.status}</dd></div>}
                  {selected.metrics?.calls != null && <div><dt>Calls</dt><dd>{fmt(selected.metrics.calls)}</dd></div>}
                  {selected.metrics?.claims != null && <div><dt>Claims</dt><dd>{selected.metrics.claims}</dd></div>}
                  {selected.metrics?.createdAt && <div><dt>When</dt><dd>{formatWhen(selected.metrics.createdAt)}</dd></div>}
                  {selected.source && <div><dt>Source</dt><dd>{selected.source} · {selected.sourceId}</dd></div>}
                </dl>
                <div className="bx-actions">
                  {selected.kind !== 'core' && selected.source && ['agent_memories', 'reflections', 'state_fossils', 'agents'].includes(selected.source) && <button type="button" onClick={() => setFocus(selected.id)}>Focus here</button>}
                  {selected.openPath && <button type="button" onClick={() => openSource(selected)}>Open source</button>}
                </div>
                {sourceText && <pre>{sourceText}</pre>}
                {neighbours.length > 0 && (
                  <div className="bx-neigh">
                    <h4>Connected to</h4>
                    {neighbours.map(n => (
                      <button type="button" key={n.id} onClick={() => choose(n, false)}><i style={{ background: BRAIN_KINDS[n.kind]?.color }} />{n.title}</button>
                    ))}
                  </div>
                )}
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
