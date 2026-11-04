import React, { useState, useEffect, useCallback } from 'react';

const SectionHeader = ({ title, color, icon }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
    <span style={{ fontSize: 18 }}>{icon}</span>
    <h4 style={{ fontSize: 14, fontWeight: 600, color, margin: 0 }}>{title}</h4>
  </div>
);

const StatCard = ({ label, value, color, sub }) => (
  <div style={{
    background: '#111118', border: '1px solid #222', borderRadius: 8,
    padding: '12px 16px', flex: '1 1 120px', minWidth: 120,
  }}>
    <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e0e0e8' }}>{value}</div>
    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{label}</div>
    {sub && <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>{sub}</div>}
  </div>
);

const VerdictBadge = ({ verdict }) => {
  const colors = { OK: '#10b981', PASS: '#10b981', DRIFT: '#f59e0b', UNKNOWN: '#f87171', REJECT: '#ef4444' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
      background: (colors[verdict] || '#555') + '22',
      color: colors[verdict] || '#888',
      border: `1px solid ${colors[verdict] || '#333'}`,
    }}>{verdict}</span>
  );
};

const EventRow = ({ event, fields }) => (
  <div style={{
    display: 'flex', gap: 8, padding: '6px 0',
    borderBottom: '1px solid #1a1a2e', fontSize: 12, alignItems: 'center',
  }}>
    {fields.map((f, i) => (
      <span key={i} style={{ color: f.color || '#888', flex: f.flex || 'none', minWidth: f.minWidth || 'auto' }}>
        {f.render ? f.render(event) : event[f.key] || '—'}
      </span>
    ))}
  </div>
);

