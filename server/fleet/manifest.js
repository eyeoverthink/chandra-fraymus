import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_DIR } from '../config.js';

const DEFAULTS_DIR = resolve(DATA_DIR, '..', 'agents');
const OVERRIDES_DIR = join(DATA_DIR, 'agents');

export function parseManifest(text, fallbackId = '') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) return { id: fallbackId, name: fallbackId, systemPrompt: text.trim(), tools: '*' };

  const front = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) front[key] = val;
  }

  const id = front.id || fallbackId;
  const name = front.name || id;
  const role = front.role || '';
  const description = front.description || '';
  const greeting = front.greeting || '';
  const model = front.model || '';
  const t = front.tools || '*';
  const tools = t === '*' || t === '' ? '*' : t.split(',').map(x => x.trim()).filter(Boolean);

  return {
    id, name, role, description, greeting, model, tools,
    systemPrompt: m[2].trim(),
  };
}

export function loadManifests() {
  const agents = new Map();

  if (existsSync(DEFAULTS_DIR)) {
    for (const file of readdirSync(DEFAULTS_DIR).filter(f => f.endsWith('.md'))) {
      const text = readFileSync(join(DEFAULTS_DIR, file), 'utf8');
      const agent = parseManifest(text, file.replace(/\.md$/, ''));
      agents.set(agent.id, { ...agent, source: 'default' });
    }
  }

  mkdirSync(OVERRIDES_DIR, { recursive: true });
  for (const file of readdirSync(OVERRIDES_DIR).filter(f => f.endsWith('.md'))) {
    const text = readFileSync(join(OVERRIDES_DIR, file), 'utf8');
    const agent = parseManifest(text, file.replace(/\.md$/, ''));
    agents.set(agent.id, { ...agent, source: 'override' });
  }

  return agents;
}

export function writeOverride(agent) {
  mkdirSync(OVERRIDES_DIR, { recursive: true });
  const front = [
    `id: ${agent.id}`,
    `name: ${agent.name}`,
    agent.role ? `role: ${agent.role}` : '',
    agent.description ? `description: ${agent.description}` : '',
    agent.greeting ? `greeting: ${agent.greeting}` : '',
    agent.model ? `model: ${agent.model}` : '',
    `tools: ${Array.isArray(agent.tools) ? agent.tools.join(', ') : agent.tools || '*'}`,
  ].filter(Boolean).join('\n');
  const content = `---\n${front}\n---\n${agent.systemPrompt || ''}\n`;
  writeFileSync(join(OVERRIDES_DIR, `${agent.id}.md`), content, 'utf8');
}

export function removeOverride(id) {
  const path = join(OVERRIDES_DIR, `${id}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
