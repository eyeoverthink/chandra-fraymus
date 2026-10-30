import React, { useState, useEffect, useCallback } from 'react';

const C = '#ef4444';
const BG = '#1a0a0a';
const BORDER = '#331111';

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 16px', flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || C }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function AlertRow({ alert, onResolve }) {
  const sevColor = alert.severity === 'critical' ? '#ef4444' : '#f59e0b';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${BORDER}` }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: '#e0e0e8' }}>{alert.message}</div>
        <div style={{ fontSize: 11, color: '#666' }}>{alert.rule} · {new Date(alert.created_at).toLocaleTimeString()}</div>
      </div>
      <button onClick={() => onResolve(alert.id)} style={{
        background: '#222', border: '1px solid #333', borderRadius: 6, padding: '3px 10px', color: '#888', cursor: 'pointer', fontSize: 11,
      }}>Resolve</button>
    </div>
  );
}

function MetricBar({ label, value, max, unit }) {
  const pct = Math.min(100, (value / (max || 1)) * 100);
  const barColor = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#aaa', marginBottom: 3 }}>
        <span>{label}</span>
        <span>{value}{unit}</span>
      </div>
      <div style={{ background: '#111', borderRadius: 4, height: 6 }}>
        <div style={{ background: barColor, borderRadius: 4, height: 6, width: `${pct}%`, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
}

export default function HealthPanel({ wsEvent }) {
  const [metrics, setMetrics] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/health/stats').then(r => r.json()),
      fetch('/api/health/alerts?limit=20').then(r => r.json()),
    ]).then(([m, a]) => {
      setMetrics(m);
      setAlerts(a.alerts || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (wsEvent?.type === 'health') load();
  }, [wsEvent, load]);

  const resolve = (id) => {
    fetch(`/api/health/alerts/${id}/resolve`, { method: 'POST' }).then(load);
  };

  const collectNow = () => {
    fetch('/api/health/collect', { method: 'POST' }).then(r => r.json()).then(() => load());
  };

  if (loading) return <div style={{ padding: 20, color: '#888' }}>Loading health data...</div>;

  const m = metrics || {};
  return (
    <div style={{ padding: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, color: '#e0e0e8', margin: 0 }}>System Health Monitor</h3>
        <button onClick={collectNow} style={{
          background: C + '22', border: `1px solid ${C}44`, borderRadius: 8, padding: '5px 14px', color: C, cursor: 'pointer', fontSize: 12,
        }}>Collect Now</button>
      </div>

      {/* Stats Row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <StatCard label="Ollama" value={m.ollama_up ? 'UP' : 'DOWN'} color={m.ollama_up ? '#22c55e' : '#ef4444'} sub={`${m.ollama_models || 0} models`} />
        <StatCard label="Heap" value={`${m.heap_mb || 0}MB`} sub={`RSS: ${m.rss_mb || 0}MB`} />
        <StatCard label="Alerts" value={m.activeAlerts || 0} color={m.activeAlerts > 0 ? '#ef4444' : '#22c55e'} />
        <StatCard label="Bus Today" value={m.db_bus_today || 0} sub={`${m.db_bus_messages || 0} total`} />
      </div>

      {/* Resource Bars */}
      <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: '#aaa', marginBottom: 12, fontWeight: 600 }}>Resources</div>
        <MetricBar label="Heap Memory" value={m.heap_mb || 0} max={512} unit="MB" />
        <MetricBar label="Agent Runs (1h)" value={m.agent_runs_1h || 0} max={50} unit="" />
        <MetricBar label="Agent Errors (1h)" value={m.agent_errors_1h || 0} max={10} unit="" />
        <MetricBar label="Needle Pending" value={m.needle_pending || 0} max={20} unit=" jobs" />
        <MetricBar label="Bus Subscriptions" value={m.bus_subscriptions || 0} max={50} unit="" />
        <MetricBar label="Bus Triggers" value={m.bus_triggers || 0} max={20} unit="" />
      </div>

      {/* Infrastructure */}
      <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: '#aaa', marginBottom: 10, fontWeight: 600 }}>Infrastructure</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            ['Workflows', m.db_workflows],
            ['Agent Threads', m.db_agents],
            ['Commerce Runs (24h)', m.commerce_runs_24h],
            ['Needle Running', m.needle_running],
          ].map(([label, val]) => (
            <div key={label} style={{ fontSize: 12, color: '#aaa' }}>
              <span style={{ color: '#666' }}>{label}:</span> <span style={{ color: '#e0e0e8' }}>{val || 0}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Alerts */}
      <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ fontSize: 13, color: '#aaa', padding: '12px 16px', fontWeight: 600, borderBottom: `1px solid ${BORDER}` }}>
          Active Alerts ({alerts.length})
        </div>
        {alerts.length === 0 ? (
          <div style={{ padding: 16, color: '#555', fontSize: 12, textAlign: 'center' }}>No active alerts</div>
        ) : (
          alerts.map(a => <AlertRow key={a.id} alert={a} onResolve={resolve} />)
        )}
      </div>

      {m._collectedAt > 0 && (
        <div style={{ fontSize: 11, color: '#444', marginTop: 12, textAlign: 'right' }}>
          Last collected: {new Date(m._collectedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
