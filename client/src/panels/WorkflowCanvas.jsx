import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, Panel,
  useNodesState, useEdgesState, addEdge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const NODE_CATEGORIES = [
  { id: 'core', label: 'Core', color: '#8b5cf6', types: [
    { type: 'llm', label: 'LLM Chat', color: '#8b5cf6', icon: '🧠' },
    { type: 'code', label: 'Code Sandbox', color: '#a855f7', icon: '💻' },
    { type: 'web_search', label: 'Web Search', color: '#3b82f6', icon: '🔎' },
    { type: 'preview', label: 'HTML Preview', color: '#10b981', icon: '🖼️' },
  ]},
  { id: 'agents', label: 'Agents', color: '#06b6d4', types: [
    { type: 'researcher', label: 'Researcher', color: '#06b6d4', icon: '🔬' },
    { type: 'copywriter', label: 'Copywriter', color: '#f59e0b', icon: '✍️' },
    { type: 'reviewer', label: 'QA Reviewer', color: '#22c55e', icon: '✅' },
    { type: 'ceo_logger', label: 'CEO Logger', color: '#a78bfa', icon: '📋' },
  ]},
  { id: 'media', label: 'Media', color: '#ec4899', types: [
    { type: 'image_gen', label: 'Image Gen', color: '#ec4899', icon: '🎨' },
    { type: 'bg_remove', label: 'BG Remove', color: '#06b6d4', icon: '✂️' },
    { type: 'upscale', label: 'Upscale', color: '#f59e0b', icon: '🔍' },
  ]},
  { id: 'intelligence', label: 'Intelligence', color: '#d946ef', types: [
    { type: 'heart_feel', label: 'Heart Feel', color: '#f59e0b', icon: '♥' },
    { type: 'dream', label: 'Dream', color: '#8b5cf6', icon: '☾' },
    { type: 'consciousness_prove', label: 'Consciousness Prove', color: '#ec4899', icon: '◈' },
    { type: 'cognition', label: 'Cognition', color: '#22c55e', icon: '⚡' },
    { type: 'memory_recall', label: 'Memory Recall', color: '#14b8a6', icon: '🌉' },
    { type: 'intelligence_cycle', label: 'Intelligence Cycle', color: '#d946ef', icon: '🔮' },
  ]},
  { id: 'fraymus', label: 'FRAYMUS', color: '#6366f1', types: [
    { type: 'tool:fraymus.encode.dna', label: 'DNA Encode', color: '#6366f1', icon: '🧬' },
    { type: 'tool:fraymus.identity.sign', label: 'Sign', color: '#f43f5e', icon: '🔐' },
    { type: 'tool:fraymus.mesh.post', label: 'Mesh Post', color: '#14b8a6', icon: '🕸️' },
  ]},
  { id: 'commerce', label: 'Commerce', color: '#96bf48', types: [
    { type: 'shopify_publish', label: 'Shopify Publish', color: '#96bf48', icon: '🛒' },
    { type: 'shopify_sync', label: 'Shopify Sync', color: '#96bf48', icon: '🔄' },
    { type: 'shopify_applier', label: 'Shopify Applier', color: '#96bf48', icon: '🚀' },
    { type: 'trend_scout', label: 'Trend Scout', color: '#e879f9', icon: '📊' },
    { type: 'apparel_designer', label: 'Apparel Designer', color: '#fb923c', icon: '👕' },
    { type: 'printify_push', label: 'Printify Push', color: '#34d399', icon: '🖨️' },
    { type: 'pricing_engine', label: 'Pricing Engine', color: '#fbbf24', icon: '💰' },
    { type: 'mystery_shopper', label: 'Mystery Shopper', color: '#f472b6', icon: '🕵️' },
    { type: 'ux_auditor', label: 'UX Auditor', color: '#c084fc', icon: '🔍' },
    { type: 'price_analyst', label: 'Price Analyst', color: '#fb7185', icon: '📈' },
    { type: 'shopper_report', label: 'Shopper Report', color: '#818cf8', icon: '📝' },
    { type: 'page_generator', label: 'Page Generator', color: '#2dd4bf', icon: '📄' },
    { type: 'collection_organizer', label: 'Collection Organizer', color: '#a3e635', icon: '🗂️' },
    { type: 'description_enhancer', label: 'Description Enhancer', color: '#facc15', icon: '✨' },
    { type: 'price_adjuster', label: 'Price Adjuster', color: '#f97316', icon: '💲' },
  ]},
];

