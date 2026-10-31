// Read-only export of memory metadata for Fraynix AttractorWorld. Payload text is never exported, only its length.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/export-attractors.cjs <output.json>');
const db = new Database(path.join(__dirname, '..', 'data', 'chandra.db'), { readonly: true });
const now = Date.now();
const SENSITIVE = /shpat_|sk-[a-z0-9]|eyJ[A-Za-z0-9_-]{10,}|[a-f0-9]{32,}|token|secret|password|api[_-]?key|credential/i;

const age = value => {
  const parsed = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, (now - parsed) / 86_400_000) : 0;
};
const label = (text, fallback) => {
  const clean = String(text ?? '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  return !clean || SENSITIVE.test(clean) ? fallback : clean;
};
const size = value => Buffer.byteLength(String(value ?? ''));

const nodes = [];
db.prepare('select id, agent_id, category, key, value, confidence, access_count, created_at from agent_memories').all().forEach((r, i) => nodes.push({
  id: `agent-${i}`, room: 'agent-memory', label: label(`${r.agent_id} ${r.category}/${r.key}`, `agent memory ${i}`),
  importance: r.confidence ?? 0.5, confidence: r.confidence ?? 0.5, ageDays: age(r.created_at), accesses: r.access_count ?? 0, bytes: size(r.value), provenance: 'measured',
}));
db.prepare('select from_agent, topic, payload, created_at from bus_messages').all().forEach((r, i) => nodes.push({
  id: `bus-${i}`, room: 'agent-bus', label: label(`${r.from_agent} on ${r.topic}`, `bus message ${i}`),
  importance: 0.3, confidence: 0.7, ageDays: age(r.created_at), accesses: 0, bytes: size(r.payload), provenance: 'measured',
}));
db.prepare('select trigger, insights, actions_taken, created_at from reflections').all().forEach((r, i) => nodes.push({
  id: `reflection-${i}`, room: 'reflections', label: label(`reflection ${r.trigger}`, `reflection ${i}`),
  importance: 0.65, confidence: 0.6, ageDays: age(r.created_at), accesses: 0, bytes: size(r.insights) + size(r.actions_taken), provenance: 'imagined',
}));
db.prepare('select namespace, summary, content, importance, access_count, created_at from vertiso_memories').all().forEach((r, i) => nodes.push({
  id: `vertiso-${i}`, room: 'vertiso', label: label(`${r.namespace} ${r.summary ?? ''}`, `vertiso memory ${i}`),
  importance: r.importance ?? 0.5, confidence: 0.8, ageDays: age(r.created_at), accesses: r.access_count ?? 0, bytes: size(r.content), provenance: 'measured',
}));
db.prepare('select key, value, updated_at from memory').all().forEach((r, i) => nodes.push({
  id: `kv-${i}`, room: 'key-value', label: label(r.key, `key-value ${i}`),
  importance: 0.4, confidence: 0.9, ageDays: age(r.updated_at), accesses: 0, bytes: size(r.value), provenance: 'measured',
}));

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ source: 'chandra.db', nodes }, null, 2));
console.log(`Exported ${nodes.length} memory records to ${output}`);
