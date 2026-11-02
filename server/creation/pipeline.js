import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama, parseJSON, voiceEndpoint } from './shared.js';

const now = () => Date.now();

// ── Stage 1: Creative Brief Generator ──────────────────────────────
// Pulls from: intelligence stack (dreams, emotions, memory), REA findings, web trends
export async function runCreativeBrief(input, opts = {}) {
  const { topic, format = 'short_video', style = 'auto' } = input;
  if (!topic) throw new Error('topic required');

  const context = [];

  // Pull dream insights if intel available
  if (opts.intel) {
    try {
      const dreams = await opts.intel.recallDreams(3);
      if (dreams.length) {
        context.push(`DREAM INSIGHTS:\n${dreams.map(d => `- ${d.value || d.content || JSON.stringify(d)}`).join('\n')}`);
      }
    } catch {}
    try {
      const prior = await opts.intel.recallInsights(`creation pipeline: ${topic}`, 3);
      if (prior.length) {
        context.push(`PRIOR CREATION INSIGHTS:\n${prior.map(p => `- ${p.value || p.content || JSON.stringify(p)}`).join('\n')}`);
      }
    } catch {}
  }

  // Pull REA analysis if available
  try {
    const reaMemories = db.prepare(
      `SELECT key, value FROM agent_memories
       WHERE agent_id = 'rea_analyst' AND category IN ('analysis', 'task')
       ORDER BY updated_at DESC LIMIT 5`
    ).all();
    if (reaMemories.length) {
      context.push(`REA COMPETITIVE INTELLIGENCE:\n${reaMemories.map(r => `- ${r.key}: ${r.value}`).join('\n')}`);
    }
  } catch {}

  // Pull YouTube outlier data for trend signals
  try {
    const outliers = db.prepare(
      `SELECT title, channel_title, view_count, outlier_ratio, outlier_tier
       FROM outlier_board WHERE outlier_tier IN ('big','mid')
       ORDER BY outlier_ratio DESC LIMIT 8`
    ).all();
    if (outliers.length) {
      context.push(`TRENDING CONTENT (YouTube outliers):\n${outliers.map(o =>
        `- "${o.title}" by ${o.channel_title} (${o.outlier_ratio}x outlier, ${o.view_count} views)`
      ).join('\n')}`);
    }
  } catch {}

  const briefPrompt = `You are a creative director for a digital media agency. Generate a detailed creative brief.

TOPIC: ${topic}
FORMAT: ${format}
STYLE: ${style}

${context.length ? context.join('\n\n') : ''}

Produce a JSON creative brief:
{
  "title": "working title for the piece",
  "hook": "opening hook — first 3 seconds / first line",
  "narrative_arc": "beginning → middle → end structure",
  "visual_style": "color palette, mood, reference points",
  "audio_direction": {"narration": "tone/pace", "music": "genre/mood", "sfx": "key sound effects"},
  "shots": [{"description": "shot description", "duration_seconds": 3, "type": "wide/close/motion"}],
  "cta": "call to action",
  "target_audience": "who this is for",
  "distribution_channels": ["youtube_shorts", "tiktok", "instagram_reels"],
  "commerce_tie_in": "product or service this could promote (null if pure content)",
  "estimated_duration_seconds": 60,
  "intelligence_signals": "what dream/emotion/REA data informed this brief"
}

Return ONLY valid JSON.`;

  const raw = await chatOllama([
    { role: 'system', content: 'You are a creative director. Return only valid JSON.' },
    { role: 'user', content: briefPrompt },
  ], { temperature: 0.7 });

  const brief = parseJSON(raw);

  // Emotion-analyze the brief itself
  if (opts.intel) {
    try {
      const emotion = opts.intel.analyzeContent(brief.hook || brief.title || topic);
      if (emotion) brief._emotion = { primary: emotion.primary, sentiment: emotion.sentiment };
    } catch {}
  }

  return { stage: 'creative_brief', brief, topic, format, style };
}

// ── Stage 2: Script Writer ─────────────────────────────────────────
// Takes creative brief → produces narration script + shot list + timing
export async function runScriptWriter(briefOutput, opts = {}) {
  const { brief, topic, format } = briefOutput;

  const scriptPrompt = `You are a professional scriptwriter for short-form video content. Write a production-ready script.

CREATIVE BRIEF:
${JSON.stringify(brief, null, 2)}

FORMAT: ${format}

Write a JSON response:
{
  "narration_script": "full narration text with [PAUSE] markers and emphasis *markers*",
  "shot_list": [
    {
      "shot_number": 1,
      "visual": "detailed visual description for image generation or HyperFrames",
      "narration_segment": "what the narrator says during this shot",
      "duration_seconds": 3,
      "transition": "cut/fade/slide",
      "text_overlay": "on-screen text if any"
    }
  ],
  "total_duration_seconds": 60,
  "music_cue": "music mood and timing notes",
  "voice_direction": "tone, pace, emphasis notes for TTS/voice clone"
}

Return ONLY valid JSON.`;

  const raw = await chatOllama([
    { role: 'system', content: 'You are a scriptwriter. Return only valid JSON.' },
    { role: 'user', content: scriptPrompt },
  ], { temperature: 0.6, maxTokens: 4096 });

  const script = parseJSON(raw);
  return { stage: 'script_writer', script, brief, topic, format };
}

