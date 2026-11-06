import React, { useState, useEffect, useCallback } from 'react';

const ACCENT = '#06d6a0';
const BG = '#0a1210';
const BORDER = '#163028';
const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const DIM = '#666';

const card = {
  background: '#101e1a', border: `1px solid ${BORDER}`, borderRadius: 10,
  padding: 16, marginBottom: 12,
};
const statCard = {
  ...card, textAlign: 'center', flex: '1 1 130px', minWidth: 120,
};
const badge = (color) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 6,
  fontSize: 11, fontWeight: 600, background: `${color}22`, color,
});

export default function CachingPanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [caches, setCaches] = useState([]);
  const [compressionData, setCompressionData] = useState(null);
  const [etagData, setEtagData] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, comp, et, h] = await Promise.all([
        fetch('/api/caching/stats').then(r => r.json()),
        fetch('/api/caching/compression').then(r => r.json()),
        fetch('/api/caching/etag').then(r => r.json()),
        fetch('/api/caching/history').then(r => r.json()),
      ]);
      setCaches(c.caches || []);
      setCompressionData(comp);
      setEtagData(et);
      setHistory(h.history || []);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (wsEvent?.type === 'health') load(); }, [wsEvent, load]);

  const totalHits = caches.reduce((a, c) => a + c.hits, 0);
  const totalMisses = caches.reduce((a, c) => a + c.misses, 0);
  const totalSize = caches.reduce((a, c) => a + c.size, 0);
  const totalCapacity = caches.reduce((a, c) => a + c.capacity, 0);
  const overallHitRate = (totalHits + totalMisses) > 0
    ? Math.round((totalHits / (totalHits + totalMisses)) * 1000) / 10 : 0;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'caches', label: 'Cache Stores' },
    { id: 'transfer', label: 'Transfer' },
    { id: 'history', label: 'History' },
  ];

  function fmtBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  }

  return (
    <div style={{ padding: 20, background: BG, minHeight: '100%', color: '#e0e0e8' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 16px', borderRadius: 8, border: `1px solid ${tab === t.id ? ACCENT : BORDER}`,
            background: tab === t.id ? `${ACCENT}22` : 'transparent', color: tab === t.id ? ACCENT : '#888',
            cursor: 'pointer', fontSize: 13, fontWeight: 500,
          }}>{t.label}</button>
        ))}
      </div>

      {error && <div style={{ ...card, borderColor: RED, color: RED, fontSize: 13 }}>{error}</div>}

      {/* TOP STAT CARDS */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: overallHitRate > 50 ? GREEN : overallHitRate > 20 ? AMBER : DIM }}>{overallHitRate}%</div>
          <div style={{ fontSize: 11, color: DIM }}>Cache Hit Rate</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT }}>{totalSize}</div>
          <div style={{ fontSize: 11, color: DIM }}>Cached Items</div>
          <div style={{ fontSize: 11, color: DIM }}>of {totalCapacity}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT }}>{compressionData?.compressionRatio || 0}%</div>
          <div style={{ fontSize: 11, color: DIM }}>Compression</div>
          <div style={{ fontSize: 11, color: DIM }}>{fmtBytes(compressionData?.savedBytes || 0)} saved</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: (etagData?.hitRate || 0) > 20 ? GREEN : DIM }}>{etagData?.hitRate || 0}%</div>
          <div style={{ fontSize: 11, color: DIM }}>ETag Hit Rate</div>
          <div style={{ fontSize: 11, color: DIM }}>{etagData?.savedResponses || 0} 304s</div>
        </div>
      </div>

      {/* OVERVIEW TAB */}
      {tab === 'overview' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Cache Summary</h4>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Hits', value: totalHits, color: GREEN },
              { label: 'Total Misses', value: totalMisses, color: AMBER },
              { label: 'Evictions', value: caches.reduce((a, c) => a + c.evictions, 0), color: RED },
              { label: 'Stores', value: caches.length, color: ACCENT },
              { label: 'Compressed', value: compressionData?.compressedCount || 0, color: GREEN },
              { label: 'Skipped', value: compressionData?.skippedCount || 0, color: DIM },
              { label: 'ETags Generated', value: etagData?.generated || 0, color: ACCENT },
              { label: 'ETag 304s', value: etagData?.hits || 0, color: GREEN },
            ].map((s, i) => (
              <div key={i} style={statCard}>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 11, color: DIM }}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={() => fetch('/api/caching/purge-expired', { method: 'POST' }).then(load)}
              style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${AMBER}`, background: `${AMBER}22`, color: AMBER, cursor: 'pointer', fontSize: 12, marginRight: 8 }}>
              Purge Expired
            </button>
            <button onClick={() => fetch('/api/caching/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(load)}
              style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${RED}`, background: `${RED}22`, color: RED, cursor: 'pointer', fontSize: 12 }}>
              Clear All Caches
            </button>
          </div>
        </div>
      )}

      {/* CACHE STORES TAB */}
      {tab === 'caches' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Cache Stores</h4>
          {caches.length === 0 && <div style={{ ...card, color: DIM }}>No cache stores active yet. Caches populate as endpoints are called.</div>}
          {caches.map((c, i) => (
            <div key={i} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: ACCENT }}>{c.name}</span>
                <span style={badge(c.hitRate > 50 ? GREEN : c.hitRate > 20 ? AMBER : DIM)}>{c.hitRate}% hit rate</span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: DIM, flexWrap: 'wrap' }}>
                <span>Size: {c.size}/{c.capacity}</span>
                <span>Hits: <span style={{ color: GREEN }}>{c.hits}</span></span>
                <span>Misses: <span style={{ color: AMBER }}>{c.misses}</span></span>
                <span>Evictions: <span style={{ color: RED }}>{c.evictions}</span></span>
                <span>TTL: {(c.defaultTtlMs / 1000).toFixed(0)}s</span>
              </div>
              {/* Utilization bar */}
              <div style={{ marginTop: 8, height: 4, background: '#1a2e28', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  width: `${(c.size / c.capacity) * 100}%`, height: '100%', borderRadius: 2,
                  background: c.size / c.capacity > 0.9 ? RED : c.size / c.capacity > 0.7 ? AMBER : ACCENT,
                }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TRANSFER TAB */}
      {tab === 'transfer' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Compression & Transfer</h4>
          {compressionData && (
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#aaa', marginBottom: 8 }}>Gzip Compression</div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: DIM, flexWrap: 'wrap' }}>
                <span>Compressed: <span style={{ color: GREEN }}>{compressionData.compressedCount}</span></span>
                <span>Skipped: {compressionData.skippedCount}</span>
                <span>Original: {fmtBytes(compressionData.totalOriginalBytes)}</span>
                <span>Compressed: {fmtBytes(compressionData.totalCompressedBytes)}</span>
                <span>Saved: <span style={{ color: GREEN }}>{fmtBytes(compressionData.savedBytes)}</span></span>
                <span>Ratio: <span style={{ color: ACCENT }}>{compressionData.compressionRatio}%</span></span>
              </div>
            </div>
          )}
          {etagData && (
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#aaa', marginBottom: 8 }}>ETag / Conditional Requests</div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: DIM, flexWrap: 'wrap' }}>
                <span>Generated: {etagData.generated}</span>
                <span>304 Hits: <span style={{ color: GREEN }}>{etagData.hits}</span></span>
                <span>Misses: {etagData.misses}</span>
                <span>Hit Rate: <span style={{ color: etagData.hitRate > 20 ? GREEN : DIM }}>{etagData.hitRate}%</span></span>
                <span>Saved Responses: {etagData.savedResponses}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* HISTORY TAB */}
      {tab === 'history' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Cache Stats History</h4>
          {history.length === 0 && <div style={{ ...card, color: DIM }}>No history snapshots yet. Snapshots record every 60 seconds.</div>}
          {history.length > 1 && (() => {
            const vals = history.map(h => h.hits);
            const maxV = Math.max(...vals, 1);
            const w = 600, h = 80;
            const points = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - (v / maxV) * h}`).join(' ');
            return (
              <div style={card}>
                <div style={{ fontSize: 12, color: DIM, marginBottom: 6 }}>Hit Count Trend ({vals.length} snapshots)</div>
                <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 80 }}>
                  <polyline points={points} fill="none" stroke={ACCENT} strokeWidth="2" />
                </svg>
              </div>
            );
          })()}
          {history.slice(-10).reverse().map((h, i) => (
            <div key={i} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
              <span style={{ color: DIM }}>{new Date(h.recorded_at).toLocaleTimeString()}</span>
              <div style={{ display: 'flex', gap: 14, color: DIM }}>
                <span>Size: {h.size}</span>
                <span>Hits: <span style={{ color: GREEN }}>{h.hits}</span></span>
                <span>Misses: <span style={{ color: AMBER }}>{h.misses}</span></span>
                <span>Evictions: <span style={{ color: RED }}>{h.evictions}</span></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
