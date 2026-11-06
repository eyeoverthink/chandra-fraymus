import { useState, useEffect, useCallback } from 'react';

const ACCENT = '#f59e0b';
const BG = '#0f0d08';
const CARD = '#1a1708';
const BORDER = '#2a2510';
const TEXT = '#e8e0c8';
const DIM = '#8a7e5a';
const RED = '#ef4444';
const GREEN = '#22c55e';
const BLUE = '#3b82f6';

export default function DbOptimizePanel({ wsEvent }) {
  const [tab, setTab] = useState('tables');
  const [tables, setTables] = useState([]);
  const [analysis, setAnalysis] = useState([]);
  const [wal, setWal] = useState(null);
  const [operations, setOperations] = useState([]);
  const [retention, setRetention] = useState(null);
  const [retentionPreview, setRetentionPreview] = useState([]);
  const [retentionHistory, setRetentionHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedTable, setExpandedTable] = useState(null);

  const load = useCallback(async () => {
    try {
      const [tRes, aRes, wRes, oRes, rRes] = await Promise.all([
        fetch('/api/db-optimize/tables'),
        fetch('/api/db-optimize/analysis'),
        fetch('/api/db-optimize/wal'),
        fetch('/api/db-optimize/operations?limit=20'),
        fetch('/api/db-optimize/retention'),
      ]);
      if (tRes.ok) setTables((await tRes.json()).tables || []);
      if (aRes.ok) setAnalysis((await aRes.json()).history || []);
      if (wRes.ok) { const d = await wRes.json(); setWal(d); }
      if (oRes.ok) setOperations((await oRes.json()).operations || []);
      if (rRes.ok) setRetention(await rRes.json());
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);
  useEffect(() => { if (wsEvent?.type === 'health') load(); }, [wsEvent, load]);

  const doAction = async (url, method = 'POST') => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(url, { method });
      const d = await res.json();
      if (d.error) setError(d.error);
      await load();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const loadPreview = async () => {
    try {
      const res = await fetch('/api/db-optimize/retention/preview');
      if (res.ok) setRetentionPreview((await res.json()).preview || []);
    } catch (_) {}
  };

  const loadRetentionHistory = async () => {
    try {
      const res = await fetch('/api/db-optimize/retention/history');
      if (res.ok) setRetentionHistory((await res.json()).history || []);
    } catch (_) {}
  };

  const fmtBytes = (b) => {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  };

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return d.toLocaleTimeString();
  };

  const totalRows = tables.reduce((s, t) => s + (t.rowCount || 0), 0);
  const totalSize = tables.reduce((s, t) => s + (t.sizeBytes || 0), 0);
  const totalIndexes = tables.reduce((s, t) => s + (t.indexes?.length || 0), 0);

  const tabs = ['tables', 'indexes', 'wal', 'retention'];

  return (
    <div style={{ background: BG, color: TEXT, minHeight: '100%', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>🗃️</span>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: ACCENT }}>Database Optimization</h2>
      </div>

      {error && <div style={{ background: '#2a0a0a', border: `1px solid ${RED}`, padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13, color: RED }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: ACCENT }}>{tables.length}</div>
          <div style={{ fontSize: 11, color: DIM }}>Tables</div>
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: ACCENT }}>{totalRows.toLocaleString()}</div>
          <div style={{ fontSize: 11, color: DIM }}>Total Rows</div>
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: ACCENT }}>{fmtBytes(totalSize)}</div>
          <div style={{ fontSize: 11, color: DIM }}>DB Size</div>
        </div>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: ACCENT }}>{totalIndexes}</div>
          <div style={{ fontSize: 11, color: DIM }}>Indexes</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `1px solid ${BORDER}`, paddingBottom: 4 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => {
            setTab(t);
            if (t === 'retention') { loadPreview(); loadRetentionHistory(); }
          }} style={{
            background: tab === t ? ACCENT + '22' : 'transparent',
            border: tab === t ? `1px solid ${ACCENT}` : '1px solid transparent',
            color: tab === t ? ACCENT : DIM,
            padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
            textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>

      {tab === 'tables' && (
        <div>
          <div style={{ fontSize: 13, color: DIM, marginBottom: 10 }}>Click a table to inspect columns and indexes</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tables.sort((a, b) => (b.rowCount || 0) - (a.rowCount || 0)).map(t => (
              <div key={t.name}>
                <div onClick={() => setExpandedTable(expandedTable === t.name ? null : t.name)} style={{
                  background: CARD, border: `1px solid ${expandedTable === t.name ? ACCENT : BORDER}`,
                  borderRadius: 6, padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{t.name}</span>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: DIM }}>
                    <span>{(t.rowCount || 0).toLocaleString()} rows</span>
                    <span>{fmtBytes(t.sizeBytes || 0)}</span>
                    <span>{t.indexes?.length || 0} idx</span>
                  </div>
                </div>
                {expandedTable === t.name && (
                  <div style={{ background: CARD, borderLeft: `2px solid ${ACCENT}`, marginLeft: 12, padding: 10, fontSize: 12 }}>
                    <div style={{ marginBottom: 6, fontWeight: 600, color: ACCENT }}>Columns</div>
                    {(t.columns || []).map(c => (
                      <div key={c.name} style={{ display: 'flex', gap: 8, padding: '2px 0', color: DIM }}>
                        <span style={{ fontFamily: 'monospace', color: TEXT, minWidth: 140 }}>{c.name}</span>
                        <span>{c.type || '—'}</span>
                        {c.pk ? <span style={{ color: ACCENT, fontSize: 10, fontWeight: 700 }}>PK</span> : null}
                        {c.notnull ? <span style={{ fontSize: 10 }}>NOT NULL</span> : null}
                      </div>
                    ))}
                    {(t.indexes?.length > 0) && (
                      <>
                        <div style={{ marginTop: 8, marginBottom: 4, fontWeight: 600, color: BLUE }}>Indexes</div>
                        {t.indexes.map((idx, i) => (
                          <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: DIM, padding: '2px 0' }}>
                            {idx.name} ({(idx.columns || []).map(c => c.name).join(', ')})
                            {idx.unique ? <span style={{ color: ACCENT, marginLeft: 6 }}>UNIQUE</span> : null}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'indexes' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={() => doAction('/api/db-optimize/analyze')} disabled={loading} style={{
              background: ACCENT, color: '#000', border: 'none', padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1,
            }}>Run Analysis</button>
          </div>
          {analysis.length === 0 && <div style={{ color: DIM, fontSize: 13 }}>No recommendations. Run analysis to scan for missing indexes.</div>}
          {analysis.map(a => (
            <div key={a.id} style={{
              background: CARD, border: `1px solid ${a.applied ? GREEN + '44' : a.severity === 'high' ? RED + '44' : BORDER}`,
              borderRadius: 6, padding: 10, marginBottom: 6,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{a.table_name}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: a.severity === 'high' ? RED + '22' : a.severity === 'medium' ? ACCENT + '22' : BLUE + '22',
                    color: a.severity === 'high' ? RED : a.severity === 'medium' ? ACCENT : BLUE,
                  }}>{a.severity}</span>
                  {a.applied ? <span style={{ fontSize: 10, color: GREEN, fontWeight: 700 }}>APPLIED</span> : null}
                </div>
              </div>
              <div style={{ fontSize: 12, color: DIM, marginBottom: 4 }}>{a.detail}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: TEXT, background: BG, padding: 6, borderRadius: 4 }}>{a.recommendation}</div>
              {!a.applied && a.recommendation.startsWith('CREATE INDEX') && (
                <button onClick={() => doAction(`/api/db-optimize/apply/${a.id}`)} disabled={loading} style={{
                  background: GREEN + '22', color: GREEN, border: `1px solid ${GREEN}44`, padding: '4px 10px',
                  borderRadius: 4, cursor: 'pointer', fontSize: 11, marginTop: 6, fontWeight: 600,
                }}>Apply Index</button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'wal' && (
        <div>
          {wal?.wal && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: wal.wal.journalMode === 'wal' ? GREEN : RED, textTransform: 'uppercase' }}>{wal.wal.journalMode}</div>
                <div style={{ fontSize: 11, color: DIM }}>Journal Mode</div>
              </div>
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: ACCENT }}>{wal.wal.dbSizeMB} MB</div>
                <div style={{ fontSize: 11, color: DIM }}>DB Size</div>
              </div>
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: wal.wal.freelistPages > 0 ? RED : GREEN }}>{fmtBytes(wal.wal.wastedBytes)}</div>
                <div style={{ fontSize: 11, color: DIM }}>Freelist Waste</div>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16 }}>
            {wal?.wal && (
              <>
                <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 12, color: DIM, marginBottom: 4 }}>Page Size</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{(wal.wal.pageSize || 0).toLocaleString()} bytes</div>
                </div>
                <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 12, color: DIM, marginBottom: 4 }}>Cache Size</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{wal.wal.cacheSizeKB} KB</div>
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button onClick={() => doAction('/api/db-optimize/checkpoint')} disabled={loading} style={{
              background: ACCENT, color: '#000', border: 'none', padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1,
            }}>Checkpoint</button>
            <button onClick={() => doAction('/api/db-optimize/vacuum')} disabled={loading} style={{
              background: RED + '22', color: RED, border: `1px solid ${RED}44`, padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1,
            }}>VACUUM</button>
            <button onClick={() => doAction('/api/db-optimize/analyze-stats')} disabled={loading} style={{
              background: BLUE + '22', color: BLUE, border: `1px solid ${BLUE}44`, padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1,
            }}>ANALYZE</button>
            <button onClick={() => doAction('/api/db-optimize/optimize-pragmas')} disabled={loading} style={{
              background: GREEN + '22', color: GREEN, border: `1px solid ${GREEN}44`, padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1,
            }}>Optimize Pragmas</button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {wal?.maintenance?.checkpoint ? (
              <button onClick={() => doAction('/api/db-optimize/maintenance/stop')} style={{
                background: RED + '22', color: RED, border: `1px solid ${RED}44`, padding: '4px 10px',
                borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>Stop Maintenance</button>
            ) : (
              <button onClick={() => doAction('/api/db-optimize/maintenance/start')} style={{
                background: GREEN + '22', color: GREEN, border: `1px solid ${GREEN}44`, padding: '4px 10px',
                borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>Start Scheduled Maintenance</button>
            )}
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: ACCENT, marginBottom: 8 }}>Recent Operations</div>
          {operations.length === 0 && <div style={{ color: DIM, fontSize: 12 }}>No operations recorded</div>}
          {operations.slice(0, 10).map(op => (
            <div key={op.id} style={{
              background: CARD, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '6px 10px',
              marginBottom: 4, display: 'flex', justifyContent: 'space-between', fontSize: 12,
            }}>
              <span style={{ fontFamily: 'monospace', color: op.operation.includes('fail') ? RED : GREEN }}>{op.operation}</span>
              <div style={{ display: 'flex', gap: 10, color: DIM }}>
                <span>{op.duration_ms}ms</span>
                <span>{fmtTime(op.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'retention' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={() => doAction('/api/db-optimize/retention/run')} disabled={loading} style={{
              background: RED + '22', color: RED, border: `1px solid ${RED}44`, padding: '6px 14px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.5 : 1,
            }}>Run Cleanup Now</button>
            <button onClick={loadPreview} style={{
              background: ACCENT + '22', color: ACCENT, border: `1px solid ${ACCENT}44`, padding: '6px 14px',
              borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>Preview</button>
            {retention?.scheduled ? (
              <button onClick={() => doAction('/api/db-optimize/retention/stop')} style={{
                background: RED + '22', color: RED, border: `1px solid ${RED}44`, padding: '4px 10px',
                borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>Stop Scheduled</button>
            ) : (
              <button onClick={() => doAction('/api/db-optimize/retention/start')} style={{
                background: GREEN + '22', color: GREEN, border: `1px solid ${GREEN}44`, padding: '4px 10px',
                borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>Start Daily Cleanup</button>
            )}
          </div>

          {retentionPreview.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: RED, marginBottom: 6 }}>Cleanup Preview</div>
              {retentionPreview.map(p => (
                <div key={p.table} style={{
                  background: CARD, border: `1px solid ${RED}22`, borderRadius: 4, padding: '6px 10px',
                  marginBottom: 4, display: 'flex', justifyContent: 'space-between', fontSize: 12,
                }}>
                  <span style={{ fontFamily: 'monospace' }}>{p.table}</span>
                  <div style={{ display: 'flex', gap: 10, color: DIM }}>
                    <span style={{ color: RED }}>{p.wouldDelete.toLocaleString()} to remove</span>
                    <span>of {p.total.toLocaleString()}</span>
                    <span>({p.maxAgeDays}d policy)</span>
                  </div>
                </div>
              ))}
            </>
          )}

          <div style={{ fontSize: 13, fontWeight: 600, color: ACCENT, marginTop: 12, marginBottom: 6 }}>Retention Policies</div>
          {retention?.policies && Object.entries(retention.policies)
            .sort(([, a], [, b]) => a.maxAgeDays - b.maxAgeDays)
            .map(([table, policy]) => (
              <div key={table} style={{
                background: CARD, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '4px 10px',
                marginBottom: 2, display: 'flex', justifyContent: 'space-between', fontSize: 12,
              }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{table}</span>
                <span style={{ color: DIM }}>{policy.maxAgeDays}d</span>
              </div>
            ))}

          {retentionHistory.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: ACCENT, marginTop: 12, marginBottom: 6 }}>Run History</div>
              {retentionHistory.slice(0, 8).map(r => (
                <div key={r.id} style={{
                  background: CARD, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '6px 10px',
                  marginBottom: 4, display: 'flex', justifyContent: 'space-between', fontSize: 12,
                }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: GREEN }}>{r.rows_deleted.toLocaleString()} deleted</span>
                    <span style={{ color: DIM }}>from {r.tables_cleaned} tables</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, color: DIM }}>
                    <span>{r.duration_ms}ms</span>
                    <span>{fmtTime(r.created_at)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
