import React, { useState, useEffect, useCallback } from 'react';

const ACCENT = '#06b6d4';
const BG = '#0a1419';
const BORDER = '#1a2e33';
const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 16px', flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || ACCENT }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function MiniBar({ label, count, maxCount }) {
  const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <div style={{ width: 140, fontSize: 12, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</div>
      <div style={{ flex: 1, background: '#111', borderRadius: 3, height: 8 }}>
        <div style={{ background: ACCENT, borderRadius: 3, height: 8, width: `${pct}%`, transition: 'width 0.3s' }} />
      </div>
      <div style={{ width: 40, fontSize: 11, color: '#888', textAlign: 'right' }}>{count}</div>
    </div>
  );
}

function WebhookRow({ hook, onToggle, onDelete }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${BORDER}` }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: hook.enabled ? GREEN : '#555', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: '#e0e0e8' }}>{hook.label || hook.url}</div>
        <div style={{ fontSize: 11, color: '#666' }}>{hook.severity_filter} · {hook.fire_count} fires</div>
      </div>
      <button onClick={() => onToggle(hook.id)} style={{ background: '#111', border: '1px solid #333', borderRadius: 5, padding: '2px 8px', color: '#888', cursor: 'pointer', fontSize: 11 }}>
        {hook.enabled ? 'Disable' : 'Enable'}
      </button>
      <button onClick={() => onDelete(hook.id)} style={{ background: '#1a0a0a', border: '1px solid #331111', borderRadius: 5, padding: '2px 8px', color: RED, cursor: 'pointer', fontSize: 11 }}>×</button>
    </div>
  );
}

export default function ObservabilityPanel({ wsEvent }) {
  const [tab, setTab] = useState('gateway');
  const [gateway, setGateway] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [webhooks, setWebhooks] = useState([]);
  const [logLevel, setLogLevel] = useState(null);
  const [uptime, setUptime] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newSeverity, setNewSeverity] = useState('critical');

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/gateway/stats').then(r => r.json()).catch(() => null),
      fetch('/api/observability/metrics').then(r => r.json()).catch(() => null),
      fetch('/api/observability/webhooks').then(r => r.json()).catch(() => ({ webhooks: [] })),
      fetch('/api/observability/log-level').then(r => r.json()).catch(() => null),
      fetch('/api/observability/uptime').then(r => r.json()).catch(() => null),
    ]).then(([g, m, w, ll, u]) => {
      setGateway(g);
      setMetrics(m);
      setWebhooks(w?.webhooks || []);
      setLogLevel(ll);
      setUptime(u);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (wsEvent?.type === 'health' || wsEvent?.type === 'gateway') load(); }, [wsEvent, load]);

  const toggleWebhook = (id) => fetch(`/api/observability/webhooks/${id}/toggle`, { method: 'POST' }).then(load);
  const deleteWebhook = (id) => fetch(`/api/observability/webhooks/${id}`, { method: 'DELETE' }).then(load);
  const testWebhooks = () => fetch('/api/observability/webhooks/test', { method: 'POST' }).then(load);
  const addWebhook = () => {
    if (!newUrl) return;
    fetch('/api/observability/webhooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: newUrl, label: newLabel || null, severity_filter: newSeverity }),
    }).then(() => { setNewUrl(''); setNewLabel(''); load(); });
  };
  const changeLogLevel = (level) => {
    fetch('/api/observability/log-level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }) }).then(load);
  };
  const pruneGateway = () => fetch('/api/gateway/prune', { method: 'POST' }).then(load);

  if (loading) return <div style={{ padding: 20, color: '#888' }}>Loading observability data...</div>;

  const tabs = [
    { id: 'gateway', label: 'Gateway' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'config', label: 'Config' },
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

      {tab === 'gateway' && gateway && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Requests (1h)" value={gateway.hourly?.total || 0} />
            <StatCard label="Errors (1h)" value={gateway.hourly?.errors || 0} color={gateway.hourly?.errors > 0 ? RED : GREEN} />
            <StatCard label="Avg Latency" value={`${gateway.hourly?.avgDuration || 0}ms`} color={gateway.hourly?.avgDuration > 500 ? AMBER : GREEN} />
            <StatCard label="Requests (24h)" value={gateway.daily?.total || 0} />
          </div>

          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '16px 0 8px' }}>Top Paths (1h)</h4>
          {(gateway.topPaths || []).length > 0 ? (
            <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12 }}>
              {gateway.topPaths.map((p, i) => (
                <MiniBar key={i} label={p.path} count={p.count} maxCount={gateway.topPaths[0]?.count || 1} />
              ))}
            </div>
          ) : <div style={{ color: '#555', fontSize: 12 }}>No requests in the last hour</div>}

          {(gateway.topKeys || []).length > 0 && (
            <>
              <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '16px 0 8px' }}>Top API Keys (1h)</h4>
              <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12 }}>
                {gateway.topKeys.map((k, i) => (
                  <MiniBar key={i} label={k.api_key?.slice(0, 12) + '...' || 'anonymous'} count={k.count} maxCount={gateway.topKeys[0]?.count || 1} />
                ))}
              </div>
            </>
          )}

          <button onClick={pruneGateway} style={{
            marginTop: 16, background: '#111', border: '1px solid #333', borderRadius: 8,
            padding: '6px 14px', color: '#888', cursor: 'pointer', fontSize: 12,
          }}>Prune old logs</button>
        </div>
      )}

      {tab === 'metrics' && metrics && (
        <div>
          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 10px' }}>Process</h4>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Uptime" value={uptime ? `${Math.floor(uptime.uptimeSeconds / 3600)}h ${Math.floor((uptime.uptimeSeconds % 3600) / 60)}m` : '—'} />
            <StatCard label="Heap Used" value={`${Math.round((metrics.process?.heap_used_bytes || 0) / 1048576)}MB`}
              color={(metrics.process?.heap_used_bytes || 0) > 512 * 1048576 ? RED : ACCENT} />
            <StatCard label="RSS" value={`${Math.round((metrics.process?.rss_bytes || 0) / 1048576)}MB`} />
          </div>

          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 10px' }}>Fleet</h4>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Runs (1h)" value={metrics.fleet?.runs_1h || 0} />
            <StatCard label="Success (1h)" value={metrics.fleet?.runs_success_1h || 0} color={GREEN} />
            <StatCard label="Failed (1h)" value={metrics.fleet?.runs_failed_1h || 0} color={metrics.fleet?.runs_failed_1h > 0 ? RED : GREEN} />
          </div>

          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 10px' }}>Intelligence</h4>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Memories" value={metrics.intelligence?.memories || 0} />
            <StatCard label="Knowledge Nodes" value={metrics.intelligence?.knowledge_nodes || 0} />
            <StatCard label="Knowledge Edges" value={metrics.intelligence?.knowledge_edges || 0} />
            <StatCard label="Active Alerts" value={metrics.health?.active_alerts || 0} color={metrics.health?.active_alerts > 0 ? RED : GREEN} />
          </div>

          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 10px' }}>Database</h4>
          <StatCard label="DB Size" value={`${Math.round((metrics.db?.size_bytes || 0) / 1048576)}MB`}
            color={(metrics.db?.size_bytes || 0) > 1024 * 1048576 ? AMBER : ACCENT} />
        </div>
      )}

      {tab === 'webhooks' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="Webhook URL"
              style={{ flex: 2, minWidth: 200, background: '#111', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#e0e0e8', fontSize: 13 }} />
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label"
              style={{ flex: 1, minWidth: 100, background: '#111', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#e0e0e8', fontSize: 13 }} />
            <select value={newSeverity} onChange={e => setNewSeverity(e.target.value)}
              style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#e0e0e8', fontSize: 13 }}>
              <option value="info">Info+</option>
              <option value="warning">Warning+</option>
              <option value="critical">Critical only</option>
            </select>
            <button onClick={addWebhook} style={{
              background: ACCENT + '22', border: `1px solid ${ACCENT}`, borderRadius: 6,
              padding: '6px 14px', color: ACCENT, cursor: 'pointer', fontSize: 12, fontWeight: 500,
            }}>Add</button>
          </div>

          {webhooks.length > 0 ? (
            <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
              {webhooks.map(h => <WebhookRow key={h.id} hook={h} onToggle={toggleWebhook} onDelete={deleteWebhook} />)}
            </div>
          ) : <div style={{ color: '#555', fontSize: 12 }}>No webhooks configured. Add one to receive alert notifications.</div>}

          <button onClick={testWebhooks} style={{
            marginTop: 16, background: '#111', border: '1px solid #333', borderRadius: 8,
            padding: '6px 14px', color: '#888', cursor: 'pointer', fontSize: 12,
          }}>Send test alert</button>
        </div>
      )}

      {tab === 'config' && (
        <div>
          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 10px' }}>Log Level</h4>
          <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
            {['debug', 'info', 'warn', 'error', 'fatal'].map(level => (
              <button key={level} onClick={() => changeLogLevel(level)} style={{
                background: logLevel?.level === level ? ACCENT + '22' : '#111',
                border: `1px solid ${logLevel?.level === level ? ACCENT : '#333'}`,
                borderRadius: 6, padding: '6px 12px', color: logLevel?.level === level ? ACCENT : '#888',
                cursor: 'pointer', fontSize: 12, textTransform: 'uppercase',
              }}>{level}</button>
            ))}
          </div>

          <h4 style={{ color: '#e0e0e8', fontSize: 13, margin: '0 0 10px' }}>System Info</h4>
          <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.8 }}>
              <div>Boot time: {uptime?.bootTime || '—'}</div>
              <div>Uptime: {uptime ? `${Math.floor(uptime.uptimeSeconds / 3600)}h ${Math.floor((uptime.uptimeSeconds % 3600) / 60)}m` : '—'}</div>
              <div>Log level: {logLevel?.level || '—'}</div>
              <div>Gateway version: {gateway?.version || '—'}</div>
              <div>Prometheus: <span style={{ color: '#555' }}>GET /api/observability/metrics/prometheus</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
