import React, { useState, useEffect, useCallback } from 'react';

const ACCENT = '#7c3aed';
const FIELD_COLORS = {
  new_logic: '#6366f1',
  improved_logic: '#8b5cf6',
  contradictions: '#ef4444',
  implementation_steps: '#22c55e',
  test_cases: '#06b6d4',
  unsupported_claims: '#f59e0b',
  remaining_dependencies: '#f97316',
};
const FIELD_LABELS = {
  new_logic: 'New Logic',
  improved_logic: 'Improved Logic',
  contradictions: 'Contradictions',
  implementation_steps: 'Implementation Steps',
  test_cases: 'Test Cases',
  unsupported_claims: 'Unsupported Claims',
  remaining_dependencies: 'Remaining Dependencies',
};
const FIELDS = Object.keys(FIELD_COLORS);

function StatusDot({ status }) {
  const colors = { running: '#f59e0b', completed: '#22c55e', complete: '#22c55e', failed: '#ef4444', crashed: '#ef4444' };
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: colors[status] || '#666', marginRight: 6 }} />;
}

function StatPill({ label, value, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 12, background: `${color}18`, color, fontSize: 12, fontWeight: 600 }}>
      {label}: {value}
    </span>
  );
}

function LedgerField({ field, entries }) {
  const [expanded, setExpanded] = useState(false);
  if (!entries || entries.length === 0) return null;
  const color = FIELD_COLORS[field] || '#888';
  const shown = expanded ? entries : entries.slice(0, 5);

  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setExpanded(!expanded)} style={{ background: 'none', border: 'none', color, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color }} />
        {FIELD_LABELS[field]} ({entries.length})
        <span style={{ fontSize: 10, color: '#666' }}>{expanded ? '▲' : '▼'}</span>
      </button>
      <div style={{ marginTop: 6, marginLeft: 16 }}>
        {shown.map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 }}>
            <span style={{ color: '#555', fontFamily: 'monospace', flexShrink: 0, minWidth: 40 }}>s{e.stage}</span>
            <span style={{ color: '#ccc', flex: 1 }}>{e.text}</span>
            {e.verified && <span style={{ color: '#22c55e', fontSize: 10, flexShrink: 0 }}>✓ verified</span>}
            {e.rejected && <span style={{ color: '#ef4444', fontSize: 10, flexShrink: 0 }}>✗ rejected</span>}
          </div>
        ))}
        {!expanded && entries.length > 5 && (
          <button onClick={() => setExpanded(true)} style={{ background: 'none', border: 'none', color: '#666', fontSize: 11, cursor: 'pointer', padding: '4px 0' }}>
            +{entries.length - 5} more...
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewSection({ review }) {
  if (!review) return <p style={{ color: '#555', fontSize: 12 }}>No review data</p>;
  if (review.error) return <p style={{ color: '#ef4444', fontSize: 12 }}>{review.error}</p>;

  const { stats, reviews, jevThreshold, durationMs } = review;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        <StatPill label="Verified" value={stats?.verified || 0} color="#22c55e" />
        <StatPill label="Rejected" value={stats?.rejected || 0} color="#ef4444" />
        <StatPill label="Disputed" value={stats?.disputed || 0} color="#f59e0b" />
        <StatPill label="Rate" value={`${stats?.verificationRate || 0}%`} color="#6366f1" />
        <StatPill label="JEV" value={`${jevThreshold}-of-3`} color="#8b5cf6" />
        {durationMs && <StatPill label="Time" value={`${(durationMs / 1000).toFixed(1)}s`} color="#888" />}
      </div>
      {reviews?.map((r, i) => (
        <div key={i} style={{ padding: '8px 12px', marginBottom: 6, borderRadius: 6, background: '#12121f', border: '1px solid #222' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: ACCENT }}>{r.reviewer}</span>
            <span style={{ fontSize: 11, color: '#555' }}>{r.agentId}</span>
          </div>
          {r.summary && <p style={{ fontSize: 12, color: '#999', margin: 0 }}>{r.summary}</p>}
          {r.error && <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>{r.error}</p>}
        </div>
      ))}
    </div>
  );
}

function StageList({ stages }) {
  if (!stages?.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }}>
      {stages.map((s, i) => (
        <div key={i} style={{ padding: '8px 12px', borderRadius: 6, background: '#12121f', border: '1px solid #1a1a2e' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#ccc' }}>
              <StatusDot status={s.status} />{s.name || `Stage ${s.number}`}
            </span>
            <span style={{ fontSize: 10, color: '#555' }}>{s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {s.added > 0 && <span style={{ fontSize: 10, color: '#22c55e' }}>+{s.added} entries</span>}
            {s.error && <span style={{ fontSize: 10, color: '#ef4444' }} title={s.error}>error</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ExecutionsList({ chainRunId }) {
  const [execs, setExecs] = useState([]);
  useEffect(() => {
    fetch(`/api/chain/runs/${chainRunId}/executions`).then(r => r.json()).then(d => setExecs(d.executions || [])).catch(() => {});
  }, [chainRunId]);
  if (execs.length === 0) return <p style={{ color: '#555', fontSize: 12 }}>No code executions yet — click "Execute Code" to generate verified code from chain findings</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {execs.map(ex => (
        <div key={ex.id} style={{ padding: 12, borderRadius: 8, background: '#12121f', border: '1px solid #1a1a2e' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: '#ccc', fontWeight: 600 }}>{ex.id}</span>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 8,
              background: ex.status === 'all_passed' ? '#22c55e22' : ex.status === 'partial' ? '#f59e0b22' : '#ef444422',
              color: ex.status === 'all_passed' ? '#22c55e' : ex.status === 'partial' ? '#f59e0b' : '#ef4444',
            }}>{ex.status}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <StatPill label="Passed" value={ex.steps_passed} color="#22c55e" />
            <StatPill label="Failed" value={ex.steps_failed} color="#ef4444" />
            <StatPill label="Total" value={ex.steps_total} color="#888" />
            {ex.duration_ms && <StatPill label="Duration" value={`${(ex.duration_ms / 1000).toFixed(0)}s`} color="#888" />}
          </div>
          {(ex.results || []).map((r, i) => (
            <div key={i} style={{ marginTop: 6, padding: '4px 8px', borderRadius: 4, background: '#0d0d1a', fontSize: 11 }}>
              <StatusDot status={r.status === 'passed' ? 'completed' : 'failed'} />
              <span style={{ color: '#aaa' }}>Step {r.step}: </span>
              <span style={{ color: '#888' }}>{r.goal}</span>
              {r.loopId && <span style={{ color: '#555', marginLeft: 6 }}>[{r.loopId}]</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RunDetail({ runId, onBack }) {
  const [run, setRun] = useState(null);
  const [tab, setTab] = useState('ledger');
  const [doc, setDoc] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/chain/runs/${runId}`).then(r => r.json()).then(setRun).catch(() => {});
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === 'document' && !doc) {
      fetch(`/api/chain/runs/${runId}/document`).then(r => r.text()).then(setDoc).catch(() => setDoc('Failed to load'));
    }
  }, [tab, runId, doc]);

  const triggerReview = async () => {
    setReviewing(true);
    try {
      await fetch(`/api/chain/runs/${runId}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      setTimeout(load, 2000);
    } catch (e) {}
    setReviewing(false);
  };

  const triggerExecute = async () => {
    setExecuting(true);
    try {
      await fetch(`/api/chain/runs/${runId}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'javascript' }) });
      setTab('executions');
    } catch (e) {}
    setExecuting(false);
  };

  if (!run) return <p style={{ color: '#555', padding: 20 }}>Loading...</p>;

  const stats = run.ledgerStats || {};
  const hasVerifiedSteps = (run.ledger?.implementation_steps || []).some(e => e.verified);
  const tabs = [
    { id: 'ledger', label: 'Ledger' },
    { id: 'stages', label: `Stages (${run.stageDetails?.length || run.stages?.length || 0})` },
    { id: 'review', label: 'Review' },
    { id: 'executions', label: 'Code' },
    { id: 'document', label: 'Document' },
  ];

  return (
    <div style={{ padding: 20 }}>
      <button onClick={onBack} style={{ background: 'none', border: '1px solid #333', borderRadius: 6, color: '#888', padding: '4px 12px', cursor: 'pointer', fontSize: 12, marginBottom: 12 }}>
        ← Back to runs
      </button>

      <div style={{ marginBottom: 16 }}>
        <h4 style={{ fontSize: 15, color: '#e0e0e8', margin: '0 0 8px', fontWeight: 600 }}>
          <StatusDot status={run.status} />{run.objective}
        </h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <StatPill label="Status" value={run.status} color={run.status === 'completed' ? '#22c55e' : '#f59e0b'} />
          <StatPill label="Entries" value={stats.total || 0} color="#6366f1" />
          <StatPill label="Warnings" value={stats.warnings || 0} color={stats.warnings > 0 ? '#ef4444' : '#22c55e'} />
          {run.usage?.durationMs && <StatPill label="Duration" value={`${(run.usage.durationMs / 1000).toFixed(0)}s`} color="#888" />}
          {run.config?.seeds?.length > 0 && <StatPill label="Seeds" value={run.config.seeds.length} color="#14b8a6" />}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid #222' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? '#1a1a2e' : 'none', border: 'none', borderBottom: tab === t.id ? `2px solid ${ACCENT}` : '2px solid transparent',
            color: tab === t.id ? '#e0e0e8' : '#666', padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'ledger' && (
        <div>
          {FIELDS.map(f => <LedgerField key={f} field={f} entries={run.ledger?.[f] || []} />)}
          {stats.total === 0 && <p style={{ color: '#555', fontSize: 13 }}>Ledger is empty — chain may still be running</p>}
        </div>
      )}

      {tab === 'stages' && <StageList stages={run.stageDetails || run.stages} />}

      {tab === 'review' && (
        <div>
          <ReviewSection review={run.review} />
          {!run.review && run.status === 'completed' && (
            <button onClick={triggerReview} disabled={reviewing} style={{
              marginTop: 12, background: ACCENT, border: 'none', borderRadius: 6, color: '#fff', padding: '8px 20px', cursor: 'pointer', fontSize: 13, opacity: reviewing ? 0.6 : 1,
            }}>{reviewing ? 'Starting review...' : 'Run JEV Review'}</button>
          )}
        </div>
      )}

      {tab === 'executions' && (
        <div>
          {run.status === 'completed' && hasVerifiedSteps && (
            <button onClick={triggerExecute} disabled={executing} style={{
              marginBottom: 16, background: '#6d28d9', border: 'none', borderRadius: 6, color: '#fff', padding: '8px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: executing ? 0.6 : 1,
            }}>{executing ? 'Executing...' : '⚡ Execute Verified Steps → Code'}</button>
          )}
          {run.status === 'completed' && !hasVerifiedSteps && (
            <p style={{ color: '#f59e0b', fontSize: 12, marginBottom: 12 }}>No verified implementation steps found — run JEV Review first to verify ledger entries</p>
          )}
          <ExecutionsList chainRunId={runId} />
        </div>
      )}

      {tab === 'document' && (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, color: '#ccc', lineHeight: 1.6, background: '#12121f', padding: 16, borderRadius: 8, border: '1px solid #222', maxHeight: 600, overflow: 'auto' }}>
          {doc || 'Loading...'}
        </pre>
      )}
    </div>
  );
}

export default function ChainPanel({ wsEvent }) {
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [objective, setObjective] = useState('');
  const [launching, setLaunching] = useState(false);
  const [slots, setSlots] = useState([]);

  const loadRuns = useCallback(() => {
    fetch('/api/chain/runs').then(r => r.json()).then(d => setRuns(d.runs || [])).catch(() => {});
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => {
    fetch('/api/chain/slots').then(r => r.json()).then(d => setSlots(d.slots || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (wsEvent?.type === 'chain') loadRuns();
  }, [wsEvent, loadRuns]);

  const launchChain = async () => {
    if (!objective.trim() || launching) return;
    setLaunching(true);
    try {
      const res = await fetch('/api/chain/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: objective.trim() }),
      });
      const data = await res.json();
      setObjective('');
      if (data.id && data.id !== 'pending') setSelectedRun(data.id);
      loadRuns();
    } catch (e) {}
    setLaunching(false);
  };

  const deleteRun = async (id, e) => {
    e.stopPropagation();
    try {
      await fetch(`/api/chain/runs/${id}`, { method: 'DELETE' });
      loadRuns();
    } catch (e) {}
  };

  if (selectedRun) return <RunDetail runId={selectedRun} onBack={() => { setSelectedRun(null); loadRuns(); }} />;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 20 }}>
        <h4 style={{ fontSize: 14, color: '#e0e0e8', margin: '0 0 8px', fontWeight: 600 }}>Launch Logic Chain</h4>
        <p style={{ fontSize: 12, color: '#666', margin: '0 0 10px' }}>
          8 specialized agents analyze your objective across 2 passes (16 stages), building an evidence-preserving ledger with JEV review.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={objective} onChange={e => setObjective(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && launchChain()}
            placeholder="Enter objective to analyze..."
            style={{ flex: 1, background: '#12121f', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', color: '#e0e0e8', fontSize: 13, outline: 'none' }}
          />
          <button onClick={launchChain} disabled={launching || !objective.trim()} style={{
            background: ACCENT, border: 'none', borderRadius: 6, color: '#fff', padding: '8px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: launching || !objective.trim() ? 0.5 : 1, whiteSpace: 'nowrap',
          }}>{launching ? 'Starting...' : 'Run Chain'}</button>
        </div>
      </div>

      {slots.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ fontSize: 13, color: '#888', margin: '0 0 8px', fontWeight: 600 }}>Agent Slots</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {slots.map((s, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 12, background: `${ACCENT}15`, color: '#aaa', fontSize: 11 }}>
                <span style={{ color: ACCENT, fontWeight: 600 }}>{s.role}</span>
                <span style={{ color: '#555' }}>→</span>
                <span>{s.agentId}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 13, color: '#888', margin: '0 0 10px', fontWeight: 600 }}>Chain Runs ({runs.length})</h4>
        {runs.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No chain runs yet — launch one above</p>}
        {runs.map(r => (
          <div key={r.id} onClick={() => setSelectedRun(r.id)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', marginBottom: 4, borderRadius: 6, background: '#12121f', border: '1px solid #1a1a2e', cursor: 'pointer', transition: 'border-color 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.borderColor = ACCENT}
            onMouseLeave={e => e.currentTarget.style.borderColor = '#1a1a2e'}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#ccc', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <StatusDot status={r.status} />{r.objective}
              </div>
              <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                {r.id} · {new Date(r.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: r.status === 'completed' ? '#22c55e' : r.status === 'running' ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>
                {r.status}
              </span>
              {r.status !== 'running' && (
                <button onClick={e => deleteRun(r.id, e)} style={{ background: 'none', border: '1px solid #333', borderRadius: 4, color: '#555', padding: '2px 8px', cursor: 'pointer', fontSize: 11 }} title="Delete run">✕</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
