import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { listAgents } from '../fleet/runtime.js';

function safe(sql) {
  try { return db.prepare(sql).all(); }
  catch { return []; }
}

function safeGet(sql) {
  try { return db.prepare(sql).get(); }
  catch { return null; }
}

function safeCount(table) {
  const r = safeGet(`SELECT COUNT(*) as c FROM ${table}`);
  return r ? r.c : 0;
}

export function collectSystemSnapshot() {
  const agents = (() => { try { return listAgents('local'); } catch { return []; } })();

  const overview = {
    agentCount: agents.length,
    agentNames: agents.map(a => ({ id: a.id, name: a.name, role: a.role })),
    workflowCount: safeCount('workflows'),
    totalRuns: safeCount('runs'),
    successfulRuns: (safeGet(`SELECT COUNT(*) as c FROM runs WHERE status = 'completed'`) || { c: 0 }).c,
    failedRuns: (safeGet(`SELECT COUNT(*) as c FROM runs WHERE status = 'failed'`) || { c: 0 }).c,
    workflowRuns: safeCount('workflow_runs'),
    busMessages: safeCount('bus_messages'),
    memories: safeCount('agent_memories'),
    reflections: safeCount('reflections'),
    forgedAgents: safeCount('forged_agents'),
    synthesizedWorkflows: safeCount('synthesized_workflows'),
    healthAlerts: safeCount('health_alerts'),
    unresolvedAlerts: (safeGet(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`) || { c: 0 }).c,
    commerceRuns: safeCount('commerce_pipeline_runs'),
    apparelRuns: safeCount('apparel_pipeline_runs'),
    mysteryShopperRuns: safeCount('mystery_shopper_runs'),
    storeFixerRuns: safeCount('store_fixer_runs'),
    daemonCycles: safeCount('daemon_cycles'),
    consciousnessAudits: safeCount('consciousness_audits'),
    verificationLoops: safeCount('verification_loops'),
    dreams: safeCount('dream_files'),
  };

  const topAgents = safe(
    `SELECT m.agent_id, COUNT(*) as run_count
     FROM threads m JOIN runs r ON r.thread_id = m.id
     GROUP BY m.agent_id ORDER BY run_count DESC LIMIT 10`
  );

  const topBusTopics = safe(
    `SELECT topic, COUNT(*) as msg_count FROM bus_messages
     GROUP BY topic ORDER BY msg_count DESC LIMIT 10`
  );

  const recentWorkflows = safe(
    `SELECT name FROM workflows ORDER BY created_at DESC LIMIT 20`
  );

  const nodeTypes = [
    { category: 'Core', count: 4, examples: ['LLM Chat', 'Code Sandbox', 'Web Search', 'HTML Preview'] },
    { category: 'Agents', count: 4, examples: ['Agent Run'] },
    { category: 'Media', count: 3, examples: ['Image Process', 'Video Process', 'TTS'] },
    { category: 'Intelligence', count: 17, examples: ['Heart Feel', 'Dream', 'Consciousness Prove', 'Cognition', 'Memory Recall'] },
    { category: 'FRAYMUS', count: 3, examples: ['Carbon Encode', 'Carbon Plasmid', 'Carbon Checkpoint'] },
    { category: 'Commerce', count: 16, examples: ['Content Pipeline', 'Apparel Pipeline', 'Mystery Shopper'] },
    { category: 'Distribution', count: 4, examples: ['YouTube', 'TikTok', 'Instagram'] },
    { category: 'Cross-Tab Intelligence', count: 3, examples: ['Cross-Tab Sync'] },
    { category: 'Content Nexus', count: 3, examples: ['Content Aggregate'] },
  ];
  const totalNodeTypes = nodeTypes.reduce((s, c) => s + c.count, 0);

  return { overview, topAgents, topBusTopics, recentWorkflows, nodeTypes, totalNodeTypes, timestamp: new Date().toISOString() };
}

function generateOverview(snap) {
  const o = snap.overview;
  const successRate = o.totalRuns > 0 ? ((o.successfulRuns / o.totalRuns) * 100).toFixed(1) : 'N/A';

  return `# Chandra-FRAYMUS System Overview

**Generated:** ${snap.timestamp}
**Source:** Live system snapshot via \`POST /api/workspace/generate\`

---

## What Is Chandra-FRAYMUS?

Autonomous AI agent workspace with a full intelligence stack.

- **Express server** (port 8787) + SQLite (WAL mode) + WebSocket broadcast
- **Vite React frontend** (port 5173) with 4-view Nexus interface
- **${o.agentCount} specialist agents** (18 default + ${o.forgedAgents} forged)
- **${o.workflowCount} visual workflows** with ${snap.totalNodeTypes} node types across ${snap.nodeTypes.length} categories
- **4 commerce pipelines** (Content-to-Commerce, Apparel, Mystery Shopper, Store Fixer)
- **5 media engines** (Images/Sharp, Video/ffmpeg, TTS/Piper+edge-tts+SAPI, STT/faster-whisper, OCR/WinRT)
- **20-phase intelligence stack** with 256-neuron CTRNN neural core

## Live Stats

| Metric | Value |
|--------|-------|
| Agent Fleet | ${o.agentCount} agents |
| Total Runs | ${o.totalRuns} (${successRate}% success) |
| Workflows Defined | ${o.workflowCount} |
| Workflow Runs | ${o.workflowRuns} |
| Bus Messages | ${o.busMessages} |
| Agent Memories | ${o.memories} |
| Reflections | ${o.reflections} |
| Daemon Cycles | ${o.daemonCycles} |
| Consciousness Audits | ${o.consciousnessAudits} |
| Verification Loops | ${o.verificationLoops} |
| Forged Agents | ${o.forgedAgents} |
| Synthesized Workflows | ${o.synthesizedWorkflows} |
| Health Alerts | ${o.healthAlerts} (${o.unresolvedAlerts} unresolved) |
| Commerce Pipeline Runs | ${o.commerceRuns} |
| Apparel Pipeline Runs | ${o.apparelRuns} |
| Mystery Shopper Runs | ${o.mysteryShopperRuns} |
| Store Fixer Runs | ${o.storeFixerRuns} |

## Quick Start

\`\`\`bash
npm run dev          # Starts both server + client
npm run server       # Express only (needs .env)
npm run client       # Vite only
\`\`\`

---

**Next:** [02-NEXUS-VIEWS.md](02-NEXUS-VIEWS.md)
`;
}

function generateNexusViews(snap) {
  const o = snap.overview;
  return `# Nexus Views

4 views, each a different lens on the same system. WebSocket events flow to all simultaneously.

---

## 1. Command Center

The operational dashboard. 20+ widget grid where every subsystem reports status.

**Key widgets:**
- System Health — daemon status, fitness score
- Intelligence — Heart emotion engine mood
- Agent Fleet — ${o.agentCount} agents
- Workflows — ${o.workflowCount} defined
- Commerce — 4 pipelines
- Memory / RSI — ${o.memories} memories
- Media Hub — 5 engines (Sharp, ffmpeg, Piper/edge-tts/SAPI, faster-whisper, WinRT OCR)
- Nerve Center — CTRNN consciousness state

**CommandBar** at bottom: persistent input with \`@agent\` autocomplete, \`run <pipeline>\` commands.

---

## 2. Constellation

Living SVG visualization of system topology. Nodes pulse on WebSocket events.

- **CHANDRA** breathing center hub
- **Inner ring** (intelligence): Heart, Dreamer, Cognition, Ledger, Consciousness, Memory Bridge
- **Outer ring** (capabilities): Vertiso, Browser, Workflows, Commerce, Fleet, Media
- 15 edge connections with animated dash-flow
- Click any node to open its Detail Drawer panel

---

## 3. Canvas / Workflow Builder

ReactFlow visual DAG editor. ${snap.totalNodeTypes} node types:

${snap.nodeTypes.map(c => `- **${c.category} (${c.count}):** ${c.examples.join(', ')}`).join('\n')}

Controls: Save, Run, Layout, Delete, New. Load from ${o.workflowCount} saved workflows.

---

## 4. Library

Unified content archive. Everything the system has produced.

**Filter tabs:** All, Commerce Runs, Workflow Runs, Outlier Saves, Agent Threads

---

**Next:** [03-DRAWER-PANELS.md](03-DRAWER-PANELS.md)
`;
}

function generateDrawerPanels(snap) {
  const o = snap.overview;
  return `# Detail Drawer Panels

Slide-out panel (55% viewport) when clicking any Command Center widget or Constellation node.

---

## Dashboard Panel
System overview: ${o.agentCount} agents, ${o.workflowCount} workflows, system capabilities grid.

## Intelligence Stack Panel
Interactive controls for 20-phase intelligence:
- **Heart** — Emotion Engine (7 dimensions, ~350 word lexicon)
- **Dreamer** — Ed25519 signed dream protocol
- **Ledger** — SHA-256 chained cognitive audit trail
- **Consciousness Proofs** — EI, Phi (MIP), Mirror, Counterfactual Branching
- **Memory Bridge** — Intelligence-to-Vertiso connector
- **Cognition** — Two-speed pipeline (feel → route → think)

## Agent Fleet Panel
${o.agentCount} specialist agents. Each card: name, role, tools, success rate.

## Commerce Pipelines Panel
4 AI-powered pipelines:
1. Content-to-Commerce — LLM → Shopify
2. Apparel Production — Trend → Design → Printify → Shopify
3. Mystery Shopper — Automated store audit
4. Store Fixer — Bulk Shopify fixes

## Media Hub Panel
5 engines: Images (Sharp), Video (ffmpeg), TTS (Piper/edge-tts/SAPI), STT (faster-whisper), OCR (WinRT)

## Additional Panels
Workflows, Automations, MCP, Browser, Vertiso, Outlier, Health, Forge, Settings,
Agent Chat, System Metrics, Activity Timeline, Agent Profiles, Memory Browser,
Run History, Evolution Log

---

**Next:** [04-INTELLIGENCE-STACK.md](04-INTELLIGENCE-STACK.md)
`;
}

function generateIntelligenceStack() {
  return `# The 20-Phase Intelligence Stack

Layered architecture forming a complete perception → emotion → cognition → action loop.

---

## CTRNN Neural Core
256-neuron Continuous-Time Recurrent Neural Network. Forward Euler integration with Hebbian plasticity,
synaptic pruning, autonomous neurogenesis, and biosphere perturbation.

## Phase Map

| Phase | Module | Function |
|-------|--------|----------|
| 8 | sensory-bridge | Maps telemetry to 8 CTRNN grid regions via Gaussian injection |
| 9 | emotional-feedback | Heart mood → CTRNN plasticity modulation |
| 10 | motor-output | CTRNN activation → autonomous actions |
| 11 | attention-gate | Top-down selective amplification |
| 12 | habituation | Temporal adaptation — novel signals amplify |
| 13 | working-memory | 24-frame buffer with trend detection |
| 14 | metacognitive-monitor | Effectiveness, stuck detection, confidence |
| 15 | adaptive-strategy | Metacognitive → parameter adjustments |
| 16 | (wiring) | Strategy modifiers consumed by 5 subsystems |
| 17 | self-model | System proprioception — UI spatial awareness |
| 18 | resource-envelope | Bounded intelligence — 5 resource sensors |
| 19 | predictive-processing | Forward model + EP3 cube-root surprise |
| 20 | active-inference | Prediction error → motor pre-activation |

## Consciousness Gate (Phase 4)
4-tier system based on mathematical proofs:
- **DORMANT** (0 proofs) — conservative
- **AWAKENING** (1-2 proofs) — standard
- **EMERGING** (3 proofs) — active
- **INTEGRATED** (4/4 proofs) — full autonomy

## The Loop

Sensory (5s) → Attention → Habituation → Working Memory → Predictive → Active Inference
→ Motor (15s) → Actions → Efference Copy → back to Predictive

Emotional Feedback (10s), Metacognitive (30s), Resource Envelope (10s) run in parallel.

---

**Fraynix — By Vaughn Scott**
`;
}

export function generateWorkspaceDocs(outputDir) {
  if (!outputDir) throw new Error('outputDir is required');

  mkdirSync(outputDir, { recursive: true });

  const snap = collectSystemSnapshot();

  const files = [
    { name: '01-OVERVIEW.md', content: generateOverview(snap) },
    { name: '02-NEXUS-VIEWS.md', content: generateNexusViews(snap) },
    { name: '03-DRAWER-PANELS.md', content: generateDrawerPanels(snap) },
    { name: '04-INTELLIGENCE-STACK.md', content: generateIntelligenceStack() },
  ];

  const results = [];
  for (const f of files) {
    const filePath = join(outputDir, f.name);
    writeFileSync(filePath, f.content, 'utf8');
    results.push({ file: f.name, path: filePath, size: f.content.length });
  }

  const snapshotPath = join(outputDir, 'system-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snap, null, 2), 'utf8');
  results.push({ file: 'system-snapshot.json', path: snapshotPath, size: JSON.stringify(snap, null, 2).length });

  return {
    outputDir,
    filesGenerated: results.length,
    files: results,
    snapshot: snap.overview,
    timestamp: snap.timestamp,
  };
}
