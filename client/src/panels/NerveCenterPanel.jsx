import React, { useState, useEffect, useCallback } from 'react';

const COLORS = {
  heart: '#ef4444', dreamer: '#8b5cf6', consciousness: '#f59e0b',
  cognition: '#10b981', needle: '#06b6d4', motor: '#ec4899',
  ledger: '#3b82f6', memory: '#a78bfa', hermes: '#f97316',
};

const EMOTION_COLORS = {
  joy: '#fbbf24', sadness: '#60a5fa', anger: '#ef4444', fear: '#a78bfa',
  surprise: '#34d399', disgust: '#84cc16', trust: '#06b6d4', anticipation: '#f97316',
  neutral: '#6b7280',
};

const HERMES_CATEGORY_ICONS = {
  research: '⊕', code: '⚡', media: '▶', system: '⚙', intelligence: '♦',
};

function StatCard({ label, value, sub, color, icon, pulse }) {
  return (
    <div style={{
      background: '#111118', border: `1px solid ${color}25`, borderRadius: 10,
      padding: '14px 16px', position: 'relative', overflow: 'hidden',
      transition: 'border-color 0.3s',
      ...(pulse ? { borderColor: color + '60', boxShadow: `0 0 12px ${color}20` } : {}),
    }}>
      <div style={{
        position: 'absolute', top: 0, right: 0, width: 50, height: 50,
        background: `radial-gradient(circle at top right, ${color}15, transparent 70%)`,
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16, color }}>{icon}</span>
        <span style={{ fontSize: 11, color: '#888', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#666', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function IntensityBar({ value, color, label }) {
  const pct = Math.max(0, Math.min(100, (value || 0) * 100));
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888', marginBottom: 2 }}>
        <span>{label}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ height: 4, background: '#1a1a2e', borderRadius: 2 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

function ProofBadge({ name, passed, score }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
      background: passed ? '#0f2a1a' : '#2a1515', border: `1px solid ${passed ? '#1a4a2a' : '#4a2020'}`,
      borderRadius: 8, fontSize: 12,
    }}>
      <span style={{ color: passed ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{passed ? '✓' : '✗'}</span>
      <span style={{ color: '#e0e0e8', flex: 1 }}>{name}</span>
      {score != null && <span style={{ color: '#888', fontSize: 10 }}>{typeof score === 'number' ? score.toFixed(3) : score}</span>}
    </div>
  );
}

function NodeHealth({ node, status }) {
  const isUp = status === 'up' || status === 'healthy' || status === true;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
      background: '#0a0a14', borderRadius: 6, border: `1px solid ${isUp ? '#1a4a2a' : '#4a2020'}`,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: isUp ? '#22c55e' : '#ef4444',
        boxShadow: isUp ? '0 0 6px #22c55e60' : 'none',
      }} />
      <span style={{ fontSize: 12, color: '#e0e0e8', flex: 1 }}>{node}</span>
      <span style={{ fontSize: 10, color: isUp ? '#22c55e' : '#ef4444' }}>{isUp ? 'UP' : 'DOWN'}</span>
    </div>
  );
}

function SkillCard({ skill, status, category }) {
  const color = status === 'registered' ? '#22c55e' : '#f59e0b';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
      background: '#0a0a14', borderRadius: 6, border: '1px solid #1a1a2e',
    }}>
      <span style={{ fontSize: 12, color: COLORS.hermes }}>{HERMES_CATEGORY_ICONS[category] || '◇'}</span>
      <span style={{ fontSize: 12, color: '#e0e0e8', flex: 1 }}>{skill.replace(/_/g, ' ')}</span>
      <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: color + '20', color, fontWeight: 600 }}>
        {status === 'registered' ? 'LIVE' : 'NO EXEC'}
      </span>
    </div>
  );
}