// ── Stage 3: Voice Synthesis ───────────────────────────────────────
// Takes script → produces narration audio via TTS cascade (Piper → edge-tts → SAPI)
export async function runVoiceSynth(scriptOutput, opts = {}) {
  const { script, topic } = scriptOutput;
  const narration = script.narration_script || script.shot_list?.map(s => s.narration_segment).join(' ') || topic;
  const voiceUrl = voiceEndpoint();

  let audioResult = null;

  // Try voice clone endpoint first (port 9099 contract)
  try {
    const res = await fetch(`${voiceUrl}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: narration.replace(/\[PAUSE\]/g, '...').replace(/\*/g, ''), voice: 'myvoice' }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      audioResult = { engine: 'voice_clone', status: 'ok', data };
    }
  } catch {}

  // Fallback to local TTS API
  if (!audioResult) {
    try {
      const res = await fetch('http://127.0.0.1:8787/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: narration.replace(/\[PAUSE\]/g, '...').replace(/\*/g, '') }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const data = await res.json();
        audioResult = { engine: data.engine || 'tts_cascade', status: 'ok', file: data.file || data.output };
      }
    } catch {}
  }

  if (!audioResult) {
    audioResult = { engine: 'none', status: 'unavailable', reason: 'No TTS engine reachable' };
  }

  return { stage: 'voice_synth', audio: audioResult, narration, script, topic };
}

// ── Stage 4: Visual Assembly ───────────────────────────────────────
// Takes script + voice → produces HyperFrames composition or image sequence
export async function runVisualAssembly(voiceOutput, opts = {}) {
  const { script, narration, audio, topic } = voiceOutput;
  const shots = script.shot_list || [];

  const compositions = [];
  for (const shot of shots) {
    // Generate image prompt for each shot via Ollama refinement
    const refined = await chatOllama([
      { role: 'system', content: 'You are a visual prompt engineer for AI image generation. Refine the visual into a detailed FLUX.1/Stable Diffusion prompt. Return ONLY the prompt text, no JSON.' },
      { role: 'user', content: `Shot: ${shot.visual}\nStyle: ${script.brief?.visual_style || 'cinematic'}\nMood: ${script.music_cue || 'dramatic'}` },
    ], { temperature: 0.5, maxTokens: 200 });

    compositions.push({
      shot_number: shot.shot_number,
      image_prompt: refined.trim(),
      narration_segment: shot.narration_segment,
      duration_seconds: shot.duration_seconds,
      transition: shot.transition,
      text_overlay: shot.text_overlay,
    });
  }

  // Try to render via ComfyUI/FLUX.1 for first shot as proof of concept
  let heroImage = null;
  if (compositions.length) {
    try {
      const genRes = await fetch('http://127.0.0.1:8787/api/images/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: compositions[0].image_prompt, width: 1024, height: 576 }),
        signal: AbortSignal.timeout(120_000),
      });
      if (genRes.ok) {
        const data = await genRes.json();
        heroImage = data.url || data.file || data.path;
      }
    } catch {}
  }

  return {
    stage: 'visual_assembly',
    compositions,
    heroImage,
    shotCount: compositions.length,
    audio,
    topic,
    script,
  };
}

// ── Stage 5: Distribution Prep ─────────────────────────────────────
// Takes assembled content → prepares platform-specific packages
export async function runDistributionPrep(assemblyOutput, opts = {}) {
  const { compositions, heroImage, audio, script, topic } = assemblyOutput;
  const brief = script.brief || {};
  const channels = brief.distribution_channels || ['youtube_shorts'];

  const packages = [];
  for (const channel of channels) {
    const pkg = await chatOllama([
      { role: 'system', content: 'You are a social media distribution specialist. Return only valid JSON.' },
      { role: 'user', content: `Prepare metadata for ${channel} distribution.

TITLE: ${brief.title || topic}
HOOK: ${brief.hook || ''}
CTA: ${brief.cta || ''}
AUDIENCE: ${brief.target_audience || 'general'}
DURATION: ${brief.estimated_duration_seconds || 60}s
SHOT COUNT: ${compositions.length}

Return JSON:
{
  "platform": "${channel}",
  "title": "platform-optimized title (max 100 chars)",
  "description": "platform-optimized description with hashtags",
  "hashtags": ["tag1", "tag2"],
  "thumbnail_prompt": "AI image prompt for platform thumbnail",
  "optimal_post_time": "recommended posting window",
  "format_notes": "platform-specific format requirements"
}` },
    ], { temperature: 0.4 });

    packages.push(parseJSON(pkg));
  }

  return {
    stage: 'distribution_prep',
    packages,
    channelCount: packages.length,
    heroImage,
    compositions,
    audio,
    topic,
    brief,
  };
}

// ── Stage 6: Commerce Bridge ───────────────────────────────────────
// Takes distributed content → links to commerce pipeline if applicable
export async function runCommerceBridge(distOutput, opts = {}) {
  const { brief, topic, packages } = distOutput;
  const commerceTieIn = brief.commerce_tie_in;

  if (!commerceTieIn || commerceTieIn === 'null') {
    return { stage: 'commerce_bridge', status: 'skipped', reason: 'No commerce tie-in in brief', topic };
  }

  // Check if a commerce pipeline run already exists for this topic
  let existingRun = null;
  try {
    existingRun = db.prepare(
      `SELECT id, status, score FROM commerce_pipeline_runs
       WHERE topic LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).get(`%${topic}%`);
  } catch {}

  if (existingRun) {
    return {
      stage: 'commerce_bridge',
      status: 'linked',
      commerceRunId: existingRun.id,
      commerceStatus: existingRun.status,
      topic,
    };
  }

  // No existing run — prepare a commerce handoff
  return {
    stage: 'commerce_bridge',
    status: 'ready',
    commerceTopic: commerceTieIn,
    recommendation: `Run commerce.full_pipeline with topic "${commerceTieIn}" to create matching products/content`,
    topic,
  };
}

