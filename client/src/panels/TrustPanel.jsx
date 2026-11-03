import { useState, useEffect, useCallback } from 'react';

const OUTCOME_COLORS = {
  success: '#22c55e', failure: '#ef4444', partial: '#f59e0b', error: '#dc2626', timeout: '#6b7280',
};

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#1e1b2e', borderRadius: 8, padding: '12px 16px', minWidth: 100 }}>
      <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e0e0f0' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function TrustBar({ score, confidence, size = 'md' }) {
  const h = size === 'sm' ? 6 : 10;
  const pct = Math.round((score || 0) * 100);
  const color = pct >= 70 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: '#2a2740', borderRadius: h / 2, height: h, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: h / 2, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: size === 'sm' ? 11 : 13, color, fontWeight: 600, minWidth: 36 }}>{pct}%</span>
      {confidence != null && (
        <span style={{ fontSize: 10, color: '#6b7280' }}>({Math.round(confidence * 100)}% conf)</span>
      )}
    </div>
  );
}

function DomainBadge({ domain, runs }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#2a2740', padding: '2px 8px', borderRadius: 10, fontSize: 11, color: '#c4b5fd' }}>
      {domain} {runs != null && <span style={{ color: '#6b7280' }}>({runs})</span>}
    </span>
  );
}