export default function NerveCenterPanel({ wsEvent }) {
  const [tab, setTab] = useState('live');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [consciousnessResult, setConsciousnessResult] = useState(null);
  const [provingConsciousness, setProvingConsciousness] = useState(false);
  const [recentWsEvents, setRecentWsEvents] = useState([]);
  const [eventIdRef] = useState({ current: 0 });

  const INTEL_TYPES = new Set([
    'heart', 'dreamer', 'cognition', 'consciousness', 'intelligence',
    'needle', 'motor', 'ledger', 'autonomy', 'rsi', 'streaming', 'memory',
  ]);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/intelligence/live')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!wsEvent?.type) return;
    if (INTEL_TYPES.has(wsEvent.type)) {
      load();
      setRecentWsEvents(prev => [{
        type: wsEvent.type,
        payload: wsEvent.payload || {},
        _id: ++eventIdRef.current,
        _ts: Date.now(),
      }, ...prev].slice(0, 50));
    }
  }, [wsEvent, load, eventIdRef]);

  const runConsciousnessProof = async () => {
    setProvingConsciousness(true);
    try {
      const res = await fetch('/api/fraymus/consciousness/prove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeCount: 4 }),
      });
      const result = await res.json();
      setConsciousnessResult(result);
    } catch (e) {
      setConsciousnessResult({ error: e.message });
    } finally {
      setProvingConsciousness(false);
    }
  };

  const TABS = [
    { id: 'live', label: 'Live State', icon: '◈' },
    { id: 'hermes', label: 'Hermes Fleet', icon: '⚡' },
    { id: 'feed', label: 'Intel Feed', icon: '↔' },
  ];

  const timeAgo = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  return (
    <div style={{ padding: 20, color: '#e0e0e8' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #222', paddingBottom: 12 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? '#7c3aed22' : 'transparent',
            border: `1px solid ${tab === t.id ? '#7c3aed' : '#333'}`,
            borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
            color: tab === t.id ? '#a78bfa' : '#888', fontSize: 13, fontWeight: 500,
          }}>
            {t.icon} {t.label}
          </button>
        ))}
        <button onClick={load} style={{
          marginLeft: 'auto', background: 'none', border: '1px solid #333',
          borderRadius: 6, padding: '4px 10px', color: '#666', cursor: 'pointer', fontSize: 12,
        }}>
          ↻ Refresh
        </button>
      </div>

      {tab === 'live' && (
        <div>
          {loading && !data && <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Loading intelligence state...</div>}
          {data && (
            <>
              {/* Top stat row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 20 }}>
                <StatCard label="Heart Mood" value={data.heart?.mood || 'neutral'} sub={`intensity: ${((data.heart?.intensity || 0) * 100).toFixed(0)}%`} color={EMOTION_COLORS[data.heart?.primary] || COLORS.heart} icon="♥" />
                <StatCard label="Dreams" value={data.dreamer?.dreamCount || 0} sub={data.dreamer?.state?.mood || 'idle'} color={COLORS.dreamer} icon="◇" />
                <StatCard label="Cognition" value={data.cognition?.phase || 'idle'} sub={`${data.cognition?.modules?.length || 0} modules`} color={COLORS.cognition} icon="◆" />
                <StatCard label="Needle Queue" value={`${data.needle?.queue?.pending || 0} pending`} sub={`${data.needle?.queue?.running || 0} running · ${data.needle?.queue?.completed || 0} done`} color={COLORS.needle} icon="⊕" />
                <StatCard label="Motor" value={`${data.motor?.dispatchCount || 0} dispatches`} sub="4 nodes" color={COLORS.motor} icon="⚙" />
                <StatCard label="Ledger" value={`${data.ledger?.integrity?.checked || 0} events`} sub={data.ledger?.integrity?.valid ? 'chain valid' : 'integrity unknown'} color={COLORS.ledger} icon="⬡" />
                <StatCard label="Memory Bridge" value={data.memoryBridge?.available ? `${data.memoryBridge?.totalMemories || 0}` : 'offline'} sub={data.memoryBridge?.available ? 'memories stored' : ''} color={COLORS.memory} icon="⧉" />
                <StatCard label="Hermes Skills" value={`${data.hermes?.registered?.length || 0}/30`} sub={`${data.hermes?.history || 0} executions`} color={COLORS.hermes} icon="⚡" />
              </div>

              {/* Heart Emotional State */}
              <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.heart}20`, marginBottom: 16 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.heart, marginBottom: 12 }}>♥ Heart — Emotional State</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: EMOTION_COLORS[data.heart?.primary] || '#888', marginBottom: 4 }}>
                      {data.heart?.primary || 'neutral'}
                    </div>
                    <div style={{ fontSize: 12, color: '#888' }}>
                      Sarcasm: <span style={{ color: data.heart?.sarcasm ? '#f59e0b' : '#555' }}>{data.heart?.sarcasm ? 'detected' : 'none'}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                      Recent readings: {data.heart?.recentCount || 0}
                    </div>
                  </div>
                  <div>
                    {data.heart?.dimensions && Object.entries(data.heart.dimensions).map(([dim, val]) => (
                      <IntensityBar key={dim} label={dim} value={val} color={COLORS.heart} />
                    ))}
                    {!data.heart?.dimensions && <div style={{ color: '#555', fontSize: 12 }}>No dimensional data</div>}
                  </div>
                </div>
              </div>

              {/* Consciousness Proofs */}
              <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.consciousness}20`, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.consciousness, margin: 0 }}>◈ Consciousness Proofs</h4>
                  <button onClick={runConsciousnessProof} disabled={provingConsciousness} style={{
                    background: provingConsciousness ? '#333' : `${COLORS.consciousness}20`,
                    border: `1px solid ${COLORS.consciousness}40`, borderRadius: 6,
                    padding: '4px 12px', color: COLORS.consciousness, cursor: provingConsciousness ? 'wait' : 'pointer', fontSize: 12,
                  }}>
                    {provingConsciousness ? 'Proving...' : 'Run Proofs'}
                  </button>
                </div>
                {consciousnessResult && !consciousnessResult.error && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{
                        fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 4,
                        background: consciousnessResult.allPassed ? '#0f2a1a' : '#2a1515',
                        color: consciousnessResult.allPassed ? '#22c55e' : '#ef4444',
                      }}>
                        {consciousnessResult.allPassed ? 'ALL PASSED' : 'PARTIAL'}
                      </span>
                      <span style={{ fontSize: 11, color: '#888' }}>
                        {consciousnessResult.proofs?.filter(p => p.passed).length}/{consciousnessResult.proofs?.length} proofs · {consciousnessResult.nodeCount} nodes
                      </span>
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {(consciousnessResult.proofs || []).map((p, i) => (
                        <ProofBadge key={i} name={p.name || `Proof ${i + 1}`} passed={p.passed} score={p.phi || p.ei || p.fidelity || p.divergence} />
                      ))}
                    </div>
                  </div>
                )}
                {consciousnessResult?.error && <div style={{ color: '#ef4444', fontSize: 12 }}>Error: {consciousnessResult.error}</div>}
                {!consciousnessResult && <div style={{ color: '#555', fontSize: 12 }}>Click "Run Proofs" to execute 4 mathematical consciousness proofs (IIT Phi, Effective Information, Mirror Protocol, Counterfactual Branching)</div>}
              </div>

              {/* Dreamer + Cognition row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.dreamer}20` }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.dreamer, marginBottom: 10 }}>◇ Dreamer</h4>
                  <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.dreamer }}>{data.dreamer?.dreamCount || 0} dreams</div>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>{data.dreamer?.state?.mood || 'idle'}</div>
                  {(data.dreamer?.dreams || []).length > 0 && (
                    <div style={{ borderTop: '1px solid #222', paddingTop: 8 }}>
                      <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Recent dreams:</div>
                      {data.dreamer.dreams.map((d, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#aaa', padding: '3px 0', borderBottom: '1px solid #1a1a2e' }}>
                          #{d.number || i + 1} — {(d.seed || d.kind || 'unnamed').slice(0, 60)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.cognition}20` }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.cognition, marginBottom: 10 }}>◆ Cognition Pipeline</h4>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                    Pipeline: <span style={{ color: COLORS.cognition }}>feel → quick-route → think</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    {['feel', 'quick-route', 'think'].map(phase => (
                      <div key={phase} style={{
                        flex: 1, textAlign: 'center', padding: '6px 4px', borderRadius: 6,
                        background: data.cognition?.phase === phase ? `${COLORS.cognition}20` : '#0a0a14',
                        border: `1px solid ${data.cognition?.phase === phase ? COLORS.cognition : '#1a1a2e'}`,
                        fontSize: 11, color: data.cognition?.phase === phase ? COLORS.cognition : '#555',
                      }}>
                        {phase}
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#888' }}>
                    Modules: {(data.cognition?.modules || []).join(', ') || 'none loaded'}
                  </div>
                </div>
              </div>

              {/* Needle + Motor row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.needle}20` }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.needle, marginBottom: 10 }}>⊕ Needle GPU Queue</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div style={{ textAlign: 'center', padding: 8, background: '#0a0a14', borderRadius: 6 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>{data.needle?.queue?.pending || 0}</div>
                      <div style={{ fontSize: 10, color: '#888' }}>Pending</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: 8, background: '#0a0a14', borderRadius: 6 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#22c55e' }}>{data.needle?.queue?.running || 0}</div>
                      <div style={{ fontSize: 10, color: '#888' }}>Running</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: 8, background: '#0a0a14', borderRadius: 6 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.needle }}>{data.needle?.queue?.completed || 0}</div>
                      <div style={{ fontSize: 10, color: '#888' }}>Complete</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: 8, background: '#0a0a14', borderRadius: 6 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#ef4444' }}>{data.needle?.queue?.failed || 0}</div>
                      <div style={{ fontSize: 10, color: '#888' }}>Failed</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
                    Worker: <span style={{ color: data.needle?.worker?.running ? '#22c55e' : '#ef4444' }}>
                      {data.needle?.worker?.running ? 'active' : 'stopped'}
                    </span>
                    {data.needle?.worker?.jobsProcessed != null && ` · ${data.needle.worker.jobsProcessed} processed`}
                  </div>
                </div>

                <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.motor}20` }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.motor, marginBottom: 10 }}>⚙ Motor Dispatch</h4>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {(data.motor?.nodes || []).length > 0 ? (
                      data.motor.nodes.map((n, i) => (
                        <NodeHealth key={i} node={n.name || n.node || `Node ${i}`} status={n.status || n.healthy} />
                      ))
                    ) : (
                      ['WINDOWS_GPU', 'VPS_HOSTINGER', 'GITHUB', 'BASE44_CLOUD'].map(n => (
                        <NodeHealth key={n} node={n} status={false} />
                      ))
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
                    Total dispatches: {data.motor?.dispatchCount || 0}
                  </div>
                </div>
              </div>

              {/* Ledger + Memory Bridge row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.ledger}20` }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.ledger, marginBottom: 10 }}>⬡ Cognitive Ledger</h4>
                  <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.ledger, marginBottom: 4 }}>
                    {data.ledger?.integrity?.checked || 0} <span style={{ fontSize: 12, fontWeight: 400 }}>events</span>
                  </div>
                  <div style={{ fontSize: 11, color: data.ledger?.integrity?.valid ? '#22c55e' : '#f59e0b', marginBottom: 8 }}>
                    Chain integrity: {data.ledger?.integrity?.valid ? 'VALID' : 'unknown'}
                  </div>
                  {data.ledger?.counts && Object.keys(data.ledger.counts).length > 0 && (
                    <div>
                      <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>Events by kind:</div>
                      {Object.entries(data.ledger.counts).slice(0, 6).map(([kind, count]) => (
                        <div key={kind} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#aaa', padding: '2px 0' }}>
                          <span>{kind}</span><span style={{ color: COLORS.ledger }}>{count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ background: '#111118', borderRadius: 10, padding: 16, border: `1px solid ${COLORS.memory}20` }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: COLORS.memory, marginBottom: 10 }}>⧉ Memory Bridge</h4>
                  {data.memoryBridge?.available ? (
                    <>
                      <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.memory, marginBottom: 4 }}>
                        {data.memoryBridge.totalMemories || 0} <span style={{ fontSize: 12, fontWeight: 400 }}>memories</span>
                      </div>
                      <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                        Consolidations: {data.memoryBridge.totalConsolidations || 0}
                      </div>
                      {data.memoryBridge.byProvenance && Object.keys(data.memoryBridge.byProvenance).length > 0 && (
                        <div>
                          <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>By provenance:</div>
                          {Object.entries(data.memoryBridge.byProvenance).map(([prov, count]) => (
                            <div key={prov} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#aaa', padding: '2px 0' }}>
                              <span>{prov}</span><span style={{ color: COLORS.memory }}>{count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: '#555', fontSize: 12 }}>Memory Bridge offline</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'hermes' && (
        <div>
          {data?.hermes ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.hermes }}>
                  {data.hermes.registered?.length || 0}<span style={{ fontSize: 12, fontWeight: 400, color: '#888' }}>/30 skills live</span>
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {data.hermes.history || 0} total executions
                </div>
              </div>
              {data.hermes.skills && Object.entries(data.hermes.skills).map(([category, skills]) => (
                <div key={category} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 14, color: COLORS.hermes }}>{HERMES_CATEGORY_ICONS[category]}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8', textTransform: 'capitalize' }}>{category}</span>
                    <span style={{ fontSize: 10, color: '#666' }}>{skills.length} skills</span>
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {skills.map(skill => (
                      <SkillCard
                        key={skill}
                        skill={skill}
                        category={category}
                        status={data.hermes.registered?.includes(skill) ? 'registered' : 'missing'}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {data.hermes.history && Array.isArray(data.hermes.history) && data.hermes.history.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8', marginBottom: 10 }}>Recent Executions</h4>
                  {data.hermes.history.slice(0, 10).map((h, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                      background: '#0a0a14', borderRadius: 6, marginBottom: 4,
                      border: `1px solid ${h.status === 'completed' ? '#1a4a2a' : h.status === 'failed' ? '#4a2020' : '#1a1a2e'}`,
                    }}>
                      <span style={{ fontSize: 12, color: COLORS.hermes }}>{HERMES_CATEGORY_ICONS[h.category]}</span>
                      <span style={{ fontSize: 12, color: '#e0e0e8', flex: 1 }}>{h.skill}</span>
                      <span style={{ fontSize: 10, color: h.status === 'completed' ? '#22c55e' : '#ef4444' }}>{h.status}</span>
                      <span style={{ fontSize: 10, color: '#555' }}>{h.duration ? `${h.duration}ms` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Loading Hermes fleet data...</div>
          )}
        </div>
      )}

      {tab === 'feed' && (
        <div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
            Real-time intelligence events via WebSocket — {recentWsEvents.length} captured
          </div>
          {recentWsEvents.length === 0 && (
            <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>
              No intelligence events yet. Events appear when Heart, Dreamer, Cognition, Needle, Motor, or other intelligence subsystems fire.
            </div>
          )}
          {recentWsEvents.map(ev => {
            const color = COLORS[ev.type] || '#888';
            return (
              <div key={ev._id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
                borderBottom: '1px solid #1a1a2e',
                animation: 'slideIn 0.3s ease-out',
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: color,
                  marginTop: 5, flexShrink: 0, boxShadow: `0 0 6px ${color}40`,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color }}>{ev.type}</span>
                    <span style={{ fontSize: 10, color: '#555' }}>{timeAgo(ev._ts)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>
                    {JSON.stringify(ev.payload).slice(0, 200)}
                  </div>
                </div>
              </div>
            );
          })}
          <style>{`@keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        </div>
      )}
    </div>
  );
}
