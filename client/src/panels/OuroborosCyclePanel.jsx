import { useState, useEffect, useCallback } from 'react';

const CATEGORY_COLORS = {
  performance: '#f59e0b', reliability: '#22c55e', security: '#ef4444',
  architecture: '#6366f1', feature: '#8b5cf6', refactor: '#0d9488', testing: '#3b82f6',
};
const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
const STATUS_COLORS = { proposed: '#6b7280', accepted: '#22c55e', rejected: '#ef4444', needs_revision: '#f59e0b', implemented: '#8b5cf6' };

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#1e1b2e', borderRadius: 8, padding: '12px 16px', minWidth: 100 }}>
      <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e0e0f0' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Badge({ text, color }) {
  return (
    <span style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: `${color}22`, color }}>
      {text}
    </span>
  );
}

export default function OuroborosCyclePanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [selectedCycle, setSelectedCycle] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [outline, setOutline] = useState(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/ouroboros-cycle/stats');
      setStats(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadCycles = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/ouroboros-cycle/cycles?limit=20');
      const data = await res.json();
      setCycles(data.cycles || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadStats(); loadCycles(); }, [loadStats, loadCycles]);
  useEffect(() => {
    if (wsEvent?.type === 'ouroboros') { loadStats(); loadCycles(); }
  }, [wsEvent, loadStats, loadCycles]);

  const runCycle = async () => {
    setRunning(true); setError('');
    try {
      const res = await fetch('/api/intelligence/ouroboros-cycle/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      await loadStats(); await loadCycles();
      if (data.cycleId) loadCycleDetail(data.cycleId);
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  };

  const runAbsorb = async () => {
    setError('');
    try {
      const res = await fetch('/api/intelligence/ouroboros-cycle/absorb', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setOutline(await res.json());
    } catch (e) { setError(e.message); }
  };

  const loadCycleDetail = async (id) => {
    try {
      const res = await fetch(`/api/intelligence/ouroboros-cycle/cycle/${id}`);
      setSelectedCycle(await res.json());
    } catch (e) { setError(e.message); }
  };

  const updateProposalStatus = async (proposalId, status) => {
    try {
      await fetch(`/api/intelligence/ouroboros-cycle/proposal/${proposalId}/status`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (selectedCycle) loadCycleDetail(selectedCycle.id);
    } catch (e) { setError(e.message); }
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'cycles', label: 'Cycles' },
    { id: 'absorb', label: 'Absorb' },
  ];

  if (selectedCycle) {
    const c = selectedCycle;
    return (
      <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
        <button onClick={() => setSelectedCycle(null)} style={{ background: 'none', border: 'none', color: '#059669', cursor: 'pointer', fontSize: 13, marginBottom: 12 }}>
          &larr; Back to cycles
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0, color: '#059669' }}>Cycle {c.id}</h3>
          <Badge text={c.status} color={c.status === 'complete' ? '#22c55e' : c.status === 'failed' ? '#ef4444' : '#f59e0b'} />
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>{c.phase} — {new Date(c.created_at + 'Z').toLocaleString()}</div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <StatCard label="Proposals" value={c.proposal_count} color="#059669" />
          <StatCard label="Accepted" value={c.accepted_count} color="#22c55e" />
          <StatCard label="Rejected" value={c.rejected_count} color="#ef4444" />
          <StatCard label="Duration" value={c.duration_ms ? `${(c.duration_ms / 1000).toFixed(1)}s` : '—'} color="#6b7280" />
        </div>

        <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Proposals (priority-ordered)</div>
        {(c.proposals || []).map((p, i) => (
          <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '10px 12px', marginBottom: 6, borderLeft: `3px solid ${CATEGORY_COLORS[p.category] || '#6b7280'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0' }}>{p.title}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <Badge text={p.priority} color={PRIORITY_COLORS[p.priority]} />
                <Badge text={p.status} color={STATUS_COLORS[p.status]} />
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#a0a0b8', marginBottom: 4 }}>{p.description}</div>
            {p.target_files?.length > 0 && (
              <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
                Files: {(Array.isArray(p.target_files) ? p.target_files : []).join(', ')}
              </div>
            )}
            {p.implementation_sketch && (
              <div style={{ fontSize: 11, color: '#86efac', background: '#0a2010', padding: '4px 8px', borderRadius: 4, marginBottom: 4 }}>
                {p.implementation_sketch}
              </div>
            )}
            {p.review_notes && (
              <div style={{ fontSize: 11, color: '#fcd34d', background: '#1a1500', padding: '4px 8px', borderRadius: 4, marginBottom: 4 }}>
                Review: {p.review_notes}
              </div>
            )}
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              {p.status !== 'implemented' && (
                <button onClick={() => updateProposalStatus(p.id, 'implemented')}
                  style={{ background: '#059669', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>
                  Mark Implemented
                </button>
              )}
              {p.status === 'proposed' && (
                <>
                  <button onClick={() => updateProposalStatus(p.id, 'accepted')}
                    style={{ background: '#22c55e', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>
                    Accept
                  </button>
                  <button onClick={() => updateProposalStatus(p.id, 'rejected')}
                    style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: tab === t.id ? '#059669' : '#2a2740', color: tab === t.id ? '#fff' : '#a0a0b8' }}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={{ background: '#1a0a0a', color: '#fca5a5', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {tab === 'overview' && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Total Cycles" value={stats?.cycles?.total || 0} color="#059669" />
            <StatCard label="Completed" value={stats?.cycles?.completed || 0} color="#22c55e" />
            <StatCard label="Proposals" value={stats?.proposals?.total || 0} color="#c4b5fd" />
            <StatCard label="Accepted" value={stats?.proposals?.accepted || 0} color="#34d399" />
            <StatCard label="Implemented" value={stats?.proposals?.implemented || 0} color="#8b5cf6" />
          </div>

          <button onClick={runCycle} disabled={running}
            style={{ background: running ? '#374151' : '#059669', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 20px', cursor: running ? 'default' : 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 16, width: '100%' }}>
            {running ? 'Ouroboros cycle running... (absorb → analyze → review)' : 'Run RSI Cycle'}
          </button>

          {stats?.byCategory?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Proposals by Category</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stats.byCategory.map((c, i) => (
                  <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge text={c.category} color={CATEGORY_COLORS[c.category] || '#6b7280'} />
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#e0e0f0' }}>{c.count}</span>
                    <span style={{ fontSize: 10, color: '#22c55e' }}>{c.accepted} ok</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {cycles.length > 0 && (
            <div>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Recent Cycles</div>
              {cycles.slice(0, 5).map((c, i) => (
                <div key={i} onClick={() => loadCycleDetail(c.id)}
                  style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#e0e0f0' }}>Cycle {c.id.slice(0, 8)}</span>
                    <Badge text={c.status} color={c.status === 'complete' ? '#22c55e' : '#ef4444'} />
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    {c.proposal_count} proposals, {c.accepted_count} accepted
                    {c.duration_ms ? ` · ${(c.duration_ms / 1000).toFixed(1)}s` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'cycles' && (
        <>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>All RSI Cycles</div>
          {cycles.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No cycles yet. Run one from the Overview tab.</div>}
          {cycles.map((c, i) => (
            <div key={i} onClick={() => loadCycleDetail(c.id)}
              style={{ background: '#1e1b2e', borderRadius: 6, padding: '10px 12px', marginBottom: 4, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0' }}>Cycle {c.id}</span>
                <Badge text={c.status} color={c.status === 'complete' ? '#22c55e' : c.status === 'failed' ? '#ef4444' : '#f59e0b'} />
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#6b7280' }}>
                <span>Phase: {c.phase}</span>
                <span style={{ color: '#059669' }}>{c.proposal_count} proposals</span>
                <span style={{ color: '#22c55e' }}>{c.accepted_count} accepted</span>
                <span style={{ color: '#ef4444' }}>{c.rejected_count} rejected</span>
                {c.duration_ms && <span>{(c.duration_ms / 1000).toFixed(1)}s</span>}
                <span>{new Date(c.created_at + 'Z').toLocaleString()}</span>
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'absorb' && (
        <>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Codebase Absorption (Phase 1 only — scan without LLM)</div>
          <button onClick={runAbsorb}
            style={{ background: '#059669', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Absorb Codebase
          </button>

          {outline && (
            <div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <StatCard label="Files" value={outline.stats?.totalFiles} color="#059669" />
                <StatCard label="Lines" value={outline.stats?.totalLines?.toLocaleString()} color="#c4b5fd" />
                <StatCard label="Routes" value={outline.stats?.totalRoutes} color="#f59e0b" />
                <StatCard label="DB Tables" value={outline.stats?.dbTableCount} color="#3b82f6" />
                <StatCard label="Agents" value={outline.stats?.agentCount} color="#ef4444" />
              </div>
              <div style={{ background: '#1e1b2e', borderRadius: 6, padding: 12, maxHeight: 400, overflowY: 'auto' }}>
                <pre style={{ fontSize: 11, color: '#c0c0d0', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.5 }}>
                  {outline.outline?.slice(0, 8000)}
                  {outline.outline?.length > 8000 ? '\n... (truncated for display)' : ''}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
