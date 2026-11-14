/**
 * An offline Wikipedia for fact grounding: a Kiwix ZIM file read by scripts/offline-wiki.py through `libzim`
 * (openZIM's own binding, from PyPI). No kiwix-serve and no network.
 *
 * Configured by OFFLINE_WIKI_ZIM (path to the .zim) and OFFLINE_WIKI_PYTHON (a Python that has libzim — the vault's
 * tools/zim-env). With either missing the source reports itself unavailable and grounding works as before.
 * The vault (F:/Claude-Work/offline-vault) holds the English Wikipedia with pictures, the reader's wheel and that env.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'offline-wiki.py');
const clip = (s, n) => String(s ?? '').slice(0, n);

/**
 * Local: OFFLINE_WIKI_ZIM + OFFLINE_WIKI_PYTHON on this machine. Remote (when this machine has no copy):
 * OFFLINE_WIKI_SSH=user@host plus OFFLINE_WIKI_REMOTE_ZIM / _PYTHON / _SCRIPT — the same reader runs there over SSH
 * (the hub already reaches fraymus-home that way); a lookup moves a few KB, not the 119 GB file. Local wins when both
 * are ready. Remote paths cannot be checked from here: a wrong one shows up as an error on the first lookup.
 */
export function offlineWikiConfig(env = process.env) {
  const zim = env.OFFLINE_WIKI_ZIM || '', python = env.OFFLINE_WIKI_PYTHON || '';
  const problems = [];
  if (!zim) problems.push('OFFLINE_WIKI_ZIM is not set');
  else if (!existsSync(zim)) problems.push(`no ZIM at ${zim}`);
  if (!python) problems.push('OFFLINE_WIKI_PYTHON is not set');
  else if (!existsSync(python)) problems.push(`no Python at ${python}`);
  if (!problems.length) return { zim, python, ready: true, problems, name: basename(zim, '.zim'), where: 'local' };
  const ssh = env.OFFLINE_WIKI_SSH || '', rz = env.OFFLINE_WIKI_REMOTE_ZIM || '', rp = env.OFFLINE_WIKI_REMOTE_PYTHON || '', rs = env.OFFLINE_WIKI_REMOTE_SCRIPT || '';
  if (ssh && /^[\w.-]+@[\w.:-]+$/.test(ssh) && rz && rp && rs) return { zim: rz, python: rp, script: rs, ssh, ready: true, problems: [], localProblems: problems, name: basename(rz.replace(/\\/g, '/'), '.zim'), where: `ssh ${ssh}` };
  return { zim, python, ready: false, problems, name: zim ? basename(zim, '.zim') : null, where: null };
}

// A Windows remote shell (cmd) gets each argument double-quoted. Inside quotes cmd still expands %VAR% and a stray quote
// would end the argument, so every character cmd treats specially is removed — the reader's arguments are config paths
// and a search phrase, neither of which needs them.
export const remoteArg = s => `"${String(s).replace(/["%^&|<>!\r\n\t`]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
const q = remoteArg;
function run(cfg, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const p = cfg.ssh
      ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', cfg.ssh, [cfg.python, '-I', cfg.script, cfg.zim, ...args].map(q).join(' ')], { windowsHide: true })
      : spawn(cfg.python, ['-I', SCRIPT, cfg.zim, ...args], { windowsHide: true });
    const out = [], err = [];
    const timer = setTimeout(() => { p.kill(); reject(new Error(`the offline wiki took over ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(clip(Buffer.concat(err).toString().trim(), 300) || `exit ${code}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8').trim().split('\n').pop())); } catch (e) { reject(new Error(`unreadable answer: ${e.message}`)); }
    });
  });
}

/** A grounding source with the same shape as the online one: search → [{title, key}], intro(key) → text. */
export function offlineWikiSource(cfg = offlineWikiConfig()) {
  return {
    name: `Wikipedia (offline copy ${cfg.name}${cfg.ssh ? ` on ${cfg.ssh.split('@')[1]}` : ''})`,
    ready: cfg.ready,
    async search(subject) { return (await run(cfg, ['search', subject, '6'])).map(h => ({ title: h.title, key: h.path })); },
    async intro(key) { return (await run(cfg, ['intro', key])).text || ''; },
    url: key => `zim://${cfg.name}/${encodeURI(key)}`,
  };
}

export async function offlineWikiInfo(cfg = offlineWikiConfig()) {
  if (!cfg.ready) return { ready: false, problems: cfg.problems };
  try { return { ready: true, zim: cfg.zim, where: cfg.where, ...(await run(cfg, ['info'])) }; } catch (e) { return { ready: false, where: cfg.where, problems: [e.message] }; }
}

/** GET /api/offline-wiki (is it ready, how many articles) and GET /api/offline-wiki/lookup?q= (what grounding would get). */
export function installOfflineWikiRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/offline-wiki', route(async (_req, res) => res.json(await offlineWikiInfo())));
  app.get('/api/offline-wiki/lookup', route(async (req, res) => {
    const q = clip(String(req.query.q || ''), 120).trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const cfg = offlineWikiConfig();
    if (!cfg.ready) return res.status(503).json({ error: `the offline wiki is not ready: ${cfg.problems.join('; ')}` });
    const src = offlineWikiSource(cfg), hits = await src.search(q);
    res.json({ query: q, hits, intro: hits[0] ? clip(await src.intro(hits[0].key), 1200) : null });
  }));
}
