/**
 * Distill service — writes the training set from distill-data.js to data/distill/<date>/ and serves its manifest.
 *
 *   train.jsonl     records to train on: {"messages": [...]} per line (the shape Unsloth / TRL chat templates read)
 *   heldout.jsonl   the fixed held-out share, for measuring the adapter; never uploaded for training
 *   manifest.json   counts per source, what was excluded and why, sha256 of both files
 *
 * Routes: GET /api/intelligence/distill (latest manifest), POST /api/intelligence/distill/export (writes a new set).
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { DATA_DIR } from '../config.js';
import { createDistiller } from './distill-data.js';
import { normalizeFor, scriptMessagesFor } from '../media/make-looks.js';

const DISTILL_DIR = join(DATA_DIR, 'distill');
const sha = s => createHash('sha256').update(s).digest('hex');

export function exportDistillSet() {
  const { records, bySource, excluded } = createDistiller({ db, creationsDir: join(DATA_DIR, 'creations'), normalizeFor, scriptMessagesFor }).collect();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = join(DISTILL_DIR, stamp);
  mkdirSync(dir, { recursive: true });
  const line = r => JSON.stringify({ messages: r.messages, source: r.source, id: r.id });
  const train = records.filter(r => !r.heldOut).map(line).join('\n') + '\n';
  const held = records.filter(r => r.heldOut).map(line).join('\n') + '\n';
  writeFileSync(join(dir, 'train.jsonl'), train);
  writeFileSync(join(dir, 'heldout.jsonl'), held);
  const manifest = {
    madeAt: new Date().toISOString(), dir, bySource, excluded,
    train: { records: records.filter(r => !r.heldOut).length, sha256: sha(train), bytes: Buffer.byteLength(train) },
    heldout: { records: records.filter(r => r.heldOut).length, sha256: sha(held), bytes: Buffer.byteLength(held) },
    note: 'Upload only train.jsonl to Colab. heldout.jsonl stays here: the adapter is measured on it.',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function latestDistillManifest() {
  if (!existsSync(DISTILL_DIR)) return null;
  const last = readdirSync(DISTILL_DIR).filter(d => existsSync(join(DISTILL_DIR, d, 'manifest.json'))).sort().pop();
  return last ? JSON.parse(readFileSync(join(DISTILL_DIR, last, 'manifest.json'), 'utf8')) : null;
}

export function installDistillRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/distill', route((req, res) => res.json({ latest: latestDistillManifest() })));
  app.post('/api/intelligence/distill/export', route((req, res) => res.json(exportDistillSet())));
}
