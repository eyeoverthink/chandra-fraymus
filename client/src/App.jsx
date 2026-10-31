import React, { useState, useEffect, useCallback, useRef } from 'react';
import useWebSocket from './useWebSocket.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import ToastProvider from './ToastProvider.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import useKeyboardShortcuts from './useKeyboardShortcuts.js';
import ShortcutHelp from './ShortcutHelp.jsx';
import WorkflowCanvas from './panels/WorkflowCanvas.jsx';
import CommandCenter from './nexus/CommandCenter.jsx';
import ConstellationView from './nexus/ConstellationView.jsx';
import LibraryView from './nexus/LibraryView.jsx';
import DetailDrawer from './nexus/DetailDrawer.jsx';

const VIEWS = [
  { id: 'command', label: 'Command Center', icon: '◈' },
  { id: 'constellation', label: 'Constellation', icon: '✦' },
  { id: 'canvas', label: 'Canvas', icon: '⬡' },
  { id: 'library', label: 'Library', icon: '▤' },
];

const NAV_BUTTONS = [
  { panel: 'chat', title: 'Agent Chat', icon: '◈', label: 'Chat', color: '#a78bfa' },
  { panel: 'timeline', title: 'Activity Timeline', icon: '⏱', label: 'Timeline', color: '#34d399' },
  { panel: 'metrics', title: 'System Metrics', icon: '◉', label: 'Metrics', color: '#60a5fa' },
  { panel: 'profiles', title: 'Agent Profiles', icon: '⊕', label: 'Profiles', color: '#f59e0b' },
  { panel: 'memory', title: 'Memory Browser', icon: '⧉', label: 'Memory', color: '#10b981' },
  { panel: 'run-history', title: 'Run History', icon: '▶', label: 'Runs', color: '#f87171' },
  { panel: 'evolution', title: 'Evolution Log', icon: '◎', label: 'Evo', color: '#a78bfa' },
  { panel: 'pulse', title: 'System Pulse', icon: '♥', label: 'Pulse', color: '#34d399' },
  { panel: 'leaderboard', title: 'Agent Leaderboard', icon: '★', label: 'Board', color: '#f59e0b' },
  { panel: 'collab', title: 'Agent Collaboration', icon: '⊗', label: 'Collab', color: '#7c3aed' },
];

function NavButton({ btn, openDrawer }) {
  return (
    <button onClick={() => openDrawer(btn.panel, btn.title)} className="nav-btn" style={{
      background: 'none', border: '1px solid #333', borderRadius: 6,
      color: '#666', fontSize: 13, padding: '4px 10px', cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s',
      whiteSpace: 'nowrap',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = btn.color; e.currentTarget.style.color = btn.color; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#666'; }}
    >
      <span style={{ fontSize: 12 }}>{btn.icon}</span>
      <span className="nav-btn-label">{btn.label}</span>
    </button>
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
          <GlobalSearch onOpenDrawer={openDrawer} onNavigate={setView} externalOpen={searchOpen} onExternalClose={() => setSearchOpen(false)} />
          {NAV_BUTTONS.map(btn => <NavButton key={btn.panel} btn={btn} openDrawer={openDrawer} />)}
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
      </main>

      {drawer && (
        <>
          <div onClick={closeDrawer} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            zIndex: 99, cursor: 'pointer',
          }} />
          <DetailDrawer
            panel={drawer.panel} title={drawer.title}
            onClose={closeDrawer} wsEvent={wsEvent} health={health}
          />
        </>
      )}
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
    </ToastProvider>
  );
}
