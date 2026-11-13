import React, { useState, useEffect, useCallback, useRef } from 'react';

const TIER_COLORS = {
  DORMANT: '#6b7280',
  AWAKENING: '#60a5fa',
  EMERGING: '#a78bfa',
  INTEGRATED: '#4ade80',
};

const TIER_ICONS = {
  DORMANT: '○',
  AWAKENING: '◐',
  EMERGING: '◑',
  INTEGRATED: '●',
};

const EMOTION_COLORS = {
  joy: '#fbbf24',
  love: '#f472b6',
  sadness: '#60a5fa',
  anger: '#f87171',
  fear: '#a78bfa',
  surprise: '#34d399',
  disgust: '#6b7280',
  neutral: '#9ca3af',
};

function pressureColor(p) {
  if (p < 0.35) return '#4ade80';
  if (p < 0.6) return '#fbbf24';
  if (p < 0.8) return '#fb923c';
  return '#f87171';
}

function pressureLabel(p) {
  if (p < 0.35) return 'LOW';
  if (p < 0.6) return 'MOD';
  if (p < 0.8) return 'HIGH';
  return 'CRIT';
}

const PROTOCOL_COLORS = {
  sentinel: '#9ca3af',
  deep_work: '#60a5fa',
  creative: '#a78bfa',
  research: '#34d399',
  lockdown: '#f87171',
};

// What switching to each mode does (the modifiers in server/awareness/protocol-engine.js, as wired 2026-11-13)
const PROTOCOL_EFFECTS = {
  sentinel: 'Default. Daemon cycles at their normal pace, normal reflection depth, narrator every ~45 s.',
  deep_work: 'Cycles 1.2× as often, reflection 1.5× deeper; narrator quiet except audits, retirements and your own lines.',
  creative: 'Cycles 1.3× as often, reflection 1.2× deeper; narrator skips routine digests.',
  research: 'Cycles at 0.8× pace, reflection 1.4× deeper; narrator a little less often.',
  lockdown: 'Autonomous work paused: no goals, motor actions, autonomous reflection or self-modification. You stay in control.',
};

