import { useEffect, useRef, useState } from 'react';
import Orb from './Orb.jsx';
import BrainGraph from './BrainGraph.jsx';
import { api, formatBytes } from './api.js';

const FALLBACK_PROMPTS = [
  { id: 'health', label: 'System health', text: 'How is the system holding up?' },
  { id: 'recall', label: 'Recall notes', text: 'Recall notes about creation' },
  { id: 'brief', label: 'Research brief', text: 'Draft a research brief about local-first agents' },
  { id: 'script', label: 'Short script', text: 'Draft a 60-second script about F.R.A.Y.M.U.S.' },
];

function routeLabel(routeClass) {
  if (routeClass === 'local') return 'LOCAL';
  if (routeClass === 'private') return 'PRIVATE NODE';
  if (routeClass === 'public') return 'PUBLIC';
  return 'UNCONFIGURED';
}

export default function CommandView({ wsStatus, onOpenSurface, onInspect }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [text, setText] = useState('');
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [banner, setBanner] = useState('');
  const [clock, setClock] = useState(() => new Date());
  const sessionId = useRef(null);
  const turnId = useRef(null);
  const audioRef = useRef(null);
  const speakAbort = useRef(null);
  const recorder = useRef(null);
  const skipUpload = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let stop = false;
    async function pull() {
      try {
        const body = await api('/api/fraymus-os/status');
        if (!stop) { setStatus(body); setStatusError(''); }
      } catch (error) {
        if (!stop) setStatusError(error.message);
      }
    }
    pull();
    const timer = setInterval(pull, 4000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  useEffect(() => () => {
    audioRef.current?.pause();
    speakAbort.current?.abort();
    recorder.current?.stream?.getTracks().forEach(track => track.stop());
  }, []);

  async function refresh(id) {
    const body = await api(`/api/fraymus-os/sessions/${id}`);
    setSession(body);
    return body;
  }

  async function send(value) {
    const clean = (value ?? text).trim();
    if (!clean) return;
    setBanner('');
    setText('');
    setPhase('thinking');
    try {
      const started = await api('/api/fraymus-os/command', {
        method: 'POST',
        body: JSON.stringify({ text: clean, sessionId: sessionId.current }),
      });
      sessionId.current = started.sessionId;
      turnId.current = started.turnId;
      let latest = null;
      for (let i = 0; i < 120; i += 1) {
        latest = await refresh(started.sessionId);
        if (latest.state !== 'thinking') break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const assistant = [...(latest?.turns || [])].reverse().find(turn => turn.role === 'assistant');
      if (assistant?.state === 'error') {
        setPhase('error');
        setBanner(assistant.error || 'The request failed.');
      } else if (assistant?.state === 'cancelled') {
        setPhase('idle');
        setBanner(assistant.error || 'Cancelled.');
      } else {
        setPhase('idle');
      }
    } catch (error) {
      setPhase('error');
      setBanner(error.message);
    }
  }

  async function cancel() {
    if (phase === 'listening') {
      skipUpload.current = true;
      recorder.current?.stop();
      setPhase('idle');
      return;
    }
    if (phase === 'speaking') {
      audioRef.current?.pause();
      speakAbort.current?.abort();
      api('/api/fraymus-os/speak/cancel', { method: 'POST', body: '{}' }).catch(() => {});
      setPhase('idle');
      return;
    }
    if (turnId.current) {
      try { await api(`/api/fraymus-os/runs/${turnId.current}/cancel`, { method: 'POST', body: '{}' }); } catch (error) { setBanner(error.message); }
      if (sessionId.current) await refresh(sessionId.current);
      setPhase('idle');
    }
  }

  async function toggleMic() {
    if (recorder.current && recorder.current.state === 'recording') {
      recorder.current.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setBanner('This browser has no microphone. Type your request instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      skipUpload.current = false;
      rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        recorder.current = null;
        if (skipUpload.current) { setPhase('idle'); return; }
        setPhase('thinking');
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          const dataUrl = await blobToDataUrl(blob);
          const audioBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          const started = await api('/api/fraymus-os/command/voice', {
            method: 'POST',
            body: JSON.stringify({ audioBase64, sessionId: sessionId.current }),
          });
          sessionId.current = started.sessionId;
          turnId.current = started.turnId;
          let latest = null;
          for (let i = 0; i < 120; i += 1) {
            latest = await refresh(started.sessionId);
            if (latest.state !== 'thinking') break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          setPhase(latest?.state === 'error' ? 'error' : 'idle');
          const assistant = [...(latest?.turns || [])].reverse().find(turn => turn.role === 'assistant');
          if (assistant?.error) setBanner(assistant.error);
        } catch (error) {
          setPhase('idle');
          setBanner(error.body?.fallback === 'text' ? error.message : error.message);
        }
      };
      recorder.current = rec;
      rec.start();
      setPhase('listening');
      setBanner('');
    } catch {
      setBanner('Microphone permission was denied. Type your request instead.');
      setPhase('idle');
    }
  }

  async function speak(answer) {
    if (!answer) return;
    setBanner('');
    setPhase('speaking');
    const controller = new AbortController();
    speakAbort.current = controller;
    try {
      const result = await api('/api/fraymus-os/speak', {
        method: 'POST',
        body: JSON.stringify({ text: answer, voice: status?.voice?.voiceId || 'vaughn-one' }),
        signal: controller.signal,
      });
      if (!result.url) throw new Error('Speech did not return audio.');
      const audio = new Audio(result.url);
      audioRef.current = audio;
      audio.onended = () => setPhase('idle');
      await audio.play();
    } catch (error) {
      if (error.name === 'AbortError') { setPhase('idle'); return; }
      setPhase('error');
      setBanner(error.body?.fallback === 'text' ? `${error.message} The answer stays on screen.` : error.message);
    }
  }

  async function decide(step, decision) {
    try {
      await api(`/api/fraymus-os/approvals/${step.id}`, { method: 'POST', body: JSON.stringify({ decision }) });
      if (sessionId.current) await refresh(sessionId.current);
    } catch (error) {
      setBanner(error.message);
    }
  }

  const prompts = status?.suggestedPrompts || FALLBACK_PROMPTS;
  const models = status?.ollama?.models || [];
  const telemetry = status?.telemetry;
  const memoryPct = status?.host?.memoryTotalBytes
    ? Math.round((status.host.memoryUsedBytes / status.host.memoryTotalBytes) * 1000) / 10
    : null;
  const assistant = [...(session?.turns || [])].reverse().find(turn => turn.role === 'assistant' && (turn.answer || turn.error));
  const routeClass = assistant?.routeClass || status?.ollama?.routeClass;

  return (
    <section className="command">
      <header className="telemetry-bar">
        <div>
          <strong>F.R.A.Y.M.U.S.</strong>
          <span>Fractal Reasoning, Adaptive Yield — Memory Unified System</span>
        </div>
        <div className="pills">
          <span className={`pill route-${routeClass || 'unconfigured'}`}>{routeLabel(routeClass)}</span>
          <span>WS {wsStatus || '…'}</span>
          <span>Local {telemetry ? telemetry.localCalls : '—'}</span>
          <span>Private {telemetry ? telemetry.privateCalls : '—'}</span>
          <span>Public {telemetry ? telemetry.publicCalls : '—'}</span>
          <span>Tokens {telemetry?.tokensMeasured ? telemetry.tokensOut : '—'}</span>
          <span>Data sent {telemetry ? formatBytes(telemetry.dataSentBytes) : '—'}</span>
          <span>{clock.toLocaleTimeString()}</span>
        </div>
      </header>
      {statusError && <p className="warn banner">Status could not be read: {statusError}</p>}
      {banner && <p className="warn banner">{banner}</p>}
      <div className="command-grid">
        <aside className="side">
          <h2>Models</h2>
          <p className="muted">{status?.ollama?.url || 'Ollama endpoint unset'} · {status?.ollama?.routeClass || 'unconfigured'}</p>
          {models.length === 0 && <p className="empty-copy">No models are installed at this endpoint. {status?.ollama?.error || ''}</p>}
          <ul className="model-list">
            {models.map(model => (
              <li key={model.name} className={model.name === status?.ollama?.selectedReasoning ? 'chosen' : ''}>
                <b>{model.name}</b>
                <span>{model.name === status?.ollama?.selectedReasoning ? 'reasoning' : 'installed'}</span>
              </li>
            ))}
          </ul>
          <h2>This machine</h2>
          <Meter label="CPU" value={status?.host?.cpuPercent} note={status?.host?.cpuPercent == null ? `load ${status?.host?.loadAvg?.[0]?.toFixed?.(2) ?? '—'}` : '%'} />
          <Meter label="Memory" value={memoryPct} note={memoryPct == null ? '—' : '% in use'} />
          <p className="muted">Tokens/sec {telemetry?.tokensPerSec ?? '—'} · measured from provider counts, not estimated.</p>
        </aside>
        <div className="stage">
          <Orb state={phase} />
          <p className="model-caption">
            {assistant?.model || status?.ollama?.selectedReasoning || 'No reasoning model selected'}
            {' · '}
            {routeLabel(routeClass)}
          </p>
          <article className="answer">
            {assistant?.answer || (phase === 'thinking' ? 'Working with the installed model…' : 'Ask for a recall, a health check, or a draft. Publishing stays behind approval and does not run.')}
          </article>
          {assistant?.sources?.length > 0 && (
            <div className="chips">
              {assistant.sources.map(source => (
                <button type="button" key={source.id} onClick={() => onInspect?.(source.sourceId || source.title)}>
                  {source.kind} · {source.title}
                </button>
              ))}
            </div>
          )}
          <form className="ask" onSubmit={event => { event.preventDefault(); send(); }}>
            <button type="button" className={phase === 'listening' ? 'mic live' : 'mic'} onClick={toggleMic}>
              {phase === 'listening' ? 'Stop mic' : 'Talk'}
            </button>
            <input
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="Ask F.R.A.Y.M.U.S…"
              aria-label="Command"
            />
            {(phase === 'thinking' || phase === 'speaking' || phase === 'listening') && (
              <button type="button" className="stop" onClick={cancel}>Stop</button>
            )}
            <button type="button" onClick={() => speak(assistant?.answer)} disabled={!assistant?.answer}>Speak</button>
            <button type="submit">Send</button>
          </form>
          <div className="prompts">
            {prompts.map(prompt => (
              <button type="button" key={prompt.id} onClick={() => send(prompt.text)}>{prompt.label}</button>
            ))}
          </div>
        </div>
        <aside className="trace">
          <h2>Transcript and tools</h2>
          <div className="transcript">
            {(session?.turns || []).length === 0 && <p className="muted">Nothing has been said in this session.</p>}
            {(session?.turns || []).map(turn => (
              <p key={turn.id} className={turn.role}>
                <b>{turn.role === 'user' ? 'You' : 'F.R.A.Y.M.U.S.'}</b>
                {turn.role === 'user' ? turn.text : (turn.answer || turn.error || turn.state)}
              </p>
            ))}
          </div>
          <div className="tools">
            {(session?.tools || []).map(step => (
              <div key={step.id} className={`tool ${step.status}`}>
                <b>{step.tool}</b>
                <span>{step.status}</span>
                {step.result?.reason && <p>{step.result.reason}</p>}
                {step.status === 'awaiting_approval' && (
                  <div className="approval">
                    <button type="button" onClick={() => decide(step, 'approve')}>Approve</button>
                    <button type="button" onClick={() => decide(step, 'deny')}>Deny</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <BrainGraph compact onOpen={() => onOpenSurface('brain')} />
        </aside>
      </div>
    </section>
  );
}

function Meter({ label, value, note }) {
  const width = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="meter">
      <div><span>{label}</span><span>{Number.isFinite(value) ? value : note}</span></div>
      <div className="track"><div style={{ width: `${width}%` }} /></div>
    </div>
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
