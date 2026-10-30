import React, { useState, useEffect, useCallback } from 'react';

const S = {
  container: { padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' },
  section: { marginBottom: 28 },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: '#a78bfa', marginBottom: 12, letterSpacing: 0.5 },
  card: { background: '#12121f', border: '1px solid #222', borderRadius: 8, padding: 14, marginBottom: 10 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  badge: { fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600 },
  badgeLive: { background: '#22c55e20', color: '#22c55e', border: '1px solid #22c55e40' },
  badgeOff: { background: '#ef444420', color: '#ef4444', border: '1px solid #ef444440' },
  btn: { padding: '6px 14px', border: '1px solid #333', borderRadius: 6, background: '#1a1a2e', color: '#ccc', cursor: 'pointer', fontSize: 12 },
  btnPrimary: { padding: '6px 14px', border: 'none', borderRadius: 6, background: '#a78bfa', color: '#111', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  btnDanger: { padding: '6px 14px', border: '1px solid #ef444440', borderRadius: 6, background: '#ef444415', color: '#ef4444', cursor: 'pointer', fontSize: 12 },
  code: { background: '#0a0a14', border: '1px solid #222', borderRadius: 6, padding: '10px 14px', fontSize: 11, fontFamily: 'monospace', color: '#8b8', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', cursor: 'pointer' },
  stat: { textAlign: 'center', padding: '10px 0' },
  statNum: { fontSize: 22, fontWeight: 700, color: '#a78bfa' },
  statLabel: { fontSize: 10, color: '#666', marginTop: 2 },
  input: { padding: '6px 10px', border: '1px solid #333', borderRadius: 6, background: '#0a0a14', color: '#e0e0e8', fontSize: 12, flex: 1 },
  empty: { textAlign: 'center', padding: 40, color: '#555', fontSize: 13 },
};

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button style={S.btn} onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function EndpointCard({ ep, onUndeploy }) {
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState(null);
  const host = window.location.origin;
  const curl = `curl -X POST ${host}/api/run/${ep.slug} \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "hello"}'`;

  useEffect(() => {
    if (expanded && !stats) {
      fetch(`/api/deploy/usage/${ep.slug}`).then(r => r.json()).then(setStats).catch(() => {});
    }
  }, [expanded, ep.slug, stats]);

  return (
    <div style={S.card}>
      <div style={S.row}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{ep.name}</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
            <code style={{ color: '#a78bfa' }}>POST /api/run/{ep.slug}</code>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ ...S.badge, ...S.badgeLive }}>LIVE</span>
          <button style={S.btn} onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide' : 'Details'}</button>
          <button style={S.btnDanger} onClick={() => onUndeploy(ep.id)}>Undeploy</button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>curl example:</div>
          <div style={S.code} onClick={() => navigator.clipboard.writeText(curl)}>{curl}</div>
          {stats?.stats && (
            <div style={{ display: 'flex', gap: 20, marginTop: 14 }}>
              <div style={S.stat}><div style={S.statNum}>{stats.stats.total}</div><div style={S.statLabel}>Total calls</div></div>
              <div style={S.stat}><div style={S.statNum}>{stats.stats.today}</div><div style={S.statLabel}>Today</div></div>
              <div style={S.stat}><div style={S.statNum}>{stats.stats.avgDurationMs}ms</div><div style={S.statLabel}>Avg latency</div></div>
              <div style={S.stat}><div style={S.statNum}>{stats.stats.errors}</div><div style={S.statLabel}>Errors</div></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DeployPanel({ wsEvent }) {
  const [endpoints, setEndpoints] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [globalUsage, setGlobalUsage] = useState(null);
  const [newTokenName, setNewTokenName] = useState('');
  const [newToken, setNewToken] = useState(null);

  const load = useCallback(() => {
    fetch('/api/deploy/catalog').then(r => r.json()).then(d => setEndpoints(d.endpoints || [])).catch(() => {});
    fetch('/api/access').then(r => r.json()).then(d => setTokens(d.tokens || [])).catch(() => {});
    fetch('/api/deploy/usage').then(r => r.json()).then(setGlobalUsage).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'workflow' || wsEvent?.type === 'deploy') load();
  }, [wsEvent, load]);

  const createKey = () => {
    const name = newTokenName.trim() || 'api-key';
    fetch('/api/access/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scopes: 'read run' }) })
      .then(r => r.json())
      .then(d => { setNewToken(d); setNewTokenName(''); load(); })
      .catch(() => {});
  };

  const revokeKey = (id) => {
    fetch(`/api/access/tokens/${id}`, { method: 'DELETE' }).then(() => load()).catch(() => {});
  };

  const undeploy = (id) => {
    fetch(`/api/workflows/${id}/undeploy`, { method: 'POST' }).then(() => load()).catch(() => {});
  };

  return (
    <div style={S.container}>
      {globalUsage && (
        <div style={S.section}>
          <div style={S.sectionTitle}>API Usage Overview</div>
          <div style={{ display: 'flex', gap: 20 }}>
            <div style={S.stat}><div style={S.statNum}>{endpoints.length}</div><div style={S.statLabel}>Deployed</div></div>
            <div style={S.stat}><div style={S.statNum}>{globalUsage.total}</div><div style={S.statLabel}>Total calls</div></div>
            <div style={S.stat}><div style={S.statNum}>{globalUsage.today}</div><div style={S.statLabel}>Today</div></div>
            <div style={S.stat}><div style={S.statNum}>{tokens.length}</div><div style={S.statLabel}>API keys</div></div>
          </div>
        </div>
      )}

      <div style={S.section}>
        <div style={S.sectionTitle}>Deployed Endpoints</div>
        {endpoints.length === 0 ? (
          <div style={S.empty}>No workflows deployed yet. Go to Canvas, build a workflow, then deploy it.</div>
        ) : endpoints.map(ep => (
          <EndpointCard key={ep.id} ep={ep} onUndeploy={undeploy} />
        ))}
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>API Keys</div>
        <div style={{ ...S.row, marginBottom: 10 }}>
          <input style={S.input} placeholder="Key name (e.g. my-app)" value={newTokenName} onChange={e => setNewTokenName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createKey()} />
          <button style={S.btnPrimary} onClick={createKey}>Generate Key</button>
        </div>
        {newToken && (
          <div style={{ ...S.card, borderColor: '#22c55e40' }}>
            <div style={{ fontSize: 11, color: '#22c55e', marginBottom: 6, fontWeight: 600 }}>New API key created — copy it now, it won't be shown again:</div>
            <div style={{ ...S.row }}>
              <code style={{ fontSize: 12, color: '#8b8', wordBreak: 'break-all' }}>{newToken.token}</code>
              <CopyButton text={newToken.token} />
            </div>
            <button style={{ ...S.btn, marginTop: 8, fontSize: 10 }} onClick={() => setNewToken(null)}>Dismiss</button>
          </div>
        )}
        {tokens.map(t => (
          <div key={t.id} style={{ ...S.card, ...S.row }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{t.name || 'Unnamed'}</div>
              <div style={{ fontSize: 10, color: '#666' }}>
                Scopes: {t.scopes} {t.last_used ? `· Last used: ${new Date(t.last_used).toLocaleDateString()}` : '· Never used'}
              </div>
            </div>
            <button style={S.btnDanger} onClick={() => revokeKey(t.id)}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}
