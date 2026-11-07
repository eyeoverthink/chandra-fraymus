import { useState, useEffect, useCallback } from 'react';

const TABS = ['Dashboard', 'Feature Flags', 'Config Store', 'History'];

export default function ConfigPanel({ wsEvent }) {
  const [tab, setTab] = useState(0);
  const [dashboard, setDashboard] = useState(null);
  const [flags, setFlags] = useState([]);
  const [flagStats, setFlagStats] = useState(null);
  const [configs, setConfigs] = useState({});
  const [namespaces, setNamespaces] = useState([]);
  const [selectedNs, setSelectedNs] = useState('');
  const [schemas, setSchemas] = useState({});
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [flagCategory, setFlagCategory] = useState('');

  const loadDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/config-mgr/dashboard');
      setDashboard(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadFlags = useCallback(async () => {
    try {
      const url = flagCategory ? `/api/config-mgr/flags?category=${flagCategory}` : '/api/config-mgr/flags';
      const res = await fetch(url);
      const data = await res.json();
      setFlags(data.flags || []);
      setFlagStats(data.stats || null);
    } catch (e) { setError(e.message); }
  }, [flagCategory]);

  const loadConfigs = useCallback(async () => {
    try {
      const res = await fetch('/api/config-mgr/store');
      const data = await res.json();
      setNamespaces(data.namespaces || []);
      if (data.namespaces?.length && !selectedNs) setSelectedNs(data.namespaces[0]);
    } catch (e) { setError(e.message); }
  }, [selectedNs]);

  const loadNamespaceConfigs = useCallback(async () => {
    if (!selectedNs) return;
    try {
      const [configRes, schemaRes] = await Promise.all([
        fetch(`/api/config-mgr/store?namespace=${selectedNs}`),
        fetch(`/api/config-mgr/schemas?namespace=${selectedNs}`),
      ]);
      setConfigs(await configRes.json());
      const schemaData = await schemaRes.json();
      setSchemas(schemaData.schema || {});
    } catch (e) { setError(e.message); }
  }, [selectedNs]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/config-mgr/history?limit=50');
      setHistory(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (tab === 0) loadDashboard();
    if (tab === 1) loadFlags();
    if (tab === 2) { loadConfigs(); loadNamespaceConfigs(); }
    if (tab === 3) loadHistory();
  }, [tab, loadDashboard, loadFlags, loadConfigs, loadNamespaceConfigs, loadHistory]);

  useEffect(() => {
    if (wsEvent?.type === 'config-change') {
      if (tab === 0) loadDashboard();
      if (tab === 2) loadNamespaceConfigs();
      if (tab === 3) loadHistory();
    }
  }, [wsEvent, tab, loadDashboard, loadNamespaceConfigs, loadHistory]);

  const toggleFlag = async (flag) => {
    try {
      await fetch(`/api/config-mgr/flags/${flag}/toggle`, { method: 'POST' });
      loadFlags();
      if (tab === 0) loadDashboard();
    } catch (e) { setError(e.message); }
  };

  const updateConfig = async (namespace, key, value, type) => {
    try {
      await fetch('/api/config-mgr/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace, key, value, type }),
      });
      loadNamespaceConfigs();
      if (tab === 0) loadDashboard();
    } catch (e) { setError(e.message); }
  };

  const resetNamespace = async (ns) => {
    try {
      await fetch(`/api/config-mgr/reset/${ns}`, { method: 'POST' });
      loadNamespaceConfigs();
    } catch (e) { setError(e.message); }
  };

  const s = {
    panel: { padding: 16, fontFamily: 'system-ui, -apple-system, sans-serif', color: '#e0e0e0', minHeight: '100%', background: '#1a1a2e' },
    tabs: { display: 'flex', gap: 0, borderBottom: '1px solid #333', marginBottom: 16 },
    tab: (active) => ({ padding: '8px 16px', cursor: 'pointer', background: active ? '#16213e' : 'transparent', color: active ? '#00d4aa' : '#888', borderBottom: active ? '2px solid #00d4aa' : '2px solid transparent', fontWeight: active ? 600 : 400, fontSize: 13, transition: 'all 0.2s' }),
    card: { background: '#16213e', borderRadius: 8, padding: 14, marginBottom: 12, border: '1px solid #2a2a4a' },
    h3: { margin: '0 0 10px', fontSize: 15, color: '#00d4aa', fontWeight: 600 },
    statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 },
    statCard: { background: '#0f3460', borderRadius: 6, padding: 10, textAlign: 'center' },
    statNum: { fontSize: 22, fontWeight: 700, color: '#00d4aa' },
    statLabel: { fontSize: 11, color: '#888', marginTop: 2 },
    flagRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1a1a2e' },
    flagName: { fontWeight: 500, fontSize: 13, color: '#e0e0e0' },
    flagDesc: { fontSize: 11, color: '#777', marginTop: 2 },
    toggle: (on) => ({ width: 40, height: 22, borderRadius: 11, background: on ? '#00d4aa' : '#444', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', border: 'none', padding: 0 }),
    toggleDot: (on) => ({ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: on ? 20 : 2, transition: 'left 0.2s' }),
    badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: color + '22', color }),
    input: { background: '#0f3460', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', color: '#e0e0e0', fontSize: 13, width: '100%', boxSizing: 'border-box' },
    btn: { background: '#00d4aa', color: '#000', border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    btnDanger: { background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    select: { background: '#0f3460', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', color: '#e0e0e0', fontSize: 13 },
    err: { background: '#2d1b1b', color: '#e74c3c', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 },
    histRow: { padding: '6px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 },
    configRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #1a1a2e' },
  };

  const DashboardTab = () => {
    if (!dashboard) return <div style={{ color: '#888', textAlign: 'center', padding: 40 }}>Loading...</div>;
    return (
      <div>
        <div style={s.statGrid}>
          <div style={s.statCard}><div style={s.statNum}>{dashboard.config?.totalKeys || 0}</div><div style={s.statLabel}>Config Keys</div></div>
          <div style={s.statCard}><div style={s.statNum}>{dashboard.flags?.enabled || 0}</div><div style={s.statLabel}>Flags Enabled</div></div>
          <div style={s.statCard}><div style={s.statNum}>{dashboard.flags?.disabled || 0}</div><div style={s.statLabel}>Flags Disabled</div></div>
          <div style={s.statCard}><div style={s.statNum}>{dashboard.config?.recentChanges || 0}</div><div style={s.statLabel}>Changes (1h)</div></div>
        </div>
        <div style={{ ...s.card, marginTop: 12 }}>
          <h3 style={s.h3}>Flag Categories</h3>
          {Object.entries(dashboard.flagsByCategory || {}).map(([cat, data]) => (
            <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span style={{ textTransform: 'capitalize' }}>{cat}</span>
              <span><span style={{ color: '#00d4aa' }}>{data.enabled}</span> / {data.total} enabled</span>
            </div>
          ))}
        </div>
        <div style={s.card}>
          <h3 style={s.h3}>Config Namespaces</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(dashboard.schemaNamespaces || []).map(ns => (
              <span key={ns} style={s.badge('#00d4aa')}>{ns}</span>
            ))}
          </div>
        </div>
        <div style={s.card}>
          <h3 style={s.h3}>Recent Changes</h3>
          {(dashboard.recentChanges || []).slice(0, 5).map(h => (
            <div key={h.id} style={s.histRow}>
              <span style={{ color: '#00d4aa' }}>{h.namespace}</span>.<span style={{ color: '#aaa' }}>{h.key}</span>
              {' '}<span style={{ color: '#666' }}>{h.old_value ? '→' : 'set'}</span>{' '}
              <span style={{ color: '#fff' }}>{(h.new_value || 'null').slice(0, 30)}</span>
              <span style={{ float: 'right', color: '#555', fontSize: 11 }}>{h.created_at}</span>
            </div>
          ))}
          {(!dashboard.recentChanges || dashboard.recentChanges.length === 0) && <div style={{ color: '#555', fontSize: 12 }}>No recent changes</div>}
        </div>
      </div>
    );
  };

  const FlagsTab = () => (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select style={s.select} value={flagCategory} onChange={e => setFlagCategory(e.target.value)}>
          <option value="">All Categories</option>
          {(flagStats?.categories || []).map(c => (
            <option key={c.category} value={c.category}>{c.category} ({c.enabled_count}/{c.count})</option>
          ))}
        </select>
        {flagStats && <span style={{ fontSize: 12, color: '#888', alignSelf: 'center' }}>{flagStats.enabled}/{flagStats.total} enabled</span>}
      </div>
      <div style={s.card}>
        {flags.map(f => (
          <div key={f.flag} style={s.flagRow}>
            <div style={{ flex: 1 }}>
              <div style={s.flagName}>{f.flag}</div>
              <div style={s.flagDesc}>{f.description || 'No description'}</div>
              <div style={{ marginTop: 3 }}>
                <span style={s.badge(f.category === 'intelligence' ? '#9b59b6' : f.category === 'infrastructure' ? '#3498db' : f.category === 'commerce' ? '#e67e22' : f.category === 'fleet' ? '#2ecc71' : '#95a5a6')}>{f.category}</span>
                {f.rollout_pct < 100 && <span style={{ ...s.badge('#f1c40f'), marginLeft: 4 }}>{f.rollout_pct}% rollout</span>}
              </div>
            </div>
            <button style={s.toggle(f.enabled)} onClick={() => toggleFlag(f.flag)}>
              <div style={s.toggleDot(f.enabled)} />
            </button>
          </div>
        ))}
        {flags.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: 20 }}>No flags found</div>}
      </div>
    </div>
  );

  const ConfigStoreTab = () => (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select style={s.select} value={selectedNs} onChange={e => setSelectedNs(e.target.value)}>
          {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <button style={s.btn} onClick={() => loadNamespaceConfigs()}>Refresh</button>
        <button style={s.btnDanger} onClick={() => selectedNs && resetNamespace(selectedNs)}>Reset to Defaults</button>
      </div>
      <div style={s.card}>
        <h3 style={s.h3}>{selectedNs || 'Select Namespace'}</h3>
        {Object.entries(configs).map(([key, entry]) => {
          const schema = schemas[key];
          return (
            <div key={key} style={s.configRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 13, color: '#e0e0e0' }}>{key}</div>
                <div style={{ fontSize: 11, color: '#666' }}>{entry.description || schema?.description || ''}</div>
                {schema && <div style={{ fontSize: 10, color: '#555' }}>
                  {schema.type}{schema.min !== undefined ? ` [${schema.min}–${schema.max}]` : ''} — default: {String(schema.default)}
                </div>}
              </div>
              <div style={{ width: 120 }}>
                {entry.type === 'boolean' ? (
                  <button style={s.toggle(entry.value)} onClick={() => updateConfig(selectedNs, key, !entry.value, 'boolean')}>
                    <div style={s.toggleDot(entry.value)} />
                  </button>
                ) : (
                  <input
                    style={s.input}
                    type={entry.type === 'number' ? 'number' : 'text'}
                    defaultValue={entry.value}
                    onBlur={e => {
                      const val = entry.type === 'number' ? Number(e.target.value) : e.target.value;
                      if (val !== entry.value) updateConfig(selectedNs, key, val, entry.type);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const val = entry.type === 'number' ? Number(e.target.value) : e.target.value;
                        updateConfig(selectedNs, key, val, entry.type);
                      }
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
        {Object.keys(configs).length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: 20 }}>No config keys — seed defaults first</div>}
      </div>
    </div>
  );

  const HistoryTab = () => (
    <div style={s.card}>
      <h3 style={s.h3}>Change History</h3>
      {history.map(h => (
        <div key={h.id} style={s.histRow}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span><span style={{ color: '#00d4aa' }}>{h.namespace}</span>.<span style={{ color: '#ccc' }}>{h.key}</span></span>
            <span style={{ color: '#555', fontSize: 11 }}>{h.created_at}</span>
          </div>
          <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
            {h.old_value ? <><span style={{ color: '#e74c3c', textDecoration: 'line-through' }}>{String(h.old_value).slice(0, 40)}</span> → </> : 'set → '}
            <span style={{ color: '#2ecc71' }}>{h.new_value ? String(h.new_value).slice(0, 40) : 'deleted'}</span>
            <span style={{ marginLeft: 8, color: '#555' }}>({h.source})</span>
          </div>
        </div>
      ))}
      {history.length === 0 && <div style={{ color: '#555', textAlign: 'center', padding: 20 }}>No history yet</div>}
    </div>
  );

  return (
    <div style={s.panel}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18, color: '#00d4aa' }}>Configuration Management</h2>
      {error && <div style={s.err}>{error} <button style={{ ...s.btn, marginLeft: 8, fontSize: 10 }} onClick={() => setError('')}>dismiss</button></div>}
      <div style={s.tabs}>
        {TABS.map((t, i) => <div key={t} style={s.tab(tab === i)} onClick={() => setTab(i)}>{t}</div>)}
      </div>
      {tab === 0 && <DashboardTab />}
      {tab === 1 && <FlagsTab />}
      {tab === 2 && <ConfigStoreTab />}
      {tab === 3 && <HistoryTab />}
    </div>
  );
}
