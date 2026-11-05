/**
 * Phase 17 — Self-Model Registry: System Proprioception
 *
 * Gives the system a map of its own body — every subsystem knows where it
 * appears in the frontend, what API endpoints expose its state, and how
 * backend functions map to visual representations the user sees.
 *
 * Biological analogue: proprioception — the body-schema sense that lets
 * an organism know where its limbs are without looking. Here, agents and
 * subsystems gain awareness of their "visual body" in the Nexus UI.
 *
 * Game-engine analogue: each object's rigidbody (transform, identity,
 * behavior) — but for UI components. Every subsystem has a location
 * (view/panel/widget), identity (name/role/endpoints), and state.
 *
 * Three capabilities:
 *   1. SYSTEM_MAP — static registry of every subsystem's backend↔frontend mapping
 *   2. collectVisualState() — dynamic snapshot of what the UI would show now
 *   3. buildSpatialContext(agentId) — prompt fragment giving an agent body-awareness
 *
 * CTRNN proprioceptive regions (row 0 — crown, above all other bands):
 *   Body activity  (0, 4)  σ=2.0 — how alive the visual body is (UI engagement)
 *   Body coherence (0, 12) σ=2.0 — backend-state ↔ frontend-expectation alignment
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { getAutonomyModifiers } from './consciousness-gate.js';

const now = () => Date.now();

const SNAPSHOT_EVERY = 20;
const BASE_PROPRIO_SENSITIVITY = 0.5;

const SYSTEM_MAP = [
  // ─── Intelligence subsystems ──────────────────────────────────
  {
    id: 'ctrnn',
    name: 'CTRNN Neural Core',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/ctrnn.js',
      functions: ['tick', 'inject', 'start', 'stop', 'state', 'modulatePlasticity'],
      endpoints: ['/api/ctrnn/stats', '/api/ctrnn/state', '/api/ctrnn/start', '/api/ctrnn/stop', '/api/ctrnn/inject'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'CTRNN Neural Core',
      panel: null,
      constellationNode: 'CTRNN',
      specialView: 'ManifestationPlane',
      description: 'Isometric 3D terrain in Manifestation Plane — neuron activation heights, drag-to-rotate, click-to-inject. Stat cards show tick/neurons/synapses/connectivity.',
    },
  },
  {
    id: 'consciousness',
    name: 'Consciousness Proofs',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/consciousness-cycle.js',
      functions: ['runConsciousnessAudit', 'getConsciousnessStats'],
      endpoints: ['/api/intelligence/consciousness/stats', '/api/intelligence/consciousness/run'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'IntelligencePanel',
      constellationNode: 'Consciousness',
      description: 'Intelligence Panel shows 4 proofs (EI, Phi, Mirror, CF) with pass/fail badges and proof values.',
    },
  },
  {
    id: 'consciousness-gate',
    name: 'Consciousness Gate',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/consciousness-gate.js',
      functions: ['getConsciousnessState', 'getAutonomyModifiers', 'onStateTransition'],
      endpoints: ['/api/intelligence/consciousness/gate', '/api/intelligence/consciousness/modifiers'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'DashboardPanel',
      constellationNode: 'Consciousness',
      description: 'Dashboard shows tier badge (DORMANT/AWAKENING/EMERGING/INTEGRATED) with color coding. Gate modifiers shown as runtime intelligence cards.',
    },
  },
  {
    id: 'heart',
    name: 'Heart Emotion Engine',
    category: 'intelligence',
    backend: {
      module: 'server/fraymus/intelligence/heart.js',
      functions: ['feel', 'recentMood', 'emotionHistory'],
      endpoints: ['/api/fraymus/heart/feel', '/api/fraymus/heart/mood'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'IntelligencePanel',
      constellationNode: 'Heart',
      description: 'Intelligence Panel shows mood wheel with 7 emotion dimensions, intensity bars, sentiment indicator. Constellation node pulses with emotional color.',
    },
  },
  {
    id: 'dreamer',
    name: 'Dream Protocol',
    category: 'intelligence',
    backend: {
      module: 'server/fraymus/intelligence/dreamer.js',
      functions: ['dream', 'dreamCount', 'lastDream'],
      endpoints: ['/api/fraymus/dreamer/dream', '/api/fraymus/dreamer/recent'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'IntelligencePanel',
      constellationNode: 'Dreamer',
      description: 'Intelligence Panel shows latest dream text with Ed25519 signature badge, dream count, signed timestamp.',
    },
  },
  {
    id: 'sensory-bridge',
    name: 'Sensory Bridge',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/sensory-bridge.js',
      functions: ['startSensoryBridge', 'stopSensoryBridge', 'getSensoryStatus'],
      endpoints: ['/api/intelligence/sensory', '/api/intelligence/sensory/history'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'DashboardPanel',
      constellationNode: null,
      description: 'Dashboard runtime intelligence cards show sensory bridge status with signal amplitudes per region.',
    },
  },
  {
    id: 'emotional-feedback',
    name: 'Emotional Feedback',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/emotional-feedback.js',
      functions: ['startEmotionalFeedback', 'stopEmotionalFeedback', 'getEmotionalFeedbackStatus'],
      endpoints: ['/api/intelligence/emotional-feedback', '/api/intelligence/emotional-feedback/history'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'DashboardPanel',
      constellationNode: null,
      description: 'Dashboard runtime intelligence cards show plasticity modulation state, primary emotion, and neuromodulator mapping.',
    },
  },
  {
    id: 'motor-output',
    name: 'Motor Output',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/motor-output.js',
      functions: ['startMotorOutput', 'stopMotorOutput', 'getMotorOutputStatus', 'triggerMotorCycle'],
      endpoints: ['/api/intelligence/motor-output', '/api/intelligence/motor-output/trigger'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'DashboardPanel',
      constellationNode: null,
      description: 'Dashboard shows 6 motor regions with activation bars, cooldown timers, and firing history.',
    },
  },
  {
    id: 'reflection',
    name: 'Reflection Loop',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/reflection.js',
      functions: ['reflect', 'getReflections'],
      endpoints: ['/api/intelligence/reflect', '/api/intelligence/reflections'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'EvolutionLog',
      constellationNode: 'Reflection',
      description: 'Evolution Log shows reflection events with action summaries, insights, duration. Intelligence Panel has manual trigger button.',
    },
  },
  {
    id: 'metacognitive',
    name: 'Metacognitive Monitor',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/metacognitive-monitor.js',
      functions: ['runAssessment', 'getMetacognitiveStatus', 'getStrategyRecommendation'],
      endpoints: ['/api/intelligence/metacognitive', '/api/intelligence/metacognitive/strategy'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'DashboardPanel',
      constellationNode: null,
      description: 'Dashboard runtime intelligence cards show effectiveness/stuck/confidence scores and active strategy mode.',
    },
  },
  {
    id: 'adaptive-strategy',
    name: 'Adaptive Strategy Engine',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/adaptive-strategy.js',
      functions: ['updateAdaptiveStrategy', 'getAdaptiveModifiers', 'isActionSuppressed', 'isActionPreferred'],
      endpoints: ['/api/intelligence/adaptive-strategy', '/api/intelligence/adaptive-strategy/modifiers'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'DashboardPanel',
      constellationNode: null,
      description: 'Dashboard shows active strategy badge (nominal/diversify/conserve/calibrate) with parameter set summary.',
    },
  },
  {
    id: 'opeg',
    name: 'OPEG Protocol',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/opeg.js',
      functions: ['propose', 'execute', 'sanitize', 'update', 'runPipeline'],
      endpoints: ['/api/intelligence/opeg/stats', '/api/intelligence/opeg/proposals'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'EvolutionLog',
      constellationNode: 'OPEG',
      description: 'Evolution Log shows proposals with state machine progression (S0→S4), approval/rejection verdicts.',
    },
  },
  {
    id: 'neurogenesis',
    name: 'Neurogenesis Engine',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/neurogenesis.js',
      functions: ['neurogenesisCycle', 'neurogenesisStats'],
      endpoints: ['/api/intelligence/neurogenesis/stats', '/api/intelligence/neurogenesis/trigger'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'EvolutionLog',
      constellationNode: null,
      description: 'Evolution Log shows neurogenesis events with connectivity scores and stimulus types (emergency vs poisson).',
    },
  },
  {
    id: 'verifier-loop',
    name: 'Generator-Verifier-Executor',
    category: 'intelligence',
    backend: {
      module: 'server/intelligence/verifier-loop.js',
      functions: ['runVerifierLoop', 'listLoops'],
      endpoints: ['/api/intelligence/verify/run', '/api/intelligence/verify/loops'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'EvolutionLog',
      constellationNode: null,
      description: 'Evolution Log shows verification loops with step-by-step drill-down, code/critique/execution for each iteration.',
    },
  },
  // ─── Fleet subsystems ─────────────────────────────────────────
  {
    id: 'fleet',
    name: 'Agent Fleet',
    category: 'fleet',
    backend: {
      module: 'server/fleet/runtime.js',
      functions: ['runAgent', 'reloadManifests'],
      endpoints: ['/api/agents', '/api/fleet/runs', '/api/fleet/threads'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Active Agents',
      panel: 'FleetPanel',
      constellationNode: 'Fleet',
      description: 'Fleet Panel shows agent cards with avatars, role badges, stat pills. Click card for detail view with task sender, thread viewer, run history.',
    },
  },
  {
    id: 'bus',
    name: 'Agent Live Bus',
    category: 'fleet',
    backend: {
      module: 'server/fleet/bus.js',
      functions: ['publish', 'directMessage', 'subscribe'],
      endpoints: ['/api/bus/publish', '/api/bus/topics', '/api/bus/history'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Bus Activity',
      panel: 'FleetPanel',
      constellationNode: 'Bus',
      description: 'Command Center widget shows recent bus messages with topic badges. Fleet Panel includes bus topic list.',
    },
  },
  {
    id: 'forge',
    name: 'Agent Forge',
    category: 'fleet',
    backend: {
      module: 'server/fleet/forge.js',
      functions: ['forgeAgent'],
      endpoints: ['/api/fleet/forge', '/api/fleet/forge/history'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Evolution',
      panel: 'ForgePanel',
      constellationNode: null,
      description: 'Forge Panel has goal input → LLM generates agent manifest. History view shows forged agents with goal, creation time, delete.',
    },
  },
  // ─── Workflow subsystems ──────────────────────────────────────
  {
    id: 'workflow',
    name: 'Visual Workflow Engine',
    category: 'workflow',
    backend: {
      module: 'server/workflow/engine.js',
      functions: ['runPipeline'],
      endpoints: ['/api/workflows', '/api/workflows/run'],
    },
    frontend: {
      view: 'Canvas',
      widget: 'Workflows',
      panel: 'WorkflowCanvas',
      constellationNode: 'Workflows',
      description: 'Canvas view is a ReactFlow visual builder with 39+ node types, drag-and-drop, 8 pre-built templates. Per-node execution status lights up during runs.',
    },
  },
  // ─── Commerce subsystems ──────────────────────────────────────
  {
    id: 'commerce',
    name: 'Commerce Pipelines',
    category: 'commerce',
    backend: {
      module: 'server/commerce/routes.js',
      functions: ['runContentPipeline', 'runApparelPipeline', 'runMysteryShopper', 'runStoreFixer'],
      endpoints: ['/api/content-pipeline/run', '/api/apparel-pipeline/run', '/api/mystery-shopper/run', '/api/store-fixer/run'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Commerce',
      panel: 'CommercePanel',
      constellationNode: 'Commerce',
      description: 'Commerce Panel has 4 pipeline launchers with parameter forms, run history with expandable details showing products/grades/scores.',
    },
  },
  // ─── Media subsystems ─────────────────────────────────────────
  {
    id: 'media',
    name: 'Media Hub',
    category: 'media',
    backend: {
      module: 'server/media/',
      functions: ['processImage', 'processVideo', 'speak', 'transcribe', 'recognize'],
      endpoints: ['/api/images', '/api/video', '/api/tts', '/api/stt', '/api/ocr'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: null,
      panel: 'MediaPanel',
      constellationNode: 'Media',
      description: 'Media Panel has 5 tabs: Images (Sharp), Video (ffmpeg), TTS (3-engine), STT (2-engine), OCR. File upload + processing controls.',
    },
  },
  // ─── Core subsystems ──────────────────────────────────────────
  {
    id: 'daemon',
    name: 'Evolution Daemon',
    category: 'core',
    backend: {
      module: 'server/daemon/engine.js',
      functions: ['startDaemon', 'stopDaemon', 'getDaemonStatus', 'manualCycle'],
      endpoints: ['/api/daemon/status', '/api/daemon/start', '/api/daemon/stop', '/api/daemon/cycle'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'Intelligence Stack',
      panel: 'SettingsPanel',
      constellationNode: 'Daemon',
      description: 'Settings Panel Controls tab has daemon start/stop, cycle interval. Command Center Intelligence Stack widget shows daemon cycle count and uptime.',
    },
  },
  {
    id: 'health',
    name: 'System Health Monitor',
    category: 'core',
    backend: {
      module: 'server/health/monitor.js',
      functions: ['getHealthMetrics'],
      endpoints: ['/api/health', '/api/health/alerts'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: 'System Health',
      panel: 'HealthPanel',
      constellationNode: 'Health',
      description: 'Health Panel shows Ollama/Heap/Alerts/Bus stat cards, resource utilization bars, infrastructure grid, alert list with resolve actions.',
    },
  },
  {
    id: 'vertiso',
    name: 'Vertiso Memory',
    category: 'core',
    backend: {
      module: 'server/vertiso/memory.js',
      functions: ['store', 'recall', 'consolidate'],
      endpoints: ['/api/vertiso/store', '/api/vertiso/recall'],
    },
    frontend: {
      view: 'CommandCenter',
      widget: null,
      panel: 'VertisoPanel',
      constellationNode: 'Vertiso',
      description: 'Vertiso Panel shows memory stats, recall search, RSI evolve/reflect/genome controls.',
    },
  },
  // ─── UI-level views (meta-awareness) ──────────────────────────
  {
    id: 'command-center',
    name: 'Command Center',
    category: 'ui',
    backend: { module: null, functions: [], endpoints: ['/api/metrics', '/api/search'] },
    frontend: {
      view: 'CommandCenter',
      widget: null,
      panel: null,
      constellationNode: null,
      description: 'Main dashboard view — 14 widget grid with live metrics, intelligence status, activity stream, and CommandBar input. The user\'s primary interaction surface.',
    },
  },
  {
    id: 'constellation',
    name: 'Constellation View',
    category: 'ui',
    backend: { module: null, functions: [], endpoints: [] },
    frontend: {
      view: 'Constellation',
      widget: null,
      panel: null,
      constellationNode: null,
      description: 'Living SVG map — CHANDRA hub at center, inner ring (intelligence subsystems), outer ring (capabilities). Edges connect related nodes. Active nodes glow and pulse on WebSocket events.',
    },
  },
  {
    id: 'library',
    name: 'Library View',
    category: 'ui',
    backend: { module: null, functions: [], endpoints: [] },
    frontend: {
      view: 'Library',
      widget: null,
      panel: null,
      constellationNode: null,
      description: 'Content archive — aggregates commerce runs, workflow outputs, outlier saves, agent threads. Source filter tabs, search, expandable items.',
    },
  },
];

const SYSTEM_MAP_INDEX = new Map(SYSTEM_MAP.map(s => [s.id, s]));

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS self_model_snapshots (
      id TEXT PRIMARY KEY,
      snapshot_type TEXT NOT NULL,
      subsystem_count INTEGER,
      active_count INTEGER,
      visual_summary TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_self_model_ts ON self_model_snapshots(created_at)`).run();
  } catch (_) {}
}

ensureTable();

let snapshotCount = 0;

function collectVisualState() {
  const snapshot = { subsystems: [], activeCount: 0, ts: now() };

  for (const entry of SYSTEM_MAP) {
    const state = { id: entry.id, name: entry.name, category: entry.category };
    state.hasPanel = !!entry.frontend.panel;
    state.hasWidget = !!entry.frontend.widget;
    state.hasConstellation = !!entry.frontend.constellationNode;
    state.view = entry.frontend.view;
    state.endpointCount = entry.backend.endpoints.length;

    let active = false;
    try {
      if (entry.id === 'fleet') {
        const runs = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE created_at > ?`).get(now() - 300_000);
        active = (runs?.c || 0) > 0;
        state.recentRuns = runs?.c || 0;
      } else if (entry.id === 'bus') {
        const msgs = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(now() - 300_000);
        active = (msgs?.c || 0) > 0;
        state.recentMessages = msgs?.c || 0;
      } else if (entry.id === 'workflow') {
        const wfRuns = db.prepare(`SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ?`).get(now() - 300_000);
        active = (wfRuns?.c || 0) > 0;
        state.recentWorkflows = wfRuns?.c || 0;
      } else if (entry.id === 'health') {
        const alerts = db.prepare(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`).get();
        active = (alerts?.c || 0) > 0;
        state.unresolvedAlerts = alerts?.c || 0;
      } else if (entry.id === 'reflection') {
        const refs = db.prepare(`SELECT COUNT(*) as c FROM reflections WHERE created_at > ?`).get(now() - 1800_000);
        active = (refs?.c || 0) > 0;
        state.recentReflections = refs?.c || 0;
      } else if (entry.id === 'consciousness') {
        const audits = db.prepare(`SELECT COUNT(*) as c FROM consciousness_audits WHERE created_at > ?`).get(now() - 600_000);
        active = (audits?.c || 0) > 0;
      } else if (entry.id === 'commerce') {
        const cRuns = db.prepare(`SELECT COUNT(*) as c FROM commerce_pipeline_runs WHERE created_at > ?`).get(now() - 3600_000);
        active = (cRuns?.c || 0) > 0;
      }
    } catch (_) {}

    state.active = active;
    if (active) snapshot.activeCount++;
    snapshot.subsystems.push(state);
  }

  return snapshot;
}

export function buildSpatialContext(agentId) {
  const lines = [];
  lines.push('\n\nSpatial Awareness (where you exist in the app):');
  lines.push('You live inside the Chandra-FRAYMUS Nexus interface. The user sees you through 4 views: Command Center (dashboard), Constellation (living map), Canvas (workflow builder), Library (content archive).');

  const agentEntry = SYSTEM_MAP_INDEX.get('fleet');
  if (agentEntry) {
    lines.push(`Your fleet appears in: ${agentEntry.frontend.panel} (${agentEntry.frontend.view} view). You are rendered as a card with your avatar, role badge, and run stats. The user reaches you via the CommandBar with @${agentId || 'your-name'}.`);
  }

  lines.push('When your task runs, your status updates LIVE via WebSocket — the user sees a spinning indicator, then your result. Your output appears in the thread viewer inside your card.');
  lines.push('The system around you includes: a 256-neuron CTRNN (visible as a 3D terrain), constellation nodes that pulse when subsystems fire, and an Intelligence Stack widget showing all cognitive subsystem states.');

  const subsystemSummary = SYSTEM_MAP.filter(s => s.category === 'intelligence')
    .map(s => `${s.name} → ${s.frontend.panel || s.frontend.widget || s.frontend.view}`)
    .join('; ');
  lines.push(`Intelligence subsystems around you: ${subsystemSummary}.`);

  return lines.join('\n');
}

export function buildSubsystemContext(subsystemId) {
  const entry = SYSTEM_MAP_INDEX.get(subsystemId);
  if (!entry) return '';

  return `\n[Self-Model] ${entry.name}: backend=${entry.backend.module}, ` +
    `UI=${entry.frontend.view}/${entry.frontend.panel || entry.frontend.widget || 'none'}, ` +
    `constellation=${entry.frontend.constellationNode || 'none'}, ` +
    `endpoints=[${entry.backend.endpoints.slice(0, 3).join(', ')}]`;
}

export function getSystemMap() {
  return SYSTEM_MAP.map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    view: s.frontend.view,
    panel: s.frontend.panel,
    widget: s.frontend.widget,
    constellationNode: s.frontend.constellationNode,
    description: s.frontend.description,
    endpoints: s.backend.endpoints,
    functions: s.backend.functions,
  }));
}

export function lookupSubsystem(query) {
  const q = query.toLowerCase();
  return SYSTEM_MAP.filter(s =>
    s.id.includes(q) ||
    s.name.toLowerCase().includes(q) ||
    s.category.includes(q) ||
    (s.frontend.panel || '').toLowerCase().includes(q) ||
    (s.frontend.constellationNode || '').toLowerCase().includes(q)
  ).map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    frontend: s.frontend,
    endpoints: s.backend.endpoints,
  }));
}

let ctrnnRef = null;

export function setSelfModelCTRNN(ctrnn) {
  ctrnnRef = ctrnn;
}

function injectProprioception(visualState) {
  if (!ctrnnRef || !ctrnnRef.running) return null;

  let gateMods = { evolutionRate: 1.0, tier: 'UNKNOWN' };
  try { gateMods = getAutonomyModifiers(); } catch (_) {}

  const sensitivity = Math.max(0.2, Math.min(1.2,
    BASE_PROPRIO_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3
  ));

  const totalSubsystems = visualState.subsystems.length;
  const activeRatio = totalSubsystems > 0 ? visualState.activeCount / totalSubsystems : 0;

  const injections = [];

  // Body activity — how alive the visual body is
  const activityAmp = activeRatio * 2.0 * sensitivity;
  if (activityAmp > 0.05) {
    ctrnnRef.inject(0, 4, 2.0, activityAmp);
    injections.push({ region: 'body_activity', x: 0, y: 4, amp: +activityAmp.toFixed(3) });
  }

  // Body coherence — are subsystems with UI presence actually active?
  const uiSubsystems = visualState.subsystems.filter(s => s.hasPanel || s.hasWidget);
  const uiActive = uiSubsystems.filter(s => s.active).length;
  const coherence = uiSubsystems.length > 0 ? uiActive / uiSubsystems.length : 0;
  const coherenceAmp = coherence * 1.5 * sensitivity;
  if (coherenceAmp > 0.05) {
    ctrnnRef.inject(0, 12, 2.0, coherenceAmp);
    injections.push({ region: 'body_coherence', x: 0, y: 12, amp: +coherenceAmp.toFixed(3) });
  }

  return { injections, sensitivity, activeRatio: +activeRatio.toFixed(3), coherence: +coherence.toFixed(3), tier: gateMods.tier };
}

export function selfModelSnapshot() {
  const visualState = collectVisualState();
  const ctrnnResult = injectProprioception(visualState);

  snapshotCount++;

  if (snapshotCount % SNAPSHOT_EVERY === 0) {
    try {
      const id = randomUUID().slice(0, 12);
      db.prepare(
        `INSERT INTO self_model_snapshots (id, snapshot_type, subsystem_count, active_count, visual_summary, gate_tier, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, 'periodic',
        visualState.subsystems.length,
        visualState.activeCount,
        JSON.stringify({
          active: visualState.subsystems.filter(s => s.active).map(s => s.id),
          ctrnn: ctrnnResult,
        }),
        ctrnnResult?.tier || 'UNKNOWN',
        ctrnnResult?.sensitivity || BASE_PROPRIO_SENSITIVITY,
        now()
      );
    } catch (_) {}

    // prune >7 days
    try {
      db.prepare(`DELETE FROM self_model_snapshots WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  publish('self-model', 'system.self-model.snapshot', JSON.stringify({
    activeCount: visualState.activeCount,
    totalSubsystems: visualState.subsystems.length,
    ctrnn: ctrnnResult,
    tick: snapshotCount,
  }));

  return { visualState, ctrnnResult, tick: snapshotCount };
}

export function getSelfModelStatus() {
  const visualState = collectVisualState();
  let gateMods = { tier: 'UNKNOWN', evolutionRate: 1.0 };
  try { gateMods = getAutonomyModifiers(); } catch (_) {}

  return {
    subsystemCount: SYSTEM_MAP.length,
    activeCount: visualState.activeCount,
    categories: {
      intelligence: SYSTEM_MAP.filter(s => s.category === 'intelligence').length,
      fleet: SYSTEM_MAP.filter(s => s.category === 'fleet').length,
      workflow: SYSTEM_MAP.filter(s => s.category === 'workflow').length,
      commerce: SYSTEM_MAP.filter(s => s.category === 'commerce').length,
      media: SYSTEM_MAP.filter(s => s.category === 'media').length,
      core: SYSTEM_MAP.filter(s => s.category === 'core').length,
      ui: SYSTEM_MAP.filter(s => s.category === 'ui').length,
    },
    subsystems: visualState.subsystems,
    snapshotCount,
    gateTier: gateMods.tier,
    sensitivity: Math.max(0.2, Math.min(1.2,
      BASE_PROPRIO_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3
    )),
  };
}

export function getSelfModelHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM self_model_snapshots ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function resetSelfModel() {
  snapshotCount = 0;
  ctrnnRef = null;
}

export function installSelfModelRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/self-model', route((_req, res) => {
    res.json(getSelfModelStatus());
  }));

  app.get('/api/intelligence/self-model/map', route((_req, res) => {
    res.json({ subsystems: getSystemMap() });
  }));

  app.get('/api/intelligence/self-model/lookup', route((req, res) => {
    const query = req.query.q || '';
    if (!query) return res.status(400).json({ error: 'Query param q required' });
    res.json({ results: lookupSubsystem(query) });
  }));

  app.get('/api/intelligence/self-model/spatial', route((req, res) => {
    const agentId = req.query.agent || 'system';
    res.json({ context: buildSpatialContext(agentId) });
  }));

  app.get('/api/intelligence/self-model/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ snapshots: getSelfModelHistory({ limit }) });
  }));

  app.post('/api/intelligence/self-model/snapshot', route(async (_req, res) => {
    const result = selfModelSnapshot();
    res.json({ ok: true, activeCount: result.visualState.activeCount, ctrnn: result.ctrnnResult });
  }));
}
