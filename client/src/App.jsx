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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <nav style={{
        display: 'flex', alignItems: 'center', height: 52, padding: '0 20px',
        background: '#111118', borderBottom: '1px solid #222', flexShrink: 0, gap: 4,
      }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8, marginRight: 32,
        }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: '#a78bfa', letterSpacing: 1, margin: 0 }}>CHANDRA</h1>
          <span style={{ fontSize: 10, color: '#555' }}>NEXUS</span>
        </div>

        <div style={{ display: 'flex', gap: 2 }}>
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
              {v.label}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#555' }}>
          <GlobalSearch onOpenDrawer={openDrawer} onNavigate={setView} externalOpen={searchOpen} onExternalClose={() => setSearchOpen(false)} />
          <button onClick={() => openDrawer('chat', 'Agent Chat')} style={{
            background: 'none', border: '1px solid #333', borderRadius: 6,
            color: '#666', fontSize: 13, padding: '4px 10px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#a78bfa'; e.currentTarget.style.color = '#a78bfa'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#666'; }}
          >
            <span style={{ fontSize: 12 }}>◈</span> Chat
          </button>
          <button onClick={() => openDrawer('timeline', 'Activity Timeline')} style={{
            background: 'none', border: '1px solid #333', borderRadius: 6,
            color: '#666', fontSize: 13, padding: '4px 10px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#34d399'; e.currentTarget.style.color = '#34d399'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#666'; }}
          >
            <span style={{ fontSize: 12 }}>⏱</span> Timeline
          </button>
          <button onClick={() => openDrawer('metrics', 'System Metrics')} style={{
            background: 'none', border: '1px solid #333', borderRadius: 6,
            color: '#666', fontSize: 13, padding: '4px 10px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#60a5fa'; e.currentTarget.style.color = '#60a5fa'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#666'; }}
          >
            <span style={{ fontSize: 12 }}>◉</span> Metrics
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: '#555' }}>
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
