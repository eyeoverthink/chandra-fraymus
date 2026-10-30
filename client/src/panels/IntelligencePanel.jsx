import React, { useState, useEffect, useCallback } from 'react';

const card = { background: '#111118', borderRadius: 10, padding: 16, border: '1px solid #222' };
const btn = (color = '#a78bfa') => ({
  padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
  background: color, color: '#fff', fontSize: 13, fontWeight: 600,
});
const badge = (bg) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11,
  fontWeight: 600, background: bg, color: '#fff',
});

const EMOTION_COLORS = {
  joy: '#f59e0b', sadness: '#3b82f6', anger: '#ef4444', fear: '#8b5cf6',
  surprise: '#06b6d4', love: '#ec4899', anxiety: '#f97316', neutral: '#6b7280',
};

function EmotionBar({ emotion, value, max = 1 }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ width: 70, fontSize: 11, color: '#999', textTransform: 'capitalize' }}>{emotion}</span>
      <div style={{ flex: 1, height: 8, background: '#1a1a2e', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: EMOTION_COLORS[emotion] || '#666', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ width: 32, fontSize: 11, color: '#666', textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

export default function IntelligencePanel({ wsEvent }) {
  const [heartResult, setHeartResult] = useState(null);
  const [mood, setMood] = useState(null);
  const [ledgerStats, setLedgerStats] = useState(null);
  const [dreamerState, setDreamerState] = useState(null);
  const [dreams, setDreams] = useState([]);
  const [proofs, setProofs] = useState(null);
  const [cognitionStatus, setCognitionStatus] = useState(null);
  const [feelText, setFeelText] = useState('');
  const [dreamSeed, setDreamSeed] = useState('');
  const [cognitionText, setCognitionText] = useState('');
  const [cognitionResult, setCognitionResult] = useState(null);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryResults, setMemoryResults] = useState(null);
  const [memoryStats, setMemoryStats] = useState(null);
  const [cycleText, setCycleText] = useState('');
  const [cycleResult, setCycleResult] = useState(null);
  const [loading, setLoading] = useState({});

  const load = useCallback(async () => {
    try {
      const [m, l, d, dl, c, ms] = await Promise.all([
        fetch('/api/fraymus/heart/mood').then(r => r.json()).catch(() => null),
        fetch('/api/fraymus/ledger/stats').then(r => r.json()).catch(() => null),
        fetch('/api/fraymus/dreamer/feel').then(r => r.json()).catch(() => null),
        fetch('/api/fraymus/dreamer/list?limit=10').then(r => r.json()).catch(() => null),
        fetch('/api/fraymus/cognition/status').then(r => r.json()).catch(() => null),
        fetch('/api/fraymus/memory/stats').then(r => r.json()).catch(() => null),
      ]);
      if (m) setMood(m);
      if (l) setLedgerStats(l);
      if (d) setDreamerState(d);
      if (dl?.dreams) setDreams(dl.dreams);
      if (c) setCognitionStatus(c);
      if (ms) setMemoryStats(ms);
    } catch (_) {}
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (['heart', 'ledger', 'dreamer', 'cognition', 'consciousness', 'intelligence'].includes(wsEvent?.channel)) load();
  }, [wsEvent, load]);

  const doFeel = async () => {
    if (!feelText.trim()) return;
    setLoading(l => ({ ...l, feel: true }));
    try {
      const r = await fetch('/api/fraymus/heart/feel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: feelText }),
      }).then(r => r.json());
      setHeartResult(r);
    } catch (_) {}
    setLoading(l => ({ ...l, feel: false }));
  };

  const doDream = async () => {
    if (!dreamSeed.trim()) return;
    setLoading(l => ({ ...l, dream: true }));
    try {
      await fetch('/api/fraymus/dreamer/dream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: dreamSeed, kind: 'spontaneous' }),
      }).then(r => r.json());
      setDreamSeed('');
      load();
    } catch (_) {}
    setLoading(l => ({ ...l, dream: false }));
  };

  const doConsolidate = async () => {
    setLoading(l => ({ ...l, consolidate: true }));
    try { await fetch('/api/fraymus/dreamer/consolidate', { method: 'POST' }); load(); } catch (_) {}
    setLoading(l => ({ ...l, consolidate: false }));
  };

  const doProofs = async () => {
    setLoading(l => ({ ...l, proofs: true }));
    try {
      const r = await fetch('/api/fraymus/consciousness/prove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeCount: 4 }),
      }).then(r => r.json());
      setProofs(r);
    } catch (_) {}
    setLoading(l => ({ ...l, proofs: false }));
  };

  const doCognition = async () => {
    if (!cognitionText.trim()) return;
    setLoading(l => ({ ...l, cognition: true }));
    try {
      const r = await fetch('/api/fraymus/cognition/process', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cognitionText, skipThink: true }),
      }).then(r => r.json());
      setCognitionResult(r);
    } catch (_) {}
    setLoading(l => ({ ...l, cognition: false }));
  };

  const doMemoryRecall = async () => {
    if (!memoryQuery.trim()) return;
    setLoading(l => ({ ...l, memory: true }));
    try {
      const r = await fetch('/api/fraymus/memory/recall', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: memoryQuery, limit: 10 }),
      }).then(r => r.json());
      setMemoryResults(r);
    } catch (_) {}
    setLoading(l => ({ ...l, memory: false }));
  };

  const doCycle = async () => {
    if (!cycleText.trim()) return;
    setLoading(l => ({ ...l, cycle: true }));
    try {
      const r = await fetch('/api/fraymus/intelligence/cycle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cycleText }),
      }).then(r => r.json());
      setCycleResult(r);
      load();
    } catch (_) {}
    setLoading(l => ({ ...l, cycle: false }));
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: '#a78bfa', marginBottom: 4 }}>Intelligence Stack</h2>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>Heart + Ledger + Dreamer + Cognition + Consciousness Proofs + Memory Bridge</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>

        {/* Heart — Emotion Analysis */}
        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#f59e0b', marginBottom: 12 }}>♥ Heart — Emotion Engine</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input value={feelText} onChange={e => setFeelText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doFeel()}
              placeholder="Type something to analyze..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0f', color: '#ddd', fontSize: 13 }}
            />
            <button onClick={doFeel} disabled={loading.feel} style={btn('#f59e0b')}>
              {loading.feel ? '...' : 'Feel'}
            </button>
          </div>
          {heartResult && heartResult.primary && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <span style={badge(EMOTION_COLORS[heartResult.primary] || '#666')}>{heartResult.primary}</span>
                <span style={badge('#333')}>intensity: {Math.round((heartResult.intensity || 0) * 100)}%</span>
                {heartResult.sarcasm && <span style={badge('#ef4444')}>sarcasm</span>}
              </div>
              {heartResult.normalized && Object.entries(heartResult.normalized).map(([e, v]) => (
                <EmotionBar key={e} emotion={e} value={v} />
              ))}
              {heartResult.quick && (
                <div style={{ marginTop: 8, padding: 10, background: '#1a1a2e', borderRadius: 6, fontSize: 12, color: '#aaa', lineHeight: 1.5 }}>
                  {heartResult.quick}
                </div>
              )}
            </div>
          )}
          {mood && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#888' }}>
              Recent mood: <span style={{ color: EMOTION_COLORS[mood.mood] || '#666' }}>{mood.mood}</span> ({mood.readings} readings)
            </div>
          )}
        </div>

        {/* Dreamer — Dream Protocol */}
        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#8b5cf6', marginBottom: 12 }}>☾ Dreamer — Dream Protocol</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input value={dreamSeed} onChange={e => setDreamSeed(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doDream()}
              placeholder="Dream seed..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0f', color: '#ddd', fontSize: 13 }}
            />
            <button onClick={doDream} disabled={loading.dream} style={btn('#8b5cf6')}>
              {loading.dream ? '...' : 'Dream'}
            </button>
          </div>
          <button onClick={doConsolidate} disabled={loading.consolidate}
            style={{ ...btn('#6d28d9'), marginBottom: 12, fontSize: 12, padding: '6px 12px' }}>
            {loading.consolidate ? '...' : 'Consolidate Dreams'}
          </button>
          {dreamerState && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <span style={badge('#8b5cf6')}>{dreamerState.state}</span>
              <span style={badge('#333')}>{dreamerState.dreamCount} dreams</span>
              <span style={badge('#333')}>score: {Math.round(dreamerState.score * 100)}%</span>
            </div>
          )}
          {dreams.length > 0 && (
            <div style={{ maxHeight: 140, overflow: 'auto', fontSize: 11, color: '#888' }}>
              {dreams.map((f, i) => <div key={i} style={{ padding: '2px 0', fontFamily: 'monospace' }}>{f}</div>)}
            </div>
          )}
        </div>

        {/* Ledger — Cognitive Audit Trail */}
        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#06b6d4', marginBottom: 12 }}>⛓ Ledger — Cognitive Events</h3>
          {ledgerStats ? (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <span style={badge(ledgerStats.integrity?.valid ? '#22c55e' : '#ef4444')}>
                  {ledgerStats.integrity?.valid ? 'Chain Valid' : 'Chain Broken'}
                </span>
                <span style={badge('#333')}>{ledgerStats.integrity?.checked || 0} checked</span>
              </div>
              {Object.entries(ledgerStats.counts || {}).map(([kind, count]) => (
                <div key={kind} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888', padding: '2px 0' }}>
                  <span style={{ fontFamily: 'monospace' }}>{kind}</span>
                  <span>{count}</span>
                </div>
              ))}
            </div>
          ) : <div style={{ color: '#666', fontSize: 12 }}>No events yet — events are recorded as you use the system.</div>}
        </div>

        {/* Consciousness Proofs */}
        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#ec4899', marginBottom: 12 }}>◈ Consciousness Proofs</h3>
          <button onClick={doProofs} disabled={loading.proofs} style={{ ...btn('#ec4899'), marginBottom: 12 }}>
            {loading.proofs ? 'Running...' : 'Run 4 Mathematical Proofs'}
          </button>
          {proofs && (
            <div>
              <div style={{ marginBottom: 8 }}>
                <span style={badge(proofs.allPassed ? '#22c55e' : '#ef4444')}>
                  {proofs.allPassed ? 'ALL PASSED — FraymusStrangeLoop' : 'SOME FAILED'}
                </span>
              </div>
              {proofs.proofs.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #1a1a2e' }}>
                  <span style={{ color: '#ddd', fontFamily: 'monospace' }}>{p.proof}</span>
                  <span style={badge(p.passed ? '#22c55e' : '#ef4444')}>{p.passed ? 'PASS' : 'FAIL'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Memory Bridge — Recall */}
        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#14b8a6', marginBottom: 12 }}>🌉 Memory Bridge — Recall</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input value={memoryQuery} onChange={e => setMemoryQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doMemoryRecall()}
              placeholder="Search intelligence memories..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0f', color: '#ddd', fontSize: 13 }}
            />
            <button onClick={doMemoryRecall} disabled={loading.memory} style={btn('#14b8a6')}>
              {loading.memory ? '...' : 'Recall'}
            </button>
          </div>
          {memoryStats?.available && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <span style={badge('#14b8a6')}>Bridge Active</span>
              {memoryStats.stored != null && <span style={badge('#333')}>{memoryStats.stored} stored</span>}
            </div>
          )}
          {memoryStats && !memoryStats.available && (
            <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>Memory Bridge unavailable — Vertiso not connected</div>
          )}
          {memoryResults && (
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {memoryResults.count === 0 && <div style={{ fontSize: 12, color: '#666' }}>No memories found for "{memoryQuery}"</div>}
              {(memoryResults.memories || []).map((m, i) => (
                <div key={i} style={{ padding: '6px 8px', marginBottom: 4, background: '#1a1a2e', borderRadius: 6, fontSize: 12 }}>
                  <div style={{ color: '#ddd', lineHeight: 1.4 }}>{(m.content || '').slice(0, 200)}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {m.provenance && <span style={badge('#14b8a6')}>{m.provenance}</span>}
                    {m.score != null && <span style={badge('#333')}>{(m.score * 100).toFixed(0)}% match</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Full Intelligence Cycle */}
        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#d946ef', marginBottom: 12 }}>🔮 Full Intelligence Cycle</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input value={cycleText} onChange={e => setCycleText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doCycle()}
              placeholder="Run full stack: feel → think → prove → dream..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0f', color: '#ddd', fontSize: 13 }}
            />
            <button onClick={doCycle} disabled={loading.cycle} style={btn('#d946ef')}>
              {loading.cycle ? '...' : 'Cycle'}
            </button>
          </div>
          {cycleResult && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ padding: 8, background: '#1a1a2e', borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>Heart</div>
                <span style={badge(EMOTION_COLORS[cycleResult.feeling?.primary] || '#666')}>
                  {cycleResult.feeling?.primary} ({Math.round((cycleResult.feeling?.intensity || 0) * 100)}%)
                </span>
              </div>
              <div style={{ padding: 8, background: '#1a1a2e', borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>Cognition</div>
                <span style={badge('#22c55e')}>{cycleResult.cognition?.phase}</span>
              </div>
              <div style={{ padding: 8, background: '#1a1a2e', borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>Consciousness</div>
                <span style={badge(cycleResult.consciousness?.allPassed ? '#22c55e' : '#ef4444')}>
                  {cycleResult.consciousness?.passed}/{cycleResult.consciousness?.total} passed
                </span>
              </div>
              <div style={{ padding: 8, background: '#1a1a2e', borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>Dream</div>
                <span style={badge('#8b5cf6')}>#{cycleResult.dream?.number}</span>
              </div>
              {cycleResult.storedToMemoryBridge && (
                <div style={{ gridColumn: 'span 2', fontSize: 11, color: '#14b8a6', textAlign: 'center' }}>
                  All results stored to Memory Bridge
                </div>
              )}
            </div>
          )}
        </div>

        {/* Cognition Pipeline */}
        <div style={{ ...card, gridColumn: 'span 2' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#22c55e', marginBottom: 12 }}>⚡ Cognition — Two-Speed Pipeline</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input value={cognitionText} onChange={e => setCognitionText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doCognition()}
              placeholder="Send through the cognition pipeline (feel → route → think)..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0f', color: '#ddd', fontSize: 13 }}
            />
            <button onClick={doCognition} disabled={loading.cognition} style={btn('#22c55e')}>
              {loading.cognition ? '...' : 'Process'}
            </button>
          </div>
          {cognitionResult && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ padding: 10, background: '#1a1a2e', borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Phase</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={badge(cognitionResult.quick ? '#f59e0b' : '#22c55e')}>{cognitionResult.phase}</span>
                  <span style={badge('#333')}>{cognitionResult.durationMs}ms</span>
                </div>
              </div>
              <div style={{ padding: 10, background: '#1a1a2e', borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Emotion Read</div>
                <span style={badge(EMOTION_COLORS[cognitionResult.feeling?.primary] || '#666')}>
                  {cognitionResult.feeling?.primary} ({Math.round((cognitionResult.feeling?.intensity || 0) * 100)}%)
                </span>
              </div>
              {cognitionResult.action && (
                <div style={{ padding: 10, background: '#1a1a2e', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Quick Route</div>
                  <span style={{ color: '#f59e0b', fontFamily: 'monospace', fontSize: 13 }}>{cognitionResult.action}</span>
                </div>
              )}
              {cognitionResult.keywords && (
                <div style={{ padding: 10, background: '#1a1a2e', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Keywords</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {cognitionResult.keywords.map((k, i) => <span key={i} style={badge('#333')}>{k}</span>)}
                  </div>
                </div>
              )}
            </div>
          )}
          {cognitionStatus && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#555' }}>
              Context: {cognitionStatus.contextLength || 0} turns · Modules: {cognitionStatus.modules ? Object.entries(cognitionStatus.modules).filter(([,v]) => v).map(([k]) => k).join(', ') : 'loading...'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
