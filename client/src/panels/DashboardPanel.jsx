import React, { useState, useEffect } from 'react';

export default function DashboardPanel({ health }) {
  const [agents, setAgents] = useState([]);
  const [events, setEvents] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);

  useEffect(() => {
    fetch('/api/fleet/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
    fetch('/api/events?limit=15').then(r => r.json()).then(d => setEvents(Array.isArray(d) ? d : [])).catch(() => {});
    fetch('/api/workflows').then(r => r.json()).then(d => setWorkflows(d.workflows || [])).catch(() => {});
    fetch('/api/mcp/servers').then(r => r.json()).then(d => setMcpServers(d.servers || d || [])).catch(() => {});
  }, []);

  const features = health?.features || [];
  const fraymusFeatures = features.filter(f => f.startsWith('fraymus-'));
  const chandraFeatures = features.filter(f => !f.startsWith('fraymus-'));

  const card = (title, value, color) => (
    <div style={{
      background: '#111118', borderRadius: 12, padding: 20,
      border: '1px solid #222', textAlign: 'center',
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{title}</div>
    </div>
  );

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#a78bfa' }}>Chandra-FRAYMUS Unified Dashboard</h2>
        <p style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
          Autonomous AI workspace with visual workflows, 16-agent fleet, MCP gateway, and full FRAYMUS intelligence stack.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
        {card('Fleet Agents', agents.length, '#a78bfa')}
        {card('Workflows', workflows.length, '#6366f1')}
        {card('MCP Servers', mcpServers.length, '#10b981')}
        {card('Features', features.length, '#ec4899')}
        {card('FRAYMUS Tools', fraymusFeatures.length * 3, '#f59e0b')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e8', marginBottom: 12 }}>System Capabilities</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {features.map(f => (
              <div key={f} style={{
                fontSize: 11, padding: '4px 8px', borderRadius: 4,
                background: f.startsWith('fraymus-') ? '#6366f120' : '#10b98120',
                color: f.startsWith('fraymus-') ? '#a78bfa' : '#10b981',
              }}>{f}</div>
            ))}
            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: '#ec489920', color: '#ec4899' }}>visual-workflow-engine</div>
            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: '#ec489920', color: '#ec4899' }}>16-agent-fleet</div>
            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: '#ec489920', color: '#ec4899' }}>mcp-server-gateway</div>
            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: '#ec489920', color: '#ec4899' }}>mcp-client-bridge</div>
            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: '#ec489920', color: '#ec4899' }}>cron-automations</div>
          </div>
        </div>

        <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e8', marginBottom: 12 }}>Recent Activity</h3>
          {events.length === 0 && <div style={{ color: '#555', fontSize: 12 }}>No recent events.</div>}
          {events.slice(0, 10).map((e, i) => (
            <div key={i} style={{ fontSize: 11, color: '#888', marginBottom: 6, display: 'flex', gap: 8 }}>
              <span style={{ color: '#555', minWidth: 65 }}>{new Date(e.created_at).toLocaleTimeString()}</span>
              <span style={{ color: '#a78bfa' }}>{e.kind}</span>
              <span>{e.detail?.slice(0, 80)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
