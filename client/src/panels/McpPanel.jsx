import React, { useState, useEffect, useCallback } from 'react';

export default function McpPanel() {
  const [servers, setServers] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [clients, setClients] = useState([]);
  const [importForm, setImportForm] = useState({ name: '', url: '' });
  const [tokenForm, setTokenForm] = useState({ name: 'my-token', scopes: 'read run' });

  const load = useCallback(() => {
    fetch('/api/mcp/servers').then(r => r.json()).then(d => setServers(d.servers || d || [])).catch(() => {});
    fetch('/api/access').then(r => r.json()).then(d => { setTokens(d.tokens || []); setClients(d.clients || []); }).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const importServer = async () => {
    if (!importForm.name || !importForm.url) return;
    await fetch('/api/mcp/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: importForm.name, url: importForm.url }),
    });
    setImportForm({ name: '', url: '' });
    load();
  };

  const removeServer = async (name) => {
    await fetch(`/api/mcp/servers/${name}`, { method: 'DELETE' });
    load();
  };

  const createToken = async () => {
    const res = await fetch('/api/access/tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenForm),
    });
    const data = await res.json();
    if (data.token) alert(`Token created: ${data.token}\n\nSave it — you won't see it again.`);
    load();
  };

  const inputStyle = {
    background: '#1a1a2e', border: '1px solid #333', borderRadius: 6,
    padding: '8px 12px', color: '#e0e0e8', fontSize: 13,
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', marginBottom: 20 }}>MCP Gateway</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        <div style={{ background: '#111118', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e8', marginBottom: 12 }}>MCP Server (/mcp)</h3>
          <p style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
            This workspace exposes itself as an MCP server at <code style={{ color: '#a78bfa' }}>/mcp</code>.
            External AI tools can connect using bearer tokens.
          </p>
          <div style={{ fontSize: 12, color: '#10b981' }}>18 tools exposed · OAuth 2.0 ready</div>
        </div>

        <div style={{ background: '#111118', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e8', marginBottom: 12 }}>Access Tokens</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input placeholder="Token name" value={tokenForm.name} onChange={e => setTokenForm(f => ({ ...f, name: e.target.value }))} style={{ ...inputStyle, flex: 1 }} />
            <button onClick={createToken} style={{ background: '#6366f1', border: 'none', borderRadius: 6, padding: '8px 14px', color: '#fff', fontSize: 12, cursor: 'pointer' }}>Create</button>
          </div>
          {tokens.map(t => (
            <div key={t.id} style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
              {t.name} · {t.kind} · {t.scopes} · {t.last_used ? new Date(t.last_used).toLocaleString() : 'never used'}
            </div>
          ))}
        </div>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 600, color: '#888', marginBottom: 12 }}>Connected MCP Servers (Client Mode)</h3>

      <div style={{ background: '#111118', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Server name" value={importForm.name} onChange={e => setImportForm(f => ({ ...f, name: e.target.value }))} style={{ ...inputStyle, width: 180 }} />
          <input placeholder="Server URL (http://...)" value={importForm.url} onChange={e => setImportForm(f => ({ ...f, url: e.target.value }))} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={importServer} style={{ background: '#10b981', border: 'none', borderRadius: 6, padding: '8px 14px', color: '#fff', fontSize: 12, cursor: 'pointer' }}>Import</button>
        </div>
      </div>

      {servers.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>No external MCP servers connected.</div>}
      {servers.map(s => (
        <div key={s.name} style={{
          background: '#111118', borderRadius: 8, padding: '12px 16px', marginBottom: 8,
          border: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8' }}>{s.name}</span>
            <span style={{
              marginLeft: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4,
              background: s.status === 'connected' ? '#10b98120' : '#dc262620',
              color: s.status === 'connected' ? '#10b981' : '#dc2626',
            }}>{s.status}</span>
            <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{s.transport} · {s.tools} tools{s.imported ? ' · imported' : ''}</div>
          </div>
          {s.imported && (
            <button onClick={() => removeServer(s.name)} style={{ background: '#dc2626', border: 'none', borderRadius: 6, padding: '4px 12px', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Remove</button>
          )}
        </div>
      ))}
    </div>
  );
}
