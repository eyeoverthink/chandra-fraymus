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

const SHELF_KINDS = [
  { id: 'site', label: 'Sites' }, { id: 'wiki', label: 'Wikis' }, { id: 'draft', label: 'Drafts' },
  { id: 'report', label: 'Reports' }, { id: 'client', label: 'API clients' },
  { id: 'image', label: 'Images' }, { id: 'video', label: 'Video' }, { id: 'audio', label: 'Audio' },
];
const MEDIA_KINDS = ['image', 'video', 'audio'];

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

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
  const [mode, setMode] = useState('auto');       // 'auto' = agent with tools, 'quick' = instant lookups + plain chat
  const [deckTab, setDeckTab] = useState('create');
  const inputRef = useRef(null);
  const [shelf, setShelf] = useState({ total: 0, counts: {}, artifacts: [] });
  const [shelfKind, setShelfKind] = useState('');
  const [shelfQuery, setShelfQuery] = useState('');
  const [shelfSearch, setShelfSearch] = useState('');   // debounced copy of shelfQuery
  const [viewer, setViewer] = useState(null);
  const [pulse, setPulse] = useState(null);             // live process rates for the rings (/api/fraymus-os/pulse)
  const [poolModels, setPoolModels] = useState([]);     // every model the pool can reach, with its machines
  const [agentModel, setAgentModel] = useState(() => { try { return localStorage.getItem('fraymus.agentModel') || ''; } catch { return ''; } });   // '' = the pool decides
  const [showWaiting, setShowWaiting] = useState(false);
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

  // the rings: measured every 2 s, so a ring moves only while its process works
  useEffect(() => {
    let stop = false;
    async function pull() {
      try { const body = await api('/api/fraymus-os/pulse'); if (!stop) setPulse(body); }
      catch (error) { console.warn('pulse unavailable:', error.message); }
    }
    pull();
    const timer = setInterval(pull, 2000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let stop = false;
    async function pull() {
      try { const body = await api('/api/fleet/models'); if (!stop) setPoolModels(body.models || []); }
      catch (error) { console.warn('model list unavailable:', error.message); }
    }
    pull();
    const timer = setInterval(pull, 30000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  function chooseModel(value) {
    setAgentModel(value);
    try { if (value) localStorage.setItem('fraymus.agentModel', value); else localStorage.removeItem('fraymus.agentModel'); } catch { /* storage unavailable: the choice lasts this visit */ }
  }

  async function decideWaiting(approval, approve) {
    try {
      await api(`/api/fleet/approvals/${approval.id}`, { method: 'POST', body: JSON.stringify({ approve }) });
      setStatus(await api('/api/fraymus-os/status'));
    } catch (error) {
      setBanner(`Could not ${approve ? 'approve' : 'deny'} ${approval.tool}: ${error.message}`);
    }
  }

  // the shelf: what the agents have made on this machine; refreshed while idle and after each turn
  useEffect(() => {
    let stop = false;
    async function pull() {
      try {
        const body = await api(`/api/hermes/artifacts?limit=12${shelfKind ? `&kind=${shelfKind}` : ''}${shelfSearch ? `&q=${encodeURIComponent(shelfSearch)}` : ''}`);
        if (!stop) setShelf(body);
      } catch (error) {
        console.warn('artifact shelf unavailable:', error.message);
      }
    }
    pull();
    const timer = setInterval(pull, 10000);
    return () => { stop = true; clearInterval(timer); };
  }, [shelfKind, shelfSearch, phase]);

  useEffect(() => {
    const timer = setTimeout(() => setShelfSearch(shelfQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [shelfQuery]);

  async function openArtifact(item) {
    if (item.kind === 'site') { window.open(item.url, '_blank', 'noopener'); return; }
    if (MEDIA_KINDS.includes(item.kind)) { setViewer({ kind: item.kind, title: item.title, format: 'media', media: item.media, detail: item.detail, prompt: item.prompt, op: item.op, params: item.params, file: item.id }); return; }
    try {
      setViewer(await api(`/api/hermes/artifacts/read?kind=${encodeURIComponent(item.kind)}&id=${encodeURIComponent(item.id)}`));
    } catch (error) {
      setBanner(`Could not open ${item.title}: ${error.message}`);
    }
  }

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
        body: JSON.stringify({ text: clean, sessionId: sessionId.current, mode, ...(mode !== 'quick' && agentModel ? { model: agentModel } : {}) }),
      });
      sessionId.current = started.sessionId;
      turnId.current = started.turnId;
      let latest = null;
      // an agent run with tools can take minutes on a local model: poll for up to 15 minutes
      for (let i = 0; i < 900; i += 1) {
        latest = await refresh(started.sessionId);
        if (latest.state !== 'thinking') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
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
          const form = new FormData();
          form.append('audio', blob, 'speech.webm');
          if (sessionId.current) form.append('sessionId', sessionId.current);
          const response = await fetch('/api/fraymus-os/command/voice', { method: 'POST', body: form });
          const started = await response.json().catch(() => ({}));
          if (!response.ok) {
            const error = new Error(started.error || 'Voice input failed');
            error.body = started;
            throw error;
          }
          sessionId.current = started.sessionId;
          turnId.current = started.turnId;
          let latest = null;
          for (let i = 0; i < 1800; i += 1) { // voice commands reach the agent too: allow 15 minutes
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
      if (sessionId.current) {
        await refresh(sessionId.current);
        // the agent continues after a decision and posts a follow-up turn: keep the transcript fresh
        const id = sessionId.current;
        for (let i = 0; i < 90 && sessionId.current === id; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const body = await refresh(id);
          if (i > 2 && body.state !== 'thinking') break;
        }
      }
    } catch (error) {
      setBanner(error.message);
    }
  }

  const prompts = status?.suggestedPrompts || FALLBACK_PROMPTS;
  const brain = status?.brain;
  const deck = status?.deck || [];
  const deckItems = (deck.find(group => group.id === deckTab) || deck[0])?.items || [];
  const waiting = (session?.tools || []).filter(step => step.status === 'awaiting_approval').length;
  function pickDeckItem(item) {
    if (item.fill) { setText(item.text); inputRef.current?.focus(); return; }
    send(item.text);
  }
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
      {brain && (
        <div className="brain-strip" aria-label="What the agent can reach">
          <span className={brain.connected ? 'pill route-local' : 'pill'}>{brain.connected ? `Brain: ${brain.agentId}` : 'Brain not connected'}</span>
          <span><b>{brain.tools}</b> tools</span>
          <span><b>{brain.hermesTools}</b> Hermes</span>
          <span><b>{brain.agents ?? '—'}</b> agents</span>
          <span><b>{brain.skills ?? '—'}</b> forged skills</span>
          <span><b>{brain.gScore != null ? brain.gScore.toFixed(2) : '—'}</b> g-score</span>
          <span><b>{brain.agentRuns24h ?? '—'}</b> runs today</span>
          <button type="button" className={`waiting-toggle ${brain.pendingApprovals ? 'needs-you' : ''}`} onClick={() => setShowWaiting(v => !v)}
            disabled={!brain.pendingApprovals} title="Agent steps that wait for your approval before they run">
            <b>{brain.pendingApprovals ?? 0}</b> waiting on you
          </button>
          <span className="mode-switch">
            <button type="button" className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')} title="Requests go to the agent, which can call tools">Agent</button>
            <button type="button" className={mode === 'quick' ? 'on' : ''} onClick={() => setMode('quick')} title="Instant lookups and plain chat, no tools">Quick</button>
          </span>
        </div>
      )}
      {showWaiting && brain?.approvals?.length > 0 && (
        <ul className="waiting-list" aria-label="Steps waiting for your approval">
          {brain.approvals.map(a => (
            <li key={a.id}>
              <div>
                <b>{a.tool}</b> <span className="muted">from {a.agentId || 'an agent'} · {ago(a.createdAt)}</span>
                <code>{a.args}</code>
              </div>
              <span className="waiting-actions">
                <button type="button" onClick={() => decideWaiting(a, true)}>Approve</button>
                <button type="button" onClick={() => decideWaiting(a, false)}>Deny</button>
              </span>
            </li>
          ))}
        </ul>
      )}
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
          <Orb state={phase} pulse={pulse} />
          <p className="model-caption" title="What really answered: the model pool sends each agent call to whichever machine can take it">
            {phase === 'thinking'
              ? `Thinking on ${agentModel || 'the model pool'}${(pulse?.rings?.find(r => r.id === 'routing')?.hosts || []).filter(h => h.inFlight).map(h => ` · ${h.name} answering`).join('') || ''}`
              : assistant?.model
                ? `${assistant.model} · ${routeLabel(routeClass)}`
                : brain?.lastModel
                  ? `Last answered: ${brain.lastModel.model} on ${brain.lastModel.host === 'local' ? 'this PC' : brain.lastModel.host} · ${ago(brain.lastModel.at)}`
                  : `${status?.ollama?.selectedReasoning || 'No model selected'} · ${routeLabel(routeClass)}`}
          </p>
          {mode !== 'quick' && poolModels.length > 0 && (
            <label className="model-pick">
              <span>Agent model</span>
              <select value={agentModel} onChange={event => chooseModel(event.target.value)}>
                <option value="">Automatic — the pool picks the fastest machine</option>
                {agentModel && !poolModels.some(m => m.model === agentModel) && <option value={agentModel}>{agentModel} (not reachable now)</option>}
                {poolModels.map(m => (
                  <option key={m.model} value={m.model}>{m.model} — {m.hosts.map(h => (h === 'local' ? 'this PC' : h)).join(', ')}</option>
                ))}
              </select>
            </label>
          )}
          <article className="answer">
            {assistant?.answer || (phase === 'thinking'
              ? (mode === 'quick' ? 'Working with the installed model…' : 'The agent is working. Tool calls appear in the transcript panel as they happen.')
              : (brain?.connected && mode !== 'quick'
                ? 'Ask for anything below, or in your own words. The agent picks tools, shows each call, and stops for your approval before anything leaves this machine.'
                : 'Ask for a recall, a health check, or a draft.'))}
            {waiting > 0 && <span className="needs-you inline"> {waiting} step{waiting === 1 ? '' : 's'} waiting for your approval in the transcript panel</span>}
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
              ref={inputRef}
              placeholder={mode === 'quick' ? 'Ask F.R.A.Y.M.U.S…' : 'Ask, build, research, create…'}
              aria-label="Command"
            />
            {(phase === 'thinking' || phase === 'speaking' || phase === 'listening') && (
              <button type="button" className="stop" onClick={cancel}>Stop</button>
            )}
            <button type="button" onClick={() => speak(assistant?.answer)} disabled={!assistant?.answer}>Speak</button>
            <button type="submit">Send</button>
          </form>
          {deck.length > 0 ? (
            <div className="deck">
              <div className="deck-tabs" role="tablist">
                {deck.map(group => (
                  <button type="button" role="tab" aria-selected={deckTab === group.id} key={group.id} className={deckTab === group.id ? 'on' : ''} onClick={() => setDeckTab(group.id)}>{group.label}</button>
                ))}
              </div>
              <div className="prompts">
                {deckItems.map(item => (
                  <button type="button" key={item.id} onClick={() => pickDeckItem(item)} title={item.text} disabled={phase === 'thinking'}>{item.label}{item.fill ? ' …' : ''}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="prompts">
              {prompts.map(prompt => (
                <button type="button" key={prompt.id} onClick={() => send(prompt.text)}>{prompt.label}</button>
              ))}
            </div>
          )}
          {(shelf.total > 0 || shelfSearch) && (
            <div className="shelf" aria-label="Made on this machine">
              <div className="shelf-head">
                <b>Made here</b>
                <span>{shelfSearch ? `${shelf.matched ?? 0} of ${shelf.total} match` : `${shelf.total} item${shelf.total === 1 ? '' : 's'}`}</span>
                <input className="shelf-search" type="search" value={shelfQuery} onChange={event => setShelfQuery(event.target.value)} placeholder="Search what was made…" aria-label="Search artifacts" />
                {SHELF_KINDS.filter(k => shelf.counts?.[k.id]).map(k => (
                  <button type="button" key={k.id} className={shelfKind === k.id ? 'on' : ''} onClick={() => setShelfKind(shelfKind === k.id ? '' : k.id)}>{k.label} {shelf.counts[k.id]}</button>
                ))}
              </div>
              <div className="shelf-row">
                {shelf.artifacts.map(item => (
                  <button type="button" key={item.kind + item.id} className={`shelf-card kind-${item.kind}`} onClick={() => openArtifact(item)} title={item.kind === 'site' ? 'Opens in a new tab' : 'Opens here'}>
                    {item.kind === 'image' && <img className="shelf-thumb" src={item.media} alt="" loading="lazy" />}
                    {item.kind === 'video' && <video className="shelf-thumb" src={`${item.media}#t=0.5`} preload="metadata" muted playsInline />}
                    <span className="shelf-kind">{item.kind}</span>
                    <strong>{item.title}</strong>
                    <span className="shelf-meta">{item.detail} · {ago(item.at)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
                <span>{step.status.replace('_', ' ')}{step.result?.approvedByHuman ? ' · approved by you' : ''}</span>
                {step.args && Object.keys(step.args).length > 0 && <p className="tool-args">{JSON.stringify(step.args).slice(0, 220)}</p>}
                {step.result?.reason && <p>{step.result.reason}</p>}
                {step.result?.preview && <p className="tool-preview">{step.result.preview}</p>}
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
      {viewer && (
        <div className="viewer-backdrop" onClick={() => setViewer(null)}>
          <div className="viewer" role="dialog" aria-label={viewer.title} onClick={event => event.stopPropagation()}>
            <header>
              <div><span className="shelf-kind">{viewer.kind}</span><strong>{viewer.title}</strong></div>
              <div>
                {viewer.format !== 'media' && <button type="button" onClick={() => { navigator.clipboard?.writeText(viewer.text).then(() => setBanner('Copied.'), () => setBanner('Copy was blocked by the browser.')); }}>Copy</button>}
                {viewer.format === 'media' && <a className="viewer-link" href={viewer.media} target="_blank" rel="noopener noreferrer">Open file</a>}
                <button type="button" onClick={() => { setText(`About "${viewer.title}": `); setViewer(null); inputRef.current?.focus(); }}>Ask about it</button>
                <button type="button" onClick={() => setViewer(null)}>Close</button>
              </div>
            </header>
            {viewer.path && <p className="muted">{viewer.path}</p>}
            {viewer.format === 'media' ? (
              <div className="viewer-media">
                {viewer.kind === 'image' && <img src={viewer.media} alt={viewer.title} />}
                {viewer.kind === 'video' && <video src={viewer.media} controls autoPlay playsInline />}
                {viewer.kind === 'audio' && <audio src={viewer.media} controls autoPlay />}
                {viewer.prompt && <p className="viewer-prompt"><b>{viewer.kind === 'audio' ? 'Says' : 'Prompt / text'}:</b> {viewer.prompt}</p>}
                <p className="muted">{viewer.detail}{viewer.params && Object.keys(viewer.params).length > 0 ? ` · ${Object.entries(viewer.params).slice(0, 8).map(([key, value]) => `${key} ${value}`).join(' · ')}` : ''}</p>
                {!viewer.op && <p className="muted">Made before provenance was recorded: nothing is known about how.</p>}
              </div>
            ) : (
              <pre className={viewer.format === 'code' ? 'code' : ''}>{viewer.text}</pre>
            )}
          </div>
        </div>
      )}
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
