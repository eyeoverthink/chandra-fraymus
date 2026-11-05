// Read existing intelligence outputs without importing or starting their engines.
// Generated insights retain their provenance; confidence is not fact verification.
const CHANNELS = [
  { table: 'debates', where: "status = 'completed'", order: 'created_at', map: row => ({
    external_id: `debate-${row.id}`, title: row.topic,
    description: `${row.verdict || 'Discussion'}: ${row.verdict_reasoning || row.proposition || ''}`,
    confidence: row.confidence,
    metadata: { kind: 'debate', recordId: row.id, agents: [row.proponent_agent, row.opponent_agent, row.judge_agent].filter(Boolean), verdict: row.verdict },
  }) },
  { table: 'reflections', where: "insights IS NOT NULL AND TRIM(insights) != ''", order: 'created_at', map: row => ({
    external_id: `reflection-${row.id}`, title: `Reflection: ${row.insights.replace(/\s+/g, ' ').slice(0, 100)}`,
    description: row.insights,
    metadata: { kind: 'reflection', recordId: row.id, trigger: row.trigger },
  }) },
  { table: 'agent_memories', where: 'verified_at IS NOT NULL', order: 'updated_at', map: row => ({
    external_id: `memory-${row.id}`, title: row.key, description: row.value, confidence: row.confidence,
    metadata: { kind: 'memory', recordId: row.id, agents: [row.agent_id], category: row.category, reviewedAt: row.verified_at },
  }) },
];

export function collectAgentInsights(db, limit = 20) {
  limit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Math.trunc(Number(limit)))) : 20;
  const items = [], channels = [];
  for (const channel of CHANNELS) {
    try {
      // Identifiers and predicates come exclusively from CHANNELS above.
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${channel.table} WHERE ${channel.where}`).get().count;
      const rows = db.prepare(`SELECT * FROM ${channel.table} WHERE ${channel.where} ORDER BY ${channel.order} DESC LIMIT ?`).all(limit);
      channels.push({ channel: channel.table, available: true, saved: count });
      for (const row of rows) {
        const item = channel.map(row);
        if (typeof item.title !== 'string' || !item.title.trim()) continue;
        items.push({
          ...item, description: String(item.description ?? '').slice(0, 6000),
          createdAt: row.updated_at || row.created_at,
          metadata: { ...item.metadata, sourceTable: channel.table, provenance: 'agent_generated', recordedAt: row.updated_at || row.created_at },
        });
      }
    } catch (e) {
      if (!/no such table/.test(e.message)) console.error(`[nexus] agent channel ${channel.table}: ${e.message}`);
      channels.push({ channel: channel.table, available: false, saved: null });
    }
  }
  items.sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || a.external_id.localeCompare(b.external_id));
  return {
    items: items.slice(0, limit), channels,
    saved: channels.reduce((sum, channel) => sum + (channel.saved || 0), 0),
    available: channels.some(channel => channel.available),
    partial: channels.some(channel => !channel.available),
  };
}
