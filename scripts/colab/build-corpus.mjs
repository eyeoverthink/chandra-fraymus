// Builds the corpus-knowledge training set for Chandra's model: Vaughn's own writing, from the r8 corpus manifest.
//
//   node scripts/colab/build-corpus.mjs [--manifest H:/fraymus-model/fraynix-gpt/runs/r8/manifest.tsv]
//
// Why from the manifest and not a fresh walk: every file is read from its local root and kept only if its sha256 still
// equals the manifest's, so the set is a strict, checkable subset of what FraynixGPT r8/r9 were trained on, and r8's own
// whole-file held-out split (every 12th file by hash) is kept — the adapter is measured on files it never saw.
// Left out, each with its reason in manifest.json (2026-11-12 review of the r8 corpus):
//   third_party  .venv / venv / site-packages / dist-packages / node_modules / vendor paths (24 % of r8's bytes)
//   upstream     heartmula-rig/ACE-Step-1.5 — the open-source ACE-Step project, not Vaughn's (Vaughn's answer)
//   secret       anything secret-shaped by distill-data.js secretIn (stricter than the r8 builder's pattern)
//   changed      the file on disk no longer has the manifest's sha256
//   missing      no local root holds the file
// Not added at all: the four "identity" examples build_sft_dataset.py prepends (they teach `git add -A && git push`
// of everything and [measured] tags on recalled facts — wrong for Chandra).
// Output in data/distill/corpus-<date>/: train.jsonl and heldout.jsonl ({"text": chunk} — each chunk starts with a
// "# file: <path>" line so the model ties content to where it lives; ≤ 6,000 bytes, split at line boundaries), and
// manifest.json (every file's verdict, totals, sha256 of both outputs).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretIn } from '../../server/intelligence/distill-data.js';

const args = process.argv.slice(2);
const MANIFEST = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : 'H:/fraymus-model/fraynix-gpt/runs/r8/manifest.tsv';
// each manifest prefix → candidate local roots; the sha256 decides which copy is the one r8 read
const ROOTS = {
  'hermes-memory-workspace': ['C:/Users/eyeka/migrate-from-mac/hermes-memory-workspace'],
  'FRAYNIX-DREAMER-120B': ['F:/FRAYNIX-DREAMER-120B', 'H:/fraymus-model/fraynix-dreamer-120b'],
  'fraynix-dreamer-120b': ['H:/fraymus-model/fraynix-dreamer-120b', 'F:/FRAYNIX-DREAMER-120B'],
  'fraynix-gpt': ['H:/fraymus-model/fraynix-gpt', 'F:/Claude-Work/vaughn-systems/fraynix-gpt'],
};
const THIRD_PARTY = /(^|\/)(\.venv|venv|site-packages|dist-packages|node_modules|vendor|\.git)\//;
const UPSTREAM = ['heartmula-rig/ACE-Step-1.5/'];
const CHUNK = 6000;

const sha = b => createHash('sha256').update(b).digest('hex');
const rows = readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/).map(l => { const [side, hash, bytes, path] = l.split('\t'); return { side, hash, bytes: +bytes, path }; });

function verdict(r) {
  if (THIRD_PARTY.test(r.path)) return { why: 'third_party' };
  if (UPSTREAM.some(u => r.path.includes(u))) return { why: 'upstream' };
  const [prefix, ...rest] = r.path.split('/');
  let found = false;
  for (const root of ROOTS[prefix] || []) {
    const p = join(root, ...rest);
    if (!existsSync(p)) continue;
    found = true;
    const raw = readFileSync(p);
    if (sha(raw) !== r.hash) continue;
    const text = raw.toString('utf8').replace(/\r\n/g, '\n');
    if (secretIn(text)) return { why: 'secret' };
    return { why: null, text, from: p };
  }
  return { why: found ? 'changed' : 'missing' };
}

/** A file's text as chunks of ≤ CHUNK bytes, cut at line boundaries, each headed by its path. */
function chunks(path, text) {
  const head = `# file: ${path}\n`, out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const add = `${line}\n`;
    if (Buffer.byteLength(head + cur + add) > CHUNK && cur) { out.push(head + cur); cur = ''; }
    cur += Buffer.byteLength(head + add) > CHUNK ? `${add.slice(0, CHUNK - head.length - 20)}\n` : add;
  }
  if (cur.trim()) out.push(head + cur);
  return out;
}

const kept = { train: [], heldout: [] }, files = [], tally = {};
for (const r of rows) {
  const v = verdict(r);
  files.push({ side: r.side, path: r.path, bytes: r.bytes, sha256: r.hash, kept: !v.why, why: v.why || undefined });
  tally[v.why || 'kept'] = (tally[v.why || 'kept'] || 0) + 1;
  if (!v.why) for (const c of chunks(r.path, v.text)) kept[r.side === 'heldout' ? 'heldout' : 'train'].push(c);
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'distill', `corpus-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(out, { recursive: true });
const write = (name, list) => { const body = list.map(t => JSON.stringify({ text: t })).join('\n') + '\n'; writeFileSync(join(out, name), body); return { chunks: list.length, bytes: Buffer.byteLength(list.join('')), sha256: sha(body) }; };
const summary = {
  madeAt: new Date().toISOString(), source: MANIFEST, roots: ROOTS, excludedUpstream: UPSTREAM, chunkBytes: CHUNK,
  tally, keptBytes: files.filter(f => f.kept).reduce((s, f) => s + f.bytes, 0), r8Bytes: files.reduce((s, f) => s + f.bytes, 0),
  train: write('train.jsonl', kept.train), heldout: write('heldout.jsonl', kept.heldout),
  note: 'Upload train.jsonl AND heldout.jsonl to the corpus notebook: held-out text is only scored, never trained on.',
  files,
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(summary, null, 1));
console.log(out);
console.log('files:', JSON.stringify(tally));
console.log(`kept ${(summary.keptBytes / 1e6).toFixed(2)} MB of r8's ${(summary.r8Bytes / 1e6).toFixed(2)} MB`);
console.log('train', JSON.stringify(summary.train)); console.log('heldout', JSON.stringify(summary.heldout));
