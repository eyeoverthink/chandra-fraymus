import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, Panel,
  useNodesState, useEdgesState, addEdge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const NODE_TYPES = [
  { type: 'llm', label: 'LLM Chat', color: '#8b5cf6', icon: '🧠' },
  { type: 'image_gen', label: 'Image Gen', color: '#ec4899', icon: '🎨' },
  { type: 'bg_remove', label: 'BG Remove', color: '#06b6d4', icon: '✂️' },
  { type: 'upscale', label: 'Upscale', color: '#f59e0b', icon: '🔍' },
  { type: 'preview', label: 'HTML Preview', color: '#10b981', icon: '🖼️' },
  { type: 'tool:fraymus.encode.dna', label: 'DNA Encode', color: '#6366f1', icon: '🧬' },
  { type: 'tool:fraymus.identity.sign', label: 'Sign', color: '#f43f5e', icon: '🔐' },
  { type: 'tool:fraymus.mesh.post', label: 'Mesh Post', color: '#14b8a6', icon: '🕸️' },
  { type: 'web_search', label: 'Web Search', color: '#3b82f6', icon: '🔎' },
  { type: 'code', label: 'Code Sandbox', color: '#a855f7', icon: '💻' },
  { type: 'researcher', label: 'Researcher', color: '#06b6d4', icon: '🔬' },
  { type: 'copywriter', label: 'Copywriter', color: '#f59e0b', icon: '✍️' },
  { type: 'reviewer', label: 'QA Reviewer', color: '#22c55e', icon: '✅' },
  { type: 'ceo_logger', label: 'CEO Logger', color: '#a78bfa', icon: '📋' },
  { type: 'shopify_publish', label: 'Shopify Publish', color: '#96bf48', icon: '🛒' },
  { type: 'trend_scout', label: 'Trend Scout', color: '#e879f9', icon: '📊' },
  { type: 'apparel_designer', label: 'Apparel Designer', color: '#fb923c', icon: '👕' },
  { type: 'printify_push', label: 'Printify Push', color: '#34d399', icon: '🖨️' },
  { type: 'shopify_sync', label: 'Shopify Sync', color: '#96bf48', icon: '🔄' },
  { type: 'pricing_engine', label: 'Pricing Engine', color: '#fbbf24', icon: '💰' },
  { type: 'mystery_shopper', label: 'Mystery Shopper', color: '#f472b6', icon: '🕵️' },
  { type: 'ux_auditor', label: 'UX Auditor', color: '#c084fc', icon: '🔍' },
  { type: 'price_analyst', label: 'Price Analyst', color: '#fb7185', icon: '📈' },
  { type: 'shopper_report', label: 'Shopper Report', color: '#818cf8', icon: '📝' },
  { type: 'page_generator', label: 'Page Generator', color: '#2dd4bf', icon: '📄' },
  { type: 'collection_organizer', label: 'Collection Organizer', color: '#a3e635', icon: '🗂️' },
  { type: 'description_enhancer', label: 'Description Enhancer', color: '#facc15', icon: '✨' },
  { type: 'price_adjuster', label: 'Price Adjuster', color: '#f97316', icon: '💲' },
  { type: 'shopify_applier', label: 'Shopify Applier', color: '#96bf48', icon: '🚀' },
  { type: 'heart_feel', label: 'Heart Feel', color: '#f59e0b', icon: '♥' },
  { type: 'dream', label: 'Dream', color: '#8b5cf6', icon: '☾' },
  { type: 'consciousness_prove', label: 'Consciousness Prove', color: '#ec4899', icon: '◈' },
  { type: 'cognition', label: 'Cognition', color: '#22c55e', icon: '⚡' },
  { type: 'memory_recall', label: 'Memory Recall', color: '#14b8a6', icon: '🌉' },
];

function NodeCard({ data }) {
  const def = NODE_TYPES.find(t => t.type === data.type) || { color: '#666', icon: '⬡', label: data.type };
  return (
    <div style={{
      background: '#1a1a2e', border: `2px solid ${def.color}40`, borderRadius: 12,
      padding: '12px 16px', minWidth: 160, boxShadow: `0 4px 12px ${def.color}15`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 18 }}>{def.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: def.color }}>{def.label}</span>
      </div>
      {data.prompt && <div style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{data.prompt}</div>}
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

export default function WorkflowCanvas({ wsEvent }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [workflows, setWorkflows] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('New Workflow');
  const reactFlowWrapper = useRef(null);

  const loadWorkflows = useCallback(() => {
    fetch('/api/workflows').then(r => r.json()).then(d => setWorkflows(d.workflows || [])).catch(() => {});
  }, []);

  useEffect(() => { loadWorkflows(); }, [loadWorkflows]);
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

  const runWorkflow = useCallback(async () => {
    if (!currentId) { await saveWorkflow(); }
    setRunning(true);
    setResult(null);
    try {
      const id = currentId || workflows[0]?.id;
      if (!id) return;
      const res = await fetch(`/api/workflows/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Run this workflow' }) });
      setResult(await res.json());
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  }, [currentId, saveWorkflow, workflows]);

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
      {error && <div style={{ background: '#2d1b1b', border: '1px solid #5b2b2b', padding: '8px 12px', color: '#f87171', fontSize: 13 }}>{error}</div>}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        background: '#111118', borderBottom: '1px solid #222',
      }}>
        <input value={name} onChange={e => setName(e.target.value)} style={{
          background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, padding: '6px 12px',
          color: '#e0e0e8', fontSize: 14, width: 200,
        }} />
        <button onClick={saveWorkflow} style={btnStyle('#6366f1')}>Save</button>
        <button onClick={runWorkflow} disabled={running} style={btnStyle('#10b981')}>{running ? 'Running...' : 'Run ▶'}</button>
        <button onClick={() => { setNodes([]); setEdges([]); setCurrentId(null); setName('New Workflow'); }} style={btnStyle('#666')}>New</button>
        {workflows.length > 0 && (
          <select onChange={e => e.target.value && loadWorkflow(e.target.value)} style={{
            background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, padding: '6px 8px', color: '#e0e0e8', fontSize: 12,
          }}>
            <option value="">Load workflow...</option>
            {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex' }}>
        <div style={{ width: 180, background: '#111118', borderRight: '1px solid #222', padding: 12, overflowY: 'auto' }}>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', marginBottom: 8 }}>Add Node</div>
          {NODE_TYPES.map(t => (
            <button key={t.type} onClick={() => addNode(t.type)} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '8px 10px', background: '#1a1a2e', border: `1px solid ${t.color}30`,
              borderRadius: 8, color: '#ccc', fontSize: 12, cursor: 'pointer', marginBottom: 6,
              transition: 'border-color 0.15s',
            }}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        <div ref={reactFlowWrapper} style={{ flex: 1 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
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
                  {result.status === 'success' ? '✓ Success' : result.error ? '✗ Error' : '✗ Failed'} · {result.durationMs || 0}ms
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
      </div>
    </div>
  );
}

const btnStyle = (bg) => ({
  background: bg, border: 'none', borderRadius: 6, padding: '6px 14px',
  color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
});
