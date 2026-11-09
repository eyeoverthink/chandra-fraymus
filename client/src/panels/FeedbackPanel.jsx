import { useState, useEffect, useCallback } from 'react';

// Outcome Feedback — the human half of credit assignment. Every finished goal execution
// shows the objective, the agent, the machine's quality and critique, and the reply.
// 👍 / 👎 blends a human score into goal_executions.quality (HUMAN_FEEDBACK_WEIGHT, default
// 0.65), which then drives agent selection weights, retirement, goal utility and reality
// fitness — the same path every machine score already takes.

const C = { card: '#111118', border: '#1e1e2a', dim: '#666', text: '#e0e0e0', green: '#10b981', red: '#ef4444', amber: '#f59e0b', blue: '#3b82f6', purple: '#a78bfa' };

function ago(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function qColor(q) { return q == null ? C.dim : q >= 0.6 ? C.green : q >= 0.35 ? C.amber : C.red; }

function Stat({ label, value, color }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', textAlign: 'center', flex: 1, minWidth: 90 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || C.text }}>{value}</div>
      <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function PendingCard({ item, onRate, busy }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{item.objective || item.goal_id}</div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ color: C.purple }}>{item.agent_id}</span>
            <span>{item.status}</span>
            <span>{ago(item.finished_at)}</span>
            <span>{Math.round((item.duration_ms || 0) / 1000)}s</span>
            <span style={{ color: qColor(item.quality) }}>machine quality {item.quality == null ? '—' : item.quality.toFixed(2)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button disabled={busy} onClick={() => onRate(item.exec_id, 1, note)} title="Useful — raises this agent's weight" style={btn(C.green)}>👍</button>
          <button disabled={busy} onClick={() => onRate(item.exec_id, -1, note)} title="Not useful — lowers this agent's weight" style={btn(C.red)}>👎</button>
        </div>
      </div>
      {item.critique && <div style={{ fontSize: 11, color: C.amber, fontStyle: 'italic' }}>Judge: {item.critique}</div>}
      <button onClick={() => setOpen(o => !o)} style={{ ...btn(C.dim), alignSelf: 'flex-start', padding: '2px 8px', fontSize: 11 }}>{open ? 'hide reply' : 'show reply'}</button>
      {open && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: C.text, background: '#0a0a0f', border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, maxHeight: 220, overflow: 'auto', margin: 0 }}>{item.reply_excerpt || '(no reply recorded)'}</pre>}
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional note — the agent will see it in its memory"
        style={{ background: '#0a0a0f', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', color: C.text, fontSize: 12 }} />
    </div>
  );
}

function btn(color) {
  return { background: color + '22', color, border: `1px solid ${color}55`, borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 14 };
}

export default function FeedbackPanel({ wsEvent }) {
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([fetch('/api/goal-executor/feedback/pending?limit=40'), fetch('/api/goal-executor/feedback?limit=50')]);
      const pj = await p.json(); const hj = await h.json();
      setPending(pj.pending || []); setHistory(hj.feedback || []); setStats(hj.stats || null); setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (wsEvent?.type === 'system.goal' || wsEvent?.type === 'goal') load(); }, [wsEvent, load]);

  const undo = async (id) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/goal-executor/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setFlash(`undone — quality back to ${j.qualityNow == null ? '—' : j.qualityNow.toFixed(2)}`);
      setTimeout(() => setFlash(''), 4000);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const rate = async (execId, rating, note) => {
    setBusy(true);
    try {
      const res = await fetch('/api/goal-executor/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ execId, rating, note }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setFlash(`${rating > 0 ? '👍' : '👎'} ${j.agentId}: quality ${j.qualityBefore == null ? '—' : j.qualityBefore.toFixed(2)} → ${j.qualityAfter.toFixed(2)}`);
      setTimeout(() => setFlash(''), 4000);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: C.text }}>
      <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
        Your vote outweighs the judge ({stats ? Math.round(stats.humanWeight * 100) : 65}%). It changes the execution's quality, which changes which agent gets the next goal, who gets retired, and which goals are worth running.
      </div>
      {stats && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Stat label="awaiting review (7d)" value={stats.pendingReview7d} color={C.blue} />
          <Stat label="rated (30d)" value={stats.total} />
          <Stat label="👍" value={stats.up} color={C.green} />
          <Stat label="👎" value={stats.down} color={C.red} />
          <Stat label="judge agreed with you" value={stats.machineAgreement == null ? '—' : `${Math.round(stats.machineAgreement * 100)}%`} color={C.amber} />
        </div>
      )}
      {flash && <div style={{ fontSize: 12, color: C.green }}>{flash}</div>}
      {error && <div style={{ fontSize: 12, color: C.red }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        {['pending', 'history'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...btn(tab === t ? C.purple : C.dim), fontSize: 12, padding: '4px 12px' }}>{t === 'pending' ? `To review (${pending.length})` : `Rated (${history.length})`}</button>
        ))}
        <button onClick={load} style={{ ...btn(C.dim), fontSize: 12, padding: '4px 12px', marginLeft: 'auto' }}>refresh</button>
      </div>
      {tab === 'pending' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pending.length === 0 && <div style={{ fontSize: 12, color: C.dim }}>Nothing awaiting review — every finished execution in the last 7 days has a rating.</div>}
          {pending.map(item => <PendingCard key={item.exec_id} item={item} onRate={rate} busy={busy} />)}
        </div>
      )}
      {tab === 'history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {history.length === 0 && <div style={{ fontSize: 12, color: C.dim }}>No ratings yet.</div>}
          {history.map(f => (
            <div key={f.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 16 }}>{f.rating > 0 ? '👍' : '👎'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.objective || f.goal_id}</div>
                <div style={{ color: C.dim, fontSize: 11 }}>
                  <span style={{ color: C.purple }}>{f.agent_id}</span> · {f.quality_before == null ? '—' : f.quality_before.toFixed(2)} → <span style={{ color: qColor(f.quality_after) }}>{f.quality_after?.toFixed(2)}</span> · {ago(f.created_at)}{f.note ? ` · “${f.note}”` : ''}
                </div>
              </div>
              <button disabled={busy} onClick={() => undo(f.id)} title="Undo this vote" style={{ ...btn(C.dim), fontSize: 11, padding: '2px 8px' }}>undo</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