export default function TrustPanel({ wsEvent }) {
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentDetail, setAgentDetail] = useState(null);
  const [agentHistory, setAgentHistory] = useState([]);
  const [error, setError] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/trust/stats');
      setStats(await res.json());
    } catch (e) { setError(e.message); }
  }, []);

  const loadLeaderboard = useCallback(async () => {
    try {
      const res = await fetch('/api/intelligence/trust/leaderboard?limit=20');
      const data = await res.json();
      setLeaderboard(data.leaderboard || []);
    } catch (e) { setError(e.message); }
  }, []);

  const loadAgentDetail = useCallback(async (agentId) => {
    try {
      const [trustRes, histRes] = await Promise.all([
        fetch(`/api/intelligence/trust/agent/${agentId}`),
        fetch(`/api/intelligence/trust/agent/${agentId}/history?limit=30`),
      ]);
      setAgentDetail(await trustRes.json());
      const hist = await histRes.json();
      setAgentHistory(hist.events || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadStats(); loadLeaderboard(); }, [loadStats, loadLeaderboard]);
  useEffect(() => {
    if (wsEvent?.type === 'trust') { loadStats(); loadLeaderboard(); if (selectedAgent) loadAgentDetail(selectedAgent); }
  }, [wsEvent, loadStats, loadLeaderboard, selectedAgent, loadAgentDetail]);

  useEffect(() => {
    if (selectedAgent) loadAgentDetail(selectedAgent);
  }, [selectedAgent, loadAgentDetail]);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'domains', label: 'Domains' },
  ];

  if (selectedAgent && agentDetail) {
    const domains = agentDetail.domains || [agentDetail];
    return (
      <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
        <button onClick={() => { setSelectedAgent(null); setAgentDetail(null); }} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 13, marginBottom: 12 }}>
          &larr; Back
        </button>
        <h3 style={{ margin: '0 0 12px', color: '#dc2626' }}>{selectedAgent}</h3>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {domains.map((d, i) => (
            <StatCard key={i} label={d.domain || 'general'} value={`${Math.round((d.score || 0) * 100)}%`}
              sub={`${d.total_runs || 0} runs`} color={d.score >= 0.7 ? '#22c55e' : d.score >= 0.4 ? '#f59e0b' : '#ef4444'} />
          ))}
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Trust by Domain</div>
          {domains.map((d, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#c4b5fd', marginBottom: 3 }}>{d.domain || 'general'}</div>
              <TrustBar score={d.score} confidence={d.confidence} />
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                <span style={{ color: '#22c55e' }}>{d.successes || 0} ok</span>
                <span style={{ color: '#ef4444' }}>{d.failures || 0} fail</span>
                {d.avg_quality != null && <span>quality: {Math.round(d.avg_quality * 100)}%</span>}
                {d.avg_duration_ms != null && <span>{Math.round(d.avg_duration_ms / 1000)}s avg</span>}
              </div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Recent Events</div>
        {agentHistory.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No events yet.</div>}
        {agentHistory.map((ev, i) => (
          <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: OUTCOME_COLORS[ev.outcome] || '#e0e0f0', fontWeight: 600, textTransform: 'uppercase' }}>
                {ev.outcome}
              </span>
              <DomainBadge domain={ev.domain} />
            </div>
            <div style={{ fontSize: 12, color: '#c0c0d0', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ev.task}
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#6b7280', marginTop: 4 }}>
              {ev.quality != null && <span>quality: {Math.round(ev.quality * 100)}%</span>}
              {ev.duration_ms != null && <span>{Math.round(ev.duration_ms / 1000)}s</span>}
              <span>{new Date(ev.created_at + 'Z').toLocaleString()}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: 16, color: '#e0e0f0', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: tab === t.id ? '#dc2626' : '#2a2740', color: tab === t.id ? '#fff' : '#a0a0b8' }}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={{ background: '#3b1010', color: '#f87171', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {tab === 'overview' && stats && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Tracked Agents" value={stats.totalAgents} color="#dc2626" />
            <StatCard label="Total Events" value={stats.totalEvents} color="#c4b5fd" />
            <StatCard label="Domains" value={stats.totalDomains} color="#f59e0b" />
            <StatCard label="Avg Trust" value={stats.avgScore != null ? `${Math.round(stats.avgScore * 100)}%` : '—'} color="#22c55e" />
          </div>

          {stats.topAgents?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Top Agents</div>
              {stats.topAgents.map((a, i) => (
                <div key={i} onClick={() => setSelectedAgent(a.agent_id)}
                  style={{ background: '#1e1b2e', borderRadius: 6, padding: '8px 12px', marginBottom: 4, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0' }}>{a.agent_id}</span>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>{a.runs} runs</span>
                  </div>
                  <TrustBar score={a.score} size="sm" />
                </div>
              ))}
            </div>
          )}

          {stats.recentEvents?.length > 0 && (
            <div>
              <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Last 7 Days</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {stats.recentEvents.map((ev, i) => (
                  <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: OUTCOME_COLORS[ev.outcome] || '#6b7280' }} />
                    <span style={{ fontSize: 12, color: '#c0c0d0' }}>{ev.outcome}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#e0e0f0' }}>{ev.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'leaderboard' && (
        <>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Agent Trust Rankings</div>
          {leaderboard.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No trust data yet. Run some agents to build the leaderboard.</div>}
          {leaderboard.map((a, i) => (
            <div key={i} onClick={() => setSelectedAgent(a.agent_id)}
              style={{ background: '#1e1b2e', borderRadius: 6, padding: '10px 12px', marginBottom: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: i < 3 ? '#dc2626' : '#2a2740', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                {i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0f0' }}>{a.agent_id}</div>
                <TrustBar score={a.score} confidence={a.confidence} size="sm" />
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>{a.total_runs} runs</div>
                <div style={{ fontSize: 11, color: '#22c55e' }}>{a.successes || 0}W</div>
                <div style={{ fontSize: 11, color: '#ef4444' }}>{a.failures || 0}L</div>
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'domains' && stats && (
        <>
          <div style={{ fontSize: 13, color: '#a0a0b8', marginBottom: 8 }}>Domain Performance</div>
          {(!stats.domainBreakdown || stats.domainBreakdown.length === 0) && <div style={{ fontSize: 12, color: '#6b7280' }}>No domain data yet.</div>}
          {stats.domainBreakdown?.map((d, i) => (
            <div key={i} style={{ background: '#1e1b2e', borderRadius: 6, padding: '10px 12px', marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <DomainBadge domain={d.domain} runs={d.total_runs} />
                <span style={{ fontSize: 11, color: '#6b7280' }}>{d.agents} agents</span>
              </div>
              <TrustBar score={d.avg_score} size="sm" />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
