import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db, logEvent } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(here, 'fleet-snapshot.json');
const BRIEFING_SUBJECT = 'fleet snapshot · 2026-10-11 17:39 PDT';

export function ingestFleetSnapshot() {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  const now = Date.now();
  const observedAt = Date.parse(snap.generated_at) || 0;
  const upsert = db.prepare(`INSERT INTO agents (id, name, role, host, status, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
      host=excluded.host, status=excluded.status, last_seen=excluded.last_seen`);
  const putMem = db.prepare(`INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);

  for (const a of snap.fleet) {
    upsert.run(`fleet-${a.name.toLowerCase().replace(/\s+/g, '-')}`,
      `${a.name} (${a.archetype})`, `historical fleet·${a.archetype.toLowerCase()}`,
      'macbook-pro', 'historical', observedAt);
  }
  putMem.run('fleet.snapshot', JSON.stringify({ generated_at: snap.generated_at, agents: snap.fleet }), now);
  putMem.run('models.macbook-pro', JSON.stringify(snap.remote_models), now);
  putMem.run('flybridge.connectome', JSON.stringify(snap.flybridge_connectome), now);

  const exists = db.prepare('SELECT id FROM mail WHERE subject = ?').get(BRIEFING_SUBJECT);
  if (!exists) {
    const lines = snap.fleet.map(a =>
      `${a.name} [${a.fx_id}] tick ${a.tick} · ${a.nodes} nodes · E=${a.avg_energy} · ${a.state}`).join('\n');
    const c = snap.flybridge_connectome;
    const body = `EYEOVERTHINK fleet snapshot (eyekaughn workspace)\n\n` +
      `${lines}\n\nworld.json untouched ~${snap.fleet[0].world_age_min}m — fleet not being ticked.\n\n` +
      `FlyBridge connectome (${c.engine}): train 11 100% · held 8 100% · novel 10 100% · blind 20 85% (chance ${c.chance})\n` +
      `blind misses:\n${c.blind_misses.map(m => '  ' + m).join('\n')}\n\n` +
      `${snap.remote_models.length} models registered on macbook-pro.`;
    db.prepare('INSERT INTO mail (from_agent, to_agent, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('fleet-bridge', 'main', BRIEFING_SUBJECT, body, 'unread', now);
    logEvent('fleet.ingest', 'fleet-bridge', `snapshot ingested · ${snap.fleet.length} agents · ${snap.remote_models.length} remote models`);
  }
}
