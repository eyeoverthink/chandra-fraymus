import { useState, useEffect, useCallback } from 'react';

const TABS = ['Overview', 'Sessions', 'Initiate'];
const PERSPECTIVE_COLORS = {
  human: '#ec4899', engineer: '#3b82f6', creative: '#f59e0b',
  strategic: '#10b981', meta: '#8b5cf6', adversarial: '#ef4444',
};

function StatCard({ label, value, sub }) {
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 8, padding: '14px 16px', minWidth: 100 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#f59e0b', marginTop: 2 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PerspectiveBadge({ name }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 11, fontWeight: 600, color: '#fff',
      background: PERSPECTIVE_COLORS[name] || '#666',
    }}>{name}</span>
  );
}

function QualityBar({ score }) {
  if (score == null) return <span style={{ color: '#555' }}>—</span>;
  const pct = Math.round(score * 100);
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

export default function SwarmPanel({ wsEvent }) {
  const [tab, setTab] = useState('Overview');
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Initiate form state
  const [task, setTask] = useState('');
  const [context, setContext] = useState('');
  const [agentCount, setAgentCount] = useState(3);
  const [perspectiveMode, setPerspectiveMode] = useState('diverse');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/swarm/stats');
      setStats(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/swarms?limit=30');
      const data = await res.json();
      setSessions(data.swarms || []);
    } catch (e) { setError(e.message); }
  }, []);

  const loadDetail = useCallback(async (id) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelligence/swarm/${id}`);
      setDetail(await res.json());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadStats(); loadSessions(); }, [loadStats, loadSessions]);
  useEffect(() => {
    if (wsEvent?.type === 'system.swarm') { loadStats(); loadSessions(); }
  }, [wsEvent, loadStats, loadSessions]);

  const initiate = async () => {
    if (!task.trim()) return;
    setRunning(true); setResult(null); setError('');
    try {
      const res = await fetch('/api/intelligence/swarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, context, agentCount, perspectiveMode }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); } else { setResult(data); loadStats(); loadSessions(); }
    } catch (e) { setError(e.message); }
    setRunning(false);
  };

  if (detail) {
    const synth = detail.synthesis_parsed || {};
    return (
      <div style={{ padding: 20, color: '#e0e0e0', fontFamily: 'system-ui' }}>
        <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', color: '#f59e0b', cursor: 'pointer', marginBottom: 12, fontSize: 13 }}>← Back to sessions</button>
        <h3 style={{ margin: 0, color: '#f59e0b' }}>Swarm: {detail.task?.slice(0, 80)}</h3>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <StatCard label="Agents" value={detail.agent_count} />
          <StatCard label="Quality" value={detail.quality_score != null ? Math.round(detail.quality_score * 100) + '%' : '—'} />
          <StatCard label="Duration" value={detail.duration_ms ? (detail.duration_ms / 1000).toFixed(1) + 's' : '—'} />
          <StatCard label="Mode" value={detail.perspective_mode} />
        </div>

        {synth.synthesis && (
          <div style={{ marginTop: 16, background: '#1a1a2e', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 6 }}>Synthesis</div>
            <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{synth.synthesis}</div>
          </div>
        )}

        {(synth.keyInsights || []).length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 6 }}>Key Insights</div>
            {synth.keyInsights.map((ins, i) => (
              <div key={i} style={{ background: '#111', borderRadius: 6, padding: '6px 10px', marginBottom: 4, fontSize: 12 }}>• {ins}</div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 8 }}>Contributions</div>
          {(detail.fullContributions || []).map((c, i) => (
            <div key={i} style={{ background: '#1a1a2e', borderRadius: 8, padding: 12, marginBottom: 8, borderLeft: `3px solid ${PERSPECTIVE_COLORS[c.perspective] || '#666'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{c.agent_id}</span>
                  <PerspectiveBadge name={c.perspective} />
                </div>
                <QualityBar score={c.quality_score} />
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.4, color: '#aaa', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{c.output?.slice(0, 2000)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, color: '#e0e0e0', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>🐝</span>
        <h2 style={{ margin: 0, color: '#f59e0b' }}>Swarm Protocol</h2>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: tab === t ? '#f59e0b' : '#1a1a2e', color: tab === t ? '#000' : '#888',
            fontWeight: tab === t ? 700 : 400, fontSize: 13,
          }}>{t}</button>
        ))}
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {tab === 'Overview' && stats && (
        <div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Total Swarms" value={stats.total} />
            <StatCard label="Completed" value={stats.completed} />
            <StatCard label="Avg Quality" value={stats.avgQuality != null ? Math.round(stats.avgQuality * 100) + '%' : '—'} />
            <StatCard label="Avg Duration" value={stats.avgDurationMs ? (stats.avgDurationMs / 1000).toFixed(1) + 's' : '—'} />
            <StatCard label="Contributions" value={stats.totalContributions} />
          </div>

          {(stats.topPerspectives || []).length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Top Perspectives</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {stats.topPerspectives.map((p, i) => (
                  <div key={i} style={{ background: '#1a1a2e', borderRadius: 8, padding: '8px 12px', borderLeft: `3px solid ${PERSPECTIVE_COLORS[p.perspective] || '#666'}` }}>
                    <PerspectiveBadge name={p.perspective} />
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{p.uses} uses • {p.avg_quality != null ? Math.round(p.avg_quality * 100) + '% quality' : 'no scores'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(stats.topAgents || []).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Top Agents</div>
              {stats.topAgents.map((a, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1a1a2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{a.agent_id}</span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#888' }}>{a.runs} runs</span>
                    <QualityBar score={a.avg_quality} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'Sessions' && (
        <div>
          {sessions.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>No swarm sessions yet. Start one from the Initiate tab.</div>}
          {sessions.map(s => (
            <div key={s.id} onClick={() => loadDetail(s.id)} style={{
              background: '#1a1a2e', borderRadius: 8, padding: 12, marginBottom: 8, cursor: 'pointer',
              borderLeft: `3px solid ${s.status === 'completed' ? '#10b981' : s.status === 'running' ? '#f59e0b' : '#ef4444'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.task?.slice(0, 60)}</div>
                <span style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, color: '#fff',
                  background: s.status === 'completed' ? '#10b981' : s.status === 'running' ? '#f59e0b' : '#ef4444',
                }}>{s.status}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: '#888' }}>
                <span>{s.agent_count} agents</span>
                <span>{s.perspective_mode}</span>
                {s.quality_score != null && <span>quality: {Math.round(s.quality_score * 100)}%</span>}
                {s.duration_ms && <span>{(s.duration_ms / 1000).toFixed(1)}s</span>}
                <span>{new Date(s.created_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
          {loading && <div style={{ color: '#f59e0b', fontSize: 12 }}>Loading...</div>}
        </div>
      )}

      {tab === 'Initiate' && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Task</label>
            <textarea value={task} onChange={e => setTask(e.target.value)} rows={3}
              placeholder="Describe the task for the swarm to solve collaboratively..."
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
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Agents</label>
              <select value={agentCount} onChange={e => setAgentCount(Number(e.target.value))}
                style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#e0e0e0', fontSize: 13 }}>
                {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Mode</label>
              <select value={perspectiveMode} onChange={e => setPerspectiveMode(e.target.value)}
                style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#e0e0e0', fontSize: 13 }}>
                <option value="diverse">Diverse (different lenses)</option>
                <option value="focused">Focused (all engineer)</option>
                <option value="auto">Auto (LLM picks lenses)</option>
              </select>
            </div>
          </div>

          <button onClick={initiate} disabled={running || !task.trim()} style={{
            background: running ? '#555' : '#f59e0b', color: '#000', border: 'none', borderRadius: 6,
            padding: '10px 24px', fontWeight: 700, fontSize: 14, cursor: running ? 'wait' : 'pointer',
          }}>{running ? 'Running Swarm...' : 'Initiate Swarm'}</button>

          {result && (
            <div style={{ marginTop: 16, background: '#1a1a2e', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: '#10b981', fontWeight: 600, marginBottom: 6 }}>Swarm Complete — {result.agentCount} agents, {result.keyInsights?.length || 0} insights</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {(result.perspectives || []).map((p, i) => <PerspectiveBadge key={i} name={p} />)}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{result.synthesis}</div>
              {(result.keyInsights || []).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>Key Insights:</div>
                  {result.keyInsights.map((ins, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>• {ins}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
