import React, { useState, useEffect, useCallback } from 'react';

const PERSPECTIVE_META = {
  human: { icon: '👤', color: '#f59e0b', desc: 'Intuitive, feeling-first' },
  engineer: { icon: '⚙️', color: '#3b82f6', desc: 'Systematic, correctness-focused' },
  creative: { icon: '🎨', color: '#ec4899', desc: 'Freeform, divergent' },
  strategic: { icon: '🗺️', color: '#10b981', desc: 'Big-picture, trend-aware' },
  meta: { icon: '🔮', color: '#8b5cf6', desc: 'Self-reflective, brutally honest' },
  adversarial: { icon: '⚔️', color: '#ef4444', desc: 'Devil\'s advocate, stress-test' },
};

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: '#111118', border: '1px solid #222', borderRadius: 8,
      padding: '12px 16px', textAlign: 'center', minWidth: 90,
    }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e0e0e8' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function PerspectiveBadge({ name, active }) {
  const m = PERSPECTIVE_META[name] || { icon: '?', color: '#666', desc: name };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 14,
      background: active ? `${m.color}22` : '#1a1a2e',
      border: `1px solid ${active ? m.color : '#333'}`,
      fontSize: 12, color: active ? m.color : '#888',
    }}>
      <span>{m.icon}</span>
      <span style={{ fontWeight: active ? 600 : 400 }}>{name}</span>
    </span>
  );
}

