// Carbon X Layer 4: Organism
// Complete workspace-as-organism: Genome (config) + Proteome (state) + Epigenome (context)
// Checkpoint/restore entire workspace state as FASTA files

import { encodeCodon, decodeCodon, codonStats } from './codon.js';
import { forgePlasmid, digestPlasmid, plasmidToFasta, fastaToPlaymid } from './plasmid.js';
import { sha256HexSync } from '../core/crypto.js';
import { encodeDna, decodeDna, gcPercent } from './dna.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const CARBON_VERSION = '1.0.0';

/**
 * Create a genome snapshot of the entire workspace
 * Genome = configuration, Proteome = active state, Epigenome = contextual data
 */
export function createGenomeSnapshot(workspace) {
  const genome = {
    version: CARBON_VERSION,
    timestamp: Date.now(),
    organism: workspace.name || 'chandra',
  };

  // Genome: configuration DNA (agents, workflows, settings)
  const genomeDna = encodeLayer('genome', {
    agents: workspace.agents || [],
    workflows: workspace.workflows || [],
    settings: workspace.settings || {},
    tools: workspace.tools || [],
  });

  // Proteome: active runtime state (running tasks, bus state, health)
  const proteomeDna = encodeLayer('proteome', {
    activeTasks: workspace.activeTasks || [],
    busTopics: workspace.busTopics || [],
    healthStatus: workspace.healthStatus || 'nominal',
    uptime: workspace.uptime || 0,
  });

  // Epigenome: contextual/environmental data (memories, reflections, learned patterns)
  const epigenomeDna = encodeLayer('epigenome', {
    memories: workspace.memories || [],
    reflections: workspace.reflections || [],
    fossils: workspace.fossils || [],
    dreamLog: workspace.dreamLog || [],
  });

  // Build organism FASTA with all three chromosomes
  const chromosomes = [
    { name: 'chr1_genome', data: genomeDna, role: 'configuration' },
    { name: 'chr2_proteome', data: proteomeDna, role: 'active_state' },
    { name: 'chr3_epigenome', data: epigenomeDna, role: 'context' },
  ];

  const fasta = chromosomes.map(chr => {
    const stats = codonStats(chr.data);
    return [
      `>${chr.name} role=${chr.role} bases=${stats.totalBases} codons=${stats.totalCodons} gc=${stats.gcContent}%`,
      ...wrapSequence(chr.data, 70),
    ].join('\n');
  }).join('\n');

  const fullBytes = new TextEncoder().encode(fasta);
  const integrity = sha256HexSync(fullBytes);

  return {
    version: CARBON_VERSION,
    organism: genome.organism,
    timestamp: genome.timestamp,
    chromosomes: chromosomes.length,
    fasta,
    integrity,
    stats: {
      totalBases: chromosomes.reduce((sum, chr) => sum + codonStats(chr.data).totalBases, 0),
      gcContent: +(chromosomes.reduce((sum, chr) => sum + codonStats(chr.data).gcContent, 0) / chromosomes.length).toFixed(2),
    },
  };
}

/**
 * Restore a workspace from a genome snapshot (FASTA)
 */
export function restoreFromSnapshot(fasta) {
  const chromosomes = parseFastaMulti(fasta);

  if (chromosomes.length < 3) {
    throw new Error(`Expected 3 chromosomes, found ${chromosomes.length}`);
  }

  const workspace = {};

  for (const chr of chromosomes) {
    const decoded = decodeLayer(chr.sequence);
    if (chr.name.includes('epigenome')) {
      workspace.memories = decoded.memories || [];
      workspace.reflections = decoded.reflections || [];
      workspace.fossils = decoded.fossils || [];
      workspace.dreamLog = decoded.dreamLog || [];
    } else if (chr.name.includes('proteome')) {
      workspace.activeTasks = decoded.activeTasks || [];
      workspace.busTopics = decoded.busTopics || [];
      workspace.healthStatus = decoded.healthStatus || 'nominal';
      workspace.uptime = decoded.uptime || 0;
    } else if (chr.name.includes('genome')) {
      workspace.agents = decoded.agents || [];
      workspace.workflows = decoded.workflows || [];
      workspace.settings = decoded.settings || {};
      workspace.tools = decoded.tools || [];
    }
  }

  return workspace;
}

/**
 * Save a checkpoint to disk as a .fasta file
 */
export function saveCheckpoint(snapshot, dataDir) {
  const dir = join(dataDir, 'carbon');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filename = `checkpoint_${snapshot.organism}_${snapshot.timestamp}.fasta`;
  const filepath = join(dir, filename);

  // Write FASTA
  writeFileSync(filepath, snapshot.fasta, 'utf8');

  // Write metadata sidecar
  const meta = {
    version: snapshot.version,
    organism: snapshot.organism,
    timestamp: snapshot.timestamp,
    chromosomes: snapshot.chromosomes,
    integrity: snapshot.integrity,
    stats: snapshot.stats,
    filename,
  };
  writeFileSync(filepath + '.meta.json', JSON.stringify(meta, null, 2), 'utf8');

  return { filepath, metapath: filepath + '.meta.json', size: snapshot.fasta.length };
}

/**
 * Load a checkpoint from disk
 */
export function loadCheckpoint(filepath) {
  if (!existsSync(filepath)) throw new Error(`Checkpoint not found: ${filepath}`);

  const fasta = readFileSync(filepath, 'utf8');
  const metapath = filepath + '.meta.json';
  let meta = null;

  if (existsSync(metapath)) {
    try { meta = JSON.parse(readFileSync(metapath, 'utf8')); } catch { meta = null; }
  }

  // Verify integrity if metadata available
  if (meta?.integrity) {
    const actual = sha256HexSync(new TextEncoder().encode(fasta));
    if (actual !== meta.integrity) {
      throw new Error(`Checkpoint integrity mismatch: expected ${meta.integrity}, got ${actual}`);
    }
  }

  const workspace = restoreFromSnapshot(fasta);
  return { workspace, meta, verified: !!meta?.integrity };
}

/**
 * List all checkpoints in the data directory
 */
export function listCheckpoints(dataDir) {
  const dir = join(dataDir, 'carbon');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.fasta'));

  return files.map(f => {
    const metapath = join(dir, f + '.meta.json');
    let meta = null;
    if (existsSync(metapath)) {
      try { meta = JSON.parse(readFileSync(metapath, 'utf8')); } catch { meta = null; }
    }
    return {
      filename: f,
      filepath: join(dir, f),
      organism: meta?.organism || 'unknown',
      timestamp: meta?.timestamp || 0,
      chromosomes: meta?.chromosomes || 0,
      integrity: meta?.integrity || null,
    };
  }).sort((a, b) => b.timestamp - a.timestamp);
}

// ═══ Internal Helpers ═══

function encodeLayer(layerName, data) {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  return encodeCodon(bytes);
}

function decodeLayer(codonSequence) {
  const bytes = decodeCodon(codonSequence);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

function wrapSequence(seq, width) {
  const lines = [];
  for (let i = 0; i < seq.length; i += width) {
    lines.push(seq.substring(i, i + width));
  }
  return lines;
}

function parseFastaMulti(fasta) {
  const entries = [];
  let current = null;

  for (const line of fasta.split('\n')) {
    if (line.startsWith('>')) {
      if (current) entries.push(current);
      const parts = line.substring(1).split(' ');
      current = { name: parts[0], meta: parts.slice(1).join(' '), sequence: '' };
    } else if (current && line.trim()) {
      current.sequence += line.trim();
    }
  }
  if (current) entries.push(current);

  return entries;
}

export { CARBON_VERSION };
