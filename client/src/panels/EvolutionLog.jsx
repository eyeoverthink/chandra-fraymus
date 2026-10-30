import { useState, useEffect, useCallback } from 'react';

const TYPE_META = {
  reflection:   { icon: '◎', color: '#a78bfa', label: 'Reflection' },
  verification: { icon: '⬡', color: '#38bdf8', label: 'Verification' },
  daemon:       { icon: '⟳', color: '#818cf8', label: 'Daemon' },
  forge:        { icon: '⚡', color: '#fb923c', label: 'Forge' },
  synthesis:    { icon: '✦', color: '#34d399', label: 'Synthesis' },
};

const STATUS_COLOR = {
  completed: '#34d399', running: '#38bdf8', failed: '#f87171',
};

function ago(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function TypeChip({ type }) {
  const m = TYPE_META[type] || { icon: '?', color: '#64748b', label: type };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: m.color + '22', color: m.color, border: `1px solid ${m.color}44`
    }}>{m.icon} {m.label}</span>
  );
}

function Pill({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 14px', borderRadius: 10, background: color + '15', border: `1px solid ${color}30`, minWidth: 55 }}>
      <span style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function EventCard({ event, onClick }) {
  const m = TYPE_META[event.type] || { icon: '?', color: '#64748b' };
  return (
    <button onClick={() => onClick(event)} style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
      padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8, cursor: 'pointer', textAlign: 'left', color: 'inherit', transition: 'background 0.15s'
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16, background: m.color + '22', border: `1px solid ${m.color}33`, flexShrink: 0, marginTop: 2
      }}>{m.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <TypeChip type={event.type} />
          {event.status && (
            <span style={{ fontSize: 11, color: STATUS_COLOR[event.status] || '#64748b', fontWeight: 600 }}>
              {event.status}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {event.summary || '(no summary)'}
        </div>
        {event.detail && (
          <div style={{ fontSize: 11, opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {event.detail}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, opacity: 0.4, whiteSpace: 'nowrap', flexShrink: 0, marginTop: 4 }}>
        {ago(event.timestamp)}
      </div>
    </button>
  );
}

function EventDetail({ event, onBack }) {
  const m = TYPE_META[event.type] || { icon: '?', color: '#64748b', label: event.type };
  const [steps, setSteps] = useState(null);

  useEffect(() => {
    if (event.type === 'verification' && event.id.startsWith('vloop-')) {
      const loopId = event.id.replace('vloop-', '');
      fetch(`/api/evolution-log/verification/${loopId}/steps`)
        .then(r => r.json()).then(d => setSteps(d.steps || [])).catch(() => {});
    }
  }, [event]);

  return (
    <div style={{ padding: 16 }}>
      <button onClick={onBack} style={{
        background: 'none', border: 'none', color: m.color, cursor: 'pointer', fontSize: 13, marginBottom: 12, padding: 0
      }}>← Back to log</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, background: m.color + '22', border: `2px solid ${m.color}44`
        }}>{m.icon}</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{m.label}</div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>{ago(event.timestamp)}{event.trigger ? ` · ${event.trigger}` : ''}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {event.status && <Pill label="Status" value={event.status} color={STATUS_COLOR[event.status] || '#64748b'} />}
        {event.duration_ms != null && <Pill label="Duration" value={`${(event.duration_ms / 1000).toFixed(1)}s`} color="#34d399" />}
        {event.language && <Pill label="Language" value={event.language} color="#38bdf8" />}
        {event.iterations != null && <Pill label="Iterations" value={`${event.iterations}/${event.maxIterations}`} color="#a78bfa" />}
        {event.nodeCount != null && <Pill label="Nodes" value={String(event.nodeCount)} color="#34d399" />}
        {event.agentId && <Pill label="Agent" value={event.agentId} color="#fb923c" />}
        {event.subtype && <Pill label="Cycle" value={event.subtype} color="#818cf8" />}
      </div>

      {event.summary && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Summary</div>
          <div style={{ padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
            {event.summary}
          </div>
        </div>
      )}

      {event.detail && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {event.type === 'reflection' ? 'Actions Taken' : 'Detail'}
          </div>
          <div style={{ padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {event.detail}
          </div>
        </div>
      )}

      {event.insights && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Insights</div>
          <div style={{ padding: 12, background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {event.insights}
          </div>
        </div>
      )}

      {event.error && (
        <div style={{ padding: 12, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, fontSize: 12, color: '#f87171', marginBottom: 12 }}>
          {event.error}
        </div>
      )}

      {steps && steps.length > 0 && (
        <div>
          <div style={{ fontSize: 11, opacity: 0.4, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Verification Steps</div>
          {steps.map((s, i) => (
            <div key={i} style={{
              padding: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 6, marginBottom: 6
            }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11 }}>
                <span style={{ fontWeight: 700, color: '#38bdf8' }}>Iter {s.iteration}</span>
                <span style={{ color: s.role === 'generator' ? '#fb923c' : s.role === 'verifier' ? '#a78bfa' : '#34d399', fontWeight: 600 }}>{s.role}</span>
                {s.verdict && <span style={{ color: s.verdict === 'pass' ? '#34d399' : '#f87171', fontWeight: 600 }}>{s.verdict}</span>}
              </div>
              {s.output && (
                <div style={{ fontSize: 11, opacity: 0.6, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto' }}>
                  {(s.output || '').slice(0, 300)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EvolutionLog() {
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (typeFilter) params.set('type', typeFilter);
    params.set('limit', '100');
    fetch(`/api/evolution-log?${params}`)
      .then(r => r.json())
      .then(d => { setEvents(d.events || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [typeFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/evolution-log/stats').then(r => r.json()).then(setStats).catch(() => {});
  }, []);

  if (selected) return <EventDetail event={selected} onBack={() => setSelected(null)} />;

  const types = Object.keys(TYPE_META);

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Evolution Log</h3>
        {stats && <span style={{ fontSize: 12, opacity: 0.4 }}>{stats.total} events</span>}
      </div>

      {stats && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {stats.reflections > 0 && <StatChip icon="◎" count={stats.reflections} color="#a78bfa" label="reflect" />}
          {stats.verifications > 0 && <StatChip icon="⬡" count={stats.verifications} color="#38bdf8" label="verify" />}
          {stats.daemon > 0 && <StatChip icon="⟳" count={stats.daemon} color="#818cf8" label="daemon" />}
          {stats.forged > 0 && <StatChip icon="⚡" count={stats.forged} color="#fb923c" label="forged" />}
          {stats.synthesized > 0 && <StatChip icon="✦" count={stats.synthesized} color="#34d399" label="synth" />}
          {stats.successRate > 0 && (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#34d39918', color: '#34d399', fontWeight: 600 }}>
              {stats.successRate}% verify
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6, padding: '4px 8px', color: 'inherit', fontSize: 12
        }}>
          <option value="">All Types</option>
          {types.map(t => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
        </select>
        <button onClick={load} style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6, padding: '4px 10px', color: 'inherit', fontSize: 12, cursor: 'pointer'
        }}>↻</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, opacity: 0.4 }}>Loading...</div>}
        {!loading && events.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.2 }}>◎</div>
            <div style={{ opacity: 0.4, fontSize: 13 }}>No evolution events yet</div>
            <div style={{ opacity: 0.3, fontSize: 11, marginTop: 4 }}>Reflections, verifications, daemon cycles, forged agents, and synthesized workflows will appear here</div>
          </div>
        )}
        {!loading && events.map(ev => <EventCard key={ev.id} event={ev} onClick={setSelected} />)}
      </div>
    </div>
  );
}

function StatChip({ icon, count, color, label }) {
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: color + '18', color, fontWeight: 600 }}>
      {icon} {count} {label}
    </span>
  );
}
