import { OLLAMA_URL, HOST, PORT } from './config.js';

const SETTINGS_KEY = 'system_settings';
let db;
let currentSettings = {
  ollamaModel: 'fraynix-dreamer-ultimate:8b',
  ollamaUrl: OLLAMA_URL,
  autoReflect: true,
  reflectIntervalMin: 30,
};

function loadSettings() {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(SETTINGS_KEY);
    if (row) Object.assign(currentSettings, JSON.parse(row.value));
  } catch {}
}

function saveSettings() {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(currentSettings));
}

export function getSettings() { return { ...currentSettings }; }
export function getActiveModel() { return currentSettings.ollamaModel; }

export function installSettingsRoutes(app, database) {
  db = database;
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  loadSettings();

  app.get('/api/settings', (_req, res) => {
    res.json({
      ...currentSettings,
      server: { host: HOST, port: PORT, ollamaUrl: OLLAMA_URL, uptime: process.uptime(), pid: process.pid },
      memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, heapTotal: process.memoryUsage().heapTotal },
    });
  });

  app.put('/api/settings', (req, res) => {
    const allowed = ['ollamaModel', 'autoReflect', 'reflectIntervalMin'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    Object.assign(currentSettings, updates);
    saveSettings();
    res.json({ ok: true, settings: getSettings() });
  });

  app.get('/api/settings/models', async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await r.json();
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
        family: m.details?.family,
        paramSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
      }));
      res.json({ models, active: currentSettings.ollamaModel });
    } catch (e) {
      res.json({ models: [], active: currentSettings.ollamaModel, error: e.message });
    }
  });

  app.get('/api/settings/diagnostics', async (_req, res) => {
    const diag = { ollama: false, db: false, timestamp: Date.now() };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      diag.ollama = r.ok;
      const d = await r.json();
      diag.ollamaModels = d.models?.length || 0;
    } catch {}
    try {
      db.prepare('SELECT 1').get();
      diag.db = true;
      const walMode = db.prepare('PRAGMA journal_mode').get();
      diag.dbMode = walMode?.journal_mode;
    } catch {}
    diag.nodeVersion = process.version;
    diag.platform = process.platform;
    diag.arch = process.arch;
    diag.uptime = process.uptime();
    res.json(diag);
  });
}
