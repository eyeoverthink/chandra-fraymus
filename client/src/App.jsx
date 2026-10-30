import React, { useState, useEffect } from 'react';
import useWebSocket from './useWebSocket.js';
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
  const wsEvent = useWebSocket();

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {});
  }, []);

  const openDrawer = (panel, title) => setDrawer({ panel, title });
  const closeDrawer = () => setDrawer(null);

  return (
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

        <div style={{ marginLeft: 'auto', fontSize: 11, color: '#555' }}>
          {health ? `Port 8787 · ${health.features?.length || 0} features` : 'Connecting...'}
        </div>
      </nav>

      <main style={{ flex: 1, overflow: 'auto', background: '#0a0a0f', position: 'relative' }}>
        {view === 'command' && (
          <CommandCenter health={health} wsEvent={wsEvent} onOpenDrawer={openDrawer} onNavigate={setView} />
        )}
        {view === 'constellation' && (
          <ConstellationView wsEvent={wsEvent} onOpenDrawer={openDrawer} onNavigate={setView} />
        )}
        {view === 'canvas' && <WorkflowCanvas wsEvent={wsEvent} />}
        {view === 'library' && <LibraryView wsEvent={wsEvent} onOpenDrawer={openDrawer} />}
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
    </div>
  );
}
