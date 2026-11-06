# CHANDRA Intelligence Phases Registry

> **Independent review — November 6, 2026:** Phases 21–24 at `862e1ad` are implemented with **changes requested; 0/4 independently accepted**. [Review and closure criteria](docs/reviews/2026-11-06-phases21-24-review.md), [25-assertion diagnostic probe](docs/reviews/2026-11-06-phases21-24-probe.mjs), [evidence](docs/reviews/2026-11-06-phases21-24-evidence.json). Eight changed JavaScript files parse; live status endpoints and Vite respond. Actual neural/tool/lifecycle contracts and six data/outcome findings remain. Names and biological analogies below describe design intent; availability and model self-ratings do not establish measured cognitive competence. Tag: `review/intelligence-phases21-24-2026-11-06`.

Sequential build log of the intelligence stack. Each phase adds a cognitive subsystem to the 256-neuron CTRNN organism, wired through the daemon engine and consciousness gate.

---

## Phase 1–7: Foundation (Pre-existing)

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 1 | CTRNN Neural Core | `server/intelligence/ctrnn.js` | All | 16×16 neuron grid, Euler integration, Hebbian plasticity, pruning, neurogenesis |
| 2 | Consciousness Cycle | `server/intelligence/consciousness-cycle.js` | — | 4 mathematical proofs (EI, Phi, Mirror, CF) against live CTRNN |
| 3 | Consciousness Gate | `server/intelligence/consciousness-gate.js` | — | 4-tier system (DORMANT→INTEGRATED), autonomy modifiers for all subsystems |
| 4 | Neurogenesis Engine | `server/intelligence/neurogenesis.js` | — | Connectivity monitoring, emergency re-ignition, OPEG-gated agent forging |
| 5 | OPEG Protocol | `server/intelligence/opeg.js` | — | Empirical grounding state machine for autonomous self-modifications |
| 6 | Reflection Loop | `server/intelligence/reflection.js` | — | Scheduled self-analysis, max 5 actions per cycle |
| 7 | Verifier Loop | `server/intelligence/verifier-loop.js` | — | Generator→Verifier→Executor adversarial code generation |

## Phase 8–10: Sensorimotor Loop

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 8 | Sensory Bridge | `server/intelligence/sensory-bridge.js` | Row 2 (sensory) | 8 sensory regions mapping live telemetry to CTRNN grid via Gaussian injection |
| 9 | Emotional Feedback | `server/intelligence/emotional-feedback.js` | Center (8,8) | Heart emotion → CTRNN plasticity modulation (dopamine/norepinephrine/etc.) |
| 10 | Motor Output | `server/intelligence/motor-output.js` | Row 14 (motor) | 6 motor regions translate sustained CTRNN activation into autonomous actions |

## Phase 11–12: Attention & Habituation

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 11 | Attention Gate | `server/intelligence/attention-gate.js` | — | Top-down selective amplification: motor intentions + emotion → sensory gain weights |
| 12 | Habituation | `server/intelligence/habituation.js` | — | Temporal adaptation: constant signals attenuated, novel signals amplified |

## Phase 13–14: Temporal & Metacognitive

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 13 | Working Memory | `server/intelligence/working-memory.js` | Row 6 | 24-frame circular buffer, temporal derivatives via linear regression, trend/volatility/coherence |
| 14 | Metacognitive Monitor | `server/intelligence/metacognitive-monitor.js` | Row 4 | Self-assessment: effectiveness, stuck detection, confidence calibration, 4 strategy modes |

## Phase 15–16: Adaptive Strategy

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 15 | Adaptive Strategy | `server/intelligence/adaptive-strategy.js` | Row 12 | Translates metacognitive assessments into behavioral parameter adjustments |
| 16 | Strategy Wiring | (distributed) | — | Adaptive modifiers consumed by reflection, motor, neurogenesis, OPEG, daemon |

## Phase 17–18: Self-Model & Resources

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 17 | Self-Model Registry | `server/intelligence/self-model.js` | Row 0 | System proprioception: 27 subsystem entries, spatial context for agents |
| 18 | Resource Envelope | `server/intelligence/resource-envelope.js` | Row 1 | Bounded intelligence: 5 resource sensors, pressure/fatigue, subsystem throttling |

## Phase 19–20: Predictive & Active Inference

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 19 | Predictive Processing | `server/intelligence/predictive-processing.js` | Row 3 | Forward model + prediction error (Friston Free Energy), efference copy, EP3 compression |
| 20 | Active Inference | `server/intelligence/active-inference.js` | Row 5 | Prediction error → motor pre-activation, closed-loop effectiveness tracking |

