// Dreamer Module — Dream Protocol by Vaughn Scott (EyeOverThink®)
// Merges fraynix-dreamer-120b's progressive dream files + Ed25519 signatures
// with fraynix-continuity's dream consolidation + imagination engine.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { signText } from '../core/identity.js';

export class Dreamer {
  constructor(entityStore, identity, dataDir) {
    this.store = entityStore;
    this.identity = identity;
    this.dir = dataDir || join(process.cwd(), 'data', 'dreams');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  _dreamFiles() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(f => /^\d{4}-dreamer-.*\.md$/.test(f))
      .sort();
  }

  _nextNumber() {
    const files = this._dreamFiles();
    if (!files.length) return 1;
    const last = parseInt(files[files.length - 1].slice(0, 4), 10);
    return last + 1;
  }

  _slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  async dream(seed, inputs = [], kind = 'consolidation') {
    const num = this._nextNumber();
    const slug = this._slugify(seed.slice(0, 60));
    const filename = `${String(num).padStart(4, '0')}-dreamer-${slug}.md`;
    const ts = new Date().toISOString();

    const body = [
      `# Dream ${num}: ${seed}`,
      ``,
      `**Kind:** ${kind}`,
      `**Dreamed:** ${ts}`,
      `**Inputs:** ${inputs.length ? inputs.join(', ') : 'spontaneous'}`,
      ``,
      `---`,
      ``,
      seed,
      ``,
      `---`,
      `*Signed by FRAYMUS Dreamer identity*`,
    ].join('\n');

    const filepath = join(this.dir, filename);
    writeFileSync(filepath, body);

    let signature = null;
    if (this.identity) {
      try {
        signature = await signText(this.identity, body);
        writeFileSync(filepath + '.sig', signature);
      } catch (e) {
        console.error('[dreamer] sign failed:', e.message);
      }
    }

    this._updateIndex(num, slug, ts, kind, signature);

    if (this.store) {
      try {
        this.store.Dreams.create({
          number: num,
          slug,
          kind,
          at: ts,
          body: seed.slice(0, 500),
          inputs: JSON.stringify(inputs),
          signed: !!signature,
        });
      } catch (e) { console.error('[dreamer] store failed:', e.message); }
    }

    return { number: num, filename, kind, signed: !!signature };
  }

  _updateIndex(num, slug, ts, kind, signature) {
    const indexPath = join(this.dir, 'INDEX.md');
    let content = '';
    if (existsSync(indexPath)) {
      content = readFileSync(indexPath, 'utf8');
    } else {
      content = '# Dream Index\n\n| # | Slug | Kind | Date | Signed |\n|---|------|------|------|--------|\n';
    }
    const signed = signature ? 'yes' : 'no';
    const line = `| ${num} | ${slug} | ${kind} | ${ts.slice(0, 10)} | ${signed} |\n`;
    content += line;
    writeFileSync(indexPath, content);
  }

  async consolidate(learnings = []) {
    if (!learnings.length && this.store) {
      try {
        const { items } = this.store.Dreams.filter({}, { limit: 50 });
        learnings = items.map(d => d.body).filter(Boolean);
      } catch (_) {}
    }
    if (!learnings.length) return { dream: null, reason: 'nothing to consolidate' };

    const themes = this._findThemes(learnings);
    if (!themes.length) return { dream: null, reason: 'no recurring themes' };

    const seed = `Consolidation dream: recurring themes found — ${themes.join(', ')}. ` +
      `From ${learnings.length} inputs, the mind sees patterns in: ${themes.slice(0, 3).join(' and ')}.`;

    return this.dream(seed, themes, 'consolidation');
  }

  async imagine(seed, count = 3) {
    const results = [];
    const held = [];

    if (this.store) {
      try {
        const { items } = this.store.Dreams.filter({}, { limit: 20 });
        held.push(...items.map(d => d.body).filter(Boolean));
      } catch (_) {}
    }

    for (let i = 0; i < count; i++) {
      const fragments = [];
      if (held.length) {
        const pick = held[Math.floor(Math.random() * held.length)];
        const words = pick.split(/\s+/);
        const start = Math.floor(Math.random() * Math.max(1, words.length - 5));
        fragments.push(words.slice(start, start + 5).join(' '));
      }
      fragments.push(seed);

      const imagined = `[imagined] ${fragments.join(' ↔ ')} — recombination ${i + 1} of ${count}`;
      const result = await this.dream(imagined, [seed], 'imagination');
      results.push(result);
    }
    return results;
  }

  feel() {
    const files = this._dreamFiles();
    const dreamCount = files.length;
    let recentKinds = {};

    if (this.store) {
      try {
        const { items } = this.store.Dreams.filter({}, { limit: 10 });
        for (const d of items) recentKinds[d.kind] = (recentKinds[d.kind] || 0) + 1;
      } catch (_) {}
    }

    const consolidations = recentKinds.consolidation || 0;
    const imaginations = recentKinds.imagination || 0;
    const spontaneous = recentKinds.spontaneous || 0;

    let state = 'neutral';
    let score = 0.5;
    const signals = [];

    if (dreamCount === 0) {
      state = 'empty';
      score = 0.1;
      signals.push('no dreams yet');
    } else if (dreamCount < 5) {
      state = 'nascent';
      score = 0.3;
      signals.push(`only ${dreamCount} dreams`);
    } else {
      if (consolidations > imaginations) {
        state = 'reflective';
        score = 0.7;
        signals.push('more consolidation than imagination');
      } else if (imaginations > consolidations) {
        state = 'creative';
        score = 0.8;
        signals.push('imagination dominant');
      } else {
        state = 'balanced';
        score = 0.6;
        signals.push('equal consolidation and imagination');
      }
    }

    if (dreamCount > 20) {
      score = Math.min(1, score + 0.1);
      signals.push('rich dream archive');
    }

    return { state, score, signals, dreamCount, recentKinds };
  }

  _findThemes(texts) {
    const freq = {};
    const stop = new Set('the a an and or but is was were be been being to of in on at for with about as it this that'.split(' '));

    for (const text of texts) {
      const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
      const seen = new Set();
      for (const w of words) {
        if (!seen.has(w)) { seen.add(w); freq[w] = (freq[w] || 0) + 1; }
      }
    }

    return Object.entries(freq)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([w]) => w);
  }

  readDream(number) {
    const files = this._dreamFiles();
    const prefix = String(number).padStart(4, '0');
    const match = files.find(f => f.startsWith(prefix));
    if (!match) return null;
    return { filename: match, body: readFileSync(join(this.dir, match), 'utf8') };
  }

  list(limit = 20) {
    return this._dreamFiles().slice(-limit);
  }
}
