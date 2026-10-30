# Phase 36 — System Settings Panel

| Field | Value |
|-------|-------|
| **Phase** | 36 |
| **Title** | System Settings Panel |
| **Status** | Complete |
| **Prev** | [Phase 35 — Agent Forge + Synthesis Panel](PHASE-35.md) |
| **Next** | Phase 37 (TBD) |

## Summary

Adds a full system configuration dashboard with 4 tabs: General (server stats + active model + config), Models (40 Ollama models with one-click switching), Controls (autonomy/daemon/reflection start/stop toggles), and Diagnostics (Node.js/Ollama/SQLite health checks). Includes a new server-side settings module with SQLite-backed persistent configuration.

## Architecture

```
server/settings.js (NEW — settings store + routes)
  ├─ GET  /api/settings            → current settings + server info + memory usage
  ├─ PUT  /api/settings            → update settings (model, reflect config)
  ├─ GET  /api/settings/models     → proxied Ollama model list with metadata
  └─ GET  /api/settings/diagnostics → system health checks (Ollama, SQLite, Node)

SettingsPanel.jsx (4-tab interface)
  ├─ General Tab       → /api/settings (server stats, model, config)
  ├─ Models Tab        → /api/settings/models (40 models, one-click switch)
  ├─ Controls Tab      → /api/fraymus/autonomy/* + /api/daemon/* (start/stop/sync)
  └─ Diagnostics Tab   → /api/settings/diagnostics (Ollama + DB health checks)

DetailDrawer.jsx  → panel registry: 'settings' → SettingsPanel (15 panels total)
CommandCenter.jsx → widget grid: 'Settings' (16 widgets total)
runtime.js        → feature flag: 'system-settings-panel' (48 features total)
```

## Files Changed

| File | Change |
|------|--------|
| `server/settings.js` | **NEW** — Settings store with SQLite `kv` table, 4 REST endpoints |
| `client/src/panels/SettingsPanel.jsx` | **NEW** — 4-tab settings panel (General, Models, Controls, Diagnostics) |
| `client/src/nexus/DetailDrawer.jsx` | Import + register SettingsPanel as 'settings' panel (15th panel) |
| `client/src/nexus/CommandCenter.jsx` | Add 'Settings' widget (16th widget) with slate color |
| `server/runtime.js` | Import + install settings routes, add feature flag (48th feature) |

## Tab Details

### General Tab
- Server address + port, uptime, PID
- Process memory: heap used, heap total, RSS
- Active Ollama model name + URL
- Configuration: auto-reflect toggle status, reflect interval

### Models Tab
- Active model with amber highlight card
- Scrollable list of all 40 Ollama models
- Per-model details: parameter size, family, size on disk, quantization level
- One-click "Use" button to switch active model (persisted to SQLite)
- Active model highlighted with green border + "ACTIVE" badge

### Controls Tab
- **Autonomy Engine**: Kuramoto sync + intelligence loop start/stop, force sync button
- **Evolution Daemon**: Background dream + prompt evolution start/stop, manual cycle button
- **Reflection Loop**: Trigger reflection button

### Diagnostics Tab
- Node.js version, platform/arch
- Uptime, DB journal mode
- Ollama connectivity: green/red dot + model count
- SQLite connectivity: green/red dot + journal mode
- Refresh diagnostics button

## Design Decisions

1. **SQLite `kv` table** — lightweight key-value store for settings persistence. Simple INSERT OR REPLACE avoids schema changes. Only settings that need to survive restarts go here.
2. **Ollama model proxy** — `/api/settings/models` proxies Ollama's `/api/tags` rather than having the client call Ollama directly. Keeps the loopback enforcement consistent and adds metadata extraction.
3. **Controls use existing APIs** — rather than duplicating autonomy/daemon logic, the Controls tab calls the existing `/api/fraymus/autonomy/*` and `/api/daemon/*` endpoints.
4. **Slate gray for settings widget** — intentionally muted (#64748b) so it doesn't compete with feature-specific colors in the Command Center grid.

## Counts After Phase 36

| Metric | Count |
|--------|-------|
| Features | 48 |
| Detail Drawer panels | 15 |
| Command Center widgets | 16 |
| REST endpoints | ~195+ |
| Agent manifests | 17 (+ forged) |
| Media engines | 5 |
| Workflow node types | 47 |
| Fleet tools | 54 |
| Phases complete | 36 |
| Components with ErrorBoundary | 19 (4 views + 15 panels) |
