/**
 * Sensory channel registry — single source of truth for what the organism can sense.
 *
 * Before Phase Q this list lived as five separate copies (sensory bridge, attention
 * gate, habituation, working memory, predictive processing) and every channel pointed
 * inward: bus, memory, emotion, consciousness, agent, health, workflow, goals. A brain
 * whose every sense reports on itself cannot learn about the world. Phase Q adds the
 * outward channels (web, youtube, commerce, mesh, git, user) and makes every consumer
 * import from here, so a new sense is one entry.
 *
 * Grid rows in use: 0 self-model · 1 resource · 2 sensory-L · 3 prediction · 4 metacog ·
 * 5 inference · 6 temporal · 8 motor-centre · 10 sensory-R · 11 outward senses ·
 * 12 adaptive · 14 motor · column 15 user sensorium.
 */

export const SENSORY_REGIONS = {
  // Internal state (left hemisphere)
  bus:           { tx: 2,  ty: 2,  sigma: 2.0, label: 'Bus traffic',         external: false },
  memory:        { tx: 2,  ty: 6,  sigma: 2.0, label: 'Memory writes',       external: false },
  emotion:       { tx: 2,  ty: 10, sigma: 2.5, label: 'Emotion state',       external: false },
  consciousness: { tx: 2,  ty: 14, sigma: 2.0, label: 'Consciousness tier',  external: false },
  // Action state (right hemisphere)
  agent:         { tx: 10, ty: 2,  sigma: 2.0, label: 'Agent activity',      external: false },
  health:        { tx: 10, ty: 6,  sigma: 2.0, label: 'Health status',       external: false },
  workflow:      { tx: 10, ty: 10, sigma: 2.0, label: 'Workflow runs',       external: false },
  goals:         { tx: 10, ty: 14, sigma: 2.0, label: 'Goals / RSI',         external: false },
  binary_insight:{ tx: 6,  ty: 14, sigma: 2.0, label: 'Binary insight (RE)', external: false },
  // Outward senses (Phase Q) — row 11
  web:           { tx: 11, ty: 1,  sigma: 1.5, label: 'Web research & trends',   external: true },
  youtube:       { tx: 11, ty: 4,  sigma: 1.5, label: 'YouTube outliers',        external: true },
  commerce:      { tx: 11, ty: 7,  sigma: 1.5, label: 'Commerce (Shopify orders)', external: true },
  mesh:          { tx: 11, ty: 10, sigma: 1.5, label: 'Mesh peers (hub + NUDP)',  external: true },
  git:           { tx: 11, ty: 13, sigma: 1.5, label: 'Repository activity',     external: true },
  // The user sensorium already injects at column 15; this channel carries the signal
  // into working memory / prediction / inference without a second injection.
  user:          { tx: 13, ty: 8,  sigma: 1.5, label: 'User presence',           external: true, inject: false },
};

export const SENSORY_KEYS = Object.keys(SENSORY_REGIONS);
export const INTERNAL_KEYS = SENSORY_KEYS.filter(k => !SENSORY_REGIONS[k].external);
export const EXTERNAL_KEYS = SENSORY_KEYS.filter(k => SENSORY_REGIONS[k].external);
