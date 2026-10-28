import React, { useState, useEffect } from 'react';

const card = { background: '#141420', borderRadius: 8, padding: 16, border: '1px solid #222' };
const btn = (color = '#7c3aed') => ({
  padding: '8px 16px', border: 'none', borderRadius: 6, background: color,
  color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500,
});

export default function BrowserPanel() {
  const [status, setStatus] = useState(null);
  const [extStatus, setExtStatus] = useState(null);
  const [url, setUrl] = useState('');
  const [pages, setPages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    fetch('/api/browser/status').then(r => r.json()).then(d => { setStatus(d); setPages(d.pages || []); }).catch(() => {});
    fetch('/api/extension/status').then(r => r.json()).then(setExtStatus).catch(() => {});
  };

  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);

  const openPage = async () => {
    if (!url) return;
    setLoading(true);
    try {
      const r = await fetch('/api/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const data = await r.json();
      setSelected(data.pageId);
      setResult(data);
      refresh();
    } catch (e) { setResult({ error: e.message }); }
    setLoading(false);
  };

  const doAction = async (action, pageId, body = {}) => {
    setLoading(true);
    try {
      const method = action.startsWith('GET') ? 'GET' : action === 'DELETE' ? 'DELETE' : 'POST';
      const path = action.replace(/^(GET|POST|DELETE)\s+/, '');
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (method === 'POST') opts.body = JSON.stringify(body);
      const r = await fetch(path, opts);
      const data = await r.json();
      setResult(data);
      refresh();
    } catch (e) { setResult({ error: e.message }); }
    setLoading(false);
  };

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <h2 style={{ color: '#a78bfa', fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Browser</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        {/* Puppeteer Status */}
        <div style={card}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>Headless Browser (Puppeteer)</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: status?.running ? '#22c55e' : status?.available ? '#f59e0b' : '#ef4444',
              boxShadow: status?.running ? '0 0 6px #22c55e' : 'none',
            }} />
            <span style={{ color: '#e0e0e8', fontSize: 14 }}>
              {status?.running ? `Running (${pages.length} pages)` : status?.available ? 'Available (idle)' : 'Puppeteer not installed'}
            </span>
          </div>
        </div>

        {/* Extension Status */}
        <div style={card}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>Chrome Extension Bridge</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: extStatus?.connections?.length ? '#22c55e' : '#ef4444',
              boxShadow: extStatus?.connections?.length ? '0 0 6px #22c55e' : 'none',
            }} />
            <span style={{ color: '#e0e0e8', fontSize: 14 }}>
              {extStatus?.connections?.length ? `${extStatus.connections.length} browser(s) connected` : 'No Chrome extension connected'}
            </span>
          </div>
          {extStatus?.connections?.map(c => (
            <div key={c.id} style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              ID: {c.id} — {c.tabs?.length || 0} tabs visible
            </div>
          ))}
        </div>
      </div>

      {/* Open URL */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#c084fc', marginBottom: 10 }}>Open Headless Page</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com"
            onKeyDown={e => e.key === 'Enter' && openPage()}
            style={{
              flex: 1, padding: '8px 12px', background: '#1a1a2e', border: '1px solid #333',
              borderRadius: 6, color: '#e0e0e8', fontSize: 13, outline: 'none',
            }} />
          <button onClick={openPage} disabled={loading} style={btn()}>Open</button>
        </div>
      </div>

      {/* Open Pages */}
      {pages.length > 0 && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#c084fc', marginBottom: 10 }}>Open Pages</div>
          {pages.map(p => (
            <div key={p.id} onClick={() => setSelected(p.id)} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', marginBottom: 4, borderRadius: 6, cursor: 'pointer',
              background: selected === p.id ? '#1a1a3e' : '#111118',
              border: selected === p.id ? '1px solid #7c3aed' : '1px solid transparent',
            }}>
              <div>
                <div style={{ fontSize: 13, color: '#e0e0e8' }}>{p.url}</div>
                <div style={{ fontSize: 11, color: '#666' }}>ID: {p.id}</div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={e => { e.stopPropagation(); doAction(`POST /api/browser/pages/${p.id}/screenshot`); }} style={btn('#374151')} title="Screenshot">📷</button>
                <button onClick={e => { e.stopPropagation(); doAction(`GET /api/browser/pages/${p.id}/text`); }} style={btn('#374151')} title="Extract Text">📄</button>
                <button onClick={e => { e.stopPropagation(); doAction(`GET /api/browser/pages/${p.id}/links`); }} style={btn('#374151')} title="Extract Links">🔗</button>
                <button onClick={e => { e.stopPropagation(); doAction(`DELETE /api/browser/pages/${p.id}`); }} style={btn('#991b1b')} title="Close">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Extension Tabs */}
      {extStatus?.connections?.some(c => c.tabs?.length) && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#c084fc', marginBottom: 10 }}>Chrome Tabs (via Extension)</div>
          {extStatus.connections.flatMap(c => (c.tabs || []).map(t => (
            <div key={`${c.id}-${t.id}`} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', marginBottom: 4, borderRadius: 6,
              background: '#111118',
            }}>
              <div>
                <div style={{ fontSize: 13, color: '#e0e0e8' }}>{t.title || t.url}</div>
                <div style={{ fontSize: 11, color: '#666' }}>{t.url}</div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => doAction(`POST /api/extension/${c.id}/screenshot`, null, { tabId: t.id })} style={btn('#374151')} title="Screenshot">📷</button>
                <button onClick={() => doAction(`POST /api/extension/${c.id}/text`, null, { tabId: t.id })} style={btn('#374151')} title="Extract Text">📄</button>
              </div>
            </div>
          )))}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c084fc' }}>Result</div>
            <button onClick={() => setResult(null)} style={{ ...btn('#374151'), padding: '4px 10px', fontSize: 11 }}>Clear</button>
          </div>
          {result.dataUrl && <img src={result.dataUrl} style={{ maxWidth: '100%', borderRadius: 6, marginBottom: 8 }} alt="screenshot" />}
          {result.filepath && <div style={{ fontSize: 12, color: '#22c55e' }}>Saved: {result.filepath}</div>}
          <pre style={{
            background: '#0a0a0f', padding: 12, borderRadius: 6, fontSize: 12,
            color: '#888', overflow: 'auto', maxHeight: 300,
          }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