export default function IntegrityPanel() {
  const [tab, setTab] = useState('overview');
  const [governance, setGovernance] = useState(null);
  const [harnessStats, setHarnessStats] = useState(null);
  const [watchdogStatus, setWatchdogStatus] = useState(null);
  const [selftestResult, setSelftestResult] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [govRes, harnRes, wdRes] = await Promise.all([
        fetch('/api/integrity/governance').then(r => r.json()).catch(() => null),
        fetch('/api/harness/stats').then(r => r.json()).catch(() => null),
        fetch('/api/integrity/status').then(r => r.json()).catch(() => null),
      ]);
      setGovernance(govRes);
      setHarnessStats(harnRes);
      setWatchdogStatus(wdRes);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 15000); return () => clearInterval(iv); }, [refresh]);

  const runSelftest = async () => {
    setSelftestResult(null);
    try {
      const res = await fetch('/api/integrity/selftest/all', { method: 'POST' });
      setSelftestResult(await res.json());
    } catch (e) { setSelftestResult({ error: e.message }); }
  };

  const TABS = [
    { id: 'overview', label: 'Overview', icon: '◈' },
    { id: 'guard', label: 'Guard', icon: '🛡' },
    { id: 'writ', label: 'Writs', icon: '📜' },
    { id: 'clock', label: 'Clock', icon: '⏱' },
    { id: 'harness', label: 'Harness', icon: '⚡' },
    { id: 'watchdog', label: 'Watchdog', icon: '👁' },
  ];

  if (loading) return <div style={{ padding: 20, color: '#555' }}>Loading integrity status...</div>;

  return (
    <div style={{ padding: 20, color: '#e0e0e8' }}>
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 14px', border: 'none', borderRadius: 6, cursor: 'pointer',
            fontSize: 12, fontWeight: tab === t.id ? 600 : 400,
            background: tab === t.id ? '#dc262622' : '#111118',
            color: tab === t.id ? '#ef4444' : '#888',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{ fontSize: 12 }}>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div>
          <SectionHeader title="System Integrity" color="#ef4444" icon="🔒" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Guard Status" value={governance?.guard?.enabled ? 'ACTIVE' : 'OFF'} color={governance?.guard?.enabled ? '#10b981' : '#f87171'} />
            <StatCard label="Writ System" value={governance?.writ?.enabled ? 'ACTIVE' : 'OFF'} color={governance?.writ?.enabled ? '#10b981' : '#f87171'} />
            <StatCard label="Clock Verdict" value={governance?.clock?.verdict?.verdict || 'UNKNOWN'} color={governance?.clock?.trusted ? '#10b981' : '#f59e0b'} />
            <StatCard label="Harness Evidence" value={harnessStats?.evidence_count || 0} color="#a78bfa" />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Guard Rejections" value={governance?.guard?.stats?.rejected || 0} color="#ef4444" sub={`${governance?.guard?.stats?.pass_rate || 100}% pass rate`} />
            <StatCard label="Active Writs" value={governance?.writ?.stats?.active || 0} color="#f59e0b" />
            <StatCard label="Consumed Writs" value={governance?.writ?.stats?.consumed || 0} color="#10b981" />
            <StatCard label="Receipts" value={governance?.writ?.stats?.receipts || 0} color="#60a5fa" />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Watchdog Files" value={watchdogStatus?.tracked_files || 0} color="#a78bfa" sub={watchdogStatus?.running ? 'running' : 'stopped'} />
            <StatCard label="Harness Refusals" value={harnessStats?.refused_count || 0} color="#f59e0b" />
            <StatCard label="Salvage Records" value={harnessStats?.salvage_count || 0} color="#dc2626" />
            <StatCard label="Owner Slot" value={governance?.writ?.stats?.ownerSlot?.status || 'none'} color={governance?.writ?.stats?.ownerSlot?.status === 'active' ? '#10b981' : '#555'} />
          </div>

          <button onClick={runSelftest} style={{
            padding: '8px 16px', borderRadius: 6, border: '1px solid #333',
            background: '#111118', color: '#ef4444', cursor: 'pointer', fontSize: 12,
          }}>Run Full Selftest</button>

          {selftestResult && (
            <div style={{ marginTop: 12, padding: 12, background: '#111118', borderRadius: 8, border: '1px solid #222' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: selftestResult.pass ? '#10b981' : '#ef4444', marginBottom: 8 }}>
                {selftestResult.pass ? 'ALL MODULES PASS' : 'SELFTEST FAILED'}
              </div>
              {selftestResult.modules && Object.entries(selftestResult.modules).map(([mod, r]) => (
                <div key={mod} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: r.pass ? '#10b981' : '#ef4444', width: 40 }}>{r.pass ? 'PASS' : 'FAIL'}</span>
                  <span style={{ color: '#888' }}>{mod}</span>
                  <span style={{ color: '#555' }}>({r.tests} tests)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'guard' && (
        <div>
          <SectionHeader title="Guard Tasks — PRE-KILL" color="#ef4444" icon="🛡" />
          <p style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
            Injection detection and payload validation. Every command and bus message is scanned before execution.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Total Checks" value={governance?.guard?.stats?.total || 0} color="#a78bfa" />
            <StatCard label="Rejections" value={governance?.guard?.stats?.rejected || 0} color="#ef4444" />
            <StatCard label="Pass Rate" value={`${governance?.guard?.stats?.pass_rate || 100}%`} color="#10b981" />
          </div>
          <h5 style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Recent Events</h5>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {(governance?.guard?.stats?.recent || []).map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 }}>
                <VerdictBadge verdict={e.verdict} />
                <span style={{ color: '#888', flex: 1 }}>{e.reason || '—'}</span>
                <span style={{ color: '#555' }}>{e.source}</span>
                <span style={{ color: '#555' }}>{new Date(e.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'writ' && (
        <div>
          <SectionHeader title="Writ System — Permission Gating" color="#f59e0b" icon="📜" />
          <p style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
            Deterministic permission council. Every tool execution requires a signed writ. Sovereign tier needs owner slot.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Total Writs" value={governance?.writ?.stats?.total || 0} color="#a78bfa" />
            <StatCard label="Active" value={governance?.writ?.stats?.active || 0} color="#10b981" />
            <StatCard label="Consumed" value={governance?.writ?.stats?.consumed || 0} color="#f59e0b" />
            <StatCard label="Expired" value={governance?.writ?.stats?.expired || 0} color="#555" />
          </div>

          {governance?.writ?.stats?.ownerSlot && governance.writ.stats.ownerSlot.status !== 'none' && (
            <div style={{ padding: 12, background: '#111118', borderRadius: 8, border: '1px solid #333', marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b', marginBottom: 4 }}>Owner Slot</div>
              <div style={{ fontSize: 12, color: '#888' }}>
                Status: <VerdictBadge verdict={governance.writ.stats.ownerSlot.status?.toUpperCase() || 'NONE'} />
                {governance.writ.stats.ownerSlot.expires_at && (
                  <span style={{ marginLeft: 8 }}>Expires: {new Date(governance.writ.stats.ownerSlot.expires_at).toLocaleTimeString()}</span>
                )}
              </div>
            </div>
          )}

          <h5 style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Recent Writs</h5>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {(governance?.writ?.stats?.recentWrits || []).map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 }}>
                <span style={{ color: w.tier === 'sovereign' ? '#f59e0b' : w.tier === 'image' ? '#60a5fa' : '#10b981', width: 60 }}>{w.tier}</span>
                <span style={{ color: '#888', flex: 1 }}>{w.agent_id}</span>
                <span style={{ color: '#555' }}>{w.tool}</span>
                <VerdictBadge verdict={w.status?.toUpperCase()} />
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'clock' && (
        <div>
          <SectionHeader title="Clock Honesty" color="#60a5fa" icon="⏱" />
          <p style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
            Verifies local clock against external references. DRIFT or UNKNOWN means timestamps are suspect.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Verdict" value={governance?.clock?.verdict?.verdict || 'UNKNOWN'} color={governance?.clock?.trusted ? '#10b981' : '#f59e0b'} />
            <StatCard label="Drift" value={governance?.clock?.verdict?.drift_ms != null ? `${governance.clock.verdict.drift_ms}ms` : '—'} color="#a78bfa" />
            <StatCard label="Source" value={governance?.clock?.verdict?.source ? new URL(governance.clock.verdict.source).hostname : '—'} color="#888" />
            <StatCard label="Trusted" value={governance?.clock?.trusted ? 'YES' : 'NO'} color={governance?.clock?.trusted ? '#10b981' : '#ef4444'} />
          </div>

          <button onClick={async () => {
            try { const r = await fetch('/api/integrity/clock/check', { method: 'POST' }); const d = await r.json(); setGovernance(g => g ? { ...g, clock: { ...g.clock, verdict: d, trusted: d.verdict === 'OK' } } : g); } catch {}
          }} style={{
            padding: '6px 14px', borderRadius: 6, border: '1px solid #333',
            background: '#111118', color: '#60a5fa', cursor: 'pointer', fontSize: 12,
          }}>Check Clock Now</button>
        </div>
      )}

      {tab === 'harness' && (
        <div>
          <SectionHeader title="Harness — Anti-Invention Seal" color="#a78bfa" icon="⚡" />
          <p style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
            Every tool result is SHA-256 sealed by the harness. Nothing unmeasured enters an agent transcript.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Evidence Records" value={harnessStats?.evidence_count || 0} color="#a78bfa" />
            <StatCard label="Runs w/ Evidence" value={harnessStats?.runs_with_evidence || 0} color="#10b981" />
            <StatCard label="Refusals" value={harnessStats?.refused_count || 0} color="#f59e0b" />
            <StatCard label="Salvage Records" value={harnessStats?.salvage_count || 0} color="#dc2626" />
          </div>
          <h5 style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Top Tools by Evidence</h5>
          {(harnessStats?.top_tools || []).map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12 }}>
              <span style={{ color: '#a78bfa', width: 40, textAlign: 'right' }}>{t.n}</span>
              <span style={{ color: '#888' }}>{t.tool}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'watchdog' && (
        <div>
          <SectionHeader title="Watchdog — File Integrity" color="#10b981" icon="👁" />
          <p style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
            SHA-256 verification of tracked files every 60s. Tampered or missing files auto-restored from fossils.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Tracked Files" value={watchdogStatus?.tracked_files || 0} color="#10b981" />
            <StatCard label="Manifest Version" value={watchdogStatus?.manifest_version || 0} color="#a78bfa" />
            <StatCard label="Running" value={watchdogStatus?.running ? 'YES' : 'NO'} color={watchdogStatus?.running ? '#10b981' : '#555'} />
            <StatCard label="Violations" value={watchdogStatus?.recent_violations?.length || 0} color="#ef4444" />
          </div>
          <h5 style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Recent Events</h5>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {(watchdogStatus?.events || []).map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 }}>
                <span style={{ color: e.type === 'healed' ? '#10b981' : e.type === 'tampered' ? '#ef4444' : '#888', width: 70 }}>{e.type}</span>
                <span style={{ color: '#555', flex: 1 }}>{e.file_path?.split(/[\\/]/).pop() || '—'}</span>
                <span style={{ color: '#555' }}>{e.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
