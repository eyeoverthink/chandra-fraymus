import { useState, useEffect, useCallback } from 'react';

export default function RepurposePanel({ wsEvent }) {
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [tab, setTab] = useState('repurpose');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [content, setContent] = useState('');
  const [sourceFormat, setSourceFormat] = useState('article');
  const [targetFormats, setTargetFormats] = useState([]);
  const [suggestions, setSuggestions] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);

  const FORMATS = ['twitter_thread', 'short_video_script', 'linkedin_post', 'instagram_caption', 'carousel_slides', 'newsletter_blurb', 'blog_post', 'youtube_description'];
  const FORMAT_LABELS = { twitter_thread: 'Twitter Thread', short_video_script: 'Short Video', linkedin_post: 'LinkedIn Post', instagram_caption: 'IG Caption', carousel_slides: 'Carousel', newsletter_blurb: 'Newsletter', blog_post: 'Blog Post', youtube_description: 'YT Description' };

  const load = useCallback(async () => {
    try {
      setError('');
      const [jRes, sRes, tRes] = await Promise.all([
        fetch('/api/repurpose/jobs?limit=20'),
        fetch('/api/repurpose/stats'),
        fetch('/api/repurpose/templates'),
      ]);
      setJobs((await jRes.json()).jobs || []);
      setStats(await sRes.json());
      setTemplates((await tRes.json()).templates || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'job_completed' || wsEvent?.type === 'job_started') load();
  }, [wsEvent, load]);

  const toggleFormat = (f) => {
    setTargetFormats(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]);
  };

  const runRepurpose = async () => {
    if (!content.trim()) return;
    try {
      setLoading(true);
      setError('');
      const body = { content, sourceFormat };
      if (targetFormats.length > 0) body.targetFormats = targetFormats;
      const res = await fetch('/api/repurpose/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const result = await res.json();
      setSelectedJob(result);
      setTab('results');
      await load();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const suggestTargets = async () => {
    if (!content.trim()) return;
    try {
      setLoading(true);
      const res = await fetch('/api/repurpose/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      setSuggestions(await res.json());
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const loadJob = async (id) => {
    try {
      const res = await fetch(`/api/repurpose/jobs/${id}`);
      const data = await res.json();
      setSelectedJob(data);
      setTab('results');
    } catch (e) { setError(e.message); }
  };

  const st = { panel: { color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', padding: '1rem', height: '100%', overflowY: 'auto', background: '#0a0a1a' },
    tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
    tab: (a) => ({ padding: '0.4rem 0.9rem', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, background: a ? '#ec4899' : '#1e1e3a', color: a ? '#fff' : '#a0a0c0' }),
    card: { background: '#12122a', borderRadius: '8px', padding: '0.8rem', marginBottom: '0.6rem', border: '1px solid #2a2a4a' },
    stat: { background: '#12122a', borderRadius: '8px', padding: '0.6rem 0.8rem', flex: 1, textAlign: 'center', border: '1px solid #2a2a4a' },
    statNum: { fontSize: '1.4rem', fontWeight: 700, color: '#f472b6' },
    statLabel: { fontSize: '0.7rem', color: '#888', textTransform: 'uppercase' },
    btn: (c = '#ec4899') => ({ padding: '0.4rem 0.9rem', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, background: c, color: '#fff' }),
    badge: (c) => ({ display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600, background: c + '22', color: c }),
    textarea: { width: '100%', minHeight: '120px', padding: '0.6rem', borderRadius: '6px', border: '1px solid #2a2a4a', background: '#1e1e3a', color: '#e2e8f0', fontSize: '0.85rem', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' },
    select: { padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid #2a2a4a', background: '#1e1e3a', color: '#e2e8f0', fontSize: '0.85rem' },
    formatBtn: (on) => ({ padding: '0.3rem 0.6rem', borderRadius: '4px', border: `1px solid ${on ? '#ec4899' : '#2a2a4a'}`, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, background: on ? '#ec489922' : '#1e1e3a', color: on ? '#f472b6' : '#888' }),
    h3: { margin: '0 0 0.3rem', fontSize: '1rem', fontWeight: 700 },
    sub: { color: '#888', fontSize: '0.75rem' },
    error: { color: '#f87171', fontSize: '0.8rem', marginBottom: '0.5rem' },
    variantCard: { background: '#1a1a35', borderRadius: '6px', padding: '0.7rem', marginBottom: '0.5rem', border: '1px solid #2a2a4a' },
  };

  const statusColor = (s) => ({ completed: '#22c55e', running: '#f59e0b', failed: '#ef4444', pending: '#94a3b8' }[s] || '#94a3b8');

  return (
    <div style={st.panel}>
      <div style={st.tabs}>
        {['repurpose', 'history', 'results', 'stats'].map(t => (
          <button key={t} style={st.tab(tab === t)} onClick={() => setTab(t)}>
            {t === 'repurpose' ? 'New' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && <p style={st.error}>{error}</p>}

      {tab === 'repurpose' && (
        <div>
          <h3 style={st.h3}>Repurpose Content</h3>
          <p style={st.sub}>Paste your source content and select output formats.</p>
          <textarea style={st.textarea} value={content} onChange={e => setContent(e.target.value)} placeholder="Paste article, script, or other content here..." />

          <div style={{ display: 'flex', gap: '0.5rem', margin: '0.6rem 0', alignItems: 'center' }}>
            <span style={st.sub}>Source:</span>
            <select style={st.select} value={sourceFormat} onChange={e => setSourceFormat(e.target.value)}>
              <option value="article">Article</option>
              <option value="blog_post">Blog Post</option>
              <option value="short_video_script">Video Script</option>
              <option value="newsletter">Newsletter</option>
              <option value="podcast_transcript">Podcast</option>
            </select>
          </div>

          <div style={{ marginBottom: '0.6rem' }}>
            <span style={{ ...st.sub, display: 'block', marginBottom: '0.3rem' }}>Target Formats (empty = auto-select 4):</span>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {FORMATS.map(f => (
                <button key={f} style={st.formatBtn(targetFormats.includes(f))} onClick={() => toggleFormat(f)}>
                  {FORMAT_LABELS[f] || f}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={st.btn()} onClick={runRepurpose} disabled={loading || !content.trim()}>
              {loading ? 'Repurposing...' : 'Repurpose Now'}
            </button>
            <button style={st.btn('#6366f1')} onClick={suggestTargets} disabled={loading || !content.trim()}>
              Suggest Targets
            </button>
          </div>

          {suggestions?.suggestions?.recommendations && (
            <div style={{ ...st.card, marginTop: '0.8rem', borderColor: '#6366f144' }}>
              <h3 style={{ ...st.h3, color: '#818cf8', fontSize: '0.9rem' }}>AI Recommendations</h3>
              {suggestions.suggestions.recommendations.map((r, i) => (
                <div key={i} style={{ padding: '0.3rem 0', borderBottom: '1px solid #1e1e3a', fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{FORMAT_LABELS[r.format] || r.format} → {r.platform}</strong>
                    <span style={st.badge(r.priority === 'high' ? '#22c55e' : r.priority === 'medium' ? '#f59e0b' : '#94a3b8')}>{r.priority}</span>
                  </div>
                  <p style={{ ...st.sub, margin: '0.1rem 0' }}>{r.reasoning}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div>
          <h3 style={st.h3}>Job History ({jobs.length})</h3>
          {jobs.length === 0 && <p style={st.sub}>No repurposing jobs yet.</p>}
          {jobs.map(j => (
            <div key={j.id} style={st.card} onClick={() => loadJob(j.id)} role="button" tabIndex={0}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: '0.85rem' }}>{j.source_format} → {j.variant_count} variants</strong>
                <span style={st.badge(statusColor(j.status))}>{j.status}</span>
              </div>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.3rem' }}>
                <span style={st.sub}>Quality: {((j.quality_score || 0) * 100).toFixed(0)}%</span>
                <span style={st.sub}>{j.duration_ms ? (j.duration_ms / 1000).toFixed(1) + 's' : ''}</span>
                <span style={st.sub}>{new Date(j.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'results' && selectedJob && (
        <div>
          <h3 style={st.h3}>Repurposed Variants</h3>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
            <span style={st.badge('#22c55e')}>{(selectedJob.variants || []).filter(v => !v.error).length} successful</span>
            {selectedJob.quality != null && <span style={st.badge('#f472b6')}>Quality: {(selectedJob.quality * 100).toFixed(0)}%</span>}
            {selectedJob.duration && <span style={st.badge('#94a3b8')}>{(selectedJob.duration / 1000).toFixed(1)}s</span>}
          </div>
          {(selectedJob.variants || JSON.parse(selectedJob.variants_json || '[]')).map((v, i) => (
            <div key={i} style={st.variantCard}>
              {v.error ? (
                <div style={{ color: '#f87171', fontSize: '0.8rem' }}>Error for {v.format}: {v.error}</div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                    <strong style={{ fontSize: '0.85rem' }}>{v.title || FORMAT_LABELS[v.format] || v.format}</strong>
                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                      <span style={st.badge('#ec4899')}>{FORMAT_LABELS[v.format] || v.format}</span>
                      <span style={st.badge('#6366f1')}>{v.platform}</span>
                    </div>
                  </div>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem', color: '#c4b5fd', margin: '0.3rem 0', lineHeight: 1.5, maxHeight: '200px', overflow: 'auto' }}>
                    {v.content}
                  </pre>
                  <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
                    {v.word_count && <span style={st.sub}>{v.word_count} words</span>}
                    {v.cta && <span style={st.sub}>CTA: {v.cta}</span>}
                    {v.hashtags?.length > 0 && <span style={st.sub}>{v.hashtags.join(' ')}</span>}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'stats' && stats && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
            <div style={st.stat}><div style={st.statNum}>{stats.totalJobs || 0}</div><div style={st.statLabel}>Jobs</div></div>
            <div style={st.stat}><div style={st.statNum}>{stats.totalVariants || 0}</div><div style={st.statLabel}>Variants</div></div>
            <div style={st.stat}><div style={st.statNum}>{stats.avgQuality ? (stats.avgQuality * 100).toFixed(0) + '%' : '—'}</div><div style={st.statLabel}>Avg Quality</div></div>
            <div style={st.stat}><div style={st.statNum}>{stats.avgDuration ? (stats.avgDuration / 1000).toFixed(1) + 's' : '—'}</div><div style={st.statLabel}>Avg Duration</div></div>
          </div>
          {stats.topTemplates?.length > 0 && (
            <div style={st.card}>
              <h3 style={st.h3}>Top Templates</h3>
              {stats.topTemplates.map((t, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', borderBottom: '1px solid #1e1e3a', fontSize: '0.8rem' }}>
                  <span>{t.name}</span>
                  <span style={{ color: '#f472b6' }}>{t.uses} uses</span>
                </div>
              ))}
            </div>
          )}
          {stats.byFormat?.length > 0 && (
            <div style={st.card}>
              <h3 style={st.h3}>By Source Format</h3>
              {stats.byFormat.map((f, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', borderBottom: '1px solid #1e1e3a', fontSize: '0.8rem' }}>
                  <span>{f.source_format}</span>
                  <span>{f.jobs} jobs / {f.variants || 0} variants</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
