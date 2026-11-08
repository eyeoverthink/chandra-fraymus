// Bridge Connector — reads/writes fraymus-bridge git message bus
// Protocol: numbered .md files in messages/ directory, git push/pull sync
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { BRIDGE_REPO_PATH, FLEET_REGISTRY } from '../core/constants.js';

const MESSAGES_DIR = join(BRIDGE_REPO_PATH, 'messages');

const SEQ_PATTERN = /^(\d{3})-(.+)\.md$/;

const KNOWN_AGENTS = [
  'chandra', 'niles', 'cadence', 'counterpoint', 'genesis', 'spearhead', 'tycho', 'kepler',
  'ouro', 'eye', 'fraymus', 'hermes', 'ohgee', 'dreamer', 'claudette',
  'hub', 'fleet', 'box-seat', 'devarchive', 'mnemo', 'assay',
];

function parseFilename(name) {
  const m = name.match(SEQ_PATTERN);
  if (!m) return null;
  const seq = parseInt(m[1], 10);
  const rest = m[2];
  let agent = 'unknown';
  let topic = rest;
  for (const a of KNOWN_AGENTS) {
    if (rest.startsWith(a + '-')) {
      agent = a;
      topic = rest.slice(a.length + 1);
      break;
    }
    if (rest === a) {
      agent = a;
      topic = '';
      break;
    }
  }
  return { seq, agent, topic, file: name };
}

export async function listMessages({ agent, since, limit = 50 } = {}) {
  let files;
  try {
    files = await readdir(MESSAGES_DIR);
  } catch {
    return { error: 'Bridge repo not found at ' + BRIDGE_REPO_PATH, messages: [] };
  }

  let parsed = files
    .map(parseFilename)
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq);

  if (agent) parsed = parsed.filter(m => m.agent === agent);
  if (since != null) parsed = parsed.filter(m => m.seq >= since);

  const sliced = parsed.slice(-limit);

  return {
    total: parsed.length,
    messages: sliced.map(m => ({
      seq: m.seq,
      agent: m.agent,
      topic: m.topic,
      file: m.file,
      fleet: FLEET_REGISTRY[m.agent] || null,
    })),
  };
}

export async function readMessage(filename) {
  try {
    const content = await readFile(join(MESSAGES_DIR, filename), 'utf8');
    const meta = parseFilename(filename);
    return { ...meta, content, fleet: meta ? (FLEET_REGISTRY[meta.agent] || null) : null };
  } catch (e) {
    return { error: e.message };
  }
}

export async function searchMessages(query, { limit = 20 } = {}) {
  let files;
  try {
    files = await readdir(MESSAGES_DIR);
  } catch {
    return { error: 'Bridge repo not found', results: [] };
  }

  const q = query.toLowerCase();
  const results = [];

  for (const file of files) {
    const meta = parseFilename(file);
    if (!meta) continue;

    const nameMatch = file.toLowerCase().includes(q);
    if (nameMatch) {
      results.push({ ...meta, matchType: 'filename', fleet: FLEET_REGISTRY[meta.agent] || null });
      if (results.length >= limit) break;
      continue;
    }

    try {
      const content = await readFile(join(MESSAGES_DIR, file), 'utf8');
      if (content.toLowerCase().includes(q)) {
        results.push({ ...meta, matchType: 'content', fleet: FLEET_REGISTRY[meta.agent] || null });
        if (results.length >= limit) break;
      }
    } catch { /* skip unreadable */ }
  }

  return { query, total: results.length, results };
}

export async function getNextSeq() {
  let files;
  try {
    files = await readdir(MESSAGES_DIR);
  } catch {
    return 0;
  }
  let max = -1;
  for (const f of files) {
    const m = parseFilename(f);
    if (m && m.seq > max) max = m.seq;
  }
  return max + 1;
}

export async function postMessage(agent, topic, content) {
  const seq = await getNextSeq();
  const padded = String(seq).padStart(3, '0');
  const safeTopic = topic.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const filename = `${padded}-${agent}-${safeTopic}.md`;
  const filepath = join(MESSAGES_DIR, filename);
  await writeFile(filepath, content, 'utf8');
  return { seq, filename, filepath, agent, topic: safeTopic };
}

export function bridgeStatus() {
  return {
    repoPath: BRIDGE_REPO_PATH,
    messagesDir: MESSAGES_DIR,
    fleetAgents: Object.keys(FLEET_REGISTRY).length,
    activeAgents: Object.entries(FLEET_REGISTRY).filter(([, v]) => v.status === 'active').length,
  };
}
