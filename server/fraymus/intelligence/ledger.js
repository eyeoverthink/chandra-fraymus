// Ledger Module — Cognitive Event Ledger by Vaughn Scott (EyeOverThink®)
// Ported from fraynix-dreamer-120b's CognitiveEventLedger concept into Chandra.
// Append-only JSONL audit trail of every state transition in the intelligence stack.

import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per ledger file before rotation

export class Ledger {
  constructor(entityStore, dataDir) {
    this.store = entityStore;
    this.dir = dataDir || join(process.cwd(), 'data', 'ledger');
    this.sequence = 0;
    this.prevHash = '0'.repeat(64);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this._recoverSequence();
  }

  _currentFile() {
    return join(this.dir, 'events.jsonl');
  }

  _rotatedFile(n) {
    return join(this.dir, `events.${n}.jsonl`);
  }

  _recoverSequence() {
    const file = this._currentFile();
    if (!existsSync(file)) return;
    try {
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]);
        this.sequence = (last.seq || 0) + 1;
        this.prevHash = last.hash || this.prevHash;
      }
    } catch (_) {}
  }

  _rotateIfNeeded() {
    const file = this._currentFile();
    if (!existsSync(file)) return;
    try {
      const stat = statSync(file);
      if (stat.size < MAX_FILE_SIZE) return;
      let n = 1;
      while (existsSync(this._rotatedFile(n))) n++;
      const { renameSync } = require('fs');
      renameSync(file, this._rotatedFile(n));
    } catch (_) {}
  }

  record(kind, data, source = 'system') {
    const seq = this.sequence++;
    const ts = new Date().toISOString();

    const entry = { seq, ts, kind, source, data };
    const payload = JSON.stringify(entry);
    const hash = createHash('sha256').update(this.prevHash + payload).digest('hex');
    entry.hash = hash;
    entry.prev = this.prevHash;
    this.prevHash = hash;

    this._rotateIfNeeded();
    appendFileSync(this._currentFile(), JSON.stringify(entry) + '\n');

    if (this.store) {
      try {
        this.store.LedgerEvents.create({
          seq,
          at: ts,
          kind,
          source,
          hash,
          summary: typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200),
        });
      } catch (_) {}
    }

    return { seq, hash };
  }

  verify(limit = 100) {
    const file = this._currentFile();
    if (!existsSync(file)) return { valid: true, checked: 0 };
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const toCheck = lines.slice(-limit);
    let prev = toCheck.length < lines.length
      ? JSON.parse(lines[lines.length - toCheck.length - 1]).hash
      : '0'.repeat(64);

    for (let i = 0; i < toCheck.length; i++) {
      const entry = JSON.parse(toCheck[i]);
      const { hash, prev: storedPrev, ...rest } = entry;
      if (storedPrev !== prev) return { valid: false, brokenAt: entry.seq, reason: 'prev mismatch' };
      const payload = JSON.stringify(rest);
      const expected = createHash('sha256').update(prev + payload).digest('hex');
      if (hash !== expected) return { valid: false, brokenAt: entry.seq, reason: 'hash mismatch' };
      prev = hash;
    }
    return { valid: true, checked: toCheck.length };
  }

  recent(limit = 20) {
    const file = this._currentFile();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  }

  countByKind() {
    const file = this._currentFile();
    if (!existsSync(file)) return {};
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const counts = {};
    for (const l of lines) {
      try {
        const { kind } = JSON.parse(l);
        counts[kind] = (counts[kind] || 0) + 1;
      } catch (_) {}
    }
    return counts;
  }
}
