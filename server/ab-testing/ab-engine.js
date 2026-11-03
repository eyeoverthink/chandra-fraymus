import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';

export function initAbTestingTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ab_experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hypothesis TEXT,
      dimension TEXT NOT NULL DEFAULT 'topic',
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      winner TEXT,
      confidence REAL DEFAULT 0,
      created_at INTEGER NOT NULL,
      concluded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ab_status ON ab_experiments(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS ab_events (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'impression',
      value REAL DEFAULT 1,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES ab_experiments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ab_events_exp ON ab_events(experiment_id, variant, event_type);
  `);
}

export function createExperiment({ name, hypothesis, dimension, variantA, variantB }) {
  const id = `abx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO ab_experiments (id, name, hypothesis, dimension, variant_a, variant_b, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
    .run(id, name, hypothesis || null, dimension || 'topic', variantA, variantB, now);
  return { id, name, status: 'running' };
}

export function listExperiments({ status, limit } = {}) {
  let sql = 'SELECT * FROM ab_experiments WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Math.min(100, parseInt(limit) || 20)); }
  return db.prepare(sql).all(...params);
}

export function getExperiment(id) {
  return db.prepare('SELECT * FROM ab_experiments WHERE id = ?').get(id);
}

export function recordEvent({ experimentId, variant, eventType, value, metadata }) {
  const exp = getExperiment(experimentId);
  if (!exp || exp.status !== 'running') return { recorded: false, reason: 'experiment not running' };

  const validVariants = ['a', 'b'];
  if (!validVariants.includes(variant?.toLowerCase())) return { recorded: false, reason: 'variant must be a or b' };

  const id = `abe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO ab_events (id, experiment_id, variant, event_type, value, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, experimentId, variant.toLowerCase(), eventType || 'impression', value || 1,
      metadata ? JSON.stringify(metadata) : null, Date.now());
  return { recorded: true, eventId: id };
}

export function getResults(experimentId) {
  const exp = getExperiment(experimentId);
  if (!exp) return null;

  const statsA = getVariantStats(experimentId, 'a');
  const statsB = getVariantStats(experimentId, 'b');

  const zScore = calculateZScore(statsA, statsB);
  const pValue = zScoreToPValue(zScore);
  const significant = pValue < 0.05;
  const lift = statsA.conversionRate > 0
    ? ((statsB.conversionRate - statsA.conversionRate) / statsA.conversionRate * 100).toFixed(1)
    : 0;

  return {
    experiment: exp,
    variantA: { ...statsA, label: exp.variant_a },
    variantB: { ...statsB, label: exp.variant_b },
    statistics: { zScore: zScore.toFixed(3), pValue: pValue.toFixed(4), significant, lift: `${lift}%` },
    recommendation: significant
      ? (statsB.conversionRate > statsA.conversionRate
        ? `Variant B (${exp.variant_b}) wins with ${lift}% lift`
        : `Variant A (${exp.variant_a}) wins`)
      : `Not yet significant (p=${pValue.toFixed(3)}, need more data)`,
  };
}

function getVariantStats(experimentId, variant) {
  const impressions = db.prepare(
    `SELECT COUNT(*) as c, SUM(value) as total FROM ab_events
     WHERE experiment_id = ? AND variant = ? AND event_type = 'impression'`
  ).get(experimentId, variant);
  const conversions = db.prepare(
    `SELECT COUNT(*) as c, SUM(value) as total FROM ab_events
     WHERE experiment_id = ? AND variant = ? AND event_type = 'conversion'`
  ).get(experimentId, variant);
  const engagement = db.prepare(
    `SELECT COUNT(*) as c, SUM(value) as total FROM ab_events
     WHERE experiment_id = ? AND variant = ? AND event_type = 'engagement'`
  ).get(experimentId, variant);
  const revenue = db.prepare(
    `SELECT COUNT(*) as c, SUM(value) as total FROM ab_events
     WHERE experiment_id = ? AND variant = ? AND event_type = 'revenue'`
  ).get(experimentId, variant);

  const impCount = impressions?.c || 0;
  const convCount = conversions?.c || 0;
  return {
    impressions: impCount,
    conversions: convCount,
    conversionRate: impCount > 0 ? convCount / impCount : 0,
    engagements: engagement?.c || 0,
    engagementTotal: engagement?.total || 0,
    revenue: revenue?.total || 0,
    revenueCount: revenue?.c || 0,
  };
}

function calculateZScore(a, b) {
  const nA = a.impressions;
  const nB = b.impressions;
  if (nA < 5 || nB < 5) return 0;

  const pA = a.conversionRate;
  const pB = b.conversionRate;
  const pPool = (a.conversions + b.conversions) / (nA + nB);

  if (pPool === 0 || pPool === 1) return 0;

  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nA + 1 / nB));
  if (se === 0) return 0;

  return (pB - pA) / se;
}

function zScoreToPValue(z) {
  const absZ = Math.abs(z);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * absZ / Math.SQRT2);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ / 2);
  return 1 - erf;
}

export function concludeExperiment(id) {
  const results = getResults(id);
  if (!results) return null;

  const winner = results.statistics.significant
    ? (results.variantB.conversionRate > results.variantA.conversionRate ? 'b' : 'a')
    : 'inconclusive';

  db.prepare('UPDATE ab_experiments SET status = ?, winner = ?, confidence = ?, concluded_at = ? WHERE id = ?')
    .run('concluded', winner, 1 - parseFloat(results.statistics.pValue), Date.now(), id);

  return { ...results, winner, concluded: true };
}

export async function autoCreateExperiment({ topic, memoryBridge }) {
  const system = `You are an A/B testing strategist for content marketing. Given a topic, suggest one meaningful experiment.
Return JSON: { "name": "experiment name", "hypothesis": "if we X then Y because Z", "dimension": "topic|format|hook|thumbnail|timing", "variantA": "control description", "variantB": "treatment description" }`;

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Topic: ${topic}. Suggest an A/B test that would improve content performance.` },
  ]);
  const parsed = parseJSON(raw);
  if (!parsed || !parsed.variantA) return { error: 'Failed to generate experiment', raw };

  const exp = createExperiment(parsed);

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'ab_experiment_created',
      feeling: { primary: 'curiosity', intensity: 0.7 },
      response: `Created A/B experiment: ${parsed.name}`,
      durationMs: 0,
    }).catch(() => {});
  }

  return { ...exp, ...parsed };
}
