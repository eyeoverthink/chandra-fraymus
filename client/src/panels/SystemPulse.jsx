import React, { useState, useEffect, useCallback } from 'react';

const S = {
  container: { padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  title: { fontSize: 16, fontWeight: 600, color: '#e0e0e8' },
  subtitle: { fontSize: 11, color: '#666', marginTop: 2 },
  refreshBtn: { padding: '4px 12px', border: '1px solid #333', borderRadius: 6, background: '#1a1a2e', color: '#888', cursor: 'pointer', fontSize: 11 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 20 },
  card: { background: '#12121f', border: '1px solid #222', borderRadius: 10, padding: 14, position: 'relative', overflow: 'hidden' },
  cardWide: { background: '#12121f', border: '1px solid #222', borderRadius: 10, padding: 14, marginBottom: 12 },
  cardLabel: { fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 },
  bigNum: { fontSize: 28, fontWeight: 700, lineHeight: 1 },
  medNum: { fontSize: 18, fontWeight: 600, lineHeight: 1 },
  unit: { fontSize: 11, color: '#666', marginTop: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  pill: { display: 'inline-block', fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 10, letterSpacing: 0.5 },
  eventRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 },
  sparkContainer: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 32, marginTop: 6 },
  sparkBar: { flex: 1, borderRadius: 2, minWidth: 4, transition: 'height 0.3s' },
  empty: { textAlign: 'center', padding: 40, color: '#555', fontSize: 13 },
  pulseRing: { position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: '50%' },
};

const COLORS = {
  fleet: '#a78bfa',
  bus: '#22d3ee',
  runs: '#ef4444',
  evolution: '#c084fc',
  vertiso: '#34d399',
  workflows: '#60a5fa',
  commerce: '#f472b6',
};

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatUptime(ms) {
  if (!ms) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

function Spark({ data = [], color = '#22d3ee' }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  return (
    <div style={S.sparkContainer}>
      {data.map((v, i) => (
        <div key={i} style={{ ...S.sparkBar, height: `${Math.max(4, (v / max) * 100)}%`, background: color, opacity: 0.4 + (i / data.length) * 0.6 }} />
      ))}
    </div>
  );
}

function PulseCard({ label, value, sub, color, accent, children }) {
  return (
    <div style={S.card}>
      <div style={{ ...S.pulseRing, background: color, boxShadow: `0 0 6px ${color}60` }} />
      <div style={S.cardLabel}>{label}</div>
      <div style={{ ...S.bigNum, color: accent || color }}>{value}</div>
      {sub && <div style={S.unit}>{sub}</div>}
      {children}
    </div>
  );
}

function StatRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
      <span style={{ fontSize: 12, color: '#888' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: color || '#e0e0e8' }}>{value}</span>
    </div>
  );
}

