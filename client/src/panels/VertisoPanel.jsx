import React, { useState, useEffect } from 'react';

const card = { background: '#12121a', border: '1px solid #222', borderRadius: 8, padding: 16, marginBottom: 12 };
const btn = { padding: '6px 14px', borderRadius: 6, border: '1px solid #333', background: '#1a1a2e', color: '#a78bfa', cursor: 'pointer', fontSize: 12 };
const input = { padding: '6px 10px', borderRadius: 6, border: '1px solid #333', background: '#0d0d14', color: '#ccc', fontSize: 12, flex: 1 };
const label = { fontSize: 11, color: '#666', marginBottom: 4, display: 'block' };

export default function VertisoPanel() {
  const [memStats, setMemStats] = useState(null);
  const [rsiStatus, setRsiStatus] = useState(null);
  const [storeAgent, setStoreAgent] = useState('concierge');
  const [storeContent, setStoreContent] = useState('');
  const [recallAgent, setRecallAgent] = useState('concierge');
  const [recallQuery, setRecallQuery] = useState('');
  const [memories, setMemories] = useState([]);
  const [evolveAgent, setEvolveAgent] = useState('concierge');
  const [genome, setGenome] = useState(null);
  const [reflection, setReflection] = useState(null);
  const [result, setResult] = useState(null);

  const load = () => {
    fetch('/api/vertiso/stats').then(r => r.json()).then(setMemStats).catch(() => {});
    fetch('/api/rsi/status').then(r => r.json()).then(setRsiStatus).catch(() => {});
  };
  useEffect(load, []);

  const doStore = async () => {
    if (!storeContent.trim()) return;
    const r = await fetch('/api/vertiso/store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: storeAgent, content: storeContent }) });
    setResult(await r.json());
    setStoreContent('');
    load();
  };

  const doRecall = async () => {
    if (!recallQuery.trim()) return;
    const r = await fetch('/api/vertiso/recall', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: recallAgent, query: recallQuery, limit: 8 }) });
    const data = await r.json();
    setMemories(data.memories || []);
  };

  const doEvolve = async () => {
    const r = await fetch('/api/rsi/evolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: evolveAgent, metrics: { taskCompletion: 0.7, responseQuality: 0.6, toolEfficiency: 0.5, memoryUtilization: 0.4 } }) });
    setResult(await r.json());
    load();
  };

  const doReflect = async () => {
    const r = await fetch('/api/rsi/reflect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: evolveAgent }) });
    setReflection(await r.json());
  };

  const doGetGenome = async () => {
    const r = await fetch(`/api/rsi/genome/${evolveAgent}`);
    setGenome(await r.json());
  };

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h2 style={{ color: '#a78bfa', fontSize: 20, marginBottom: 8 }}>Vertiso Memory + RSI</h2>
      <p style={{ color: '#666', fontSize: 12, marginBottom: 20 }}>Vector-similarity episodic memory & recursive self-improvement for all agents</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div style={card}>
          <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Memory Stats</div>
          {memStats ? (
            <>
              <div style={{ color: '#ccc', fontSize: 24, fontWeight: 700 }}>{memStats.totalMemories}</div>
              <div style={{ color: '#666', fontSize: 11 }}>total memories · {memStats.totalConsolidations} consolidations</div>
              {Object.entries(memStats.byAgent || {}).map(([a, n]) => (
                <div key={a} style={{ color: '#888', fontSize: 11, marginTop: 4 }}>{a}: {n} memories</div>
              ))}
            </>
          ) : <div style={{ color: '#555' }}>Loading...</div>}
        </div>
        <div style={card}>
          <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>RSI Status</div>
          {rsiStatus ? (
            <>
              <div style={{ color: '#ccc', fontSize: 24, fontWeight: 700 }}>{rsiStatus.totalGenerations}</div>
              <div style={{ color: '#666', fontSize: 11 }}>generations · {rsiStatus.totalImprovements} improvements</div>
              {(rsiStatus.agents || []).map(a => (
                <div key={a.agentId} style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
                  {a.agentId}: gen {a.generation}, fitness {a.bestFitness?.toFixed(3)}
                </div>
              ))}
            </>
          ) : <div style={{ color: '#555' }}>Loading...</div>}
        </div>
      </div>

      <div style={card}>
        <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Store Memory</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div>
            <span style={label}>Agent ID</span>
            <input style={{ ...input, width: 120 }} value={storeAgent} onChange={e => setStoreAgent(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Content</span>
            <input style={input} value={storeContent} onChange={e => setStoreContent(e.target.value)} placeholder="Memory to store..." onKeyDown={e => e.key === 'Enter' && doStore()} />
          </div>
          <div style={{ alignSelf: 'flex-end' }}><button style={btn} onClick={doStore}>Store</button></div>
        </div>
      </div>

      <div style={card}>
        <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Recall (Semantic Search)</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div>
            <span style={label}>Agent ID</span>
            <input style={{ ...input, width: 120 }} value={recallAgent} onChange={e => setRecallAgent(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Query</span>
            <input style={input} value={recallQuery} onChange={e => setRecallQuery(e.target.value)} placeholder="Search memories..." onKeyDown={e => e.key === 'Enter' && doRecall()} />
          </div>
          <div style={{ alignSelf: 'flex-end' }}><button style={btn} onClick={doRecall}>Recall</button></div>
        </div>
        {memories.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {memories.map((m, i) => (
              <div key={i} style={{ padding: 8, background: '#0d0d14', borderRadius: 6, marginBottom: 6, fontSize: 12 }}>
                <div style={{ color: '#a78bfa', fontWeight: 600 }}>Score: {m.score} · Sim: {m.similarity}</div>
                <div style={{ color: '#ccc', marginTop: 4 }}>{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Recursive Self-Improvement</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div>
            <span style={label}>Agent ID</span>
            <input style={{ ...input, width: 140 }} value={evolveAgent} onChange={e => setEvolveAgent(e.target.value)} />
          </div>
          <div style={{ alignSelf: 'flex-end', display: 'flex', gap: 6 }}>
            <button style={btn} onClick={doEvolve}>Evolve</button>
            <button style={btn} onClick={doReflect}>Reflect</button>
            <button style={btn} onClick={doGetGenome}>Genome</button>
          </div>
        </div>

        {genome && (
          <div style={{ padding: 8, background: '#0d0d14', borderRadius: 6, marginBottom: 8 }}>
            <div style={{ color: '#a78bfa', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Genome (Gen {genome.generation})</div>
            <pre style={{ color: '#888', fontSize: 11, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(genome.genome, null, 2)}</pre>
          </div>
        )}

        {reflection && (
          <div style={{ padding: 8, background: '#0d0d14', borderRadius: 6, marginBottom: 8 }}>
            <div style={{ color: '#a78bfa', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Reflection · {reflection.overallHealth}</div>
            {(reflection.weakest || []).map((w, i) => (
              <div key={i} style={{ color: '#f87171', fontSize: 11, marginTop: 4 }}>
                {w.dimension}: {w.current} ({w.trend}, {w.delta > 0 ? '+' : ''}{w.delta})
              </div>
            ))}
            {(reflection.recommendations || []).map((r, i) => (
              <div key={i} style={{ color: '#4ade80', fontSize: 11, marginTop: 4 }}>{r.action} {r.target}: {r.reason}</div>
            ))}
          </div>
        )}
      </div>

      {result && (
        <div style={card}>
          <div style={{ color: '#a78bfa', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Last Result</div>
          <pre style={{ color: '#888', fontSize: 11, margin: 0, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
