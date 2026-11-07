/**
 * Curated presets. They call Chandra's existing creation stages and persist
 * both a F.R.A.Y.M.U.S. artifact and, when the table exists, a creation_pipeline_runs row.
 * They never publish.
 */

import { randomUUID } from 'node:crypto';
import { isAbort } from './http-error.js';

export const PRESETS = [
  {
    id: 'research-brief',
    title: 'Research brief',
    summary: 'Turn a topic into a creative brief with Chandra creation stage 1.',
    stages: ['creative_brief'],
    services: ['ollama'],
    publishes: false,
  },
  {
    id: 'short-video-script',
    title: 'Short-video script',
    summary: 'Turn a topic into a brief and a narration script with Chandra creation stages 1 and 2.',
    stages: ['creative_brief', 'script_writer'],
    services: ['ollama'],
    publishes: false,
  },
];

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch (error) {
    console.error('fraymus-os recipes table check:', error.message);
    return false;
  }
}

async function defaultBrief(input, ctx) {
  const { runCreativeBrief } = await import('../creation/pipeline.js');
  return runCreativeBrief(input, ctx);
}

async function defaultScript(briefOutput, ctx) {
  const { runScriptWriter } = await import('../creation/pipeline.js');
  return runScriptWriter(briefOutput, ctx);
}

export function createRecipes(options) {
  const { db } = options;
  const runCreativeBrief = options.runCreativeBrief || defaultBrief;
  const runScriptWriter = options.runScriptWriter || defaultScript;

  const insertArtifact = db.prepare(`INSERT INTO fraymus_os_artifacts
    (id, preset, topic, status, payload, provenance, creation_run_id, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function insertCreationRun({ id, topic, format, status, stages, error }) {
    if (!tableExists(db, 'creation_pipeline_runs')) return null;
    try {
      db.prepare(`INSERT INTO creation_pipeline_runs
        (id, topic, format, status, stages, shot_count, channels, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        topic,
        format,
        status,
        JSON.stringify({ ...stages, error: error || null, via: 'fraymus-os' }),
        stages.script?.script?.shot_list?.length || stages.brief?.brief?.shots?.length || 0,
        '[]',
        Date.now(),
      );
      return id;
    } catch (error_) {
      console.error('fraymus-os creation run:', error_.message);
      return null;
    }
  }

  function provenance(preset, extra = {}) {
    return {
      store: 'fraymus_os_artifacts',
      preset: preset.id,
      stages: preset.stages,
      writer: 'fraymus-os',
      publishes: false,
      modelNote: 'The Chandra creation stage chooses the model through OLLAMA_BASE_URL and FRAYMUS_DEFAULT_MODEL.',
      ...extra,
      createdAt: Date.now(),
    };
  }

  async function run(presetId, input = {}, ctx = {}) {
    const preset = PRESETS.find(item => item.id === presetId);
    if (!preset) {
      const error = new Error('Unknown preset');
      error.status = 404;
      throw error;
    }
    const topic = String(input.topic || '').trim();
    if (!topic || topic.length > 500) {
      const error = new Error('topic is required (1–500 characters)');
      error.status = 400;
      throw error;
    }
    const format = preset.id === 'research-brief' ? 'research_brief' : (input.format || 'short_video');
    const artifactId = randomUUID();
    const creationRunId = randomUUID();
    const started = Date.now();
    try {
      if (ctx.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const brief = await runCreativeBrief({ topic, format, style: input.style || 'auto' }, { signal: ctx.signal });
      if (ctx.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      let script = null;
      if (preset.stages.includes('script_writer')) {
        script = await runScriptWriter(brief, { signal: ctx.signal });
        if (ctx.signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }
      const payload = { brief: brief.brief || brief, script: script?.script || null, topic, format };
      const recordProvenance = provenance(preset, {
        durationMs: Date.now() - started,
        model: brief.model || script?.model || null,
        endpoint: brief.endpoint || null,
      });
      const stages = { creative_brief: brief, script_writer: script };
      const savedRun = insertCreationRun({ id: creationRunId, topic, format, status: 'completed', stages });
      insertArtifact.run(
        artifactId, preset.id, topic, 'completed', JSON.stringify(payload),
        JSON.stringify(recordProvenance), savedRun, null, Date.now(),
      );
      return getArtifact(artifactId);
    } catch (error) {
      if (isAbort(error, ctx.signal)) throw error;
      const message = error.message || 'Creation stage failed';
      const savedRun = insertCreationRun({
        id: creationRunId, topic, format, status: 'failed', stages: {}, error: message,
      });
      insertArtifact.run(
        artifactId, preset.id, topic, 'failed', null,
        JSON.stringify(provenance(preset, { durationMs: Date.now() - started })),
        savedRun, message, Date.now(),
      );
      const wrapped = new Error(message);
      wrapped.status = error.status || 503;
      wrapped.artifact = getArtifact(artifactId);
      throw wrapped;
    }
  }

  function listArtifacts(limit = 20) {
    const capped = Math.min(100, Math.max(1, limit));
    return db.prepare(`SELECT id, preset, topic, status, provenance, creation_run_id AS creationRunId, error, created_at AS createdAt
      FROM fraymus_os_artifacts ORDER BY created_at DESC LIMIT ?`).all(capped).map(row => ({
      ...row,
      provenance: JSON.parse(row.provenance),
    }));
  }

  function getArtifact(id) {
    const row = db.prepare(`SELECT id, preset, topic, status, payload, provenance, creation_run_id AS creationRunId, error, created_at AS createdAt
      FROM fraymus_os_artifacts WHERE id = ?`).get(id);
    if (!row) return null;
    return {
      ...row,
      payload: row.payload ? JSON.parse(row.payload) : null,
      provenance: JSON.parse(row.provenance),
    };
  }

  return { presets: PRESETS, run, listArtifacts, getArtifact };
}