export default function SystemPulse({ wsEvent }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/system-pulse');
      const d = await r.json();
      setData(d);
      setLastRefresh(Date.now());
    } catch (e) { console.error('pulse:', e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (wsEvent) reload();
  }, [wsEvent, reload]);

  if (loading) return <div style={S.empty}>Scanning system pulse...</div>;
  if (!data) return <div style={S.empty}>System offline</div>;

  const { fleet, bus, runs, evolution, vertiso, workflows, entities, healthSparkline, recentEvents, commerce, uptime } = data;

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div>
          <div style={S.title}>System pulse</div>
          <div style={S.subtitle}>
            Uptime {formatUptime(uptime)} · {lastRefresh ? `refreshed ${relTime(lastRefresh)}` : ''}
          </div>
        </div>
        <button style={S.refreshBtn} onClick={reload}>Refresh</button>
      </div>

      {/* Top row: Fleet, Bus, Runs */}
      <div style={S.grid}>
        <PulseCard label="Agent fleet" value={fleet.agents} sub={`${fleet.forged} forged · ${fleet.memories} memories`} color={COLORS.fleet}>
          {fleet.recentForges?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {fleet.recentForges.map((f, i) => (
                <div key={i} style={{ fontSize: 10, color: '#888', padding: '2px 0' }}>
                  {f.goal?.slice(0, 30) || f.id} · {relTime(f.created_at)}
                </div>
              ))}
            </div>
          )}
        </PulseCard>

        <PulseCard label="Bus traffic" value={bus.total} sub={`${bus.hour}/hr · ${bus.today}/day`} color={COLORS.bus}>
          <div style={{ marginTop: 8 }}>
            <StatRow label="Topics" value={bus.topics} color={COLORS.bus} />
            <StatRow label="Subscriptions" value={bus.subscriptions} color={COLORS.bus} />
          </div>
        </PulseCard>

        <PulseCard label="Total runs" value={runs.total} sub={`${runs.today} today`} color={COLORS.runs}>
          {Object.entries(runs.byType || {}).map(([type, counts]) => (
            <StatRow key={type} label={type} value={`${counts.total} (${counts.today} today)`} />
          ))}
        </PulseCard>
      </div>

      {/* Second row: Evolution, Vertiso, Workflows */}
      <div style={S.grid}>
        <PulseCard label="Evolution" value={evolution.reflections + evolution.verifications + evolution.daemonCycles} sub="autonomous actions" color={COLORS.evolution}>
          <div style={{ marginTop: 8 }}>
            <StatRow label="Reflections" value={evolution.reflections} color={COLORS.evolution} />
            <StatRow label="Verifications" value={evolution.verifications} />
            <StatRow label="Daemon cycles" value={evolution.daemonCycles} />
            <StatRow label="Forged agents" value={evolution.forged} color={COLORS.fleet} />
            <StatRow label="Synthesized WFs" value={evolution.synthesized} color={COLORS.workflows} />
          </div>
        </PulseCard>

        <PulseCard label="Vertiso memory" value={vertiso.memories} sub={`${vertiso.rsiEvals} RSI evals`} color={COLORS.vertiso}>
          <div style={{ marginTop: 8 }}>
            <StatRow label="RSI generations" value={vertiso.rsiGens} color={COLORS.vertiso} />
          </div>
        </PulseCard>

        <PulseCard label="Workflows" value={workflows} sub={`${entities} FRAYMUS entities`} color={COLORS.workflows}>
          {healthSparkline?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>CPU sparkline</div>
              <Spark data={healthSparkline} color={COLORS.workflows} />
            </div>
          )}
        </PulseCard>
      </div>

      {/* Commerce pipelines */}
      {(Object.keys(commerce?.pipeline || {}).length > 0 || Object.keys(commerce?.apparel || {}).length > 0) && (
        <div style={S.cardWide}>
          <div style={S.cardLabel}>Commerce pipelines</div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {Object.entries(commerce.pipeline || {}).map(([status, count]) => (
              <div key={`p-${status}`} style={{ fontSize: 12 }}>
                <span style={{ color: COLORS.commerce, fontWeight: 600 }}>{count}</span>
                <span style={{ color: '#666', marginLeft: 4 }}>commerce {status}</span>
              </div>
            ))}
            {Object.entries(commerce.apparel || {}).map(([status, count]) => (
              <div key={`a-${status}`} style={{ fontSize: 12 }}>
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>{count}</span>
                <span style={{ color: '#666', marginLeft: 4 }}>apparel {status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent events */}
      {recentEvents?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>Recent events</div>
          <div style={S.card}>
            {recentEvents.map((ev, i) => (
              <div key={i} style={S.eventRow}>
                <div style={S.row}>
                  <span style={{ ...S.pill, background: '#22d3ee15', color: '#22d3ee', border: '1px solid #22d3ee30' }}>{ev.type}</span>
                  <span style={{ color: '#bbb' }}>{(ev.summary || '').slice(0, 60)}</span>
                </div>
                <span style={{ color: '#555', fontSize: 11, whiteSpace: 'nowrap' }}>{relTime(ev.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
