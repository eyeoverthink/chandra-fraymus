import React, { useState, useEffect } from 'react';
import useWebSocket from './useWebSocket.js';
import WorkflowCanvas from './panels/WorkflowCanvas.jsx';
import FleetPanel from './panels/FleetPanel.jsx';
import AutomationsPanel from './panels/AutomationsPanel.jsx';
import McpPanel from './panels/McpPanel.jsx';
import DashboardPanel from './panels/DashboardPanel.jsx';
import BrowserPanel from './panels/BrowserPanel.jsx';
import VertisoPanel from './panels/VertisoPanel.jsx';
import OutlierPanel from './panels/OutlierPanel.jsx';
import IntelligencePanel from './panels/IntelligencePanel.jsx';
import CommercePanel from './panels/CommercePanel.jsx';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '◈' },
  { id: 'intelligence', label: 'Intelligence', icon: '♦' },
  { id: 'canvas', label: 'Workflow Canvas', icon: '⬡' },
  { id: 'fleet', label: 'Agent Fleet', icon: '⚡' },
  { id: 'automations', label: 'Automations', icon: '⟳' },
  { id: 'mcp', label: 'MCP Gateway', icon: '⬢' },
  { id: 'browser', label: 'Browser', icon: '◉' },
  { id: 'vertiso', label: 'Vertiso / RSI', icon: '◇' },
  { id: 'commerce', label: 'Commerce', icon: '◆' },
  { id: 'outlier', label: 'Outlier Board', icon: '◎' },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [health, setHealth] = useState(null);
  const wsEvent = useWebSocket();

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {});
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <nav style={{
        width: 220, background: '#111118', borderRight: '1px solid #222', display: 'flex',
        flexDirection: 'column', padding: '16px 0', flexShrink: 0,
      }}>
        <div style={{ padding: '0 16px 20px', borderBottom: '1px solid #222' }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#a78bfa', letterSpacing: 1 }}>CHANDRA</h1>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>FRAYMUS UNIFIED</div>
        </div>
        <div style={{ flex: 1, paddingTop: 12 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: 13,
              background: tab === t.id ? '#1a1a2e' : 'transparent',
              color: tab === t.id ? '#a78bfa' : '#888',
              borderLeft: tab === t.id ? '3px solid #a78bfa' : '3px solid transparent',
              transition: 'all 0.15s',
            }}>
              <span style={{ fontSize: 16 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid #222', fontSize: 11, color: '#555' }}>
          {health ? `Port ${health.workspace ? '' : ''}8787 · ${health.features?.length || 0} features` : 'Connecting...'}
        </div>
      </nav>

      <main style={{ flex: 1, overflow: 'auto', background: '#0a0a0f' }}>
        {tab === 'dashboard' && <DashboardPanel health={health} wsEvent={wsEvent} />}
        {tab === 'intelligence' && <IntelligencePanel wsEvent={wsEvent} />}
        {tab === 'canvas' && <WorkflowCanvas wsEvent={wsEvent} />}
        {tab === 'fleet' && <FleetPanel wsEvent={wsEvent} />}
        {tab === 'automations' && <AutomationsPanel wsEvent={wsEvent} />}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'vertiso' && <VertisoPanel wsEvent={wsEvent} />}
        {tab === 'commerce' && <CommercePanel wsEvent={wsEvent} />}
        {tab === 'outlier' && <OutlierPanel />}
      </main>
    </div>
  );
}
