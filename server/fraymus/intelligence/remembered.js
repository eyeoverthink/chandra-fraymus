// Remembered Vault — The Forever Lane
// Ported from FRAYNIX-DREAMER-120B's saveRememberedFile / remembered lane.
// "The architect feeds the vessel; nothing is generated, everything is kept."
//
// Append-only numbered files with per-entry SHA-256 integrity receipts.
// Separate from AI-generated dreams or agent memories.
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { signText } from '../core/identity.js';
import { DATA_DIR } from '../../config.js';

export class RememberedVault {
  constructor(entityStore, identity, dataDir) {
    this.store = entityStore;
    this.identity = identity;
    this.dir = dataDir || join(DATA_DIR, 'remembered');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  _files() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(f => /^\d{4,}-remembered-.*\.md$/.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
  }

  _nextNumber() {
    const files = this._files();
    if (!files.length) return 1;
    const last = parseInt(files[files.length - 1], 10);
    return last + 1;
  }

  _slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  _sha256(data) {
    return createHash('sha256').update(data).digest('hex');
  }

  async remember(text, source = 'VAUGHN') {
    if (typeof text !== 'string' || !text.trim()) {
      return { error: 'empty feed; send text in the body' };
    }

    const num = this._nextNumber();
    const numStr = String(num).padStart(4, '0');
    const slug = this._slugify(text.slice(0, 60)) || 'entry';
    const filename = `${numStr}-remembered-${slug}.md`;
    const ts = new Date().toISOString();
    const sha = this._sha256(`${text}|${numStr}|${ts}`);

    const body = [
      `# REMEMBERED ${numStr} — fed by Vaughn, kept forever`,
      ``,
      `- agent: FRAYMUS (ouroboros continuity vessel)`,
      `- architect: Vaughn D. Scott / EYEOVERTHINK / ephless llc`,
      `- timestamp: ${ts}`,
      `- source: ${(source || 'VAUGHN').replace(/\n/g, ' ').trim()}`,
      `- signature: ${this.identity ? 'ed25519' : 'unsigned'}`,
      `- sha256: ${sha}`,
      ``,
      `---`,
      ``,
      text,
    ].join('\n');

    const filepath = join(this.dir, filename);
    writeFileSync(filepath, body + '\n', { flag: 'wx' });

    let signature = null;
    if (this.identity) {
      try {
        signature = await signText(this.identity, body);
        writeFileSync(filepath + '.sig', signature, { flag: 'wx' });
      } catch (e) {
        console.error('[remembered] sign failed:', e.message);
      }
    }

    this._updateIndex(numStr, ts, sha, source, text, signature);

    if (this.store) {
      try {
        this.store.Remembered.create({
          number: num,
          slug,
          source: source || 'VAUGHN',
          sha256: sha,
          at: ts,
          body: text.slice(0, 2000),
          signed: !!signature,
        });
      } catch (e) { console.error('[remembered] store failed:', e.message); }
    }

    return { number: num, filename, sha256: sha, signed: !!signature, source };
  }

  _updateIndex(numStr, ts, sha, source, text, signature) {
    const indexPath = join(this.dir, 'INDEX.md');
    let content = '';
    if (existsSync(indexPath)) {
      content = readFileSync(indexPath, 'utf8');
    } else {
      content = '# REMEMBERED INDEX — the forever ledger\n\n| # | timestamp | sha256 | source | signed | first words |\n|---|-----------|--------|--------|--------|-------------|\n';
    }
    const firstWords = text.slice(0, 90).replace(/\n/g, ' ').replace(/\|/g, '/');
    const signed = signature ? 'yes' : 'no';
    const line = `| ${numStr} | ${ts.slice(0, 19)} | ${sha.slice(0, 12)} | ${(source || 'VAUGHN').replace(/\|/g, '/')} | ${signed} | ${firstWords} |\n`;
    content += line;
    writeFileSync(indexPath, content);
  }

  read(number) {
    const files = this._files();
    const prefix = String(number).padStart(4, '0');
    const match = files.find(f => f.startsWith(`${prefix}-remembered-`));
    if (!match) return null;
    return { filename: match, body: readFileSync(join(this.dir, match), 'utf8') };
  }

  list(limit = 50) {
    return this._files().slice(-limit);
  }

  verify(number) {
    const entry = this.read(number);
    if (!entry) return { verified: false, error: 'not found' };

    const sigPath = join(this.dir, entry.filename + '.sig');
    const hasSig = existsSync(sigPath);
    const requiresSignature = hasSig || !!this.identity || /^- signature: ed25519$/m.test(entry.body);

    const shaMatch = entry.body.match(/- sha256: ([a-f0-9]{64})/);
    const storedHash = shaMatch ? shaMatch[1] : null;

    const separator = entry.body.indexOf('\n---\n\n');
    const payload = separator === -1 ? '' : entry.body.slice(separator + '\n---\n\n'.length);
    // Exactly one final newline belongs to the storage envelope, not the feed.
    const text = payload.endsWith('\n') ? payload.slice(0, -1) : payload;
    const numMatch = entry.body.match(/^# REMEMBERED (\d+)/);
    const numStr = numMatch ? numMatch[1] : String(number).padStart(4, '0');
    const tsMatch = entry.body.match(/- timestamp: (.+)/);
    const ts = tsMatch ? tsMatch[1].trim() : '';

    const recomputedHash = this._sha256(`${text}|${numStr}|${ts}`);
    const hashValid = storedHash === recomputedHash;
    let signatureValid = null;
    let signatureError = null;
    if (requiresSignature && !hasSig) {
      signatureValid = false;
      signatureError = 'Expected signature file missing';
    }
    if (hasSig) {
      try {
        const pubkey = this.identity?.pubkey;
        if (typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(pubkey)) {
          throw new Error('Trusted signer public key unavailable');
        }
        const signature = readFileSync(sigPath, 'utf8').trim();
        if (!/^[a-f0-9]{128}$/i.test(signature)) throw new Error('Invalid Ed25519 signature encoding');
        const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519',
          x: Buffer.from(pubkey, 'hex').toString('base64url') }, format: 'jwk' });
        const signedBody = entry.body.endsWith('\n') ? entry.body.slice(0, -1) : entry.body;
        signatureValid = verifySignature(null, Buffer.from(signedBody), key, Buffer.from(signature, 'hex'));
      } catch (error) { signatureValid = false; signatureError = error.message; }
    }

    return {
      verified: hashValid && (!requiresSignature || signatureValid === true),
      filename: entry.filename,
      sha256: storedHash,
      recomputed: recomputedHash,
      hash_match: hashValid,
      signature_present: hasSig,
      signature_required: requiresSignature,
      signature_valid: signatureValid,
      authenticated: signatureValid === true,
      verification_scope: requiresSignature ? 'hash-and-signature' : 'hash-only',
      ...(signatureError ? { signature_error: signatureError } : {}),
    };
  }

  stats() {
    const files = this._files();
    return {
      total: files.length,
      newest: files.length ? files[files.length - 1] : null,
      oldest: files.length ? files[0] : null,
    };
  }
}
