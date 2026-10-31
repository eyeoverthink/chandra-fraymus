import React, { useState, useEffect, useCallback } from 'react';

const RANK_BADGES = ['', '\u{1F947}', '\u{1F948}', '\u{1F949}'];
const TITLE_CONFIG = {
  mvp: { emoji: '👑', label: 'MVP', color: '#fbbf24', unit: 'pts' },
  runner: { emoji: '⚡', label: 'Top Runner', color: '#ef4444', unit: 'runs' },
  communicator: { emoji: '📡', label: 'Top Communicator', color: '#22d3ee', unit: 'messages' },
  scholar: { emoji: '🧠', label: 'Top Scholar', color: '#a78bfa', unit: 'memories' },
  forger: { emoji: '🔥', label: 'Top Forger', color: '#f59e0b', unit: 'forged' },
};

const CAT_CONFIG = {
  execution: { label: 'Execution', color: '#ef4444', icon: '▶' },
  communication: { label: 'Comms', color: '#22d3ee', icon: '◈' },
  knowledge: { label: 'Knowledge', color: '#a78bfa', icon: '◉' },
  creation: { label: 'Creation', color: '#f59e0b', icon: '⚒' },
  evolution: { label: 'Evolution', color: '#c084fc', icon: '◎' },
  reliability: { label: 'Reliability', color: '#34d399', icon: '✓' },
};

const FILTER_TABS = [
  { key: 'all', label: 'All Agents' },
  { key: 'runners', label: 'Runners', field: 'runs' },
  { key: 'comms', label: 'Communicators', field: 'busMessages' },
  { key: 'scholars', label: 'Scholars', field: 'memories' },
  { key: 'forgers', label: 'Forgers', field: 'forged' },
];

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function MiniSparkline({ data, color, width = 60, height = 20 }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
      {data[data.length - 1] > 0 && (
        <circle cx={width} cy={height - (data[data.length - 1] / max) * (height - 2) - 1} r="2" fill={color} />
      )}
    </svg>
  );
}

function ScoreBreakdown({ categories }) {
  const total = Object.values(categories).reduce((s, v) => s + v, 0) || 1;
  return (
    <div style={{ display: 'flex', gap: 2, height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 6 }}>
      {Object.entries(CAT_CONFIG).map(([key, cfg]) => {
        const w = (categories[key] / total) * 100;
        if (w < 1) return null;
        return <div key={key} style={{ width: `${w}%`, background: cfg.color, minWidth: 2 }} title={`${cfg.label}: ${categories[key]} pts`} />;
      })}
    </div>
  );
}

function AchievementBadges({ achievements }) {
  if (!achievements || achievements.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginTop: 6 }}>
      {achievements.map(a => (
        <span key={a.id} title={`${a.label}: ${a.desc}`} style={{
          fontSize: 12, cursor: 'default',
          filter: 'drop-shadow(0 0 2px rgba(255,255,255,0.2))',
        }}>
          {a.emoji}
        </span>
      ))}
    </div>
  );
}

function RoleAvatar({ name, color }) {
  const initial = (name || '?')[0].toUpperCase();
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%',
      background: `${color}20`, border: `2px solid ${color}60`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, color, flexShrink: 0,
    }}>
      {initial}
    </div>
  );
}

