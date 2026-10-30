import React, { useState, useEffect, useCallback } from 'react';

const S = {
  container: { padding: 20, color: '#e0e0e8', fontFamily: 'system-ui, sans-serif' },
  section: { marginBottom: 28 },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: '#22d3ee', marginBottom: 12, letterSpacing: 0.5 },
  card: { background: '#12121f', border: '1px solid #222', borderRadius: 8, padding: 14, marginBottom: 10 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  badge: { fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600 },
  badgeTopic: { background: '#22d3ee20', color: '#22d3ee', border: '1px solid #22d3ee40' },
  badgeDm: { background: '#a78bfa20', color: '#a78bfa', border: '1px solid #a78bfa40' },
  btn: { padding: '6px 14px', border: '1px solid #333', borderRadius: 6, background: '#1a1a2e', color: '#ccc', cursor: 'pointer', fontSize: 12 },
  btnPrimary: { padding: '6px 14px', border: 'none', borderRadius: 6, background: '#22d3ee', color: '#111', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  btnDanger: { padding: '6px 14px', border: '1px solid #ef444440', borderRadius: 6, background: '#ef444415', color: '#ef4444', cursor: 'pointer', fontSize: 12 },
  stat: { textAlign: 'center', padding: '10px 0' },
  statNum: { fontSize: 22, fontWeight: 700, color: '#22d3ee' },
  statLabel: { fontSize: 10, color: '#666', marginTop: 2 },
  input: { padding: '6px 10px', border: '1px solid #333', borderRadius: 6, background: '#0a0a14', color: '#e0e0e8', fontSize: 12, flex: 1 },
  empty: { textAlign: 'center', padding: 40, color: '#555', fontSize: 13 },
  msgFrom: { fontSize: 11, fontWeight: 600, color: '#22d3ee' },
  msgTopic: { fontSize: 10, color: '#666', marginLeft: 8 },
  msgPayload: { fontSize: 12, color: '#bbb', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' },
  msgTime: { fontSize: 10, color: '#555', marginTop: 4 },
  topicTag: { display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#22d3ee15', color: '#22d3ee', border: '1px solid #22d3ee30', marginRight: 6, marginBottom: 4, cursor: 'pointer' },
};

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function safeParse(str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return str; }
}

function MessageCard({ msg }) {
  const payload = safeParse(msg.payload);
  const preview = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const isDm = msg.topic === 'dm';

  return (
    <div style={S.card}>
      <div style={S.row}>
        <div>
          <span style={S.msgFrom}>{msg.from_agent}</span>
          {isDm
            ? <span style={S.msgTopic}> → {msg.to_agent}</span>
            : <span style={S.msgTopic}> on {msg.topic}</span>}
        </div>
        <span style={{ ...S.badge, ...(isDm ? S.badgeDm : S.badgeTopic) }}>
          {isDm ? 'DM' : 'topic'}
        </span>
      </div>
      <div style={S.msgPayload}>{preview.slice(0, 500)}</div>
      <div style={S.msgTime}>{relTime(msg.created_at)}</div>
    </div>
  );
}

function ComposeSection({ agents, onSent }) {
  const [mode, setMode] = useState('topic');
  const [from, setFrom] = useState('');
  const [topic, setTopic] = useState('');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!from || !message) return;
    setSending(true);
    try {
      const url = mode === 'dm' ? '/api/fleet/bus/dm' : '/api/fleet/bus/publish';
      const body = mode === 'dm'
        ? { from, to, payload: message }
        : { from, topic, payload: message };
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setMessage('');
      onSent();
    } catch (e) { console.error('bus send:', e.message); }
    setSending(false);
  };

  return (
    <div style={S.card}>
      <div style={{ ...S.row, marginBottom: 10 }}>
        <button style={mode === 'topic' ? S.btnPrimary : S.btn} onClick={() => setMode('topic')}>Publish</button>
        <button style={mode === 'dm' ? S.btnPrimary : S.btn} onClick={() => setMode('dm')}>Direct Message</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <select style={{ ...S.input, flex: '0 0 auto', minWidth: 140 }} value={from} onChange={e => setFrom(e.target.value)}>
          <option value="">From agent...</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
        </select>
        {mode === 'topic'
          ? <input style={S.input} placeholder="Topic (e.g. commerce.done)" value={topic} onChange={e => setTopic(e.target.value)} />
          : <select style={{ ...S.input, flex: '0 0 auto', minWidth: 140 }} value={to} onChange={e => setTo(e.target.value)}>
              <option value="">To agent...</option>
              {agents.filter(a => a.id !== from).map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
        }
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={S.input} placeholder="Message..." value={message} onChange={e => setMessage(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()} />
        <button style={S.btnPrimary} onClick={send} disabled={sending}>{sending ? '...' : 'Send'}</button>
      </div>
    </div>
  );
}

export default function BusPanel({ wsEvent }) {
  const [stats, setStats] = useState(null);
  const [topics, setTopics] = useState([]);
  const [feed, setFeed] = useState([]);
  const [subs, setSubs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [statsR, topicsR, subsR, agentsR] = await Promise.all([
        fetch('/api/fleet/bus/stats').then(r => r.json()),
        fetch('/api/fleet/bus/topics').then(r => r.json()),
        fetch('/api/fleet/bus/subscriptions').then(r => r.json()),
        fetch('/api/fleet/agents').then(r => r.json()),
      ]);
      setStats(statsR);
      setTopics(topicsR.topics || []);
      setSubs(subsR.subscriptions || []);
      setAgents(agentsR.agents || []);
    } catch (e) { console.error('bus reload:', e.message); }
    setLoading(false);
  }, []);

  const loadFeed = useCallback(async (topic) => {
    try {
      const url = topic
        ? `/api/fleet/bus/history/${encodeURIComponent(topic)}?limit=30`
        : '/api/fleet/bus/history/dm?limit=30';
      const r = await fetch(url);
      const data = await r.json();
      setFeed(data.messages || []);
    } catch (e) { console.error('bus feed:', e.message); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (wsEvent?.type === 'bus') {
      reload();
      if (selectedTopic) loadFeed(selectedTopic);
    }
  }, [wsEvent, reload, loadFeed, selectedTopic]);

  if (loading) return <div style={S.empty}>Loading bus...</div>;

  return (
    <div style={S.container}>
      <div style={S.section}>
        <div style={S.sectionTitle}>AGENT LIVE BUS</div>
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <div style={S.stat}><div style={S.statNum}>{stats.total}</div><div style={S.statLabel}>Total Messages</div></div>
            <div style={S.stat}><div style={S.statNum}>{stats.today}</div><div style={S.statLabel}>Today</div></div>
            <div style={S.stat}><div style={S.statNum}>{stats.topics}</div><div style={S.statLabel}>Topics</div></div>
            <div style={S.stat}><div style={S.statNum}>{stats.subscriptions}</div><div style={S.statLabel}>Subscriptions</div></div>
          </div>
        )}
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>COMPOSE</div>
        <ComposeSection agents={agents} onSent={() => { reload(); if (selectedTopic) loadFeed(selectedTopic); }} />
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>TOPICS</div>
        {topics.length === 0
          ? <div style={{ color: '#555', fontSize: 12 }}>No topics yet — publish a message to create one.</div>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {topics.map(t => (
                <span key={t.topic} style={{
                  ...S.topicTag,
                  ...(selectedTopic === t.topic ? { background: '#22d3ee30', borderColor: '#22d3ee' } : {}),
                }} onClick={() => { setSelectedTopic(t.topic); loadFeed(t.topic); }}>
                  {t.topic} ({t.messageCount})
                </span>
              ))}
            </div>
        }
      </div>

      {subs.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>SUBSCRIPTIONS</div>
          <div style={S.card}>
            {subs.map((s, i) => (
              <div key={i} style={{ ...S.row, padding: '4px 0', borderBottom: i < subs.length - 1 ? '1px solid #1a1a2e' : 'none' }}>
                <span style={{ fontSize: 12, color: '#22d3ee' }}>{s.agent_id}</span>
                <span style={{ fontSize: 11, color: '#666' }}>{s.topic}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={S.section}>
        <div style={{ ...S.row, marginBottom: 12 }}>
          <div style={S.sectionTitle}>
            {selectedTopic ? `MESSAGES: ${selectedTopic}` : 'RECENT MESSAGES'}
          </div>
          {selectedTopic && (
            <button style={S.btn} onClick={() => { setSelectedTopic(null); setFeed([]); }}>Clear filter</button>
          )}
        </div>
        {feed.length === 0
          ? <div style={S.empty}>
              {selectedTopic ? `No messages in topic "${selectedTopic}" yet.` : 'Select a topic to view messages, or publish one to get started.'}
            </div>
          : feed.map(m => <MessageCard key={m.id} msg={m} />)
        }
      </div>
    </div>
  );
}
