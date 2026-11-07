import { useEffect, useState } from 'react';
import { api, formatBytes, formatWhen } from './api.js';

export default function CoreView() {
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    async function pull() {
      try {
        const [core, requests] = await Promise.all([
          api('/api/fraymus-os/status'),
          api('/api/fraymus-os/telemetry/log?limit=40'),
        ]);
        if (stop) return;
        setStatus(core);
        setLog(requests.requests || []);
        setError('');
      } catch (err) {
        if (!stop) setError(err.message);
      }
    }
    pull();
    const timer = setInterval(pull, 4000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const telemetry = status?.telemetry;
  const memoryPct = status?.host?.memoryTotalBytes
    ? Math.round((status.host.memoryUsedBytes / status.host.memoryTotalBytes) * 1000) / 10
    : null;

  return (
    <section className="core">
      <header>
        <h1>Core</h1>
        <p>Measured routes only. A dash means that number was not reported. Zero is shown only when the counter itself was measured.</p>
      </header>
      {error && <p className="warn banner">{error}</p>}
      {!status && !error && <p className="muted">Reading the local core…</p>}
      {status && (
        <>
          <div className="core-grid">
            <article>
              <h2>Ollama</h2>
              <p>{status.ollama.url || 'Not configured'}</p>
              <p className={`pill route-${status.ollama.routeClass}`}>{status.ollama.routeClass}</p>
              <p className="muted">{status.policy?.label}</p>
              {status.ollama.error && <p className="warn">{status.ollama.error}</p>}
              <p>Preferred reasoning model: fraynix-gpt · {status.ollama.reasoningInstalled ? `using ${status.ollama.selectedReasoning}` : 'not installed'}</p>
              <p>Preferred fast model: fraynix-dna:8b · {status.ollama.fastInstalled ? `installed as ${status.ollama.selectedFast}` : 'not installed'}</p>
              <ul>
                {(status.ollama.models || []).map(model => <li key={model.name}>{model.name}{model.size ? ` · ${formatBytes(model.size)}` : ''}</li>)}
              </ul>
              {(status.ollama.models || []).length === 0 && <p>No installed models were returned.</p>}
            </article>
            <article>
              <h2>Voice</h2>
              <p>VoiceStudio {status.voice?.voiceStudio?.configured ? status.voice.voiceStudio.url : 'is not configured'}</p>
              <p className="muted">Route {status.voice?.voiceStudio?.routeClass || 'unconfigured'} · voice id {status.voice?.voiceId || 'unset'}</p>
              <p>Piper fallback: {status.voice?.piper?.available ? 'available locally' : 'not available'}</p>
              <p className="muted">Allowed voices: {(status.voice?.allowedVoices || []).join(', ') || 'vaughn-one, overlord'}</p>
            </article>
            <article>
              <h2>Host</h2>
              <p>CPU {status.host?.cpuPercent == null ? 'waiting for a second sample' : `${status.host.cpuPercent}%`}</p>
              <p className="muted">{status.host?.cpuNote}</p>
              <p>Load average {status.host?.loadAvg?.map(value => value.toFixed(2)).join(' · ')}</p>
              <p>Memory {memoryPct == null ? '—' : `${memoryPct}%`} of {formatBytes(status.host?.memoryTotalBytes)}</p>
              <p>Process heap {formatBytes(status.host?.heapUsedBytes)}</p>
            </article>
            <article>
              <h2>Traffic</h2>
              <p>Local calls {telemetry?.localCalls ?? '—'}</p>
              <p>Private-network calls {telemetry?.privateCalls ?? '—'}</p>
              <p>Public calls {telemetry?.publicCalls ?? '—'}</p>
              <p>Blocked public attempts {telemetry?.blockedPublicAttempts ?? '—'}</p>
              <p>Data sent {telemetry ? formatBytes(telemetry.dataSentBytes) : '—'}</p>
              <p>Tokens in {telemetry?.tokensMeasured ? telemetry.tokensIn : '—'}</p>
              <p>Tokens out {telemetry?.tokensMeasured ? telemetry.tokensOut : '—'}</p>
              <p>Tokens/sec {telemetry?.tokensPerSec ?? '—'}</p>
            </article>
          </div>
          <h2>Request log</h2>
          <div className="log-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Kind</th><th>Route</th><th>Model</th><th>Sent</th><th>Tokens out</th><th>ms</th><th>Result</th></tr>
              </thead>
              <tbody>
                {log.length === 0 && <tr><td colSpan={8}>No requests have been recorded.</td></tr>}
                {log.map(row => (
                  <tr key={row.id}>
                    <td>{formatWhen(row.createdAt)}</td>
                    <td>{row.kind}</td>
                    <td>{row.routeClass}</td>
                    <td>{row.model || '—'}</td>
                    <td>{formatBytes(row.bytesSent)}</td>
                    <td>{row.tokensOut == null ? '—' : row.tokensOut}</td>
                    <td>{row.durationMs}</td>
                    <td>{row.ok ? 'ok' : (row.error || 'failed')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