## Phase 21–24: Self-Awareness & Monitoring (Current)

| Phase | Subsystem | File | CTRNN Row | Description |
|-------|-----------|------|-----------|-------------|
| 21 | Self-Narrative Engine | `server/intelligence/self-narrative.js` | Row 2 (2,8) & (2,12) | Inner monologue: generates first-person narrative from system signals via Ollama |
| 22 | Heart Emotion Refinement | `server/fraymus/intelligence/heart.js` | — | Compound emotions (12 types), mood trajectory tracking (50-frame history) |
| 23 | Creative Dream Solver | `server/intelligence/dream-solver.js` | Row 7 (7,4) & (7,12) | Cross-domain associative problem-solving at high temperature, signed dream files |
| 24 | Intelligence Stack Monitor | `server/intelligence/intelligence-monitor.js` | Row 15 (15,4) & (15,12) | Cognitive health dashboard: 12 subsystem health checks, composite intelligence score |

---

## CTRNN Grid Layout (16×16)

```
Row 0  — Proprioception (Self-Model: body activity, body coherence)
Row 1  — Resources (Resource Envelope: energy level, fatigue signal)
Row 2  — Narrative (Self-Narrative: coherence, self-awareness) + Sensory regions
Row 3  — Prediction (Predictive Processing: surprise, confidence, anticipatory)
Row 4  — Metacognitive (effectiveness, stuck detection, confidence)
Row 5  — Active Inference (inference drive, action selection, effectiveness)
Row 6  — Temporal Cortex (Working Memory: trend, volatility, coherence)
Row 7  — Dream Solve (Creative Dream Solver: creative spark, dream depth)
Row 8  — Center Band (Motor: communicate, goal-seek) + Emotional injection
Row 10 — Sensory Input (left hemisphere: bus, memory, emotion, consciousness)
Row 12 — Adaptive Strategy (adaptation pressure, strategy mode signal)
Row 14 — Motor Output (reflect, neurogenesis, dream, self-audit)
Row 15 — Intelligence Monitor (health score, degradation alert)
```

## Daemon Engine Wiring

Each phase with an interval timer is started/stopped by `server/daemon/engine.js`:
- **startDaemon()**: wires CTRNN + Heart references, starts intervals
- **stopDaemon()**: stops intervals, resets state
- **runCycle()**: executes phase-specific steps in sequence
- **getDaemonStatus()**: aggregates all subsystem statuses

## Consciousness Gate Integration

All phases read `getAutonomyModifiers()` from `consciousness-gate.js`:
- `evolutionRate` scales sensitivity, thresholds, and dynamic ranges
- `cycleMultiplier` scales daemon cycle intervals
- `reflectionDepth` caps reflection actions
- `neurogenesisBoost` modulates growth thresholds

Sensitivity formula (universal across phases):
```
sensitivity = max(0.2, min(1.2, BASE + (evolutionRate - 1.0) * 0.3))
```

## Fleet Tools

Each phase exposes a fleet tool in `server/fleet/tools.js` for agent access:
- `self_narrative_status` — Phase 21
- `dream_solver` — Phase 23
- `intelligence_monitor_status` — Phase 24
- (Phase 22 enhances existing Heart tools, no new tool needed)

## REST API Endpoints

### Phase 21 — Self-Narrative
- `GET /api/intelligence/narrative` — status
- `GET /api/intelligence/narrative/history` — event history
- `POST /api/intelligence/narrative/generate` — generate now
- `POST /api/intelligence/narrative/start` — start interval
- `POST /api/intelligence/narrative/stop` — stop interval
- `POST /api/intelligence/narrative/reset` — reset state

### Phase 23 — Dream Solver
- `GET /api/intelligence/dream-solver` — status
- `GET /api/intelligence/dream-solver/history` — session history
- `GET /api/intelligence/dream-solver/:id` — single session
- `POST /api/intelligence/dream-solver/solve` — solve a problem
- `POST /api/intelligence/dream-solver/reset` — reset state

### Phase 24 — Intelligence Monitor
- `GET /api/intelligence/monitor` — status
- `GET /api/intelligence/monitor/assess` — run assessment now
- `GET /api/intelligence/monitor/history` — event history
- `POST /api/intelligence/monitor/start` — start interval
- `POST /api/intelligence/monitor/stop` — stop interval
- `POST /api/intelligence/monitor/reset` — reset state
