import React, { useState, useEffect, useCallback } from 'react';

function fmt(bytes) {
  if (!bytes) return '—';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function uptime(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function SettingsPanel({ wsEvent }) {
  const [settings, setSettings] = useState(null);
  const [models, setModels] = useState([]);
  const [diag, setDiag] = useState(null);
  const [autonomy, setAutonomy] = useState(null);
  const [daemon, setDaemon] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [tab, setTab] = useState('general');

  const load = useCallback(() => {
    fetch('/api/settings').then(r => r.json()).then(d => {
      setSettings(d);
      setSelectedModel(d.ollamaModel || '');
    }).catch(() => {});
    fetch('/api/settings/models').then(r => r.json()).then(d => setModels(d.models || [])).catch(() => {});
    fetch('/api/settings/diagnostics').then(r => r.json()).then(setDiag).catch(() => {});
    fetch('/api/fraymus/autonomy/status').then(r => r.json()).then(setAutonomy).catch(() => {});
    fetch('/api/daemon/status').then(r => r.json()).then(setDaemon).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type && ['health', 'agents', 'daemon'].includes(wsEvent.type)) load();
  }, [wsEvent, load]);

  const saveModel = async (model) => {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollamaModel: model }),
      });
      setSelectedModel(model);
      load();
    } catch {} finally { setSaving(false); }
  };

  const toggleAutonomy = async (action) => {
    try {
      await fetch(`/api/fraymus/autonomy/${action}`, { method: 'POST' });
      load();
    } catch {}
  };

  const toggleDaemon = async (action) => {
    try {
      await fetch(`/api/daemon/${action}`, { method: 'POST' });
      load();
    } catch {}
  };

  const TABS = [
    { id: 'general', label: 'General', icon: '⚙' },
    { id: 'models', label: 'Models', icon: '◈' },
    { id: 'controls', label: 'Controls', icon: '⟳' },
    { id: 'diagnostics', label: 'Diagnostics', icon: '♦' },
  ];

  const Stat = ({ label, value, color }) => (
    <div style={{ background: '#111118', borderRadius: 8, padding: '10px 14px', border: '1px solid #222' }}>
      <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: color || '#e0e0e8' }}>{value}</div>
    </div>
  );

  const Toggle = ({ label, active, onToggle, offLabel, onLabel }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #1a1a2e' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#e0e0e8' }}>{label}</div>
        <div style={{ fontSize: 11, color: active ? '#22c55e' : '#666', marginTop: 2 }}>
          {active ? (onLabel || 'Active') : (offLabel || 'Stopped')}
        </div>
      </div>
      <button onClick={onToggle} style={{
        background: active ? '#ef444420' : '#22c55e20',
        border: `1px solid ${active ? '#ef444440' : '#22c55e40'}`,
        borderRadius: 6, padding: '6px 16px', fontSize: 12, cursor: 'pointer',
        color: active ? '#ef4444' : '#22c55e', fontWeight: 500,
      }}>
        {active ? 'Stop' : 'Start'}
      </button>
    </div>
  );

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#22c55e', marginBottom: 4 }}>
        System Settings
      </h2>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 20 }}>
        Configure Ollama models, autonomy, daemon, and view diagnostics
      </p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 14px', border: 'none', borderRadius: 8, cursor: 'pointer',
            fontSize: 12, fontWeight: tab === t.id ? 600 : 400,
            background: tab === t.id ? '#22c55e22' : '#111118',
            color: tab === t.id ? '#22c55e' : '#888',
            transition: 'all 0.15s',
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && settings && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 }}>
            <Stat label="Server" value={`${settings.server?.host}:${settings.server?.port}`} color="#22c55e" />
            <Stat label="Uptime" value={uptime(settings.server?.uptime)} color="#6366f1" />
            <Stat label="PID" value={settings.server?.pid} />
            <Stat label="Heap Used" value={fmt(settings.memory?.heapUsed)} color="#f59e0b" />
            <Stat label="Heap Total" value={fmt(settings.memory?.heapTotal)} />
            <Stat label="RSS" value={fmt(settings.memory?.rss)} color="#ec4899" />
          </div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222', marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#22c55e', marginBottom: 12 }}>Active Model</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e0e0e8' }}>{settings.ollamaModel}</div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>Ollama: {settings.ollamaUrl}</div>
          </div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6366f1', marginBottom: 12 }}>Configuration</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#888' }}>Auto-Reflect</span>
                <span style={{ color: settings.autoReflect ? '#22c55e' : '#ef4444' }}>
                  {settings.autoReflect ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#888' }}>Reflect Interval</span>
                <span style={{ color: '#e0e0e8' }}>{settings.reflectIntervalMin} min</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'models' && (
        <div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222', marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b', marginBottom: 4 }}>
              Active Model
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#e0e0e8' }}>{selectedModel}</div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 12 }}>
            Available Models ({models.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 400, overflowY: 'auto' }}>
            {models.map(m => {
              const isActive = m.name === selectedModel;
              return (
                <div key={m.name} style={{
                  background: isActive ? '#22c55e10' : '#111118',
                  borderRadius: 8, padding: '10px 14px',
                  border: `1px solid ${isActive ? '#22c55e30' : '#222'}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  cursor: 'pointer',
                }} onClick={() => !saving && saveModel(m.name)}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: isActive ? 600 : 400, color: isActive ? '#22c55e' : '#e0e0e8' }}>
                      {m.name}
                      {isActive && <span style={{ fontSize: 10, marginLeft: 8, color: '#22c55e' }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
                      {m.paramSize || '—'} · {m.family || '—'} · {fmt(m.size)}
                      {m.quantization ? ` · ${m.quantization}` : ''}
                    </div>
                  </div>
                  {!isActive && (
                    <button disabled={saving} style={{
                      background: '#22c55e20', border: '1px solid #22c55e40', borderRadius: 6,
                      padding: '4px 12px', color: '#22c55e', cursor: saving ? 'wait' : 'pointer', fontSize: 11,
                    }}>
                      {saving ? '...' : 'Use'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'controls' && (
        <div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa', marginBottom: 8 }}>Autonomy Engine</div>
            <Toggle
              label="Kuramoto Sync + Intelligence Loop"
              active={autonomy?.active || autonomy?.status === 'active'}
              onToggle={() => toggleAutonomy(autonomy?.active || autonomy?.status === 'active' ? 'stop' : 'start')}
              onLabel={`Gen ${autonomy?.generation ?? '?'} · Phase sync active`}
              offLabel="Autonomy stopped"
            />
            <button onClick={() => toggleAutonomy('sync')} style={{
              marginTop: 12, background: '#6366f120', border: '1px solid #6366f140', borderRadius: 6,
              padding: '6px 16px', color: '#6366f1', cursor: 'pointer', fontSize: 12,
            }}>
              Force Sync
            </button>
          </div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b', marginBottom: 8 }}>Evolution Daemon</div>
            <Toggle
              label="Background Dream + Prompt Evolution"
              active={daemon?.running}
              onToggle={() => toggleDaemon(daemon?.running ? 'stop' : 'start')}
              onLabel={`Cycle #${daemon?.cycleCount ?? '?'} · ${daemon?.intervalMin ?? 30}min interval`}
              offLabel="Daemon stopped"
            />
            <button onClick={() => toggleDaemon('cycle')} style={{
              marginTop: 12, background: '#f59e0b20', border: '1px solid #f59e0b40', borderRadius: 6,
              padding: '6px 16px', color: '#f59e0b', cursor: 'pointer', fontSize: 12,
            }}>
              Manual Cycle
            </button>
          </div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#ec4899', marginBottom: 8 }}>Reflection Loop</div>
            <button onClick={async () => {
              try { await fetch('/api/intelligence/reflect', { method: 'POST' }); } catch {}
            }} style={{
              background: '#ec489920', border: '1px solid #ec489940', borderRadius: 6,
              padding: '6px 16px', color: '#ec4899', cursor: 'pointer', fontSize: 12,
            }}>
              Trigger Reflection
            </button>
          </div>
        </div>
      )}

      {tab === 'diagnostics' && diag && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 20 }}>
            <Stat label="Node.js" value={diag.nodeVersion} color="#22c55e" />
            <Stat label="Platform" value={`${diag.platform} / ${diag.arch}`} />
            <Stat label="Uptime" value={uptime(diag.uptime)} color="#6366f1" />
            <Stat label="DB Mode" value={diag.dbMode || '—'} color="#f59e0b" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              background: '#111118', borderRadius: 8, padding: '12px 16px', border: '1px solid #222',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e0e0e8' }}>Ollama</div>
                <div style={{ fontSize: 11, color: '#666' }}>{diag.ollamaModels || 0} models loaded</div>
              </div>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: diag.ollama ? '#22c55e' : '#ef4444',
              }} />
            </div>
            <div style={{
              background: '#111118', borderRadius: 8, padding: '12px 16px', border: '1px solid #222',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#e0e0e8' }}>SQLite</div>
                <div style={{ fontSize: 11, color: '#666' }}>Journal: {diag.dbMode || 'unknown'}</div>
              </div>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: diag.db ? '#22c55e' : '#ef4444',
              }} />
            </div>
          </div>
          <button onClick={load} style={{
            marginTop: 16, background: '#22c55e20', border: '1px solid #22c55e40', borderRadius: 6,
            padding: '8px 20px', color: '#22c55e', cursor: 'pointer', fontSize: 12, fontWeight: 500,
          }}>
            Refresh Diagnostics
          </button>
        </div>
      )}
    </div>
  );
}