const NODE_TYPES = NODE_CATEGORIES.flatMap(c => c.types);

const STATUS_COLORS = { running: '#f59e0b', success: '#22c55e', error: '#ef4444' };

function NodeCard({ data }) {
  const def = NODE_TYPES.find(t => t.type === data.type) || { color: '#666', icon: '⬡', label: data.type };
  const status = data._status;
  const borderColor = status ? STATUS_COLORS[status] : `${def.color}40`;
  const glow = status === 'running' ? `0 0 12px ${STATUS_COLORS.running}60` : status ? `0 0 8px ${STATUS_COLORS[status]}30` : `0 4px 12px ${def.color}15`;
  return (
    <div style={{
      background: '#1a1a2e', border: `2px solid ${borderColor}`, borderRadius: 12,
      padding: '12px 16px', minWidth: 160, boxShadow: glow,
      animation: status === 'running' ? 'pulse 1.5s ease-in-out infinite' : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 18 }}>{def.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: def.color }}>{def.label}</span>
        {status && (
          <span style={{ fontSize: 10, marginLeft: 'auto', color: STATUS_COLORS[status], fontWeight: 700 }}>
            {status === 'running' ? '...' : status === 'success' ? 'OK' : 'ERR'}
          </span>
        )}
      </div>
      {data.prompt && <div style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{data.prompt}</div>}
      {data._durationMs != null && (
        <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>{data._durationMs}ms</div>
      )}
    </div>
  );
}

const nodeTypes = { custom: NodeCard };

