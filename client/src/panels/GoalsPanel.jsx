import React, { useState, useEffect, useCallback } from 'react';

const C = {
  bg: '#0a0a0f', card: '#111118', border: '#1e1e2a',
  text: '#e0e0e0', dim: '#666', accent: '#16a34a',
  green: '#10b981', red: '#ef4444', amber: '#f59e0b',
  purple: '#a78bfa', blue: '#3b82f6', teal: '#14b8a6',
};

const PRIORITY_COLORS = { high: C.red, medium: C.amber, low: C.teal };
const STATUS_COLORS = { proposed: C.blue, active: C.accent, completed: C.green, rejected: C.red, failed: '#6b7280' };

function PriorityBadge({ priority }) {
  const color = PRIORITY_COLORS[priority] || C.dim;
  return (
    <span style={{ background: color + '20', color, padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
      {priority || 'medium'}
    </span>
  );
}

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status] || C.dim;
  return (
    <span style={{ background: color + '20', color, padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
      {status || 'proposed'}
    </span>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function GoalsPanel({ wsEvent }) {
  const [proposals, setProposals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [statusFilter, setStatusFilter] = useState(null);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    try {
      const url = statusFilter ? `/api/goals?limit=50&status=${statusFilter}` : '/api/goals?limit=50';
      const res = await fetch(url);
      const data = await res.json();
      setProposals(data.proposals || []);
    } catch (e) { setError(e.message); }
  }, [statusFilter]);

  const loadDetail = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/goals/${id}`);
      const data = await res.json();
      setDetail(data);
      setSelected(id);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (wsEvent?.type === 'system.goal') loadList();
  }, [wsEvent, loadList]);

  const generateGoals = async () => {
    setGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/goals/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      loadList();
    } catch (e) { setError(e.message); }
    setGenerating(false);
  };

  const updateStatus = async (id, status) => {
    try {
      await fetch(`/api/goals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      loadList();
      if (selected === id) loadDetail(id);
    } catch (e) { setError(e.message); }
  };

  const deleteGoal = async (id) => {
    try {
      await fetch(`/api/goals/${id}`, { method: 'DELETE' });
      if (selected === id) { setSelected(null); setDetail(null); }
      loadList();
    } catch (e) { setError(e.message); }
  };

  const counts = {
    total: proposals.length,
    proposed: proposals.filter(p => p.status === 'proposed').length,
    active: proposals.filter(p => p.status === 'active').length,
    completed: proposals.filter(p => p.status === 'completed').length,
  };

  const FILTERS = [null, 'proposed', 'active', 'completed', 'rejected'];

  return (
    <div style={{ padding: '16px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: C.text, maxHeight: '100%', overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Autonomous Goal Engine</h2>
      <p style={{ fontSize: 11, color: C.dim, margin: '0 0 16px' }}>Self-directed intelligence: analyzes knowledge gaps and proposes chain objectives</p>

      {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <StatCard label="Total" value={counts.total} color={C.text} />
        <StatCard label="Proposed" value={counts.proposed} color={C.blue} />
        <StatCard label="Active" value={counts.active} color={C.accent} />
        <StatCard label="Completed" value={counts.completed} color={C.green} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {FILTERS.map(f => (
            <button key={f || 'all'} onClick={() => setStatusFilter(f)} style={{
              background: statusFilter === f ? C.accent + '30' : 'transparent', border: `1px solid ${statusFilter === f ? C.accent : C.border}`,
              borderRadius: 4, padding: '3px 8px', fontSize: 10, color: statusFilter === f ? C.accent : C.dim, cursor: 'pointer',
            }}>{f || 'All'}</button>
          ))}
        </div>
        <button onClick={generateGoals} disabled={generating} style={{
          background: generating ? C.dim : C.accent, color: '#fff', border: 'none', borderRadius: 6,
          padding: '5px 14px', fontSize: 11, cursor: generating ? 'default' : 'pointer', fontWeight: 600,
        }}>{generating ? 'Generating...' : 'Generate Goals'}</button>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: '0 0 280px' }}>
          {proposals.map(p => (
            <div key={p.id} onClick={() => loadDetail(p.id)} style={{
              background: selected === p.id ? C.accent + '12' : C.card, border: `1px solid ${selected === p.id ? C.accent + '40' : C.border}`,
              borderRadius: 8, padding: '10px 12px', marginBottom: 6, cursor: 'pointer', transition: 'all 0.15s',
            }}>
              <div style={{ fontSize: 12, color: C.text, fontWeight: 500, marginBottom: 4, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {p.objective}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <StatusBadge status={p.status} />
                <PriorityBadge priority={p.priority} />
                <span style={{ fontSize: 10, color: C.dim, marginLeft: 'auto' }}>{p.complexity || 'moderate'}</span>
              </div>
            </div>
          ))}
          {proposals.length === 0 && <div style={{ color: C.dim, fontSize: 11, textAlign: 'center', padding: 20 }}>No goal proposals yet</div>}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {detail ? (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6, lineHeight: 1.4 }}>{detail.objective}</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                <StatusBadge status={detail.status} />
                <PriorityBadge priority={detail.priority} />
                <span style={{ fontSize: 10, color: C.dim }}>{detail.complexity}</span>
                <span style={{ fontSize: 10, color: C.dim, marginLeft: 'auto' }}>Source: {detail.source}</span>
              </div>

              {detail.rationale && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.purple, marginBottom: 4 }}>Rationale</div>
                  <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>{detail.rationale}</div>
                </div>
              )}

              {detail.builds_on && (
                <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>
                  Builds on: <span style={{ color: C.teal, fontFamily: 'monospace' }}>{detail.builds_on}</span>
                </div>
              )}

              {detail.landscape_summary && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.amber, marginBottom: 4 }}>Landscape Summary</div>
                  <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5, fontStyle: 'italic' }}>{detail.landscape_summary}</div>
                </div>
              )}

              {detail.chain_run_id && (
                <div style={{ fontSize: 11, color: C.dim, marginBottom: 12 }}>
                  Chain run: <span style={{ color: C.blue, fontFamily: 'monospace' }}>{detail.chain_run_id}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                {detail.status === 'proposed' && (
                  <>
                    <button onClick={() => updateStatus(detail.id, 'active')} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '4px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>Activate</button>
                    <button onClick={() => updateStatus(detail.id, 'rejected')} style={{ background: C.red + '30', color: C.red, border: `1px solid ${C.red}40`, borderRadius: 5, padding: '4px 12px', fontSize: 11, cursor: 'pointer' }}>Reject</button>
                  </>
                )}
                {detail.status === 'active' && (
                  <button onClick={() => updateStatus(detail.id, 'completed')} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 5, padding: '4px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>Mark Complete</button>
                )}
                <button onClick={() => deleteGoal(detail.id)} style={{ background: '#1a1a2e', color: C.dim, border: `1px solid ${C.border}`, borderRadius: 5, padding: '4px 12px', fontSize: 11, cursor: 'pointer', marginLeft: 'auto' }}>Delete</button>
              </div>
            </div>
          ) : (
            <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', padding: 40 }}>Select a goal to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
