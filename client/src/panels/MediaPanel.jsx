import React, { useState, useEffect, useRef } from 'react';

const TABS = ['images', 'video', 'tts', 'stt', 'ocr'];
const TAB_LABELS = { images: 'Images', video: 'Video', tts: 'Text-to-Speech', stt: 'Speech-to-Text', ocr: 'OCR' };
const TAB_COLORS = { images: '#a78bfa', video: '#f59e0b', tts: '#10b981', stt: '#6366f1', ocr: '#ec4899' };

function StatusDot({ ok }) {
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: ok ? '#22c55e' : '#555', marginRight: 6,
  }} />;
}

function Card({ title, children }) {
  return (
    <div style={{ background: '#111118', borderRadius: 12, padding: 16, border: '1px solid #222', marginBottom: 12 }}>
      {title && <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e8', marginBottom: 10 }}>{title}</div>}
      {children}
    </div>
  );
}

function ImagesTab() {
  const [status, setStatus] = useState(null);
  const [outputs, setOutputs] = useState([]);
  const [file, setFile] = useState(null);
  const [op, setOp] = useState('resize');
  const [opts, setOpts] = useState('{"width":400}');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef();

  useEffect(() => {
    fetch('/api/media/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
  }, [result]);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      try { const o = JSON.parse(opts); Object.entries(o).forEach(([k, v]) => fd.append(k, v)); } catch {}
      const r = await fetch(`/api/media/${op}`, { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) { setResult(await r.json()); }
      else {
        const blob = await r.blob();
        setResult({ imageUrl: URL.createObjectURL(blob), type: ct });
      }
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  return (
    <>
      <Card title="Image Operations">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {['resize', 'crop', 'convert', 'effects', 'watermark', 'thumbnail', 'upscale', 'info'].map(o => (
            <button key={o} onClick={() => setOp(o)} style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid #333', fontSize: 11, cursor: 'pointer',
              background: op === o ? '#a78bfa30' : '#0a0a0f', color: op === o ? '#a78bfa' : '#888',
            }}>{o}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input ref={inputRef} type="file" accept="image/*" onChange={e => setFile(e.target.files[0])}
            style={{ fontSize: 11, color: '#888', flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={opts} onChange={e => setOpts(e.target.value)} placeholder='{"width":400}'
            style={{ flex: 1, background: '#0a0a0f', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#ccc', fontSize: 11 }} />
          <button onClick={run} disabled={busy || !file} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: '#a78bfa', color: '#fff', opacity: busy || !file ? 0.4 : 1,
          }}>{busy ? 'Processing...' : 'Run'}</button>
        </div>
      </Card>
      {result && (
        <Card title="Result">
          {result.error && <div style={{ color: '#ef4444', fontSize: 12 }}>{result.error}</div>}
          {result.imageUrl && <img src={result.imageUrl} alt="result" style={{ maxWidth: '100%', borderRadius: 8 }} />}
          {!result.error && !result.imageUrl && <pre style={{ fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Card>
      )}
      {outputs.length > 0 && (
        <Card title={`Recent Outputs (${outputs.length})`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {outputs.slice(0, 20).map(f => {
              const name = typeof f === 'string' ? f : f.name;
              const url = typeof f === 'string' ? `/media/${f}` : f.url;
              return (
                <a key={name} href={url} target="_blank" rel="noreferrer"
                  style={{ fontSize: 10, color: '#a78bfa', background: '#a78bfa10', padding: '3px 8px', borderRadius: 4 }}>{name}</a>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

function VideoTab() {
  const [file, setFile] = useState(null);
  const [op, setOp] = useState('info');
  const [opts, setOpts] = useState('{}');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outputs, setOutputs] = useState([]);

  useEffect(() => {
    fetch('/api/video/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
  }, [result]);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      try { const o = JSON.parse(opts); Object.entries(o).forEach(([k, v]) => fd.append(k, String(v))); } catch {}
      const r = await fetch(`/api/video/${op}`, { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) { setResult(await r.json()); }
      else {
        const blob = await r.blob();
        setResult({ mediaUrl: URL.createObjectURL(blob), type: ct });
      }
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  return (
    <>
      <Card title="Video Operations">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {['info', 'thumbnail', 'trim', 'resize', 'convert', 'extract-audio', 'gif', 'frames', 'overlay-text'].map(o => (
            <button key={o} onClick={() => setOp(o)} style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid #333', fontSize: 11, cursor: 'pointer',
              background: op === o ? '#f59e0b30' : '#0a0a0f', color: op === o ? '#f59e0b' : '#888',
            }}>{o}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input type="file" accept="video/*,audio/*" onChange={e => setFile(e.target.files[0])}
            style={{ fontSize: 11, color: '#888', flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={opts} onChange={e => setOpts(e.target.value)} placeholder='{"start":0,"end":10}'
            style={{ flex: 1, background: '#0a0a0f', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', color: '#ccc', fontSize: 11 }} />
          <button onClick={run} disabled={busy || !file} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: '#f59e0b', color: '#000', opacity: busy || !file ? 0.4 : 1,
          }}>{busy ? 'Processing...' : 'Run'}</button>
        </div>
      </Card>
      {result && (
        <Card title="Result">
          {result.error && <div style={{ color: '#ef4444', fontSize: 12 }}>{result.error}</div>}
          {result.mediaUrl && result.type?.includes('image') && <img src={result.mediaUrl} alt="result" style={{ maxWidth: '100%', borderRadius: 8 }} />}
          {result.mediaUrl && result.type?.includes('video') && <video src={result.mediaUrl} controls style={{ maxWidth: '100%', borderRadius: 8 }} />}
          {result.mediaUrl && result.type?.includes('audio') && <audio src={result.mediaUrl} controls style={{ width: '100%' }} />}
          {!result.error && !result.mediaUrl && <pre style={{ fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Card>
      )}
      {outputs.length > 0 && (
        <Card title={`Recent Outputs (${outputs.length})`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {outputs.slice(0, 20).map(f => {
              const name = typeof f === 'string' ? f : f.name;
              return <span key={name} style={{ fontSize: 10, color: '#f59e0b', background: '#f59e0b10', padding: '3px 8px', borderRadius: 4 }}>{name}</span>;
            })}
          </div>
        </Card>
      )}
    </>
  );
}

function TTSTab() {
  const [text, setText] = useState('Hello from Chandra-FRAYMUS. Testing speech synthesis.');
  const [engine, setEngine] = useState('');
  const [voice, setVoice] = useState('');
  const [status, setStatus] = useState(null);
  const [voices, setVoices] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outputs, setOutputs] = useState([]);

  useEffect(() => {
    fetch('/api/tts/status').then(r => r.json()).then(setStatus).catch(() => {});
    fetch('/api/tts/voices').then(r => r.json()).then(d => setVoices(d.voices || [])).catch(() => {});
    fetch('/api/tts/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
  }, []);

  const speak = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const body = { text };
      if (engine) body.engine = engine;
      if (voice) body.voice = voice;
      const r = await fetch('/api/tts/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('audio')) {
        const blob = await r.blob();
        setResult({ audioUrl: URL.createObjectURL(blob) });
      } else {
        setResult(await r.json());
      }
      fetch('/api/tts/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const engines = status?.engines || {};
  return (
    <>
      <Card title="Engine Status">
        <div style={{ display: 'flex', gap: 16 }}>
          {Object.entries(engines).map(([name, info]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', fontSize: 12 }}>
              <StatusDot ok={info.available} />
              <span style={{ color: info.available ? '#10b981' : '#555' }}>{name}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Speak">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3}
          style={{ width: '100%', background: '#0a0a0f', border: '1px solid #333', borderRadius: 6, padding: 10, color: '#ccc', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <select value={engine} onChange={e => setEngine(e.target.value)}
            style={{ background: '#0a0a0f', border: '1px solid #333', borderRadius: 6, padding: '5px 8px', color: '#ccc', fontSize: 11 }}>
            <option value="">Auto engine</option>
            {Object.keys(engines).map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <select value={voice} onChange={e => setVoice(e.target.value)}
            style={{ background: '#0a0a0f', border: '1px solid #333', borderRadius: 6, padding: '5px 8px', color: '#ccc', fontSize: 11, flex: 1 }}>
            <option value="">Default voice</option>
            {voices.map(v => <option key={v.id || v.name} value={v.id || v.name}>{v.name || v.id}</option>)}
          </select>
          <button onClick={speak} disabled={busy || !text.trim()} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: '#10b981', color: '#fff', opacity: busy || !text.trim() ? 0.4 : 1,
          }}>{busy ? 'Speaking...' : 'Speak'}</button>
        </div>
      </Card>
      {result && (
        <Card title="Result">
          {result.error && <div style={{ color: '#ef4444', fontSize: 12 }}>{result.error}</div>}
          {result.audioUrl && <audio src={result.audioUrl} controls autoPlay style={{ width: '100%' }} />}
          {!result.error && !result.audioUrl && <pre style={{ fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Card>
      )}
      {outputs.length > 0 && (
        <Card title={`Recent Outputs (${outputs.length})`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {outputs.slice(0, 20).map(f => {
              const name = typeof f === 'string' ? f : f.name;
              return <span key={name} style={{ fontSize: 10, color: '#10b981', background: '#10b98110', padding: '3px 8px', borderRadius: 4 }}>{name}</span>;
            })}
          </div>
        </Card>
      )}
    </>
  );
}

function STTTab() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outputs, setOutputs] = useState([]);

  useEffect(() => {
    fetch('/api/stt/status').then(r => r.json()).then(setStatus).catch(() => {});
    fetch('/api/stt/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
  }, []);

  const transcribe = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('audio', file);
      const r = await fetch('/api/stt/transcribe', { method: 'POST', body: fd });
      setResult(await r.json());
      fetch('/api/stt/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const engines = status?.engines || {};
  return (
    <>
      <Card title="Engine Status">
        <div style={{ display: 'flex', gap: 16 }}>
          {Object.entries(engines).map(([name, info]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', fontSize: 12 }}>
              <StatusDot ok={info.available} />
              <span style={{ color: info.available ? '#6366f1' : '#555' }}>{name}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Transcribe Audio">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.webm" onChange={e => setFile(e.target.files[0])}
            style={{ fontSize: 11, color: '#888', flex: 1 }} />
          <button onClick={transcribe} disabled={busy || !file} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: '#6366f1', color: '#fff', opacity: busy || !file ? 0.4 : 1,
          }}>{busy ? 'Transcribing...' : 'Transcribe'}</button>
        </div>
      </Card>
      {result && (
        <Card title="Transcript">
          {result.error && <div style={{ color: '#ef4444', fontSize: 12 }}>{result.error}</div>}
          {result.transcript && (
            <div>
              <div style={{ fontSize: 14, color: '#e0e0e8', lineHeight: 1.6, marginBottom: 8 }}>{result.transcript}</div>
              <div style={{ fontSize: 11, color: '#666' }}>
                Engine: {result.engine} | Confidence: {typeof result.confidence === 'number' ? (result.confidence * 100).toFixed(1) + '%' : '—'}
              </div>
            </div>
          )}
          {!result.error && !result.transcript && <pre style={{ fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Card>
      )}
      {outputs.length > 0 && (
        <Card title={`Recent Transcriptions (${outputs.length})`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {outputs.slice(0, 20).map(f => {
              const name = typeof f === 'string' ? f : f.name;
              return <span key={name} style={{ fontSize: 10, color: '#6366f1', background: '#6366f110', padding: '3px 8px', borderRadius: 4 }}>{name}</span>;
            })}
          </div>
        </Card>
      )}
    </>
  );
}

function OCRTab() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outputs, setOutputs] = useState([]);

  useEffect(() => {
    fetch('/api/ocr/status').then(r => r.json()).then(setStatus).catch(() => {});
    fetch('/api/ocr/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
  }, []);

  const recognize = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const r = await fetch('/api/ocr/recognize', { method: 'POST', body: fd });
      setResult(await r.json());
      fetch('/api/ocr/outputs').then(r => r.json()).then(d => setOutputs(d.files || [])).catch(() => {});
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  return (
    <>
      <Card title="OCR Status">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <StatusDot ok={status?.available} />
          <span style={{ fontSize: 12, color: status?.available ? '#ec4899' : '#555' }}>
            Windows Media OCR {status?.available ? 'ready' : 'unavailable'}
          </span>
          {status?.languages && (
            <span style={{ fontSize: 11, color: '#666' }}>Languages: {Array.isArray(status.languages) ? status.languages.join(', ') : status.languages}</span>
          )}
        </div>
      </Card>
      <Card title="Extract Text from Image">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={e => setFile(e.target.files[0])}
            style={{ fontSize: 11, color: '#888', flex: 1 }} />
          <button onClick={recognize} disabled={busy || !file} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: '#ec4899', color: '#fff', opacity: busy || !file ? 0.4 : 1,
          }}>{busy ? 'Recognizing...' : 'OCR'}</button>
        </div>
      </Card>
      {result && (
        <Card title="Extracted Text">
          {result.error && <div style={{ color: '#ef4444', fontSize: 12 }}>{result.error}</div>}
          {result.text && (
            <div>
              <div style={{ fontSize: 13, color: '#e0e0e8', lineHeight: 1.6, marginBottom: 8, whiteSpace: 'pre-wrap', background: '#0a0a0f', padding: 12, borderRadius: 6 }}>{result.text}</div>
              <div style={{ fontSize: 11, color: '#666' }}>
                Words: {result.wordCount || '—'} | Lines: {Array.isArray(result.lines) ? result.lines.length : '—'}
                {result.width ? ` | ${result.width}x${result.height}` : ''}
              </div>
            </div>
          )}
          {!result.error && !result.text && <pre style={{ fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
        </Card>
      )}
      {outputs.length > 0 && (
        <Card title={`Recent OCR Results (${outputs.length})`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {outputs.slice(0, 20).map(f => {
              const name = typeof f === 'string' ? f : f.name;
              return <span key={name} style={{ fontSize: 10, color: '#ec4899', background: '#ec489910', padding: '3px 8px', borderRadius: 4 }}>{name}</span>;
            })}
          </div>
        </Card>
      )}
    </>
  );
}

const TAB_COMPONENTS = { images: ImagesTab, video: VideoTab, tts: TTSTab, stt: STTTab, ocr: OCRTab };

export default function MediaPanel() {
  const [tab, setTab] = useState('images');
  const TabContent = TAB_COMPONENTS[tab];

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', margin: 0 }}>Media Hub</h2>
        <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
          5 engines: Sharp images, ffmpeg video, TTS (Piper/edge-tts/SAPI), STT (faster-whisper/SAPI), OCR (Windows Media)
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #222', paddingBottom: 8 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 14px', borderRadius: '8px 8px 0 0', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: tab === t ? `${TAB_COLORS[t]}20` : 'transparent',
            color: tab === t ? TAB_COLORS[t] : '#666',
            borderBottom: tab === t ? `2px solid ${TAB_COLORS[t]}` : '2px solid transparent',
          }}>{TAB_LABELS[t]}</button>
        ))}
      </div>

      <TabContent />
    </div>
  );
}
