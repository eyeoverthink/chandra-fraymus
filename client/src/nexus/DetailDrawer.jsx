import React from 'react';
import ErrorBoundary from '../ErrorBoundary.jsx';
import DashboardPanel from '../panels/DashboardPanel.jsx';
import IntelligencePanel from '../panels/IntelligencePanel.jsx';
import FleetPanel from '../panels/FleetPanel.jsx';
import CommercePanel from '../panels/CommercePanel.jsx';
import AutomationsPanel from '../panels/AutomationsPanel.jsx';
import McpPanel from '../panels/McpPanel.jsx';
import BrowserPanel from '../panels/BrowserPanel.jsx';
import VertisoPanel from '../panels/VertisoPanel.jsx';
import OutlierPanel from '../panels/OutlierPanel.jsx';
import DeployPanel from '../panels/DeployPanel.jsx';
import BusPanel from '../panels/BusPanel.jsx';
import HealthPanel from '../panels/HealthPanel.jsx';
import MediaPanel from '../panels/MediaPanel.jsx';
import ForgePanel from '../panels/ForgePanel.jsx';
import SettingsPanel from '../panels/SettingsPanel.jsx';
import AgentChatPanel from '../panels/AgentChatPanel.jsx';
import ActivityTimeline from '../panels/ActivityTimeline.jsx';
import SystemMetrics from '../panels/SystemMetrics.jsx';
import AgentProfiles from '../panels/AgentProfiles.jsx';
import MemoryBrowser from '../panels/MemoryBrowser.jsx';

const PANELS = {
  dashboard: { component: DashboardPanel, label: 'System Dashboard', needsHealth: true },
  intelligence: { component: IntelligencePanel, label: 'Intelligence' },
  fleet: { component: FleetPanel, label: 'Agent Fleet' },
  bus: { component: BusPanel, label: 'Agent Live Bus' },
  commerce: { component: CommercePanel, label: 'Commerce Pipelines' },
  deploy: { component: DeployPanel, label: 'Deploy-as-API' },
  automations: { component: AutomationsPanel, label: 'Automations' },
  mcp: { component: McpPanel, label: 'MCP Gateway' },
  browser: { component: BrowserPanel, label: 'Browser' },
  vertiso: { component: VertisoPanel, label: 'Vertiso / RSI' },
  outlier: { component: OutlierPanel, label: 'Outlier Board' },
  health: { component: HealthPanel, label: 'System Health Monitor' },
  media: { component: MediaPanel, label: 'Media Hub' },
  forge: { component: ForgePanel, label: 'Forge + Synthesis' },
  settings: { component: SettingsPanel, label: 'System Settings' },
  chat: { component: AgentChatPanel, label: 'Agent Chat' },
  timeline: { component: ActivityTimeline, label: 'Activity Timeline' },
  metrics: { component: SystemMetrics, label: 'System Metrics' },
  profiles: { component: AgentProfiles, label: 'Agent Profiles' },
  memory: { component: MemoryBrowser, label: 'Memory Browser' },
};

export default function DetailDrawer({ panel, title, onClose, wsEvent, health }) {
  if (!panel || !PANELS[panel]) return null;
  const cfg = PANELS[panel];
  const Component = cfg.component;
  const props = { wsEvent };
  if (cfg.needsHealth) props.health = health;

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0,
      width: '55%', minWidth: 480, maxWidth: 900,
      background: '#0a0a0f', borderLeft: '1px solid #222',
      zIndex: 100, display: 'flex', flexDirection: 'column',
      boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
      animation: 'drawerSlide 0.2s ease-out',
    }}>
      <style>{`@keyframes drawerSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', borderBottom: '1px solid #222', flexShrink: 0,
      }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e8', margin: 0 }}>
          {title || cfg.label}
        </h3>
        <button onClick={onClose} style={{
          background: '#1a1a2e', border: '1px solid #333', borderRadius: 6,
          padding: '4px 12px', color: '#888', cursor: 'pointer', fontSize: 13,
        }}>✕ Close</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <ErrorBoundary label={cfg.label}>
          <Component {...props} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
