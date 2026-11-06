import React, { useState, useEffect, useCallback } from 'react';

const ACCENT = '#a855f7';
const BG = '#0d0a14';
const BORDER = '#1e1530';
const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const DIM = '#666';

const card = {
  background: '#12101c', border: `1px solid ${BORDER}`, borderRadius: 10,
  padding: 16, marginBottom: 12,
};
const badge = (color) => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 6,
  fontSize: 11, fontWeight: 600, background: `${color}22`, color,
});
const statCard = {
  ...card, textAlign: 'center', flex: '1 1 140px', minWidth: 130,
};

export default function PerformancePanel({ wsEvent }) {
  const [tab, setTab] = useState('endpoints');
  const [endpoints, setEndpoints] = useState([]);
  const [volume, setVolume] = useState([]);
  const [slowReqs, setSlowReqs] = useState([]);
  const [queryData, setQueryData] = useState(null);
  const [memData, setMemData] = useState(null);
  const [memHistory, setMemHistory] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [ep, vol, slow, q, m, mh] = await Promise.all([
        fetch('/api/profiling/endpoints').then(r => r.json()),
        fetch('/api/profiling/volume').then(r => r.json()),
        fetch('/api/profiling/slow').then(r => r.json()),
        fetch('/api/profiling/queries').then(r => r.json()),
        fetch('/api/profiling/memory').then(r => r.json()),
        fetch('/api/profiling/memory/history').then(r => r.json()),
      ]);
      setEndpoints(ep.endpoints || []);
      setVolume(vol.volume || []);
      setSlowReqs(slow.slowRequests || []);
      setQueryData(q);
      setMemData(m);
      setMemHistory(mh.history || []);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (wsEvent?.type === 'health') load(); }, [wsEvent, load]);

  const tabs = [
    { id: 'endpoints', label: 'Endpoints' },
    { id: 'queries', label: 'Queries' },
    { id: 'memory', label: 'Memory' },
    { id: 'slow', label: 'Slow Log' },
  ];

  const heapPct = memData?.current ? memData.current.heapUtilization : 0;
  const heapColor = heapPct > 85 ? RED : heapPct > 65 ? AMBER : GREEN;
  const trendColor = memData?.stats?.heapTrend === 'growing' ? AMBER : memData?.stats?.heapTrend === 'shrinking' ? GREEN : DIM;

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

      {/* OVERVIEW STAT CARDS */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {volume.map(v => (
          <div key={v.interval} style={statCard}>
            <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT }}>{v.count}</div>
            <div style={{ fontSize: 11, color: DIM }}>{v.interval} requests</div>
            <div style={{ fontSize: 11, color: v.avgMs > 500 ? AMBER : DIM }}>{v.avgMs}ms avg</div>
            {v.errorCount > 0 && <div style={{ fontSize: 11, color: RED }}>{v.errorCount} errors</div>}
          </div>
        ))}
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: heapColor }}>{memData?.current?.heapUsedMb || 0}</div>
          <div style={{ fontSize: 11, color: DIM }}>Heap MB</div>
          <div style={{ fontSize: 11, color: heapColor }}>{heapPct}% used</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 700, color: trendColor }}>{memData?.stats?.heapTrend || '—'}</div>
          <div style={{ fontSize: 11, color: DIM }}>Heap Trend</div>
          <div style={{ fontSize: 11, color: DIM }}>{memData?.current?.uptimeSeconds ? `${Math.round(memData.current.uptimeSeconds / 60)}m uptime` : ''}</div>
        </div>
      </div>

      {/* ENDPOINTS TAB */}
      {tab === 'endpoints' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Slowest Endpoints (1h)</h4>
          {endpoints.length === 0 && <div style={{ ...card, color: DIM }}>No request data yet. Endpoints appear after traffic flows.</div>}
          {endpoints.map((ep, i) => (
            <div key={i} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ flex: '1 1 200px' }}>
                <span style={badge(ACCENT)}>{ep.method}</span>
                <span style={{ marginLeft: 8, fontSize: 13, fontFamily: 'monospace' }}>{ep.path}</span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: DIM }}>
                <span>{ep.cnt} req</span>
                <span style={{ color: ep.avg_ms > 500 ? AMBER : ep.avg_ms > 1000 ? RED : '#aaa' }}>
                  avg {ep.avg_ms}ms
                </span>
                <span>max {Math.round(ep.max_ms)}ms</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* QUERIES TAB */}
      {tab === 'queries' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Query Performance</h4>
          {queryData?.profile && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <div style={statCard}>
                <div style={{ fontSize: 22, fontWeight: 700, color: queryData.profile.slowCount > 10 ? AMBER : GREEN }}>{queryData.profile.slowCount}</div>
                <div style={{ fontSize: 11, color: DIM }}>Slow queries (1h)</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT }}>{queryData.profile.avgMs}</div>
                <div style={{ fontSize: 11, color: DIM }}>Avg slow ms</div>
              </div>
              <div style={statCard}>
                <div style={{ fontSize: 22, fontWeight: 700, color: queryData.profile.maxMs > 200 ? RED : AMBER }}>{queryData.profile.maxMs}</div>
                <div style={{ fontSize: 11, color: DIM }}>Max slow ms</div>
              </div>
            </div>
          )}
          <h4 style={{ fontSize: 13, color: '#aaa', marginBottom: 8 }}>Top Queries by Total Time</h4>
          {(queryData?.stats || []).map((q, i) => (
            <div key={i} style={{ ...card, fontSize: 12 }}>
              <div style={{ fontFamily: 'monospace', color: '#c4b5fd', marginBottom: 4, wordBreak: 'break-all' }}>{q.sql}</div>
              <div style={{ display: 'flex', gap: 16, color: DIM }}>
                <span>{q.count} calls</span>
                <span>avg {q.avgMs}ms</span>
                <span style={{ color: q.maxMs > 100 ? AMBER : DIM }}>max {q.maxMs}ms</span>
                <span>total {q.totalMs}ms</span>
              </div>
            </div>
          ))}
          {(!queryData?.stats || queryData.stats.length === 0) && (
            <div style={{ ...card, color: DIM }}>No query stats yet. Stats populate as the server processes queries.</div>
          )}
        </div>
      )}

      {/* MEMORY TAB */}
      {tab === 'memory' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Memory & Process</h4>
          {memData?.current && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { label: 'Heap Used', value: `${memData.current.heapUsedMb} MB`, color: heapColor },
                { label: 'Heap Total', value: `${memData.current.heapTotalMb} MB`, color: ACCENT },
                { label: 'RSS', value: `${memData.current.rssMb} MB`, color: memData.current.rssMb > 500 ? AMBER : GREEN },
                { label: 'External', value: `${memData.current.externalMb} MB`, color: DIM },
                { label: 'ArrayBuffers', value: `${memData.current.arrayBuffersMb} MB`, color: DIM },
                { label: 'CPU User', value: `${memData.current.cpuUserMs}ms`, color: DIM },
                { label: 'CPU System', value: `${memData.current.cpuSystemMs}ms`, color: DIM },
                { label: 'Loop Lag', value: `${memData.stats?.avg_loop_lag || 0}ms avg`, color: (memData.stats?.avg_loop_lag || 0) > 10 ? AMBER : GREEN },
              ].map((s, i) => (
                <div key={i} style={statCard}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: DIM }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Mini SVG sparkline for heap history */}
          {memHistory.length > 1 && (() => {
            const vals = memHistory.map(h => h.heap_used_mb);
            const maxV = Math.max(...vals, 1);
            const w = 600, h = 100;
            const points = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - (v / maxV) * h}`).join(' ');
            return (
              <div style={{ ...card }}>
                <div style={{ fontSize: 12, color: DIM, marginBottom: 6 }}>Heap Usage Trend ({vals.length} samples)</div>
                <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 100 }}>
                  <polyline points={points} fill="none" stroke={ACCENT} strokeWidth="2" />
                  <text x="0" y="12" fill={DIM} fontSize="10">{Math.round(maxV)} MB</text>
                  <text x="0" y={h - 2} fill={DIM} fontSize="10">0 MB</text>
                </svg>
              </div>
            );
          })()}

          {memData?.stats && (
            <div style={card}>
              <div style={{ fontSize: 12, color: DIM, marginBottom: 6 }}>1-Hour Stats ({memData.stats.sample_count} samples)</div>
              <div style={{ display: 'flex', gap: 20, fontSize: 12, flexWrap: 'wrap' }}>
                <span>Heap: {memData.stats.min_heap}–{memData.stats.max_heap} MB (avg {memData.stats.avg_heap})</span>
                <span>RSS avg: {memData.stats.avg_rss} MB, max: {memData.stats.max_rss} MB</span>
                <span>Loop lag: avg {memData.stats.avg_loop_lag}ms, max {memData.stats.max_loop_lag}ms</span>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => fetch('/api/profiling/memory/start', { method: 'POST' }).then(load)}
              style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${GREEN}`, background: `${GREEN}22`, color: GREEN, cursor: 'pointer', fontSize: 12 }}>
              Start Tracking
            </button>
            <button onClick={() => fetch('/api/profiling/memory/stop', { method: 'POST' }).then(load)}
              style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${RED}`, background: `${RED}22`, color: RED, cursor: 'pointer', fontSize: 12 }}>
              Stop Tracking
            </button>
            <button onClick={() => fetch('/api/profiling/memory/snapshot', { method: 'POST' }).then(load)}
              style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${ACCENT}`, background: `${ACCENT}22`, color: ACCENT, cursor: 'pointer', fontSize: 12 }}>
              Snapshot Now
            </button>
          </div>
        </div>
      )}

      {/* SLOW LOG TAB */}
      {tab === 'slow' && (
        <div>
          <h4 style={{ fontSize: 14, color: ACCENT, marginBottom: 10 }}>Slow Request Log (&ge;1s)</h4>
          {slowReqs.length === 0 && <div style={{ ...card, color: DIM }}>No slow requests recorded yet.</div>}
          {slowReqs.map((r, i) => (
            <div key={i} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <div>
                <span style={badge(r.status >= 400 ? RED : ACCENT)}>{r.method} {r.status}</span>
                <span style={{ marginLeft: 8, fontSize: 13, fontFamily: 'monospace' }}>{r.path}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 12, color: DIM }}>
                <span style={{ color: r.duration_ms > 2000 ? RED : AMBER }}>{Math.round(r.duration_ms)}ms</span>
                <span>{new Date(r.created_at).toLocaleTimeString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
