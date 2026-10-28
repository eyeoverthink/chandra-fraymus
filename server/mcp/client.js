import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { setFleetTools } from '../fleet/runtime.js';

const subst = s => s.replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (_m, k) => process.env[k] || '');
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

const MAX_INLINE = 200_000;
const clip = (s, n = MAX_INLINE) => s.length > n ? s.slice(0, n) + '...[truncated]' : s;

const state = [];
const defs = new Map();
const importedFile = () => join(DATA_DIR, 'mcp-servers.json');
const registeredTools = [];

export const mcpStatus = () => [...state];
export const mcpServers = () => state.map(s => {
  const d = defs.get(s.name);
  return { ...s, transport: d?.url ? 'http' : 'stdio', target: d?.url || d?.command, imported: !!d?.imported };
});

async function connectHttp(def) {
  const headers = {};
  for (const [k, v] of Object.entries(def.headers || {})) headers[k] = subst(v);
  const url = subst(def.url);

  const initRes = await withTimeout(fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'chandra-fraymus', version: '1.0.0' }, capabilities: {} } }),
    signal: AbortSignal.timeout(15_000),
  }), 15_000, 'connect');

  if (!initRes.ok) throw new Error(`HTTP ${initRes.status}`);

  const listRes = await withTimeout(fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(15_000),
  }), 15_000, 'list tools');

  const listData = await listRes.json();
  const listed = listData.result?.tools || [];
  const safe = new Set(def.safeTools || []);

  return listed.map(t => ({
    name: `${def.name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
    group: `mcp:${def.name}`,
    description: `[${def.name}] ${t.description || t.name}`.slice(0, 1000),
    risk: safe.has(t.name) ? 'safe' : 'approval',
    parameters: t.inputSchema || { type: 'object', properties: {} },
    _mcpServer: def.name,
    _mcpTool: t.name,
    _mcpUrl: url,
    _mcpHeaders: headers,
    execute: async ({ args }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: t.name, arguments: args || {} } }),
        signal: AbortSignal.timeout(600_000),
      });
      const data = await res.json();
      const result = data.result;
      if (result?.isError) {
        const msg = (result.content || []).map(c => c.text || '').join('\n') || 'tool error';
        throw new Error(msg.slice(0, 1000));
      }
      const parts = (result?.content || []).map(c => c.type === 'text' ? c.text : JSON.stringify(c).slice(0, 500));
      return clip(parts.join('\n'));
    },
  }));
}

function readFile(path) {
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch { return []; }
}

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

async function startServer(def) {
  const missing = (def.requires || []).filter(k => !process.env[k]);
  const set = s => { const i = state.findIndex(x => x.name === def.name); if (i >= 0) state[i] = s; else state.push(s); };
  defs.set(def.name, def);

  if (def.disabled || missing.length) {
    return set({ name: def.name, status: 'skipped', tools: 0, detail: def.disabled ? 'disabled' : `set ${missing.join(', ')}` });
  }

  if (!def.url) {
    return set({ name: def.name, status: 'skipped', tools: 0, detail: 'only HTTP transport supported in this build' });
  }

  try {
    const tools = await connectHttp(def);
    registeredTools.push(...tools);
    set({ name: def.name, status: 'connected', tools: tools.length });
  } catch (e) {
    set({ name: def.name, status: 'error', tools: 0, detail: String(e?.message || e).slice(0, 300) });
  }
}

export async function initMcp(configPath) {
  state.length = 0;
  registeredTools.length = 0;
  const path = configPath || process.env.MCP_SERVERS_FILE || join(DATA_DIR, '..', 'config', 'mcp-servers.json');
  const base = readFile(path);
  const imported = readFile(importedFile()).map(d => ({ ...d, imported: true }));
  await Promise.all([...base, ...imported].map(startServer));
  return state;
}

export function getImportedTools() {
  return [...registeredTools];
}

function persist() {
  const keep = [...defs.values()].filter(d => d.imported).map(({ imported, ...d }) => d);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(importedFile(), JSON.stringify(keep, null, 2), { mode: 0o600 });
}

export function parseImport(input) {
  const out = [];
  const add = (name, d) => out.push({
    name, description: d.description, url: d.url || d.serverUrl,
    command: d.command, args: Array.isArray(d.args) ? d.args.map(String) : undefined,
    env: d.env, headers: d.headers,
    safeTools: Array.isArray(d.safeTools) ? d.safeTools.map(String) : undefined,
  });
  if (input?.mcpServers && typeof input.mcpServers === 'object') {
    for (const [n, d] of Object.entries(input.mcpServers)) add(n, d || {});
  } else if (input?.name) {
    add(String(input.name), input);
  } else {
    throw new Error('provide {name,url|command,...} or {mcpServers:{...}}');
  }
  return out;
}

export async function importServers(input) {
  const list = parseImport(input);
  const results = [];
  for (const d of list) {
    if (!NAME_RE.test(d.name)) throw new Error(`Invalid server name "${d.name}"`);
    if (!d.url) throw new Error(`${d.name}: needs url (only HTTP transport supported)`);
    if (defs.has(d.name) && !defs.get(d.name).imported) throw new Error(`${d.name}: name used by built-in config`);
  }
  for (const d of list) {
    await removeServer(d.name, false);
    await startServer({ ...d, imported: true });
    results.push(state.find(s => s.name === d.name));
  }
  persist();
  return results;
}

export async function removeServer(name, save = true) {
  const d = defs.get(name);
  if (d && !d.imported) throw new Error('Built-in config servers must be edited in config file');
  for (let i = registeredTools.length - 1; i >= 0; i--) {
    if (registeredTools[i].name.startsWith(`${name}__`)) registeredTools.splice(i, 1);
  }
  defs.delete(name);
  const idx = state.findIndex(s => s.name === name);
  if (idx >= 0) state.splice(idx, 1);
  if (save) persist();
  return !!d;
}
