import React, { useState, useEffect, useCallback } from 'react';

const C = {
  bg: '#0a0a0f', card: '#111118', border: '#1e1e2a',
  text: '#e0e0e0', dim: '#666', accent: '#dc2626',
  green: '#10b981', red: '#ef4444', amber: '#f59e0b',
  teal: '#14b8a6', purple: '#a78bfa', blue: '#3b82f6',
};

function VerdictBadge({ verdict, confidence }) {
  const color = verdict === 'proponent' ? C.green : verdict === 'opponent' ? C.red : C.amber;
  return (
    <span style={{ background: color + '20', color, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
      {verdict?.toUpperCase() || 'PENDING'} {confidence != null ? `(${Math.round(confidence * 100)}%)` : ''}
    </span>
  );
}

function RoundCard({ title, side, data, color }) {
  if (!data) return null;
  return (
    <div style={{ background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 6 }}>{title} — {side}</div>
      {data.thesis && <div style={{ fontSize: 12, color: C.text, marginBottom: 6 }}>{data.thesis}</div>}
      {data.points && data.points.length > 0 && (
        <ul style={{ margin: '4px 0', paddingLeft: 16, fontSize: 11, color: C.dim }}>
          {data.points.map((p, i) => <li key={i} style={{ marginBottom: 2 }}>{p}</li>)}
        </ul>
      )}
      {data.weaknesses_found && data.weaknesses_found.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ fontSize: 10, color: C.red }}>Weaknesses found:</span>
          <ul style={{ margin: '2px 0', paddingLeft: 16, fontSize: 11, color: C.dim }}>
            {data.weaknesses_found.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {data.counters && data.counters.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ fontSize: 10, color: C.blue }}>Counters:</span>
          <ul style={{ margin: '2px 0', paddingLeft: 16, fontSize: 11, color: C.dim }}>
            {data.counters.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      {data.strengthened_position && <div style={{ fontSize: 11, color: C.text, marginTop: 4, fontStyle: 'italic' }}>{data.strengthened_position}</div>}
      {data.implications && <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>Implications: {data.implications}</div>}
    </div>
  );
}

function SynthesisCard({ synthesis }) {
  if (!synthesis) return null;
  const winColor = { proponent: C.green, opponent: C.red, draw: C.amber };
  return (
    <div style={{ background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, borderLeft: `3px solid ${C.purple}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.purple, marginBottom: 8 }}>Judge Synthesis</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {['logic_winner', 'evidence_winner', 'rebuttal_winner'].map(k => (
          <div key={k} style={{ fontSize: 11 }}>
            <span style={{ color: C.dim }}>{k.replace(/_/g, ' ')}:</span>{' '}
            <span style={{ color: winColor[synthesis[k]] || C.dim, fontWeight: 600 }}>{synthesis[k] || '—'}</span>
          </div>
        ))}
      </div>
      {synthesis.blind_spots && synthesis.blind_spots.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 10, color: C.amber }}>Blind spots:</span>
          <ul style={{ margin: '2px 0', paddingLeft: 16, fontSize: 11, color: C.dim }}>
            {synthesis.blind_spots.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}
      {synthesis.verdict_reasoning && <div style={{ fontSize: 11, color: C.text }}>{synthesis.verdict_reasoning}</div>}
      {synthesis.synthesis && <div style={{ fontSize: 11, color: C.dim, marginTop: 4, fontStyle: 'italic' }}>{synthesis.synthesis}</div>}
    </div>
  );
}

export default function DebatePanel({ wsEvent }) {
  const [debates, setDebates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [running, setRunning] = useState(false);
  const [topic, setTopic] = useState('');
  const [proposition, setProposition] = useState('');
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/debates?limit=30');
      const data = await res.json();
      setDebates(data.debates || []);
    } catch (e) { setError(e.message); }
  }, []);

  const loadDetail = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/debates/${id}`);
      const data = await res.json();
      setDetail(data);
      setSelected(id);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (wsEvent?.type === 'system.debate') loadList();
  }, [wsEvent, loadList]);

  const startDebate = async () => {
    if (!topic.trim() || !proposition.trim()) return;
    setRunning(true);
    setError('');
    try {
      const res = await fetch('/api/debates/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic.trim(), proposition: proposition.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDetail(data);
      setSelected(data.id);
      setTopic('');
      setProposition('');
      loadList();
    } catch (e) { setError(e.message); }
    setRunning(false);
  };

  return (
    <div style={{ padding: '16px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: C.text, maxHeight: '100%', overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Debate Protocol</h2>
      <p style={{ fontSize: 11, color: C.dim, margin: '0 0 16px' }}>Adversarial multi-agent reasoning: proponent vs opponent, judged across 3 rounds</p>

      {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.accent, marginBottom: 8 }}>Start New Debate</div>
        <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="Topic (e.g. AI Alignment)"
          style={{ width: '100%', background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', color: C.text, fontSize: 12, marginBottom: 6, boxSizing: 'border-box' }} />
        <input value={proposition} onChange={e => setProposition(e.target.value)} placeholder="Proposition to debate (e.g. AGI will be beneficial for humanity)"
          style={{ width: '100%', background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', color: C.text, fontSize: 12, marginBottom: 8, boxSizing: 'border-box' }} />
        <button onClick={startDebate} disabled={running || !topic.trim() || !proposition.trim()} style={{
          background: running ? C.dim : C.accent, color: '#fff', border: 'none', borderRadius: 6,
          padding: '6px 16px', fontSize: 12, cursor: running ? 'default' : 'pointer', fontWeight: 600,
        }}>{running ? 'Debating...' : 'Start Debate'}</button>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: '0 0 260px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.dim, marginBottom: 8 }}>Past Debates ({debates.length})</div>
          {debates.map(d => (
            <div key={d.id} onClick={() => loadDetail(d.id)} style={{
              background: selected === d.id ? C.accent + '15' : C.card, border: `1px solid ${selected === d.id ? C.accent + '40' : C.border}`,
              borderRadius: 8, padding: '8px 12px', marginBottom: 6, cursor: 'pointer', transition: 'all 0.15s',
            }}>
              <div style={{ fontSize: 12, color: C.text, fontWeight: 500, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.topic}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <VerdictBadge verdict={d.verdict} confidence={d.confidence} />
                <span style={{ fontSize: 10, color: C.dim }}>{d.duration_ms ? `${(d.duration_ms / 1000).toFixed(1)}s` : '...'}</span>
              </div>
            </div>
          ))}
          {debates.length === 0 && <div style={{ color: C.dim, fontSize: 11 }}>No debates yet</div>}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {detail && detail.rounds ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{detail.topic}</div>
                  <div style={{ fontSize: 11, color: C.dim, fontStyle: 'italic' }}>"{detail.proposition}"</div>
                </div>
                <VerdictBadge verdict={detail.verdict} confidence={detail.confidence} />
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 10, color: C.dim }}>
                <span>Proponent: <span style={{ color: C.green }}>{detail.proponent_agent || detail.agents?.proponent}</span></span>
                <span>Opponent: <span style={{ color: C.red }}>{detail.opponent_agent || detail.agents?.opponent}</span></span>
                <span>Judge: <span style={{ color: C.purple }}>{detail.judge_agent || detail.agents?.judge}</span></span>
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: C.dim, marginTop: 4 }}>Round 1: Opening Arguments</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <RoundCard title="Opening" side="Proponent" data={detail.rounds.opening?.proponent} color={C.green} />
                <RoundCard title="Opening" side="Opponent" data={detail.rounds.opening?.opponent} color={C.red} />
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: C.dim }}>Round 2: Rebuttals</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <RoundCard title="Rebuttal" side="Proponent" data={detail.rounds.rebuttal?.proponent} color={C.green} />
                <RoundCard title="Rebuttal" side="Opponent" data={detail.rounds.rebuttal?.opponent} color={C.red} />
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: C.dim }}>Round 3: Synthesis & Verdict</div>
              <SynthesisCard synthesis={detail.rounds.synthesis} />
            </div>
          ) : (
            <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', padding: 40 }}>Select a debate to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
