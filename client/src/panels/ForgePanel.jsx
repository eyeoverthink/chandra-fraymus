import React, { useState, useEffect, useCallback } from 'react';

export default function ForgePanel({ wsEvent }) {
  const [tab, setTab] = useState('forge');
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [forging, setForging] = useState(false);
  const [forgeResult, setForgeResult] = useState(null);
  const [forgedAgents, setForgedAgents] = useState([]);
  const [synthGoal, setSynthGoal] = useState('');
  const [synthConstraints, setSynthConstraints] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthResult, setSynthResult] = useState(null);
  const [synthesized, setSynthesized] = useState([]);

  const loadHistory = useCallback(() => {
    fetch('/api/fleet/forge/history').then(r => r.json()).then(d => setForgedAgents(d.forged || [])).catch(() => {});
    fetch('/api/workflows/synthesized').then(r => r.json()).then(d => setSynthesized(d.synthesized || [])).catch(() => {});
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => {
    if (wsEvent?.type && ['agents', 'workflow', 'forge'].includes(wsEvent.type)) loadHistory();
  }, [wsEvent, loadHistory]);

  const handleForge = async () => {
    if (!goal.trim() || forging) return;
    setForging(true);
    setForgeResult(null);
    try {
      const res = await fetch('/api/fleet/forge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim(), context: context.trim() || undefined }),
      });
      const data = await res.json();
      setForgeResult(data);
      setGoal('');
      setContext('');
      loadHistory();
    } catch (e) {
      setForgeResult({ error: e.message });
    } finally {
      setForging(false);
    }
  };

  const handleSynthesize = async () => {
    if (!synthGoal.trim() || synthesizing) return;
    setSynthesizing(true);
    setSynthResult(null);
    try {
      const res = await fetch('/api/workflows/synthesize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: synthGoal.trim(), constraints: synthConstraints.trim() || undefined }),
      });
      const data = await res.json();
      setSynthResult(data);
      setSynthGoal('');
      setSynthConstraints('');
      loadHistory();
    } catch (e) {
      setSynthResult({ error: e.message });
    } finally {
      setSynthesizing(false);
    }
  };

  const removeForged = async (agentId) => {
    try {
      await fetch(`/api/fleet/forge/${agentId}`, { method: 'DELETE' });
      loadHistory();
    } catch {}
  };

  const TABS = [
    { id: 'forge', label: 'Agent Forge', icon: '⚡' },
    { id: 'synth', label: 'Workflow Synthesis', icon: '⬡' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f59e0b', marginBottom: 4 }}>
        Forge + Synthesis
      </h2>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 20 }}>
        Create new agents from goals or synthesize workflows from descriptions
      </p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 16px', border: 'none', borderRadius: 8, cursor: 'pointer',
            fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
            background: tab === t.id ? '#f59e0b22' : '#111118',
            color: tab === t.id ? '#f59e0b' : '#888',
            transition: 'all 0.15s',
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'forge' && (
        <div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222', marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b', marginBottom: 12 }}>
              Forge a New Agent
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>Goal</label>
              <input value={goal} onChange={e => setGoal(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleForge()}
                placeholder="e.g. An agent that summarizes long articles into bullet points"
                style={{
                  width: '100%', background: '#1a1a2e', border: '1px solid #333', borderRadius: 8,
                  padding: '10px 14px', color: '#e0e0e8', fontSize: 13, boxSizing: 'border-box',
                }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>Context (optional)</label>
              <textarea value={context} onChange={e => setContext(e.target.value)}
                placeholder="Any constraints, preferred tools, or additional context..."
                rows={3} style={{
                  width: '100%', background: '#1a1a2e', border: '1px solid #333', borderRadius: 8,
                  padding: '10px 14px', color: '#e0e0e8', fontSize: 13, resize: 'vertical',
                  boxSizing: 'border-box', fontFamily: 'inherit',
                }} />
            </div>
            <button onClick={handleForge} disabled={forging || !goal.trim()} style={{
              background: forging ? '#333' : '#f59e0b', border: 'none', borderRadius: 8,
              padding: '10px 24px', color: forging ? '#888' : '#000', fontSize: 13,
              fontWeight: 600, cursor: forging ? 'wait' : 'pointer',
            }}>
              {forging ? 'Forging...' : '⚡ Forge Agent'}
            </button>
          </div>

          {forgeResult && (
            <div style={{
              background: forgeResult.error ? '#ef444415' : '#22c55e15',
              borderRadius: 12, padding: 16, marginBottom: 20,
              border: `1px solid ${forgeResult.error ? '#ef444430' : '#22c55e30'}`,
            }}>
              {forgeResult.error ? (
                <div style={{ color: '#ef4444', fontSize: 13 }}>Error: {forgeResult.error}</div>
              ) : (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#22c55e', marginBottom: 8 }}>
                    Agent Forged: {forgeResult.name || forgeResult.agentId}
                  </div>
                  {forgeResult.role && (
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Role: {forgeResult.role}</div>
                  )}
                  {forgeResult.tools && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {(Array.isArray(forgeResult.tools) ? forgeResult.tools : []).map(t => (
                        <span key={t} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, background: '#10b98115', color: '#10b981' }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: '#888', marginBottom: 12 }}>
              Forged Agents ({forgedAgents.length})
            </h3>
            {forgedAgents.length === 0 && (
              <div style={{ color: '#555', fontSize: 13 }}>No forged agents yet. Create one above.</div>
            )}
            {forgedAgents.map(a => (
              <div key={a.id || a.agentId} style={{
                background: '#111118', borderRadius: 8, padding: '12px 16px', marginBottom: 8,
                border: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8' }}>{a.name || a.id || a.agentId}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{a.role || a.goal || 'Forged agent'}</div>
                  {a.forgedAt && (
                    <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>{new Date(a.forgedAt).toLocaleString()}</div>
                  )}
                </div>
                <button onClick={() => removeForged(a.id || a.agentId)} style={{
                  background: '#ef444420', border: '1px solid #ef444440', borderRadius: 6,
                  padding: '4px 12px', color: '#ef4444', cursor: 'pointer', fontSize: 11,
                }}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'synth' && (
        <div>
          <div style={{ background: '#111118', borderRadius: 12, padding: 20, border: '1px solid #222', marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa', marginBottom: 12 }}>
              Synthesize a Workflow
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>Goal</label>
              <input value={synthGoal} onChange={e => setSynthGoal(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSynthesize()}
                placeholder="e.g. Generate a product image, remove background, upscale to 4x"
                style={{
                  width: '100%', background: '#1a1a2e', border: '1px solid #333', borderRadius: 8,
                  padding: '10px 14px', color: '#e0e0e8', fontSize: 13, boxSizing: 'border-box',
                }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 4 }}>Constraints (optional)</label>
              <textarea value={synthConstraints} onChange={e => setSynthConstraints(e.target.value)}
                placeholder="e.g. Must use FLUX.1 for image gen, output as PNG..."
                rows={3} style={{
                  width: '100%', background: '#1a1a2e', border: '1px solid #333', borderRadius: 8,
                  padding: '10px 14px', color: '#e0e0e8', fontSize: 13, resize: 'vertical',
                  boxSizing: 'border-box', fontFamily: 'inherit',
                }} />
            </div>
            <button onClick={handleSynthesize} disabled={synthesizing || !synthGoal.trim()} style={{
              background: synthesizing ? '#333' : '#a78bfa', border: 'none', borderRadius: 8,
              padding: '10px 24px', color: synthesizing ? '#888' : '#000', fontSize: 13,
              fontWeight: 600, cursor: synthesizing ? 'wait' : 'pointer',
            }}>
              {synthesizing ? 'Synthesizing...' : '⬡ Synthesize Workflow'}
            </button>
          </div>

          {synthResult && (
            <div style={{
              background: synthResult.error ? '#ef444415' : '#a78bfa15',
              borderRadius: 12, padding: 16, marginBottom: 20,
              border: `1px solid ${synthResult.error ? '#ef444430' : '#a78bfa30'}`,
            }}>
              {synthResult.error ? (
                <div style={{ color: '#ef4444', fontSize: 13 }}>Error: {synthResult.error}</div>
              ) : (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#a78bfa', marginBottom: 8 }}>
                    Workflow Created: {synthResult.name || synthResult.workflowId || 'New Workflow'}
                  </div>
                  {synthResult.nodes && (
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                      {synthResult.nodes.length} nodes · {synthResult.edges?.length || 0} edges
                    </div>
                  )}
                  {synthResult.nodes && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {synthResult.nodes.map((n, i) => (
                        <span key={i} style={{
                          fontSize: 10, padding: '3px 8px', borderRadius: 4,
                          background: '#6366f115', color: '#6366f1',
                        }}>
                          {n.type || n.id}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: '#888', marginBottom: 12 }}>
              Synthesized Workflows ({synthesized.length})
            </h3>
            {synthesized.length === 0 && (
              <div style={{ color: '#555', fontSize: 13 }}>No synthesized workflows yet. Create one above.</div>
            )}
            {synthesized.map((w, i) => (
              <div key={w.id || i} style={{
                background: '#111118', borderRadius: 8, padding: '12px 16px', marginBottom: 8,
                border: '1px solid #222',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8' }}>
                  {w.name || w.id || `Workflow ${i + 1}`}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                  {w.goal || 'Synthesized workflow'}
                </div>
                {w.nodes && (
                  <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                    {w.nodes.length} nodes · {w.edges?.length || 0} edges
                    {w.synthesizedAt && ` · ${new Date(w.synthesizedAt).toLocaleString()}`}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
