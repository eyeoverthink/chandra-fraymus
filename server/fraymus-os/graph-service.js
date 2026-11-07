/**
 * Read-only knowledge projection. Opening a node does not write the owning store.
 */

const COLLECT_LIMIT = 400;

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch (error) {
    console.error('fraymus-os graph table check:', error.message);
    return false;
  }
}

function safeParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function clip(value, max = 280) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function tagsOf(value) {
  const parsed = safeParse(value, []);
  if (Array.isArray(parsed)) return parsed.map(tag => String(tag)).filter(Boolean).slice(0, 12);
  if (typeof value === 'string' && value && !value.startsWith('[')) return [value];
  return [];
}

export function createGraphService(db, options = {}) {
  async function listAgents() {
    if (typeof options.listAgents === 'function') return options.listAgents();
    try {
      const { loadManifests } = await import('../fleet/manifest.js');
      return [...loadManifests().values()].map(agent => ({
        id: agent.id,
        name: agent.name,
        role: agent.role || '',
        description: agent.description || '',
        source: agent.source || 'manifest',
      }));
    } catch (error) {
      console.error('fraymus-os graph agents:', error.message);
      return [];
    }
  }

  function collectRows(table, sql, map) {
    if (!tableExists(db, table)) return [];
    try {
      return db.prepare(sql).all(COLLECT_LIMIT).map(map).filter(Boolean);
    } catch (error) {
      console.error(`fraymus-os graph ${table}:`, error.message);
      return [];
    }
  }

  async function collect() {
    const nodes = [];
    const edges = [];

    for (const note of collectRows('fraymus_os_notes',
      `SELECT id, title, body, tags, provenance, created_at, updated_at
       FROM fraymus_os_notes ORDER BY updated_at DESC LIMIT ?`, row => ({
        id: `note:${row.id}`,
        kind: 'note',
        title: row.title,
        summary: clip(row.body),
        excerpt: clip(row.body, 500),
        source: 'fraymus_os_notes',
        sourceId: row.id,
        tags: tagsOf(row.tags),
        provenance: safeParse(row.provenance, { store: 'fraymus_os_notes' }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        visibility: 'local',
        openPath: `/api/fraymus-os/notes/${row.id}`,
      }))) nodes.push(note);

    for (const row of collectRows('memory',
      'SELECT key, value, updated_at FROM memory ORDER BY updated_at DESC LIMIT ?', row => ({
        id: `memory:kv:${row.key}`,
        kind: 'memory',
        title: row.key,
        summary: clip(row.value),
        excerpt: clip(row.value, 500),
        source: 'memory',
        sourceId: row.key,
        tags: [],
        provenance: { store: 'memory', key: row.key },
        createdAt: row.updated_at,
        updatedAt: row.updated_at,
        visibility: 'local',
        openPath: `/api/fraymus-os/graph/node/memory:kv:${encodeURIComponent(row.key)}`,
      }))) nodes.push(row);

    for (const row of collectRows('agent_memories',
      `SELECT id, agent_id, category, key, value, confidence, source, verified_at, created_at, updated_at
       FROM agent_memories ORDER BY updated_at DESC LIMIT ?`, row => ({
        id: `memory:agent:${row.id}`,
        kind: 'memory',
        title: row.key,
        summary: clip(row.value),
        excerpt: clip(row.value, 500),
        source: 'agent_memories',
        sourceId: String(row.id),
        tags: [row.category].filter(Boolean),
        provenance: {
          store: 'agent_memories',
          agentId: row.agent_id,
          category: row.category,
          confidence: row.confidence,
          source: row.source,
          verifiedAt: row.verified_at,
        },
        agentId: row.agent_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        visibility: 'local',
        openPath: `/api/fraymus-os/graph/node/memory:agent:${row.id}`,
      }))) nodes.push(row);

    for (const row of collectRows('vertiso_memories',
      `SELECT id, agent_id, namespace, content, summary, importance, provenance, confidence, created_at, updated_at
       FROM vertiso_memories ORDER BY updated_at DESC LIMIT ?`, row => ({
        id: `memory:vertiso:${row.id}`,
        kind: 'memory',
        title: clip(row.summary || row.content, 80),
        summary: clip(row.summary || row.content),
        excerpt: clip(row.content, 500),
        source: 'vertiso_memories',
        sourceId: row.id,
        tags: [row.namespace].filter(Boolean),
        provenance: {
          store: 'vertiso_memories',
          agentId: row.agent_id,
          namespace: row.namespace,
          provenance: row.provenance,
          confidence: row.confidence,
          importance: row.importance,
        },
        agentId: row.agent_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        visibility: 'local',
        openPath: `/api/fraymus-os/graph/node/memory:vertiso:${row.id}`,
      }))) nodes.push(row);

    for (const row of collectRows('fleet_memories',
      'SELECT id, agent_id, text, tags, created_at FROM fleet_memories ORDER BY id DESC LIMIT ?', row => ({
        id: `memory:fleet:${row.id}`,
        kind: 'memory',
        title: clip(row.text, 80),
        summary: clip(row.text),
        excerpt: clip(row.text, 500),
        source: 'fleet_memories',
        sourceId: String(row.id),
        tags: tagsOf(row.tags),
        provenance: { store: 'fleet_memories', agentId: row.agent_id },
        agentId: row.agent_id,
        createdAt: row.created_at,
        updatedAt: row.created_at,
        visibility: 'local',
        openPath: `/api/fraymus-os/graph/node/memory:fleet:${row.id}`,
      }))) nodes.push(row);

    const agents = await listAgents();
    for (const agent of agents) {
      if (!agent?.id) continue;
      nodes.push({
        id: `agent:${agent.id}`,
        kind: 'agent',
        title: agent.name || agent.id,
        summary: clip(agent.description || agent.role || agent.id),
        excerpt: clip(agent.description || agent.role || '', 500),
        source: 'fleet_manifest',
        sourceId: agent.id,
        tags: [agent.role].filter(Boolean),
        provenance: { store: 'fleet_manifest', sourceFile: agent.source || 'manifest', role: agent.role || '' },
        createdAt: null,
        updatedAt: null,
        visibility: 'local',
        openPath: `/api/fraymus-os/graph/node/agent:${encodeURIComponent(agent.id)}`,
      });
    }

    for (const row of collectRows('workflows',
      'SELECT id, name, nodes, user_id, created_at, updated_at FROM workflows ORDER BY updated_at DESC LIMIT ?', row => {
        let nodeCount = 0;
        try {
          const parsed = JSON.parse(row.nodes || '[]');
          nodeCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch { nodeCount = 0; }
        return {
          id: `workflow:${row.id}`,
          kind: 'workflow',
          title: row.name,
          summary: `${nodeCount} canvas nodes`,
          excerpt: row.name,
          source: 'workflows',
          sourceId: row.id,
          tags: [],
          provenance: { store: 'workflows', userId: row.user_id, nodeCount },
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          visibility: 'local',
          openPath: `/api/workflows/${row.id}`,
        };
      })) nodes.push(row);

    for (const row of collectRows('fraymus_os_artifacts',
      `SELECT id, preset, topic, status, payload, provenance, creation_run_id, error, created_at
       FROM fraymus_os_artifacts ORDER BY created_at DESC LIMIT ?`, row => {
        const payload = safeParse(row.payload, {});
        const title = payload?.brief?.title || payload?.script?.narration_script?.slice?.(0, 80) || row.topic;
        return {
          id: `artifact:${row.id}`,
          kind: 'artifact',
          title: clip(title, 80),
          summary: `${row.preset} · ${row.status}`,
          excerpt: clip(payload?.brief?.hook || payload?.script?.narration_script || row.error || row.topic, 500),
          source: 'fraymus_os_artifacts',
          sourceId: row.id,
          tags: [row.preset, row.status].filter(Boolean),
          provenance: safeParse(row.provenance, { store: 'fraymus_os_artifacts' }),
          createdAt: row.created_at,
          updatedAt: row.created_at,
          visibility: 'local',
          openPath: `/api/fraymus-os/artifacts/${row.id}`,
          creationRunId: row.creation_run_id,
        };
      })) nodes.push(row);

    for (const row of collectRows('creation_pipeline_runs',
      'SELECT id, topic, format, status, created_at FROM creation_pipeline_runs ORDER BY created_at DESC LIMIT ?', row => ({
        id: `creation:${row.id}`,
        kind: 'artifact',
        title: row.topic,
        summary: `${row.format} · ${row.status}`,
        excerpt: `${row.format} creation run`,
        source: 'creation_pipeline_runs',
        sourceId: row.id,
        tags: [row.format, row.status].filter(Boolean),
        provenance: { store: 'creation_pipeline_runs', format: row.format, status: row.status },
        createdAt: row.created_at,
        updatedAt: row.created_at,
        visibility: 'local',
        openPath: `/api/creation/runs/${row.id}`,
      }))) nodes.push(row);

    for (const row of collectRows('fraymus_os_skill_proposals',
      'SELECT id, goal, manifest, status, created_at FROM fraymus_os_skill_proposals ORDER BY created_at DESC LIMIT ?', row => ({
        id: `skill:${row.id}`,
        kind: 'skill',
        title: clip(row.goal, 80),
        summary: `Proposal · ${row.status} · execution blocked`,
        excerpt: clip(row.goal, 500),
        source: 'fraymus_os_skill_proposals',
        sourceId: row.id,
        tags: ['proposal', 'execution-blocked'],
        provenance: { store: 'fraymus_os_skill_proposals', status: row.status, execution: 'blocked', install: 'blocked' },
        createdAt: row.created_at,
        updatedAt: row.created_at,
        visibility: 'local',
        openPath: `/api/fraymus-os/skills/${row.id}`,
      }))) nodes.push(row);

    const byId = new Map(nodes.map(node => [node.id, node]));
    const agentIds = new Set(nodes.filter(node => node.kind === 'agent').map(node => node.sourceId));
    for (const node of nodes) {
      if (node.agentId && agentIds.has(node.agentId)) {
        edges.push({ id: `e:${node.id}:agent:${node.agentId}`, from: node.id, to: `agent:${node.agentId}`, type: 'owned_by' });
      }
      if (node.creationRunId && byId.has(`creation:${node.creationRunId}`)) {
        edges.push({ id: `e:${node.id}:creation:${node.creationRunId}`, from: node.id, to: `creation:${node.creationRunId}`, type: 'persisted_as' });
      }
    }

    const tagBuckets = new Map();
    for (const node of nodes) {
      for (const tag of node.tags || []) {
        const key = String(tag).toLowerCase();
        if (!key || key === 'proposal' || key === 'execution-blocked') continue;
        if (!tagBuckets.has(key)) tagBuckets.set(key, []);
        tagBuckets.get(key).push(node.id);
      }
    }
    const degree = new Map();
    for (const ids of tagBuckets.values()) {
      const unique = [...new Set(ids)];
      if (unique.length < 2 || unique.length > 8) continue;
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) {
          const left = degree.get(unique[i]) || 0;
          const right = degree.get(unique[j]) || 0;
          if (left >= 4 || right >= 4) continue;
          edges.push({ id: `e:tag:${unique[i]}:${unique[j]}`, from: unique[i], to: unique[j], type: 'shared_tag' });
          degree.set(unique[i], left + 1);
          degree.set(unique[j], right + 1);
        }
      }
    }

    return { nodes, edges };
  }

  function countsOf(nodes) {
    const counts = { note: 0, memory: 0, agent: 0, workflow: 0, artifact: 0, skill: 0, file: 0 };
    for (const node of nodes) counts[node.kind] = (counts[node.kind] || 0) + 1;
    return counts;
  }

  function matches(node, query) {
    if (!query) return true;
    const haystack = `${node.title} ${node.summary} ${(node.tags || []).join(' ')} ${node.source} ${node.sourceId}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  async function query({ q = '', kind = '', cursor = '0', limit = 100 } = {}) {
    const { nodes, edges } = await collect();
    const counts = countsOf(nodes);
    const filtered = nodes.filter(node => (!kind || node.kind === kind) && matches(node, q.trim()));
    const start = Math.max(0, parseInt(cursor, 10) || 0);
    const capped = Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
    const page = filtered.slice(start, start + capped);
    const ids = new Set(page.map(node => node.id));
    const pageEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    const next = start + capped < filtered.length ? String(start + capped) : null;
    return {
      nodes: page.map(publicNode),
      edges: pageEdges,
      counts,
      matched: filtered.length,
      total: nodes.length,
      nextCursor: next,
    };
  }

  async function getNode(id) {
    const decoded = decodeURIComponent(id);
    const { nodes } = await collect();
    const node = nodes.find(item => item.id === decoded);
    return node ? publicNode(node) : null;
  }

  async function path(from, to) {
    const { nodes, edges } = await collect();
    const start = decodeURIComponent(from || '');
    const goal = decodeURIComponent(to || '');
    if (!nodes.some(node => node.id === start) || !nodes.some(node => node.id === goal)) {
      return { found: false, path: [], reason: 'One or both records are not in the graph.' };
    }
    const adjacent = new Map();
    for (const edge of edges) {
      if (!adjacent.has(edge.from)) adjacent.set(edge.from, []);
      if (!adjacent.has(edge.to)) adjacent.set(edge.to, []);
      adjacent.get(edge.from).push(edge.to);
      adjacent.get(edge.to).push(edge.from);
    }
    const queue = [start];
    const previous = new Map([[start, null]]);
    while (queue.length) {
      const current = queue.shift();
      if (current === goal) break;
      for (const next of adjacent.get(current) || []) {
        if (previous.has(next)) continue;
        previous.set(next, current);
        queue.push(next);
      }
    }
    if (!previous.has(goal)) return { found: false, path: [], reason: 'No relationship path joins these records.' };
    const chain = [];
    let cursor = goal;
    while (cursor) {
      chain.push(cursor);
      cursor = previous.get(cursor);
    }
    chain.reverse();
    return { found: true, path: chain };
  }

  function search(text, limit = 4) {
    return query({ q: text, limit }).then(result => result.nodes.slice(0, limit));
  }

  return { query, getNode, path, search, collect };
}

function publicNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    excerpt: node.excerpt,
    source: node.source,
    sourceId: node.sourceId,
    tags: node.tags || [],
    provenance: node.provenance || { store: node.source },
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    visibility: node.visibility || 'local',
    openPath: node.openPath,
    links: [],
  };
}