export default function PerspectivePanel({ wsEvent }) {
  const [stats, setStats] = useState(null);
  const [playbook, setPlaybook] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [perspectives, setPerspectives] = useState(null);
  const [error, setError] = useState('');
  const [assessing, setAssessing] = useState(false);
  const [assessInput, setAssessInput] = useState('');
  const [assessResult, setAssessResult] = useState(null);
  const [tab, setTab] = useState('overview');

  const load = useCallback(async () => {
    try {
      const [sRes, pRes, sessRes, persRes] = await Promise.all([
        fetch('/api/perspective/status'),
        fetch('/api/perspective/playbook'),
        fetch('/api/perspective/sessions?limit=10'),
        fetch('/api/perspective/perspectives'),
      ]);
      setStats(await sRes.json());
      const pd = await pRes.json();
      setPlaybook(pd.playbook || []);
      const sd = await sessRes.json();
      setSessions(sd.sessions || []);
      const prd = await persRes.json();
      setPerspectives(prd.perspectives || {});
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'system.perspective') load();
  }, [wsEvent, load]);

  const runAssess = async () => {
    if (!assessInput.trim()) return;
    setAssessing(true);
    setAssessResult(null);
    try {
      const res = await fetch('/api/perspective/assess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: assessInput, context: 'manual UI assessment' }),
      });
      setAssessResult(await res.json());
      load();
    } catch (e) { setError(e.message); }
    setAssessing(false);
  };

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'playbook', label: 'Playbook' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'assess', label: 'Assess' },
  ];

  const pad = { padding: 20 };

  return (
    <div style={pad}>
      {error && <div style={{ color: '#ef4444', marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {/* Stat cards */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <StatCard label="Sessions" value={stats.totalSessions} color="#8b5cf6" />
          <StatCard label="Shifts" value={stats.totalShifts} color="#3b82f6" />
          <StatCard label="Playbook" value={stats.playbookSize} color="#10b981" />
          <StatCard label="Instance" value={stats.instanceId?.slice(0, 6) || '—'} color="#f59e0b" />
        </div>
      )}

      {/* Perspective usage distribution */}
      {stats?.perspectiveUsage?.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {stats.perspectiveUsage.map(p => (
            <PerspectiveBadge key={p.perspective} name={p.perspective} active />
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #222', paddingBottom: 8 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: tab === t.key ? '#8b5cf622' : 'transparent',
            border: `1px solid ${tab === t.key ? '#8b5cf6' : '#333'}`,
            borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
            color: tab === t.key ? '#8b5cf6' : '#888', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === 'overview' && perspectives && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260, 1fr))', gap: 10 }}>
          {Object.entries(perspectives).map(([key, p]) => {
            const m = PERSPECTIVE_META[key] || { icon: '?', color: '#666' };
            const usage = stats?.perspectiveUsage?.find(u => u.perspective === key);
            return (
              <div key={key} style={{
                background: '#111118', border: '1px solid #222', borderRadius: 10,
                padding: 16, position: 'relative',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 20 }}>{m.icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: m.color }}>{p.label}</span>
                  {usage && (
                    <span style={{
                      marginLeft: 'auto', fontSize: 11, color: '#888',
                      background: '#1a1a2e', padding: '2px 8px', borderRadius: 10,
                    }}>{usage.count} uses</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6, fontStyle: 'italic' }}>{p.style}</div>
                <div style={{ fontSize: 12, color: '#888', lineHeight: 1.5 }}>{p.approach}</div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 8 }}>Best for: {p.when}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Playbook tab */}
      {tab === 'playbook' && (
        <div>
          {playbook.length === 0 && <div style={{ color: '#666', fontSize: 13 }}>No playbook entries yet. Run assessments to build the playbook.</div>}
          {playbook.map((entry, i) => {
            const total = (entry.success_count || 0) + (entry.fail_count || 0);
            const rate = total > 0 ? Math.round((entry.success_count / total) * 100) : null;
            const persp = Array.isArray(entry.perspectives_used) ? entry.perspectives_used : [];
            return (
              <div key={entry.id || i} style={{
                background: '#111118', border: '1px solid #222', borderRadius: 8,
                padding: 14, marginBottom: 8,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8' }}>{entry.pattern}</span>
                  {rate !== null && (
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      background: rate >= 70 ? '#10b98122' : rate >= 40 ? '#f59e0b22' : '#ef444422',
                      color: rate >= 70 ? '#10b981' : rate >= 40 ? '#f59e0b' : '#ef4444',
                    }}>{rate}% success ({total})</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{entry.recommended_approach}</div>
                {persp.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                    {persp.map(p => <PerspectiveBadge key={p} name={p} active />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sessions tab */}
      {tab === 'sessions' && (
        <div>
          {sessions.length === 0 && <div style={{ color: '#666', fontSize: 13 }}>No perspective sessions yet.</div>}
          {sessions.map((s, i) => {
            const persp = Array.isArray(s.active_perspectives) ? s.active_perspectives : [];
            const age = s.started_at ? `${Math.round((Date.now() - s.started_at) / 60000)}m ago` : '';
            return (
              <div key={s.id || i} style={{
                background: '#111118', border: '1px solid #222', borderRadius: 8,
                padding: 14, marginBottom: 8,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#888', fontFamily: 'monospace' }}>{(s.id || '').slice(0, 8)}</span>
                  <span style={{ fontSize: 11, color: '#666' }}>{age}</span>
                </div>
                {persp.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                    {persp.map(p => <PerspectiveBadge key={p} name={p} active />)}
                  </div>
                )}
                {s.outcome_summary && (
                  <div style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>{s.outcome_summary}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Assess tab */}
      {tab === 'assess' && (
        <div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
            Describe a task or problem to get the Perspective engine's recommended approach.
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={assessInput}
              onChange={e => setAssessInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runAssess()}
              placeholder="What needs to be done?"
              style={{
                flex: 1, background: '#111118', border: '1px solid #333', borderRadius: 8,
                padding: '10px 14px', color: '#e0e0e8', fontSize: 13, outline: 'none',
              }}
            />
            <button onClick={runAssess} disabled={assessing} style={{
              background: '#8b5cf6', border: 'none', borderRadius: 8, padding: '10px 18px',
              color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              opacity: assessing ? 0.5 : 1,
            }}>{assessing ? 'Thinking...' : 'Assess'}</button>
          </div>

          {assessResult && (
            <div style={{
              background: '#111118', border: '1px solid #8b5cf644', borderRadius: 10,
              padding: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#8b5cf6', marginBottom: 8 }}>
                Recommended Perspective{assessResult.perspectives?.length > 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {(assessResult.perspectives || []).map(p => <PerspectiveBadge key={p} name={p} active />)}
              </div>
              {assessResult.confidence != null && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
                  Confidence: <span style={{ color: assessResult.confidence >= 0.7 ? '#10b981' : '#f59e0b' }}>
                    {(assessResult.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              {assessResult.framing && (
                <div style={{
                  fontSize: 13, color: '#e0e0e8', padding: 12, background: '#0a0a0f',
                  borderRadius: 8, border: '1px solid #222', marginBottom: 8, lineHeight: 1.5,
                }}>"{assessResult.framing}"</div>
              )}
              {assessResult.reasoning && (
                <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
                  <span style={{ fontWeight: 600 }}>Reasoning:</span> {assessResult.reasoning}
                </div>
              )}
              {assessResult.pattern_match && (
                <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
                  Pattern: <span style={{ fontFamily: 'monospace' }}>{assessResult.pattern_match}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
