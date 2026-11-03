import { useState, useEffect, useCallback } from 'react';

const PATTERN_COLORS = {
  bias: '#ef4444', heuristic: '#f59e0b', blind_spot: '#6b7280',
  strength: '#22c55e', preference: '#8b5cf6',
};
const PATTERN_ICONS = {
  bias: '⚠', heuristic: '⚡', blind_spot: '◌',
  strength: '★', preference: '◆',
};

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#1e1b2e', borderRadius: 8, padding: '12px 16px', minWidth: 100 }}>
      <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e0e0f0' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PatternBadge({ type }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: `${PATTERN_COLORS[type] || '#6b7280'}22`, color: PATTERN_COLORS[type] || '#6b7280', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
      {PATTERN_ICONS[type] || '?'} {type}
    </span>
  );
}

function StrengthBar({ value, color }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, background: '#2a2740', borderRadius: 3, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color || '#7c3aed', borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color: color || '#7c3aed', fontWeight: 600, minWidth: 30 }}>{pct}%</span>
    </div>
  );
}

export default function SubconsciousPanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [thoughts, setThoughts] = useState([]);
  const [selectedThought, setSelectedThought] = useState(null);
  const [introspection, setIntrospection] = useState(null);
  const [introspectAgent, setIntrospectAgent] = useState('');
  const [error, setError] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/subconscious/stats');
      setStats(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadThoughts = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/subconscious/thoughts?limit=30');
      const data = await res.json();
      setThoughts(data.thoughts || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadStats(); loadThoughts(); }, [loadStats, loadThoughts]);
  useEffect(() => {
    if (wsEvent?.type === 'subconscious') { loadStats(); loadThoughts(); }
  }, [wsEvent, loadStats, loadThoughts]);

  const loadThoughtDetail = async (id) => {
    try {
      const res = await fetch(`/api/intelligence/subconscious/thought/${id}`);
      setSelectedThought(await res.json());
    } catch (e) { setError(e.message); }
  };

  const runIntrospect = async () => {
    if (!introspectAgent.trim()) return;
    setError('');
    try {
      const res = await fetch(`/api/intelligence/subconscious/introspect/${encodeURIComponent(introspectAgent.trim())}`);
      setIntrospection(await res.json());
    } catch (e) { setError(e.message); }
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'streams', label: 'Thought Streams' },
    { id: 'introspect', label: 'Introspect' },
  ];

  if (selectedThought) {
    const t = selectedThought;
    return (
      <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
        <button onClick={() => setSelectedThought(null)} style={{ background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontSize: 13, marginBottom: 12 }}>
          &larr; Back
        </button>
        <h3 style={{ margin: '0 0 4px', color: '#7c3aed' }}>{t.agent_id}</h3>
        <div style={{ fontSize: 12, color: '#a0a0b8', marginBottom: 12 }}>{t.task}</div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <StatCard label="Depth" value={t.depth} color="#7c3aed" />
          <StatCard label="Insights" value={t.insights?.length || 0} color="#22c55e" />
          <StatCard label="Dead Ends" value={t.dead_ends?.length || 0} color="#ef4444" />
          <StatCard label="Pivots" value={t.pivots?.length || 0} color="#f59e0b" />
        </div>

        <div style={{ background: '#1e1b2e', borderRadius: 8, padding: 12, marginBottom: 12, maxHeight: 200, overflowY: 'auto' }}>
          <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 6 }}>Reasoning Trace</div>
          <pre style={{ fontSize: 12, color: '#c0c0d0', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.5 }}>{t.reasoning_trace}</pre>
        </div>

        {t.insights?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#22c55e', marginBottom: 6 }}>Insights Captured</div>
            {t.insights.map((ins, i) => (
              <div key={i} style={{ background: '#0a2010', borderLeft: '3px solid #22c55e', padding: '6px 10px', marginBottom: 4, fontSize: 12, color: '#86efac', borderRadius: '0 4px 4px 0' }}>
                {typeof ins === 'string' ? ins : JSON.stringify(ins)}
              </div>
            ))}
          </div>
        )}

        {t.dead_ends?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 6 }}>Dead Ends (avoid these)</div>
            {t.dead_ends.map((de, i) => (
              <div key={i} style={{ background: '#200a0a', borderLeft: '3px solid #ef4444', padding: '6px 10px', marginBottom: 4, fontSize: 12, color: '#fca5a5', borderRadius: '0 4px 4px 0' }}>
                {typeof de === 'string' ? de : de.approach || JSON.stringify(de)}
              </div>
            ))}
          </div>
        )}

        {t.pivots?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 6 }}>Pivots (direction changes)</div>
            {t.pivots.map((pv, i) => (
              <div key={i} style={{ background: '#1a1500', borderLeft: '3px solid #f59e0b', padding: '6px 10px', marginBottom: 4, fontSize: 12, color: '#fcd34d', borderRadius: '0 4px 4px 0' }}>
                {typeof pv === 'string' ? pv : pv.reason || JSON.stringify(pv)}
              </div>
            ))}
          </div>
        )}

        {t.confidence_arc?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 6 }}>Confidence Arc</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 40 }}>
              {t.confidence_arc.map((c, i) => (
                <div key={i} style={{ flex: 1, background: c >= 0.7 ? '#22c55e' : c >= 0.4 ? '#f59e0b' : '#ef4444', height: `${Math.round(c * 100)}%`, borderRadius: '2px 2px 0 0', minHeight: 2 }}
                  title={`Step ${i + 1}: ${Math.round(c * 100)}%`} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: tab === t.id ? '#7c3aed' : '#2a2740', color: tab === t.id ? '#fff' : '#a0a0b8' }}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={{ background: '#2d1040', color: '#c084fc', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {tab === 'overview' && stats && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Thought Streams" value={stats.totalThoughts} color="#7c3aed" />
            <StatCard label="Patterns Found" value={stats.totalPatterns} color="#c4b5fd" />
            <StatCard label="Agents Tracked" value={stats.agents} color="#f59e0b" />
            <StatCard label="Avg Depth" value={stats.avgDepth != null ? stats.avgDepth.toFixed(1) : '—'} color="#22c55e" />
          </div>

          {stats.patternTypes?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Pattern Types</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stats.patternTypes.map((pt, i) => (
                  <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PatternBadge type={pt.pattern_type} />
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#e0e0f0' }}>{pt.count}</span>
                    <span style={{ fontSize: 10, color: '#6b7280' }}>avg {Math.round((pt.avg_strength || 0) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.topAgents?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Active Thinkers</div>
              {stats.topAgents.map((a, i) => (
                <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0' }}>{a.agent_id}</span>
                  <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                    <span style={{ color: '#7c3aed' }}>{a.thoughts} thoughts</span>
                    <span style={{ color: '#c4b5fd' }}>{a.patterns} patterns</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {stats.recentInsights?.length > 0 && (
            <div>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Recent Insights</div>
              {stats.recentInsights.map((r, i) => (
                <div key={i} style={{ background: '#0a2010', borderLeft: '3px solid #22c55e', padding: '8px 10px', marginBottom: 4, borderRadius: '0 4px 4px 0' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{r.agent_id} — {r.task?.slice(0, 60)}</div>
                  {r.insights?.slice(0, 2).map((ins, j) => (
                    <div key={j} style={{ fontSize: 12, color: '#86efac' }}>{typeof ins === 'string' ? ins : JSON.stringify(ins)}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'streams' && (
        <>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Captured Reasoning Traces</div>
          {thoughts.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No thought streams captured yet. Run agent tasks with reasoning capture enabled.</div>}
          {thoughts.map((t, i) => (
            <div key={i} onClick={() => loadThoughtDetail(t.id)}
              style={{ background: '#1e1b2e', borderRadius: 6, padding: '10px 12px', marginBottom: 4, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0' }}>{t.agent_id}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: '#7c3aed', background: '#7c3aed22', padding: '1px 6px', borderRadius: 8 }}>depth {t.depth}</span>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>{t.domain}</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#c0c0d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
                {t.task}
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#6b7280' }}>
                {t.insights?.length > 0 && <span style={{ color: '#22c55e' }}>{t.insights.length} insights</span>}
                {t.dead_ends?.length > 0 && <span style={{ color: '#ef4444' }}>{t.dead_ends.length} dead ends</span>}
                {t.pivots?.length > 0 && <span style={{ color: '#f59e0b' }}>{t.pivots.length} pivots</span>}
                <span>{new Date(t.created_at + 'Z').toLocaleString()}</span>
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'introspect' && (
        <>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Agent Self-Examination</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input value={introspectAgent} onChange={e => setIntrospectAgent(e.target.value)}
              placeholder="Agent ID (e.g. fraymus-prime)"
              style={{ flex: 1, background: '#1e1b2e', border: '1px solid #3a3650', borderRadius: 6, padding: '8px 12px', color: '#e0e0f0', fontSize: 13, outline: 'none' }} />
            <button onClick={runIntrospect}
              style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Introspect
            </button>
          </div>

          {introspection && (
            <div>
              {introspection.meta && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                  <StatCard label="Depth Avg" value={introspection.meta.avgDepth?.toFixed(1) || '—'} color="#7c3aed" />
                  <StatCard label="Insights" value={introspection.meta.totalInsights} color="#22c55e" />
                  <StatCard label="Dead Ends" value={introspection.meta.totalDeadEnds} color="#ef4444" />
                  <StatCard label="Patterns" value={introspection.meta.patternCount} color="#c4b5fd" />
                </div>
              )}

              {introspection.strengths?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#22c55e', marginBottom: 6 }}>Strengths</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {introspection.strengths.map((s, i) => <PatternBadge key={i} type="strength" />)}
                    {introspection.strengths.map((s, i) => (
                      <span key={`t${i}`} style={{ fontSize: 12, color: '#86efac' }}>{s}</span>
                    ))}
                  </div>
                </div>
              )}

              {introspection.blindSpots?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Blind Spots</div>
                  {introspection.blindSpots.map((b, i) => (
                    <div key={i} style={{ background: '#1e1b2e', padding: '4px 10px', borderRadius: 4, marginBottom: 2, fontSize: 12, color: '#9ca3af' }}>◌ {b}</div>
                  ))}
                </div>
              )}

              {introspection.biases?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 6 }}>Biases</div>
                  {introspection.biases.map((b, i) => (
                    <div key={i} style={{ background: '#200a0a', padding: '4px 10px', borderRadius: 4, marginBottom: 2, fontSize: 12, color: '#fca5a5' }}>⚠ {b}</div>
                  ))}
                </div>
              )}

              {introspection.patterns?.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, color: '#a0a0b8', marginBottom: 6 }}>All Patterns</div>
                  {introspection.patterns.map((p, i) => (
                    <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <PatternBadge type={p.pattern_type} />
                        <span style={{ fontSize: 10, color: '#6b7280' }}>seen {p.frequency}x</span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0', marginBottom: 2 }}>{p.pattern}</div>
                      {p.description && <div style={{ fontSize: 12, color: '#a0a0b8' }}>{p.description}</div>}
                      <StrengthBar value={p.strength} color={PATTERN_COLORS[p.pattern_type]} />
                    </div>
                  ))}
                </div>
              )}

              {!introspection.patterns?.length && !introspection.strengths?.length && (
                <div style={{ fontSize: 12, color: '#6b7280', background: '#1e1b2e', padding: 12, borderRadius: 6 }}>
                  {introspection.report || 'No subconscious data for this agent yet.'}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
