import React, { useState, useEffect, useCallback } from 'react';

const S = {
  container: { padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  title: { fontSize: 16, fontWeight: 600, color: '#e0e0e8' },
  subtitle: { fontSize: 11, color: '#666', marginTop: 2 },
  refreshBtn: { padding: '4px 12px', border: '1px solid #333', borderRadius: 6, background: '#1a1a2e', color: '#888', cursor: 'pointer', fontSize: 11 },
  titleCards: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 },
  titleCard: { background: '#12121f', border: '1px solid #222', borderRadius: 10, padding: 12, textAlign: 'center' },
  titleEmoji: { fontSize: 22, marginBottom: 4 },
  titleLabel: { fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 0.8, textTransform: 'uppercase' },
  titleName: { fontSize: 13, fontWeight: 600, marginTop: 4 },
  titleValue: { fontSize: 11, color: '#888', marginTop: 2 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 0.8, textTransform: 'uppercase', padding: '8px 10px', borderBottom: '1px solid #222' },
  td: { padding: '10px', borderBottom: '1px solid #1a1a2e', fontSize: 13 },
  rankCell: { width: 40, textAlign: 'center', fontWeight: 700, fontSize: 16 },
  nameCell: { fontWeight: 600, color: '#e0e0e8' },
  scoreCell: { fontWeight: 700, fontSize: 15 },
  statPill: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, marginRight: 4 },
  bar: { height: 4, borderRadius: 2, marginTop: 4, transition: 'width 0.5s ease' },
  lineageCard: { background: '#12121f', border: '1px solid #222', borderRadius: 10, padding: 14, marginBottom: 12 },
  lineageTitle: { fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 10, letterSpacing: 0.5 },
  lineageRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1a1a2e', fontSize: 12 },
  empty: { textAlign: 'center', padding: 40, color: '#555', fontSize: 13 },
  totalsRow: { display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' },
  totalChip: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', background: '#12121f', border: '1px solid #222', borderRadius: 8, fontSize: 12 },
};

