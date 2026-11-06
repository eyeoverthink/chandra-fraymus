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

      if (gateRes.status === 'fulfilled' && gateRes.value.ok) {
        const g = await gateRes.value.json();
        updates.tier = g.tier || g.state?.tier || 'DORMANT';
        updates.proofsPassed = g.proofsPassed ?? g.state?.proofsPassed ?? 0;
      }

      if (emotRes.status === 'fulfilled' && emotRes.value.ok) {
        const e = await emotRes.value.json();
        updates.emotion = e.primaryEmotion || e.emotion || 'neutral';
        updates.emotionIntensity = e.intensity ?? e.emotionIntensity ?? 0;
        updates.valence = e.valence ?? 0;
      }

      if (resRes.status === 'fulfilled' && resRes.value.ok) {
        const r = await resRes.value.json();
        updates.pressure = r.pressure ?? r.currentPressure ?? 0;
        updates.fatigue = r.fatigue ?? 0;
      }

      if (metricsRes.status === 'fulfilled' && metricsRes.value.ok) {
        const m = await metricsRes.value.json();
        updates.activeAgents = m.overview?.totalAgents ?? m.activeAgents ?? 0;
        updates.busRate = m.overview?.busMessages ?? m.busRate ?? 0;
      }

      if (protoRes.status === 'fulfilled' && protoRes.value.ok) {
        const p = await protoRes.value.json();
        updates.protocol = p.active?.name || p.protocol || 'sentinel';
      }

      setData(prev => ({ ...prev, ...updates }));
    } catch (_) {}
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

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

      {/* Consciousness Tier */}
      <div className="pulse-gauge">
        <span className={data.tier === 'INTEGRATED' ? 'pulse-alive' : ''} style={{ color: tierColor, fontSize: 12, fontWeight: 700 }}>
          {TIER_ICONS[data.tier] || '○'}
        </span>
        <span style={{ color: tierColor, fontWeight: 600, letterSpacing: 0.5 }}>{data.tier}</span>
        <span style={{ color: '#555', fontSize: 9 }}>{data.proofsPassed}/4</span>
      </div>

      {/* Heart Emotion */}
      <div className="pulse-gauge">
        <div className="pulse-dot" style={{ background: emotColor, boxShadow: data.emotionIntensity > 0.5 ? `0 0 6px ${emotColor}` : 'none' }} />
        <span style={{ color: emotColor, textTransform: 'capitalize' }}>{data.emotion}</span>
        <div className="pulse-bar">
          <div className="pulse-bar-fill" style={{
            width: `${Math.round(Math.max(0, Math.min(1, data.emotionIntensity)) * 100)}%`,
            background: emotColor,
          }} />
        </div>
      </div>

      {/* Resource Pressure */}
      <div className="pulse-gauge">
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
        <span style={{ color: presColor, fontWeight: 600, fontSize: 9 }}>{pressureLabel(data.pressure)}</span>
      </div>

      {/* Active Agents */}
      <div className="pulse-gauge">
        <span style={{ color: '#6366f1', fontSize: 10 }}>◈</span>
        <span style={{ color: '#6366f1', fontWeight: 600 }}>{data.activeAgents}</span>
        <span className="pulse-label" style={{ color: '#555' }}>agents</span>
      </div>

      {/* Bus Rate */}
      <div className="pulse-gauge">
        <span style={{ color: '#22d3ee', fontSize: 10 }}>⟡</span>
        <span style={{ color: '#22d3ee', fontWeight: 600 }}>{data.busRate}</span>
        <span className="pulse-label" style={{ color: '#555' }}>bus msg</span>
      </div>

      {/* Protocol Mode */}
      <div className="pulse-gauge" style={{ borderRight: 'none' }}>
        <div className="pulse-dot" style={{ background: protoColor }} />
        <span style={{ color: protoColor, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>
          {data.protocol.replace(/_/g, ' ')}
        </span>
      </div>
    </div>
  );
}