export default function ActivityPulseStrip({ wsEvent }) {
  const [data, setData] = useState({
    tier: 'DORMANT',
    proofsPassed: 0,
    emotion: 'neutral',
    emotionIntensity: 0,
    valence: 0,
    pressure: 0,
    fatigue: 0,
    activeAgents: 0,
    busRate: 0,
    protocol: 'sentinel',
  });
  const tickRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [gateRes, emotRes, resRes, metricsRes, protoRes] = await Promise.allSettled([
        fetch('/api/intelligence/consciousness/gate'),
        fetch('/api/intelligence/emotional-feedback'),
        fetch('/api/intelligence/resource-envelope'),
        fetch('/api/metrics'),
        fetch('/api/awareness/protocol'),
      ]);

      const updates = {};

      // Field names as the APIs send them. Until 2026-11-13 this strip read names none of them sent and showed its
      // defaults: DORMANT 0/4 while the gate was INTEGRATED 4/4, a pressure bar at 0, 0 agents, 0 bus messages.
      if (gateRes.status === 'fulfilled' && gateRes.value.ok) {
        const g = await gateRes.value.json();
        const st = g.currentState || {};
        updates.tier = st.tier?.label || g.modifiers?.tier || 'DORMANT';
        updates.proofsPassed = st.proofsPassed ?? 0;
        updates.phi = st.phi ?? null;
        updates.stale = !!st.stale;
      }

      if (emotRes.status === 'fulfilled' && emotRes.value.ok) {
        const e = await emotRes.value.json();
        const le = e.lastEmotion || {};
        updates.emotion = le.primary || 'neutral';
        updates.emotionShare = le.distribution?.[le.primary] ?? 0;
        updates.emotionIntensity = le.arousal ?? 0;
        updates.valence = le.valence ?? 0;
      }

      if (resRes.status === 'fulfilled' && resRes.value.ok) {
        const r = await resRes.value.json();
        updates.pressure = r.lastPressure ?? 0;
        updates.fatigue = r.fatigueLevel ?? 0;
        updates.activeAgents = r.lastResources?.concurrentRuns ?? 0;
        updates.busPerMin = r.lastResources?.busMessagesPerMin ?? 0;
      }

      if (metricsRes.status === 'fulfilled' && metricsRes.value.ok) {
        const m = await metricsRes.value.json();
        updates.runs24h = m.overview?.runs24h ?? 0;
      }

      if (protoRes.status === 'fulfilled' && protoRes.value.ok) {
        const p = await protoRes.value.json();
        updates.protocol = p.active?.name || 'sentinel';
        updates.protocols = p.available || [];
        updates.protocolInfo = p.active || null;
      }

      setData(prev => ({ ...prev, ...updates }));
    } catch (_) {}
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  // The protocol is a real switch now: each mode changes how often the daemon cycles, whether autonomous work runs,
  // how deep reflection goes and how often the narrator speaks (server/awareness/protocol-engine.js).
  const [menu, setMenu] = useState(false);
  const switchProtocol = async name => {
    setMenu(false);
    try {
      await fetch('/api/awareness/protocol/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: name, reason: 'operator (status strip)' }) });
    } catch (e) { console.error('protocol switch:', e.message); }
    refresh();
  };

  useEffect(() => {
    if (!wsEvent) return;
    const t = wsEvent.type;
    if (t === 'consciousness' || t === 'heart' || t === 'health' || t === 'intelligence' || t === 'autonomy') {
      tickRef.current++;
      if (tickRef.current % 2 === 0) refresh();
    }
  }, [wsEvent, refresh]);

  const tierColor = TIER_COLORS[data.tier] || '#6b7280';
  const emotColor = EMOTION_COLORS[data.emotion] || '#9ca3af';
  const presColor = pressureColor(data.pressure);
  const protoColor = PROTOCOL_COLORS[data.protocol] || '#9ca3af';

  return (
    <div className="pulse-strip" style={{
      display: 'flex', alignItems: 'center', gap: 2,
      height: 28, padding: '0 16px', flexShrink: 0,
      background: 'linear-gradient(180deg, #0e0e16 0%, #111118 100%)',
      borderBottom: '1px solid #1a1a25',
      fontSize: 11, color: '#888', overflow: 'hidden',
    }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .pulse-strip { scrollbar-width: none; }
        .pulse-strip::-webkit-scrollbar { display: none; }
        .pulse-gauge { display: flex; align-items: center; gap: 5px; padding: 0 10px; white-space: nowrap; border-right: 1px solid #1a1a25; height: 100%; }
        .pulse-gauge:last-child { border-right: none; }
        .pulse-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .pulse-bar { width: 40px; height: 4px; border-radius: 2px; background: #222; overflow: hidden; flex-shrink: 0; }
        .pulse-bar-fill { height: 100%; border-radius: 2px; transition: width 0.6s ease, background 0.4s ease; }
        @keyframes pulse-glow { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
        .pulse-alive { animation: pulse-glow 2s ease-in-out infinite; }
        @media (max-width: 900px) {
          .pulse-gauge { padding: 0 6px; gap: 3px; }
          .pulse-label { display: none; }
        }
        @media (max-width: 600px) {
          .pulse-strip { padding: 0 8px; gap: 0; }
          .pulse-bar { width: 28px; }
        }
      ` }} />

      {/* Consciousness Tier — from the latest audit of the live CTRNN */}
      <div className="pulse-gauge" title={`Consciousness gate: ${data.proofsPassed} of 4 proofs on the latest audit${data.phi != null ? `, Φ ${Number(data.phi).toFixed(3)}` : ''}${data.stale ? ' (audit is stale)' : ''}`}>
        <span className={data.tier === 'INTEGRATED' ? 'pulse-alive' : ''} style={{ color: tierColor, fontSize: 12, fontWeight: 700 }}>
          {TIER_ICONS[data.tier] || '○'}
        </span>
        <span style={{ color: tierColor, fontWeight: 600, letterSpacing: 0.5 }}>{data.tier}</span>
        <span style={{ color: '#777', fontSize: 9 }}>{data.proofsPassed}/4{data.phi != null ? ` · Φ ${Number(data.phi).toFixed(2)}` : ''}</span>
      </div>

      {/* Heart Emotion — dominant feeling in recent text and how strongly it dominates */}
      <div className="pulse-gauge" title={`Heart: ${data.emotion} is ${Math.round((data.emotionShare || 0) * 100)}% of recent readings · arousal ${Number(data.emotionIntensity || 0).toFixed(2)} · valence ${Number(data.valence || 0).toFixed(2)}`}>
        <div className="pulse-dot" style={{ background: emotColor, boxShadow: data.emotionIntensity > 0.5 ? `0 0 6px ${emotColor}` : 'none' }} />
        <span style={{ color: emotColor, textTransform: 'capitalize' }}>{data.emotion}</span>
        <div className="pulse-bar">
          <div className="pulse-bar-fill" style={{
            width: `${Math.round(Math.max(0, Math.min(1, data.emotionShare || 0)) * 100)}%`,
            background: emotColor,
          }} />
        </div>
      </div>

      {/* Resource Pressure */}
      <div className="pulse-gauge" title={`Resource pressure ${Number(data.pressure || 0).toFixed(2)} (heap, database, runs, model latency, bus, model queue) · fatigue ${Number(data.fatigue || 0).toFixed(2)}`}>
        <span style={{ fontSize: 10, color: presColor }}>
          {data.pressure >= 0.8 ? '▲' : data.pressure >= 0.6 ? '△' : '◇'}
        </span>
        <span className="pulse-label" style={{ color: '#666' }}>RES</span>
        <div className="pulse-bar">
          <div className="pulse-bar-fill" style={{
            width: `${Math.round(Math.max(0, Math.min(1, data.pressure)) * 100)}%`,
            background: presColor,
          }} />
        </div>
        <span style={{ color: presColor, fontWeight: 600, fontSize: 9 }}>{pressureLabel(data.pressure)} {Math.round((data.pressure || 0) * 100)}%</span>
      </div>

      {/* Agent runs in flight now, and today */}
      <div className="pulse-gauge" title={`${data.activeAgents} agent run(s) in flight · ${data.runs24h || 0} in the last 24 h`}>
        <span style={{ color: '#6366f1', fontSize: 10 }}>◈</span>
        <span style={{ color: '#6366f1', fontWeight: 600 }}>{data.activeAgents}</span>
        <span className="pulse-label" style={{ color: '#555' }}>running · {data.runs24h || 0} today</span>
      </div>

      {/* Bus traffic per minute */}
      <div className="pulse-gauge" title="Messages on the internal bus per minute">
        <span style={{ color: '#22d3ee', fontSize: 10 }}>⟡</span>
        <span style={{ color: '#22d3ee', fontWeight: 600 }}>{data.busPerMin ?? 0}</span>
        <span className="pulse-label" style={{ color: '#555' }}>bus / min</span>
      </div>

      {/* Protocol Mode — a switch that changes behaviour */}
      <div className="pulse-gauge" style={{ borderRight: 'none' }}>
        <button type="button" onClick={() => setMenu(m => !m)} title={data.protocolInfo?.description || 'Operating protocol'}
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid #262636', borderRadius: 5, padding: '1px 7px', cursor: 'pointer' }}>
          <span className="pulse-dot" style={{ background: protoColor }} />
          <span style={{ color: protoColor, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>
            {data.protocol.replace(/_/g, ' ')}
          </span>
          <span style={{ color: '#666', fontSize: 9 }}>▾</span>
        </button>
      </div>
      {menu && (
        <div style={{ position: 'fixed', top: 84, right: 16, zIndex: 50, background: '#11111a', border: '1px solid #262636', borderRadius: 8, padding: 6, width: 300, boxShadow: '0 12px 30px rgba(0,0,0,.5)' }}>
          {Object.entries(PROTOCOL_EFFECTS).map(([name, effect]) => (
            <button key={name} type="button" onClick={() => switchProtocol(name)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: data.protocol === name ? '#1b1b2a' : 'none', border: 'none', borderRadius: 6, padding: '6px 8px', cursor: 'pointer' }}>
              <span style={{ color: PROTOCOL_COLORS[name], fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{name.replace(/_/g, ' ')}{data.protocol === name ? ' · active' : ''}</span>
              <span style={{ display: 'block', color: '#888', fontSize: 10, marginTop: 2, lineHeight: 1.35 }}>{effect}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
