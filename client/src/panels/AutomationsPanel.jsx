import React, { useState, useEffect, useCallback } from 'react';

export default function AutomationsPanel() {
  const [automations, setAutomations] = useState([]);
  const [form, setForm] = useState({ name: '', cron: '0 8 * * *', kind: 'agent', agentId: 'concierge', prompt: '' });
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    fetch('/api/automations').then(r => r.json()).then(d => setAutomations(d.automations || d || [])).catch(() => {});
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name || !form.cron) return;
    try {
      setError(null);
      await fetch('/api/automations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, cron: form.cron, kind: form.kind,
          agentId: form.agentId, payload: { prompt: form.prompt },
        }),
      });
      setForm({ name: '', cron: '0 8 * * *', kind: 'agent', agentId: 'concierge', prompt: '' });
      load();
    } catch (e) { setError(`Create failed: ${e.message}`); }
  };

  const runNow = async (id) => {
    try {
      setError(null);
      await fetch(`/api/automations/${id}/run`, { method: 'POST' });
      setTimeout(load, 3000);
    } catch (e) { setError(`Run failed: ${e.message}`); }
  };

  const del = async (id) => {
    try {
      setError(null);
      await fetch(`/api/automations/${id}`, { method: 'DELETE' });
      load();
    } catch (e) { setError(`Delete failed: ${e.message}`); }
  };

  const inputStyle = {
    background: '#1a1a2e', border: '1px solid #333', borderRadius: 6,
    padding: '8px 12px', color: '#e0e0e8', fontSize: 13, width: '100%',
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', marginBottom: 20 }}>Automations — Cron Scheduler</h2>
      {error && <div style={{ background: '#2d1b1b', border: '1px solid #5b2b2b', borderRadius: 8, padding: '8px 12px', marginBottom: 16, color: '#f87171', fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#111118', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8', marginBottom: 16 }}>New Automation</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <input placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
          <input placeholder="Cron (5-field UTC)" value={form.cron} onChange={e => setForm(f => ({ ...f, cron: e.target.value }))} style={inputStyle} />
          <select value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))} style={inputStyle}>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input placeholder="Prompt for agent" value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))} style={inputStyle} />
        </div>
        <button onClick={create} style={{
          marginTop: 12, background: '#6366f1', border: 'none', borderRadius: 8,
          padding: '8px 20px', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}>Create Automation</button>
      </div>

      <div>
        {automations.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>No automations yet.</div>}
        {automations.map(a => (
          <div key={a.id} style={{
            background: '#111118', borderRadius: 8, padding: '14px 16px', marginBottom: 8,
            border: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e8' }}>{a.name}</div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                {a.cron} · {a.kind} → {a.agent_id || a.tool || '—'} · {a.enabled ? '✓ enabled' : '✗ disabled'}
              </div>
              {a.lastRun && <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>Last: {a.lastRun.status} at {new Date(a.lastRun.started_at).toLocaleString()}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => runNow(a.id)} style={{ background: '#10b981', border: 'none', borderRadius: 6, padding: '4px 12px', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Run Now</button>
              <button onClick={() => del(a.id)} style={{ background: '#dc2626', border: 'none', borderRadius: 6, padding: '4px 12px', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
