import React, { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import useWebSocket from './useWebSocket.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import ToastProvider from './ToastProvider.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import useKeyboardShortcuts from './useKeyboardShortcuts.js';
import ShortcutHelp from './ShortcutHelp.jsx';
import ActivityPulseStrip from './hud/ActivityPulseStrip.jsx';
import NudgeToast from './hud/NudgeToast.jsx';
import ProtocolSelector from './hud/ProtocolSelector.jsx';
import WorkflowCanvas from './panels/WorkflowCanvas.jsx';
import CommandCenter from './nexus/CommandCenter.jsx';
import ConstellationView from './nexus/ConstellationView.jsx';
import LibraryView from './nexus/LibraryView.jsx';
import DetailDrawer from './nexus/DetailDrawer.jsx';

const ManifestationPlane = lazy(() => import('./nexus/ManifestationPlane.jsx'));

const VIEWS = [
  { id: 'command', label: 'Command Center', icon: '◈' },
  { id: 'constellation', label: 'Constellation', icon: '✦' },
  { id: 'canvas', label: 'Canvas', icon: '⬡' },
  { id: 'library', label: 'Library', icon: '▤' },
  { id: 'manifold', label: 'Manifold', icon: '◬' },
];

const NAV_GROUPS = [
  {
    id: 'intelligence', label: 'Intelligence', icon: '⚡', color: '#c084fc',
    items: [
      { panel: 'nerve-center', title: 'Nerve Center', icon: '⚡', label: 'Nerve Center' },
      { panel: 'subconscious', title: 'Subconscious Engine', icon: '🧠', label: 'Subconscious' },
      { panel: 'observatory', title: 'Intelligence Observatory', icon: '🔭', label: 'Observatory' },
      { panel: 'strategy', title: 'Strategy Engine', icon: '🧭', label: 'Strategy' },
      { panel: 'cross-tab', title: 'Cross-Tab Intelligence', icon: '🌐', label: 'Cross-Tab' },
      { panel: 'ouroboros-cycle', title: 'Ouroboros RSI', icon: '🐍', label: 'Ouroboros RSI' },
      { panel: 'ouroboros-lineage', title: 'Ouroboros Lineage', icon: '🧬', label: 'Lineage' },
    ],
  },
  {
    id: 'fleet', label: 'Fleet', icon: '🤖', color: '#6366f1',
    items: [
      { panel: 'chat', title: 'Agent Chat', icon: '💬', label: 'Agent Chat' },
      { panel: 'profiles', title: 'Agent Profiles', icon: '🤖', label: 'Profiles' },
      { panel: 'leaderboard', title: 'Agent Leaderboard', icon: '🏆', label: 'Leaderboard' },
      { panel: 'collab', title: 'Agent Collaboration', icon: '🤝', label: 'Collaboration' },
      { panel: 'trust', title: 'Trust Engine', icon: '🛡', label: 'Trust' },
    ],
  },
  {
    id: 'ops', label: 'Ops', icon: '📊', color: '#34d399',
    items: [
      { panel: 'timeline', title: 'Activity Timeline', icon: '📜', label: 'Timeline' },
      { panel: 'metrics', title: 'System Metrics', icon: '📊', label: 'Metrics' },
      { panel: 'run-history', title: 'Run History', icon: '▶️', label: 'Run History' },
      { panel: 'pulse', title: 'System Pulse', icon: '💓', label: 'Pulse' },
      { panel: 'evolution', title: 'Evolution Log', icon: '🔬', label: 'Evolution' },
    ],
  },
  {
    id: 'protocols', label: 'Protocols', icon: '⛓️', color: '#f59e0b',
    items: [
      { panel: 'chain', title: 'Logic Chain', icon: '⛓️', label: 'Logic Chain' },
      { panel: 'debate', title: 'Debate Protocol', icon: '⚔️', label: 'Debate' },
      { panel: 'swarm', title: 'Swarm Protocol', icon: '🐝', label: 'Swarm' },
    ],
  },
  {
    id: 'system', label: 'System', icon: '🔒', color: '#f87171',
    items: [
      { panel: 'memory', title: 'Memory Browser', icon: '💭', label: 'Memory' },
      { panel: 'integrity', title: 'System Integrity', icon: '🔒', label: 'Integrity' },
      { panel: 'content-nexus', title: 'Content Nexus', icon: '📡', label: 'Content Nexus' },
    ],
  },
];

function NavGroup({ group, openDrawer, isOpen, onToggle, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={onToggle} className="nav-btn" style={{
        background: isOpen ? `${group.color}15` : 'none',
        border: `1px solid ${isOpen ? group.color : '#444'}`, borderRadius: 6,
        color: isOpen ? group.color : '#aaa', fontSize: 13, padding: '4px 10px',
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
        transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}
        onMouseEnter={e => { if (!isOpen) { e.currentTarget.style.borderColor = group.color; e.currentTarget.style.color = group.color; }}}
        onMouseLeave={e => { if (!isOpen) { e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#aaa'; }}}
      >
        <span style={{ fontSize: 12 }}>{group.icon}</span>
        <span className="nav-btn-label">{group.label}</span>
        <span style={{ fontSize: 8, marginLeft: 2, opacity: 0.5 }}>{isOpen ? '▲' : '▼'}</span>
      </button>
      {isOpen && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          background: '#151520', border: '1px solid #333', borderRadius: 8,
          padding: '4px 0', minWidth: 190, zIndex: 100,
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          {group.items.map(item => (
            <button key={item.panel} onClick={() => { openDrawer(item.panel, item.title); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 14px', border: 'none', background: 'transparent',
                color: '#ccc', fontSize: 13, cursor: 'pointer', textAlign: 'left',
                transition: 'background 0.1s, color 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = `${group.color}15`; e.currentTarget.style.color = group.color; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#ccc'; }}
            >
              <span style={{ fontSize: 14, width: 20, textAlign: 'center' }}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const RESPONSIVE_CSS = `
  @media (max-width: 1024px) {
    .nav-btn-label { display: none !important; }
    .nav-btn { padding: 4px 8px !important; min-width: 32px; justify-content: center; }
    .view-label { display: none !important; }
    .nav-panels { gap: 4px !important; flex-wrap: wrap !important; }
    .chandra-title { margin-right: 12px !important; }
  }
  @media (max-width: 768px) {
    .chandra-nav { height: auto !important; padding: 8px 12px !important; flex-wrap: wrap !important; gap: 8px !important; }
    .chandra-title { margin-right: 8px !important; }
    .chandra-title h1 { font-size: 14px !important; }
    .nav-views { gap: 1px !important; }
    .nav-views button { padding: 6px 10px !important; font-size: 12px !important; }
    .nav-panels { order: 3; width: 100%; overflow-x: auto; padding: 4px 0; -webkit-overflow-scrolling: touch; }
    .nav-panels::-webkit-scrollbar { height: 3px; }
    .nav-panels::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
    .nav-status { order: 2; }
    .detail-drawer { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
  }
  @media (max-width: 480px) {
    .chandra-nav { padding: 6px 8px !important; }
    .nav-views button { padding: 4px 6px !important; font-size: 11px !important; }
    .nav-btn { padding: 3px 6px !important; font-size: 11px !important; }
    .nav-btn span:first-child { font-size: 10px !important; }
  }
`;

export default function App() {
  const [view, setView] = useState('command');
  const [health, setHealth] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState(null);
  const { lastEvent: wsEvent, wsStatus } = useWebSocket();

  const handleShortcut = useCallback((action) => {
    if (action === 'help') { setShowHelp(h => !h); return; }
    if (action === 'search') { setSearchOpen(true); return; }
    if (action === 'close') { setDrawer(null); setShowHelp(false); setSearchOpen(false); return; }
    if (action === 'chat') { setDrawer({ panel: 'chat', title: 'Agent Chat' }); return; }
    if (action === 'timeline') { setDrawer({ panel: 'timeline', title: 'Activity Timeline' }); return; }
    if (action === 'metrics') { setDrawer({ panel: 'metrics', title: 'System Metrics' }); return; }
    if (action === 'profiles') { setDrawer({ panel: 'profiles', title: 'Agent Profiles' }); return; }
    if (action === 'memory') { setDrawer({ panel: 'memory', title: 'Memory Browser' }); return; }
    if (action === 'run-history') { setDrawer({ panel: 'run-history', title: 'Run History' }); return; }
    if (action === 'evolution') { setDrawer({ panel: 'evolution', title: 'Evolution Log' }); return; }
    if (action === 'pulse') { setDrawer({ panel: 'pulse', title: 'System Pulse' }); return; }
    if (action === 'leaderboard') { setDrawer({ panel: 'leaderboard', title: 'Agent Leaderboard' }); return; }
    if (action === 'collab') { setDrawer({ panel: 'collab', title: 'Agent Collaboration' }); return; }
    if (action === 'creation') { setDrawer({ panel: 'creation', title: 'Creation Pipeline' }); return; }
    if (action === 'nerve-center') { setDrawer({ panel: 'nerve-center', title: 'Intelligence Nerve Center' }); return; }
    if (action === 'distribution') { setDrawer({ panel: 'distribution', title: 'Social Distribution' }); return; }
    if (action === 'analytics') { setDrawer({ panel: 'analytics', title: 'Analytics Feedback' }); return; }
    if (action === 'learning-loop') { setDrawer({ panel: 'learning-loop', title: 'Commerce Learning Loop' }); return; }
    if (action === 'calendar') { setDrawer({ panel: 'calendar', title: 'Content Calendar' }); return; }
    if (action === 'ab-testing') { setDrawer({ panel: 'ab-testing', title: 'A/B Testing Engine' }); return; }
    if (action === 'trend-radar') { setDrawer({ panel: 'trend-radar', title: 'Trend Radar' }); return; }
    if (action === 'audience') { setDrawer({ panel: 'audience', title: 'Audience Intelligence' }); return; }
    if (action === 'repurpose') { setDrawer({ panel: 'repurpose', title: 'Content Repurposing' }); return; }
    if (action === 'chain') { setDrawer({ panel: 'chain', title: 'Logic Chain' }); return; }
    if (action === 'debate') { setDrawer({ panel: 'debate', title: 'Debate Protocol' }); return; }
    if (action === 'swarm') { setDrawer({ panel: 'swarm', title: 'Swarm Protocol' }); return; }
    if (action === 'strategy') { setDrawer({ panel: 'strategy', title: 'Strategy Engine' }); return; }
    if (action === 'trust') { setDrawer({ panel: 'trust', title: 'Trust Engine' }); return; }
    if (action === 'subconscious') { setDrawer({ panel: 'subconscious', title: 'Subconscious Engine' }); return; }
    if (action === 'ouroboros-cycle') { setDrawer({ panel: 'ouroboros-cycle', title: 'Ouroboros RSI' }); return; }
    if (action === 'ouroboros-lineage') { setDrawer({ panel: 'ouroboros-lineage', title: 'Ouroboros Lineage' }); return; }
    if (action.startsWith('view:')) {
      setView(action.slice(5));
      setDrawer(null);
    }
  }, []);

  useKeyboardShortcuts({ onAction: handleShortcut });

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {});
  }, []);

  const openDrawer = (panel, title) => setDrawer({ panel, title });
  const closeDrawer = () => setDrawer(null);

  return (
    <ToastProvider wsEvent={wsEvent}>
    <style dangerouslySetInnerHTML={{ __html: RESPONSIVE_CSS }} />
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <nav className="chandra-nav" style={{
        display: 'flex', alignItems: 'center', height: 52, padding: '0 20px',
        background: '#111118', borderBottom: '1px solid #222', flexShrink: 0, gap: 4,
      }}>
        <div className="chandra-title" style={{
          display: 'flex', alignItems: 'baseline', gap: 8, marginRight: 32, flexShrink: 0,
        }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: '#a78bfa', letterSpacing: 1, margin: 0 }}>CHANDRA</h1>
          <span style={{ fontSize: 10, color: '#555' }}>NEXUS</span>
        </div>

        <div className="nav-views" style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          {VIEWS.map(v => (
            <button key={v.id} onClick={() => { setView(v.id); closeDrawer(); }} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13,
              borderRadius: 8, fontWeight: view === v.id ? 600 : 400,
              background: view === v.id ? '#a78bfa18' : 'transparent',
              color: view === v.id ? '#a78bfa' : '#888',
              transition: 'all 0.15s',
            }}>
              <span style={{ fontSize: 14 }}>{v.icon}</span>
              <span className="view-label">{v.label}</span>
            </button>
          ))}
        </div>

        <div className="nav-panels" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ProtocolSelector />
          <GlobalSearch onOpenDrawer={openDrawer} onNavigate={setView} externalOpen={searchOpen} onExternalClose={() => setSearchOpen(false)} />
          {NAV_GROUPS.map(g => (
            <NavGroup key={g.id} group={g} openDrawer={openDrawer}
              isOpen={openGroup === g.id}
              onToggle={() => setOpenGroup(prev => prev === g.id ? null : g.id)}
              onClose={() => setOpenGroup(null)}
            />
          ))}
        </div>
        <div className="nav-status" style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: '#555', flexShrink: 0 }}>
          {wsStatus !== 'connected' && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color: wsStatus === 'reconnecting' ? '#f59e0b' : '#f87171',
              animation: wsStatus === 'reconnecting' ? 'pulse 1.5s infinite' : 'none',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: wsStatus === 'reconnecting' ? '#f59e0b' : '#f87171',
              }} />
              {wsStatus === 'connecting' ? 'Connecting...' : wsStatus === 'reconnecting' ? 'Reconnecting...' : 'Connection error'}
            </span>
          )}
          {health ? `Port 8787 · ${health.features?.length || 0} features` : 'Connecting...'}
        </div>
      </nav>

      <ActivityPulseStrip wsEvent={wsEvent} />

      <main style={{ flex: 1, overflow: 'auto', background: '#0a0a0f', position: 'relative' }}>
        {view === 'command' && (
          <ErrorBoundary label="Command Center">
            <CommandCenter health={health} wsEvent={wsEvent} onOpenDrawer={openDrawer} onNavigate={setView} />
          </ErrorBoundary>
        )}
        {view === 'constellation' && (
          <ErrorBoundary label="Constellation">
            <ConstellationView wsEvent={wsEvent} onOpenDrawer={openDrawer} onNavigate={setView} />
          </ErrorBoundary>
        )}
        {view === 'canvas' && (
          <ErrorBoundary label="Canvas">
            <WorkflowCanvas wsEvent={wsEvent} />
          </ErrorBoundary>
        )}
        {view === 'library' && (
          <ErrorBoundary label="Library">
            <LibraryView wsEvent={wsEvent} onOpenDrawer={openDrawer} />
          </ErrorBoundary>
        )}
        {view === 'manifold' && (
          <ErrorBoundary label="Manifold">
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555', fontSize: 14 }}>Loading ManifestationPlane...</div>}>
              <ManifestationPlane wsEvent={wsEvent} />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      {drawer && (
        <>
          <div onClick={closeDrawer} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            zIndex: 99, cursor: 'pointer',
          }} />
          <DetailDrawer
            panel={drawer.panel} title={drawer.title}
            onClose={closeDrawer} wsEvent={wsEvent} health={health} onOpenPanel={openDrawer}
          />
        </>
      )}
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
      <NudgeToast wsEvent={wsEvent} />
    </div>
    </ToastProvider>
  );
}