// ── Full Creation Pipeline Orchestrator ─────────────────────────────
export async function runCreationPipeline(input, opts = {}) {
  const t0 = Date.now();
  const stages = {};
  const { intel, broadcast } = opts;

  try {
    if (intel) {
      try {
        const prior = await intel.recallInsights(`creation pipeline: ${input.topic}`, 3);
        if (prior.length) stages.intel_recall = { count: prior.length };
      } catch {}
    }

    if (broadcast) broadcast('creation', { type: 'pipeline_start', topic: input.topic });

    const t1 = Date.now();
    const briefed = await runCreativeBrief(input, { intel });
    stages.creative_brief = { status: 'ok', data: briefed, durationMs: Date.now() - t1 };
    if (broadcast) broadcast('creation', { type: 'stage_complete', stage: 'creative_brief' });

    const t2 = Date.now();
    const scripted = await runScriptWriter(briefed, { intel });
    stages.script_writer = { status: 'ok', data: scripted, durationMs: Date.now() - t2 };
    if (broadcast) broadcast('creation', { type: 'stage_complete', stage: 'script_writer' });

    const t3 = Date.now();
    const voiced = await runVoiceSynth(scripted, { intel });
    stages.voice_synth = { status: 'ok', data: voiced, durationMs: Date.now() - t3 };
    if (broadcast) broadcast('creation', { type: 'stage_complete', stage: 'voice_synth' });

    const t4 = Date.now();
    const assembled = await runVisualAssembly(voiced, { intel });
    stages.visual_assembly = { status: 'ok', data: assembled, durationMs: Date.now() - t4 };
    if (broadcast) broadcast('creation', { type: 'stage_complete', stage: 'visual_assembly' });

    const t5 = Date.now();
    const distributed = await runDistributionPrep(assembled, { intel });
    stages.distribution_prep = { status: 'ok', data: distributed, durationMs: Date.now() - t5 };
    if (broadcast) broadcast('creation', { type: 'stage_complete', stage: 'distribution_prep' });

    const t6 = Date.now();
    const bridged = await runCommerceBridge(distributed, { intel });
    stages.commerce_bridge = { status: 'ok', data: bridged, durationMs: Date.now() - t6 };

    // Log the run
    const runId = randomUUID();
    try {
      db.prepare(`INSERT INTO creation_pipeline_runs
        (id, topic, format, status, stages, shot_count, channels, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId,
        input.topic,
        input.format || 'short_video',
        'completed',
        JSON.stringify(stages),
        assembled.shotCount || 0,
        JSON.stringify(distributed.packages?.map(p => p.platform) || []),
        now(),
      );
    } catch (e) { console.error('creation run log:', e.message); }

    if (intel) {
      intel.storeInsight({
        type: 'creation_pipeline',
        topic: input.topic,
        format: input.format,
        shotCount: assembled.shotCount,
        channels: distributed.channelCount,
        commerceBridge: bridged.status,
        durationMs: Date.now() - t0,
      });
    }

    if (broadcast) broadcast('creation', { type: 'pipeline_complete', runId, topic: input.topic });

    return {
      status: 'completed',
      stages,
      totalDurationMs: Date.now() - t0,
      runId,
      shotCount: assembled.shotCount,
      channelCount: distributed.channelCount,
    };
  } catch (e) {
    if (broadcast) broadcast('creation', { type: 'pipeline_error', error: e.message });
    return {
      status: 'error',
      error: e.message,
      stages,
      totalDurationMs: Date.now() - t0,
    };
  }
}
