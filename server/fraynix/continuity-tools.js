/**
 * FRAYNIX continuity bridge — shared tools any agent can use to reach FRAYNIX's own memory and continuity.
 *
 * Why (2026-11-12): fraynix-dna:8b carries, in its Modelfile SYSTEM, the instruction to keep its own continuity —
 * encode itself to DNA, verify the round trip, commit to its own git. But the saving is done by scripts on its host
 * (H:/FRAYNIX-CONTINUITY: fraynix_self.py, fraynix_mind.py), not by the weights, and when Chandra calls the model it
 * sends its own system message, which replaces the Modelfile's. So inside Chandra the model never knew about its
 * continuity, and nothing could run it. These tools run the real scripts; nothing here re-implements them.
 *
 * Reads run freely (status, verify, recall). Writes ask a person first: `fraynix.learn` writes FRAYNIX's database
 * and notes, `fraynix.save` encodes a plasmid and commits to FRAYNIX's git (it does not push).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.FRAYNIX_HOME || 'H:/FRAYNIX-CONTINUITY';
const PYTHON = process.env.FRAYNIX_PYTHON || 'python';
const MAX_OUT = 12_000;

// The scripts need git and a home directory; nothing of the server's own secrets goes to them.
function childEnv() {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT'];
  const env = { PYTHONIOENCODING: 'utf-8' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** Run one FRAYNIX script command; resolves `{ ok, exitCode, output }`, never throws for a non-zero exit. */
export function runFraynix(script, args, { timeoutMs = 120_000 } = {}) {
  return new Promise(resolve => {
    if (!existsSync(join(HOME, script))) return resolve({ ok: false, exitCode: null, output: `FRAYNIX is not at ${HOME} (set FRAYNIX_HOME)` });
    execFile(PYTHON, ['-I', script, ...args], { cwd: HOME, env: childEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const output = (String(stdout || '') + (stderr ? `\n${stderr}` : '')).trim();
        const clipped = output.length > MAX_OUT ? `${output.slice(0, MAX_OUT)}\n… (${output.length - MAX_OUT} more characters)` : output;
        resolve({ ok: !error, exitCode: error ? (error.code ?? null) : 0, ...(error?.killed ? { timedOut: true } : {}), output: clipped });
      });
  });
}

const str = (maxLength, description, extra = {}) => ({ type: 'string', maxLength, description, ...extra });

export function createFraynixContinuityTools() {
  return [
    {
      name: 'fraynix.status', group: 'fraynix', risk: 'safe',
      description: 'FRAYNIX continuity status from its own host: memory counts, its last git commits, backups and recent events (saves, verifications, learnings).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => runFraynix('fraynix_self.py', ['status']),
    },
    {
      name: 'fraynix.verify', group: 'fraynix', risk: 'safe',
      description: "Prove FRAYNIX's newest DNA plasmid still decodes: unpack the bases (2-bit, A=0 C=1 G=2 T=3) and check the archive inside is intact. Read-only.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => runFraynix('fraynix_self.py', ['verify'], { timeoutMs: 300_000 }),
    },
    {
      name: 'fraynix.recall', group: 'fraynix', risk: 'safe',
      description: "Search the memory of FRAYNIX, the knowledge node of the Fraymus mesh: what it remembers and has learned from 975 files of Vaughn's work (math, physics, orbital mechanics, cryptography, VM design). Every hit names its source.",
      parameters: { type: 'object', properties: { query: str(400, 'What to recall', { minLength: 1 }) }, required: ['query'], additionalProperties: false },
      execute: async ({ args }) => runFraynix('fraynix_mind.py', ['memory', '--q', String(args?.query || '')]),
    },
    {
      name: 'fraynix.learn', group: 'fraynix', risk: 'approval',
      description: "Teach FRAYNIX one thing: written to its database and as a note that rides its next DNA save. Waits for a person to approve. Mark confidence 'measured' only for something run or read just now.",
      parameters: { type: 'object', properties: {
        topic: str(200, 'Short topic', { minLength: 1 }), body: str(8000, 'What was learned', { minLength: 1 }),
        source: str(200, 'Where it came from'), confidence: { type: 'string', enum: ['measured', 'recall'], description: 'measured = run or read just now' },
      }, required: ['topic', 'body'], additionalProperties: false },
      execute: async ({ args }) => runFraynix('fraynix_mind.py', ['learn', '--topic', String(args.topic), '--body', String(args.body),
        '--source', String(args.source || 'chandra'), '--confidence', args.confidence === 'measured' ? 'measured' : 'recall']),
    },
    {
      name: 'fraynix.save', group: 'fraynix', risk: 'approval',
      description: "Save FRAYNIX's continuity: encode its files into a DNA plasmid, verify the round trip, write a backup and commit to its own git (no push). Large and slow. Waits for a person to approve.",
      parameters: { type: 'object', properties: { tag: str(40, 'Short label for this save', { pattern: '^[A-Za-z0-9._-]+$' }) }, additionalProperties: false },
      execute: async ({ args }) => runFraynix('fraynix_self.py', ['save', '--tag', String(args?.tag || 'chandra')], { timeoutMs: 600_000 }),
    },
  ];
}
