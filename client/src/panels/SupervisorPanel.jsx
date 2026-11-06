import React, { useState, useEffect, useCallback } from 'react';

const ACCENT = '#22c55e';
const BG = '#070d08';
const CARD = '#0d1a0f';
const BORDER = '#1a2e1d';
const MUTED = '#6b8a6e';
const WARN = '#eab308';
const CRIT = '#ef4444';

const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 14 };
const pill = (bg) => ({
  display: 'inline-block', padding: '2px 10px', borderRadius: 12,
  fontSize: 11, fontWeight: 600, background: bg + '22', color: bg, border: `1px solid ${bg}44`,
});
const btn = (bg = ACCENT) => ({
  background: bg + '22', border: `1px solid ${bg}44`, borderRadius: 6,
  padding: '6px 14px', color: bg, cursor: 'pointer', fontSize: 12, fontWeight: 600,
});

function StatCard({ label, value, unit, warn }) {
  return (
    <div style={{ ...card, textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: warn ? WARN : '#e0e8e2' }}>{value}</div>
      {unit && <div style={{ fontSize: 10, color: MUTED }}>{unit}</div>}
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function ProcessTab() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        fetch('/api/supervisor/process').then(r => r.json()),
        fetch('/api/supervisor/process/history?limit=20').then(r => r.json()),
      ]);
      setData(s);
      setHistory(h);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  if (err) return <div style={{ color: CRIT, padding: 16 }}>Error: {err}</div>;
  if (!data) return <div style={{ color: MUTED, padding: 16 }}>Loading...</div>;

  const c = data.current;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatCard label="Heap Used" value={c.heapUsedMb} unit="MB" warn={c.heapUsedMb > 400} />
        <StatCard label="RSS" value={c.rssMb} unit="MB" />
        <StatCard label="EL Lag p99" value={c.eventLoopLagP99} unit="ms" warn={c.eventLoopLagP99 > 100} />
        <StatCard label="Handles" value={c.activeHandles} warn={c.activeHandles > 300} />
        <StatCard label="Uptime" value={Math.floor(c.uptimeSeconds / 60)} unit="min" />
      </div>

      <div style={{ ...card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: MUTED }}>Heap Trend:</span>
        <span style={pill(c.heapTrend === 'growing' ? WARN : c.heapTrend === 'shrinking' ? '#3b82f6' : ACCENT)}>
          {c.heapTrend}
        </span>
        <span style={{ fontSize: 12, color: MUTED }}>Node:</span>
        <span style={{ fontSize: 12, color: '#e0e8e2' }}>{data.nodeVersion}</span>
        <span style={{ fontSize: 12, color: MUTED }}>PID:</span>
        <span style={{ fontSize: 12, color: '#e0e8e2' }}>{data.pid}</span>
        <span style={pill(data.running ? ACCENT : MUTED)}>{data.running ? 'Monitoring' : 'Stopped'}</span>
      </div>

      {data.recentSnapshots.length > 1 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Heap Trend (recent)</div>
          <svg viewBox="0 0 300 60" style={{ width: '100%', height: 60 }}>
            {(() => {
              const pts = data.recentSnapshots;
              const maxH = Math.max(...pts.map(p => p.heapUsedMb), 1);
              const step = 300 / Math.max(pts.length - 1, 1);
              const path = pts.map((p, i) => {
                const x = i * step;
                const y = 55 - (p.heapUsedMb / maxH) * 50;
                return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
              }).join(' ');
              return <path d={path} fill="none" stroke={ACCENT} strokeWidth="1.5" />;
            })()}
          </svg>
        </div>
      )}

      {history.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Stored Snapshots</div>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            {history.map(h => (
              <div key={h.id} style={{
                display: 'flex', gap: 12, padding: '4px 0', borderBottom: `1px solid ${BORDER}`,
                fontSize: 11, color: '#c0c8c2',
              }}>
                <span>{h.created_at}</span>
                <span>Heap: {h.heap_used_mb}MB</span>
                <span>EL p99: {h.event_loop_lag_p99}ms</span>
                <span style={pill(h.heap_trend === 'growing' ? WARN : ACCENT)}>{h.heap_trend}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HealerTab() {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        fetch('/api/supervisor/healer').then(r => r.json()),
        fetch('/api/supervisor/healer/history?limit=30').then(r => r.json()),
      ]);
      setStatus(s);
      setHistory(h);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const trigger = async () => {
    try {
      await fetch('/api/supervisor/healer/trigger', { method: 'POST' });
      load();
    } catch (e) { setErr(e.message); }
  };

  if (err) return <div style={{ color: CRIT, padding: 16 }}>Error: {err}</div>;
  if (!status) return <div style={{ color: MUTED, padding: 16 }}>Loading...</div>;

  const sevColor = s => s === 'critical' ? CRIT : s === 'warning' ? WARN : ACCENT;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={pill(status.running ? ACCENT : MUTED)}>{status.running ? 'Active' : 'Stopped'}</span>
        <span style={{ fontSize: 11, color: MUTED }}>
          EL threshold: {status.config.eventLoopLagThresholdMs}ms
        </span>
        <span style={{ fontSize: 11, color: MUTED }}>
          Heap limit: {status.config.maxHeapMb}MB
        </span>
        <button onClick={trigger} style={btn(WARN)}>Run Healing Check</button>
      </div>

      <div style={card}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Healing Events ({history.length})</div>
        {history.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 12 }}>No healing events yet — system healthy</div>
        ) : (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {history.map(h => (
              <div key={h.id} style={{
                padding: '8px 0', borderBottom: `1px solid ${BORDER}`,
                display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              }}>
                <span style={pill(sevColor(h.severity))}>{h.severity}</span>
                <span style={{ fontSize: 12, color: '#e0e8e2', fontWeight: 600 }}>{h.trigger_type}</span>
                <span style={{ fontSize: 11, color: MUTED }}>{h.action_taken}</span>
                {h.detail && <span style={{ fontSize: 10, color: MUTED }}>{h.detail}</span>}
                <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>{h.created_at}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OrchestratorTab() {
  const [checkResult, setCheckResult] = useState(null);
  const [probes, setProbes] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const loadProbes = useCallback(async () => {
    try {
      const [r, l, h] = await Promise.all([
        fetch('/api/supervisor/orchestrator/readiness').then(r => r.json()),
        fetch('/api/supervisor/orchestrator/liveness').then(r => r.json()),
        fetch('/api/supervisor/orchestrator/history?limit=10').then(r => r.json()),
      ]);
      setProbes({ readiness: r, liveness: l });
      setHistory(h);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { loadProbes(); const t = setInterval(loadProbes, 15000); return () => clearInterval(t); }, [loadProbes]);

  const runCheck = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/supervisor/orchestrator/check', { method: 'POST' });
      setCheckResult(await res.json());
      loadProbes();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  if (err) return <div style={{ color: CRIT, padding: 16 }}>Error: {err}</div>;

  const statusColor = s => s === 'healthy' ? ACCENT : s === 'degraded' ? WARN : CRIT;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {probes && (
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ ...card, flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: MUTED }}>Readiness</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: probes.readiness.ready ? ACCENT : CRIT }}>
              {probes.readiness.ready ? 'READY' : 'NOT READY'}
            </div>
          </div>
          <div style={{ ...card, flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: MUTED }}>Liveness</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: probes.liveness.alive ? ACCENT : CRIT }}>
              {probes.liveness.alive ? 'ALIVE' : 'STALLED'}
            </div>
            <div style={{ fontSize: 10, color: MUTED }}>EL lag: {probes.liveness.checks.eventLoopLagMs}ms</div>
          </div>
        </div>
      )}

      <div style={{ ...card, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={runCheck} disabled={loading} style={btn()}>
          {loading ? 'Checking...' : 'Run Full Health Check'}
        </button>
        {checkResult && (
          <span style={{ fontSize: 12, color: MUTED }}>
            {checkResult.passed}/{checkResult.checked} passed in {checkResult.durationMs}ms
          </span>
        )}
      </div>

      {checkResult && (
        <div style={card}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Subsystem Results</div>
          {checkResult.results.map(r => (
            <div key={r.id} style={{
              display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0',
              borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap',
            }}>
              <span style={pill(statusColor(r.status))}>{r.status}</span>
              <span style={{ fontSize: 12, color: '#e0e8e2', fontWeight: 600, minWidth: 120 }}>{r.name}</span>
              <span style={{ fontSize: 10, color: MUTED }}>{r.category}</span>
              <span style={{ fontSize: 10, color: MUTED }}>{r.durationMs}ms</span>
              {r.detail && Object.entries(r.detail).filter(([k]) => k !== 'ok').map(([k, v]) => (
                <span key={k} style={{ fontSize: 10, color: MUTED }}>{k}: {JSON.stringify(v)}</span>
              ))}
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Check History</div>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            {history.map(h => (
              <div key={h.id} style={{
                display: 'flex', gap: 12, padding: '4px 0', borderBottom: `1px solid ${BORDER}`,
                fontSize: 11, color: '#c0c8c2',
              }}>
                <span>{h.created_at}</span>
                <span style={{ color: h.subsystems_failed > 0 ? WARN : ACCENT }}>
                  {h.subsystems_passed}/{h.subsystems_checked} passed
                </span>
                <span>{h.duration_ms}ms</span>
                <span style={{ color: MUTED }}>{h.check_type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SupervisorPanel({ wsEvent }) {
  const [tab, setTab] = useState('process');

  const tabs = [
    { id: 'process', label: 'Process' },
    { id: 'healer', label: 'Healer' },
    { id: 'orchestrator', label: 'Orchestrator' },
  ];

  return (
    <div style={{ background: BG, minHeight: '100%', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
      }}>
        <span style={{ fontSize: 20 }}>🏥</span>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: ACCENT, margin: 0 }}>
          Process Supervisor
        </h2>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? ACCENT + '22' : 'transparent',
            border: `1px solid ${tab === t.id ? ACCENT + '44' : BORDER}`,
            borderRadius: 6, padding: '6px 16px', cursor: 'pointer',
            color: tab === t.id ? ACCENT : MUTED, fontSize: 12, fontWeight: 600,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'process' && <ProcessTab />}
      {tab === 'healer' && <HealerTab />}
      {tab === 'orchestrator' && <OrchestratorTab />}
    </div>
  );
}