const RANK_BADGES = ['', '\u{1F947}', '\u{1F948}', '\u{1F949}'];
const TITLE_CONFIG = {
  runner: { emoji: '⚡', label: 'Top Runner', color: '#ef4444', unit: 'runs' },
  communicator: { emoji: '\u{1F4E1}', label: 'Top Communicator', color: '#22d3ee', unit: 'messages' },
  scholar: { emoji: '\u{1F9E0}', label: 'Top Scholar', color: '#a78bfa', unit: 'memories' },
  forger: { emoji: '\u{1F525}', label: 'Top Forger', color: '#f59e0b', unit: 'forged' },
};

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function LeaderboardPanel({ wsEvent }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/leaderboard');
      const d = await r.json();
      setData(d);
    } catch (e) { console.error('leaderboard:', e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (wsEvent) reload();
  }, [wsEvent, reload]);

  if (loading) return <div style={S.empty}>Ranking agents...</div>;
  if (!data) return <div style={S.empty}>Leaderboard unavailable</div>;

  const { leaderboard, totals, titles, forgeLineage } = data;
  const maxScore = leaderboard[0]?.score || 1;

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div>
          <div style={S.title}>Agent Leaderboard</div>
          <div style={S.subtitle}>{totals.agents} agents in fleet · ranked by composite score</div>
        </div>
        <button style={S.refreshBtn} onClick={reload}>Refresh</button>
      </div>

      {/* Title holders */}
      <div style={S.titleCards}>
        {Object.entries(TITLE_CONFIG).map(([key, cfg]) => {
          const holder = titles[key];
          return (
            <div key={key} style={{ ...S.titleCard, borderColor: holder ? cfg.color + '40' : '#222' }}>
              <div style={S.titleEmoji}>{cfg.emoji}</div>
              <div style={S.titleLabel}>{cfg.label}</div>
              {holder ? (
                <>
                  <div style={{ ...S.titleName, color: cfg.color }}>{holder.name}</div>
                  <div style={S.titleValue}>{holder.value} {cfg.unit}</div>
                </>
              ) : (
                <div style={{ ...S.titleValue, marginTop: 8 }}>No data</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Totals bar */}
      <div style={S.totalsRow}>
        <div style={S.totalChip}>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>{totals.runs}</span> total runs
        </div>
        <div style={S.totalChip}>
          <span style={{ color: '#22d3ee', fontWeight: 700 }}>{totals.busMessages}</span> bus messages
        </div>
        <div style={S.totalChip}>
          <span style={{ color: '#a78bfa', fontWeight: 700 }}>{totals.memories}</span> memories
        </div>
        <div style={S.totalChip}>
          <span style={{ color: '#f59e0b', fontWeight: 700 }}>{totals.forged}</span> forged agents
        </div>
      </div>

      {/* Leaderboard table */}
      {leaderboard.length === 0 ? (
        <div style={S.empty}>No agent activity yet. Run some agents to populate the leaderboard.</div>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, width: 40 }}>#</th>
              <th style={S.th}>Agent</th>
              <th style={{ ...S.th, textAlign: 'center' }}>Runs</th>
              <th style={{ ...S.th, textAlign: 'center' }}>Bus</th>
              <th style={{ ...S.th, textAlign: 'center' }}>Mem</th>
              <th style={{ ...S.th, textAlign: 'center' }}>Forged</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Score</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.map(entry => {
              const badge = RANK_BADGES[entry.rank] || '';
              const barWidth = `${Math.max(4, (entry.score / maxScore) * 100)}%`;
              return (
                <tr key={entry.id} style={{ background: entry.rank <= 3 ? '#a78bfa08' : 'transparent' }}>
                  <td style={{ ...S.td, ...S.rankCell }}>
                    {badge || entry.rank}
                  </td>
                  <td style={{ ...S.td, ...S.nameCell }}>
                    <div>{entry.name}</div>
                    <div style={{ ...S.bar, width: barWidth, background: `linear-gradient(90deg, #a78bfa, #22d3ee)` }} />
                  </td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    {entry.runs > 0 && (
                      <span style={{ ...S.statPill, background: '#ef444415', color: '#ef4444', border: '1px solid #ef444430' }}>
                        {entry.runs}
                        {entry.successes > 0 && <span style={{ color: '#34d399' }}>({entry.successes})</span>}
                      </span>
                    )}
                  </td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    {entry.busMessages > 0 && (
                      <span style={{ ...S.statPill, background: '#22d3ee15', color: '#22d3ee', border: '1px solid #22d3ee30' }}>
                        {entry.busMessages}
                      </span>
                    )}
                  </td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    {entry.memories > 0 && (
                      <span style={{ ...S.statPill, background: '#a78bfa15', color: '#a78bfa', border: '1px solid #a78bfa30' }}>
                        {entry.memories}
                      </span>
                    )}
                  </td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    {entry.forged > 0 && (
                      <span style={{ ...S.statPill, background: '#f59e0b15', color: '#f59e0b', border: '1px solid #f59e0b30' }}>
                        {entry.forged}
                      </span>
                    )}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', ...S.scoreCell, color: entry.rank === 1 ? '#f59e0b' : entry.rank <= 3 ? '#a78bfa' : '#e0e0e8' }}>
                    {entry.score}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Forge Lineage */}
      {forgeLineage.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={S.lineageTitle}>Forge Lineage</div>
          <div style={S.lineageCard}>
            {forgeLineage.map((f, i) => (
              <div key={i} style={S.lineageRow}>
                <span style={{ ...S.statPill, background: '#f59e0b15', color: '#f59e0b', border: '1px solid #f59e0b30' }}>
                  {f.by}
                </span>
                <span style={{ color: '#555' }}>forged</span>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>{f.id}</span>
                <span style={{ color: '#555', marginLeft: 'auto', fontSize: 11 }}>
                  {(f.goal || '').slice(0, 40)}
                </span>
                <span style={{ color: '#444', fontSize: 10, whiteSpace: 'nowrap' }}>{relTime(f.at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
