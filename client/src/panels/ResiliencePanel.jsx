import React, { useState, useEffect, useCallback } from 'react';

const ACCENT = '#f59e0b';
const BG = '#0a1419';
const BORDER = '#1a2e33';
const GREEN = '#22c55e';
const RED = '#ef4444';

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 16px', flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || ACCENT }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function CircuitCard({ name, circuit }) {
  const stateColor = circuit.state === 'closed' ? GREEN : circuit.state === 'open' ? RED : ACCENT;
  return (
    <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor, flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8' }}>{name}</span>
        </div>
        <span style={{ fontSize: 11, color: stateColor, textTransform: 'uppercase', fontWeight: 600 }}>{circuit.state}</span>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888' }}>
        <span>Calls: {circuit.totalCalls}</span>
        <span style={{ color: GREEN }}>OK: {circuit.totalSuccesses}</span>
        <span style={{ color: circuit.totalFailures > 0 ? RED : '#888' }}>Fail: {circuit.totalFailures}</span>
        {circuit.msUntilRetry > 0 && <span style={{ color: ACCENT }}>Retry in {Math.ceil(circuit.msUntilRetry / 1000)}s</span>}
      </div>
    </div>
  );
}

function BackupRow({ backup }) {
  const date = new Date(backup.created).toLocaleString();
  const sizeMB = (backup.size / 1048576).toFixed(1);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: `1px solid ${BORDER}` }}>
      <span style={{ fontSize: 13, color: '#e0e0e8', flex: 1 }}>{backup.filename}</span>
      <span style={{ fontSize: 11, color: '#888' }}>{sizeMB}MB</span>
      <span style={{ fontSize: 11, color: '#666' }}>{date}</span>
    </div>
  );
}

function RecoveryEvent({ action }) {
  const date = new Date(action.created_at).toLocaleString();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: `1px solid ${BORDER}` }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: action.success ? GREEN : RED, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: '#e0e0e8' }}>{action.subsystem} — {action.action}</div>
        <div style={{ fontSize: 11, color: '#666' }}>{action.trigger_rule}{action.detail ? `: ${action.detail.slice(0, 80)}` : ''}</div>
      </div>
      <span style={{ fontSize: 10, color: '#555' }}>{date}</span>
    </div>
  );
}