const defaultEdgeOptions = {
  animated: true,
  style: { stroke: '#a78bfa', strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#a78bfa' },
};

let nodeId = 0;

function getDepth(id, parentMap, memo) {
  if (memo[id] !== undefined) return memo[id];
  const parents = parentMap[id] || [];
  if (parents.length === 0) { memo[id] = 0; return 0; }
  memo[id] = 1 + Math.max(...parents.map(p => getDepth(p, parentMap, memo)));
  return memo[id];
}

function NodeEditor({ node, onUpdate, onClose }) {
  const [prompt, setPrompt] = useState(node.data.prompt || '');
  const def = NODE_TYPES.find(t => t.type === node.data.type) || { label: node.data.type, icon: '?', color: '#666' };
  return (
    <div style={{
      position: 'absolute', right: 0, top: 0, bottom: 0, width: 280, zIndex: 10,
      background: '#111118', borderLeft: '1px solid #333', padding: 16, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 16 }}>{def.icon}</span>
          <span style={{ color: def.color, fontSize: 13, fontWeight: 600 }}>{def.label}</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 }}>x</button>
      </div>
      <label style={{ color: '#888', fontSize: 11, fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
        Node ID
      </label>
      <div style={{ color: '#555', fontSize: 11, marginBottom: 12, fontFamily: 'monospace' }}>{node.id}</div>
      <label style={{ color: '#888', fontSize: 11, fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
        Prompt / Config
      </label>
      <textarea
        value={prompt} onChange={e => setPrompt(e.target.value)}
        placeholder="Enter node prompt or configuration..."
        rows={6}
        style={{
          background: '#0a0a0f', border: '1px solid #222', borderRadius: 6, padding: 8,
          color: '#e0e0e8', fontSize: 12, resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
        }}
      />
      <button onClick={() => { onUpdate(node.id, prompt); onClose(); }} style={{
        marginTop: 10, background: '#6366f1', border: 'none', borderRadius: 6, padding: '8px 0',
        color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      }}>Apply</button>
    </div>
  );
}

function CategorizedPalette({ onAdd, collapsed }) {
  const [openCat, setOpenCat] = useState('core');
  if (collapsed) return null;
  return (
    <div style={{ width: 190, background: '#111118', borderRight: '1px solid #222', padding: '8px 10px', overflowY: 'auto' }}>
      <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>
        Node Palette ({NODE_TYPES.length})
      </div>
      {NODE_CATEGORIES.map(cat => (
        <div key={cat.id} style={{ marginBottom: 4 }}>
          <button onClick={() => setOpenCat(openCat === cat.id ? null : cat.id)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
            padding: '5px 8px', background: openCat === cat.id ? '#1a1a2e' : 'transparent',
            border: `1px solid ${openCat === cat.id ? cat.color + '40' : 'transparent'}`,
            borderRadius: 6, color: openCat === cat.id ? cat.color : '#888', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', transition: 'all 0.15s',
          }}>
            {cat.label} ({cat.types.length})
            <span style={{ fontSize: 9 }}>{openCat === cat.id ? '▾' : '▸'}</span>
          </button>
          {openCat === cat.id && (
            <div style={{ padding: '4px 0 4px 6px' }}>
              {cat.types.map(t => (
                <button key={t.type} onClick={() => onAdd(t.type)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  padding: '5px 8px', background: '#0f0f18', border: `1px solid ${t.color}20`,
                  borderRadius: 6, color: '#ccc', fontSize: 11, cursor: 'pointer', marginBottom: 3,
                  transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = t.color}
                  onMouseLeave={e => e.currentTarget.style.borderColor = t.color + '20'}
                >
                  <span style={{ fontSize: 12 }}>{t.icon}</span> {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function WorkflowCanvas({ wsEvent }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [workflows, setWorkflows] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('New Workflow');
  const [editingNode, setEditingNode] = useState(null);
  const [palletteCollapsed, setPaletteCollapsed] = useState(false);
  const reactFlowWrapper = useRef(null);

  const loadWorkflows = useCallback(() => {
    fetch('/api/workflows').then(r => r.json()).then(d => setWorkflows(d.workflows || [])).catch(() => {});
  }, []);

  const loadDefinitions = useCallback(() => {
    fetch('/api/workflows/definitions').then(r => r.json()).then(d => setDefinitions(d.definitions || [])).catch(() => {});
  }, []);

  useEffect(() => { loadWorkflows(); loadDefinitions(); }, [loadWorkflows, loadDefinitions]);
  useEffect(() => {
    if (wsEvent?.type === 'workflow') loadWorkflows();
  }, [wsEvent, loadWorkflows]);

  const onConnect = useCallback(params => setEdges(eds => addEdge(params, eds)), [setEdges]);

  const addNode = useCallback((type) => {
    const id = `node_${++nodeId}_${Date.now()}`;
    setNodes(nds => [...nds, {
      id, type: 'custom', position: { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
      data: { type, prompt: '', label: type },
    }]);
  }, [setNodes]);

  const onNodeClick = useCallback((_event, node) => {
    setEditingNode(node);
  }, []);

  const updateNodePrompt = useCallback((nodeId, prompt) => {
    setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, prompt } } : n));
  }, [setNodes]);

  const deleteSelected = useCallback(() => {
    setNodes(nds => nds.filter(n => !n.selected));
    setEdges(eds => eds.filter(e => !e.selected));
    setEditingNode(null);
  }, [setNodes, setEdges]);

  const autoLayout = useCallback(() => {
    const sorted = [];
    const visited = new Set();
    const edgeMap = {};
    edges.forEach(e => { edgeMap[e.target] = edgeMap[e.target] || []; edgeMap[e.target].push(e.source); });
    const roots = nodes.filter(n => !edges.some(e => e.target === n.id));
    const queue = [...roots.map(r => r.id)];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      sorted.push(id);
      edges.filter(e => e.source === id).forEach(e => queue.push(e.target));
    }
    nodes.filter(n => !visited.has(n.id)).forEach(n => sorted.push(n.id));
    const cols = {};
    sorted.forEach((id, i) => {
      const depth = getDepth(id, edgeMap, {});
      cols[depth] = (cols[depth] || 0);
      const x = 80 + depth * 280;
      const y = 60 + cols[depth] * 120;
      cols[depth]++;
      setNodes(nds => nds.map(n => n.id === id ? { ...n, position: { x, y } } : n));
    });
  }, [nodes, edges, setNodes]);

  const loadTemplate = useCallback((defName) => {
    const def = definitions.find(d => d.name === defName);
    if (!def) return;
    setCurrentId(null);
    setResult(null);
    setName(defName.replace(/([A-Z])/g, ' $1').trim());
    setNodes(def.nodes.map(n => ({
      id: n.id, type: 'custom', position: n.position || { x: 100, y: 100 },
      data: { type: n.type || n.data?.type, prompt: n.data?.prompt || '', label: n.type || n.data?.type },
    })));
    setEdges(def.edges.map(e => ({
      id: e.id || `${e.source}-${e.target}`, source: e.source, target: e.target,
    })));
  }, [definitions, setNodes, setEdges]);

  const saveWorkflow = useCallback(async () => {
    try {
      setError(null);
      const payload = {
        name,
        nodes: nodes.map(n => ({ id: n.id, type: n.data.type, data: n.data, position: n.position })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
      };
      if (currentId) {
        await fetch(`/api/workflows/${currentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } else {
        const res = await fetch('/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        setCurrentId(data.id);
      }
      loadWorkflows();
    } catch (e) { setError(`Save failed: ${e.message}`); }
  }, [nodes, edges, name, currentId, loadWorkflows]);

  const applyNodeStatuses = useCallback((statusMap) => {
    setNodes(nds => nds.map(n => ({
      ...n,
      data: {
        ...n.data,
        _status: statusMap[n.id]?.status || null,
        _durationMs: statusMap[n.id]?.durationMs ?? null,
      },
    })));
  }, [setNodes]);

  const runWorkflow = useCallback(async () => {
    if (!currentId) { await saveWorkflow(); }
    setRunning(true);
    setResult(null);
    const allRunning = {};
    nodes.forEach(n => { allRunning[n.id] = { status: 'running' }; });
    applyNodeStatuses(allRunning);
    try {
      const id = currentId || workflows[0]?.id;
      if (!id) return;
      const res = await fetch(`/api/workflows/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Run this workflow' }) });
      const data = await res.json();
      setResult(data);
      if (data.results) {
        const statusMap = {};
        for (const [nodeId, r] of Object.entries(data.results)) {
          statusMap[nodeId] = { status: r.error ? 'error' : 'success', durationMs: r.durationMs };
        }
        applyNodeStatuses(statusMap);
      }
    } catch (e) {
      setResult({ error: e.message });
      applyNodeStatuses({});
    } finally {
      setRunning(false);
    }
  }, [currentId, saveWorkflow, workflows, nodes, applyNodeStatuses]);

  const loadWorkflow = useCallback(async (id) => {
    try {
      setError(null);
      const res = await fetch(`/api/workflows/${id}`);
      const wf = await res.json();
      setCurrentId(id);
      setName(wf.name);
      const parsed = typeof wf.nodes === 'string' ? JSON.parse(wf.nodes) : wf.nodes;
      const parsedEdges = typeof wf.edges === 'string' ? JSON.parse(wf.edges) : wf.edges;
      setNodes(parsed.map(n => ({ id: n.id, type: 'custom', position: n.position || { x: 100, y: 100 }, data: n.data || { type: n.type } })));
      setEdges(parsedEdges.map(e => ({ id: e.id || `${e.source}-${e.target}`, source: e.source, target: e.target })));
    } catch (e) { setError(`Load failed: ${e.message}`); }
  }, [setNodes, setEdges]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }`}</style>
      {error && <div style={{ background: '#2d1b1b', border: '1px solid #5b2b2b', padding: '8px 12px', color: '#f87171', fontSize: 13 }}>{error}</div>}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        background: '#111118', borderBottom: '1px solid #222', flexWrap: 'wrap',
      }}>
        <input value={name} onChange={e => setName(e.target.value)} style={{
          background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, padding: '6px 12px',
          color: '#e0e0e8', fontSize: 14, width: 180,
        }} />
        <span style={{ fontSize: 10, color: '#555', padding: '4px 8px', background: '#1a1a2e', borderRadius: 4 }}>
          {nodes.length} nodes / {edges.length} edges
        </span>
        <button onClick={saveWorkflow} style={btnStyle('#6366f1')}>Save</button>
        <button onClick={runWorkflow} disabled={running} style={btnStyle('#10b981')}>{running ? 'Running...' : 'Run ▶'}</button>
        <button onClick={autoLayout} disabled={nodes.length === 0} style={btnStyle('#3b82f6')}>Layout</button>
        <button onClick={deleteSelected} style={btnStyle('#ef4444')}>Delete</button>
        <button onClick={() => { setNodes([]); setEdges([]); setCurrentId(null); setName('New Workflow'); setResult(null); setEditingNode(null); }} style={btnStyle('#666')}>New</button>
        <button onClick={() => setPaletteCollapsed(!palletteCollapsed)} style={btnStyle('#444')}>{palletteCollapsed ? '◂ Show' : '◂ Hide'}</button>
        {workflows.length > 0 && (
          <select onChange={e => e.target.value && loadWorkflow(e.target.value)} style={selectStyle}>
            <option value="">Load saved...</option>
            {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {definitions.length > 0 && (
          <select onChange={e => { if (e.target.value) loadTemplate(e.target.value); e.target.value = ''; }} style={{ ...selectStyle, borderColor: '#6366f140' }}>
            <option value="">Templates ({definitions.length})...</option>
            {definitions.map(d => <option key={d.name} value={d.name}>{d.name.replace(/([A-Z])/g, ' $1').trim()}</option>)}
          </select>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
        <CategorizedPalette onAdd={addNode} collapsed={palletteCollapsed} />

        <div ref={reactFlowWrapper} style={{ flex: 1 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            fitView
            style={{ background: '#0a0a0f' }}
          >
            <Background color="#222" gap={20} />
            <Controls style={{ background: '#1a1a2e', borderColor: '#333' }} />
            <MiniMap style={{ background: '#111118' }} nodeColor={() => '#a78bfa'} />
            {result && (
              <Panel position="bottom-right" style={{
                background: '#1a1a2e', border: '1px solid #333', borderRadius: 12,
                padding: 16, maxWidth: 360, maxHeight: 300, overflow: 'auto', fontSize: 12,
              }}>
                <div style={{ fontWeight: 600, color: result.status === 'success' ? '#10b981' : '#f43f5e', marginBottom: 8 }}>
                  {result.status === 'success' ? 'OK' : result.error ? 'ERR' : 'FAIL'} · {result.durationMs || 0}ms
                </div>
                {result.results && Object.entries(result.results).map(([id, r]) => (
                  <div key={id} style={{ color: r.error ? '#f43f5e' : '#888', marginBottom: 4 }}>
                    {r.type}: {r.error || r.text?.slice(0, 80) || 'ok'} ({r.durationMs}ms)
                  </div>
                ))}
              </Panel>
            )}
          </ReactFlow>
        </div>
        {editingNode && (
          <NodeEditor
            node={editingNode}
            onUpdate={updateNodePrompt}
            onClose={() => setEditingNode(null)}
          />
        )}
      </div>
    </div>
  );
}

const btnStyle = (bg) => ({
  background: bg, border: 'none', borderRadius: 6, padding: '6px 14px',
  color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
});

const selectStyle = {
  background: '#1a1a2e', border: '1px solid #333', borderRadius: 6,
  padding: '6px 8px', color: '#e0e0e8', fontSize: 12,
};