function ExpandedDetail({ entry }) {
  return (
    <tr>
      <td colSpan={7} style={{ padding: '0 10px 14px 52px', borderBottom: '1px solid #222' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10, marginTop: 4 }}>
          {Object.entries(CAT_CONFIG).map(([key, cfg]) => (
            <div key={key} style={{
              background: '#0a0a18', border: `1px solid ${cfg.color}30`, borderRadius: 8, padding: '8px 10px',
            }}>
              <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {cfg.icon} {cfg.label}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: cfg.color, marginTop: 2 }}>
                {entry.categories[key]}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#666' }}>
            Role: <span style={{ color: entry.roleColor }}>{entry.role}</span>
          </span>
          {entry.threads > 0 && (
            <span style={{ fontSize: 11, color: '#666' }}>
              Threads: <span style={{ color: '#60a5fa' }}>{entry.threads}</span>
            </span>
          )}
          {entry.runs > 0 && (
            <span style={{ fontSize: 11, color: '#666' }}>
              Success rate: <span style={{ color: entry.successes === entry.runs ? '#34d399' : '#f59e0b' }}>
                {Math.round((entry.successes / entry.runs) * 100)}%
              </span>
            </span>
          )}
          {entry.avgConfidence > 0 && (
            <span style={{ fontSize: 11, color: '#666' }}>
              Confidence: <span style={{ color: '#a78bfa' }}>{entry.avgConfidence}</span>
            </span>
          )}
        </div>

        {entry.topTopics && entry.topTopics.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: '#555' }}>Topics:</span>
            {entry.topTopics.map((t, i) => (
              <span key={i} style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                background: '#22d3ee10', color: '#22d3ee', border: '1px solid #22d3ee20',
              }}>
                {t.topic} ({t.count})
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

export default function LeaderboardPanel({ wsEvent }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/leaderboard');
      const d = await r.json();
      setData(d);
    } catch (e) { console.error('leaderboard:', e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);
  useEffect(() => { if (wsEvent) reload(); }, [wsEvent, reload]);

  if (loading) return <div style={{ textAlign: 'center', padding: 40, color: '#555', fontSize: 13 }}>Ranking agents...</div>;
  if (!data) return <div style={{ textAlign: 'center', padding: 40, color: '#555', fontSize: 13 }}>Leaderboard unavailable</div>;

  const { leaderboard, totals, titles, forgeLineage } = data;

  const filtered = filter === 'all'
    ? leaderboard
    : leaderboard.filter(e => {
        const tab = FILTER_TABS.find(t => t.key === filter);
        return tab && e[tab.field] > 0;
      }).sort((a, b) => {
        const tab = FILTER_TABS.find(t => t.key === filter);
        return tab ? b[tab.field] - a[tab.field] : 0;
      });

  const maxScore = filtered[0]?.score || 1;

  return (
    <div style={{ padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Agent Leaderboard</div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
            {totals.agents} fleet · {filtered.length} ranked · 6 scoring dimensions
          </div>
        </div>
        <button onClick={reload} style={{
          padding: '4px 12px', border: '1px solid #333', borderRadius: 6,
          background: '#1a1a2e', color: '#888', cursor: 'pointer', fontSize: 11,
        }}>Refresh</button>
      </div>

      {/* Title holders */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 16 }}>
        {Object.entries(TITLE_CONFIG).map(([key, cfg]) => {
          const holder = titles[key];
          return (
            <div key={key} style={{
              background: '#12121f', border: `1px solid ${holder ? cfg.color + '40' : '#222'}`,
              borderRadius: 10, padding: 10, textAlign: 'center',
            }}>
              <div style={{ fontSize: 18, marginBottom: 2 }}>{cfg.emoji}</div>
              <div style={{ fontSize: 9, fontWeight: 600, color: '#555', letterSpacing: 0.6, textTransform: 'uppercase' }}>{cfg.label}</div>
              {holder ? (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: cfg.color, marginTop: 3 }}>{holder.name}</div>
                  <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>{holder.value} {cfg.unit}</div>
                </>
              ) : (
                <div style={{ fontSize: 10, color: '#444', marginTop: 6 }}>—</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Totals */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { label: 'Runs', value: totals.runs, color: '#ef4444' },
          { label: 'Bus', value: totals.busMessages, color: '#22d3ee' },
          { label: 'Memories', value: totals.memories, color: '#a78bfa' },
          { label: 'Forged', value: totals.forged, color: '#f59e0b' },
          { label: 'Threads', value: totals.threads, color: '#60a5fa' },
          { label: 'Reflections', value: totals.reflections, color: '#c084fc' },
        ].map(t => (
          <div key={t.label} style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px',
            background: '#12121f', border: '1px solid #222', borderRadius: 8, fontSize: 11,
          }}>
            <span style={{ color: t.color, fontWeight: 700, fontSize: 13 }}>{t.value}</span>
            <span style={{ color: '#666' }}>{t.label}</span>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {FILTER_TABS.map(tab => (
          <button key={tab.key} onClick={() => { setFilter(tab.key); setExpanded(null); }} style={{
            padding: '5px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            border: filter === tab.key ? '1px solid #a78bfa60' : '1px solid #222',
            background: filter === tab.key ? '#a78bfa15' : '#12121f',
            color: filter === tab.key ? '#a78bfa' : '#666',
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Leaderboard table */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#555', fontSize: 13 }}>
          No agent activity{filter !== 'all' ? ` in this category` : ''}. Run some agents to populate the leaderboard.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle('#', 40)} />
              <th style={thStyle('Agent')}>Agent</th>
              <th style={thStyle('7d', 60, 'center')}>7d</th>
              <th style={thStyle('Runs', 55, 'center')}>Runs</th>
              <th style={thStyle('Bus', 50, 'center')}>Bus</th>
              <th style={thStyle('Mem', 50, 'center')}>Mem</th>
              <th style={thStyle('Score', 60, 'right')}>Score</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(entry => {
              const badge = RANK_BADGES[entry.rank] || '';
              const isExpanded = expanded === entry.id;
              return (
                <React.Fragment key={entry.id}>
                  <tr
                    onClick={() => setExpanded(isExpanded ? null : entry.id)}
                    style={{
                      background: entry.rank <= 3 ? '#a78bfa06' : 'transparent',
                      cursor: 'pointer', transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = '#a78bfa10'}
                    onMouseLeave={e => e.currentTarget.style.background = entry.rank <= 3 ? '#a78bfa06' : 'transparent'}
                  >
                    <td style={{ ...tdStyle, width: 40, textAlign: 'center', fontWeight: 700, fontSize: 16 }}>
                      {badge || entry.rank}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <RoleAvatar name={entry.name} color={entry.roleColor} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: '#e0e0e8', fontSize: 13 }}>{entry.name}</div>
                          <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{entry.role}</div>
                          <ScoreBreakdown categories={entry.categories} />
                          <AchievementBadges achievements={entry.achievements} />
                        </div>
                      </div>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      <MiniSparkline data={entry.sparkline} color={entry.roleColor} />
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      {entry.runs > 0 && (
                        <span style={pillStyle('#ef4444')}>
                          {entry.runs}
                          {entry.successes > 0 && <span style={{ color: '#34d399', fontSize: 9 }}>✓{entry.successes}</span>}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      {entry.busMessages > 0 && <span style={pillStyle('#22d3ee')}>{entry.busMessages}</span>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      {entry.memories > 0 && <span style={pillStyle('#a78bfa')}>{entry.memories}</span>}
                    </td>
                    <td style={{
                      ...tdStyle, textAlign: 'right', fontWeight: 700, fontSize: 15,
                      color: entry.rank === 1 ? '#fbbf24' : entry.rank <= 3 ? '#a78bfa' : '#e0e0e8',
                    }}>
                      {entry.score}
                    </td>
                  </tr>
                  {isExpanded && <ExpandedDetail entry={entry} />}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Forge Lineage */}
      {forgeLineage.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 10, letterSpacing: 0.5 }}>
            Forge Lineage
          </div>
          <div style={{ background: '#12121f', border: '1px solid #222', borderRadius: 10, padding: 14 }}>
            {forgeLineage.map((f, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                borderBottom: i < forgeLineage.length - 1 ? '1px solid #1a1a2e' : 'none', fontSize: 12,
              }}>
                <span style={pillStyle('#f59e0b')}>{f.by}</span>
                <span style={{ color: '#555' }}>forged</span>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>{f.id}</span>
                <span style={{ color: '#555', marginLeft: 'auto', fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.goal}
                </span>
                <span style={{ color: '#444', fontSize: 10, whiteSpace: 'nowrap' }}>{relTime(f.at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Achievement catalog */}
      {data.achievementCatalog && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 10, letterSpacing: 0.5 }}>
            Achievements ({data.achievementCatalog.length})
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.achievementCatalog.map(a => {
              const earned = leaderboard.some(e => e.achievements?.some(ea => ea.id === a.id));
              return (
                <div key={a.id} title={`${a.label}: ${a.desc}`} style={{
                  padding: '4px 10px', borderRadius: 8, fontSize: 11,
                  background: earned ? '#a78bfa10' : '#0a0a18',
                  border: `1px solid ${earned ? '#a78bfa30' : '#1a1a2e'}`,
                  color: earned ? '#e0e0e8' : '#444',
                  cursor: 'default',
                }}>
                  {a.emoji} {a.label}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = (label, width, align = 'left') => ({
  textAlign: align, fontSize: 10, fontWeight: 600, color: '#555',
  letterSpacing: 0.8, textTransform: 'uppercase', padding: '8px 10px',
  borderBottom: '1px solid #222', ...(width ? { width } : {}),
});

const tdStyle = { padding: '10px', borderBottom: '1px solid #1a1a2e', fontSize: 13 };

const pillStyle = (color) => ({
  display: 'inline-flex', alignItems: 'center', gap: 3,
  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
  background: `${color}15`, color, border: `1px solid ${color}30`,
});
