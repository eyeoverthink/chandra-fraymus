// Imports a GGUF trained by scripts/colab/chandra-lora.ipynb onto fraymus-home as an Ollama model, and changes nothing else.
//
//   node scripts/colab/import-adapter.mjs <file.gguf> --sha256 <hex> [--name qwen3-chandra:14b] [--dry-run]
//
// 1. checks the local file's sha256 against the one the notebook printed
// 2. copies it to fraymus-home D:\Models\chandra-lora\<date>\ (non-Ollama weights live there; Ollama's own store stays in
//    D:\ollama) and checks the sha256 again on arrival
// 3. writes a Modelfile that is qwen3:14b's own (template, stop tokens, parameters) with only FROM changed, and runs
//    `ollama create` — the base model, Ollama's settings and the app are untouched
// 4. a dated README in the new folder and a row in D:\Models\README.md's index (the layout rule on that machine)
// 5. one short chat to prove it loads
// --dry-run does steps that read only: ssh, ollama, free space, the Modelfile it would write.
import { createReadStream, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

const HOST = process.env.CHANDRA_HOME_SSH || 'eyeov@100.99.98.101';
const OLLAMA = process.env.CHANDRA_HOME_OLLAMA || 'http://100.99.98.101:11434';
const BASE = 'qwen3:14b';
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes('--dry-run');
const gguf = args.find(a => a.endsWith('.gguf'));
const name = flag('--name') || 'qwen3-chandra:14b';
const expected = (flag('--sha256') || '').toLowerCase();
const stamp = new Date().toISOString().slice(0, 10);
const remoteDir = `D:\\Models\\chandra-lora\\${stamp}`;

const ssh = (cmd, { input } = {}) => {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, cmd], { encoding: 'utf8', input, maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ssh failed (${r.status}): ${cmd.slice(0, 80)}\n${r.stderr}`);
  return r.stdout;
};
// The whole script travels encoded and stops on its first error. First live import (2026-11-12): a script piped on stdin
// is read line by line, so the here-strings that wrote the Modelfile and README broke, and PowerShell still exited 0.
const ps = script => ssh(`powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')}`);
// Small text files are written here and copied, so they arrive byte for byte (UTF-8, no BOM, LF) — not re-encoded by PowerShell.
const STAGE = 'F:/Claude-Work/chandra-superintelligence/memory/import-staging';
const upload = (name, text, remotePath) => {
  mkdirSync(STAGE, { recursive: true });
  const local = join(STAGE, name);
  writeFileSync(local, text);
  const r = spawnSync('scp', ['-o', 'BatchMode=yes', local, `${HOST}:${remotePath.replace(/\\/g, '/')}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`scp of ${name} failed: ${r.stderr}`);
};
const fileSha = f => new Promise((ok, no) => { const h = createHash('sha256'); createReadStream(f).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no); });

if (!dry && (!gguf || !existsSync(gguf))) { console.error('give the path of the .gguf the notebook saved (or --dry-run)'); process.exit(2); }
if (!dry && !/^[0-9a-f]{64}$/.test(expected)) { console.error('give --sha256 with the hash the notebook printed'); process.exit(2); }

console.log(`host ${HOST}; model name ${name}; folder ${remoteDir}`);
const where = ssh('where ollama').trim().split(/\r?\n/)[0];
console.log('ollama on home:', where);
const free = ps(`(Get-PSDrive D).Free`).trim();
console.log('D: free', (Number(free) / 1e9).toFixed(0), 'GB');
const base = ssh(`ollama show ${BASE} --modelfile`);
if (!/^FROM /m.test(base) || !/^TEMPLATE /m.test(base)) throw new Error(`could not read ${BASE}'s Modelfile`);
const remoteFile = `${remoteDir}\\${gguf ? basename(gguf) : 'model.gguf'}`;
const modelfile = base.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').replace(/^FROM .*$/m, `FROM ${remoteFile}`);
console.log(`Modelfile: ${BASE}'s own, FROM changed to ${remoteFile} (${modelfile.split('\n').length} lines)`);

if (dry) { console.log('\ndry run: nothing copied or created.'); process.exit(0); }

const size = statSync(gguf).size, got = await fileSha(gguf);
if (got !== expected) throw new Error(`local sha256 ${got} does not match the notebook's ${expected}`);
if (Number(free) < size * 2.2) throw new Error(`not enough room on D: for the file and Ollama's copy (${(size / 1e9).toFixed(1)} GB each)`);
console.log(`local file ok: ${(size / 1e9).toFixed(2)} GB, sha256 ${got.slice(0, 16)}…`);

ps(`New-Item -ItemType Directory -Force '${remoteDir}' | Out-Null`);
// resume: a file already there with the right size and hash is not copied again
const remoteHash = () => ps(`if (Test-Path '${remoteFile}') { if ((Get-Item '${remoteFile}').Length -eq ${size}) { (Get-FileHash -Algorithm SHA256 '${remoteFile}').Hash } else { 'partial' } } else { 'none' }`).trim().toLowerCase();
if (remoteHash() === expected) console.log('already on fraymus-home with the right sha256: not copied again');
else {
  console.log('copying (this is a large file over the tailnet)…');
  const t0 = Date.now();
  const cp = spawnSync('scp', ['-o', 'BatchMode=yes', gguf, `${HOST}:${remoteFile.replace(/\\/g, '/')}`], { stdio: 'inherit' });
  if (cp.status !== 0) throw new Error('scp failed');
  console.log(`copied in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const remoteSha = remoteHash();
  if (remoteSha !== expected) throw new Error(`file on fraymus-home has sha256 ${remoteSha}, expected ${expected}`);
  console.log('sha256 matches on arrival');
}

upload('Modelfile', `${modelfile}\n`, `${remoteDir}\\Modelfile`);
const readme = `# D:\\Models\\chandra-lora\\${stamp}

- **Created:** ${stamp}
- **What:** GGUF of qwen3:14b with Chandra's first LoRA adapter merged (trained in Colab by scripts/colab/chandra-lora.ipynb)
- **sha256:** ${expected}
- **Ollama model made from it:** ${name} (Modelfile here: qwen3:14b's own, only FROM changed)
- **Not used by the app** until measure-adapter.mjs shows it does better on the held-out set. To remove: \`ollama rm ${name}\` and delete this folder.
`;
upload('README.md', readme, `${remoteDir}\\README.md`);
ps(`$p='D:\\Models\\README.md'; $c=Get-Content -Raw $p; if ($c -notmatch 'chandra-lora') { $c=$c -replace '(\\| comfyui \\|[^\\n]*\\n)', ('$1' + '| chandra-lora | GGUFs of Chandra-trained adapters, one folder per date; each made into an Ollama model | ${stamp} |' + [char]10); $c=$c -replace '\\*\\*Last updated:\\*\\* [0-9-]+', '**Last updated:** ${stamp}'; Set-Content -Encoding utf8 -NoNewline -Path $p -Value $c }`);
console.log('README written, index row added');

console.log(`ollama create ${name} …`);
console.log(ssh(`ollama create ${name} -f "${remoteDir}\\Modelfile"`).trim().split(/\r?\n/).slice(-3).join('\n'));

const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(300_000), body: JSON.stringify({ model: name, stream: false, think: false, keep_alive: '1m', messages: [{ role: 'user', content: 'Reply with the single word: ready' }] }) });
const j = await r.json();
console.log('first reply:', JSON.stringify(j.message?.content ?? j.error).slice(0, 120));
console.log(`\ndone. ${name} exists on fraymus-home and is not used by the app. Next: node scripts/colab/measure-adapter.mjs`);
