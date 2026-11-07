import { useState, useEffect, useCallback } from 'react';

const ACCENT = '#8b5cf6';
const BG = '#0a070d';

const statCard = (label, value, sub) => (
  <div style={{ background: '#1a1225', border: `1px solid ${ACCENT}33`, borderRadius: 10, padding: '14px 16px', minWidth: 90, textAlign: 'center' }}>
    <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT }}>{value}</div>
    <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{label}</div>
    {sub && <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{sub}</div>}
  </div>
);

export default function GatewayPanel({ wsEvent }) {
  const [tab, setTab] = useState('limiter');
  const [limiterData, setLimiterData] = useState(null);
  const [validatorData, setValidatorData] = useState(null);
  const [catalogData, setCatalogData] = useState(null);
  const [limiterHistory, setLimiterHistory] = useState([]);
  const [validatorHistory, setValidatorHistory] = useState([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [error, setError] = useState('');

  const loadLimiter = useCallback(async () => {
    try {
      const [status, history] = await Promise.all([
        fetch('/api/gateway/rate-limiter').then(r => r.json()),
        fetch('/api/gateway/rate-limiter/history?limit=20').then(r => r.json()),
      ]);
      setLimiterData(status);
      setLimiterHistory(history);
    } catch (e) { setError(e.message); }
  }, []);

  const loadValidator = useCallback(async () => {
    try {
      const [status, history] = await Promise.all([
        fetch('/api/gateway/validator').then(r => r.json()),
        fetch('/api/gateway/validator/history?limit=20').then(r => r.json()),
      ]);
      setValidatorData(status);
      setValidatorHistory(history);
    } catch (e) { setError(e.message); }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const url = catalogFilter
        ? `/api/gateway/catalog?category=${catalogFilter}`
        : '/api/gateway/catalog';
      const data = await fetch(url).then(r => r.json());
      setCatalogData(data);
    } catch (e) { setError(e.message); }
  }, [catalogFilter]);

  useEffect(() => {
    if (tab === 'limiter') loadLimiter();
    if (tab === 'validator') loadValidator();
    if (tab === 'catalog') loadCatalog();
  }, [tab, loadLimiter, loadValidator, loadCatalog]);

  useEffect(() => {
    if (wsEvent?.type === 'gateway') {
      if (tab === 'limiter') loadLimiter();
      if (tab === 'validator') loadValidator();
    }
  }, [wsEvent, tab, loadLimiter, loadValidator]);

  const tabBtn = (id, label) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: '6px 16px', border: 'none', borderRadius: 6, cursor: 'pointer',
        background: tab === id ? ACCENT : '#1a1225',
        color: tab === id ? '#fff' : '#aaa',
        fontSize: 13, fontWeight: 600,
      }}
    >{label}</button>
  );

  return (
    <div style={{ background: BG, color: '#e0e0e0', padding: 16, fontFamily: 'system-ui, sans-serif', minHeight: '100%' }}>
      <h2 style={{ color: ACCENT, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🚪</span> API Gateway
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {tabBtn('limiter', 'Rate Limiter')}
        {tabBtn('validator', 'Validator')}
        {tabBtn('catalog', 'API Catalog')}
      </div>

      {error && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {tab === 'limiter' && limiterData && (
        <div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {statCard('Active Windows', limiterData.activeWindows)}
            {statCard('Route Rules', Object.keys(limiterData.routeLimits).length)}
          </div>

          <h4 style={{ color: ACCENT, fontSize: 13, margin: '12px 0 8px' }}>Route Limits</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(limiterData.routeLimits).map(([prefix, cfg]) => (
              <div key={prefix} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#1a1225', borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{prefix}</span>
                <span style={{ color: ACCENT }}>{cfg.maxRequests} req/{Math.round(cfg.windowMs / 1000)}s</span>
              </div>
            ))}
          </div>

          {limiterData.windows.length > 0 && (
            <>
              <h4 style={{ color: ACCENT, fontSize: 13, margin: '16px 0 8px' }}>Active Windows</h4>
              {limiterData.windows.map((w, i) => (
                <div key={i} style={{ padding: '6px 10px', background: '#1a1225', borderRadius: 6, marginBottom: 4, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{w.ip} → {w.prefix}</span>
                  <span>hits: {w.activeHits} {w.blocked > 0 && <span style={{ color: '#f87171' }}>blocked: {w.blocked}</span>}</span>
                </div>
              ))}
            </>
          )}

          {limiterHistory.length > 0 && (
            <>
              <h4 style={{ color: '#f87171', fontSize: 13, margin: '16px 0 8px' }}>Blocked Requests</h4>
              {limiterHistory.map((e, i) => (
                <div key={i} style={{ padding: '6px 10px', background: '#1a0a0a', border: '1px solid #f8717133', borderRadius: 6, marginBottom: 4, fontSize: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#f87171' }}>{e.ip}</span>
                    <span style={{ color: '#666' }}>{e.created_at}</span>
                  </div>
                  <div style={{ color: '#aaa' }}>{e.route_prefix} — {e.window_hits}/{e.limit_max}</div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'validator' && validatorData && (
        <div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {statCard('Total Violations', validatorData.totalViolations)}
            {statCard('Last Hour', validatorData.lastHour)}
            {statCard('Max Body', `${Math.round(validatorData.config.maxBodySize / 1048576)}MB`)}
            {statCard('Max URL', validatorData.config.maxUrlLength)}
          </div>

          {validatorData.byType.length > 0 && (
            <>
              <h4 style={{ color: ACCENT, fontSize: 13, margin: '12px 0 8px' }}>By Violation Type</h4>
              {validatorData.byType.map((v, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#1a1225', borderRadius: 6, marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: '#ccc' }}>{v.violation}</span>
                  <span style={{ color: ACCENT, fontWeight: 700 }}>{v.count}</span>
                </div>
              ))}
            </>
          )}

          {validatorHistory.length > 0 && (
            <>
              <h4 style={{ color: '#fbbf24', fontSize: 13, margin: '16px 0 8px' }}>Recent Violations</h4>
              {validatorHistory.map((v, i) => (
                <div key={i} style={{ padding: '6px 10px', background: '#1a1a0a', border: '1px solid #fbbf2433', borderRadius: 6, marginBottom: 4, fontSize: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#fbbf24' }}>{v.violation}</span>
                    <span style={{ color: '#666' }}>{v.created_at}</span>
                  </div>
                  <div style={{ color: '#aaa' }}>{v.ip} → {v.path}</div>
                  {v.detail && <div style={{ color: '#666', fontFamily: 'monospace' }}>{v.detail}</div>}
                </div>
              ))}
            </>
          )}

          <h4 style={{ color: ACCENT, fontSize: 13, margin: '16px 0 8px' }}>Allowed Content Types</h4>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(validatorData.config.allowedContentTypes || []).map((ct, i) => (
              <span key={i} style={{ padding: '3px 8px', background: `${ACCENT}22`, border: `1px solid ${ACCENT}44`, borderRadius: 4, fontSize: 11, color: ACCENT }}>{ct}</span>
            ))}
          </div>
        </div>
      )}

      {tab === 'catalog' && catalogData && (
        <div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {statCard('Endpoints', catalogData.endpointCount)}
            {statCard('GET', catalogData.methodCounts?.GET || 0)}
            {statCard('POST', catalogData.methodCounts?.POST || 0)}
            {statCard('Categories', Object.keys(catalogData.categoryCounts || {}).length)}
          </div>

          <h4 style={{ color: ACCENT, fontSize: 13, margin: '12px 0 8px' }}>Filter by Category</h4>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <button onClick={() => setCatalogFilter('')}
              style={{ padding: '3px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                background: !catalogFilter ? ACCENT : '#1a1225', color: !catalogFilter ? '#fff' : '#aaa' }}>
              All
            </button>
            {Object.entries(catalogData.categoryCounts || {}).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
              <button key={cat} onClick={() => setCatalogFilter(cat)}
                style={{ padding: '3px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  background: catalogFilter === cat ? ACCENT : '#1a1225', color: catalogFilter === cat ? '#fff' : '#aaa' }}>
                {cat} ({count})
              </button>
            ))}
          </div>

          <h4 style={{ color: ACCENT, fontSize: 13, margin: '12px 0 8px' }}>
            Endpoints {catalogData.filtered && `(${catalogFilter})`}
          </h4>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {(catalogData.endpoints || []).map((ep, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a1225' : '#120e1a', borderRadius: 4, marginBottom: 2, fontSize: 11, alignItems: 'center' }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontWeight: 700, fontSize: 10,
                  background: ep.method === 'GET' ? '#22c55e22' : ep.method === 'POST' ? '#3b82f622' : '#f59e0b22',
                  color: ep.method === 'GET' ? '#22c55e' : ep.method === 'POST' ? '#3b82f6' : '#f59e0b',
                  minWidth: 36, textAlign: 'center',
                }}>{ep.method}</span>
                <span style={{ color: '#ccc', fontFamily: 'monospace', flex: 1 }}>{ep.path}</span>
                <span style={{ color: '#666', fontSize: 10 }}>{ep.category}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
