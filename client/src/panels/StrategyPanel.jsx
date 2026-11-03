import { useState, useEffect, useCallback } from 'react';

const TABS = ['Overview', 'Sessions', 'Analyze'];
const PATH_COLORS = {
  single_agent: '#6366f1', swarm: '#f59e0b', debate: '#dc2626',
  pipeline: '#8b5cf6', decompose: '#10b981', verify_loop: '#3b82f6', fallback: '#666',
};
const PATH_ICONS = {
  single_agent: '⚡', swarm: '🐝', debate: '⚔', pipeline: '⬡',
  decompose: '◎', verify_loop: '✓', fallback: '?',
};

function StatCard({ label, value, sub }) {
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 8, padding: '14px 16px', minWidth: 100 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#0d9488', marginTop: 2 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PathBadge({ path }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
      color: '#fff', background: PATH_COLORS[path] || '#666',
    }}>
      <span>{PATH_ICONS[path] || '?'}</span> {path?.replace(/_/g, ' ')}
    </span>
  );
}

function ConfidenceBar({ value }) {
  if (value == null) return <span style={{ color: '#555' }}>—</span>;
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: '#222', borderRadius: 3, maxWidth: 80 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color, fontWeight: 600 }}>{pct}%</span>
    </div>
  );
}

export default function StrategyPanel({ wsEvent }) {
  const [tab, setTab] = useState('Overview');
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [task, setTask] = useState('');
  const [context, setContext] = useState('');
  const [autoExecute, setAutoExecute] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/strategy/stats');
      setStats(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/strategies?limit=30');
      const data = await res.json();
      setSessions(data.strategies || []);
    } catch (e) { setError(e.message); }
  }, []);

  const loadDetail = useCallback(async (id) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelligence/strategy/${id}`);
      setDetail(await res.json());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadStats(); loadSessions(); }, [loadStats, loadSessions]);
  useEffect(() => {
    if (wsEvent?.type === 'system.strategy') { loadStats(); loadSessions(); }
  }, [wsEvent, loadStats, loadSessions]);

  const analyze = async () => {
    if (!task.trim()) return;
    setRunning(true); setResult(null); setError('');
    try {
      const res = await fetch('/api/intelligence/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, context, autoExecute }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); } else { setResult(data); loadStats(); loadSessions(); }
    } catch (e) { setError(e.message); }
    setRunning(false);
  };

  if (detail) {
    const analysis = detail.analysis || {};
    const plan = detail.plan || {};
    const execResult = detail.result || {};
    return (
      <div style={{ padding: 20, color: '#e0e0e0', fontFamily: 'system-ui' }}>
        <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', color: '#0d9488', cursor: 'pointer', marginBottom: 12, fontSize: 13 }}>← Back</button>
        <h3 style={{ margin: 0, color: '#0d9488' }}>Strategy: {detail.task?.slice(0, 80)}</h3>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <StatCard label="Path" value={detail.execution_path?.replace(/_/g, ' ') || 'pending'} />
          <StatCard label="Quality" value={detail.outcome_score != null ? Math.round(detail.outcome_score * 100) + '%' : '—'} />
          <StatCard label="Duration" value={detail.duration_ms ? (detail.duration_ms / 1000).toFixed(1) + 's' : '—'} />
          <StatCard label="Status" value={detail.status} />
        </div>

        {analysis.reasoning && (
          <div style={{ marginTop: 16, background: '#1a1a2e', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: '#0d9488', fontWeight: 600, marginBottom: 6 }}>Analysis</div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              {analysis.complexity && <span style={{ fontSize: 11, color: '#888', background: '#222', padding: '2px 8px', borderRadius: 10 }}>Complexity: {analysis.complexity}</span>}
              {analysis.domain && <span style={{ fontSize: 11, color: '#888', background: '#222', padding: '2px 8px', borderRadius: 10 }}>{analysis.domain}</span>}
              {analysis.requires_creativity && <span style={{ fontSize: 11, color: '#f59e0b', background: '#332800', padding: '2px 8px', borderRadius: 10 }}>Creative</span>}
              {analysis.requires_precision && <span style={{ fontSize: 11, color: '#3b82f6', background: '#1a2744', padding: '2px 8px', borderRadius: 10 }}>Precise</span>}
              {analysis.requires_multiple_viewpoints && <span style={{ fontSize: 11, color: '#8b5cf6', background: '#2d1f5e', padding: '2px 8px', borderRadius: 10 }}>Multi-view</span>}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: '#aaa' }}>{analysis.reasoning}</div>
            {analysis.recommended_agents?.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
                Agents: {analysis.recommended_agents.map((a, i) => (
                  <span key={i} style={{ color: '#6366f1', fontWeight: 600 }}>{i > 0 ? ', ' : ''}{a}</span>
                ))}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 11, color: '#888' }}>Confidence: </span>
              <ConfidenceBar value={analysis.confidence} />
            </div>
          </div>
        )}

        {execResult.type && (
          <div style={{ marginTop: 12, background: '#1a1a2e', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: '#0d9488', fontWeight: 600, marginBottom: 6 }}>Execution Result</div>
            <PathBadge path={execResult.type} />
            {execResult.reply && <div style={{ fontSize: 12, lineHeight: 1.5, color: '#aaa', marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{execResult.reply}</div>}
            {execResult.synthesis && <div style={{ fontSize: 12, lineHeight: 1.5, color: '#aaa', marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{execResult.synthesis}</div>}
            {execResult.verdict && <div style={{ fontSize: 13, marginTop: 8 }}>Verdict: <span style={{ color: '#f59e0b', fontWeight: 600 }}>{execResult.verdict}</span></div>}
            {execResult.subResults && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Sub-tasks:</div>
                {execResult.subResults.map((sr, i) => (
                  <div key={i} style={{ fontSize: 12, color: '#aaa', padding: '4px 8px', background: '#111', borderRadius: 6, marginBottom: 4 }}>
                    <PathBadge path={sr.path} /> {sr.task?.slice(0, 60)} {sr.error && <span style={{ color: '#ef4444' }}> — {sr.error}</span>}
                  </div>
                ))}
              </div>
            )}
            {execResult.error && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{execResult.error}</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 20, color: '#e0e0e0', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>🧭</span>
        <h2 style={{ margin: 0, color: '#0d9488' }}>Strategy Engine</h2>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: tab === t ? '#0d9488' : '#1a1a2e', color: tab === t ? '#000' : '#888',
            fontWeight: tab === t ? 700 : 400, fontSize: 13,
          }}>{t}</button>
        ))}
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {tab === 'Overview' && stats && (
        <div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Total" value={stats.total} />
            <StatCard label="Completed" value={stats.completed} />
            <StatCard label="Avg Quality" value={stats.avgQuality != null ? Math.round(stats.avgQuality * 100) + '%' : '—'} />
            <StatCard label="Avg Duration" value={stats.avgDurationMs ? (stats.avgDurationMs / 1000).toFixed(1) + 's' : '—'} />
          </div>

          {(stats.pathDistribution || []).length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Execution Path Distribution</div>
              {stats.pathDistribution.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1a1a2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4, borderLeft: `3px solid ${PATH_COLORS[p.path] || '#666'}` }}>
                  <PathBadge path={p.path} />
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#888' }}>{p.count} uses</span>
                    <ConfidenceBar value={p.avg_quality} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {(stats.topPatterns || []).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Learned Patterns</div>
              {stats.topPatterns.map((p, i) => (
                <div key={i} style={{ background: '#1a1a2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#e0e0e0' }}>"{p.pattern}"</span>
                    <PathBadge path={p.recommended_path} />
                  </div>
                  <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{p.uses} uses, {Math.round(p.success_rate * 100)}% success</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'Sessions' && (
        <div>
          {sessions.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>No strategy sessions yet.</div>}
          {sessions.map(s => (
            <div key={s.id} onClick={() => loadDetail(s.id)} style={{
              background: '#1a1a2e', borderRadius: 8, padding: 12, marginBottom: 8, cursor: 'pointer',
              borderLeft: `3px solid ${s.status === 'completed' ? '#10b981' : s.status === 'planned' ? '#0d9488' : s.status === 'executing' ? '#f59e0b' : '#ef4444'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.task?.slice(0, 60)}</div>
                <span style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, color: '#fff',
                  background: s.status === 'completed' ? '#10b981' : s.status === 'planned' ? '#0d9488' : s.status === 'executing' ? '#f59e0b' : '#ef4444',
                }}>{s.status}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: '#888', alignItems: 'center' }}>
                {s.execution_path && <PathBadge path={s.execution_path} />}
                {s.outcome_score != null && <span>quality: {Math.round(s.outcome_score * 100)}%</span>}
                {s.duration_ms && <span>{(s.duration_ms / 1000).toFixed(1)}s</span>}
                <span>{new Date(s.created_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
          {loading && <div style={{ color: '#0d9488', fontSize: 12 }}>Loading...</div>}
        </div>
      )}

      {tab === 'Analyze' && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Task</label>
            <textarea value={task} onChange={e => setTask(e.target.value)} rows={3}
              placeholder="Describe the task — the engine will recommend the best execution path..."
              style={{ width: '100%', background: '#111', border: '1px solid #333', borderRadius: 6, padding: 10, color: '#e0e0e0', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Context (optional)</label>
            <textarea value={context} onChange={e => setContext(e.target.value)} rows={2}
              placeholder="Additional context..."
              style={{ width: '100%', background: '#111', border: '1px solid #333', borderRadius: 6, padding: 10, color: '#e0e0e0', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoExecute} onChange={e => setAutoExecute(e.target.checked)}
                style={{ accentColor: '#0d9488' }} />
              Auto-execute (analyze + run through recommended path)
            </label>
          </div>

          <button onClick={analyze} disabled={running || !task.trim()} style={{
            background: running ? '#555' : '#0d9488', color: '#000', border: 'none', borderRadius: 6,
            padding: '10px 24px', fontWeight: 700, fontSize: 14, cursor: running ? 'wait' : 'pointer',
          }}>{running ? (autoExecute ? 'Strategizing + Executing...' : 'Analyzing...') : (autoExecute ? 'Strategize + Execute' : 'Analyze Task')}</button>

          {result && (
            <div style={{ marginTop: 16, background: '#1a1a2e', borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>
                  {result.status === 'completed' ? 'Strategy Executed' : 'Analysis Complete'}
                </div>
                <PathBadge path={result.executionPath || result.recommendedPath} />
              </div>
              {result.analysis?.reasoning && (
                <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>{result.analysis.reasoning}</div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {result.analysis?.complexity && <span style={{ fontSize: 11, color: '#888', background: '#222', padding: '2px 8px', borderRadius: 10 }}>{result.analysis.complexity}</span>}
                {result.analysis?.domain && <span style={{ fontSize: 11, color: '#888', background: '#222', padding: '2px 8px', borderRadius: 10 }}>{result.analysis.domain}</span>}
              </div>
              {result.analysis?.recommended_agents?.length > 0 && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
                  Recommended: {result.analysis.recommended_agents.join(', ')}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#888' }}>
                Confidence: <ConfidenceBar value={result.confidence || result.analysis?.confidence} />
              </div>
              {result.quality != null && (
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  Outcome quality: <ConfidenceBar value={result.quality} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
