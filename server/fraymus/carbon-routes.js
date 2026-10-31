// Carbon X REST API Routes
// Biological encoding, plasmid forge, genome checkpoint/restore

import { encodeCodon, decodeCodon, codonStats, codonGcContent } from './encoding/codon.js';
import { forgePlasmid, digestPlasmid, plasmidToFasta, restrictionDigest } from './encoding/plasmid.js';
import {
  createGenomeSnapshot, restoreFromSnapshot,
  saveCheckpoint, loadCheckpoint, listCheckpoints,
} from './encoding/carbon.js';
import { join } from 'path';

export function installCarbonRoutes(app, { dataDir, broadcast, db, heart, ledger, memoryBridge }) {
  const DATA_DIR = dataDir || process.env.CHANDRA_DATA_DIR || './data';

  // ═══ Codon Engine ═══

  // Encode text/bytes to codon sequence
  app.post('/api/carbon/encode', (req, res, next) => {
    try {
      const { text, bytes } = req.body || {};
      if (!text && !bytes) return res.status(400).json({ error: 'text or bytes required' });

      const input = text
        ? new TextEncoder().encode(text)
        : new Uint8Array(Array.isArray(bytes) ? bytes : []);

      const encoded = encodeCodon(input);
      const stats = codonStats(encoded);

      res.json({
        encoded,
        stats,
        inputSize: input.length,
        encodedSize: encoded.length,
        expansionRatio: +(encoded.length / Math.max(1, input.length)).toFixed(2),
      });
    } catch (e) { next(e); }
  });

  // Decode codon sequence back to text/bytes
  app.post('/api/carbon/decode', (req, res, next) => {
    try {
      const { sequence } = req.body || {};
      if (!sequence) return res.status(400).json({ error: 'sequence required' });

      const decoded = decodeCodon(sequence);
      const text = new TextDecoder().decode(decoded);

      res.json({
        text,
        bytes: Array.from(decoded),
        size: decoded.length,
      });
    } catch (e) { next(e); }
  });

  // Codon stats for any DNA sequence
  app.post('/api/carbon/stats', (req, res, next) => {
    try {
      const { sequence } = req.body || {};
      if (!sequence) return res.status(400).json({ error: 'sequence required' });
      res.json(codonStats(sequence));
    } catch (e) { next(e); }
  });

  // ═══ Plasmid Forge ═══

  // Forge a new plasmid from payload
  app.post('/api/carbon/plasmid/forge', (req, res, next) => {
    try {
      const { payload, name, type, source, marker } = req.body || {};
      if (!payload) return res.status(400).json({ error: 'payload required' });

      const plasmid = forgePlasmid(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
        { name, type, source, marker }
      );

      if (broadcast) broadcast({ type: 'carbon:plasmid_forged', name, size: plasmid.size });
      if (ledger) ledger.record('carbon.plasmid.forged', { name, size: plasmid.size, gcContent: plasmid.gcContent }, 'carbon');
      if (memoryBridge) memoryBridge.storeCognitionResult({ phase: 'carbon_plasmid', feeling: { primary: 'curiosity', intensity: 0.5 }, response: `Plasmid forged: ${name || 'unnamed'}, ${plasmid.size} bases, GC ${plasmid.gcContent}%`, durationMs: 0 }).catch(() => {});

      res.json(plasmid);
    } catch (e) { next(e); }
  });

  // Digest a plasmid — extract payload
  app.post('/api/carbon/plasmid/digest', (req, res, next) => {
    try {
      const { dna } = req.body || {};
      if (!dna) return res.status(400).json({ error: 'dna required' });

      const result = digestPlasmid(dna);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Convert plasmid to FASTA
  app.post('/api/carbon/plasmid/fasta', (req, res, next) => {
    try {
      const { plasmid } = req.body || {};
      if (!plasmid) return res.status(400).json({ error: 'plasmid object required' });

      const fasta = plasmidToFasta(plasmid);
      res.json({ fasta });
    } catch (e) { next(e); }
  });

  // Restriction digest
  app.post('/api/carbon/plasmid/restrict', (req, res, next) => {
    try {
      const { dna, enzyme } = req.body || {};
      if (!dna || !enzyme) return res.status(400).json({ error: 'dna and enzyme required' });

      const result = restrictionDigest(dna, enzyme);
      res.json(result);
    } catch (e) { next(e); }
  });

  // ═══ Genome Checkpoint/Restore ═══

  // Create a genome checkpoint from current workspace state
  app.post('/api/carbon/checkpoint', (req, res, next) => {
    try {
      const workspace = buildWorkspaceSnapshot(db, req.body || {});
      const snapshot = createGenomeSnapshot(workspace);
      const saved = saveCheckpoint(snapshot, DATA_DIR);

      if (broadcast) broadcast({ type: 'carbon:checkpoint_created', organism: snapshot.organism, timestamp: snapshot.timestamp });
      if (ledger) ledger.record('carbon.checkpoint.created', { organism: snapshot.organism, bases: snapshot.stats.totalBases, chromosomes: snapshot.chromosomes }, 'carbon');
      if (memoryBridge) memoryBridge.storeCognitionResult({ phase: 'carbon_checkpoint', feeling: { primary: 'determination', intensity: 0.6 }, response: `Genome checkpoint: ${snapshot.organism}, ${snapshot.stats.totalBases} bases, ${snapshot.chromosomes} chromosomes`, durationMs: 0 }).catch(() => {});

      res.json({
        ...saved,
        organism: snapshot.organism,
        timestamp: snapshot.timestamp,
        chromosomes: snapshot.chromosomes,
        integrity: snapshot.integrity,
        stats: snapshot.stats,
      });
    } catch (e) { next(e); }
  });

  // Restore workspace from a checkpoint
  app.post('/api/carbon/restore', (req, res, next) => {
    try {
      const { filepath, fasta } = req.body || {};

      let workspace;
      if (filepath) {
        const result = loadCheckpoint(filepath);
        workspace = result.workspace;
      } else if (fasta) {
        workspace = restoreFromSnapshot(fasta);
      } else {
        return res.status(400).json({ error: 'filepath or fasta required' });
      }

      if (broadcast) broadcast({ type: 'carbon:restored', agentCount: (workspace.agents || []).length });
      if (ledger) ledger.record('carbon.restored', { agentCount: (workspace.agents || []).length, workflowCount: (workspace.workflows || []).length }, 'carbon');

      res.json({ workspace, restored: true });
    } catch (e) { next(e); }
  });

  // List all checkpoints
  app.get('/api/carbon/checkpoints', (req, res, next) => {
    try {
      const checkpoints = listCheckpoints(DATA_DIR);
      res.json({ checkpoints, count: checkpoints.length });
    } catch (e) { next(e); }
  });

  // Carbon X status
  app.get('/api/carbon/status', (req, res) => {
    res.json({
      version: '1.0.0',
      layers: [
        { layer: 1, name: 'Nucleotide Base', module: 'dna.js', status: 'active' },
        { layer: 2, name: 'Codon Engine', module: 'codon.js', status: 'active' },
        { layer: 3, name: 'Plasmid Forge', module: 'plasmid.js', status: 'active' },
        { layer: 4, name: 'Organism', module: 'carbon.js', status: 'active' },
      ],
      capabilities: ['encode', 'decode', 'forge_plasmid', 'digest_plasmid', 'fasta_export', 'restriction_digest', 'checkpoint', 'restore'],
    });
  });
}

// ═══ Workspace Snapshot Builder ═══

function buildWorkspaceSnapshot(db, overrides) {
  const workspace = {
    name: overrides.name || 'chandra',
    agents: [],
    workflows: [],
    settings: {},
    tools: [],
    activeTasks: [],
    busTopics: [],
    healthStatus: 'nominal',
    uptime: process.uptime(),
    memories: [],
    reflections: [],
    fossils: [],
    dreamLog: [],
  };

  if (!db) return { ...workspace, ...overrides };

  try {
    // Pull agents from fleet manifests table
    const agents = db.prepare('SELECT id, name, role FROM agents LIMIT 100').all();
    workspace.agents = agents.map(a => ({ id: a.id, name: a.name, role: a.role }));
  } catch { /* table may not exist */ }

  try {
    const workflows = db.prepare('SELECT id, name FROM workflows LIMIT 100').all();
    workspace.workflows = workflows.map(w => ({ id: w.id, name: w.name }));
  } catch { /* table may not exist */ }

  try {
    const topics = db.prepare('SELECT DISTINCT topic FROM bus_messages ORDER BY created_at DESC LIMIT 50').all();
    workspace.busTopics = topics.map(t => t.topic);
  } catch { /* table may not exist */ }

  try {
    const memories = db.prepare('SELECT agent_id, category, key, value, confidence FROM agent_memories ORDER BY updated_at DESC LIMIT 100').all();
    workspace.memories = memories;
  } catch { /* table may not exist */ }

  try {
    const reflections = db.prepare('SELECT id, trigger, insights FROM reflections ORDER BY created_at DESC LIMIT 20').all();
    workspace.reflections = reflections;
  } catch { /* table may not exist */ }

  try {
    const fossils = db.prepare("SELECT agent_id, key, value FROM agent_memories WHERE category = 'fossil' LIMIT 50").all();
    workspace.fossils = fossils;
  } catch { /* table may not exist */ }

  return { ...workspace, ...overrides };
}
