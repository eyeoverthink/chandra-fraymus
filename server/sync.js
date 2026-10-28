import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { db, logEvent } from './db.js';
import { OLLAMA_URL } from './config.js';
import { assertLocalModel } from './agent/provider.js';

export const runHostCommand = (cmd, args, timeout = 10000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ ok: !error, out: ((stdout || '') + (stderr || '')).slice(0, 24000), error: error?.message });
  });
});
export const NODE_LOG = process.env.OPENCLAW_NODE_LOG || (process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Logs', 'openclaw', 'node.log')
  : join(homedir(), '.openclaw', 'logs', 'node.log'));
export const TAILSCALE_BIN = process.env.TAILSCALE_BIN || (process.platform === 'darwin'
  ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  : process.platform === 'win32' && existsSync(join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'))
    ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe') : 'tailscale');
export async function readNodeLog(lines = 20) {
  const handle = await open(NODE_LOG, 'r');
  try {
    const info = await handle.stat();
    const size = Math.min(info.size, 64 * 1024), buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, info.size - size);
    return buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
  } finally { await handle.close(); }
}
const upsertAgent = db.prepare(`INSERT INTO agents (id,name,role,host,status,last_seen)
  VALUES (@id,@name,@role,@host,@status,@last_seen)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,
  host=excluded.host,status=excluded.status,last_seen=excluded.last_seen`);
const putMemory = db.prepare(`INSERT INTO memory (key,value,updated_at) VALUES (?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
let lastNodeState = null;
export const busyModels = new Set();
export async function syncTailscale() {
  const result = await runHostCommand(TAILSCALE_BIN, ['status', '--json']);
  if (!result.ok) return;
  let peers; try { peers = Object.values(JSON.parse(result.out).Peer || {}); } catch { return; }
  for (const peer of peers) {
    const name = peer.HostName || peer.DNSName?.replace(/\.$/, '') || peer.ID;
    if (!name) continue;
    upsertAgent.run({ id: `ts-${peer.ID || name}`, name, role: `tailnet peer · ${peer.OS || 'unknown'}`,
      host: peer.TailscaleIPs?.[0] || name, status: peer.Online ? 'online' : 'offline', last_seen: Date.now() });
  }
}
export async function syncNode() {
  const result = await runHostCommand(process.env.OPENCLAW_BIN || 'openclaw', ['node', 'status']);
  const running = result.ok && /running \(pid/.test(result.out);
  const pid = result.out.match(/pid (\d+)/)?.[1] || null, now = Date.now();
  upsertAgent.run({ id: 'tango', name: 'Tango', role: 'OpenClaw node (this computer)', host: hostname(),
    status: running ? 'online' : 'offline', last_seen: now });
  const state = running ? 'online' : 'offline';
  if (lastNodeState && lastNodeState !== state) logEvent('node.state', 'tango', `${lastNodeState} → ${state}`);
  lastNodeState = state;
  let log = null; try { log = await readNodeLog(3); } catch {}
  putMemory.run('node.gateway', JSON.stringify({ connected: log === null ? null : log.includes('gateway connected'),
    configured: result.ok, pid, logAvailable: log !== null }), now);
}
export async function syncOllama() {
  try {
    const [tagsResponse, residentResponse] = await Promise.all([
      fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(5000) }),
    ]);
    if (!tagsResponse.ok) throw new Error(`Ollama ${tagsResponse.status}`);
    const tags = await tagsResponse.json(), resident = residentResponse.ok ? await residentResponse.json() : { models: [] };
    const loaded = new Set((resident.models || []).map(model => model.name));
    for (const model of tags.models || []) {
      try { assertLocalModel(model.name, model); } catch { continue; }
      upsertAgent.run({ id: model.name, name: model.name, role: 'ollama model', host: OLLAMA_URL,
        status: busyModels.has(model.name) ? 'busy' : loaded.has(model.name) ? 'online' : 'idle', last_seen: Date.now() });
    }
    putMemory.run('ollama.loaded', JSON.stringify([...loaded]), Date.now());
    putMemory.run('ollama.health', JSON.stringify({ ok: true, endpoint: OLLAMA_URL, observedAt: Date.now() }), Date.now());
  } catch (error) {
    for (const row of db.prepare("SELECT id FROM agents WHERE role='ollama model'").all()) {
      if (!busyModels.has(row.id)) db.prepare("UPDATE agents SET status='offline' WHERE id=?").run(row.id);
    }
    putMemory.run('ollama.health', JSON.stringify({ ok: false, endpoint: OLLAMA_URL, error: error.message }), Date.now());
  }
}
export async function syncAll() { await Promise.allSettled([syncTailscale(), syncNode(), syncOllama()]); }
