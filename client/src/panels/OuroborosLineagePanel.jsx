import { useState, useEffect, useCallback, useRef } from 'react';

const GENE_COLORS = {
  performance: '#f59e0b', reliability: '#22c55e', security: '#ef4444',
  architecture: '#6366f1', feature: '#8b5cf6', refactor: '#0d9488', testing: '#3b82f6',
};

function Badge({ text, color }) {
  return (
    <span style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: `${color}22`, color }}>
      {text}
    </span>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: `${color}15`, border: `1px solid ${color}33` }}>
      <span style={{ fontSize: 10, color: '#a0a0b8' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

// ─── SVG Lineage Graph ──────────────────────────────────────────

function LineageGraph({ cycles, children, selected, onSelect }) {
  const svgRef = useRef(null);
  const [viewBox, setViewBox] = useState('0 0 800 400');

  const nodeW = 160, nodeH = 80, gapX = 60, gapY = 40;
  const startX = 40, startY = 40;

  // Layout: simple left-to-right chain (generations are linear for now)
  const sorted = [...cycles].sort((a, b) => (a.generation || 1) - (b.generation || 1));
  const positions = {};
  sorted.forEach((c, i) => {
    positions[c.id] = { x: startX + i * (nodeW + gapX), y: startY, cycle: c };
  });

  const totalW = Math.max(800, startX * 2 + sorted.length * (nodeW + gapX));
  const totalH = Math.max(300, startY * 2 + nodeH + 80);

  useEffect(() => {
    setViewBox(`0 0 ${totalW} ${totalH}`);
  }, [totalW, totalH]);

  const statusColor = (s) => s === 'complete' ? '#22c55e' : s === 'failed' ? '#ef4444' : '#f59e0b';

  return (
    <div style={{ width: '100%', overflowX: 'auto', overflowY: 'hidden', background: '#0d0d15', borderRadius: 8, border: '1px solid #1e1b2e' }}>
      <svg ref={svgRef} viewBox={viewBox} style={{ width: totalW, height: totalH, minWidth: '100%' }}>
        <defs>
          <linearGradient id="edgeGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#059669" stopOpacity="0.3" />
            <stop offset="50%" stopColor="#059669" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0.3" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#059669" opacity="0.6" />
          </marker>
        </defs>

        {/* DNA helix background lines */}
        {sorted.length > 1 && (() => {
          const points = sorted.map((_, i) => startX + i * (nodeW + gapX) + nodeW / 2);
          const y = startY + nodeH / 2;
          const helixPath1 = points.map((x, i) => {
            const cmd = i === 0 ? 'M' : 'L';
            const yOff = Math.sin(i * 1.2) * 12;
            return `${cmd} ${x} ${y + yOff}`;
          }).join(' ');
          const helixPath2 = points.map((x, i) => {
            const cmd = i === 0 ? 'M' : 'L';
            const yOff = Math.sin(i * 1.2 + Math.PI) * 12;
            return `${cmd} ${x} ${y + yOff}`;
          }).join(' ');
          return (
            <>
              <path d={helixPath1} fill="none" stroke="#05966930" strokeWidth="2" strokeDasharray="4 4" />
              <path d={helixPath2} fill="none" stroke="#8b5cf630" strokeWidth="2" strokeDasharray="4 4" />
            </>
          );
        })()}

        {/* Edges */}
        {sorted.map((c) => {
          if (!c.parent_cycle_id || !positions[c.parent_cycle_id]) return null;
          const from = positions[c.parent_cycle_id];
          const to = positions[c.id];
          return (
            <line key={`edge-${c.id}`}
              x1={from.x + nodeW} y1={from.y + nodeH / 2}
              x2={to.x} y2={to.y + nodeH / 2}
              stroke="url(#edgeGrad)" strokeWidth="2"
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {/* Nodes */}
        {sorted.map((c) => {
          const pos = positions[c.id];
          const isSelected = selected === c.id;
          const genome = c.genomeSize || 0;
          const mutations = c.mutations || 0;
          const sc = statusColor(c.status);

          return (
            <g key={c.id} onClick={() => onSelect(c.id)} style={{ cursor: 'pointer' }}>
              {/* Selection glow */}
              {isSelected && (
                <rect x={pos.x - 3} y={pos.y - 3} width={nodeW + 6} height={nodeH + 6}
                  rx={10} fill="none" stroke="#059669" strokeWidth="2" filter="url(#glow)" opacity="0.6" />
              )}

              {/* Node background */}
              <rect x={pos.x} y={pos.y} width={nodeW} height={nodeH}
                rx={8} fill="#1a1730" stroke={isSelected ? '#059669' : '#2a2740'} strokeWidth={isSelected ? 2 : 1} />

              {/* Status indicator */}
              <circle cx={pos.x + 12} cy={pos.y + 12} r={4} fill={sc} />

              {/* Generation label */}
              <text x={pos.x + nodeW / 2} y={pos.y + 18} textAnchor="middle"
                fill="#e0e0f0" fontSize="12" fontWeight="700" fontFamily="system-ui">
                Gen {c.generation || 1}
              </text>

              {/* ID snippet */}
              <text x={pos.x + nodeW / 2} y={pos.y + 32} textAnchor="middle"
                fill="#6b7280" fontSize="9" fontFamily="monospace">
                {c.id.slice(0, 10)}
              </text>

              {/* Genome bar */}
              <rect x={pos.x + 10} y={pos.y + 40} width={nodeW - 20} height={6} rx={3} fill="#1e1b2e" />
              {genome > 0 && (
                <rect x={pos.x + 10} y={pos.y + 40}
                  width={Math.min(nodeW - 20, Math.max(4, (genome / Math.max(genome, 20)) * (nodeW - 20)))}
                  height={6} rx={3} fill="#059669" opacity="0.7" />
              )}

              {/* Stats row */}
              <text x={pos.x + 10} y={pos.y + 60} fill="#a0a0b8" fontSize="9" fontFamily="system-ui">
                {c.proposal_count || 0}P / {c.accepted_count || 0}A
              </text>
              <text x={pos.x + nodeW - 10} y={pos.y + 60} textAnchor="end"
                fill="#059669" fontSize="9" fontFamily="system-ui">
                {genome}G {mutations > 0 ? `+${mutations}` : ''}
              </text>

              {/* Duration */}
              <text x={pos.x + nodeW / 2} y={pos.y + 74} textAnchor="middle"
                fill="#4b5563" fontSize="8" fontFamily="system-ui">
                {c.duration_ms ? `${(c.duration_ms / 1000).toFixed(0)}s` : '—'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Genome Viewer ──────────────────────────────────────────────

function GenomeViewer({ genes }) {
  if (!genes || genes.length === 0) return <div style={{ fontSize: 12, color: '#6b7280', padding: 12 }}>No genes in genome yet.</div>;

  const byType = { inherited: [], mutation: [] };
  for (const g of genes) {
    (byType[g.gene_type] || byType.mutation).push(g);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {['mutation', 'inherited'].map(type => {
        const list = byType[type];
        if (list.length === 0) return null;
        return (
          <div key={type}>
            <div style={{ fontSize: 11, color: type === 'mutation' ? '#059669' : '#6366f1', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
              {type === 'mutation' ? `New Mutations (${list.length})` : `Inherited Genes (${list.length})`}
            </div>
            {list.map((g, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', marginBottom: 2,
                background: '#1a1730', borderRadius: 4,
                borderLeft: `3px solid ${GENE_COLORS[g.category] || '#6b7280'}`,
              }}>
                <span style={{ fontSize: 11, color: '#e0e0f0', flex: 1 }}>{g.title}</span>
                <Badge text={g.category} color={GENE_COLORS[g.category] || '#6b7280'} />
                <span style={{ fontSize: 9, color: '#4b5563' }}>Gen {g.generation_acquired}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Workspace Viewer ──────────────────────────────────────────

function WorkspaceSection({ title, icon, color, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 8, background: '#1a1730', borderRadius: 8, border: `1px solid ${color}22`, overflow: 'hidden' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: `${color}08` }}>
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color, flex: 1 }}>{title}</span>
        <span style={{ fontSize: 10, color: '#6b7280', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
      </div>
      {open && <div style={{ padding: '8px 12px' }}>{children}</div>}
    </div>
  );
}

function MetricRow({ label, value, delta, unit }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid #1e1b2e' }}>
      <span style={{ fontSize: 11, color: '#a0a0b8' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#e0e0f0' }}>{value}{unit || ''}</span>
        {delta !== undefined && delta !== 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, color: delta > 0 ? '#22c55e' : '#ef4444' }}>
            {delta > 0 ? '+' : ''}{delta}
          </span>
        )}
      </div>
    </div>
  );
}

function WorkspaceViewer({ workspace, diffData }) {
  if (!workspace) return <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>Select a generation and click "Load Workspace" to view its state snapshot.</div>;
  const s = workspace.snapshot;
  const d = diffData;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
        <StatPill label="Generation" value={s.generation} color="#059669" />
        <StatPill label="Fingerprint" value={workspace.fingerprint?.slice(0, 8)} color="#6366f1" />
        <StatPill label="Captured" value={new Date(s.capturedAt).toLocaleString()} color="#6b7280" />
      </div>

      {/* Fleet */}
      <WorkspaceSection title={`Agent Fleet (${s.fleet.count})`} icon="⊕" color="#f59e0b">
        <MetricRow label="Total Agents" value={s.fleet.count} delta={d?.fleet?.countDelta} />
        <MetricRow label="Manifests" value={s.fleet.manifestCount} />
        <MetricRow label="Forged" value={s.fleet.forgedCount} />
        <MetricRow label="Total Runs" value={s.fleet.totalRuns} delta={d?.fleet?.runsDelta} />
        <MetricRow label="Successful Runs" value={s.fleet.successRuns} />
        {s.fleet.agents.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Agent Roster</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {s.fleet.agents.map((a, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, fontSize: 10, background: a.source === 'forged' ? '#059669' + '15' : '#f59e0b' + '15', color: a.source === 'forged' ? '#059669' : '#f59e0b', border: `1px solid ${a.source === 'forged' ? '#059669' : '#f59e0b'}22` }}>
                  {a.name}{a.toolCount > 0 ? ` (${a.toolCount}t)` : ''}
                </span>
              ))}
            </div>
          </div>
        )}
        {d?.fleet?.added?.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {d.fleet.added.map((a, i) => <Badge key={i} text={`+ ${a.name}`} color="#22c55e" />)}
          </div>
        )}
        {d?.fleet?.removed?.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {d.fleet.removed.map((a, i) => <Badge key={i} text={`- ${a.name}`} color="#ef4444" />)}
          </div>
        )}
      </WorkspaceSection>

      {/* Workflows */}
      <WorkspaceSection title={`Workflows (${s.workflows.count})`} icon="⬡" color="#c4b5fd">
        <MetricRow label="Definitions" value={s.workflows.count} delta={d?.workflows?.countDelta} />
        <MetricRow label="Synthesized" value={s.workflows.synthesizedCount} />
        <MetricRow label="Total Runs" value={s.workflows.totalRuns} />
        <MetricRow label="Completed Runs" value={s.workflows.completedRuns} />
      </WorkspaceSection>

      {/* Genome */}
      <WorkspaceSection title={`Genome (${s.genome.size} genes)`} icon="🧬" color="#059669">
        <MetricRow label="Total Genes" value={s.genome.size} delta={d?.genome?.sizeDelta} />
        <MetricRow label="Mutations" value={s.genome.mutations} />
        <MetricRow label="Inherited" value={s.genome.inherited} />
        <MetricRow label="Hash" value={s.genome.hash?.slice(0, 12) || '—'} />
        {d?.genome?.hashChanged && <Badge text="Genome Changed" color="#f59e0b" />}
        {s.genome.categories.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {s.genome.categories.map((cat, i) => <Badge key={i} text={cat} color={GENE_COLORS[cat] || '#6b7280'} />)}
          </div>
        )}
      </WorkspaceSection>

      {/* Codebase */}
      <WorkspaceSection title="Codebase" icon="◈" color="#3b82f6">
        <MetricRow label="Files" value={s.codebase.files} delta={d?.codebase?.filesDelta} />
        <MetricRow label="Lines" value={s.codebase.lines.toLocaleString()} delta={d?.codebase?.linesDelta} />
        <MetricRow label="REST Routes" value={s.codebase.routes} delta={d?.codebase?.routesDelta} />
        <MetricRow label="DB Tables" value={s.codebase.tables} delta={d?.codebase?.tablesDelta} />
        {d?.codebase?.newTables?.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {d.codebase.newTables.map((t, i) => <Badge key={i} text={`+ ${t}`} color="#22c55e" />)}
          </div>
        )}
      </WorkspaceSection>

      {/* Intelligence */}
      <WorkspaceSection title="Intelligence Stack" icon="🔭" color="#8b5cf6">
        <MetricRow label="Reflections" value={s.intelligence.reflections} delta={d?.intelligence?.reflectionsDelta} />
        <MetricRow label="Verification Loops" value={s.intelligence.verifications} delta={d?.intelligence?.verificationsDelta} />
        <MetricRow label="Verified (Approved)" value={s.intelligence.verificationsApproved} />
        <MetricRow label="Daemon Cycles" value={s.intelligence.daemonCycles} />
        <MetricRow label="Agent Memories" value={s.intelligence.memories} delta={d?.intelligence?.memoriesDelta} />
        <MetricRow label="Verified Memories" value={s.intelligence.verifiedMemories} />
        <MetricRow label="Agents w/ Memory" value={s.intelligence.memoriesAgents} />
      </WorkspaceSection>

      {/* Bus */}
      <WorkspaceSection title={`Agent Bus (${s.bus.topicCount} topics)`} icon="⊗" color="#f87171">
        <MetricRow label="Topics" value={s.bus.topicCount} delta={d?.bus?.topicsDelta} />
        <MetricRow label="Messages" value={s.bus.messageCount} delta={d?.bus?.messagesDelta} />
        <MetricRow label="Triggers" value={s.bus.triggers} />
        <MetricRow label="Active Triggers" value={s.bus.activeTriggers} />
        {d?.bus?.newTopics?.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {d.bus.newTopics.map((t, i) => <Badge key={i} text={`+ ${t}`} color="#22c55e" />)}
          </div>
        )}
      </WorkspaceSection>

      {/* Vitals */}
      <WorkspaceSection title="System Vitals" icon="♥" color="#22c55e">
        <MetricRow label="Heap" value={s.vitals.heapMB} unit=" MB" />
        <MetricRow label="RSS" value={s.vitals.rssMB} unit=" MB" />
        <MetricRow label="Uptime" value={Math.round(s.vitals.uptimeSec / 60)} unit=" min" />
      </WorkspaceSection>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────

export default function OuroborosLineagePanel({ wsEvent }) {
  const [tab, setTab] = useState('graph');
  const [lineage, setLineage] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [genome, setGenome] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [wsDiff, setWsDiff] = useState(null);
  const [compareData, setCompareData] = useState(null);
  const [compareTarget, setCompareTarget] = useState(null);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadLineage = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/ouroboros-cycle/lineage');
      setLineage(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadLineage(); }, [loadLineage]);
  useEffect(() => {
    if (wsEvent?.type === 'ouroboros' || wsEvent?.type === 'evolution') loadLineage();
  }, [wsEvent, loadLineage]);

  const selectCycle = async (id) => {
    setSelectedId(id);
    setWorkspace(null);
    setWsDiff(null);
    try {
      const [detailRes, genomeRes] = await Promise.all([
        fetch(`/api/intelligence/ouroboros-cycle/cycle/${id}`),
        fetch(`/api/intelligence/ouroboros-cycle/genome/${id}`),
      ]);
      setSelectedDetail(await detailRes.json());
      setGenome(await genomeRes.json());

      // Try loading workspace
      const wsRes = await fetch(`/api/intelligence/ouroboros-cycle/workspace/${id}`);
      if (wsRes.ok) {
        const wsData = await wsRes.json();
        setWorkspace(wsData);
        // Load diff against parent if available
        const cycle = lineage?.cycles?.find(c => c.id === id);
        if (cycle?.parent_cycle_id) {
          const diffRes = await fetch(`/api/intelligence/ouroboros-cycle/workspace-diff?a=${cycle.parent_cycle_id}&b=${id}`);
          if (diffRes.ok) setWsDiff(await diffRes.json());
        }
      }
    } catch (e) { setError(e.message); }
  };

  const captureWorkspace = async (cycleId) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelligence/ouroboros-cycle/workspace/${cycleId}/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error((await res.json()).error);
      const wsData = await res.json();
      setWorkspace(wsData);
      const cycle = lineage?.cycles?.find(c => c.id === cycleId);
      if (cycle?.parent_cycle_id) {
        const diffRes = await fetch(`/api/intelligence/ouroboros-cycle/workspace-diff?a=${cycle.parent_cycle_id}&b=${cycleId}`);
        if (diffRes.ok) setWsDiff(await diffRes.json());
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const forkFromCycle = async (cycleId) => {
    setForking(true);
    setError('');
    try {
      const res = await fetch(`/api/intelligence/ouroboros-cycle/fork/${cycleId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error((await res.json()).error);
      const result = await res.json();
      await loadLineage();
      selectCycle(result.cycleId);
      setTab('workspace');
    } catch (e) { setError(e.message); }
    setForking(false);
  };

  const runCompare = async (idA, idB) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelligence/ouroboros-cycle/compare?a=${idA}&b=${idB}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setCompareData(await res.json());
      setTab('compare');
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const tabs = [
    { id: 'graph', label: 'Lineage Graph' },
    { id: 'timeline', label: 'Evolution Timeline' },
    { id: 'genome', label: 'Genome Browser' },
    { id: 'workspace', label: 'Workspace' },
    { id: 'compare', label: 'Compare' },
  ];

  const cycles = lineage?.cycles || [];
  const totalGens = lineage?.totalGenerations || 0;
  const latest = cycles.length > 0 ? cycles[cycles.length - 1] : null;

  return (
    <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header stats */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <StatPill label="Generations" value={totalGens} color="#059669" />
        <StatPill label="Total Cycles" value={cycles.length} color="#c4b5fd" />
        {latest && <StatPill label="Latest Gen" value={latest.generation || 1} color="#22c55e" />}
        {latest && <StatPill label="Genome Size" value={latest.genomeSize || 0} color="#f59e0b" />}
        {latest?.genome_hash && <StatPill label="Hash" value={latest.genome_hash?.slice(0, 8)} color="#6366f1" />}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: tab === t.id ? '#059669' : '#2a2740', color: tab === t.id ? '#fff' : '#a0a0b8' }}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={{ background: '#1a0a0a', color: '#fca5a5', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {/* Graph Tab */}
      {tab === 'graph' && (
        <>
          {cycles.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
              No cycles yet. Run the Ouroboros from the RSI panel, or start the daemon for autonomous evolution.
            </div>
          ) : (
            <LineageGraph
              cycles={cycles}
              children={lineage?.children || {}}
              selected={selectedId}
              onSelect={selectCycle}
            />
          )}

          {/* Selected cycle detail */}
          {selectedDetail && (
            <div style={{ marginTop: 12, background: '#1a1730', borderRadius: 8, padding: 12, border: '1px solid #2a2740' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#059669' }}>
                    Generation {selectedDetail.generation || 1}
                  </span>
                  <Badge text={selectedDetail.status} color={selectedDetail.status === 'complete' ? '#22c55e' : '#ef4444'} />
                  {selectedDetail.genome_hash && (
                    <span style={{ fontSize: 9, color: '#4b5563', fontFamily: 'monospace' }}>
                      genome:{selectedDetail.genome_hash?.slice(0, 8)}
                    </span>
                  )}
                </div>
                <button onClick={() => { setSelectedId(null); setSelectedDetail(null); setGenome(null); }}
                  style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 12 }}>
                  close
                </button>
              </div>

              {/* Lineage chain */}
              {selectedDetail.parent_cycle_id && (
                <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                  Parent: <span style={{ fontFamily: 'monospace', color: '#6366f1', cursor: 'pointer' }}
                    onClick={() => selectCycle(selectedDetail.parent_cycle_id)}>
                    {selectedDetail.parent_cycle_id.slice(0, 10)}
                  </span>
                </div>
              )}

              {/* Stats */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                <StatPill label="Proposals" value={selectedDetail.proposal_count || 0} color="#c4b5fd" />
                <StatPill label="Accepted" value={selectedDetail.accepted_count || 0} color="#22c55e" />
                <StatPill label="Rejected" value={selectedDetail.rejected_count || 0} color="#ef4444" />
                <StatPill label="Duration" value={selectedDetail.duration_ms ? `${(selectedDetail.duration_ms / 1000).toFixed(1)}s` : '—'} color="#6b7280" />
              </div>

              {/* Proposals */}
              {selectedDetail.proposals?.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 4, fontWeight: 600 }}>Proposals</div>
                  {selectedDetail.proposals.slice(0, 8).map((p, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', marginBottom: 2,
                      borderLeft: `3px solid ${GENE_COLORS[p.category] || '#6b7280'}`, background: '#0d0d15', borderRadius: 4,
                    }}>
                      <span style={{ fontSize: 11, color: '#e0e0f0', flex: 1 }}>{p.title}</span>
                      <Badge text={p.status} color={p.status === 'accepted' ? '#22c55e' : p.status === 'rejected' ? '#ef4444' : '#f59e0b'} />
                    </div>
                  ))}
                </div>
              )}

              {/* Genome */}
              {genome?.genes && (
                <div>
                  <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 4, fontWeight: 600 }}>
                    Genome ({genome.total} genes)
                  </div>
                  <GenomeViewer genes={genome.genes} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Timeline Tab */}
      {tab === 'timeline' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {cycles.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>No evolution history yet.</div>}
          {[...cycles].reverse().map((c, i) => {
            const insights = c.insights;
            return (
              <div key={c.id} onClick={() => selectCycle(c.id)}
                style={{
                  display: 'flex', gap: 12, padding: '10px 12px', cursor: 'pointer',
                  background: selectedId === c.id ? '#1e1b2e' : '#0d0d15', borderRadius: 6,
                  borderLeft: `3px solid ${c.status === 'complete' ? '#059669' : '#ef4444'}`,
                  transition: 'background 0.15s',
                }}>
                {/* Generation marker */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 50 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>
                    {c.generation || i + 1}
                  </div>
                  {i < cycles.length - 1 && (
                    <div style={{ width: 2, flex: 1, background: '#2a2740', marginTop: 4 }} />
                  )}
                </div>

                {/* Content */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#e0e0f0' }}>
                      Generation {c.generation || i + 1}
                    </span>
                    <span style={{ fontSize: 10, color: '#4b5563' }}>
                      {c.created_at ? new Date(c.created_at + 'Z').toLocaleString() : ''}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                    <Badge text={c.status} color={c.status === 'complete' ? '#22c55e' : '#ef4444'} />
                    {c.genome_hash && (
                      <span style={{ fontSize: 9, color: '#6b7280', fontFamily: 'monospace' }}>
                        {c.genome_hash.slice(0, 8)}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#a0a0b8' }}>
                    <span>{c.proposal_count || 0} proposals</span>
                    <span style={{ color: '#22c55e' }}>{c.accepted_count || 0} accepted</span>
                    <span style={{ color: '#059669' }}>{c.genomeSize || 0} genome</span>
                    <span style={{ color: '#8b5cf6' }}>+{c.mutations || 0} mutations</span>
                    {c.duration_ms && <span>{(c.duration_ms / 1000).toFixed(0)}s</span>}
                  </div>

                  {/* Category breakdown */}
                  {insights?.categories?.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {insights.categories.map((cat, j) => (
                        <Badge key={j} text={cat} color={GENE_COLORS[cat] || '#6b7280'} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Genome Browser Tab */}
      {tab === 'genome' && (
        <>
          {!selectedId ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
              Select a generation from the Graph or Timeline tab to browse its genome.
            </div>
          ) : genome?.genes ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#059669' }}>
                  Genome — Generation {selectedDetail?.generation || '?'}
                </span>
                <span style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>
                  {genome.total} genes · hash:{selectedDetail?.genome_hash?.slice(0, 8) || '—'}
                </span>
              </div>
              <GenomeViewer genes={genome.genes} />
            </div>
          ) : (
            <div style={{ padding: 12, color: '#6b7280', fontSize: 12 }}>Loading genome...</div>
          )}
        </>
      )}

      {/* Workspace Tab */}
      {tab === 'workspace' && (
        <>
          {!selectedId ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
              Select a generation from the Graph or Timeline tab to view its workspace snapshot.
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#059669' }}>
                  Workspace — Generation {selectedDetail?.generation || '?'}
                </span>
                {!workspace && (
                  <button onClick={() => captureWorkspace(selectedId)} disabled={loading}
                    style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: '#059669', color: '#fff', opacity: loading ? 0.5 : 1 }}>
                    {loading ? 'Capturing...' : 'Capture Workspace'}
                  </button>
                )}
                {workspace && (
                  <button onClick={() => captureWorkspace(selectedId)} disabled={loading}
                    style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #333', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: 'none', color: '#a0a0b8', opacity: loading ? 0.5 : 1 }}>
                    {loading ? 'Recapturing...' : 'Recapture'}
                  </button>
                )}
              </div>
              {wsDiff && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <Badge text={wsDiff.identical ? 'Identical to parent' : 'Diverged from parent'} color={wsDiff.identical ? '#6b7280' : '#f59e0b'} />
                  {wsDiff.codebase?.linesDelta !== 0 && (
                    <Badge text={`${wsDiff.codebase.linesDelta > 0 ? '+' : ''}${wsDiff.codebase.linesDelta} lines`} color={wsDiff.codebase.linesDelta > 0 ? '#22c55e' : '#ef4444'} />
                  )}
                  {wsDiff.fleet?.countDelta !== 0 && (
                    <Badge text={`${wsDiff.fleet.countDelta > 0 ? '+' : ''}${wsDiff.fleet.countDelta} agents`} color={wsDiff.fleet.countDelta > 0 ? '#22c55e' : '#ef4444'} />
                  )}
                  {wsDiff.genome?.sizeDelta !== 0 && (
                    <Badge text={`${wsDiff.genome.sizeDelta > 0 ? '+' : ''}${wsDiff.genome.sizeDelta} genes`} color="#059669" />
                  )}
                </div>
              )}
              <WorkspaceViewer workspace={workspace} diffData={wsDiff} />

              {/* Fork action */}
              <div style={{ marginTop: 12, padding: 12, background: '#0f0d1a', borderRadius: 8, border: '1px solid #1e1b2e' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#c4b5fd' }}>Fork from this Generation</div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>Create a new cycle seeded from this generation's genome</div>
                  </div>
                  <button onClick={() => forkFromCycle(selectedId)} disabled={forking}
                    style={{ padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                      background: forking ? '#333' : 'linear-gradient(135deg, #7c3aed, #059669)', color: '#fff', opacity: forking ? 0.5 : 1 }}>
                    {forking ? 'Forking...' : 'Fork'}
                  </button>
                </div>
              </div>

              {/* Compare launcher */}
              {cycles.length > 1 && (
                <div style={{ marginTop: 8, padding: 12, background: '#0f0d1a', borderRadius: 8, border: '1px solid #1e1b2e' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa', marginBottom: 6 }}>Compare with another generation</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {cycles.filter(c => c.id !== selectedId).slice(0, 6).map(c => (
                      <button key={c.id} onClick={() => runCompare(selectedId, c.id)}
                        style={{ padding: '3px 10px', borderRadius: 4, border: '1px solid #333', background: 'none', color: '#a0a0b8', fontSize: 10, cursor: 'pointer' }}>
                        Gen {c.generation || 1} ({c.id.slice(0, 6)})
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Compare Tab */}
      {tab === 'compare' && (
        <>
          {!compareData ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>
              Select a generation in the Workspace tab and click a comparison target.
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa' }}>Workspace Comparison</span>
                <button onClick={() => { setCompareData(null); setTab('workspace'); }}
                  style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #333', background: 'none', color: '#a0a0b8', fontSize: 11, cursor: 'pointer' }}>
                  Back
                </button>
              </div>

              {/* Summary */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                <Badge text={`Gen ${compareData.cycleA.generation} vs Gen ${compareData.cycleB.generation}`} color="#60a5fa" />
                <Badge text={compareData.summary.identical ? 'Identical' : 'Diverged'} color={compareData.summary.identical ? '#22c55e' : '#f59e0b'} />
                <Badge text={`${Math.round(compareData.summary.genomeSimilarity * 100)}% genome similarity`} color="#c4b5fd" />
                {compareData.summary.genesAdded > 0 && <Badge text={`+${compareData.summary.genesAdded} genes`} color="#22c55e" />}
                {compareData.summary.genesRemoved > 0 && <Badge text={`-${compareData.summary.genesRemoved} genes`} color="#ef4444" />}
              </div>

              {/* Side by side stats */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                {[compareData.cycleA, compareData.cycleB].map((c, i) => (
                  <div key={c.id} style={{ background: '#1a1730', borderRadius: 8, padding: 10, border: `1px solid ${i === 0 ? '#6366f133' : '#05966933'}` }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#6366f1' : '#059669', marginBottom: 4 }}>
                      Gen {c.generation} {i === 0 ? '(A)' : '(B)'}
                    </div>
                    <div style={{ fontSize: 9, color: '#4b5563', fontFamily: 'monospace', marginBottom: 6 }}>{c.id}</div>
                    <div style={{ fontSize: 10, color: '#a0a0b8' }}>
                      <div>Status: <span style={{ color: c.status === 'complete' ? '#22c55e' : '#ef4444' }}>{c.status}</span></div>
                      <div>Genome: <span style={{ fontFamily: 'monospace', color: '#c4b5fd' }}>{c.genome_hash?.slice(0, 8) || '—'}</span></div>
                      {c.duration_ms && <div>Duration: {(c.duration_ms / 1000).toFixed(1)}s</div>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Genome changes */}
              {(compareData.genome.added.length > 0 || compareData.genome.removed.length > 0) && (
                <div style={{ background: '#1a1730', borderRadius: 8, padding: 10, border: '1px solid #2a2740', marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#c4b5fd', marginBottom: 6 }}>Genome Changes</div>
                  {compareData.genome.added.map(g => (
                    <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <span style={{ color: '#22c55e', fontSize: 10, fontWeight: 700 }}>+</span>
                      <Badge text={g.category} color={GENE_COLORS[g.category] || '#888'} />
                      <span style={{ fontSize: 11, color: '#e0e0f0' }}>{g.title}</span>
                    </div>
                  ))}
                  {compareData.genome.removed.map(g => (
                    <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                      <span style={{ color: '#ef4444', fontSize: 10, fontWeight: 700 }}>-</span>
                      <Badge text={g.category} color={GENE_COLORS[g.category] || '#888'} />
                      <span style={{ fontSize: 11, color: '#a0a0b8', textDecoration: 'line-through' }}>{g.title}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
                    Shared genes: {compareData.genome.shared} | Total A: {compareData.genome.totalA} | Total B: {compareData.genome.totalB}
                  </div>
                </div>
              )}

              {/* Workspace diff details */}
              {compareData.workspace && !compareData.workspace.identical && (
                <div style={{ background: '#1a1730', borderRadius: 8, padding: 10, border: '1px solid #2a2740' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b', marginBottom: 6 }}>Workspace Drift</div>
                  {compareData.workspace.fleet && (
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: '#a0a0b8' }}>Fleet: </span>
                      <span style={{ fontSize: 11, color: compareData.workspace.fleet.countDelta > 0 ? '#22c55e' : compareData.workspace.fleet.countDelta < 0 ? '#ef4444' : '#a0a0b8' }}>
                        {compareData.workspace.fleet.countDelta > 0 ? '+' : ''}{compareData.workspace.fleet.countDelta} agents
                      </span>
                      {compareData.workspace.fleet.added?.length > 0 && (
                        <span style={{ fontSize: 10, color: '#22c55e', marginLeft: 6 }}>({compareData.workspace.fleet.added.join(', ')})</span>
                      )}
                    </div>
                  )}
                  {compareData.workspace.codebase && (
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: '#a0a0b8' }}>Codebase: </span>
                      <span style={{ fontSize: 11, color: '#e0e0f0' }}>
                        {compareData.workspace.codebase.filesDelta > 0 ? '+' : ''}{compareData.workspace.codebase.filesDelta} files,{' '}
                        {compareData.workspace.codebase.linesDelta > 0 ? '+' : ''}{compareData.workspace.codebase.linesDelta} lines,{' '}
                        {compareData.workspace.codebase.routesDelta > 0 ? '+' : ''}{compareData.workspace.codebase.routesDelta} routes
                      </span>
                    </div>
                  )}
                  {compareData.workspace.bus?.topicsDelta !== 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: '#a0a0b8' }}>Bus: </span>
                      <span style={{ fontSize: 11, color: '#e0e0f0' }}>
                        {compareData.workspace.bus.topicsDelta > 0 ? '+' : ''}{compareData.workspace.bus.topicsDelta} topics,{' '}
                        {compareData.workspace.bus.messagesDelta > 0 ? '+' : ''}{compareData.workspace.bus.messagesDelta} messages
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