export default function ResiliencePanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [backups, setBackups] = useState(null);
  const [circuits, setCircuits] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/resilience/dashboard').then(r => r.json()).catch(() => null),
      fetch('/api/resilience/backups').then(r => r.json()).catch(() => null),
      fetch('/api/resilience/circuits').then(r => r.json()).catch(() => ({ circuits: {}, recentEvents: [] })),
      fetch('/api/resilience/recovery').then(r => r.json()).catch(() => null),
    ]).then(([d, b, c, r]) => {
      setDashboard(d);
      setBackups(b);
      setCircuits(c);
      setRecovery(r);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (wsEvent?.type === 'health') load(); }, [wsEvent, load]);

  const triggerBackup = () => {
    setBackingUp(true);
    fetch('/api/resilience/backups', { method: 'POST' }).then(() => { setBackingUp(false); load(); }).catch(() => setBackingUp(false));
  };
  const resetCircuit = (service) => fetch(`/api/resilience/circuits/${service}/reset`, { method: 'POST' }).then(load);
  const runCheck = () => fetch('/api/resilience/recovery/check', { method: 'POST' }).then(load);
  const startMonitor = () => fetch('/api/resilience/recovery/start', { method: 'POST' }).then(load);
  const stopMonitor = () => fetch('/api/resilience/recovery/stop', { method: 'POST' }).then(load);

  if (loading) return <div style={{ padding: 20, color: '#888' }}>Loading resilience data...</div>;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'circuits', label: 'Circuits' },
    { id: 'backups', label: 'Backups' },
    { id: 'recovery', label: 'Recovery' },
  ];

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? ACCENT + '22' : '#111', border: `1px solid ${tab === t.id ? ACCENT : '#333'}`,
            borderRadius: 8, padding: '6px 14px', color: tab === t.id ? ACCENT : '#888', cursor: 'pointer', fontSize: 12, fontWeight: 500,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && dashboard && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="System Status" value={dashboard.status === 'healthy' ? 'Healthy' : 'Degraded'}
              color={dashboard.status === 'healthy' ? GREEN : RED} />
            <StatCard label="Open Circuits" value={dashboard.circuits.open}
              color={dashboard.circuits.open > 0 ? RED : GREEN} sub={`of ${dashboard.circuits.total} total`} />
            <StatCard label="Backups" value={dashboard.backups.count} sub={`${dashboard.backups.totalSizeMB}MB total`} />
            <StatCard label="Recovery Rate" value={`${dashboard.recovery.successRate}%`}
              color={dashboard.recovery.successRate >= 80 ? GREEN : ACCENT} sub={`${dashboard.recovery.totalActions} actions`} />
          </div>

          {dashboard.backups.latest && (
            <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Latest Backup</div>
              <div style={{ fontSize: 13, color: '#e0e0e8' }}>{dashboard.backups.latest.filename}</div>
              <div style={{ fontSize: 11, color: '#666' }}>{(dashboard.backups.latest.size / 1048576).toFixed(1)}MB — {new Date(dashboard.backups.latest.created).toLocaleString()}</div>
            </div>
          )}

          <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Recovery Monitor</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dashboard.recovery.monitorActive ? GREEN : '#555' }} />
              <span style={{ fontSize: 13, color: '#e0e0e8' }}>{dashboard.recovery.monitorActive ? 'Active' : 'Stopped'}</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'circuits' && circuits && (
        <div>
          {Object.keys(circuits.circuits).length > 0 ? (
            Object.entries(circuits.circuits).map(([name, c]) => (
              <div key={name}>
                <CircuitCard name={name} circuit={c} />
                {c.state !== 'closed' && (
                  <button onClick={() => resetCircuit(name)} style={{
                    marginBottom: 12, background: '#111', border: '1px solid #333', borderRadius: 6,
                    padding: '4px 10px', color: '#888', cursor: 'pointer', fontSize: 11,
                  }}>Reset {name}</button>
                )}
              </div>
            ))
          ) : <div style={{ color: '#555', fontSize: 12 }}>No circuit breakers registered yet. They appear as external services are called.</div>}

          {(circuits.recentEvents || []).length > 0 && (
            <>
              <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '16px 0 8px' }}>Recent State Changes</h4>
              <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
                {circuits.recentEvents.slice(0, 10).map((e, i) => (
                  <div key={i} style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, fontSize: 12, color: '#aaa' }}>
                    <span style={{ color: '#e0e0e8' }}>{e.service}</span> — {e.from_state} → <span style={{ color: e.to_state === 'open' ? RED : e.to_state === 'closed' ? GREEN : ACCENT }}>{e.to_state}</span>
                    <span style={{ fontSize: 10, color: '#555', marginLeft: 8 }}>{new Date(e.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'backups' && backups && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Total Backups" value={backups.backupCount} sub={`max ${backups.maxBackups}`} />
            <StatCard label="Total Size" value={`${backups.totalSizeMB}MB`} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={triggerBackup} disabled={backingUp} style={{
              background: ACCENT + '22', border: `1px solid ${ACCENT}`, borderRadius: 6,
              padding: '6px 14px', color: ACCENT, cursor: backingUp ? 'wait' : 'pointer', fontSize: 12, fontWeight: 500,
              opacity: backingUp ? 0.5 : 1,
            }}>{backingUp ? 'Backing up...' : 'Backup Now'}</button>
          </div>

          {(backups.history || []).length > 0 && (
            <>
              <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 8px' }}>Backup History</h4>
              <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
                {backups.history.map((h, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: `1px solid ${BORDER}` }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: h.status === 'completed' ? GREEN : RED, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: '#e0e0e8', flex: 1 }}>{h.filename}</span>
                    <span style={{ fontSize: 11, color: '#888' }}>{(h.size_bytes / 1048576).toFixed(1)}MB</span>
                    <span style={{ fontSize: 11, color: '#666' }}>{h.duration_ms}ms</span>
                    <span style={{ fontSize: 10, color: '#555' }}>{h.trigger}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'recovery' && recovery && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Total Actions" value={recovery.totalActions} />
            <StatCard label="Success Rate" value={`${recovery.successRate}%`}
              color={recovery.successRate >= 80 ? GREEN : ACCENT} />
            <StatCard label="Monitor" value={recovery.monitorActive ? 'Active' : 'Stopped'}
              color={recovery.monitorActive ? GREEN : '#888'} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={runCheck} style={{
              background: '#111', border: '1px solid #333', borderRadius: 6,
              padding: '6px 14px', color: '#888', cursor: 'pointer', fontSize: 12,
            }}>Run Check Now</button>
            {recovery.monitorActive ? (
              <button onClick={stopMonitor} style={{
                background: '#1a0a0a', border: '1px solid #331111', borderRadius: 6,
                padding: '6px 14px', color: RED, cursor: 'pointer', fontSize: 12,
              }}>Stop Monitor</button>
            ) : (
              <button onClick={startMonitor} style={{
                background: ACCENT + '22', border: `1px solid ${ACCENT}`, borderRadius: 6,
                padding: '6px 14px', color: ACCENT, cursor: 'pointer', fontSize: 12, fontWeight: 500,
              }}>Start Monitor</button>
            )}
          </div>

          {(recovery.recentActions || []).length > 0 ? (
            <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
              {recovery.recentActions.map((a, i) => <RecoveryEvent key={i} action={a} />)}
            </div>
          ) : <div style={{ color: '#555', fontSize: 12 }}>No recovery actions taken yet.</div>}
        </div>
      )}
    </div>
  );
}
